// OccuLite: one connection to an openccu-lite system (task 196). It detects the system and what it
// offers (GET /api/meta/v1/version's capabilities), loads a complete picture - the values with
// ts/lc/confirmed from the state store, the device lists, the metadata - and keeps it live from
// lite-rpc's event stream, owning the stream's reliability: reconnect with backoff, resume by the
// last event id, re-read after a resync, the batches of one multicall together. Requests go over
// lite-rpc's JSON-RPC path, a FLOAT datapoint written as a typed double.

import {OccuLiteError, httpError} from './errors.ts';
import {MetaCopy, type MetaDocument, type MetaEvent} from './meta.ts';
import {datapointRef, parseDatapointRef, parseRef, ref as mkRef} from './refs.ts';
import {parseSSE} from './sse.ts';
import {fetchTransport, type Transport} from './transport.ts';

/** The API majors this client speaks. */
export const SPEAKS = {meta: 1, rpc: 1, system: 1, auth: 1};

export interface Auth {
    /** an API token (olt_…), sent as the bearer credential */
    token?: string;
    /** a browser session id, sent in the Authorization header (D-115's header credential) */
    session?: string;
}

export interface Options {
    url: string;
    auth?: Auth;
    transport?: Transport;
    /** the interfaces to follow; default every interface the system offers */
    interfaces?: string[];
    /** load the state store at connect (default true, when the system has one) */
    values?: boolean;
    /** keep a live copy of names and taxonomy (default true) */
    meta?: boolean;
    /** the device descriptions at connect and their changes (default true) */
    devices?: boolean;
    log?: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;
    /** reconnect backoff in ms; default 1 s growing to 30 s */
    reconnect?: {min: number; max: number};
    /** how long ready() waits for the device lists; default 30 s */
    readyTimeout?: number;
}

export interface Value {
    value: unknown;
    /** ms since the epoch: the last report, the same value or not */
    ts: number;
    /** ms since the epoch: the last change; undefined for a value only seen once without the store */
    lc?: number;
    /** false for a value the system restored from its own file that no device has reported since */
    confirmed: boolean;
}

export interface ValueEvent extends Value {
    ref: string;
    interface: string;
    address: string;
    key: string;
    /** the seq of the first event of the multicall it came in */
    batch?: number;
    previousForS?: number;
    source?: string;
}

export interface Capabilities {
    pairing?: boolean;
    state?: boolean;
    history?: boolean;
    apis?: Record<string, number>;
    transports?: string[];
    limits?: Record<string, number>;
    json_double?: boolean;
    [k: string]: unknown;
}

export interface Info {
    implementation?: string;
    api?: string;
    version?: number;
    revision?: number;
    hmip?: unknown;
}

export type Status = 'idle' | 'connecting' | 'ready' | 'degraded' | 'offline' | 'closed';

type Handler = (arg: any) => void;

interface ParamDesc {
    TYPE?: string;
    OPERATIONS?: number;
    [k: string]: unknown;
}

const ms = (s: string | undefined): number | undefined => (s ? Date.parse(s) : undefined);

export class OccuLite {
    readonly url: string;
    readonly opts: Options;
    info: Info = {};
    capabilities: Capabilities = {};
    scopes: string[] = [];
    interfaces: string[] = [];
    readonly values = new Map<string, Value>();
    /** device and channel descriptions by ref */
    readonly devices = new Map<string, Record<string, unknown>>();
    readonly meta = new MetaCopy();
    status: Status = 'idle';
    /** requests in flight, for a consumer that paces its writes */
    inflight = 0;

    private tx: Transport;
    private handlers = new Map<string, Set<Handler>>();
    private abort = new AbortController();
    private lastEventId = '';
    private bootId = '';
    private descCache = new Map<string, Promise<Record<string, ParamDesc>>>();
    private batchBuf: ValueEvent[] = [];
    private batchMark = 0;
    private batchTimer: ReturnType<typeof setTimeout> | undefined;
    private readyP: Promise<void> | undefined;
    private devicesSeen = new Set<string>();
    private devicesWaiter: (() => void) | undefined;
    private metaRefresh: ReturnType<typeof setTimeout> | undefined;
    private resyncing = false;

    constructor(opts: Options) {
        this.opts = opts;
        this.url = opts.url.replace(/\/+$/, '');
        this.tx = opts.transport ?? fetchTransport();
    }

    // ---- events ------------------------------------------------------------------------------

    /** Subscribes; the answer unsubscribes. Events: status, value, batch, devices, interface, meta, resync, error. */
    on(event: string, fn: Handler): () => void {
        let s = this.handlers.get(event);
        if (!s) this.handlers.set(event, (s = new Set()));
        s.add(fn);
        return () => s!.delete(fn);
    }

    private emit(event: string, arg: unknown): void {
        for (const fn of this.handlers.get(event) ?? []) {
            try {
                fn(arg);
            } catch (e) {
                this.opts.log?.error?.(`occulite-client: a ${event} handler threw`, e);
            }
        }
    }

    private setStatus(s: Status): void {
        if (this.status === s) return;
        this.status = s;
        this.emit('status', {state: s});
    }

    // ---- HTTP --------------------------------------------------------------------------------

    private headers(extra: Record<string, string> = {}): Record<string, string> {
        const h: Record<string, string> = {...extra};
        const a = this.opts.auth;
        if (a?.token) h.Authorization = `Bearer ${a.token}`;
        else if (a?.session) h.Authorization = `Bearer ${a.session}`;
        return h;
    }

    /** Any API call, the same errors; the escape hatch for what the client does not wrap. */
    async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
        this.inflight++;
        try {
            const r = await this.tx.request(method, this.url + path, this.headers(body === undefined ? {} : {'Content-Type': 'application/json'}), body === undefined ? undefined : JSON.stringify(body));
            let parsed: unknown = undefined;
            if (r.body) {
                try {
                    parsed = JSON.parse(r.body);
                } catch {
                    parsed = r.body;
                }
            }
            if (r.status < 200 || r.status > 299) throw httpError(r.status, parsed);
            return parsed as T;
        } finally {
            this.inflight--;
        }
    }

    // ---- connect -----------------------------------------------------------------------------

    /** Connects and resolves once the first complete picture is loaded; rejects on a system that is
     *  not openccu-lite, a refused credential, or an API major it does not speak. */
    ready(): Promise<void> {
        this.readyP ??= this.connect();
        return this.readyP;
    }

    private async connect(): Promise<void> {
        this.setStatus('connecting');
        const v = await this.request<Info & {capabilities?: Capabilities}>('GET', '/api/meta/v1/version').catch((e: OccuLiteError) => {
            if (e.code === 'not-found' || e.status === 404) throw new OccuLiteError('unsupported', 'not an openccu-lite system (no /api/meta/v1/version)');
            throw e;
        });
        if (!v || typeof v !== 'object' || v.api !== 'meta') throw new OccuLiteError('unsupported', 'not an openccu-lite system');
        this.info = {implementation: v.implementation, api: v.api, version: v.version, revision: v.revision, hmip: v.hmip};
        this.capabilities = v.capabilities ?? {};
        for (const [api, major] of Object.entries(this.capabilities.apis ?? {})) {
            const mine = (SPEAKS as Record<string, number>)[api];
            if (mine !== undefined && major > mine) throw new OccuLiteError('unsupported', `the system speaks ${api} API ${major}; this client speaks ${mine} - update occulite-client`);
        }
        const st = await this.request<{scopes?: string[]; authenticated?: boolean}>('GET', '/api/auth/v1/state').catch(() => ({scopes: []}));
        this.scopes = st.scopes ?? [];
        const ifs = await this.request<{name: string}[]>('GET', '/api/rpc/v1/interfaces');
        this.interfaces = (this.opts.interfaces ?? ifs.map((i) => i.name)).filter((n) => ifs.some((i) => i.name === n));
        await Promise.all([this.opts.values === false ? undefined : this.loadValues(), this.opts.meta === false ? undefined : this.loadMeta()]);
        const devicesDone = this.opts.devices === false ? Promise.resolve() : new Promise<void>((res) => (this.devicesWaiter = res));
        void this.runStream();
        if (this.opts.meta !== false) void this.runMetaStream();
        await Promise.race([devicesDone, new Promise<void>((res) => setTimeout(res, this.opts.readyTimeout ?? 30000))]);
        this.setStatus('ready');
    }

    /** Closes the streams; the client is done. */
    close(): void {
        this.abort.abort();
        clearTimeout(this.batchTimer);
        clearTimeout(this.metaRefresh);
        this.setStatus('closed');
    }

    private async loadValues(): Promise<void> {
        if (!this.capabilities.state) return;
        let after = '';
        let eventId = '';
        for (let page = 0; page < 1000; page++) {
            const q = new URLSearchParams({limit: '5000'});
            for (const i of this.interfaces) q.append('interface', i);
            if (after) q.set('after', after);
            const r = await this.request<{entries: any[]; next?: string; event_id?: string}>('GET', `/api/rpc/v1/state?${q}`);
            if (page === 0) eventId = r.event_id ?? '';
            for (const e of r.entries) this.values.set(datapointRef(e.interface, e.address, e.datapoint), {value: e.value, ts: ms(e.ts) ?? 0, lc: ms(e.lc), confirmed: !!e.confirmed});
            if (!r.next) break;
            after = r.next;
        }
        // the stream resumes from the read: nothing between the read and the stream is lost
        if (eventId && !this.lastEventId) this.lastEventId = eventId;
    }

    private async loadMeta(): Promise<void> {
        const doc = await this.request<MetaDocument>('GET', '/api/meta/v1/snapshot').catch(() => undefined);
        if (doc) this.meta.load(doc);
    }

    // ---- the RPC event stream ------------------------------------------------------------------

    private async runStream(): Promise<void> {
        let delay = this.opts.reconnect?.min ?? 1000;
        const maxDelay = this.opts.reconnect?.max ?? 30000;
        let firstDevices = this.opts.devices !== false;
        while (!this.abort.signal.aborted) {
            const q = new URLSearchParams();
            for (const i of this.interfaces) q.append('interface', i);
            if (firstDevices) q.set('devices', '1');
            const h = this.headers();
            if (this.lastEventId) h['Last-Event-ID'] = this.lastEventId;
            try {
                const s = await this.tx.stream(`${this.url}/api/rpc/v1/events?${q}`, h, this.abort.signal);
                if (s.status !== 200) {
                    let body: unknown = s.body;
                    try {
                        body = JSON.parse(s.body ?? '');
                    } catch {
                        /* text */
                    }
                    const err = httpError(s.status, body);
                    this.emit('error', err);
                    if (s.status === 401 || s.status === 403) {
                        this.setStatus('offline');
                        return; // a credential that is refused does not get better by retrying
                    }
                    throw err;
                }
                delay = this.opts.reconnect?.min ?? 1000;
                for await (const m of parseSSE(s.chunks)) {
                    if (m.id) this.lastEventId = m.id;
                    this.handle(m.event, m.data);
                }
                firstDevices = false;
            } catch (e) {
                if (this.abort.signal.aborted) return;
                this.opts.log?.warn?.(`occulite-client: the event stream ended: ${(e as Error).message}`);
            }
            if (this.abort.signal.aborted) return;
            if (this.status === 'ready') this.setStatus('degraded');
            await new Promise((res) => setTimeout(res, delay));
            delay = Math.min(delay * 2, maxDelay);
        }
    }

    private handle(event: string, raw: string): void {
        let d: any;
        try {
            d = JSON.parse(raw);
        } catch {
            return;
        }
        switch (event) {
            case 'hello': {
                if (this.bootId && d.boot_id && d.boot_id !== this.bootId) void this.resync('boot');
                this.bootId = d.boot_id ?? this.bootId;
                if (this.status === 'degraded') this.setStatus('ready');
                break;
            }
            case 'event':
            case 'state': {
                const key = event === 'event' ? d.key : (d.datapoint ?? d.key);
                const r = datapointRef(d.interface, d.address, key);
                const prev = this.values.get(r);
                const ts = ms(d.ts) ?? Date.now();
                const changed = !prev || !Object.is(prev.value, d.value);
                const v: Value = {value: d.value, ts, lc: ms(d.lc) ?? (changed ? ts : prev?.lc), confirmed: d.confirmed ?? true};
                this.values.set(r, v);
                const ev: ValueEvent = {ref: r, interface: d.interface, address: d.address, key, ...v, batch: d.batch, previousForS: d.previous_for_s, source: d.source};
                this.emit('value', ev);
                if (event === 'event') this.collectBatch(ev);
                break;
            }
            case 'interface':
                this.emit('interface', {interface: d.interface, state: d.state});
                break;
            case 'newDevices':
            case 'deleteDevices':
            case 'updateDevice':
            case 'replaceDevice':
            case 'readdedDevice': {
                const kind = {newDevices: 'new', deleteDevices: 'deleted', updateDevice: 'updated', replaceDevice: 'replaced', readdedDevice: 'readded'}[event];
                if (Array.isArray(d.devices)) {
                    for (const desc of d.devices) if (desc?.ADDRESS) this.devices.set(mkRef(d.interface, desc.ADDRESS), desc);
                    this.devicesSeen.add(d.interface);
                    if (this.devicesWaiter && this.interfaces.every((i) => this.devicesSeen.has(i))) {
                        this.devicesWaiter();
                        this.devicesWaiter = undefined;
                    }
                }
                if (event === 'deleteDevices') {
                    for (const a of d.addresses ?? []) {
                        for (const k of [...this.devices.keys()]) if (k === mkRef(d.interface, a) || k.startsWith(mkRef(d.interface, a) + ':')) this.devices.delete(k);
                    }
                }
                this.emit('devices', {kind, interface: d.interface, refs: (d.addresses ?? (d.devices ?? []).map((x: any) => x.ADDRESS)).map((a: string) => mkRef(d.interface, a)), descriptions: d.devices});
                break;
            }
            case 'resync':
                void this.resync(d.reason ?? 'gap');
                break;
        }
    }

    // the events of one system.multicall carry the same batch mark: gathered, emitted together
    private collectBatch(ev: ValueEvent): void {
        if (!ev.batch) return;
        if (this.batchMark && ev.batch !== this.batchMark) this.flushBatch();
        this.batchMark = ev.batch;
        this.batchBuf.push(ev);
        clearTimeout(this.batchTimer);
        this.batchTimer = setTimeout(() => this.flushBatch(), 20);
    }

    private flushBatch(): void {
        clearTimeout(this.batchTimer);
        if (this.batchBuf.length) this.emit('batch', this.batchBuf);
        this.batchBuf = [];
        this.batchMark = 0;
    }

    /** After a gap, another boot or an overflow: the values are read again, then 'resync' tells a
     *  consumer that caches to republish. */
    private async resync(reason: string): Promise<void> {
        // the hello of another boot and the server's own resync message come together: one re-read
        if (this.resyncing) return;
        this.resyncing = true;
        try {
            if (this.opts.values !== false) await this.loadValues();
        } catch (e) {
            this.emit('error', e);
        } finally {
            this.resyncing = false;
        }
        this.emit('resync', {reason});
    }

    // ---- the metadata stream ---------------------------------------------------------------------

    private async runMetaStream(): Promise<void> {
        let delay = this.opts.reconnect?.min ?? 1000;
        while (!this.abort.signal.aborted) {
            try {
                const s = await this.tx.stream(`${this.url}/api/meta/v1/events/sse?since=${this.meta.revision}`, this.headers(), this.abort.signal);
                if (s.status === 401 || s.status === 403 || s.status === 404) return;
                if (s.status === 200) {
                    delay = this.opts.reconnect?.min ?? 1000;
                    for await (const m of parseSSE(s.chunks)) {
                        let ev: MetaEvent;
                        try {
                            ev = JSON.parse(m.data);
                        } catch {
                            continue;
                        }
                        if (!this.meta.apply(ev)) this.refreshMetaSoon();
                        this.emit('meta', ev);
                    }
                }
            } catch {
                if (this.abort.signal.aborted) return;
            }
            await new Promise((res) => setTimeout(res, delay));
            delay = Math.min(delay * 2, this.opts.reconnect?.max ?? 30000);
        }
    }

    private refreshMetaSoon(): void {
        clearTimeout(this.metaRefresh);
        this.metaRefresh = setTimeout(() => void this.loadMeta(), 200);
    }

    // ---- requests over lite-rpc's JSON-RPC path --------------------------------------------------

    private rpcId = 0;

    /** Any method of an interface process; the credential's tier decides (task 78). */
    async call<T = unknown>(iface: string, method: string, params: unknown[] = []): Promise<T> {
        const r = await this.request<{result?: T; error?: {code: number; message: string}}>('POST', `/api/rpc/v1/json/${encodeURIComponent(iface)}`, {jsonrpc: '2.0', method, params, id: ++this.rpcId});
        if (r?.error) throw new OccuLiteError('rpc-fault', r.error.message, {faultCode: r.error.code, method});
        return r?.result as T;
    }

    /** Several calls in one request (a JSON-RPC batch). */
    async batch(iface: string, calls: [string, unknown[]][]): Promise<unknown[]> {
        const body = calls.map(([method, params]) => ({jsonrpc: '2.0', method, params, id: ++this.rpcId}));
        const r = await this.request<{id: number; result?: unknown; error?: {code: number; message: string}}[]>('POST', `/api/rpc/v1/json/${encodeURIComponent(iface)}`, body);
        const byId = new Map((r ?? []).map((x) => [x.id, x]));
        return body.map((b, i) => {
            const x = byId.get(b.id);
            if (x?.error) return new OccuLiteError('rpc-fault', x.error.message, {faultCode: x.error.code, method: calls[i][0]});
            return x?.result;
        });
    }

    /** A channel's paramset description, cached per channel. */
    paramsetDescription(channelRef: string, paramset = 'VALUES'): Promise<Record<string, ParamDesc>> {
        const k = `${channelRef}|${paramset}`;
        let p = this.descCache.get(k);
        if (!p) {
            const {interface: i, address} = parseRef(channelRef);
            p = this.call<Record<string, ParamDesc>>(i, 'getParamsetDescription', [address, paramset]);
            p.catch(() => this.descCache.delete(k));
            this.descCache.set(k, p);
        }
        return p;
    }

    /** A value typed for the wire: a FLOAT datapoint's number as {"double": n} (task 196, S2). */
    private async typed(channelRef: string, key: string, value: unknown): Promise<unknown> {
        if (typeof value !== 'number' || !Number.isInteger(value) || !this.capabilities.json_double) return value;
        const desc = await this.paramsetDescription(channelRef).catch(() => undefined);
        return desc?.[key]?.TYPE === 'FLOAT' ? {double: value} : value;
    }

    async getValue(datapoint: string): Promise<unknown> {
        const {interface: i, address, key} = parseDatapointRef(datapoint);
        return this.call(i, 'getValue', [address, key]);
    }

    async setValue(datapoint: string, value: unknown): Promise<void> {
        const {interface: i, address, key} = parseDatapointRef(datapoint);
        await this.call(i, 'setValue', [address, key, await this.typed(mkRef(i, address), key, value)]);
    }

    async getParamset(channelRef: string, paramset = 'VALUES'): Promise<Record<string, unknown>> {
        const {interface: i, address} = parseRef(channelRef);
        return this.call(i, 'getParamset', [address, paramset]);
    }

    async putParamset(channelRef: string, paramset: string, values: Record<string, unknown>): Promise<void> {
        const {interface: i, address} = parseRef(channelRef);
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(values)) out[k] = paramset === 'VALUES' ? await this.typed(channelRef, k, v) : v;
        await this.call(i, 'putParamset', [address, paramset, out]);
    }

    // ---- history, metadata writes, the token -----------------------------------------------------

    /** One datapoint's history (task 195): [[ms, value], …]. */
    async history(datapoint: string, opts: {from?: number | Date; to?: number | Date; maxPoints?: number} = {}): Promise<[number, unknown][]> {
        if (!this.capabilities.history) throw new OccuLiteError('unsupported', 'this system keeps no datapoint history');
        const {interface: i, address, key} = parseDatapointRef(datapoint);
        const q = new URLSearchParams({interface: i, address, datapoint: key});
        if (opts.from !== undefined) q.set('from', String(+opts.from));
        if (opts.to !== undefined) q.set('to', String(+opts.to));
        if (opts.maxPoints) q.set('max_points', String(opts.maxPoints));
        return this.request('GET', `/api/rpc/v1/history?${q}`);
    }

    async rename(ref: string, name: string): Promise<void> {
        await this.request('PATCH', `/api/meta/v1/objects/${encodeURIComponent(ref)}`, {name});
    }

    async assign(ref: string, path: string, member: boolean): Promise<void> {
        const cur = this.meta.object(ref)?.enums ?? [];
        const enums = member ? [...new Set([...cur, path])] : cur.filter((p) => p !== path);
        await this.request('PATCH', `/api/meta/v1/objects/${encodeURIComponent(ref)}`, {enums});
    }

    /** A new secret for this client's token (task 219); the old one stays valid a minute. The
     *  client uses the new one from here on; store it. */
    async rotateToken(): Promise<string> {
        const r = await this.request<{token: string}>('POST', '/api/auth/v1/tokens/self/rotate', {});
        if (this.opts.auth) this.opts.auth.token = r.token;
        return r.token;
    }
}
