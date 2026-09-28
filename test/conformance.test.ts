// occulited's conformance corpus (its D-16), run against the copy's read side: every valid document
// loads and round-trips, every case's reads before its first write - the subtree queries with the
// tree semantics, the objects - answer what the store would, and an unknown path is refused with
// the store's code. The writes are the store's (occulited in Go, homematic-manager's local provider
// in TypeScript); this copy only follows them. OPENCCU_LITE_FIXTURES points at an occulited checkout's
// fixtures/ to run the upstream files instead of the vendored copy (test/fixtures/meta/NOTICE.md).

import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {OccuLiteError} from '../src/errors.ts';
import {MetaCopy, type MetaDocument} from '../src/meta.ts';

const VENDORED = path.join(import.meta.dirname, 'fixtures', 'meta');
const CORPUS = process.env.OPENCCU_LITE_FIXTURES ?? VENDORED;
const read = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>;
const files = (d: string) => readdirSync(path.join(CORPUS, d)).filter((n) => n.endsWith('.json')).sort();

const WRITES = new Set(['object.set', 'object.put', 'object.delete', 'objects.bulk', 'enum.create', 'enum.delete', 'node.create', 'node.update', 'node.delete', 'orphan.set', 'import']);

function subset(actual: unknown, expected: unknown, at: string): void {
    if (Array.isArray(expected)) return void assert.deepEqual(actual, expected, at);
    if (expected && typeof expected === 'object') {
        assert.equal(typeof actual, 'object', at);
        for (const [k, v] of Object.entries(expected)) subset((actual as Record<string, unknown>)[k], v, `${at}.${k}`);
        return;
    }
    assert.equal(actual, expected, at);
}

test(`the conformance corpus (${CORPUS === VENDORED ? 'the vendored copy' : CORPUS}): every valid document loads and round-trips`, () => {
    let n = 0;
    for (const f of files('store')) {
        const raw = read(path.join(CORPUS, 'store', f));
        if (typeof raw._reason === 'string') continue; // an invalid document is the store's to refuse; the copy takes what the system gave it
        const m = new MetaCopy();
        m.load(raw as unknown as MetaDocument);
        assert.equal(m.snapshot().format, 1, f);
        assert.deepEqual(m.snapshot(), raw, `${f} round-trips`);
        n++;
    }
    assert.ok(n >= 3, `${n} valid documents`);
});

for (const f of files('cases')) {
    const c = read(path.join(CORPUS, 'cases', f)) as {title: string; start: 'empty' | MetaDocument; ops: Record<string, unknown>[]};
    test(`${f}: ${c.title} - the reads before the first write`, () => {
        const m = new MetaCopy();
        m.load(c.start === 'empty' ? {format: 1, revision: 0, objects: {}, enums: {room: {name: {en: 'Rooms'}, tree: []}, function: {name: {en: 'Functions'}, tree: []}}} : c.start);
        let reads = 0;
        for (const op of c.ops) {
            if (WRITES.has(op.op as string)) break;
            const expect = op.expect as Record<string, unknown>;
            switch (op.op) {
                case 'objects.query': {
                    if (typeof expect.error === 'string') {
                        assert.throws(() => m.query(op.enum as string, {orphaned: op.orphaned as boolean | undefined}), (e: OccuLiteError) => e.code === expect.error, `${f} ${op.enum} → ${expect.error}`);
                    } else {
                        assert.deepEqual(m.query(op.enum as string, {orphaned: op.orphaned as boolean | undefined}), expect.refs, `${f} query ${op.enum}`);
                    }
                    reads++;
                    break;
                }
                case 'object.get': {
                    if (typeof expect.error === 'string') assert.equal(m.object(op.ref as string), undefined, `${f} ${op.ref} → ${expect.error}`);
                    else subset(m.object(op.ref as string), expect.value, `${f} object ${op.ref}`);
                    reads++;
                    break;
                }
                default:
                    break; // events.since: the stream's, not the copy's
            }
        }
        if (c.ops.length && !WRITES.has(c.ops[0].op as string)) assert.ok(reads > 0, `${f} has reads to check`);
    });
}
