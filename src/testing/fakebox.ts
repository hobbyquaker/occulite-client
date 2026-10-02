// occulite-client/testing: a fake openccu-lite system in one Node http server - the version answer
// with its capabilities, the auth state, lite-rpc's interfaces, JSON-RPC path and event stream
// (hello, device lists, events with batch marks, resync), the state store, the history, the
// metadata snapshot and its change stream, pairing and token rotation, and the system API's slice
// (status, radio health, service messages with their stream, the heating groups, the history list).
// The package's own tests run against it; a consumer's tests can too (the porting guide's testing section).

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
    /** false: the metadata snapshot answers 503 (a system whose metadata is not up yet) */
    metaRoute?: boolean;
    /** refs a DELETE of an enum or node without members=detach is refused for (409 has-members) */
    metaMembers?: string[];
    /** device descriptions per interface (listDevices) */
    devices?: Record<string, Record<string, unknown>[]>;
    /** VALUES paramset descriptions by `<interface>.<channel>` */
    descriptions?: Record<string, Record<string, {TYPE: string; OPERATIONS?: number}>>;
    /** `<interface>.<address>.<KEY>` → value: what getParamset(VALUES) and getValue answer */
    values?: Record<string, FakeValue>;
    /** the keys the state store keeps (the system's chosen set); default: every key in `values` */
    storeKeys?: string[];
    /** channels (`<interface>.<address>`) whose getParamset faults with -1 Failure (a BidCos device away) */
    failing?: string[];
    meta?: {revision: number; objects: Record<string, unknown>; enums: Record<string, unknown>};
    capabilities?: Record<string, unknown>;
    /** approve every pairing request as soon as the program revealed its half */
    autoApprove?: boolean;
    /** accept connections and never answer (a system still booting); set it back to false and the
     *  held requests are answered */
    hang?: boolean;
    /** send the stream's `: ping` comment every n ms (default: none; the system does every 15 s) */
    pingInterval?: number;
    /** false: a system without the system API (its capabilities name none; the routes 404) */
    systemApi?: boolean;
    /** `GET /api/system/v1/status`; a small default */
    status?: Record<string, unknown>;
    /** `GET /api/system/v1/radio/health`; a default with one HmIP-RF entry */
    radioHealth?: Record<string, unknown>;
    /** the active service messages (`GET /service-messages` and its stream); setServiceMessages() changes them */
    serviceMessages?: Record<string, unknown>[];
    /** the heating groups, in the shape of `GET /groups/{id}` (id, name, type, members, forbid_single_operation) */
    groups?: {id: number; name: string; type: string; members: {id: string; serial: string; type: string}[]; forbid_single_operation?: boolean}[];
    /** the group types with their assignable devices; default one BidCos type with two thermostats */
    groupTypes?: {id: string; label: string; assignable: {id: string; serial: string; type: string}[]; leftover: {id: string; serial: string; type: string}[]}[];
    /** the history list's additions and removals (`/datastore/history`) */
    historyAdd?: string[];
    historyRemove?: string[];
}

interface Stream {
    res: http.ServerResponse;
    interfaces: string[];
}

export class FakeBox {
    url = '';
    readonly calls: {interface: string; method: string; params: unknown[]}[] = [];
    readonly metaPatches: {ref: string; body: unknown}[] = [];
    /** every metadata write: method, path (below /api/meta/v1, with the query), body, If-Match */
    readonly metaWrites: {method: string; path: string; body: unknown; ifMatch?: string; contentType?: string}[] = [];
    bootId = 'boot1';
    private server: http.Server;
    private streams = new Set<Stream>();
    private metaStreams = new Set<http.ServerResponse>();
    private seq = 0;
    private ring: {seq: number; event: string; data: unknown}[] = [];
    /** how often a stream was opened (reconnects counted) */
    streamsOpened = 0;
    /** the same for the metadata change stream */
    metaStreamsOpened = 0;
    /** and for the service-message stream */
    serviceStreamsOpened = 0;
    /** every request below /api/system/v1: `METHOD /path` */
    readonly systemRequests: string[] = [];
    private serviceStreams = new Set<http.ServerResponse>();
    private held = new Set<{req: http.IncomingMessage; res: http.ServerResponse}>();
    readonly pairings = new Map<string, {poll: string; nonce: Buffer; commit: string; clientNonce?: Buffer; state: string; token?: string; access: unknown; app: string}>();

    readonly opts: FakeBoxOptions;

    constructor(opts: FakeBoxOptions = {}) {
        this.opts = opts;
        this.server = http.createServer((req, res) => {
            if (this.opts.hang) {
                const h = {req, res};
                this.held.add(h);
                req.on('close', () => this.held.delete(h));
                return;
            }
            void this.handle(req, res);
        });
    }

    /** Stops hanging: the requests held so far are answered. */
    resume(): void {
        this.opts.hang = false;
        for (const h of this.held) void this.handle(h.req, h.res);
        this.held.clear();
    }

    async start(): Promise<string> {
        await new Promise<void>((res) => this.server.listen(0, '127.0.0.1', res));
        this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
        return this.url;
    }

    async stop(): Promise<void> {
        for (const h of this.held) h.res.destroy();
        this.held.clear();
        for (const s of this.streams) s.res.end();
        for (const r of this.metaStreams) r.end();
        for (const r of this.serviceStreams) r.end();
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

    /** An interface that appears after the start (hmipserver after rfd): listed, its devices known,
     *  and `interface {state: 'added'}` on the stream. */
    addInterface(name: string, o: {running?: boolean; devices?: Record<string, unknown>[]} = {}): void {
        this.opts.interfaces = [...(this.opts.interfaces ?? ['HmIP-RF']), {name, running: o.running !== false}];
        if (o.devices) (this.opts.devices ??= {})[name] = o.devices;
        this.push('interface', {interface: name, state: 'added'});
    }

    /** An interface goes up or down: the list follows, and `interface {state}` goes out. */
    setInterface(name: string, running: boolean): void {
        this.opts.interfaces = this.ifaceList().map((i) => (i.name === name ? {name, running} : i));
        this.push('interface', {interface: name, state: running ? 'up' : 'down'});
    }

    /** The service messages change: the new list, and the view on every open stream. */
    setServiceMessages(list: Record<string, unknown>[]): void {
        this.opts.serviceMessages = list;
        for (const r of this.serviceStreams) r.write(`event: messages\ndata: ${JSON.stringify(this.serviceView())}\n\n`);
    }

    /** How many service-message streams are open now. */
    get serviceStreamsOpen(): number {
        return this.serviceStreams.size;
    }

    private serviceView(): Record<string, unknown> {
        const messages = this.opts.serviceMessages ?? [];
        return {count: messages.length, messages, swept: '2026-09-25T00:00:00Z', errors: {}};
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

    /** Ends every metadata change stream, for a consumer's reconnect test (`metaStreamsOpened` counts the reopen). */
    dropMetaStreams(): void {
        for (const r of this.metaStreams) r.end();
        this.metaStreams.clear();
    }

    /** How many metadata change streams are open now. */
    get metaStreamsOpen(): number {
        return this.metaStreams.size;
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
            const apis: Record<string, number> = {meta: 1, rpc: 1, auth: 1, ...(this.opts.systemApi === false ? {} : {system: 1})};
            return this.json(res, 200, {api: 'meta', version: 1, format: 1, revision: this.opts.meta?.revision ?? 0, implementation: 'fakebox', capabilities: this.opts.capabilities ?? {pairing: true, state: true, history: true, apis, transports: ['sse'], json_double: true}});
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
            // the long poll: the answer waits for a change of state up to wait= seconds (the system's 30)
            const wait = Math.min(Number(u.searchParams.get('wait') ?? 0), 30) * 1000;
            const end = Date.now() + wait;
            while (p.state === 'pending' && Date.now() < end && !res.closed) await new Promise((r) => setTimeout(r, 20));
            if (res.closed) return;
            if (p.state === 'approved') {
                this.pairings.delete(pm[1]);
                return this.json(res, 200, {state: 'approved', token: p.token, name: `${p.app}-fake`, scopes: ['rpc:read'], access: p.access});
            }
            return this.json(res, 200, {state: p.state});
        }
        const verdict = this.authorized(req);
        // the auth state is open: no credential at all is answered, not refused (the shell asks it to know)
        if (key === 'GET /api/auth/v1/state' && verdict === 401 && !req.headers.authorization && !req.headers.cookie) return this.json(res, 200, {authenticated: false, setup_required: false});
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
                .filter((e) => !this.opts.storeKeys || this.opts.storeKeys.includes(e.datapoint))
                .sort((a, b) => (`${a.interface}/${a.address}/${a.datapoint}` < `${b.interface}/${b.address}/${b.datapoint}` ? -1 : 1));
            const limit = Number(u.searchParams.get('limit') ?? 1000);
            const after = u.searchParams.get('after') ?? '';
            const from = after ? entries.findIndex((e) => `${e.interface}/${e.address}/${e.datapoint}` > after) : 0;
            const page = from < 0 ? [] : entries.slice(from, from + limit);
            const out: Record<string, unknown> = {entries: page, total: entries.length, unconfirmed: entries.filter((e) => !e.confirmed).length, event_id: `${this.bootId}-${this.seq}`};
            if (!after) out.datapoints = this.opts.storeKeys ?? [...new Set(entries.map((e) => e.datapoint))];
            if (from >= 0 && from + limit < entries.length) out.next = `${page.at(-1)!.interface}/${page.at(-1)!.address}/${page.at(-1)!.datapoint}`;
            return this.json(res, 200, out);
        }
        if (key === 'GET /api/rpc/v1/history') {
            return this.json(res, 200, [[Date.parse('2026-09-25T00:00:00Z'), 21.5], [Date.parse('2026-09-25T00:10:00Z'), 21.7]]);
        }
        if (key === 'GET /api/rpc/v1/events') {
            this.streamsOpened++;
            res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store'});
            res.write(': connected\n\n');
            if (this.opts.pingInterval) {
                const t = setInterval(() => res.write(': ping\n\n'), this.opts.pingInterval);
                req.on('close', () => clearInterval(t));
            }
            const s: Stream = {res, interfaces: u.searchParams.getAll('interface')};
            this.send(res, `${this.bootId}-${this.seq}`, 'hello', {boot_id: this.bootId, seq: this.seq, interfaces: this.ifaceList().map((i) => ({name: i.name, state: i.running ? 'up' : 'down'})), buffer: {seconds: 300, events: 5000}});
            const last = req.headers['last-event-id'];
            if (typeof last === 'string' && last) {
                const [boot, n] = [last.slice(0, last.lastIndexOf('-')), Number(last.slice(last.lastIndexOf('-') + 1))];
                if (boot !== this.bootId) this.send(res, undefined, 'resync', {reason: 'boot'});
                else for (const m of this.ring) if (m.seq > n) this.send(res, `${this.bootId}-${m.seq}`, m.event, m.data);
            }
            if (u.searchParams.get('devices') === '1') {
                // one listDevices per interface; a process that is not running answers with an error, as the system does
                for (const i of this.ifaceList()) if (!s.interfaces.length || s.interfaces.includes(i.name)) this.send(res, undefined, 'newDevices', i.running ? {interface: i.name, devices: this.opts.devices?.[i.name] ?? []} : {interface: i.name, error: `${i.name} is down`});
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
                    case 'listDevices':
                        return {jsonrpc: '2.0', id: c.id, result: this.opts.devices?.[iface] ?? []};
                    case 'getParamsetDescription':
                        return {jsonrpc: '2.0', id: c.id, result: this.opts.descriptions?.[`${iface}.${addr}`] ?? {}};
                    case 'getValue':
                        return {jsonrpc: '2.0', id: c.id, result: this.opts.values?.[`${iface}.${addr}.${a2}`]?.value ?? null};
                    case 'setValue':
                    case 'putParamset':
                        return {jsonrpc: '2.0', id: c.id, result: ''};
                    case 'getParamset': {
                        if (this.opts.failing?.includes(`${iface}.${addr}`)) return {jsonrpc: '2.0', id: c.id, error: {code: -1, message: 'Failure'}};
                        if (a2 !== 'VALUES') return {jsonrpc: '2.0', id: c.id, result: {}};
                        const out: Record<string, unknown> = {};
                        const prefix = `${iface}.${addr}.`;
                        for (const [r, v] of Object.entries(this.opts.values ?? {})) if (r.startsWith(prefix) && !r.slice(prefix.length).includes('.')) out[r.slice(prefix.length)] = v.value;
                        return {jsonrpc: '2.0', id: c.id, result: out};
                    }
                }
                return {jsonrpc: '2.0', id: c.id, error: {code: -32601, message: `unknown method ${c.method}`}};
            };
            return this.json(res, 200, Array.isArray(b) ? b.map(one) : one(b));
        }
        if (key === 'GET /api/meta/v1/snapshot' && this.opts.metaRoute === false) return this.json(res, 503, {error: 'unavailable', message: 'not yet'});
        if (key === 'GET /api/meta/v1/snapshot') return this.json(res, 200, {format: 1, ...(this.opts.meta ?? {revision: 0, objects: {}, enums: {}})});
        if (key === 'GET /api/meta/v1/events/sse') {
            this.metaStreamsOpened++;
            res.writeHead(200, {'Content-Type': 'text/event-stream'});
            res.write(': connected\n\n');
            this.metaStreams.add(res);
            req.on('close', () => this.metaStreams.delete(res));
            return;
        }
        if (key === 'GET /api/meta/v1/enums') return this.json(res, 200, {revision: this.opts.meta?.revision ?? 0, enums: this.opts.meta?.enums ?? {}});
        if (key === 'GET /api/meta/v1/export') {
            const doc = {format: 1, ...(this.opts.meta ?? {revision: 0, objects: {}, enums: {}})};
            if (u.searchParams.get('format') === 'yaml') {
                res.writeHead(200, {'Content-Type': 'application/yaml', 'Content-Disposition': 'attachment; filename=meta.yaml'});
                return void res.end(`format: 1\nrevision: ${doc.revision}\n`);
            }
            return this.json(res, 200, doc);
        }
        // the metadata writes: recorded, one revision each, If-Match checked, a {} PATCH is a 304 - the shapes of
        // docs/meta-api.md without the store's semantics (the copy follows the change stream, which a test drives)
        if (path.startsWith('/api/meta/v1/') && (req.method === 'PUT' || req.method === 'PATCH' || req.method === 'POST' || req.method === 'DELETE')) {
            if (this.lacks('meta:write')) return this.json(res, 403, {error: 'forbidden', scope: 'meta:write', message: 'the credential lacks meta:write'});
            const meta = (this.opts.meta ??= {revision: 0, objects: {}, enums: {}});
            const ct = String(req.headers['content-type'] ?? '');
            let raw = '';
            for await (const c of req) raw += c;
            const b = raw && ct.includes('json') ? JSON.parse(raw) : raw || undefined;
            const rel = path.slice('/api/meta/v1'.length) + (u.search || '');
            const ifMatch = req.headers['if-match'] as string | undefined;
            this.metaWrites.push({method: req.method, path: rel, body: b, ifMatch, contentType: ct || undefined});
            if (ifMatch !== undefined && Number(ifMatch.replace(/"/g, '')) !== meta.revision) return this.json(res, 409, {error: 'revision-conflict', message: `the store is at ${meta.revision}`, detail: {revision: meta.revision}});
            const om = /^\/objects\/(.+)$/.exec(path.slice('/api/meta/v1'.length));
            if (om && req.method === 'PATCH') {
                this.metaPatches.push({ref: decodeURIComponent(om[1]), body: b});
                if (b && typeof b === 'object' && Object.keys(b).length === 0) {
                    res.writeHead(304, {ETag: `"${meta.revision}"`}).end();
                    return;
                }
            }
            if (path.endsWith('/nodes') && req.method === 'POST' && b?.parent && b.parent !== null && String(b.parent).includes('nowhere')) return this.json(res, 422, {error: 'unknown-path', message: `no such path: ${b.parent}`});
            if (path.startsWith('/api/meta/v1/enums/') && req.method === 'DELETE' && !u.searchParams.has('members') && this.opts.metaMembers?.length) return this.json(res, 409, {error: 'has-members', message: 'members', detail: {refs: this.opts.metaMembers}});
            meta.revision++;
            return this.json(res, req.method === 'POST' && (path.endsWith('/enums') || path.endsWith('/nodes')) ? 201 : 200, {revision: meta.revision, changed: true});
        }
        if (path.startsWith('/api/system/v1/')) return this.handleSystem(req, res, u);
        this.json(res, 404, {error: 'not_found', message: `no route ${key}`});
    }

    // ---- the system API's slice (task 9): the shapes of docs/system-api.md, the scopes as the system checks them ----

    private async handleSystem(req: http.IncomingMessage, res: http.ServerResponse, u: URL): Promise<void> {
        const rel = u.pathname.slice('/api/system/v1'.length);
        const key = `${req.method} ${rel}`;
        this.systemRequests.push(key);
        if (this.opts.systemApi === false) return this.json(res, 404, {error: 'not_found', message: `no route ${key}`});
        const safe = req.method === 'GET' || req.method === 'HEAD';
        if (this.lacks(safe ? 'system:read' : 'system:write')) return this.json(res, 403, {error: 'forbidden', scope: safe ? 'system:read' : 'system:write', message: `the credential lacks ${safe ? 'system:read' : 'system:write'}`});
        if (key === 'GET /status') return this.json(res, 200, this.opts.status ?? {hostname: 'fakebox', version: {version: '3.89.11.20260919', product: 'fake', platform: 'fake', lite: '1.0.0-dev.0'}, occulited_version: 'fakebox', uptime_s: 42, load: [0.1, 0.2, 0.3], mem_total_kb: 1024, mem_available_kb: 512, disks: [{mount: '/', total_kb: 1000, used_kb: 500}], time: new Date().toISOString(), timezone: 'Europe/Berlin', hm_mode: 'HMIP'});
        if (key === 'GET /radio/health') return this.json(res, 200, this.opts.radioHealth ?? {polled: new Date().toISOString(), interfaces: [{interface: 'HmIP-RF', address: '3014F711A0000000000000FA', type: 'RPI-RF-MOD', connected: true, default: true, firmware: '4.4.22', duty_cycle: 3, carrier_sense: 12, carrier_sense_source: 'event'}], answering: [], errors: {}, history: {'HmIP-RF/3014F711A0000000000000FA': [{t: '2026-09-25T00:00:00Z', dc: 2, cs: 10, up: true}, {t: '2026-09-25T00:01:00Z', dc: 3, cs: 12, up: true}]}, busy: false, busy_interface: ''});
        if (key === 'GET /service-messages') return this.json(res, 200, this.serviceView());
        if (key === 'GET /service-messages/stream') {
            this.serviceStreamsOpened++;
            res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store'});
            res.write(`event: messages\ndata: ${JSON.stringify(this.serviceView())}\n\n`);
            if (this.opts.pingInterval) {
                const t = setInterval(() => res.write(': ping\n\n'), this.opts.pingInterval);
                req.on('close', () => clearInterval(t));
            }
            this.serviceStreams.add(res);
            req.on('close', () => this.serviceStreams.delete(res));
            return;
        }
        if (key === 'GET /datastore/history' || key === 'PUT /datastore/history') {
            if (req.method === 'PUT') {
                const b = (await this.body(req)) ?? {};
                const bad = [...(b.add ?? []), ...(b.remove ?? [])].find((n: string) => !/^[A-Z0-9_]+$/.test(n));
                if (bad) return this.json(res, 422, {error: 'invalid', message: `not a datapoint name: ${bad}`});
                this.opts.historyAdd = b.add ?? [];
                this.opts.historyRemove = b.remove ?? [];
            }
            const defaults = ['ACTUAL_TEMPERATURE', 'HUMIDITY', 'LEVEL', 'STATE'];
            const datapoints: Record<string, string> = {};
            for (const n of [...defaults, ...(this.opts.historyAdd ?? [])]) if (!(this.opts.historyRemove ?? []).includes(n)) datapoints[n] = /TEMPERATURE|HUMIDITY|LEVEL|POWER/.test(n) ? 'sampled' : 'event';
            return this.json(res, 200, {datapoints, defaults, add: this.opts.historyAdd ?? [], remove: this.opts.historyRemove ?? [], series: 3, capped: 0, rows_per_series: 500, max_series: 1000});
        }
        // the heating groups: an in-memory store in the API's shapes; a member id fits one group at a time
        type M = {id: string; serial: string; type: string};
        const types = () => this.opts.groupTypes ?? [{id: 'HomeMatic.heating', label: 'Heating_Control', assignable: [{id: 'KEQ0000001', serial: 'KEQ0000001', type: 'HM-CC-RT-DN'}, {id: 'KEQ0000002', serial: 'KEQ0000002', type: 'HM-TC-IT-WM-W-EU'}], leftover: []}];
        const groups = (this.opts.groups ??= []);
        const member = (id: string) => types().flatMap((t) => [...t.assignable, ...t.leftover]).find((m) => m.id === id) ?? {id, serial: id, type: 'unknown'};
        const serial = (id: number) => `INT${String(id).padStart(7, '0')}`;
        const taken = (except?: number) => new Set(groups.filter((g) => g.id !== except).flatMap((g) => g.members.map((m) => m.id)));
        const detail = (g: (typeof groups)[0], configure?: string[]) => {
            const t = types().find((x) => x.id === g.type);
            const used = taken(g.id);
            return {id: g.id, name: g.name, type: g.type, device: serial(g.id), ref: `VirtualDevices.${serial(g.id)}`, device_name: `${g.name} ${serial(g.id)}`, forbid_single_operation: g.forbid_single_operation ?? false, members: g.members, assignable: (t?.assignable ?? []).filter((m: M) => !used.has(m.id) && !g.members.some((x) => x.id === m.id)), leftover: t?.leftover ?? [], types: types().map((x) => ({id: x.id, label: x.label})), ...(configure ? {devices_to_configure: configure.map(member)} : {})};
        };
        if (key === 'GET /groups') return this.json(res, 200, {groups: groups.map((g) => ({id: g.id, name: g.name, type: g.type, type_label: types().find((t) => t.id === g.type)?.label ?? g.type, device: serial(g.id), ref: `VirtualDevices.${serial(g.id)}`})), devices_to_configure: []});
        if (key === 'GET /groups/types') {
            const used = taken();
            return this.json(res, 200, {types: types().map((t) => ({...t, assignable: t.assignable.filter((m) => !used.has(m.id))}))});
        }
        const gm = /^\/groups\/(\d+)$/.exec(rel);
        if (key === 'POST /groups' || (gm && (req.method === 'PUT' || req.method === 'DELETE'))) {
            const b = (await this.body(req)) ?? {};
            if (req.method === 'POST') {
                if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 64) return this.json(res, 422, {error: 'invalid', message: 'name: 1 to 64 characters on one line'});
                if (!types().some((t) => t.id === b.type)) return this.json(res, 422, {error: 'invalid', message: 'type: the group type, e.g. HomeMatic.heating'});
                const id = (groups.at(-1)?.id ?? 0) + 1;
                const g = {id, name: b.name.trim(), type: b.type, members: (b.members ?? []).map(member) as M[], forbid_single_operation: b.forbid_single_operation ?? false};
                groups.push(g);
                return this.json(res, 200, detail(g, g.members.map((m) => m.id)));
            }
            const g = groups.find((x) => x.id === Number(gm![1]));
            if (!g) return this.json(res, 404, {error: 'unknown-group', message: `no group ${gm![1]}`});
            if (req.method === 'DELETE') {
                groups.splice(groups.indexOf(g), 1);
                return this.json(res, 200, {deleted: g.id, former_members: g.members});
            }
            if (b.name !== undefined) {
                if (typeof b.name !== 'string' || !b.name.trim()) return this.json(res, 422, {error: 'invalid', message: 'name: 1 to 64 characters on one line'});
                g.name = b.name.trim();
            }
            if (Array.isArray(b.members)) g.members = b.members.map(member);
            if (typeof b.forbid_single_operation === 'boolean') g.forbid_single_operation = b.forbid_single_operation;
            return this.json(res, 200, detail(g, g.members.map((m) => m.id)));
        }
        if (gm && req.method === 'GET') {
            const g = groups.find((x) => x.id === Number(gm[1]));
            if (!g) return this.json(res, 404, {error: 'unknown-group', message: `no group ${gm[1]}`});
            return this.json(res, 200, detail(g));
        }
        this.json(res, 404, {error: 'not_found', message: `no route ${key}`});
    }
}
