import assert from 'node:assert/strict';
import {test} from 'node:test';
import {callbackEvents} from '../src/callbacks.ts';
import {OccuLite, type SweepResult, type ValueEvent} from '../src/client.ts';
import {FakeBox} from '../src/testing/fakebox.ts';

const until = async (f: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!f()) {
        if (Date.now() > end) throw new Error('timed out');
        await new Promise((r) => setTimeout(r, 10));
    }
};

function box(): FakeBox {
    return new FakeBox({
        interfaces: ['HmIP-RF', 'BidCos-RF'],
        devices: {
            'HmIP-RF': [{ADDRESS: 'H', TYPE: 'HmIP-PDT', PARAMSETS: ['MASTER']}, {ADDRESS: 'H:0', PARENT: 'H', PARAMSETS: ['MASTER', 'VALUES']}, {ADDRESS: 'H:4', PARENT: 'H', PARAMSETS: ['MASTER', 'VALUES']}],
            'BidCos-RF': [{ADDRESS: 'B', TYPE: 'HM-LC-Sw1', PARAMSETS: ['MASTER']}, {ADDRESS: 'B:0', PARENT: 'B', PARAMSETS: ['MASTER', 'VALUES']}, {ADDRESS: 'B:1', PARENT: 'B', PARAMSETS: ['MASTER', 'VALUES']}, {ADDRESS: 'U', TYPE: 'HM-LC-Sw1'}, {ADDRESS: 'U:0', PARENT: 'U', PARAMSETS: ['VALUES']}, {ADDRESS: 'U:1', PARENT: 'U', PARAMSETS: ['VALUES']}],
        },
        storeKeys: ['LEVEL', 'STATE', 'UNREACH', 'LOWBAT'],
        values: {
            'HmIP-RF.H:4.LEVEL': {value: 0.5, ts: '2026-09-28T10:00:00Z', lc: '2026-09-28T09:00:00Z'},
            'HmIP-RF.H:4.RAMP_TIME': {value: 0.5},
            'HmIP-RF.H:4.ACTIVITY_STATE': {value: 1},
            'HmIP-RF.H:0.UNREACH': {value: false},
            'HmIP-RF.H:0.RSSI_DEVICE': {value: -60},
            'BidCos-RF.B:1.STATE': {value: true},
            'BidCos-RF.B:1.INHIBIT': {value: false},
            'BidCos-RF.B:0.UNREACH': {value: false},
            'BidCos-RF.U:0.UNREACH': {value: true},
            'BidCos-RF.U:1.STATE': {value: false},
            'BidCos-RF.U:1.INHIBIT': {value: true},
        },
    });
}

test("values: 'all' sweeps the datapoints outside the store, paced; the store's entries win; UNREACH BidCos devices are skipped", async (t) => {
    const b = box();
    await b.start();
    t.after(() => b.stop());
    const c = new OccuLite({url: b.url, values: 'all', meta: false, sweepPaceMs: 30});
    t.after(() => c.close());
    const values: ValueEvent[] = [];
    c.on('value', (e: ValueEvent) => values.push(e));
    const sweeps: SweepResult[] = [];
    c.on('sweep', (s: SweepResult) => sweeps.push(s));
    const srv = callbackEvents(c, {initIds: {}});
    const events: unknown[] = [];
    srv.on('event', (_e, p) => events.push(p));
    const t0 = Date.now();
    await c.ready();
    // the store's set only, at ready
    assert.equal(c.values.size, 6, 'LEVEL, STATE ×2, UNREACH ×3');
    assert.equal(c.values.get('HmIP-RF.H:4.RAMP_TIME'), undefined);
    await until(() => sweeps.length === 1, 5000);
    const s = sweeps[0];
    // channels: H:0, H:4, B:0, B:1 asked; U:0 and U:1 skipped (UNREACH on BidCos); the devices themselves are no channels
    assert.equal(s.channels, 4);
    assert.equal(s.read, 4);
    assert.equal(s.skipped, 2);
    assert.equal(s.failed, 0);
    assert.equal(s.values, 4, 'RAMP_TIME, ACTIVITY_STATE, RSSI_DEVICE, INHIBIT');
    assert.ok(Date.now() - t0 >= 3 * 30, 'paced');
    const rt = c.values.get('HmIP-RF.H:4.RAMP_TIME')!;
    assert.deepEqual([rt.value, rt.source, rt.confirmed, rt.lc], [0.5, 'sweep', true, undefined]);
    assert.equal(c.values.get('HmIP-RF.H:4.LEVEL')!.lc, Date.parse('2026-09-28T09:00:00Z'), "the store's entry stays");
    assert.equal(c.values.get('BidCos-RF.U:1.INHIBIT'), undefined, 'the UNREACH device was not asked');
    assert.deepEqual(values.filter((v) => v.source === 'sweep').map((v) => v.ref).sort(), ['BidCos-RF.B:1.INHIBIT', 'HmIP-RF.H:0.RSSI_DEVICE', 'HmIP-RF.H:4.ACTIVITY_STATE', 'HmIP-RF.H:4.RAMP_TIME']);
    assert.deepEqual(events, [], 'callbacks turns no sweep value into an event call');
    const gp = b.calls.filter((x) => x.method === 'getParamset');
    assert.deepEqual(gp.map((x) => `${x.interface}.${x.params[0]}`), ['BidCos-RF.B:0', 'BidCos-RF.B:1', 'HmIP-RF.H:0', 'HmIP-RF.H:4']);
    // a re-run for one device: its channels only
    const again = await c.sweep(['BidCos-RF.B']);
    assert.equal(again.channels, 2);
    assert.equal(again.values, 0, 'nothing new');
    assert.equal(b.calls.filter((x) => x.method === 'getParamset').length, 6);
    srv.close();
});

test('a channel the process faults on is counted, the sweep goes on; a failing device does not stop it', async (t) => {
    const b = box();
    b.opts.failing = ['HmIP-RF.H:0'];
    await b.start();
    t.after(() => b.stop());
    const c = new OccuLite({url: b.url, values: 'all', meta: false, sweepPaceMs: 5});
    t.after(() => c.close());
    const sweeps: SweepResult[] = [];
    c.on('sweep', (s: SweepResult) => sweeps.push(s));
    await c.ready();
    await until(() => sweeps.length === 1);
    assert.deepEqual([sweeps[0].channels, sweeps[0].read, sweeps[0].failed, sweeps[0].values], [4, 3, 1, 3]);
});

test('values: true (the default) sweeps nothing; a device paired later is swept when values is all', async (t) => {
    const b = box();
    await b.start();
    t.after(() => b.stop());
    const c = new OccuLite({url: b.url, meta: false});
    t.after(() => c.close());
    await c.ready();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(b.calls.filter((x) => x.method === 'getParamset').length, 0);
    c.close();

    const a = new OccuLite({url: b.url, values: 'all', meta: false, sweepPaceMs: 5});
    t.after(() => a.close());
    const sweeps: SweepResult[] = [];
    a.on('sweep', (s: SweepResult) => sweeps.push(s));
    await a.ready();
    await until(() => sweeps.length === 1);
    b.opts.devices!['HmIP-RF'].push({ADDRESS: 'N', TYPE: 'HmIP-SWDO'}, {ADDRESS: 'N:1', PARENT: 'N', PARAMSETS: ['VALUES']});
    b.opts.values!['HmIP-RF.N:1.STATE'] = {value: true};
    b.opts.values!['HmIP-RF.N:1.TAMPER'] = {value: false};
    b.push('newDevices', {interface: 'HmIP-RF', addresses: ['N', 'N:1']});
    await until(() => sweeps.length === 2);
    assert.deepEqual([sweeps[1].channels, sweeps[1].values], [1, 2]);
    assert.equal(a.values.get('HmIP-RF.N:1.TAMPER')?.source, 'sweep');
});
