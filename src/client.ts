// OccuLite: one connection to an openccu-lite system (task 196). It detects the system and what it
// offers (GET /api/meta/v1/version's capabilities), loads a complete picture - the values with
// ts/lc/confirmed from the state store, the device lists, the metadata - and keeps it live from
// lite-rpc's event stream, owning the stream's reliability: reconnect with backoff, resume by the
// last event id, re-read after a resync, the batches of one multicall together. Requests go over
// lite-rpc's JSON-RPC path, a FLOAT datapoint written as a typed double.

import {OccuLiteError, abortError, httpError, timeoutSignal} from './errors.ts';
import {MetaCopy, type MetaDocument, type MetaEvent} from './meta.ts';
import {datapointRef, parseDatapointRef, parseRef, ref as mkRef} from './refs.ts';
import {parseSSE} from './sse.ts';
import {fetchTransport, type Transport} from './transport.ts';

/** The API majors this client speaks. */
export const SPEAKS = {meta: 1, rpc: 1, system: 1, auth: 1};

/** The header every request carries: occulited refuses a state-changing call whose only credential
 *  is the session cookie without it (a custom header cannot ride on a cross-site form post or a
 *  link). Harmless beside a Bearer. */
export const REQUEST_HEADER = 'X-Occulite-Request';

export interface Auth {
    /** an API token (olt_…), sent as the bearer credential */
    token?: string;
    /** a browser session id, sent in the Authorization header (D-115's header credential) */
    session?: string;
}

/** Which credential the client uses - for a consumer's status line and its hints. */
export type Credential = 'token' | 'addon' | 'local' | 'session' | 'none';

/** A credential found at connect and again after a 401 (occulite-client/node's nodeAuth() reads the
 *  addon's and the local token file this way, so a token created later is picked up without a restart). */
export interface AuthProvider {
    resolve(reason: 'start' | 'unauthenticated'): Promise<Auth & {credential?: Credential}> | (Auth & {credential?: Credential});
}

/** full: devices, values and requests over lite-rpc; names-only: the credential lacks rpc:read (the
 *  local token, say), so only the metadata is loaded and followed and every RPC method rejects forbidden. */
export type Mode = 'full' | 'names-only';

export interface Options {
    url: string;
    /** the credential, or a provider that finds one (occulite-client/node: nodeAuth('auto')) */
    auth?: Auth | AuthProvider;
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
    /** per request, ms; default 30 s. A request over it rejects with `timeout` (not `unreachable`) */
    timeout?: number;
    /** the whole connect - detection, credential, the first picture - before ready() rejects with `timeout`; default 60 s */
    connectTimeout?: number;
    /** silence on a stream (the system pings every 15 s) after which it is reopened; default 45 s */
    streamTimeout?: number;
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

/** One interface the system runs, as GET /api/rpc/v1/interfaces answers it (the names are the
 *  InterfacesList.xml names lite-rpc's paths take). */
export interface InterfaceInfo {
    name: string;
    protocol?: string;
    url_path?: string;
    /** the subscriber's view: the process answered its last init or ping */
    running: boolean;
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
const isProvider = (a: Auth | AuthProvider): a is AuthProvider => typeof (a as AuthProvider).resolve === 'function';

export class OccuLite {
    readonly url: string;
    readonly opts: Options;
    info: Info = {};
    capabilities: Capabilities = {};
    scopes: string[] = [];
    /** which credential is in use */
    credential: Credential = 'none';
    /** full, or names-only for a credential without rpc:read */
    mode: Mode = 'full';
    /** the interfaces followed, with their state: from GET /api/rpc/v1/interfaces (rpc:read), else
     *  learned from the stream's hello; kept live from the interface events */
    interfaces: InterfaceInfo[] = [];
    readonly values = new Map<string, Value>();
    /** device and channel descriptions by ref */
    readonly devices = new Map<string, Record<string, unknown>>();
    readonly meta = new MetaCopy();
    status: Status = 'idle';
    /** requests in flight, for a consumer that paces its writes */
    inflight = 0;

    private tx: Transport;
    private auth: Auth = {};
    private reauthAt = 0;
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
    /** the list came from the interfaces route (else it is a guess the stream's hello completes) */
    private interfacesListed = false;

    constructor(opts: Options) {
        this.opts = opts;
        this.url = opts.url.replace(/\/+$/, '');
        this.tx = opts.transport ?? fetchTransport();
        if (opts.auth && !isProvider(opts.auth)) this.takeAuth(opts.auth);
    }

    private takeAuth(a: Auth & {credential?: Credential}): boolean {
        const before = this.auth.token ?? this.auth.session;
        this.auth = a; // the object itself: rotateToken() writes the new secret into it for the consumer
        this.credential = a.credential ?? (a.token ? 'token' : a.session ? 'session' : 'none');
        return (a.token ?? a.session) !== before;
    }

    /** Asks the provider (when there is one); true when the credential changed. */
    private async resolveAuth(reason: 'start' | 'unauthenticated'): Promise<boolean> {
        const a = this.opts.auth;
        if (!a || !isProvider(a)) return false;
        if (reason === 'unauthenticated') {
            if (Date.now() - this.reauthAt < 30000) return false; // once, not on every refused call
            this.reauthAt = Date.now();
        }
        return this.takeAuth(await a.resolve(reason));
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
        const h: Record<string, string> = {[REQUEST_HEADER]: '1', ...extra};
        if (this.auth.token) h.Authorization = `Bearer ${this.auth.token}`;
        else if (this.auth.session) h.Authorization = `Bearer ${this.auth.session}`;
        return h;
    }

    /** Any API call, the same errors; the escape hatch for what the client does not wrap. A request
     *  takes opts.timeout (default the client's) and a signal of the caller's; close() ends it too. */
    async request<T = unknown>(method: string, path: string, body?: unknown, opts: {signal?: AbortSignal; timeout?: number} = {}): Promise<T> {
        this.inflight++;
        try {
            const signal = timeoutSignal(opts.timeout ?? this.opts.timeout ?? 30000, this.abort.signal, opts.signal);
            const raw = body === undefined ? undefined : JSON.stringify(body);
            const ct: Record<string, string> = body === undefined ? {} : {'Content-Type': 'application/json'};
            let r = await this.tx.request(method, this.url + path, this.headers(ct), raw, signal);
            // a refused credential: the provider may know a newer one (a token file rewritten) - once
            if (r.status === 401 && (await this.resolveAuth('unauthenticated'))) r = await this.tx.request(method, this.url + path, this.headers(ct), raw, signal);
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
     *  not openccu-lite, a refused credential, an API major it does not speak, `timeout` after
     *  connectTimeout, or `aborted` when the signal fires (the client is closed then). */
    ready(opts: {signal?: AbortSignal} = {}): Promise<void> {
        this.readyP ??= this.connect(opts.signal);
        return this.readyP;
    }

    private async connect(signal?: AbortSignal): Promise<void> {
        const deadline = timeoutSignal(this.opts.connectTimeout ?? 60000, signal);
        const onAbort = () => {
            this.close();
        };
        deadline?.addEventListener('abort', onAbort, {once: true});
        try {
            await this.connectSteps(deadline);
        } catch (e) {
            if (deadline?.aborted) throw abortError(deadline, 'connecting');
            throw e;
        } finally {
            deadline?.removeEventListener('abort', onAbort);
        }
    }

    private async connectSteps(signal?: AbortSignal): Promise<void> {
        this.setStatus('connecting');
        await this.resolveAuth('start');
        const v = await this.request<Info & {capabilities?: Capabilities}>('GET', '/api/meta/v1/version', undefined, {signal}).catch((e: OccuLiteError) => {
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
        const unauth = () => new OccuLiteError('unauthenticated', this.credential === 'none' ? 'no credential: pair this program with the system, or pass a token (auth: {token})' : `the ${this.credential} credential is not accepted by the system: pair again, or check the token`, {status: 401});
        const st = await this.request<{scopes?: string[]; authenticated?: boolean}>('GET', '/api/auth/v1/state', undefined, {signal}).catch((e: OccuLiteError) => {
            if (e.code === 'unauthenticated') throw unauth();
            if (e.code === 'not-found' || e.code === 'unsupported') return {} as {scopes?: string[]; authenticated?: boolean}; // no auth state to read: assume full access
            throw e;
        });
        if (st.authenticated === false) throw unauth();
        this.scopes = st.scopes ?? [];
        const rpc = st.scopes === undefined || this.scopes.includes('*') || this.scopes.includes('rpc:read');
        this.mode = rpc ? 'full' : 'names-only';
        if (rpc) await this.loadInterfaces(signal);
        await Promise.all([this.opts.values === false || !rpc ? undefined : this.loadValues(signal), this.opts.meta === false ? undefined : this.loadMeta(signal)]);
        if (signal?.aborted) throw abortError(signal, 'connecting');
        const devicesDone = this.opts.devices === false || !rpc ? Promise.resolve() : new Promise<void>((res) => (this.devicesWaiter = res));
        if (rpc) void this.runStream();
        else this.opts.log?.info?.(`occulite-client: names only - the ${this.credential} credential lacks rpc:read; pair for devices and values`);
        if (this.opts.meta !== false) void this.runMetaStream();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const gaveUp = new Promise<void>((res) => (timer = setTimeout(res, this.opts.readyTimeout ?? 30000)));
        const aborted = new Promise<void>((res) => signal?.addEventListener('abort', () => res(), {once: true}));
        try {
            await Promise.race([devicesDone, gaveUp, aborted]);
        } finally {
            clearTimeout(timer);
        }
        if (signal?.aborted) throw abortError(signal, 'connecting');
        this.setStatus('ready');
    }

    /** The interfaces this system runs, typed: GET /api/rpc/v1/interfaces (needs rpc:read). */
    listInterfaces(opts: {signal?: AbortSignal} = {}): Promise<InterfaceInfo[]> {
        return this.request<InterfaceInfo[]>('GET', '/api/rpc/v1/interfaces', undefined, opts).then((l) => (Array.isArray(l) ? l.map((i) => ({...i, running: i.running !== false})) : []));
    }

    /** The interfaces to follow: the system's list narrowed to opts.interfaces. A credential
     *  without rpc:read (403) or a system without the route (404) is no failure: the consumer's
     *  list stands as a guess, and the stream's hello names the rest. */
    private async loadInterfaces(signal?: AbortSignal): Promise<void> {
        const wanted = this.opts.interfaces;
        try {
            const list = await this.listInterfaces({signal});
            this.interfaces = wanted ? list.filter((i) => wanted.includes(i.name)) : list;
            this.interfacesListed = true;
        } catch (e) {
            const code = (e as OccuLiteError).code;
            if (code !== 'forbidden' && code !== 'not-found' && code !== 'unsupported') throw e;
            this.opts.log?.warn?.(`occulite-client: the interfaces list is not available (${code}); following ${wanted?.join(', ') || 'what the stream names'}`);
            this.interfaces = (wanted ?? []).map((name) => ({name, running: true}));
            this.interfacesListed = false;
        }
    }

    /** The stream's and the state read's interface= filter: the consumer's choice, or none - a
     *  filter would hide the `interface added` of one that appears later (the system matches
     *  interface events by the filter too), and a client that wants everything saves nothing by it. */
    private interfaceFilter(): string[] {
        return this.opts.interfaces ? this.interfaces.map((i) => i.name) : [];
    }

    /** ready() waits for the device lists of the running interfaces; a stopped one is reported
     *  through `interface {state: 'down'}` and its list taken when it comes. */
    private checkDevicesReady(): void {
        if (this.devicesWaiter && this.interfaces.filter((i) => i.running).every((i) => this.devicesSeen.has(i.name))) {
            this.devicesWaiter();
            this.devicesWaiter = undefined;
        }
    }

    private setInterfaceState(name: string, running: boolean): void {
        const cur = this.interfaces.find((i) => i.name === name);
        if (cur) cur.running = running;
        else if (!this.opts.interfaces || this.opts.interfaces.includes(name)) this.interfaces.push({name, running});
    }

    private fetching = new Set<string>();

    /** listDevices of one interface (a late one, or a newDevices that named addresses only): the
     *  descriptions go into box.devices and out as one `devices {kind: 'new'}` event with them. */
    private async fetchDevices(iface: string, addresses?: string[]): Promise<void> {
        if (this.opts.devices === false || this.mode !== 'full' || this.fetching.has(iface)) return;
        this.fetching.add(iface);
        try {
            const list = await this.call<Record<string, unknown>[]>(iface, 'listDevices');
            const want = addresses ? new Set(addresses) : undefined;
            const descs: Record<string, unknown>[] = [];
            for (const desc of Array.isArray(list) ? list : []) {
                const a = desc?.ADDRESS as string | undefined;
                if (!a) continue;
                const known = this.devices.has(mkRef(iface, a));
                this.devices.set(mkRef(iface, a), desc);
                if (want ? want.has(a) : !known) descs.push(desc);
            }
            this.devicesSeen.add(iface);
            this.checkDevicesReady();
            this.opts.log?.debug?.(`occulite-client: listDevices on ${iface}: ${Array.isArray(list) ? list.length : 0} descriptions, ${descs.length} new`);
            if (descs.length || want) this.emit('devices', {kind: 'new', interface: iface, refs: descs.map((x) => mkRef(iface, x.ADDRESS as string)), descriptions: descs});
        } catch (e) {
            this.opts.log?.warn?.(`occulite-client: listDevices on ${iface} failed: ${(e as Error).message}`);
            if (addresses) this.emit('devices', {kind: 'new', interface: iface, refs: addresses.map((a) => mkRef(iface, a))});
        } finally {
            this.fetching.delete(iface);
        }
    }

    /** Closes the streams; the client is done. */
    close(): void {
        this.abort.abort();
        clearTimeout(this.batchTimer);
        clearTimeout(this.metaRefresh);
        this.setStatus('closed');
    }

    private async loadValues(signal?: AbortSignal): Promise<void> {
        if (!this.capabilities.state) return;
        let after = '';
        let eventId = '';
        for (let page = 0; page < 1000; page++) {
            const q = new URLSearchParams({limit: '5000'});
            for (const i of this.interfaceFilter()) q.append('interface', i);
            if (after) q.set('after', after);
            const r = await this.request<{entries: any[]; next?: string; event_id?: string}>('GET', `/api/rpc/v1/state?${q}`, undefined, {signal});
            if (page === 0) eventId = r.event_id ?? '';
            for (const e of r.entries) this.values.set(datapointRef(e.interface, e.address, e.datapoint), {value: e.value, ts: ms(e.ts) ?? 0, lc: ms(e.lc), confirmed: !!e.confirmed});
            if (!r.next) break;
            after = r.next;
        }
        // the stream resumes from the read: nothing between the read and the stream is lost
        if (eventId && !this.lastEventId) this.lastEventId = eventId;
    }

    private async loadMeta(signal?: AbortSignal): Promise<void> {
        const doc = await this.request<MetaDocument>('GET', '/api/meta/v1/snapshot', undefined, {signal}).catch(() => undefined);
        if (doc) this.meta.load(doc);
    }

    /** Opens a stream with a silence watchdog: no message or ping for streamTimeout ends it, and
     *  the caller reopens. The stream ends with close() too. */
    private async openStream(url: string, headers: Record<string, string>): Promise<{status: number; body?: string; messages: AsyncGenerator<import('./sse.ts').SSEMessage>}> {
        const sc = new AbortController();
        const signal = AbortSignal.any([this.abort.signal, sc.signal]);
        const silence = this.opts.streamTimeout ?? 45000;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const kick = () => {
            clearTimeout(timer);
            timer = setTimeout(() => sc.abort(new OccuLiteError('timeout', `no message for ${silence} ms`, {detail: {code: 'timeout'}})), silence);
        };
        kick();
        let s: Awaited<ReturnType<Transport['stream']>>;
        try {
            s = await this.tx.stream(url, headers, signal);
        } catch (e) {
            clearTimeout(timer);
            throw sc.signal.aborted ? new OccuLiteError('timeout', 'the stream did not open in time', {detail: {code: 'timeout'}}) : e;
        }
        const parsed = parseSSE(s.chunks, kick);
        const self = this;
        async function* messages() {
            try {
                for await (const m of parsed) {
                    kick();
                    yield m;
                }
                if (sc.signal.aborted && !self.abort.signal.aborted) throw sc.signal.reason;
            } finally {
                clearTimeout(timer);
            }
        }
        if (s.status !== 200) clearTimeout(timer);
        return {status: s.status, body: s.body, messages: messages()};
    }

    // ---- the RPC event stream ------------------------------------------------------------------

    private async runStream(): Promise<void> {
        let delay = this.opts.reconnect?.min ?? 1000;
        const maxDelay = this.opts.reconnect?.max ?? 30000;
        while (!this.abort.signal.aborted) {
            const q = new URLSearchParams();
            for (const i of this.interfaceFilter()) q.append('interface', i);
            // the device lists with the stream while ready() still waits for them (a dropped stream asks again)
            if (this.opts.devices !== false && this.devicesWaiter) q.set('devices', '1');
            const h = this.headers();
            if (this.lastEventId) h['Last-Event-ID'] = this.lastEventId;
            try {
                const s = await this.openStream(`${this.url}/api/rpc/v1/events?${q}`, h);
                if (s.status !== 200) {
                    let body: unknown = s.body;
                    try {
                        body = JSON.parse(s.body ?? '');
                    } catch {
                        /* text */
                    }
                    const err = httpError(s.status, body);
                    if (s.status === 401 && (await this.resolveAuth('unauthenticated'))) continue; // a newer token: again, at once
                    this.emit('error', err);
                    if (s.status === 401 || s.status === 403) {
                        this.setStatus('offline');
                        return; // a credential that is refused does not get better by retrying
                    }
                    throw err;
                }
                delay = this.opts.reconnect?.min ?? 1000;
                for await (const m of s.messages) {
                    if (m.id) this.lastEventId = m.id;
                    this.handle(m.event, m.data);
                }
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
                // the hello names the interfaces and their state: what a guess lacked, and the state of the listed ones
                for (const i of Array.isArray(d.interfaces) ? d.interfaces : []) {
                    if (typeof i?.name !== 'string') continue;
                    if (this.interfacesListed && !this.interfaces.some((x) => x.name === i.name)) continue;
                    this.setInterfaceState(i.name, i.state !== 'down');
                }
                this.checkDevicesReady();
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
                if (typeof d.interface === 'string') {
                    if (d.state === 'removed') this.interfaces = this.interfaces.filter((i) => i.name !== d.interface);
                    else this.setInterfaceState(d.interface, d.state !== 'down');
                    // one that came up after connect (hmipserver after rfd, a stopped hs485d started): its devices
                    if ((d.state === 'added' || d.state === 'up' || d.state === 'restarted') && this.interfaces.some((i) => i.name === d.interface)) void this.fetchDevices(d.interface);
                    this.checkDevicesReady();
                }
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
                    this.checkDevicesReady();
                } else if (event === 'newDevices' && d.error !== undefined) {
                    // the ?devices=1 snapshot of an interface that did not answer: nothing to wait for
                    this.opts.log?.warn?.(`occulite-client: no device list from ${d.interface}: ${d.error}`);
                    this.setInterfaceState(d.interface, false);
                    this.devicesSeen.add(d.interface);
                    this.checkDevicesReady();
                    break;
                } else if (event === 'newDevices' && this.opts.devices !== false && Array.isArray(d.addresses) && this.mode === 'full') {
                    // the live event carries addresses only: the descriptions come from listDevices, then the event
                    void this.fetchDevices(d.interface, d.addresses);
                    break;
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
                const s = await this.openStream(`${this.url}/api/meta/v1/events/sse?since=${this.meta.revision}`, this.headers());
                if (s.status === 401 || s.status === 403 || s.status === 404) return;
                if (s.status === 200) {
                    delay = this.opts.reconnect?.min ?? 1000;
                    for await (const m of s.messages) {
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
            } catch (e) {
                if (this.abort.signal.aborted) return;
                this.opts.log?.warn?.(`occulite-client: the metadata stream ended: ${(e as Error).message}`);
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

    /** names-only: every RPC method rejects forbidden naming rpc:read, without a request. */
    private rpcGuard(): void {
        if (this.mode === 'names-only') throw new OccuLiteError('forbidden', `names only: the ${this.credential} credential lacks rpc:read - pair this program with the system for devices and values`, {status: 403, scope: 'rpc:read'});
    }

    /** Any method of an interface process; the credential's tier decides (task 78). */
    async call<T = unknown>(iface: string, method: string, params: unknown[] = []): Promise<T> {
        this.rpcGuard();
        const r = await this.request<{result?: T; error?: {code: number; message: string}}>('POST', `/api/rpc/v1/json/${encodeURIComponent(iface)}`, {jsonrpc: '2.0', method, params, id: ++this.rpcId});
        if (r?.error) throw new OccuLiteError('rpc-fault', r.error.message, {faultCode: r.error.code, method});
        return r?.result as T;
    }

    /** Several calls in one request (a JSON-RPC batch). */
    async batch(iface: string, calls: [string, unknown[]][]): Promise<unknown[]> {
        this.rpcGuard();
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
        this.rpcGuard();
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
        this.auth.token = r.token;
        return r.token;
    }
}
