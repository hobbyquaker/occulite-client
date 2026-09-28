import assert from 'node:assert/strict';
import {test} from 'node:test';
import {OccuLite} from '../src/client.ts';
import {OccuLiteError} from '../src/errors.ts';
import {FakeBox} from '../src/testing/fakebox.ts';
import type {ServiceMessageView} from '../src/types.ts';

const until = async (f: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!f()) {
        if (Date.now() > end) throw new Error('timed out');
        await new Promise((r) => setTimeout(r, 10));
    }
};

const quiet = {debug() {}, info() {}, warn() {}, error() {}};

test('status, radio health and the service messages come typed from the system API', async (t) => {
    const box = new FakeBox({serviceMessages: [{interface: 'HmIP-RF', address: '000A1B2C3D4E5F', channel: '000A1B2C3D4E5F:0', key: 'LOWBAT', value: true, since: '2026-09-25T00:00:00Z', seen: 'start', type: 'HmIP-SWDO', name: 'Fenster Bad', enums: ['room/eg/bad']}]});
    await box.start();
    t.after(() => box.stop());
    const c = new OccuLite({url: box.url, values: false, meta: false, devices: false, log: quiet});
    t.after(() => c.close());
    await c.ready();
    const st = await c.system.status();
    assert.equal(st.hostname, 'fakebox');
    assert.equal(st.version.lite, '1.0.0-dev.0');
    assert.equal(st.timezone, 'Europe/Berlin');
    const rh = await c.system.radioHealth();
    assert.equal(rh.interfaces[0].duty_cycle, 3);
    assert.equal(rh.interfaces[0].carrier_sense, 12);
    assert.equal(rh.history['HmIP-RF/3014F711A0000000000000FA'].length, 2);
    assert.equal(rh.busy, false);
    const sm = await c.system.serviceMessages();
    assert.equal(sm.count, 1);
    assert.equal(sm.messages[0].key, 'LOWBAT');
    assert.equal(sm.messages[0].name, 'Fenster Bad');
    assert.equal(sm.messages[0].seen, 'start');
    assert.deepEqual(sm.errors, {});
    // the history list: what is recorded, and a change kept by the system
    const h = await c.system.datastore.history();
    assert.equal(h.datapoints.ACTUAL_TEMPERATURE, 'sampled');
    assert.deepEqual(h.add, []);
    const h2 = await c.system.datastore.history({add: ['POWER', 'MOTION'], remove: ['LEVEL']});
    assert.equal(h2.datapoints.POWER, 'sampled');
    assert.equal(h2.datapoints.MOTION, 'event');
    assert.equal(h2.datapoints.LEVEL, undefined);
    await assert.rejects(c.system.datastore.history({add: ['not a name']}), (e: OccuLiteError) => e.code === 'invalid');
    assert.equal(box.systemRequests.filter((r) => r.startsWith('GET /service-messages/stream')).length, 0, 'no stream without a handler');
});

test('the heating groups: list, types, get, create, update, remove; unknown-group and invalid', async (t) => {
    const box = new FakeBox();
    await box.start();
    t.after(() => box.stop());
    const c = new OccuLite({url: box.url, values: false, meta: false, devices: false, log: quiet});
    t.after(() => c.close());
    await c.ready();
    assert.deepEqual(await c.system.groups.list(), {groups: [], devices_to_configure: []});
    const types = await c.system.groups.types();
    assert.equal(types[0].id, 'HomeMatic.heating');
    assert.deepEqual(
        types[0].assignable.map((m) => m.id),
        ['KEQ0000001', 'KEQ0000002'],
    );
    const made = await c.system.groups.create({name: 'Bad', type: 'HomeMatic.heating', members: ['KEQ0000001']});
    assert.equal(made.id, 1);
    assert.equal(made.device, 'INT0000001');
    assert.equal(made.ref, 'VirtualDevices.INT0000001');
    assert.equal(made.device_name, 'Bad INT0000001');
    assert.deepEqual(
        made.members.map((m) => m.serial),
        ['KEQ0000001'],
    );
    assert.deepEqual(made.devices_to_configure?.map((m) => m.id), ['KEQ0000001']);
    assert.deepEqual(
        made.assignable.map((m) => m.id),
        ['KEQ0000002'],
        'a member fits one group',
    );
    // the list and the types follow
    const list = await c.system.groups.list();
    assert.deepEqual(list.groups, [{id: 1, name: 'Bad', type: 'HomeMatic.heating', type_label: 'Heating_Control', device: 'INT0000001', ref: 'VirtualDevices.INT0000001'}]);
    assert.deepEqual((await c.system.groups.types())[0].assignable.map((m) => m.id), ['KEQ0000002']);
    // the members as a whole; a field left out keeps its value
    const changed = await c.system.groups.update(1, {members: ['KEQ0000001', 'KEQ0000002'], forbid_single_operation: true});
    assert.equal(changed.name, 'Bad');
    assert.equal(changed.members.length, 2);
    assert.equal(changed.forbid_single_operation, true);
    assert.equal((await c.system.groups.get(1)).members.length, 2);
    await assert.rejects(c.system.groups.get(99), (e: OccuLiteError) => e.code === 'unknown-group' && e.status === 404);
    await assert.rejects(c.system.groups.update(99, {name: 'x'}), (e: OccuLiteError) => e.code === 'unknown-group');
    await assert.rejects(c.system.groups.create({name: '', type: 'HomeMatic.heating', members: []}), (e: OccuLiteError) => e.code === 'invalid' && /name/.test(e.message));
    await assert.rejects(c.system.groups.create({name: 'x', type: 'nope', members: []}), (e: OccuLiteError) => e.code === 'invalid' && /type/.test(e.message));
    const gone = await c.system.groups.remove(1);
    assert.equal(gone.deleted, 1);
    assert.deepEqual(
        gone.former_members.map((m) => m.id),
        ['KEQ0000001', 'KEQ0000002'],
    );
    assert.deepEqual((await c.system.groups.list()).groups, []);
    // every write carried a body - a DELETE too (lighttpd's 411)
    assert.ok(box.systemRequests.includes('DELETE /groups/1'));
});

test('without the system API every method rejects unsupported before a request; without system:read the API says forbidden', async (t) => {
    const box = new FakeBox({systemApi: false});
    await box.start();
    t.after(() => box.stop());
    const c = new OccuLite({url: box.url, values: false, meta: false, devices: false, log: quiet});
    t.after(() => c.close());
    await c.ready();
    assert.equal(c.capabilities.apis?.system, undefined);
    for (const p of [c.system.status(), c.system.radioHealth(), c.system.serviceMessages(), c.system.groups.list(), c.system.groups.types(), c.system.groups.get(1), c.system.groups.create({name: 'x', type: 'y', members: []}), c.system.groups.remove(1), c.system.datastore.history()]) {
        await assert.rejects(p, (e: OccuLiteError) => e.code === 'unsupported');
    }
    assert.equal(box.systemRequests.length, 0, 'nothing was asked');
    // the stream is not opened either: one error event, no retry
    const errors: OccuLiteError[] = [];
    c.on('error', (e: OccuLiteError) => errors.push(e));
    const off = c.on('serviceMessages', () => {});
    await until(() => errors.length === 1);
    assert.equal(errors[0].code, 'not-found');
    off();

    const ro = new FakeBox({token: 't', scopes: ['rpc:read', 'meta:read']});
    await ro.start();
    t.after(() => ro.stop());
    const r = new OccuLite({url: ro.url, auth: {token: 't'}, values: false, meta: false, devices: false, log: quiet});
    t.after(() => r.close());
    await r.ready();
    await assert.rejects(r.system.status(), (e: OccuLiteError) => e.code === 'forbidden' && e.scope === 'system:read');
    await assert.rejects(r.system.groups.create({name: 'x', type: 'HomeMatic.heating', members: []}), (e: OccuLiteError) => e.code === 'forbidden' && e.scope === 'system:write');
});

test('the service-message stream is opened with the first handler, delivers every change, and is closed with the last', async (t) => {
    const box = new FakeBox({serviceMessages: []});
    await box.start();
    t.after(() => box.stop());
    const c = new OccuLite({url: box.url, values: false, meta: false, devices: false, log: quiet});
    t.after(() => c.close());
    await c.ready();
    assert.equal(box.serviceStreamsOpened, 0);
    const views: ServiceMessageView[] = [];
    const off1 = c.on('serviceMessages', (v: ServiceMessageView) => views.push(v));
    await until(() => views.length === 1);
    assert.equal(box.serviceStreamsOpened, 1);
    assert.equal(views[0].count, 0);
    // a second handler shares the stream
    const seen2: number[] = [];
    const off2 = c.on('serviceMessages', (v: ServiceMessageView) => seen2.push(v.count));
    box.setServiceMessages([{interface: 'BidCos-RF', address: 'KEQ0000001', channel: 'KEQ0000001:0', key: 'UNREACH', value: true, since: new Date().toISOString(), seen: 'event'}]);
    await until(() => views.length === 2 && seen2.length === 1);
    assert.equal(views[1].messages[0].key, 'UNREACH');
    assert.equal(box.serviceStreamsOpened, 1);
    // the first handler leaves: the stream stays for the second; the last leaves: the stream is closed
    off1();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(box.serviceStreamsOpen, 1);
    off2();
    await until(() => box.serviceStreamsOpen === 0);
    box.setServiceMessages([]);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(views.length, 2, 'nothing delivered after the last handler left');
    // and again: a fresh stream
    const off3 = c.on('serviceMessages', (v: ServiceMessageView) => views.push(v));
    await until(() => views.length === 3);
    assert.equal(box.serviceStreamsOpened, 2);
    off3();
    // a dropped stream is reopened while a handler is registered
    const off4 = c.on('serviceMessages', (v: ServiceMessageView) => views.push(v));
    await until(() => views.length === 4);
    for (const r of (box as unknown as {serviceStreams: Set<{end(): void}>}).serviceStreams) r.end();
    await until(() => box.serviceStreamsOpened === 4, 5000);
    off4();
});
