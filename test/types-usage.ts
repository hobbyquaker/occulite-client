// A consumer-shaped usage of the package's types, compiled by `npm run check` (tsconfig.test.json) and never run:
// what homematic-manager's trust dialog and device grid, matterbridge-homematic's channel list and hm2mqtt.js's
// value cache read from the client has to type-check without a cast (task 10).
import type {DeviceDescription, OccuLite, OccuLiteError, ParamsetDescription, ServiceMessage} from '../src/index.ts';
import type {ProbeResult} from '../src/node/index.ts';

export function channelsOf(box: OccuLite, device: string): DeviceDescription[] {
    const dev = box.devices.get(device);
    const children: string[] = Array.isArray(dev?.CHILDREN) ? dev.CHILDREN : [];
    return children.map((a) => box.devices.get(`${dev!.INTERFACE ?? 'HmIP-RF'}.${a}`)).filter((d): d is DeviceDescription => d !== undefined);
}

export function cacheKey(d: DeviceDescription): string {
    // TYPE and ADDRESS are always there; FIRMWARE and VERSION on a device only
    return `${d.TYPE}/${d.FIRMWARE ?? ''}/${d.VERSION ?? ''}/${d.ADDRESS}`;
}

export async function writable(box: OccuLite, ref: string): Promise<string[]> {
    const desc: ParamsetDescription = await box.paramsetDescription(ref);
    return Object.entries(desc)
        .filter(([, p]) => (p.OPERATIONS & 2) !== 0 && p.TYPE !== 'ACTION')
        .map(([k, p]) => `${k} ${p.UNIT ?? ''} ${p.MIN ?? ''}..${p.MAX ?? ''} ${p.VALUE_LIST?.join('|') ?? ''}`);
}

export function alarmLine(m: ServiceMessage): string {
    return `${m.name ?? `${m.type ?? ''} ${m.address}`}: ${m.key} since ${m.since}${m.seen === 'start' ? ' (at least)' : ''}`;
}

/** homematic-manager's trust block: the leaf to pin, the CA to trust. */
export function trustBlock(r: ProbeResult): {pin?: string; ca?: {subject: string; pem: string}; names?: string} | undefined {
    if (!r.certificate) return undefined;
    return {pin: r.certificate.fingerprint256, names: r.certificate.altNames, ca: r.ca ? {subject: r.ca.subject ?? '', pem: r.ca.pem} : undefined};
}

export function trustFromError(e: OccuLiteError): string | undefined {
    if (e.code !== 'certificate') return undefined;
    return e.ca?.pem ?? e.certificate?.fingerprint256;
}
