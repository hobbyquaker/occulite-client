// The metadata API's live copy (docs/meta-api.md, docs/meta-format.md): the snapshot at connect,
// object events applied in place from the change stream, and a fresh snapshot for anything else
// (an enum or node change, an import, a resync, a revision gap). Queries by ref; writes go to the
// API and come back through the stream.

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
    [k: string]: unknown;
}

/** A node with its path, for the rooms and functions lists. */
export interface NodeInfo {
    path: string;
    id: string;
    name: string;
    refs: string[];
}

function label(n: string | Record<string, string> | undefined, lang = 'en'): string {
    if (!n) return '';
    if (typeof n === 'string') return n;
    return n[lang] ?? n.en ?? Object.values(n)[0] ?? '';
}

export class MetaCopy {
    doc: MetaDocument = {format: 1, revision: 0, objects: {}, enums: {}};

    /** Replaces the copy with a snapshot. */
    load(doc: MetaDocument): void {
        this.doc = {format: doc.format, revision: doc.revision, objects: doc.objects ?? {}, enums: doc.enums ?? {}};
    }

    /**
     * Applies one change event; false when the copy cannot follow it and needs a new snapshot (a
     * node or enum change, an import, a resync, a gap).
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

    /** The nodes of an enum (room, function, ...), each with its members; with inherit, a node's
     *  members include those of its descendants (the format's subtree semantics). */
    nodes(enumId: string, opts: {inherit?: boolean; lang?: string} = {}): NodeInfo[] {
        const e = this.doc.enums[enumId];
        if (!e) return [];
        const out: NodeInfo[] = [];
        const walk = (list: MetaNode[] | undefined, prefix: string) => {
            for (const n of list ?? []) {
                const path = `${prefix}/${n.id}`;
                out.push({path, id: n.id, name: label(n.name, opts.lang), refs: []});
                walk(n.children, path);
            }
        };
        walk(e.nodes ?? e.children, enumId);
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

    /** The names of the rooms and functions an object is directly in. */
    membership(ref: string, lang?: string): {rooms: string[]; functions: string[]} {
        const paths = this.doc.objects[ref]?.enums ?? [];
        const names = (enumId: string) =>
            this.nodes(enumId, {lang})
                .filter((n) => paths.includes(n.path))
                .map((n) => n.name);
        return {rooms: names('room'), functions: names('function')};
    }
}
