import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {descriptionKey, memoryCache} from '../src/cache.ts';
import {OccuLite} from '../src/client.ts';
import {fileCache} from '../src/node/index.ts';
import {FakeBox} from '../src/testing/fakebox.ts';

const DEV = {ADDRESS: '000A1B2C3D4E5F', TYPE: 'HmIP-PDT', FIRMWARE: '1.2.0', VERSION: 4, PARAMSETS: ['MASTER']};
const CH = (n: number) => ({ADDRESS: `000A1B2C3D4E5F:${n}`, PARENT: '000A1B2C3D4E5F', PARENT_TYPE: 'HmIP-PDT', TYPE: 'DIMMER_VIRTUAL_RECEIVER', PARAMSETS: ['MASTER', 'VALUES']});
const DESC = {LEVEL: {TYPE: 'FLOAT', OPERATIONS: 7}, RAMP_TIME: {TYPE: 'FLOAT', OPERATIONS: 2}};
const KEY = 'HmIP-RF/HmIP-PDT/1.2.0/4/DIMMER_VIRTUAL_RECEIVER/VALUES';

function box(): FakeBox {
    return new FakeBox({devices: {'HmIP-RF': [DEV, CH(4), CH(5), CH(6), {ADDRESS: 'X:1', TYPE: 'ORPHAN'}]}, descriptions: {'HmIP-RF.000A1B2C3D4E5F:4': DESC, 'HmIP-RF.000A1B2C3D4E5F:5': DESC, 'HmIP-RF.000A1B2C3D4E5F:6': DESC, 'HmIP-RF.X:1': {STATE: {TYPE: 'BOOL'}}}, meta: {revision: 7, objects: {'HmIP-RF.000A1B2C3D4E5F:4': {name: 'Deckenlampe'}}, enums: {}}});
}

test('descriptionKey: the consumers\' key - device level, channel level, a link paramset', () => {
    assert.equal(descriptionKey('BidCos-RF', {TYPE: 'HM-CC-RT-DN-BoM', FIRMWARE: '1.1', VERSION: 4}, undefined, 'MASTER'), 'BidCos-RF/HM-CC-RT-DN-BoM/1.1/4//MASTER');
    assert.equal(descriptionKey('BidCos-RF', {TYPE: 'HM-CC-RT-DN-BoM', FIRMWARE: '1.1', VERSION: 4}, {TYPE: 'CLIMATECONTROL_RECEIVER'}, 'VALUES'), 'BidCos-RF/HM-CC-RT-DN-BoM/1.1/4/CLIMATECONTROL_RECEIVER/VALUES');
    assert.equal(descriptionKey('BidCos-RF', {TYPE: 'HM-LC-Sw1', FIRMWARE: '2.8', VERSION: 1}, {TYPE: 'SWITCH'}, 'JEQ0123456:1'), 'BidCos-RF/HM-LC-Sw1/2.8/1/SWITCH/LINK');
});

test('three channels of one type ask getParamsetDescription once; a channel outside box.devices is asked per channel', async (t) => {
    const b = box();
    await b.start();
    t.after(() => b.stop());
    const c = new OccuLite({url: b.url, values: false, meta: false});
    t.after(() => c.close());
    await c.ready();
    assert.equal(c.descriptionKey('HmIP-RF.000A1B2C3D4E5F:5'), KEY);
    assert.equal(c.descriptionKey('HmIP-RF.000A1B2C3D4E5F'), 'HmIP-RF/HmIP-PDT/1.2.0/4//VALUES', 'the device itself');
    assert.equal(c.descriptionKey('HmIP-RF.NOPE:1'), undefined);
    assert.deepEqual(await c.paramsetDescription('HmIP-RF.000A1B2C3D4E5F:4'), DESC);
    assert.deepEqual(await c.paramsetDescription('HmIP-RF.000A1B2C3D4E5F:5'), DESC);
    await c.setValue('HmIP-RF.000A1B2C3D4E5F:6.LEVEL', 1); // the typed double asks the description
    const asked = () => b.calls.filter((x) => x.method === 'getParamsetDescription').map((x) => x.params[0]);
    assert.deepEqual(asked(), ['000A1B2C3D4E5F:4'], 'one call for the type');
    assert.deepEqual(b.calls.at(-1)!.params, ['000A1B2C3D4E5F:6', 'LEVEL', {double: 1}]);
    // a channel the device lists do not know: per channel, as before
    await c.paramsetDescription('HmIP-RF.Y:1').catch(() => {});
    assert.deepEqual(asked(), ['000A1B2C3D4E5F:4', 'Y:1']);
});

test('fileCache: a node-red-contrib-ccu-shaped seed answers without a call; a restart on the same file makes none; the snapshot is kept', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'occulite-cache-'));
    const seed = join(dir, 'paramsets.json');
    writeFileSync(seed, JSON.stringify({[KEY]: DESC, 'BidCos-RF/HM-LC-Sw1/2.8/1/SWITCH/VALUES': {STATE: {TYPE: 'BOOL'}}}));
    const file = join(dir, 'occulite-cache.json');
    const b = box();
    await b.start();
    t.after(() => b.stop());
    const cache = fileCache(file, {seed, debounceMs: 20});
    const c = new OccuLite({url: b.url, values: false, cache});
    t.after(() => c.close());
    await c.ready();
    assert.deepEqual(await c.paramsetDescription('HmIP-RF.000A1B2C3D4E5F:4'), DESC);
    assert.equal(b.calls.filter((x) => x.method === 'getParamsetDescription').length, 0, 'the seed answered');
    await c.paramsetDescription('HmIP-RF.X:1'); // not in the seed, not derivable (no PARENT): fetched per channel, not cached by type
    assert.equal(b.calls.filter((x) => x.method === 'getParamsetDescription').length, 1);
    await cache.flush();
    const written = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(written[KEY], undefined, 'the seed is not copied into the file');
    assert.equal(written['meta/snapshot'].revision, 7, 'the snapshot is in the file');
    assert.equal(written['meta/snapshot'].objects['HmIP-RF.000A1B2C3D4E5F:4'].name, 'Deckenlampe');
    c.close();

    // a restart: the same file (and seed); the system's snapshot is not there yet - the names are, from the file
    b.opts.metaRoute = false;
    b.calls.length = 0;
    const cache2 = fileCache(file, {seed, debounceMs: 20});
    const c2 = new OccuLite({url: b.url, values: false, cache: cache2});
    t.after(() => c2.close());
    await c2.ready();
    assert.equal(c2.meta.name('HmIP-RF.000A1B2C3D4E5F:4'), 'Deckenlampe', 'the cached snapshot');
    assert.equal(c2.meta.revision, 7);
    await c2.setValue('HmIP-RF.000A1B2C3D4E5F:5.LEVEL', 0);
    assert.equal(b.calls.filter((x) => x.method === 'getParamsetDescription').length, 0, 'no description call after the restart');
    assert.deepEqual(b.calls.at(-1)!.params, ['000A1B2C3D4E5F:5', 'LEVEL', {double: 0}]);
    // a fetched description lands in the file under the consumers' key
    b.opts.devices!['HmIP-RF'].push({ADDRESS: 'Z', TYPE: 'HmIP-SWDO', FIRMWARE: '1.0.0', VERSION: 2}, {ADDRESS: 'Z:1', PARENT: 'Z', TYPE: 'SHUTTER_CONTACT'});
    b.opts.descriptions!['HmIP-RF.Z:1'] = {STATE: {TYPE: 'BOOL'}};
    b.push('newDevices', {interface: 'HmIP-RF', addresses: ['Z', 'Z:1']});
    const end = Date.now() + 2000;
    while (!c2.devices.has('HmIP-RF.Z:1') && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    await c2.paramsetDescription('HmIP-RF.Z:1');
    await cache2.flush();
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8'))['HmIP-RF/HmIP-SWDO/1.0.0/2/SHUTTER_CONTACT/VALUES'], {STATE: {TYPE: 'BOOL'}});
    await cache2.close();
});

test('memoryCache is the default and shared by nothing else; the sweep skips a channel whose cached description has store keys only', async (t) => {
    const b = new FakeBox({devices: {'HmIP-RF': [DEV, CH(4), CH(5)]}, descriptions: {'HmIP-RF.000A1B2C3D4E5F:4': {LEVEL: {TYPE: 'FLOAT'}}}, storeKeys: ['LEVEL'], values: {'HmIP-RF.000A1B2C3D4E5F:4.LEVEL': {value: 1}, 'HmIP-RF.000A1B2C3D4E5F:5.LEVEL': {value: 0}}});
    await b.start();
    t.after(() => b.stop());
    const cache = memoryCache();
    const c = new OccuLite({url: b.url, values: 'all', meta: false, cache, sweepPaceMs: 5});
    t.after(() => c.close());
    const sweeps: {channels: number; skipped: number}[] = [];
    c.on('sweep', (s: {channels: number; skipped: number}) => sweeps.push(s));
    await c.paramsetDescription('HmIP-RF.000A1B2C3D4E5F:4').catch(() => {}); // before ready: the devices are not known yet, so per channel
    await c.ready();
    await c.paramsetDescription('HmIP-RF.000A1B2C3D4E5F:5'); // now by type, into the cache
    assert.equal(cache.size, 1);
    const end = Date.now() + 2000;
    while (!sweeps.length && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    // both channels' VALUES description names LEVEL only, which the store keeps: both skipped, unless the sweep ran first
    assert.equal(sweeps[0].channels + sweeps[0].skipped, 2);
});
