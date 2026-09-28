import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

// a CommonJS consumer (node-red-contrib-ccu) loads the ESM package with require(esm): the built dist must stay
// requireable from a .cjs file - every entry point, with the classes and functions the porting guide names
test('the built package is require()able from CommonJS', {timeout: 60000}, (t) => {
    const out = mkdtempSync(join(tmpdir(), 'occulite-cjs-'));
    try {
        execFileSync(process.execPath, [join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json', '--outDir', out], {stdio: 'pipe'});
    } catch (e) {
        t.diagnostic(String((e as {stdout?: Buffer}).stdout ?? e));
        throw e;
    }
    writeFileSync(
        join(out, 'check.cjs'),
        `const {OccuLite, OccuLiteError, MetaCopy, SystemAPI, memoryCache, parseRef} = require('./index.js');
const node = require('./node/index.js');
const {callbackEvents} = require('./callbacks.js');
const {FakeBox} = require('./testing/fakebox.js');
const box = new OccuLite({url: 'http://127.0.0.1:1', meta: false, values: false});
if (typeof box.ready !== 'function' || !(box.system instanceof SystemAPI) || !(box.meta instanceof MetaCopy)) throw new Error('OccuLite');
for (const f of ['probe', 'probeUntil', 'pair', 'createClient', 'nodeAuth', 'nodeTransport', 'fileCache']) if (typeof node[f] !== 'function') throw new Error(f);
if (typeof callbackEvents !== 'function' || typeof FakeBox !== 'function' || typeof memoryCache !== 'function') throw new Error('entry points');
if (parseRef('HmIP-RF.A:1').address !== 'A:1' || !(new OccuLiteError('x', 'y') instanceof Error)) throw new Error('functions');
box.close();
console.log('cjs ok');
`,
    );
    const r = execFileSync(process.execPath, [join(out, 'check.cjs')], {encoding: 'utf8', stdio: 'pipe'});
    assert.equal(r.trim(), 'cjs ok');
});
