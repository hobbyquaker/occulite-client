import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MetaCopy} from '../src/meta.ts';
import {OccuLiteError, abortError, httpError} from '../src/index.ts';
import {pairingCode} from '../src/node/index.ts';
import {datapointRef, deviceOf, parseDatapointRef, parseRef, ref} from '../src/refs.ts';
import {parseSSE} from '../src/sse.ts';

test('refs', () => {
    assert.equal(ref('HmIP-RF', '000A1B2C3D4E5F:4'), 'HmIP-RF.000A1B2C3D4E5F:4');
    assert.equal(datapointRef('BidCos-RF', 'JEQ0230153:1', 'STATE'), 'BidCos-RF.JEQ0230153:1.STATE');
    assert.deepEqual(parseRef('HmIP-RF.000A1B2C3D4E5F:4'), {interface: 'HmIP-RF', address: '000A1B2C3D4E5F:4'});
    assert.deepEqual(parseDatapointRef('HmIP-RF.000A1B2C3D4E5F:4.LEVEL'), {interface: 'HmIP-RF', address: '000A1B2C3D4E5F:4', key: 'LEVEL'});
    assert.equal(deviceOf('JEQ0230153:1'), 'JEQ0230153');
    assert.throws(() => parseRef('nodot'));
    assert.throws(() => parseDatapointRef('HmIP-RF.ABC'));
});

async function* chunks(parts: string[]) {
    for (const p of parts) yield new TextEncoder().encode(p);
}

test('SSE: split chunks, CRLF, comments, several data lines', async () => {
    let pings = 0;
    const out = [];
    for await (const m of parseSSE(chunks([': connected\r\n\r\nid: b-1\r\nevent: hel', 'lo\r\ndata: {"a":1}\r\n\r\n', 'data: x\ndata: y\n\n: ping\n\n']), () => pings++)) out.push(m);
    assert.deepEqual(out, [{id: 'b-1', event: 'hello', data: '{"a":1}'}, {id: undefined, event: 'message', data: 'x\ny'}]);
    assert.equal(pings, 2);
});

test('the pairing code is the system\'s (the Go side\'s vectors)', () => {
    const n = Buffer.from([...Array(16).keys()]);
    const c = Buffer.from([...Array(16).keys()].map((i) => 16 + i));
    assert.equal(pairingCode(n, c, Buffer.alloc(0)), '848873');
    assert.equal(pairingCode(n, c, Buffer.from([0xab, 0xcd, 0xef])), '998994');
});

test('the metadata copy: events in place, a gap asks for a snapshot, the tree', () => {
    const m = new MetaCopy();
    // the format's shape: enums.<id>.tree, nodes with children (docs/meta-format.md)
    m.load({format: 1, revision: 5, objects: {'HmIP-RF.A:1': {name: 'Lampe', enums: ['room/eg/wz']}}, enums: {room: {name: {en: 'Rooms'}, tree: [{id: 'eg', name: 'EG', children: [{id: 'wz', name: 'Wohnzimmer'}]}]}, function: {tree: [{id: 'licht', name: {de: 'Licht', en: 'Light'}}]}}});
    assert.equal(m.name('HmIP-RF.A:1'), 'Lampe');
    assert.equal(m.apply({revision: 6, kind: 'object.updated', ref: 'HmIP-RF.B:1', value: {name: 'Kontakt', enums: ['function/licht']}}), true);
    assert.equal(m.apply({revision: 6, kind: 'object.updated', ref: 'HmIP-RF.B:1', value: {}}), true, 'a replay is ignored');
    assert.equal(m.name('HmIP-RF.B:1'), 'Kontakt');
    assert.equal(m.apply({revision: 8, kind: 'object.deleted', ref: 'HmIP-RF.B:1'}), false, 'a gap');
    assert.equal(m.apply({revision: 7, kind: 'node.moved'}), false, 'a node change needs a snapshot');
    const direct = m.rooms();
    assert.deepEqual(direct.map((n) => [n.path, n.name, n.refs]), [['room/eg', 'EG', []], ['room/eg/wz', 'Wohnzimmer', ['HmIP-RF.A:1']]]);
    assert.deepEqual(m.rooms({inherit: true})[0].refs, ['HmIP-RF.A:1']);
    assert.deepEqual(m.membershipNames('HmIP-RF.A:1'), {rooms: ['Wohnzimmer', 'EG'], functions: []}, 'most specific first, the ancestors after');
    assert.deepEqual(m.membershipNames('HmIP-RF.A:1', {inherit: false}), {rooms: ['Wohnzimmer'], functions: []});
    assert.deepEqual(m.membership('HmIP-RF.B:1', {lang: 'en'}).functions, [{path: 'function/licht', id: 'licht', name: 'Light', depth: 1}]);
    assert.deepEqual(m.membershipNames('HmIP-RF.B:1', {lang: 'de'}), {rooms: [], functions: ['Licht']});
    assert.deepEqual(m.channels().map((c) => c.ref), ['HmIP-RF.A:1', 'HmIP-RF.B:1']);
});

test('httpError and abortError are exported from the root, and build the client\'s errors', () => {
    const forbidden = httpError(403, {error: 'forbidden', message: 'needs meta:write'});
    assert.ok(forbidden instanceof OccuLiteError);
    assert.equal(forbidden.code, 'forbidden');
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.scope, 'meta:write');
    assert.equal(httpError(404, {}).code, 'not-found');
    assert.equal(httpError(502, 'bad gateway').code, 'http-502');
    assert.equal(abortError(undefined).code, 'aborted');
    const ac = new AbortController();
    ac.abort(new DOMException('late', 'TimeoutError'));
    assert.equal(abortError(ac.signal, 'the sweep').code, 'timeout');
    assert.equal(abortError(ac.signal, 'the sweep').message, 'the sweep timed out');
});
