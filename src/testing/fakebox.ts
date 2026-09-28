// occulite-client/testing: a fake openccu-lite system in one Node http server - the version answer
// with its capabilities, the auth state, lite-rpc's interfaces, JSON-RPC path and event stream
// (hello, device lists, events with batch marks, resync), the state store, the history, the
// metadata snapshot and its change stream, pairing and token rotation. The package's own tests run
// against it; a consumer's tests can too (the porting guide's testing section).

import {createHash, randomBytes} from 'node:crypto';
import http from 'node:http';
import type {AddressInfo} from 'node:net';

export interface FakeValue {
    value: unknown;
    ts?: string;
    lc?: string;
    confirmed?: boolean;
    source?: string;
}

export interface FakeBoxOptions {
    token?: string;
    /** a browser session id: accepted as the cookie `occulite_session=<id>` or as a Bearer; a
     *  state-changing call on the cookie alone must carry X-Occulite-Request (403 request-header) */
    session?: string;
    scopes?: string[];
    /** the interfaces the system runs, a name or {name, running} (default HmIP-RF, running) */
    interfaces?: (string | {name: string; running?: boolean})[];
    /** false: an older system without GET /api/rpc/v1/interfaces (404) */
    interfacesRoute?: boolean;
    /** device descriptions per interface (listDevices) */
    devices?: Record<string, Record<string, unknown>[]>;
    /** VALUES paramset descriptions by `<interface>.<channel>` */
    descriptions?: Record<string, Record<string, {TYPE: string; OPERATIONS?: number}>>;
    /** `<interface>.<address>.<KEY>` → value */
    values?: Record<string, FakeValue>;
    meta?: {revision: number; objects: Record<string, unknown>; enums: Record<string, unknown>};
    capabilities?: Record<string, unknown>;
    /** approve every pairing request as soon as the program revealed its half */
    autoApprove?: boolean;
}

interface Stream {
    res: http.ServerResponse;
    interfaces: string[];
}

export class FakeBox {
    url = '';
    readonly calls: {interface: string; method: string; params: unknown[]}[] = [];
    readonly metaPatches: {ref: string; body: unknown}[] = [];
    bootId = 'boot1';
    private server: http.Server;
    private streams = new Set<Stream>();
    private metaStreams = new Set<http.ServerResponse>();
    private seq = 0;
    private ring: {seq: number; event: string; data: unknown}[] = [];
    readonly pairings = new Map<string, {poll: string; nonce: Buffer; commit: string; clientNonce?: Buffer; state: string; token?: string; access: unknown; app: string}>();

    readonly opts: FakeBoxOptions;

    constructor(opts: FakeBoxOptions = {}) {
        this.opts = opts;
        this.server = http.createServer((req, res) => void this.handle(req, res));
    }

    async start(): Promise<string> {
        await new Promise<void>((res) => this.server.listen(0, '127.0.0.1', res));
        this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
        return this.url;
    }

    async stop(): Promise<void> {
        for (const s of this.streams) s.res.end();
        for (const r of this.metaStreams) r.end();
        this.server.closeAllConnections();
        await new Promise<void>((res) => this.server.close(() => res()));
    }

    private ifaces(): string[] {
        return this.ifaceList().map((i) => i.name);
    }

    private ifaceList(): {name: string; running: boolean}[] {
        return (this.opts.interfaces ?? ['HmIP-RF']).map((i) => (typeof i === 'string' ? {name: i, running: true} : {name: i.name, running: i.running !== false})).sort((a, b) => (a.name < b.name ? -1 : 1));
    }

    /** The scopes the credential has; every lite-rpc route needs rpc:read (as on the system). */
    private lacks(scope: string): boolean {
        const have = this.opts.scopes ?? ['*'];
        return !have.includes('*') && !have.includes(scope);
    }

    private json(res: http.ServerResponse, status: number, body: unknown): void {
        res.writeHead(status, {'Content-Type': 'application/json'});
        res.end(JSON.stringify(body));
    }

    /** The credential check as occulited does it: 0 = passes, 401 = none, 403 = the cookie alone
     *  on a state-changing call without the request header. */
    private authorized(req: http.IncomingMessage): 0 | 401 | 403 {
        if (!this.opts.token && !this.opts.session) return 0;
        const bearer = req.headers.authorization;
        if (this.opts.token && bearer === `Bearer ${this.opts.token}`) return 0;
        if (this.opts.session && bearer === `Bearer ${this.opts.session}`) return 0;
        const cookie = /(?:^|;\s*)(?:__Secure-)?occulite_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
        if (this.opts.session && cookie === this.opts.session) {
            const safe = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
            return safe || bearer || req.headers['x-occulite-request'] ? 0 : 403;
        }
        return 401;
    }

    private send(res: http.ServerResponse, id: string | undefined, event: string, data: unknown): void {
        res.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    /** Puts a message on the stream, as the bus does: numbered, kept for a resume. */
    push(event: string, data: Record<string, unknown>): void {
        this.seq++;
        const d: Record<string, unknown> = {...data, ts: data.ts ?? new Date().toISOString()};
        this.ring.push({seq: this.seq, event, data: d});
        for (const s of this.streams) {
            if (d.interface && s.interfaces.length && !s.interfaces.includes(String(d.interface))) continue;
            this.send(s.res, `${this.bootId}-${this.seq}`, event, d);
        }
    }

    /** An event of a device; batch = the seq of the first event of a multicall. */
    event(iface: string, address: string, key: string, value: unknown, batch?: number): void {
        const r = `${iface}.${address}.${key}`;
        const now = new Date().toISOString();
        const prev = this.opts.values?.[r];
        const lc = prev && Object.is(prev.value, value) ? prev.lc : now;
        (this.opts.values ??= {})[r] = {value, ts: now, lc, confirmed: true, source: 'event'};
        this.push('event', {interface: iface, address, key, value, lc, confirmed: true, ...(batch ? {batch} : {})});
    }

    /** The seq the next message gets. */
    nextSeq(): number {
        return this.seq + 1;
    }

    /** A metadata change event. */
    metaEvent(ev: Record<string, unknown>): void {
        for (const r of this.metaStreams) r.write(`data: ${JSON.stringify(ev)}\n\n`);
    }

    /** Ends every stream (a restart of the system, with bootId changed for another boot). */
    dropStreams(): void {
        for (const s of this.streams) s.res.end();
        this.streams.clear();
    }

    /** The code of a pairing request, as the Status page shows it (plain HTTP: no fingerprint). */
    pairingCode(id: string): string {
        const p = this.pairings.get(id)!;
        const d = createHash('sha256').update(p.nonce).update(p.clientNonce!).digest();
        return String(d.readUInt32BE(0) % 1_000_000).padStart(6, '0');
    }

    approve(id: string): void {
        const p = this.pairings.get(id);
        if (p) {
            p.state = 'approved';
            p.token = `olt_${randomBytes(16).toString('hex')}`;
        }
    }

    private async body(req: http.IncomingMessage): Promise<any> {
        let raw = '';
        for await (const c of req) raw += c;
        return raw ? JSON.parse(raw) : undefined;
    }

    private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const u = new URL(req.url ?? '/', 'http://x');
        const path = u.pathname;
        const key = `${req.method} ${path}`;
        if (key === 'GET /api/meta/v1/version') {
            return this.json(res, 200, {api: 'meta', version: 1, format: 1, revision: this.opts.meta?.revision ?? 0, implementation: 'fakebox', capabilities: this.opts.capabilities ?? {pairing: true, state: true, history: true, apis: {meta: 1, rpc: 1, system: 1, auth: 1}, transports: ['sse'], json_double: true}});
        }
        // pairing: open, the poll secret is the credential
        if (key === 'POST /api/auth/v1/pairing/request') {
            const b = await this.body(req);
            const id = randomBytes(4).toString('hex');
            const poll = randomBytes(12).toString('hex');
            const nonce = randomBytes(16);
            this.pairings.set(id, {poll, nonce, commit: b.commit, state: 'pending', access: b.access, app: b.app});
            return this.json(res, 202, {id, poll, nonce: nonce.toString('hex'), expires_in: 300, interval: 2, fingerprint: ''});
        }
        const pm = /^\/api\/auth\/v1\/pairing\/request\/([^/]+)$/.exec(path);
        if (pm) {
            const p = this.pairings.get(pm[1]);
            if (!p) return this.json(res, 404, {error: 'not_found', message: 'no such pairing request'});
            if (req.headers.authorization !== `Pairing ${p.poll}`) return this.json(res, 403, {error: 'forbidden', message: 'not the poll secret'});
            if (req.method === 'DELETE') {
                this.pairings.delete(pm[1]);
                res.writeHead(204).end();
                return;
            }
            const cn = u.searchParams.get('client_nonce');
            if (cn && !p.clientNonce) {
                const b = Buffer.from(cn, 'hex');
                if (createHash('sha256').update(b).digest('hex') !== p.commit) return this.json(res, 422, {error: 'invalid', message: 'not the commitment'});
                p.clientNonce = b;
                if (this.opts.autoApprove) this.approve(pm[1]);
            }
            if (p.state === 'approved') {
                this.pairings.delete(pm[1]);
                return this.json(res, 200, {state: 'approved', token: p.token, name: `${p.app}-fake`, scopes: ['rpc:read'], access: p.access});
            }
            return this.json(res, 200, {state: p.state});
        }
        const verdict = this.authorized(req);
        if (verdict === 401) return this.json(res, 401, {error: 'unauthenticated', message: 'login required'});
        if (verdict === 403) return this.json(res, 403, {error: 'request-header', message: 'a state-changing call with the session cookie alone must carry the header X-Occulite-Request'});
        if (key === 'GET /api/auth/v1/state') return this.json(res, 200, {authenticated: true, scopes: this.opts.scopes ?? ['*']});
        if (key === 'POST /api/auth/v1/tokens/self/rotate') {
            this.opts.token = `olt_${randomBytes(16).toString('hex')}`;
            return this.json(res, 200, {token: this.opts.token, name: 'fake', previous_valid_s: 60});
        }
        if (path.startsWith('/api/rpc/v1/') && this.lacks('rpc:read')) return this.json(res, 403, {error: 'forbidden', scope: 'rpc:read', message: 'the credential lacks rpc:read'});
        if (key === 'GET /api/rpc/v1/interfaces') {
            if (this.opts.interfacesRoute === false) return this.json(res, 404, {error: 'not_found', message: 'no route'});
            return this.json(res, 200, this.ifaceList().map((i) => ({name: i.name, protocol: 'xmlrpc', url_path: `/api/rpc/v1/xmlrpc/${i.name}`, running: i.running})));
        }
        if (key === 'GET /api/rpc/v1/state') {
            const want = u.searchParams.getAll('interface');
            const entries = Object.entries(this.opts.values ?? {})
                .map(([r, v]) => {
                    const i = r.indexOf('.');
                    const j = r.lastIndexOf('.');
                    return {interface: r.slice(0, i), address: r.slice(i + 1, j), datapoint: r.slice(j + 1), value: v.value, ts: v.ts ?? new Date(0).toISOString(), lc: v.lc ?? v.ts ?? new Date(0).toISOString(), confirmed: v.confirmed ?? true, source: v.source ?? 'event'};
                })
                .filter((e) => !want.length || want.includes(e.interface))
                .sort((a, b) => (`${a.interface}/${a.address}/${a.datapoint}` < `${b.interface}/${b.address}/${b.datapoint}` ? -1 : 1));
            const limit = Number(u.searchParams.get('limit') ?? 1000);
            const after = u.searchParams.get('after') ?? '';
            const from = after ? entries.findIndex((e) => `${e.interface}/${e.address}/${e.datapoint}` > after) : 0;
            const page = from < 0 ? [] : entries.slice(from, from + limit);
            const out: Record<string, unknown> = {entries: page, total: entries.length, unconfirmed: entries.filter((e) => !e.confirmed).length, event_id: `${this.bootId}-${this.seq}`};
            if (from >= 0 && from + limit < entries.length) out.next = `${page.at(-1)!.interface}/${page.at(-1)!.address}/${page.at(-1)!.datapoint}`;
            return this.json(res, 200, out);
        }
        if (key === 'GET /api/rpc/v1/history') {
            return this.json(res, 200, [[Date.parse('2026-09-25T00:00:00Z'), 21.5], [Date.parse('2026-09-25T00:10:00Z'), 21.7]]);
        }
        if (key === 'GET /api/rpc/v1/events') {
            res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store'});
            res.write(': connected\n\n');
            const s: Stream = {res, interfaces: u.searchParams.getAll('interface')};
            this.send(res, `${this.bootId}-${this.seq}`, 'hello', {boot_id: this.bootId, seq: this.seq, interfaces: this.ifaceList().map((i) => ({name: i.name, state: i.running ? 'up' : 'down'})), buffer: {seconds: 300, events: 5000}});
            const last = req.headers['last-event-id'];
            if (typeof last === 'string' && last) {
                const [boot, n] = [last.slice(0, last.lastIndexOf('-')), Number(last.slice(last.lastIndexOf('-') + 1))];
                if (boot !== this.bootId) this.send(res, undefined, 'resync', {reason: 'boot'});
                else for (const m of this.ring) if (m.seq > n) this.send(res, `${this.bootId}-${m.seq}`, m.event, m.data);
            }
            if (u.searchParams.get('devices') === '1') {
                for (const i of this.ifaces()) if (!s.interfaces.length || s.interfaces.includes(i)) this.send(res, undefined, 'newDevices', {interface: i, devices: this.opts.devices?.[i] ?? []});
            }
            this.streams.add(s);
            req.on('close', () => this.streams.delete(s));
            return;
        }
        const jm = /^\/api\/rpc\/v1\/json\/([^/]+)$/.exec(path);
        if (req.method === 'POST' && jm) {
            const iface = decodeURIComponent(jm[1]);
            const b = await this.body(req);
            const one = (c: {method: string; params: unknown[]; id: number}) => {
                this.calls.push({interface: iface, method: c.method, params: c.params});
                const [addr, a2] = c.params as [string, string];
                switch (c.method) {
                    case 'getParamsetDescription':
                        return {jsonrpc: '2.0', id: c.id, result: this.opts.descriptions?.[`${iface}.${addr}`] ?? {}};
                    case 'getValue':
                        return {jsonrpc: '2.0', id: c.id, result: this.opts.values?.[`${iface}.${addr}.${a2}`]?.value ?? null};
                    case 'setValue':
                    case 'putParamset':
                        return {jsonrpc: '2.0', id: c.id, result: ''};
                    case 'getParamset':
                        return {jsonrpc: '2.0', id: c.id, result: {}};
                }
                return {jsonrpc: '2.0', id: c.id, error: {code: -32601, message: `unknown method ${c.method}`}};
            };
            return this.json(res, 200, Array.isArray(b) ? b.map(one) : one(b));
        }
        if (key === 'GET /api/meta/v1/snapshot') return this.json(res, 200, {format: 1, ...(this.opts.meta ?? {revision: 0, objects: {}, enums: {}})});
        if (key === 'GET /api/meta/v1/events/sse') {
            res.writeHead(200, {'Content-Type': 'text/event-stream'});
            res.write(': connected\n\n');
            this.metaStreams.add(res);
            req.on('close', () => this.metaStreams.delete(res));
            return;
        }
        const om = /^\/api\/meta\/v1\/objects\/(.+)$/.exec(path);
        if (req.method === 'PATCH' && om) {
            this.metaPatches.push({ref: decodeURIComponent(om[1]), body: await this.body(req)});
            return this.json(res, 200, {revision: (this.opts.meta?.revision ?? 0) + 1});
        }
        this.json(res, 404, {error: 'not_found', message: `no route ${key}`});
    }
}
