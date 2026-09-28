import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {OccuLite} from '../src/client.ts';
import {OccuLiteError} from '../src/errors.ts';
import {MetaCopy, type MetaDocument} from '../src/meta.ts';
import {FakeBox} from '../src/testing/fakebox.ts';

const HOUSE = JSON.parse(readFileSync(new URL('./fixtures/meta/store/valid-house.json', import.meta.url), 'utf8')) as MetaDocument;

const until = async (f: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!f()) {
        if (Date.now() > end) throw new Error('timed out');
        await new Promise((r) => setTimeout(r, 10));
    }
};

test('membership: the node and its ancestors, most specific first, then tree order; names once; by language', () => {
    const m = new MetaCopy();
    m.load(HOUSE);
    // the house: BidCos-RF.JEQ9000001:1 in room/og/bad and function/heizung; HmIP-RF.000A1B2C3D4E5F:4 in room/eg/wohnzimmer, function/licht
    assert.deepEqual(m.membershipNames('HmIP-RF.000A1B2C3D4E5F:4'), {rooms: ['Wohnzimmer', 'Erdgeschoss'], functions: ['Licht']}, "node-red-contrib-ccu's memberNames vector");
    assert.deepEqual(m.membership('BidCos-RF.JEQ9000001:1').rooms.map((n) => [n.path, n.depth]), [['room/og/bad', 2], ['room/og', 1]]);
    assert.deepEqual(m.membership('BidCos-RF.JEQ9000001:1', {inherit: false}).rooms.map((n) => n.path), ['room/og/bad']);
    assert.deepEqual(m.membershipNames('HmIP-RF.nope'), {rooms: [], functions: []});
    // two direct paths at different depths: the deeper first, siblings in tree order
    m.load({format: 1, revision: 1, objects: {'X.a:1': {enums: ['room/eg', 'room/og/bad', 'room/og']}}, enums: {room: {tree: [{id: 'eg', name: 'EG'}, {id: 'og', name: 'OG', children: [{id: 'bad', name: 'Bad'}]}]}}});
    assert.deepEqual(m.membershipNames('X.a:1').rooms, ['Bad', 'EG', 'OG']);
    // a name shared by two nodes appears once
    m.load({format: 1, revision: 1, objects: {'X.a:1': {enums: ['room/a/x', 'room/b/x']}}, enums: {room: {tree: [{id: 'a', name: 'A', children: [{id: 'x', name: 'Flur'}]}, {id: 'b', name: 'B', children: [{id: 'x', name: 'Flur'}]}]}}});
    assert.deepEqual(m.membershipNames('X.a:1').rooms, ['Flur', 'A', 'B']);
});

test('the copy follows node.moved, node.updated and enum.updated in place; created and deleted nodes ask for a snapshot', () => {
    const m = new MetaCopy();
    m.load(HOUSE);
    const rev = HOUSE.revision;
    // a rename keeps the path (fixture 03)
    assert.equal(m.apply({revision: rev + 1, kind: 'node.updated', enum: 'room', path: 'room/og/bad', value: {id: 'bad', name: 'Badezimmer'}}), true);
    assert.equal(m.nodeAt('room/og/bad')?.name, 'Badezimmer');
    // a move rewrites the member paths, as the store did in the same revision
    assert.equal(m.apply({revision: rev + 2, kind: 'node.moved', enum: 'room', from: 'room/og/bad', to: 'room/eg/bad'}), true);
    assert.deepEqual(m.object('BidCos-RF.JEQ9000001:1')?.enums, ['room/eg/bad', 'function/heizung']);
    assert.equal(m.nodeAt('room/og/bad'), undefined);
    assert.equal(m.nodeAt('room/eg/bad')?.name, 'Badezimmer');
    assert.deepEqual(m.query('room/eg'), ['BidCos-RF.JEQ9000001:1', 'HmIP-RF.000A1B2C3D4E5F:4', 'HmIP-RF.0011223344AABB:1']);
    assert.deepEqual(m.membershipNames('BidCos-RF.JEQ9000001:1').rooms, ['Badezimmer', 'Erdgeschoss']);
    // a subtree moves with its paths
    assert.equal(m.apply({revision: rev + 3, kind: 'node.moved', enum: 'room', from: 'room/eg', to: 'room/og/eg'}), true);
    assert.deepEqual(m.object('HmIP-RF.000A1B2C3D4E5F:4')?.enums, ['room/og/eg/wohnzimmer', 'function/licht']);
    assert.equal(m.apply({revision: rev + 4, kind: 'enum.updated', enum: 'room', value: {name: {de: 'Zimmer', en: 'Rooms'}}}), true);
    assert.deepEqual(m.doc.enums.room.name, {de: 'Zimmer', en: 'Rooms'});
    assert.equal(m.revision, rev + 4);
    assert.equal(m.apply({revision: rev + 5, kind: 'node.created', enum: 'room', path: 'room/keller', value: {id: 'keller', name: 'Keller'}}), false);
    assert.equal(m.apply({revision: rev + 5, kind: 'node.deleted', enum: 'room', path: 'room/og'}), false);
    assert.equal(m.apply({revision: rev + 5, kind: 'import', objects: 3, enums: 3}), false);
    assert.equal(m.apply({revision: rev + 5, kind: 'node.moved', enum: 'room', from: 'room/nope', to: 'room/x'}), false, 'an unknown node asks for a snapshot');
    // the format's error for an unknown path
    assert.throws(() => m.query('room/nowhere'), (e: OccuLiteError) => e.code === 'unknown-path');
});

test('the writes mirror the API: bodies, If-Match, the 304, the DELETE body, the query flags, import and export, the error codes', async (t) => {
    const box = new FakeBox({token: 'olt_w', scopes: ['meta:write'], meta: {revision: 10, objects: {'HmIP-RF.A:1': {name: 'Lampe', enums: ['room/eg']}}, enums: {room: {tree: [{id: 'eg', name: 'EG'}]}}}});
    await box.start();
    t.after(() => box.stop());
    const c = new OccuLite({url: box.url, auth: {token: 'olt_w'}, values: false, devices: false});
    t.after(() => c.close());
    await c.ready();
    const m = c.meta;
    assert.deepEqual(await m.objects.patch('HmIP-RF.A:1', {name: 'Deckenlampe'}), {revision: 11, changed: true});
    assert.deepEqual(await m.objects.put('HmIP-RF.B:1', {name: 'Kontakt', enums: ['room/eg']}, {ifMatch: 11}), {revision: 12, changed: true});
    await assert.rejects(m.objects.patch('HmIP-RF.B:1', {name: 'x'}, {ifMatch: 11}), (e: OccuLiteError) => e.code === 'revision-conflict' && e.status === 409);
    assert.deepEqual(await m.objects.patch('HmIP-RF.B:1', {}), {revision: 12, changed: false}, 'a 304 with the revision from the ETag');
    assert.deepEqual(await m.objects.delete('HmIP-RF.B:1'), {revision: 13, changed: true});
    assert.deepEqual(await m.objects.bulk({set: {'HmIP-RF.A:1': {enums: ['room/eg']}, 'HmIP-RF.C:1': {name: 'C'}}, delete: ['HmIP-RF.D:1']}), {revision: 14, changed: true});
    assert.deepEqual(await m.objects.assign('HmIP-RF.A:1', 'function/licht', true), {revision: 15, changed: true});
    assert.deepEqual(await c.rename('HmIP-RF.A:1', 'Lampe'), {revision: 16, changed: true});
    assert.deepEqual(await m.enums.create('floor', {de: 'Etagen', en: 'Floors'}), {revision: 17, changed: true});
    assert.deepEqual(await m.enums.update('floor', {name: {en: 'Levels'}}), {revision: 18, changed: true});
    box.opts.metaMembers = ['HmIP-RF.A:1'];
    await assert.rejects(m.enums.delete('room'), (e: OccuLiteError) => e.code === 'has-members' && (e.detail as {refs: string[]}).refs[0] === 'HmIP-RF.A:1');
    assert.deepEqual(await m.enums.delete('room', {detach: true}), {revision: 19, changed: true});
    box.opts.metaMembers = [];
    assert.deepEqual(await m.tree.create('room', {parent: 'room/eg', id: 'bad', name: 'Bad', icon: 'bath', position: 0}), {revision: 20, changed: true});
    await assert.rejects(m.tree.create('room', {parent: 'room/nowhere', id: 'x', name: 'x'}), (e: OccuLiteError) => e.code === 'unknown-path' && e.status === 422);
    assert.deepEqual(await m.tree.update('room/eg/bad', {parent: null, position: 1}), {revision: 21, changed: true});
    assert.deepEqual(await m.tree.delete('room/bad', {detach: true}), {revision: 22, changed: true});
    assert.deepEqual(await m.import({format: 1, revision: 0, objects: {}, enums: {}}, {mode: 'merge'}), {revision: 23, changed: true});
    assert.deepEqual(await m.import('format: 1\n', {mode: 'replace'}), {revision: 24, changed: true});
    assert.equal((await m.export()).revision, 24);
    assert.match(await m.export({format: 'yaml'}), /^format: 1/);
    assert.deepEqual((await m.enums.list()).revision, 24);
    // what went over the wire
    const w = box.metaWrites;
    assert.deepEqual(w.map((x) => `${x.method} ${x.path}`), [
        'PATCH /objects/HmIP-RF.A%3A1',
        'PUT /objects/HmIP-RF.B%3A1',
        'PATCH /objects/HmIP-RF.B%3A1',
        'PATCH /objects/HmIP-RF.B%3A1',
        'DELETE /objects/HmIP-RF.B%3A1',
        'POST /objects:bulk',
        'PATCH /objects/HmIP-RF.A%3A1',
        'PATCH /objects/HmIP-RF.A%3A1',
        'POST /enums',
        'PATCH /enums/floor',
        'DELETE /enums/room',
        'DELETE /enums/room?members=detach',
        'POST /enums/room/nodes',
        'POST /enums/room/nodes',
        'PATCH /enums/room/nodes/eg/bad',
        'DELETE /enums/room/nodes/bad?members=detach',
        'PUT /import?mode=merge',
        'PUT /import?mode=replace',
    ]);
    assert.equal(w[1].ifMatch, '11');
    assert.deepEqual(w[4].body, {}, 'a DELETE carries {} (lighttpd answers 411 to a body-less one)');
    assert.deepEqual(w[5].body, {set: {'HmIP-RF.A:1': {enums: ['room/eg']}, 'HmIP-RF.C:1': {name: 'C'}}, delete: ['HmIP-RF.D:1']});
    assert.deepEqual(w[6].body, {enums: ['room/eg', 'function/licht']}, 'assign adds to the copy\'s list');
    assert.deepEqual(w[8].body, {id: 'floor', name: {de: 'Etagen', en: 'Floors'}});
    assert.deepEqual(w[12].body, {parent: 'room/eg', id: 'bad', name: 'Bad', icon: 'bath', position: 0});
    assert.deepEqual(w[14].body, {parent: null, position: 1});
    assert.match(w[17].contentType ?? '', /yaml/);
    assert.match(w[16].contentType ?? '', /json/);
    // a credential without meta:write
    const ro = new FakeBox({token: 'olt_r', scopes: ['meta:read'], meta: {revision: 1, objects: {}, enums: {}}});
    await ro.start();
    t.after(() => ro.stop());
    const r = new OccuLite({url: ro.url, auth: {token: 'olt_r'}});
    t.after(() => r.close());
    await r.ready();
    await assert.rejects(r.meta.objects.rename('X.a:1', 'x'), (e: OccuLiteError) => e.code === 'forbidden' && e.scope === 'meta:write');
    // a copy on its own has no system to write to
    await assert.rejects(new MetaCopy().objects.rename('X.a:1', 'x'), (e: OccuLiteError) => e.code === 'unsupported');
});

test('a node.moved on the stream is applied in place, no new snapshot', async (t) => {
    const box = new FakeBox({meta: structuredClone(HOUSE)});
    await box.start();
    t.after(() => box.stop());
    const c = new OccuLite({url: box.url, values: false, devices: false});
    t.after(() => c.close());
    await c.ready();
    await until(() => box.metaStreamsOpened === 1);
    let snaps = 0;
    const orig = c.request.bind(c);
    (c as unknown as {request: typeof orig}).request = ((m: string, p: string, ...rest: unknown[]) => {
        if (p === '/api/meta/v1/snapshot') snaps++;
        return (orig as (...a: unknown[]) => Promise<unknown>)(m, p, ...rest);
    }) as typeof orig;
    box.metaEvent({revision: HOUSE.revision + 1, kind: 'node.moved', enum: 'room', from: 'room/og/bad', to: 'room/eg/bad'});
    await until(() => c.meta.revision === HOUSE.revision + 1);
    assert.deepEqual(c.meta.object('BidCos-RF.JEQ9000001:1')?.enums, ['room/eg/bad', 'function/heizung']);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(snaps, 0);
});
