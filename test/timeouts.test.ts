import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {test} from 'node:test';
import {OccuLite} from '../src/client.ts';
import {OccuLiteError} from '../src/errors.ts';
import {pair, probe, probeUntil} from '../src/node/index.ts';
import {FakeBox} from '../src/testing/fakebox.ts';

const until = async (f: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!f()) {
        if (Date.now() > end) throw new Error('timed out');
        await new Promise((r) => setTimeout(r, 10));
    }
};

// a port nothing listens on
async function freePort(): Promise<number> {
    const s = net.createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const port = (s.address() as net.AddressInfo).port;
    await new Promise<void>((r) => s.close(() => r()));
    return port;
}

test('probe: a hanging system is unreachable with reason timeout, within the timeout - never a CCU', async (t) => {
    const box = new FakeBox({hang: true});
    await box.start();
    t.after(() => box.stop());
    const t0 = Date.now();
    const r = await probe(box.url, {timeout: 300});
    assert.ok(Date.now() - t0 < 1500, 'answered within the timeout');
    assert.equal(r.kind, 'unreachable');
    assert.equal(r.reachable, false);
    assert.equal(r.reason, 'timeout');
});

test('probe: refused, a CCU, openccu-lite, an abort', async (t) => {
    const refused = await probe(`127.0.0.1:${await freePort()}`, {timeout: 1000});
    assert.deepEqual([refused.kind, refused.reachable, refused.reason], ['unreachable', false, 'refused']);

    const ccu = http.createServer((_q, r) => r.end('<html>WebUI</html>'));
    await new Promise<void>((r) => ccu.listen(0, '127.0.0.1', r));
    t.after(() => ccu.close());
    const c = await probe(`127.0.0.1:${(ccu.address() as net.AddressInfo).port}`);
    assert.deepEqual([c.kind, c.reachable, c.reason], ['ccu', true, undefined]);

    const box = new FakeBox();
    await box.start();
    t.after(() => box.stop());
    const lite = await probe(box.url);
    assert.deepEqual([lite.kind, lite.reachable], ['openccu-lite', true]);
    assert.equal((lite.info as {implementation: string}).implementation, 'fakebox');

    const ac = new AbortController();
    const hanging = new FakeBox({hang: true});
    await hanging.start();
    t.after(() => hanging.stop());
    const p = probe(hanging.url, {timeout: 5000, signal: ac.signal});
    setTimeout(() => ac.abort(), 50);
    const a = await p;
    assert.deepEqual([a.kind, a.reachable, a.reason], ['unreachable', false, 'aborted']);
});

test('probeUntil: retries while unreachable and resolves once the system answers; aborts', async (t) => {
    const box = new FakeBox({hang: true});
    await box.start();
    t.after(() => box.stop());
    setTimeout(() => box.resume(), 250);
    const r = await probeUntil(box.url, {timeout: 100, schedule: [50, 100]});
    assert.equal(r.kind, 'openccu-lite');

    const ac = new AbortController();
    const p = probeUntil(`127.0.0.1:${await freePort()}`, {schedule: [50], signal: ac.signal});
    setTimeout(() => ac.abort(), 120);
    await assert.rejects(p, (e: OccuLiteError) => e.code === 'aborted');
});

test('ready(): a hanging /version rejects with timeout, not unreachable; an abort rejects aborted', async (t) => {
    const box = new FakeBox({hang: true});
    await box.start();
    t.after(() => box.stop());
    const c = new OccuLite({url: box.url, timeout: 200});
    t.after(() => c.close());
    const t0 = Date.now();
    await assert.rejects(c.ready(), (e: OccuLiteError) => e.code === 'timeout');
    assert.ok(Date.now() - t0 < 2000);

    const c2 = new OccuLite({url: box.url, timeout: 5000, connectTimeout: 200});
    t.after(() => c2.close());
    await assert.rejects(c2.ready(), (e: OccuLiteError) => e.code === 'timeout');
    assert.equal(c2.status, 'closed');

    const ac = new AbortController();
    const c3 = new OccuLite({url: box.url});
    t.after(() => c3.close());
    const p = c3.ready({signal: ac.signal});
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(p, (e: OccuLiteError) => e.code === 'aborted');
});

test('a request times out with the client\'s timeout; the client\'s own timers do not hold the process', async (t) => {
    const box = new FakeBox({devices: {'HmIP-RF': []}});
    await box.start();
    t.after(() => box.stop());
    const c = new OccuLite({url: box.url, values: false, meta: false, timeout: 150});
    t.after(() => c.close());
    await c.ready();
    box.opts.hang = true;
    await assert.rejects(c.request('GET', '/api/auth/v1/state'), (e: OccuLiteError) => e.code === 'timeout');
    await assert.rejects(c.request('GET', '/api/auth/v1/state', undefined, {timeout: 1000}).then(() => {}, (e) => Promise.reject(e)), (e: OccuLiteError) => e.code === 'timeout');
    box.resume();
});

test('pair(): the overall timeout rejects timeout and withdraws the request', async (t) => {
    const box = new FakeBox();
    await box.start();
    t.after(() => box.stop());
    let code = '';
    const p = pair({url: box.url, app: 'test-app', access: {devices: 'read'}, onCode: (c) => (code = c), timeout: 300});
    await until(() => code !== '');
    assert.equal(box.pairings.size, 1);
    await assert.rejects(p, (e: OccuLiteError) => e.code === 'timeout');
    await until(() => box.pairings.size === 0);

    const ac = new AbortController();
    const p2 = pair({url: box.url, app: 'test-app', access: {devices: 'read'}, onCode: () => ac.abort(), signal: ac.signal});
    await assert.rejects(p2, (e: OccuLiteError) => e.code === 'aborted');
    await until(() => box.pairings.size === 0);
});

test('the stream watchdog: a silent stream is reopened, a pinging one is not', async (t) => {
    const silent = new FakeBox({devices: {'HmIP-RF': []}});
    await silent.start();
    t.after(() => silent.stop());
    const c = new OccuLite({url: silent.url, values: false, meta: false, streamTimeout: 150, reconnect: {min: 10, max: 20}});
    t.after(() => c.close());
    await c.ready();
    await until(() => silent.streamsOpened >= 3, 2000);
    c.close();

    const pinging = new FakeBox({devices: {'HmIP-RF': []}, pingInterval: 40});
    await pinging.start();
    t.after(() => pinging.stop());
    const c2 = new OccuLite({url: pinging.url, values: false, meta: false, streamTimeout: 150, reconnect: {min: 10, max: 20}});
    t.after(() => c2.close());
    await c2.ready();
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(pinging.streamsOpened, 1, 'the pings keep the stream alive');
    assert.equal(c2.status, 'ready');
});
