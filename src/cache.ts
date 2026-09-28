// The description cache (task 196, task 5): paramset descriptions keyed the way node-red-contrib-ccu,
// hm2mqtt.js and matterbridge-homematic key their files - interface/TYPE/FIRMWARE/VERSION/channel
// type/paramset - so their existing files seed it, plus the metadata snapshot under meta/snapshot,
// so names are there before the system answers. memoryCache() here; fileCache() in occulite-client/node.

/** What a cache stores: paramset descriptions, and the metadata snapshot under `meta/snapshot`. */
export interface DescriptionCache {
    get(key: string): Promise<unknown | undefined> | unknown | undefined;
    set(key: string, value: unknown): Promise<void> | void;
}

/** The default: a Map for the process's lifetime. */
export function memoryCache(): DescriptionCache & {readonly size: number} {
    const m = new Map<string, unknown>();
    return {
        get: (k) => m.get(k),
        set: (k, v) => void m.set(k, v),
        get size() {
            return m.size;
        },
    };
}

/** The key of a channel's (or device's) paramset description: `iface/TYPE/FIRMWARE/VERSION/chType/paramset`
 *  - the device's TYPE, FIRMWARE and VERSION, the channel's TYPE (empty for the device itself), and
 *  the paramset's name with a link paramset (a peer address) as LINK. node-red-contrib-ccu's
 *  paramsets.json, hm2mqtt.js's and matterbridge-homematic's files use exactly this. */
export function descriptionKey(iface: string, device: Record<string, unknown>, channel: Record<string, unknown> | undefined, paramset: string): string {
    const ps = /[\da-f]+:\d+/i.test(paramset) ? 'LINK' : paramset; // the consumers' test: an address with a channel
    const s = (v: unknown) => (v === undefined || v === null ? '' : String(v));
    return `${iface}/${s(device.TYPE)}/${s(device.FIRMWARE)}/${s(device.VERSION)}/${channel ? s(channel.TYPE) : ''}/${ps}`;
}

export const META_SNAPSHOT_KEY = 'meta/snapshot';
