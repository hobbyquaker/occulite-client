import assert from 'node:assert/strict';
import {test} from 'node:test';
import {OccuLite} from '../src/client.ts';
import {FakeBox} from '../src/testing/fakebox.ts';

const until = async (f: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!f()) {
        if (Date.now() > end) throw new Error('timed out');
        await new Promise((r) => setTimeout(r, 10));
    }
};

test('ready() does not wait for an interface that is not running; its devices come when it comes up', async (t) => {
    const box = new FakeBox({interfaces: ['HmIP-RF', {name: 'BidCos-Wired', running: false}], devices: {'HmIP-RF': [{ADDRESS: 'A'}], 'BidCos-Wired': [{ADDRESS: 'W1'}, {ADDRESS: 'W1:1', PARENT: 'W1'}]}});
    await box.start();
    t.after(() => box.stop());
    const c = new OccuLite({url: box.url, values: false, meta: false, readyTimeout: 5000, log: {debug() {}, info() {}, warn() {}, error() {}}});
    t.after(() => c.close());
    const events: {kind: string; interface: string; refs: string[]; descriptions?: unknown[]}[] = [];
    c.on('devices', (e: (typeof events)[0]) => events.push(e));
    const t0 = Date.now();
    await c.ready();
    assert.ok(Date.now() - t0 < 1000, `ready in ${Date.now() - t0} ms, not the readyTimeout`);
    assert.equal(c.interfaces.find((i) => i.name === 'BidCos-Wired')?.running, false);
    assert.equal(c.devices.size, 1);
    // hs485d is started: interface up, the client asks listDevices and reports the devices as new
    box.setInterface('BidCos-Wired', true);
    await until(() => c.devices.size === 3);
    assert.equal(c.interfaces.find((i) => i.name === 'BidCos-Wired')?.running, true);
    await until(() => events.some((e) => e.interface === 'BidCos-Wired'));
    const ev = events.find((e) => e.interface === 'BidCos-Wired')!;
    assert.equal(ev.kind, 'new');
    assert.deepEqual(ev.refs, ['BidCos-Wired.W1', 'BidCos-Wired.W1:1']);
    assert.equal((ev.descriptions as {ADDRESS: string}[])[1].PARENT, 'W1');
});

test('an interface that appears after connect is followed; a newDevices with addresses only gets its descriptions', async (t) => {
    const box = new FakeBox({interfaces: ['BidCos-RF'], devices: {'BidCos-RF': [{ADDRESS: 'B'}]}});
    await box.start();
    t.after(() => box.stop());
    const c = new OccuLite({url: box.url, values: false, meta: false});
    t.after(() => c.close());
    const events: {kind: string; interface: string; refs: string[]; descriptions?: unknown[]}[] = [];
    c.on('devices', (e: (typeof events)[0]) => events.push(e));
    const states: unknown[] = [];
    c.on('interface', (e: unknown) => states.push(e));
    await c.ready();
    assert.deepEqual(c.interfaces.map((i) => i.name), ['BidCos-RF']);
    // hmipserver comes up after rfd
    box.addInterface('HmIP-RF', {devices: [{ADDRESS: 'H', TYPE: 'HmIP-PDT'}, {ADDRESS: 'H:3', PARENT: 'H'}]});
    await until(() => c.devices.size === 3);
    assert.deepEqual(c.interfaces.map((i) => [i.name, i.running]), [['BidCos-RF', true], ['HmIP-RF', true]]);
    assert.deepEqual(states, [{interface: 'HmIP-RF', state: 'added'}]);
    assert.deepEqual(events.at(-1)?.refs, ['HmIP-RF.H', 'HmIP-RF.H:3']);
    // a device paired later: the stream says newDevices with addresses; the descriptions are fetched
    box.opts.devices!['HmIP-RF'].push({ADDRESS: 'N', TYPE: 'HmIP-SWDO'}, {ADDRESS: 'N:1', PARENT: 'N'});
    box.push('newDevices', {interface: 'HmIP-RF', addresses: ['N', 'N:1']});
    await until(() => c.devices.size === 5);
    const ev = events.at(-1)!;
    assert.deepEqual([ev.kind, ev.refs], ['new', ['HmIP-RF.N', 'HmIP-RF.N:1']]);
    assert.equal((ev.descriptions as {TYPE: string}[])[0].TYPE, 'HmIP-SWDO');
    // events of the new interface arrive (no interface filter on the stream)
    const values: unknown[] = [];
    c.on('value', (v: unknown) => values.push(v));
    box.event('HmIP-RF', 'H:3', 'STATE', true);
    await until(() => values.length === 1);
});

test('with an interfaces option, one that appears outside it is not followed', async (t) => {
    const box = new FakeBox({interfaces: ['BidCos-RF'], devices: {'BidCos-RF': []}});
    await box.start();
    t.after(() => box.stop());
    const c = new OccuLite({url: box.url, interfaces: ['BidCos-RF'], values: false, meta: false});
    t.after(() => c.close());
    await c.ready();
    box.addInterface('HmIP-RF', {devices: [{ADDRESS: 'H'}]});
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(c.interfaces.map((i) => i.name), ['BidCos-RF']);
    assert.equal(c.devices.size, 0);
});
