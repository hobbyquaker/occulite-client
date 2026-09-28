import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {OccuLite} from '../src/client.ts';
import {OccuLiteError} from '../src/errors.ts';
import {createClient, nodeAuth} from '../src/node/index.ts';
import {FakeBox} from '../src/testing/fakebox.ts';

test('names-only: a meta:read credential loads the names, skips lite-rpc, and every RPC method rejects forbidden', async (t) => {
    const box = new FakeBox({token: 'olt_local', scopes: ['meta:read'], meta: {revision: 2, objects: {'HmIP-RF.A:1': {name: 'Lampe'}}, enums: {}}, devices: {'HmIP-RF': [{ADDRESS: 'A'}]}});
    await box.start();
    t.after(() => box.stop());
    const c = new OccuLite({url: box.url, auth: {token: 'olt_local'}});
    t.after(() => c.close());
    const errors: unknown[] = [];
    c.on('error', (e: unknown) => errors.push(e));
    await c.ready();
    assert.equal(c.mode, 'names-only');
    assert.equal(c.credential, 'token');
    assert.equal(c.status, 'ready');
    assert.equal(c.meta.name('HmIP-RF.A:1'), 'Lampe');
    assert.deepEqual(c.interfaces, []);
    assert.equal(c.devices.size, 0);
    await assert.rejects(c.setValue('HmIP-RF.A:1.STATE', true), (e: OccuLiteError) => e.code === 'forbidden' && e.scope === 'rpc:read' && /names only/.test(e.message));
    await assert.rejects(c.batch('HmIP-RF', [['getValue', []]]), (e: OccuLiteError) => e.code === 'forbidden');
    await assert.rejects(c.history('HmIP-RF.A:1.STATE'), (e: OccuLiteError) => e.code === 'forbidden');
    assert.equal(box.calls.length, 0, 'no RPC request went out');
    assert.equal(box.streamsOpened, 0, 'no RPC stream was opened');
    // the metadata stream is followed
    const opened = Date.now() + 2000;
    while (box.metaStreamsOpened < 1 && Date.now() < opened) await new Promise((r) => setTimeout(r, 10));
    box.metaEvent({revision: 3, kind: 'object.updated', ref: 'HmIP-RF.A:1', value: {name: 'Deckenlampe'}});
    const end = Date.now() + 2000;
    while (c.meta.name('HmIP-RF.A:1') !== 'Deckenlampe' && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    assert.equal(c.meta.name('HmIP-RF.A:1'), 'Deckenlampe');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(c.status, 'ready', 'no stream 403 pulls it offline');
    assert.deepEqual(errors, []);
});

test('no credential: ready() rejects unauthenticated with the hint to pair', async (t) => {
    const box = new FakeBox({token: 'olt_x'});
    await box.start();
    t.after(() => box.stop());
    const c = new OccuLite({url: box.url});
    t.after(() => c.close());
    await assert.rejects(c.ready(), (e: OccuLiteError) => e.code === 'unauthenticated' && /pair/.test(e.message) && /auth: \{token\}/.test(e.message));
    assert.equal(c.credential, 'none');
    // a wrong token names the credential
    const w = new OccuLite({url: box.url, auth: {token: 'olt_wrong'}});
    t.after(() => w.close());
    await assert.rejects(w.ready(), (e: OccuLiteError) => e.code === 'unauthenticated' && /token credential/.test(e.message));
});

test('nodeAuth: the order of auto - environment, the addon token, the local token, none - and the explicit forms', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'occulite-auth-'));
    const local = join(dir, 'local-token');
    const addons = join(dir, 'addon-tokens');
    const o = {localTokenFile: local, addonTokenDir: addons, env: {} as Record<string, string | undefined>};
    assert.deepEqual(await nodeAuth('auto', o).resolve('start'), {credential: 'none'});
    assert.deepEqual(await nodeAuth({local: true}, o).resolve('start'), {credential: 'none'});
    writeFileSync(local, '\nolt_local_token   \n');
    assert.deepEqual(await nodeAuth('auto', o).resolve('start'), {token: 'olt_local_token', credential: 'local'});
    assert.deepEqual(await nodeAuth('auto', {...o, addon: 'hm2mqtt'}).resolve('start'), {token: 'olt_local_token', credential: 'local'}, 'no addon file yet');
    const {mkdirSync} = await import('node:fs');
    mkdirSync(addons);
    writeFileSync(join(addons, 'hm2mqtt.api'), 'olt_addon_token\n');
    assert.deepEqual(await nodeAuth('auto', {...o, addon: 'hm2mqtt'}).resolve('start'), {token: 'olt_addon_token', credential: 'addon'});
    assert.deepEqual(await nodeAuth('auto', o).resolve('start'), {token: 'olt_local_token', credential: 'local'}, 'auto without an addon name skips the addon dir');
    assert.deepEqual(await nodeAuth('auto', {...o, addon: 'hm2mqtt', env: {OCCULITE_TOKEN: 'olt_env'}}).resolve('start'), {token: 'olt_env', credential: 'token'});
    assert.deepEqual(await nodeAuth({addon: 'hm2mqtt'}, o).resolve('start'), {token: 'olt_addon_token', credential: 'addon'});
    assert.deepEqual(await nodeAuth({addon: 'nope'}, o).resolve('start'), {credential: 'none'});
    assert.deepEqual(await nodeAuth({token: 'olt_t'}).resolve('start'), {token: 'olt_t', credential: 'token'});
    assert.deepEqual(await nodeAuth({session: 'SID'}).resolve('start'), {session: 'SID', credential: 'session'});
    assert.deepEqual(await nodeAuth({none: true}).resolve('start'), {credential: 'none'});
});

test('createClient: the local token file is read at connect and again after a 401 (a token created later)', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'occulite-auth-'));
    const local = join(dir, 'local-token');
    writeFileSync(local, 'olt_one\n');
    const box = new FakeBox({token: 'olt_one', scopes: ['meta:read'], meta: {revision: 1, objects: {}, enums: {}}});
    await box.start();
    t.after(() => box.stop());
    const c = createClient({url: box.url, auth: 'auto', localTokenFile: local, addonTokenDir: join(dir, 'none'), env: {}});
    t.after(() => c.close());
    await c.ready();
    assert.equal(c.credential, 'local');
    assert.equal(c.mode, 'names-only');
    // the system minted a new local token and the file was rewritten: the next 401 makes the client re-read it
    box.opts.token = 'olt_two';
    writeFileSync(local, 'olt_two\n');
    const st = await c.request<{authenticated: boolean}>('GET', '/api/auth/v1/state');
    assert.equal(st.authenticated, true);
    // a file that still holds the old token: the 401 stands
    box.opts.token = 'olt_three';
    await new Promise((r) => setTimeout(r, 20));
    await assert.rejects(c.request('GET', '/api/auth/v1/state'), (e: OccuLiteError) => e.code === 'unauthenticated');
});
