// Refs, the metadata API's vocabulary (docs/meta-format.md): a device or channel is
// <interface>.<address> - the first dot separates - and a datapoint is its ref plus .KEY.

export interface Ref {
    interface: string;
    address: string;
    key?: string;
}

/** A channel's or device's ref. */
export function ref(iface: string, address: string): string {
    return `${iface}.${address}`;
}

/** A datapoint's ref: interface.address.KEY. */
export function datapointRef(iface: string, address: string, key: string): string {
    return `${iface}.${address}.${key}`;
}

/** Splits a device/channel ref (no key). */
export function parseRef(r: string): Ref {
    const i = r.indexOf('.');
    if (i <= 0 || i === r.length - 1) throw new TypeError(`not a ref: ${r}`);
    return {interface: r.slice(0, i), address: r.slice(i + 1)};
}

/** Splits a datapoint ref: the key is after the last dot, the interface before the first. */
export function parseDatapointRef(r: string): Ref & {key: string} {
    const i = r.indexOf('.');
    const j = r.lastIndexOf('.');
    if (i <= 0 || j <= i || j === r.length - 1) throw new TypeError(`not a datapoint ref: ${r}`);
    return {interface: r.slice(0, i), address: r.slice(i + 1, j), key: r.slice(j + 1)};
}

/** The device of a channel address: the part before the colon. */
export function deviceOf(address: string): string {
    const i = address.indexOf(':');
    return i < 0 ? address : address.slice(0, i);
}
