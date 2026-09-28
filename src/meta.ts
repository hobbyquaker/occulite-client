// The metadata API's live copy and its writes (docs/meta-api.md, docs/meta-format.md): the snapshot
// at connect, the change stream's events applied in place where the copy can follow them (objects,
// a node's name or icon, a move, an enum's name) and a fresh snapshot for the rest (a created or
// deleted node or enum, an import, a resync, a revision gap). Reads by ref and by path with the
// format's tree semantics - a channel in room/eg/bad is in room/eg too, when asked with inherit.
// The writes mirror the API's routes and go through a writer the client attaches; every write
// answers {revision, changed} and takes an If-Match revision.

import {OccuLiteError} from './errors.ts';

export interface MetaObject {
    name?: string;
    enums?: string[];
    meta?: Record<string, unknown>;
    orphaned?: boolean;
}

export interface MetaNode {
    id: string;
    name?: string | Record<string, string>;
    icon?: string;
    children?: MetaNode[];
}

export interface MetaEnum {
    name?: string | Record<string, string>;
    /** the nodes, ordered (docs/meta-format.md: `tree`) */
    tree?: MetaNode[];
    /** @deprecated 0.1.0 read `nodes`/`children`; the format's key is `tree` */
    nodes?: MetaNode[];
    children?: MetaNode[];
}

export interface MetaDocument {
    format: number;
    revision: number;
    objects: Record<string, MetaObject>;
    enums: Record<string, MetaEnum>;
}

export interface MetaEvent {
    revision: number;
    kind: string;
    ref?: string;
    value?: unknown;
    enum?: string;
    path?: string;
    from?: string;
    to?: string;
    [k: string]: unknown;
}

/** A node with its path, for the rooms and functions lists. */
export interface NodeInfo {
    path: string;
    id: string;
    name: string;
    refs: string[];
}

/** A node an object belongs to: its path, id and name in the language asked for. */
export interface NodeRef {
    path: string;
    id: string;
    name: string;
    /** 1 for a root node */
    depth: number;
}

/** What every metadata write answers: the store's revision after it, and whether it changed anything
 *  (a `304`: nothing changed, the revision did not move). */
export interface WriteResult {
    revision: number;
    changed: boolean;
}

export interface WriteOptions {
    /** the revision the write is conditional on: `revision-conflict` (409) when the store moved on */
    ifMatch?: number;
    signal?: AbortSignal;
}

/** The API's error codes (docs/meta-api.md), as OccuLiteError.code. */
export type MetaErrorCode =
    | 'invalid-ref'
    | 'invalid-name'
    | 'invalid-id'
    | 'unknown-object'
    | 'unknown-enum'
    | 'unknown-path'
    | 'duplicate-id'
    | 'duplicate-path'
    | 'has-members'
    | 'invalid-move'
    | 'too-deep'
    | 'format-unsupported'
    | 'revision-conflict'
    | 'unauthenticated'
    | 'forbidden';

/** What the client hands the copy for its writes: one metadata API request. */
export interface MetaWriter {
    write(method: 'PUT' | 'PATCH' | 'POST' | 'DELETE', path: string, body: unknown, opts: WriteOptions & {query?: Record<string, string>; contentType?: string}): Promise<WriteResult>;
    read<T = unknown>(path: string, opts?: {signal?: AbortSignal; raw?: boolean}): Promise<T>;
}

function label(n: string | Record<string, string> | undefined, lang = 'en'): string {
    if (!n) return '';
    if (typeof n === 'string') return n;
    return n[lang] ?? n.en ?? Object.values(n)[0] ?? '';
}

const enc = encodeURIComponent;
/** A node path in a URL is literal (docs/meta-api.md), the enum id its first segment. */
const nodeUrl = (path: string) => {
    const i = path.indexOf('/');
    const e = i < 0 ? path : path.slice(0, i);
    return `/enums/${enc(e)}/nodes/${i < 0 ? '' : path.slice(i + 1)}`;
};

export class MetaCopy {
    doc: MetaDocument = {format: 1, revision: 0, objects: {}, enums: {}};
    private writer: MetaWriter | undefined;

    /** The client attaches its writer; a copy without one refuses writes with `unsupported`. */
    attach(writer: MetaWriter): void {
        this.writer = writer;
    }

    private w(): MetaWriter {
        if (!this.writer) throw new OccuLiteError('unsupported', 'this metadata copy is not attached to a system');
        return this.writer;
    }

    // every write and read below rejects (never throws) when the copy has no system
    private async run(method: 'PUT' | 'PATCH' | 'POST' | 'DELETE', path: string, body: unknown, opts: WriteOptions & {query?: Record<string, string>; contentType?: string}): Promise<WriteResult> {
        return this.w().write(method, path, body, opts);
    }

    private async get<T>(path: string, opts?: {signal?: AbortSignal; raw?: boolean}): Promise<T> {
        return this.w().read<T>(path, opts);
    }

    /** Replaces the copy with a snapshot (its own copy of it: the events are applied in place). */
    load(doc: MetaDocument): void {
        this.doc = structuredClone({format: doc.format, revision: doc.revision, objects: doc.objects ?? {}, enums: doc.enums ?? {}});
    }

    /**
     * Applies one change event; false when the copy cannot follow it and needs a new snapshot (a
     * created or deleted node or enum, an import, a resync, a gap).
     */
    apply(ev: MetaEvent): boolean {
        if (ev.revision <= this.doc.revision) return true; // seen already (a replay)
        if (ev.revision !== this.doc.revision + 1) return false;
        switch (ev.kind) {
            case 'object.updated':
                if (!ev.ref) return false;
                this.doc.objects[ev.ref] = (ev.value ?? {}) as MetaObject;
                break;
            case 'object.deleted':
                if (!ev.ref) return false;
                delete this.doc.objects[ev.ref];
                break;
            case 'node.updated': {
                // a rename or an icon: the node stays where it is
                const n = ev.path ? this.nodeAt(ev.path) : undefined;
                const v = ev.value as MetaNode | undefined;
                if (!n || !v) return false;
                if (v.name !== undefined) n.name = v.name;
                if ('icon' in v) {
                    if (v.icon === undefined || v.icon === null) delete n.icon;
                    else n.icon = v.icon;
                }
                break;
            }
            case 'node.moved': {
                // the node keeps its id; the member paths are rewritten (from → to), as the store did in the same revision
                if (!ev.from || !ev.to || !this.moveNode(ev.from, ev.to)) return false;
                for (const o of Object.values(this.doc.objects)) {
                    if (!o.enums) continue;
                    o.enums = o.enums.map((p) => (p === ev.from ? ev.to! : p.startsWith(ev.from + '/') ? ev.to + p.slice(ev.from!.length) : p));
                }
                break;
            }
            case 'enum.updated': {
                const e = ev.enum ? this.doc.enums[ev.enum] : undefined;
                const v = ev.value as MetaEnum | undefined;
                if (!e || !v) return false;
                if (v.name !== undefined) e.name = v.name;
                break;
            }
            default:
                return false;
        }
        this.doc.revision = ev.revision;
        return true;
    }

    get revision(): number {
        return this.doc.revision;
    }

    snapshot(): MetaDocument {
        return structuredClone(this.doc);
    }

    object(ref: string): MetaObject | undefined {
        return this.doc.objects[ref];
    }

    name(ref: string): string | undefined {
        return this.doc.objects[ref]?.name;
    }

    /** Every object that is a channel (its address has a colon), with its name. */
    channels(): {ref: string; interface: string; address: string; name?: string}[] {
        const out = [];
        for (const [ref, o] of Object.entries(this.doc.objects)) {
            const i = ref.indexOf('.');
            const address = ref.slice(i + 1);
            if (address.includes(':')) out.push({ref, interface: ref.slice(0, i), address, name: o.name});
        }
        return out.sort((a, b) => (a.ref < b.ref ? -1 : 1));
    }

    // ---- the trees --------------------------------------------------------------------------------

    private treeOf(enumId: string): MetaNode[] | undefined {
        const e = this.doc.enums[enumId];
        return e ? (e.tree ?? e.nodes ?? e.children ?? []) : undefined;
    }

    /** The node at a path (`room/eg/bad`), or undefined. */
    nodeAt(path: string): MetaNode | undefined {
        const [enumId, ...ids] = path.split('/');
        let list = this.treeOf(enumId);
        let node: MetaNode | undefined;
        for (const id of ids) {
            node = list?.find((n) => n.id === id);
            if (!node) return undefined;
            list = node.children;
        }
        return ids.length ? node : undefined;
    }

    /** Whether a path resolves: an enum, or a node in it. */
    hasPath(path: string): boolean {
        return path.includes('/') ? this.nodeAt(path) !== undefined : this.treeOf(path) !== undefined;
    }

    private parentList(path: string): MetaNode[] | undefined {
        const i = path.lastIndexOf('/');
        const parent = path.slice(0, i);
        return parent.includes('/') ? this.nodeAt(parent)?.children : this.treeOf(parent);
    }

    private moveNode(from: string, to: string): boolean {
        if (from === to) return true;
        const src = this.parentList(from);
        const node = src?.find((n) => n.id === from.slice(from.lastIndexOf('/') + 1));
        if (!src || !node) return false;
        const toParent = to.slice(0, to.lastIndexOf('/'));
        let dst: MetaNode[] | undefined;
        if (toParent.includes('/')) {
            const p = this.nodeAt(toParent);
            if (!p) return false;
            dst = p.children ??= [];
        } else {
            const e = this.doc.enums[toParent];
            if (!e) return false;
            dst = e.tree ??= e.nodes ?? e.children ?? [];
        }
        src.splice(src.indexOf(node), 1);
        node.id = to.slice(to.lastIndexOf('/') + 1);
        dst.push(node); // the position within the new siblings is not in the event: appended
        return true;
    }

    /** Every node of an enum as {path, id, name, depth}, in tree order. */
    private flat(enumId: string, lang?: string): NodeRef[] {
        const out: NodeRef[] = [];
        const walk = (list: MetaNode[] | undefined, prefix: string, depth: number) => {
            for (const n of list ?? []) {
                const path = `${prefix}/${n.id}`;
                out.push({path, id: n.id, name: label(n.name, lang) || n.id, depth});
                walk(n.children, path, depth + 1);
            }
        };
        walk(this.treeOf(enumId), enumId, 1);
        return out;
    }

    /** The nodes of an enum (room, function, ...), each with its members; with inherit, a node's
     *  members include those of its descendants (the format's subtree semantics). */
    nodes(enumId: string, opts: {inherit?: boolean; lang?: string} = {}): NodeInfo[] {
        const out: NodeInfo[] = this.flat(enumId, opts.lang).map((n) => ({path: n.path, id: n.id, name: n.name, refs: []}));
        if (!out.length) return out;
        for (const [ref, o] of Object.entries(this.doc.objects)) {
            for (const p of o.enums ?? []) {
                for (const n of out) {
                    if (n.path === p || (opts.inherit && p.startsWith(n.path + '/'))) n.refs.push(ref);
                }
            }
        }
        return out;
    }

    rooms(opts: {inherit?: boolean; lang?: string} = {}): NodeInfo[] {
        return this.nodes('room', opts);
    }

    functions(opts: {inherit?: boolean; lang?: string} = {}): NodeInfo[] {
        return this.nodes('function', opts);
    }

    /** The subtree query of the format spec: the refs of every object whose enums hold the path or
     *  a path below it (the enum's id alone: every object in that enum), sorted; `orphaned` filters
     *  on the flag. An unknown path is `unknown-path`, as on the API. */
    query(path: string, opts: {orphaned?: boolean} = {}): string[] {
        if (!this.hasPath(path)) throw new OccuLiteError('unknown-path', `no such path: ${path}`, {status: 422});
        const out: string[] = [];
        for (const [ref, o] of Object.entries(this.doc.objects)) {
            if (opts.orphaned !== undefined && (o.orphaned === true) !== opts.orphaned) continue;
            if ((o.enums ?? []).some((p) => p === path || p.startsWith(path + '/'))) out.push(ref);
        }
        return out.sort();
    }

    /** The nodes an object is in, per enum: with inherit (default true) the node and its ancestors,
     *  most specific first (then tree order) - what a program that showed ReGa's flat rooms wants -
     *  else the direct nodes only. Names by lang with the English fallback. */
    membership(ref: string, opts: {inherit?: boolean; lang?: string} = {}): {rooms: NodeRef[]; functions: NodeRef[]} {
        const paths = this.doc.objects[ref]?.enums ?? [];
        const inherit = opts.inherit !== false;
        const of = (enumId: string): NodeRef[] => {
            const flat = this.flat(enumId, opts.lang);
            const byPath = new Map(flat.map((n, order) => [n.path, {n, order}]));
            const found = new Map<string, {n: NodeRef; order: number}>();
            for (const p of paths) {
                if (!p.startsWith(enumId + '/')) continue;
                let cur = p;
                while (cur.includes('/')) {
                    const hit = byPath.get(cur);
                    if (hit && !found.has(cur)) found.set(cur, hit);
                    if (!inherit) break;
                    cur = cur.slice(0, cur.lastIndexOf('/'));
                }
            }
            return [...found.values()].sort((a, b) => b.n.depth - a.n.depth || a.order - b.order).map((x) => x.n);
        };
        return {rooms: of('room'), functions: of('function')};
    }

    /** The names of an object's rooms and functions, most specific first, each name once
     *  (node-red-contrib-ccu's memberNames). */
    membershipNames(ref: string, opts: {inherit?: boolean; lang?: string} = {}): {rooms: string[]; functions: string[]} {
        const m = this.membership(ref, opts);
        const names = (l: NodeRef[]) => [...new Set(l.map((n) => n.name))];
        return {rooms: names(m.rooms), functions: names(m.functions)};
    }

    // ---- the writes: the API's routes, through the client -------------------------------------------

    /** `/objects`: names, membership, meta. The copy follows through the change stream. */
    readonly objects = {
        /** PATCH: any subset of name, enums, meta (meta merged per namespace, null removes one) */
        patch: (ref: string, body: Partial<MetaObject>, opts: WriteOptions = {}): Promise<WriteResult> => this.run('PATCH', `/objects/${enc(ref)}`, body, opts),
        /** PUT: create or replace; absent optional fields go back to their defaults */
        put: (ref: string, body: MetaObject, opts: WriteOptions = {}): Promise<WriteResult> => this.run('PUT', `/objects/${enc(ref)}`, body, opts),
        delete: (ref: string, opts: WriteOptions = {}): Promise<WriteResult> => this.run('DELETE', `/objects/${enc(ref)}`, {}, opts),
        /** POST /objects:bulk: many patches and deletions as one revision, all or nothing */
        bulk: (body: {set?: Record<string, Partial<MetaObject>>; delete?: string[]}, opts: WriteOptions = {}): Promise<WriteResult> => this.run('POST', '/objects:bulk', {set: body.set ?? {}, delete: body.delete ?? []}, opts),
        /** PATCH {name} */
        rename: (ref: string, name: string, opts: WriteOptions = {}): Promise<WriteResult> => this.run('PATCH', `/objects/${enc(ref)}`, {name}, opts),
        /** PATCH {enums}: the object's paths with one added or removed (from the copy's current list) */
        assign: (ref: string, path: string, member: boolean, opts: WriteOptions = {}): Promise<WriteResult> => {
            const cur = this.doc.objects[ref]?.enums ?? [];
            const enums = member ? [...new Set([...cur, path])] : cur.filter((p) => p !== path);
            return this.run('PATCH', `/objects/${enc(ref)}`, {enums}, opts);
        },
    };

    /** `/enums`: the taxonomies themselves. */
    readonly enums = {
        create: (id: string, name: Record<string, string> | string, opts: WriteOptions = {}): Promise<WriteResult> => this.run('POST', '/enums', {id, name}, opts),
        update: (id: string, body: {name: Record<string, string> | string}, opts: WriteOptions = {}): Promise<WriteResult> => this.run('PATCH', `/enums/${enc(id)}`, body, opts),
        /** refused with has-members (detail.refs) while objects are in it, unless detach */
        delete: (id: string, opts: WriteOptions & {detach?: boolean} = {}): Promise<WriteResult> => this.run('DELETE', `/enums/${enc(id)}`, {}, {...opts, query: opts.detach ? {members: 'detach'} : undefined}),
        /** GET /enums: every enum with its tree, from the system */
        list: (opts: {signal?: AbortSignal} = {}): Promise<{revision: number; enums: Record<string, MetaEnum>}> => this.get('/enums', opts),
    };

    /** `/enums/{enum}/nodes/{path}`: the nodes of the trees. */
    readonly tree = {
        /** parent: a path, or null for a root node; position: the index among the new siblings */
        create: (enumId: string, body: {parent: string | null; id: string; name: string | Record<string, string>; icon?: string; position?: number}, opts: WriteOptions = {}): Promise<WriteResult> => this.run('POST', `/enums/${enc(enumId)}/nodes`, body, opts),
        /** any of name, icon, parent (a move; null = to the root), position */
        update: (path: string, body: {name?: string | Record<string, string>; icon?: string | null; parent?: string | null; position?: number}, opts: WriteOptions = {}): Promise<WriteResult> => this.run('PATCH', nodeUrl(path), body, opts),
        delete: (path: string, opts: WriteOptions & {detach?: boolean} = {}): Promise<WriteResult> => this.run('DELETE', nodeUrl(path), {}, {...opts, query: opts.detach ? {members: 'detach'} : undefined}),
    };

    /** PUT /import: a whole document, one revision, all or nothing; mode replace (default) or merge. */
    import(document: MetaDocument | string, opts: WriteOptions & {mode?: 'replace' | 'merge'; contentType?: string} = {}): Promise<WriteResult> {
        return this.run('PUT', '/import', document, {...opts, query: opts.mode ? {mode: opts.mode} : undefined, contentType: opts.contentType ?? (typeof document === 'string' ? 'application/yaml' : 'application/json')});
    }

    /** GET /export: the whole document as the system has it (json), or as YAML text. */
    export(opts?: {format?: 'json'; signal?: AbortSignal}): Promise<MetaDocument>;
    export(opts: {format: 'yaml'; signal?: AbortSignal}): Promise<string>;
    export(opts: {format?: 'json' | 'yaml'; signal?: AbortSignal} = {}): Promise<MetaDocument | string> {
        return this.get(`/export?format=${opts.format ?? 'json'}`, {signal: opts.signal, raw: opts.format === 'yaml'});
    }
}
