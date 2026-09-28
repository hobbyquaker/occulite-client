// occulite-client/node: what needs Node - the https transport that pins a self-signed certificate
// per connection (Node's fetch takes no such option without undici), probe(), and pair() (the
// client half of task 219), which binds its code to the certificate it saw.

import {createHash, randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import * as net from 'node:net';
import * as tls from 'node:tls';
import type {TLSSocket} from 'node:tls';
import {OccuLite, REQUEST_HEADER, type Auth, type AuthProvider, type Credential, type Options} from '../client.ts';
import {OccuLiteError, abortError, httpError, timeoutSignal, transportReason, type CertificateInfo} from '../errors.ts';
import type {Transport, TransportResponse} from '../transport.ts';

export interface Trust {
    /** the certificate's SHA-256 as colon-separated hex (what pairing returns): only this one is accepted */
    fingerprint256?: string;
    /** a CA in PEM */
    ca?: string;
    /** accept any certificate (pairing's first contact only) */
    insecure?: boolean;
}

const norm = (fp: string) => fp.replace(/:/g, '').toLowerCase();

/** The colon-separated SHA-256 of a DER certificate. */
export function fingerprint256(der: Buffer): string {
    return createHash('sha256').update(der).digest('hex').toUpperCase().match(/../g)!.join(':');
}

interface Seen {
    fingerprint?: string;
    cert?: CertificateInfo;
}

function options(url: URL, trust: Trust | undefined, headers: Record<string, string>, method: string, seen: Seen, signal?: AbortSignal): https.RequestOptions {
    const o: https.RequestOptions = {method, headers, signal, hostname: url.hostname, port: url.port || undefined, path: url.pathname + url.search};
    if (url.protocol !== 'https:') return o;
    const record = (cert: tls.PeerCertificate) => {
        const cn = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(', ') : v);
        seen.fingerprint = cert.fingerprint256;
        seen.cert = {subject: cn(cert.subject?.CN), issuer: cn(cert.issuer?.CN), fingerprint256: cert.fingerprint256, validFrom: cert.valid_from, validTo: cert.valid_to};
    };
    if (trust?.fingerprint256 || trust?.insecure) {
        // the pin (or pairing's first contact): our own TLS socket, handed to the request only after
        // the handshake and the fingerprint check - nothing, the credential least of all, is written
        // to a server that shows another certificate. (Node skips checkServerIdentity when the
        // chain does not verify, so a self-signed certificate cannot be pinned there.)
        const pin = trust.fingerprint256 ? norm(trust.fingerprint256) : '';
        o.createConnection = ((_opts: unknown, oncreate: (err: Error | null, s?: tls.TLSSocket) => void) => {
            const sock = tls.connect({host: url.hostname, port: Number(url.port || 443), servername: net.isIP(url.hostname) ? undefined : url.hostname, rejectUnauthorized: false, ca: trust.ca});
            sock.once('secureConnect', () => {
                const cert = sock.getPeerCertificate();
                record(cert);
                if (pin && norm(cert.fingerprint256 ?? '') !== pin) {
                    sock.destroy();
                    oncreate(new Error('certificate-pin'));
                    return;
                }
                oncreate(null, sock);
            });
            sock.once('error', (e) => oncreate(e));
            return undefined;
        }) as unknown as https.RequestOptions['createConnection'];
        return o;
    }
    if (trust?.ca) o.ca = trust.ca;
    o.checkServerIdentity = (host, cert) => {
        record(cert);
        return tls.checkServerIdentity(host, cert);
    };
    return o;
}

function certError(seen: Seen, e: Error): OccuLiteError {
    return new OccuLiteError('certificate', e.message === 'certificate-pin' ? 'the system presents another certificate than the one pinned at pairing' : `the certificate is not trusted: ${e.message}`, {certificate: seen.cert});
}

function isCertError(e: NodeJS.ErrnoException): boolean {
    return e.message === 'certificate-pin' || /certificate|self.signed|CERT_|UNABLE_TO_VERIFY/i.test(`${e.code ?? ''} ${e.message}`);
}

/** The https transport with pinning; the seen certificate is recorded for pairing. */
export function nodeTransport(trust?: Trust): Transport & {lastFingerprint(): string | undefined} {
    let last: string | undefined;
    const send = (method: string, url: string, headers: Record<string, string>, body: string | undefined, signal?: AbortSignal) =>
        new Promise<http.IncomingMessage>((resolve, reject) => {
            const u = new URL(url);
            const seen: Seen = {};
            const mod = u.protocol === 'https:' ? https : http;
            const req = mod.request(options(u, trust, {...headers, ...(body ? {'Content-Length': String(Buffer.byteLength(body))} : {})}, method, seen, signal), (res) => {
                const sock = res.socket as TLSSocket;
                const peer = typeof sock.getPeerX509Certificate === 'function' ? sock.getPeerX509Certificate() : undefined;
                last = peer ? peer.fingerprint256 : seen.fingerprint;
                resolve(res);
            });
            req.on('error', (e: NodeJS.ErrnoException) => {
                if (e.name === 'AbortError' || e.code === 'ABORT_ERR') reject(abortError(signal));
                else if (isCertError(e)) reject(certError(seen, e));
                else reject(new OccuLiteError('unreachable', `the system does not answer: ${e.message}`, {detail: {code: transportReason(e)}}));
            });
            if (body) req.write(body);
            req.end();
        });
    return {
        lastFingerprint: () => last,
        async request(method, url, headers, body, signal): Promise<TransportResponse> {
            const res = await send(method, url, headers, body, signal);
            const chunks: Buffer[] = [];
            for await (const c of res) chunks.push(c as Buffer);
            const h: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h[k] = Array.isArray(v) ? v.join(', ') : v;
            return {status: res.statusCode ?? 0, headers: h, body: Buffer.concat(chunks).toString('utf8')};
        },
        async stream(url, headers, signal) {
            const res = await send('GET', url, {...headers, Accept: 'text/event-stream'}, undefined, signal);
            if (res.statusCode !== 200) {
                const chunks: Buffer[] = [];
                for await (const c of res) chunks.push(c as Buffer);
                return {status: res.statusCode ?? 0, chunks: (async function* () {})(), body: Buffer.concat(chunks).toString('utf8')};
            }
            return {status: 200, chunks: res as AsyncIterable<Uint8Array>};
        },
    };
}

export interface ProbeOptions {
    trust?: Trust;
    /** per request, ms; default 5 s. A system that accepts the connection and does not answer is `unreachable` with reason `timeout` - never a CCU */
    timeout?: number;
    signal?: AbortSignal;
}

export interface ProbeResult {
    kind: 'openccu-lite' | 'ccu' | 'unreachable';
    /** true for any HTTP answer (a CCU's HTML too) and for a certificate the trust refused (the system is there);
     *  false for refused, timeout, dns */
    reachable: boolean;
    /** why it is unreachable: timeout, refused, dns, reset, certificate, aborted, or the OS error code */
    reason?: string;
    url: string;
    /** the version answer of an openccu-lite system */
    info?: unknown;
    fingerprint256?: string;
    /** the certificate a `certificate` reason is about */
    certificate?: CertificateInfo;
}

/** What an address is: openccu-lite (and its version answer), a CCU (any other HTTP answer), or
 *  unreachable - with `reachable` and `reason` telling "still booting, try again" (timeout, refused)
 *  from "not there" (dns) and from a trust problem (certificate). Follows one redirect to https and
 *  records the certificate it saw. */
export async function probe(address: string, opts: ProbeOptions = {}): Promise<ProbeResult> {
    const base = /^https?:\/\//.test(address) ? address.replace(/\/+$/, '') : `http://${address}`;
    const tx = nodeTransport(opts.trust ?? {insecure: true});
    let url = base;
    for (let hop = 0; hop < 2; hop++) {
        let r: TransportResponse;
        try {
            r = await tx.request('GET', `${url}/api/meta/v1/version`, {Accept: 'application/json'}, undefined, timeoutSignal(opts.timeout ?? 5000, opts.signal));
        } catch (e) {
            const err = e as OccuLiteError;
            if (err.code === 'certificate') return {kind: 'unreachable', reachable: true, reason: 'certificate', url, certificate: err.certificate, fingerprint256: err.certificate?.fingerprint256};
            return {kind: 'unreachable', reachable: false, reason: err.code === 'timeout' ? 'timeout' : err.code === 'aborted' ? 'aborted' : (err.reason ?? 'error'), url};
        }
        if ((r.status === 301 || r.status === 302 || r.status === 307 || r.status === 308) && r.headers.location) {
            url = new URL(r.headers.location, url).origin;
            continue;
        }
        try {
            const j = JSON.parse(r.body);
            if (r.status === 200 && j?.api === 'meta') return {kind: 'openccu-lite', reachable: true, url, info: j, fingerprint256: tx.lastFingerprint()};
        } catch {
            /* HTML: a CCU's WebUI */
        }
        return {kind: 'ccu', reachable: true, url, fingerprint256: tx.lastFingerprint()};
    }
    return {kind: 'ccu', reachable: true, url, fingerprint256: tx.lastFingerprint()};
}

/** probe() again and again while the address is unreachable (a system still booting), with the
 *  consumers' schedule - 1, 2, 4, 8, then every 15 s - until an answer comes; a certificate
 *  problem is an answer too. Rejects `aborted` when the signal fires. */
export async function probeUntil(address: string, opts: ProbeOptions & {schedule?: number[]} = {}): Promise<ProbeResult> {
    const schedule = opts.schedule ?? [1000, 2000, 4000, 8000, 15000];
    for (let attempt = 0; ; attempt++) {
        if (opts.signal?.aborted) throw new OccuLiteError('aborted', 'probing was aborted');
        const r = await probe(address, opts);
        if (r.reachable) return r;
        if (r.reason === 'aborted' || opts.signal?.aborted) throw new OccuLiteError('aborted', 'probing was aborted');
        const wait = schedule[Math.min(attempt, schedule.length - 1)];
        await new Promise<void>((res) => {
            const t = setTimeout(done, wait);
            function done() {
                clearTimeout(t);
                opts.signal?.removeEventListener('abort', done);
                res();
            }
            opts.signal?.addEventListener('abort', done, {once: true});
        });
    }
}

// ---- credentials on the system -----------------------------------------------------------------

/** How a Node program names its credential: 'auto' looks in this order - OCCULITE_TOKEN in the
 *  environment, the addon's own token (when `addon` is named), the local token (meta:read alone:
 *  names only), none - and the files are read again after a 401, so a token created later is picked
 *  up without a restart. */
export type NodeAuth = 'auto' | {token: string} | {session: string} | {addon: string} | {local: true} | {none: true};

export interface NodeAuthOptions {
    /** the addon id for 'auto' and its token file /run/occulite/addon-tokens/<id>.api (the manifest's runtime.api_scopes) */
    addon?: string;
    /** default /usr/local/etc/occulite/local-token (meta:read; every addon may read it) */
    localTokenFile?: string;
    /** default /run/occulite/addon-tokens */
    addonTokenDir?: string;
    /** default process.env */
    env?: Record<string, string | undefined>;
}

export const LOCAL_TOKEN_FILE = '/usr/local/etc/occulite/local-token';
export const ADDON_TOKEN_DIR = '/run/occulite/addon-tokens';

/** The first non-empty line of a token file, or undefined when it is not there or empty. */
async function tokenFile(path: string): Promise<string | undefined> {
    try {
        const line = (await readFile(path, 'utf8')).split(/\r?\n/).find((l) => l.trim() !== '');
        return line?.trim() || undefined;
    } catch {
        return undefined;
    }
}

/** The credential provider for OccuLite's `auth` option: `nodeAuth('auto', {addon: 'hm2mqtt'})`. */
export function nodeAuth(spec: NodeAuth = 'auto', o: NodeAuthOptions = {}): AuthProvider & {spec: NodeAuth} {
    const env = o.env ?? process.env;
    const local = () => tokenFile(o.localTokenFile ?? LOCAL_TOKEN_FILE);
    const addon = (id: string) => tokenFile(`${o.addonTokenDir ?? ADDON_TOKEN_DIR}/${id}.api`);
    const found = (token: string | undefined, credential: Credential): (Auth & {credential: Credential}) | undefined => (token ? {token, credential} : undefined);
    return {
        spec,
        async resolve() {
            if (spec === 'auto') {
                return found(env.OCCULITE_TOKEN, 'token') ?? (o.addon ? found(await addon(o.addon), 'addon') : undefined) ?? found(await local(), 'local') ?? {credential: 'none'};
            }
            if ('token' in spec) return {token: spec.token, credential: 'token'};
            if ('session' in spec) return {session: spec.session, credential: 'session'};
            if ('addon' in spec) return found(await addon(spec.addon), 'addon') ?? {credential: 'none'};
            if ('local' in spec) return found(await local(), 'local') ?? {credential: 'none'};
            return {credential: 'none'};
        },
    };
}

export interface CreateOptions extends Omit<Options, 'auth' | 'transport'>, NodeAuthOptions {
    /** default 'auto' */
    auth?: NodeAuth | AuthProvider;
    /** the certificate to trust: the fingerprint pinned at pairing, a CA, or nothing for a valid certificate */
    trust?: Trust;
}

/** An OccuLite for Node: the pinned https transport and the credential resolution in one call. */
export function createClient(o: CreateOptions): OccuLite {
    const {auth, trust, addon, localTokenFile, addonTokenDir, env, ...rest} = o;
    const provider = auth && typeof (auth as AuthProvider).resolve === 'function' ? (auth as AuthProvider) : nodeAuth((auth as NodeAuth | undefined) ?? 'auto', {addon, localTokenFile, addonTokenDir, env});
    return new OccuLite({...rest, auth: provider, transport: nodeTransport(trust)});
}

export interface PairOptions {
    url: string;
    app: string;
    appVersion?: string;
    instance?: string;
    name?: string;
    /** one level per area: devices read|operate|configure|administer, names read|configure, system read|configure */
    access: {devices?: string; names?: string; system?: string};
    purpose?: {devices?: string; names?: string; system?: string};
    /** called with the code to show the user, once the system has it */
    onCode: (code: string) => void;
    /** abort = withdraw the request; the promise rejects `aborted` */
    signal?: AbortSignal;
    /** an overall limit, ms: after it the request is withdrawn and the promise rejects `timeout`
     *  (the system itself lets a request expire after five minutes) */
    timeout?: number;
    /** the certificate to trust; default: any, for this first contact only (the fingerprint returned is the one to pin) */
    trust?: Trust;
}

export interface Paired {
    token: string;
    name: string;
    scopes: string[];
    access: Record<string, string>;
    /** the certificate the code was bound to ('' over plain HTTP): pin it */
    fingerprint256: string;
}

/** The code both sides show (task 219): SHA-256(nonce | client_nonce | fingerprint), the first
 *  four bytes as a big-endian integer mod 1 000 000, six digits. */
export function pairingCode(nonce: Buffer, clientNonce: Buffer, fingerprint: Buffer): string {
    const d = createHash('sha256').update(nonce).update(clientNonce).update(fingerprint).digest();
    return String(d.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

/** Asks the system for a token and waits for an administrator's approval on its Status page. */
export async function pair(o: PairOptions): Promise<Paired> {
    const url = o.url.replace(/\/+$/, '');
    const tx = nodeTransport(o.trust ?? {insecure: true});
    // the whole pairing: the consumer's signal and the overall timeout; each request gets its own limit too
    const signal = timeoutSignal(o.timeout, o.signal);
    const per = (ms: number) => timeoutSignal(ms, signal);
    const clientNonce = randomBytes(16);
    const commit = createHash('sha256').update(clientNonce).digest('hex');
    const body = JSON.stringify({app: o.app, app_version: o.appVersion, instance: o.instance, name: o.name, access: o.access, purpose: o.purpose, commit});
    const r = await tx.request('POST', `${url}/api/auth/v1/pairing/request`, {'Content-Type': 'application/json', [REQUEST_HEADER]: '1'}, body, per(15000)).catch((e: OccuLiteError) => {
        throw signal?.aborted ? abortError(signal, 'pairing') : e;
    });
    const ans = JSON.parse(r.body || '{}');
    if (r.status !== 202) throw httpError(r.status, ans);
    const seen = url.startsWith('https:') ? tx.lastFingerprint() ?? '' : '';
    const code = pairingCode(Buffer.from(ans.nonce, 'hex'), clientNonce, seen ? Buffer.from(norm(seen), 'hex') : Buffer.alloc(0));
    const auth = {Authorization: `Pairing ${ans.poll}`, [REQUEST_HEADER]: '1'};
    const pollURL = `${url}/api/auth/v1/pairing/request/${encodeURIComponent(ans.id)}`;
    let first = true;
    // an abort or the timeout withdraws the request on the system (its own request limit, no signal)
    const withdraw = () => void tx.request('DELETE', pollURL, auth, undefined, timeoutSignal(10000)).catch(() => {});
    signal?.addEventListener('abort', withdraw, {once: true});
    let settled = false; // the system answered approved, rejected or expired: nothing to withdraw
    try {
        for (;;) {
            if (signal?.aborted) throw abortError(signal, 'pairing');
            const q = first ? `?client_nonce=${clientNonce.toString('hex')}&wait=0` : '?wait=30';
            // the long poll answers within 30 s; 45 s catches a connection that went half-open
            const p = await tx.request('GET', pollURL + q, auth, undefined, per(first ? 15000 : 45000)).catch((e: OccuLiteError) => {
                throw signal?.aborted ? abortError(signal, 'pairing') : e;
            });
            const j = JSON.parse(p.body || '{}');
            if (p.status === 429) {
                await new Promise((res) => setTimeout(res, 2000));
                continue;
            }
            if (p.status !== 200) throw httpError(p.status, j);
            if (first) {
                first = false;
                o.onCode(code);
            }
            if (j.state === 'approved' || j.state === 'rejected' || j.state === 'expired') settled = true;
            if (j.state === 'approved') return {token: j.token, name: j.name, scopes: j.scopes ?? [], access: j.access ?? {}, fingerprint256: seen};
            if (j.state === 'rejected') throw new OccuLiteError('rejected', 'the administrator rejected the request (or picked another code)');
            if (j.state === 'expired') throw new OccuLiteError('expired', 'nobody approved the request within five minutes');
        }
    } finally {
        signal?.removeEventListener('abort', withdraw);
        // a per-request timeout or another error on the way out: the request is withdrawn too
        if (!settled && !signal?.aborted) withdraw();
    }
}
