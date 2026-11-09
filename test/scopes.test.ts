import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {test} from 'node:test';
import {OccuLite} from '../src/client.ts';
import {OccuLiteError} from '../src/errors.ts';
import {covers, normalizeScopes} from '../src/index.ts';
import {pair} from '../src/node/index.ts';
import {FakeBox, PAIRING_LEVELS, pairingScopes} from '../src/testing/fakebox.ts';

const DEVICES = {'HmIP-RF': [{ADDRESS: '000A1B2C3D4E5F', TYPE: 'HmIP-PDT'}, {ADDRESS: '000A1B2C3D4E5F:4', PARENT: '000A1B2C3D4E5F', TYPE: 'DIMMER_VIRTUAL_RECEIVER'}]};

test('covers: a write includes its read, each rpc tier the ones before it, * everything', () => {
    const tiers = ['rpc:read', 'rpc:operate', 'rpc:configure', 'rpc:admin'];
    for (const [i, have] of tiers.entries()) {
        for (const [j, want] of tiers.entries()) assert.equal(covers([have], want), j <= i, `${have} covers ${want}`);
        assert.equal(covers(['*'], have), true);
    }
    assert.equal(covers(['meta:write'], 'meta:read'), true);
    assert.equal(covers(['meta:read'], 'meta:write'), false);
    assert.equal(covers(['system:write'], 'system:read'), true);
    assert.equal(covers(['system:write'], 'led'), true);
    assert.equal(covers(['system:write'], 'logs:read'), false, 'the journal is its own scope');
    assert.equal(covers(['addons:write'], 'system:read'), true);
    assert.equal(covers(['auth:admin'], 'self'), true);
    assert.equal(covers(['power'], 'power:halt'), true);
    assert.equal(covers(['power:halt'], 'power'), false);
    assert.equal(covers(['addon:hm2mqtt'], 'addon:hm2mqtt'), true);
    assert.equal(covers(['addon:hm2mqtt'], 'addon:other'), false);
    assert.equal(covers([], 'rpc:read'), false);
    assert.equal(covers(['meta:read', 'rpc:operate'], 'rpc:read'), true);
});

test('normalizeScopes: the list as the system shows it - the highest tier, sorted, once, * alone, never self', () => {
    assert.deepEqual(normalizeScopes(['rpc:read', 'rpc:operate', 'meta:read']), ['meta:read', 'rpc:operate']);
    assert.deepEqual(normalizeScopes(['rpc:admin', 'rpc:configure', 'rpc:read', 'meta:write', 'meta:read', 'system:read', 'logs:read', 'system:write']), ['logs:read', 'meta:write', 'rpc:admin', 'system:write']);
    assert.deepEqual(normalizeScopes(['meta:read', '*', 'rpc:read']), ['*']);
    assert.deepEqual(normalizeScopes(['self', 'meta:read', 'meta:read']), ['meta:read']);
    assert.deepEqual(normalizeScopes([]), []);
});

test("FakeBox's pairing scopes: occulited's levels, the addons, the 422 reasons", () => {
    assert.deepEqual(pairingScopes({devices: 'read'}), ['rpc:read']);
    assert.deepEqual(pairingScopes({devices: 'operate', names: 'read'}), ['meta:read', 'rpc:operate']);
    assert.deepEqual(pairingScopes({devices: 'configure', names: 'configure'}), ['meta:write', 'rpc:configure']);
    assert.deepEqual(pairingScopes({devices: 'administer', names: 'configure', system: 'configure'}), ['logs:read', 'meta:write', 'rpc:admin', 'system:write']);
    assert.deepEqual(pairingScopes({system: 'read', backup: 'download'}), ['backup', 'logs:read', 'system:read']);
    assert.deepEqual(pairingScopes({devices: 'none', names: ''}, ['hm2mqtt']), ['addon:hm2mqtt']);
    assert.match(pairingScopes({rooms: 'read'}) as string, /unknown area "rooms"/);
    assert.match(pairingScopes({devices: 'write'}) as string, /devices has no level "write" \(administer, configure, operate, read\)/);
    assert.match(pairingScopes({devices: 'toString'}) as string, /no level/, 'no prototype key passes for a level');
    assert.match(pairingScopes({}) as string, /at least one area/);
    assert.match(pairingScopes(undefined) as string, /at least one area/);
    assert.deepEqual(Object.keys(PAIRING_LEVELS), ['devices', 'names', 'system', 'backup']);
});

// every tier as pairing grants it: the auth state lists the highest only, and the client runs full with it
for (const level of ['read', 'operate', 'configure', 'administer'] as const) {
    test(`a token paired for devices at ${level}: the auth state lists the tier alone, the client runs full`, async (t) => {
        const granted = [...PAIRING_LEVELS.devices[level], 'meta:read'];
        const box = new FakeBox({token: 'olt_t', scopes: granted, devices: DEVICES});
        await box.start();
        t.after(() => box.stop());
        const c = new OccuLite({url: box.url, auth: {token: 'olt_t'}});
        t.after(() => c.close());
        await c.ready();
        const tier = level === 'administer' ? 'rpc:admin' : `rpc:${level}`;
        assert.deepEqual(c.scopes, ['meta:read', tier].sort(), 'as occulited lists it');
        assert.equal(c.mode, 'full');
        assert.deepEqual(c.interfaces.map((i) => i.name), ['HmIP-RF']);
        assert.equal(c.devices.size, 2);
        assert.equal(c.hasScope('rpc:read'), true);
        assert.equal(c.hasScope('rpc:operate'), level !== 'read');
        assert.equal(c.hasScope('rpc:admin'), level === 'administer');
        assert.equal(c.hasScope('meta:write'), false);
        assert.equal(box.streamsOpened, 1);
    });
}

test('a token holding only the highest tier (rpc:admin), or Full access, reads lite-rpc from FakeBox too', async (t) => {
    for (const scopes of [['rpc:admin'], ['*'], ['rpc:operate', 'meta:read']]) {
        const box = new FakeBox({token: 'olt_t', scopes, devices: DEVICES, values: {'HmIP-RF.000A1B2C3D4E5F:4.LEVEL': {value: 0.5}}});
        await box.start();
        t.after(() => box.stop());
        const c = new OccuLite({url: box.url, auth: {token: 'olt_t'}});
        t.after(() => c.close());
        await c.ready();
        assert.equal(c.mode, 'full', scopes.join());
        assert.equal(c.devices.size, 2);
        assert.equal(await c.getValue('HmIP-RF.000A1B2C3D4E5F:4.LEVEL'), 0.5);
    }
});

test('hasScope: true before connect (nothing known yet); a meta:read credential lacks every rpc tier', async (t) => {
    const box = new FakeBox({token: 'olt_l', scopes: ['meta:read'], meta: {revision: 1, objects: {}, enums: {}}});
    await box.start();
    t.after(() => box.stop());
    const c = new OccuLite({url: box.url, auth: {token: 'olt_l'}});
    t.after(() => c.close());
    assert.equal(c.hasScope('rpc:admin'), true);
    await c.ready();
    assert.equal(c.mode, 'names-only');
    for (const s of ['rpc:read', 'rpc:operate', 'rpc:configure', 'rpc:admin', 'meta:write']) assert.equal(c.hasScope(s), false, s);
    assert.equal(c.hasScope('meta:read'), true);
});

test("pair() at devices: administer: the system's answer (the tiers, not rpc:read beside them), and the token reads devices", async (t) => {
    const box = new FakeBox({token: 'olt_other', scopes: ['meta:read'], autoApprove: true, devices: DEVICES, meta: {revision: 1, objects: {}, enums: {}}});
    await box.start();
    t.after(() => box.stop());
    const p = await pair({url: box.url, app: 'test-app', access: {devices: 'administer', names: 'configure', system: 'configure'}, onCode: () => {}});
    assert.deepEqual(p.scopes, ['logs:read', 'meta:write', 'rpc:admin', 'system:write']);
    assert.deepEqual(p.access, {devices: 'administer', names: 'configure', system: 'configure'});
    assert.deepEqual(box.tokens.get(p.token), p.scopes);
    const c = new OccuLite({url: box.url, auth: {token: p.token}});
    t.after(() => c.close());
    await c.ready();
    assert.deepEqual(c.scopes, p.scopes);
    assert.equal(c.mode, 'full');
    assert.equal(c.devices.size, 2);
    assert.equal((await c.system.status()).hostname, 'fakebox', 'system:write includes system:read');
    assert.deepEqual(await c.meta.objects.patch('HmIP-RF.000A1B2C3D4E5F:4', {name: 'Lampe'}), {revision: 2, changed: true}, 'meta:write');
    // the box's own token keeps its own scopes beside the paired one
    const own = new OccuLite({url: box.url, auth: {token: 'olt_other'}});
    t.after(() => own.close());
    await own.ready();
    assert.equal(own.mode, 'names-only');
    await assert.rejects(own.meta.objects.patch('HmIP-RF.000A1B2C3D4E5F:4', {name: 'x'}), (e: OccuLiteError) => e.code === 'forbidden' && e.scope === 'meta:write');
    await assert.rejects(own.listInterfaces(), (e: OccuLiteError) => e.code === 'forbidden' && e.scope === 'rpc:read');
});

test("FakeBox's pairing request: 422 for an unknown area or level, the addons' scopes in the approval", async (t) => {
    const box = new FakeBox({autoApprove: true});
    await box.start();
    t.after(() => box.stop());
    const post = (body: unknown) => fetch(`${box.url}/api/auth/v1/pairing/request`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    const bad = await post({app: 'x', access: {devices: 'write'}, commit: 'c'});
    assert.equal(bad.status, 422);
    assert.equal((await bad.json()).error, 'invalid');
    assert.equal((await post({app: 'x', access: {}, commit: 'c'})).status, 422);
    const nonce = randomBytes(16);
    const r = await post({app: 'x', addons: ['hm2mqtt'], access: {devices: 'operate'}, commit: createHash('sha256').update(nonce).digest('hex')});
    assert.equal(r.status, 202);
    const {id, poll} = await r.json();
    const answer = await (await fetch(`${box.url}/api/auth/v1/pairing/request/${id}?client_nonce=${nonce.toString('hex')}`, {headers: {Authorization: `Pairing ${poll}`}})).json();
    assert.equal(answer.state, 'approved');
    assert.deepEqual(answer.scopes, ['addon:hm2mqtt', 'rpc:operate']);
    assert.deepEqual(answer.addons, ['hm2mqtt']);
    // the token is a credential now: the auth state answers its scopes
    const st = await (await fetch(`${box.url}/api/auth/v1/state`, {headers: {Authorization: `Bearer ${answer.token}`}})).json();
    assert.deepEqual(st, {authenticated: true, scopes: ['addon:hm2mqtt', 'rpc:operate']});
});
