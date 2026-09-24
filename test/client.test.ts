import assert from 'node:assert/strict';
import http from 'node:http';
import {after, before, test} from 'node:test';
import {callbackEvents} from '../src/callbacks.ts';
import {OccuLite, type ValueEvent} from '../src/client.ts';
import {OccuLiteError} from '../src/errors.ts';
import {pair} from '../src/node/index.ts';
import {FakeBox} from '../src/testing/fakebox.ts';

const until = async (f: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!f()) {
        if (Date.now() > end) throw new Error('timed out');
        await new Promise((r) => setTimeout(r, 10));
    }
};

let box: FakeBox;
before(async () => {
    box = new FakeBox({
        token: 'olt_' + 'a'.repeat(32),
        interfaces: ['HmIP-RF', 'BidCos-RF'],
        devices: {'HmIP-RF': [{ADDRESS: '000A1B2C3D4E5F', TYPE: 'HmIP-PDT'}, {ADDRESS: '000A1B2C3D4E5F:4', PARENT: '000A1B2C3D4E5F', TYPE: 'DIMMER_VIRTUAL_RECEIVER'}], 'BidCos-RF': []},
        descriptions: {'HmIP-RF.000A1B2C3D4E5F:4': {LEVEL: {TYPE: 'FLOAT', OPERATIONS: 7}, RAMP_TIME: {TYPE: 'FLOAT'}}},
        values: {'HmIP-RF.000A1B2C3D4E5F:4.LEVEL': {value: 0.5, ts: '2026-09-25T00:00:00Z', lc: '2026-09-24T20:00:00Z', confirmed: false, source: 'restored'}},
        meta: {revision: 3, objects: {'HmIP-RF.000A1B2C3D4E5F:4': {name: 'Deckenlampe'}}, enums: {}},
    });
    await box.start();
});
after(() => box.stop());

test('a refused credential rejects ready()', async () => {
    const c = new OccuLite({url: box.url, auth: {token: 'olt_' + 'b'.repeat(32)}});
    await assert.rejects(c.ready(), (e: OccuLiteError) => e.code === 'unauthenticated');
    c.close();
});

test('not openccu-lite: a CCU answers its WebUI', async (t) => {
    const ccu = http.createServer((_q, r) => r.end('<html>WebUI</html>'));
    await new Promise<void>((r) => ccu.listen(0, '127.0.0.1', r));
    t.after(() => ccu.close());
    const c = new OccuLite({url: `http://127.0.0.1:${(ccu.address() as {port: number}).port}`});
    await assert.rejects(c.ready(), (e: OccuLiteError) => e.code === 'unsupported');
    c.close();
});

test('connect, the complete picture, live values, batches, requests', async (t) => {
    const c = new OccuLite({url: box.url, auth: {token: 'olt_' + 'a'.repeat(32)}, reconnect: {min: 20, max: 50}});
    t.after(() => c.close());
    await c.ready();
    assert.equal(c.status, 'ready');
    assert.equal(c.info.implementation, 'fakebox');
    assert.equal(c.capabilities.state, true);
    assert.deepEqual(c.interfaces, ['HmIP-RF', 'BidCos-RF']);
    const lv = c.values.get('HmIP-RF.000A1B2C3D4E5F:4.LEVEL')!;
    assert.equal(lv.value, 0.5);
    assert.equal(lv.confirmed, false);
    assert.equal(lv.lc, Date.parse('2026-09-24T20:00:00Z'));
    assert.equal(c.devices.get('HmIP-RF.000A1B2C3D4E5F:4')?.TYPE, 'DIMMER_VIRTUAL_RECEIVER');
    assert.equal(c.meta.name('HmIP-RF.000A1B2C3D4E5F:4'), 'Deckenlampe');

    const seen: ValueEvent[] = [];
    const batches: ValueEvent[][] = [];
    c.on('value', (e: ValueEvent) => seen.push(e));
    c.on('batch', (b: ValueEvent[]) => batches.push(b));
    box.event('HmIP-RF', '000A1B2C3D4E5F:4', 'LEVEL', 0.75);
    const b = box.nextSeq();
    box.event('HmIP-RF', '000A1B2C3D4E5F:4', 'LEVEL', 0.8, b);
    box.event('HmIP-RF', '000A1B2C3D4E5F:4', 'WORKING', true, b);
    await until(() => batches.length === 1);
    assert.equal(seen[0].value, 0.75);
    assert.equal(seen[0].confirmed, true);
    assert.equal(c.values.get('HmIP-RF.000A1B2C3D4E5F:4.LEVEL')!.value, 0.8);
    assert.deepEqual(batches[0].map((e) => e.key), ['LEVEL', 'WORKING']);

    // a FLOAT written as an integer goes as a typed double; another key as it is
    await c.setValue('HmIP-RF.000A1B2C3D4E5F:4.LEVEL', 1);
    await c.putParamset('HmIP-RF.000A1B2C3D4E5F:4', 'VALUES', {LEVEL: 0, ON_TIME: 5});
    const sets = box.calls.filter((x) => x.method === 'setValue' || x.method === 'putParamset');
    assert.deepEqual(sets[0].params, ['000A1B2C3D4E5F:4', 'LEVEL', {double: 1}]);
    assert.deepEqual(sets[1].params, ['000A1B2C3D4E5F:4', 'VALUES', {LEVEL: {double: 0}, ON_TIME: 5}]);
    assert.equal(box.calls.filter((x) => x.method === 'getParamsetDescription').length, 1, 'the description is cached');
    await assert.rejects(c.call('HmIP-RF', 'nope'), (e: OccuLiteError) => e.code === 'rpc-fault' && e.faultCode === -32601);
    const r = await c.batch('HmIP-RF', [['getValue', ['000A1B2C3D4E5F:4', 'LEVEL']], ['nope', []]]);
    assert.equal(r[0], 0.8);
    assert.ok(r[1] instanceof OccuLiteError);
    assert.deepEqual(await c.history('HmIP-RF.000A1B2C3D4E5F:1.ACTUAL_TEMPERATURE'), [[Date.parse('2026-09-25T00:00:00Z'), 21.5], [Date.parse('2026-09-25T00:10:00Z'), 21.7]]);
    await c.rename('HmIP-RF.000A1B2C3D4E5F:4', 'Lampe');
    assert.deepEqual(box.metaPatches.at(-1), {ref: 'HmIP-RF.000A1B2C3D4E5F:4', body: {name: 'Lampe'}});

    // the metadata stream: an object event applied in place
    box.metaEvent({revision: 4, kind: 'object.updated', ref: 'HmIP-RF.000A1B2C3D4E5F:4', value: {name: 'Lampe'}});
    await until(() => c.meta.name('HmIP-RF.000A1B2C3D4E5F:4') === 'Lampe');

    // the stream drops: the client reconnects and resumes - what came meanwhile is replayed
    const n = seen.length;
    box.dropStreams();
    box.event('HmIP-RF', '000A1B2C3D4E5F:4', 'LEVEL', 0.1);
    await until(() => seen.length > n);
    assert.equal(seen.at(-1)!.value, 0.1);

    // another boot: a resync, the values read again
    const resyncs: unknown[] = [];
    c.on('resync', (e: unknown) => resyncs.push(e));
    box.bootId = 'boot2';
    box.dropStreams();
    await until(() => resyncs.length === 1);
    assert.deepEqual(resyncs[0], {reason: 'boot'});
    c.close();
    assert.equal(c.status, 'closed');
});

test('the callbacks module: the old callback-server arguments', async (t) => {
    const c = new OccuLite({url: box.url, auth: {token: 'olt_' + 'a'.repeat(32)}, meta: false});
    t.after(() => c.close());
    await c.ready();
    const srv = callbackEvents(c, {initIds: {'HmIP-RF': 'nr_1_HmIP-RF'}});
    const got: unknown[][] = [];
    srv.on('event', (_e, p) => got.push(['event', ...p]));
    srv.on('system.multicall', (_e, p) => got.push(['multicall', p[0]]));
    box.event('HmIP-RF', 'X:1', 'STATE', true);
    const b = box.nextSeq();
    box.event('HmIP-RF', 'X:2', 'STATE', false, b);
    box.event('HmIP-RF', 'X:3', 'STATE', true, b);
    await until(() => got.length === 2);
    assert.deepEqual(got[0], ['event', 'nr_1_HmIP-RF', 'X:1', 'STATE', true]);
    assert.deepEqual(got[1], ['multicall', [{methodName: 'event', params: ['nr_1_HmIP-RF', 'X:2', 'STATE', false]}, {methodName: 'event', params: ['nr_1_HmIP-RF', 'X:3', 'STATE', true]}]]);
    srv.close();
    c.close();
});

test('pairing: the code both sides show, the token after the approval', async () => {
    let code = '';
    const p = pair({url: box.url, app: 'test-app', appVersion: '1.0.0', instance: 'ci', access: {devices: 'read'}, onCode: (c) => (code = c)});
    await until(() => code !== '');
    const [id] = [...box.pairings.keys()];
    assert.equal(box.pairingCode(id), code);
    box.approve(id);
    const res = await p;
    assert.match(res.token, /^olt_[0-9a-f]{32}$/);
    assert.equal(res.fingerprint256, '');
    assert.deepEqual(res.access, {devices: 'read'});
});

test('rotation: the client uses the new secret', async () => {
    const auth = {token: box.opts.token};
    const c = new OccuLite({url: box.url, auth, values: false, meta: false, devices: false});
    await c.ready();
    const t = await c.rotateToken();
    assert.equal(t, box.opts.token);
    assert.equal(auth.token, t);
    await c.request('GET', '/api/auth/v1/state');
    c.close();
});
