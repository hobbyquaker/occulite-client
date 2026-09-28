import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import https from 'node:https';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {X509Certificate} from 'node:crypto';
import {nodeTransport, probe} from '../src/node/index.ts';
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

// a CA-signed certificate nothing trusts: the error carries the leaf, the chain and the CA with its PEM - what a
// consumer's *Trust the CA* stores - and the CA passed as trust.ca lets the request through
test('a CA-signed certificate: the error names the CA with its PEM; trust.ca accepts it; probe() returns the certificate', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'occulite-ca-'));
    const ossl = (args: string[]) => execFileSync('openssl', args, {stdio: 'ignore'});
    try {
        ossl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2', '-subj', '/CN=lab-ca', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign', '-keyout', join(dir, 'ca.key'), '-out', join(dir, 'ca.pem')]);
        ossl(['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-subj', '/CN=openccu-lite', '-keyout', join(dir, 's.key'), '-out', join(dir, 's.csr')]);
        writeFileSync(join(dir, 'ext.cnf'), 'subjectAltName=IP:127.0.0.1,DNS:openccu-lite\nbasicConstraints=CA:FALSE\n');
        ossl(['x509', '-req', '-in', join(dir, 's.csr'), '-CA', join(dir, 'ca.pem'), '-CAkey', join(dir, 'ca.key'), '-CAcreateserial', '-days', '2', '-extfile', join(dir, 'ext.cnf'), '-out', join(dir, 's.pem')]);
    } catch {
        t.skip('no openssl');
        return;
    }
    const caPem = readFileSync(join(dir, 'ca.pem'), 'utf8');
    const leafPem = readFileSync(join(dir, 's.pem'), 'utf8');
    const caFp = new X509Certificate(caPem).fingerprint256;
    let requests = 0;
    const srv = https.createServer({key: readFileSync(join(dir, 's.key')), cert: leafPem + caPem}, (_q, r) => {
        requests++;
        r.end('{"api":"meta","version":1}');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    t.after(() => srv.close());
    const url = `https://127.0.0.1:${(srv.address() as {port: number}).port}`;
    const same = (a: string, b: string) => a.replace(/\s+/g, '') === b.replace(/\s+/g, '');

    // nothing trusts it: the error is the consumer's trust dialog
    await assert.rejects(nodeTransport().request('GET', `${url}/x`, {Authorization: 'Bearer secret'}), (e: OccuLiteError) => {
        assert.equal(e.code, 'certificate');
        assert.equal(e.reason, 'SELF_SIGNED_CERT_IN_CHAIN');
        assert.equal(e.certificate?.subject, 'openccu-lite');
        assert.equal(e.certificate?.issuer, 'lab-ca');
        assert.match(e.certificate?.altNames ?? '', /IP Address:127\.0\.0\.1/);
        assert.ok(same(e.certificate?.pem ?? '', leafPem), 'the leaf PEM');
        assert.equal(e.chain?.length, 2);
        assert.equal(e.ca?.subject, 'lab-ca');
        assert.equal(e.ca?.fingerprint256, caFp);
        assert.ok(same(e.ca?.pem ?? '', caPem), 'the CA PEM');
        assert.match(e.message, /issued by lab-ca/);
        return true;
    });
    assert.equal(requests, 0, 'nothing was written to the refused server');
    // trusting the CA (beside Node's defaults) lets it through; the identity is checked against the IP
    const trusting = nodeTransport({ca: caPem});
    assert.equal((await trusting.request('GET', `${url}/x`, {})).status, 200);
    assert.equal(trusting.lastCA()?.subject, 'lab-ca');
    // probe(): the first contact takes any certificate and returns what it saw, CA included
    const seen = await probe(url);
    assert.equal(seen.kind, 'openccu-lite');
    assert.equal(seen.certificate?.subject, 'openccu-lite');
    assert.equal(seen.ca?.subject, 'lab-ca');
    assert.ok(same(seen.ca?.pem ?? '', caPem));
    assert.equal(seen.chain?.length, 2);
    // probe() with a trust that refuses it: reachable, reason certificate, the CA to offer
    const refused = await probe(url, {trust: {}});
    assert.deepEqual([refused.kind, refused.reachable, refused.reason], ['unreachable', true, 'certificate']);
    assert.equal(refused.ca?.subject, 'lab-ca');
    assert.equal(refused.fingerprint256, seen.fingerprint256);
});

test('a self-signed certificate: the error has the leaf and no CA to offer; the pin error says pin', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'occulite-self-'));
    try {
        execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2', '-subj', '/CN=openccu-lite', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], {stdio: 'ignore'});
    } catch {
        t.skip('no openssl');
        return;
    }
    const cert = readFileSync(join(dir, 'c.pem'), 'utf8');
    const srv = https.createServer({key: readFileSync(join(dir, 'k.pem')), cert}, (_q, r) => r.end('{}'));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    t.after(() => srv.close());
    const url = `https://127.0.0.1:${(srv.address() as {port: number}).port}/x`;
    await assert.rejects(nodeTransport().request('GET', url, {}), (e: OccuLiteError) => {
        assert.equal(e.code, 'certificate');
        assert.equal(e.reason, 'DEPTH_ZERO_SELF_SIGNED_CERT');
        assert.equal(e.certificate?.fingerprint256, new X509Certificate(cert).fingerprint256);
        assert.equal(e.chain?.length, 1);
        assert.equal(e.ca, undefined);
        assert.match(e.message, /self-signed/);
        return true;
    });
    await assert.rejects(nodeTransport({fingerprint256: 'AA:BB'}).request('GET', url, {}), (e: OccuLiteError) => e.code === 'certificate' && e.reason === 'pin');
});
