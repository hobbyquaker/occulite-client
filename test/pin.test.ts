import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync} from 'node:fs';
import https from 'node:https';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {X509Certificate} from 'node:crypto';
import {nodeTransport} from '../src/node/index.ts';
import {OccuLiteError} from '../src/errors.ts';

// the pin is checked on the TLS socket before anything - the credential least of all - is written
test('a pinned self-signed certificate: the right one passes, another is refused before the request', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'occulite-pin-'));
    try {
        execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2', '-subj', '/CN=openccu-lite', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], {stdio: 'ignore'});
    } catch {
        t.skip('no openssl');
        return;
    }
    const cert = readFileSync(join(dir, 'c.pem'), 'utf8');
    const fp = new X509Certificate(cert).fingerprint256;
    let requests = 0;
    const srv = https.createServer({key: readFileSync(join(dir, 'k.pem')), cert}, (_q, r) => {
        requests++;
        r.end('{"ok":true}');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    t.after(() => srv.close());
    const url = `https://127.0.0.1:${(srv.address() as {port: number}).port}/x`;
    const good = nodeTransport({fingerprint256: fp});
    const r = await good.request('GET', url, {Authorization: 'Bearer secret'});
    assert.equal(r.status, 200);
    assert.equal(good.lastFingerprint(), fp);
    const bad = nodeTransport({fingerprint256: 'AA:BB:CC'});
    await assert.rejects(bad.request('GET', url, {Authorization: 'Bearer secret'}), (e: OccuLiteError) => e.code === 'certificate' && e.certificate?.fingerprint256 === fp);
    assert.equal(requests, 1, 'the refused connection wrote no request');
    // without a pin the system's trust applies: a self-signed certificate is refused
    await assert.rejects(nodeTransport().request('GET', url, {}), (e: OccuLiteError) => e.code === 'certificate');
    // pairing's first contact takes any certificate and records it
    const any = nodeTransport({insecure: true});
    assert.equal((await any.request('GET', url, {})).status, 200);
    assert.equal(any.lastFingerprint(), fp);
});
