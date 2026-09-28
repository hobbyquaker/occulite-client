// The callback compatibility module (task 196): the stream's events as the method calls
// homematic-xmlrpc's and binrpc's callback servers emit - `event`, `system.multicall`,
// `newDevices`, `deleteDevices`, `updateDevice`, `replaceDevice`, `readdedDevice` - with the same
// argument lists and a no-op callback, so a consumer's rpcMethods/METHODS table feeds from the
// stream unchanged. It supersedes homematic-xmlrpc task 1's createEventStream.
//
// The argument lists, as the CCU's interface processes send them (params is always an array):
//   event            [initId, address, key, value]
//   system.multicall [[{methodName: 'event', params: [initId, address, key, value]}, ...]]
//   newDevices       [initId, descriptions]           the descriptions, as listDevices gives them
//   deleteDevices    [initId, addresses]
//   updateDevice     [initId, address, hint]           hint is 0: the stream carries none (yet)
//   replaceDevice    [initId, oldAddress, newAddress]
//   readdedDevice    [initId, addresses]
//   interface        [initId, interface, state]        synthetic, only with interfaceEvents: true
// Never emitted: listDevices (the system does not ask a client for its device list), init,
// setReadyConfig, system.listMethods - a consumer's handlers for them stay for its CCU path.

import type {OccuLite, ValueEvent} from './client.ts';
import {parseRef} from './refs.ts';

type Callback = (err: Error | null, params: unknown[], cb: (err: unknown, res: unknown) => void) => void;

export interface CallbackServer {
    on(method: string, fn: Callback): void;
    close(): void;
}

export interface CallbackOptions {
    /** the id per interface the consumer would have passed to init (its first argument back) */
    initIds?: Record<string, string>;
    /** the id for an interface not in initIds: a string for all, or derived per interface - the
     *  consumers' shapes are `nr_<6 chars>_<iface>`, `mb_<iface>`, `hm2mqtt_hm_<iface>`; default the
     *  interface name */
    initId?: string | ((iface: string) => string);
    /** a batch as one system.multicall (default true); false: every event as a single `event` */
    batches?: boolean;
    /** also emit the synthetic `interface` method on interface state changes (default false) */
    interfaceEvents?: boolean;
}

const noop = () => {};

/** The stream's events as the callback server's method calls. */
export function callbackEvents(box: OccuLite, opts: CallbackOptions = {}): CallbackServer {
    const fns = new Map<string, Callback[]>();
    const call = (method: string, params: unknown[]) => {
        for (const f of fns.get(method) ?? []) f(null, params, noop);
    };
    const id = (iface: string) => opts.initIds?.[iface] ?? (typeof opts.initId === 'function' ? opts.initId(iface) : (opts.initId ?? iface));
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
    if (opts.interfaceEvents) {
        offs.push(box.on('interface', (ev: {interface: string; state: string}) => call('interface', [id(ev.interface), ev.interface, ev.state])));
    }
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
