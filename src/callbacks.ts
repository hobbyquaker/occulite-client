// The callback compatibility module (task 196): the stream's events as the method calls
// homematic-xmlrpc's and binrpc's callback servers emit - `event`, `system.multicall`,
// `newDevices`, `deleteDevices`, `updateDevice`, `replaceDevice`, `readdedDevice` - with the same
// argument lists and a no-op callback, so a consumer's rpcMethods/METHODS table feeds from the
// stream unchanged. It supersedes homematic-xmlrpc task 1's createEventStream.

import type {OccuLite, ValueEvent} from './client.ts';
import {parseRef} from './refs.ts';

type Callback = (err: Error | null, params: unknown[], cb: (err: unknown, res: unknown) => void) => void;

export interface CallbackServer {
    on(method: string, fn: Callback): void;
    close(): void;
}

const noop = () => {};

/** initIds: the id per interface the consumer would have passed to init (its first argument back). */
export function callbackEvents(box: OccuLite, opts: {initIds: Record<string, string>; batches?: boolean}): CallbackServer {
    const fns = new Map<string, Callback[]>();
    const call = (method: string, params: unknown[]) => {
        for (const f of fns.get(method) ?? []) f(null, params, noop);
    };
    const id = (iface: string) => opts.initIds[iface] ?? iface;
    const offs: (() => void)[] = [];
    // a batch as one system.multicall (hmipserver's and rfd's shape), a single event as event
    if (opts.batches !== false) {
        offs.push(
            box.on('batch', (evs: ValueEvent[]) => {
                call('system.multicall', [evs.map((e) => ({methodName: 'event', params: [id(e.interface), e.address, e.key, e.value]}))]);
            }),
        );
    }
    offs.push(
        box.on('value', (e: ValueEvent) => {
            if (e.batch && opts.batches !== false) return; // the multicall carries it
            if (e.source === 'sweep' || e.source === 'restored') return; // a state confirmation is no device event
            call('event', [id(e.interface), e.address, e.key, e.value]);
        }),
    );
    offs.push(
        box.on('devices', (ev: {kind: string; interface: string; refs: string[]; descriptions?: unknown[]}) => {
            const addrs = ev.refs.map((r) => parseRef(r).address);
            switch (ev.kind) {
                case 'new':
                    call('newDevices', [id(ev.interface), ev.descriptions ?? []]);
                    break;
                case 'deleted':
                    call('deleteDevices', [id(ev.interface), addrs]);
                    break;
                case 'updated':
                    call('updateDevice', [id(ev.interface), addrs[0], 0]);
                    break;
                case 'replaced':
                    call('replaceDevice', [id(ev.interface), addrs[0], addrs[1]]);
                    break;
                case 'readded':
                    call('readdedDevice', [id(ev.interface), addrs]);
                    break;
            }
        }),
    );
    return {
        on(method, fn) {
            let l = fns.get(method);
            if (!l) fns.set(method, (l = []));
            l.push(fn);
        },
        close() {
            for (const off of offs) off();
        },
    };
}
