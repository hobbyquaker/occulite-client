// The system API's slice the consumers use (task 196, task 9): the heating groups (Homematic
// Manager's groups editor, node-red-contrib-ccu's groups file), the service messages with their
// stream, the radio health (hm2mqtt.js's duty cycle) and the status - typed, thin, each route of
// occulited's docs/system-api.md as it is. Everything else goes through box.request(). Every method
// rejects `unsupported` when the connected system offers no system API, and `forbidden` naming
// system:read or system:write when the credential lacks it (the API's own answer).

import type {OccuLiteError} from './errors.ts';
import type {ServiceMessageView} from './types.ts';

/** A device as the group pages know it: hmipserver's id for it (the address on openccu-lite), its serial and type. */
export interface GroupMember {
    id: string;
    serial: string;
    type: string;
}

/** One heating group as `GET /groups` lists it. */
export interface HeatingGroup {
    id: number;
    name: string;
    /** `HomeMatic.heating` (BidCos, `HM-CC-VG-1`) or `hmip.heating.group` */
    type: string;
    /** the type's label (`Heating_Control`, `HmIP-Heizungssteuerung`) */
    type_label: string;
    /** the group device's address on VirtualDevices (`INT0000001`) */
    device: string;
    /** its metadata ref (`VirtualDevices.INT0000001`) */
    ref: string;
}

/** A group type the editor offers, with the devices a new group of it could take. */
export interface HeatingGroupType {
    id: string;
    label: string;
    assignable: GroupMember[];
    /** the devices that fit no group any more */
    leftover: GroupMember[];
}

/** One group in full, as `GET /groups/{id}` and every write answer it. */
export interface HeatingGroupDetail {
    id: number;
    name: string;
    type: string;
    device: string;
    ref: string;
    /** the group device's name hmipserver stores (`<name> INT000000N`) */
    device_name: string;
    /** the WebUI's "operate as group only" */
    forbid_single_operation: boolean;
    members: GroupMember[];
    assignable: GroupMember[];
    leftover: GroupMember[];
    types: {id: string; label: string}[];
    /** after a write: the members whose configuration is still pending (show them, nothing to do) */
    devices_to_configure?: GroupMember[];
}

export interface HeatingGroupList {
    groups: HeatingGroup[];
    devices_to_configure: GroupMember[];
}

/** One radio interface's health, from `listBidcosInterfaces`. */
export interface RadioInterfaceHealth {
    /** `BidCos-RF`, `HmIP-RF` */
    interface: string;
    /** the module's or gateway's address (an HmIP SGTIN, a BidCos serial) */
    address: string;
    type: string;
    description?: string;
    connected: boolean;
    default: boolean;
    firmware?: string;
    /** percent of the hourly airtime budget used; -1 when the interface reports none */
    duty_cycle: number;
    /** `CARRIER_SENSE_LEVEL` in whole percent, when known (0 included) */
    carrier_sense?: number;
    /** where it came from: `interface`, `device`, `event` */
    carrier_sense_source?: string;
    /** which physical radio the entry is (entries with one key are one radio) */
    radio?: string;
    radio_name?: string;
    [k: string]: unknown;
}

/** One sample of the health history. */
export interface RadioSample {
    /** RFC 3339 */
    t: string;
    /** duty cycle, percent */
    dc: number;
    /** carrier sense, percent, when reported */
    cs?: number;
    /** connected */
    up: boolean;
}

/** `GET /radio/health`. */
export interface RadioHealth {
    /** when the last sample was taken, RFC 3339 */
    polled: string;
    interfaces: RadioInterfaceHealth[];
    /** the interface processes that answered without a radio list (hs485d, CUxD): up, nothing to sample */
    answering: string[];
    /** the processes that did not answer, with the error */
    errors: Record<string, string>;
    /** `<interface>/<address>` → the last 500 samples, oldest first */
    history: Record<string, RadioSample[]>;
    /** any duty cycle at or over 80 % */
    busy: boolean;
    busy_interface?: string;
    /** the radio stack's units, on a systemd system */
    units?: {unit: string; interfaces: string[]; active_state: string; sub_state: string; starting?: boolean; queued?: boolean; starting_s?: number}[];
    /** the system's view of its own RPC process */
    feed?: RpcFeed;
    [k: string]: unknown;
}

/** The system's RPC process as it sees it (`feed` of the radio health and the service messages). */
export interface RpcFeed {
    connected: boolean;
    boot_id?: string;
    since?: string;
    last_error?: string;
    /** events received since the process started */
    received: number;
    interfaces: {name: string; url?: string; state: 'up' | 'down' | 'silent' | string; registered: boolean; last_activity?: string; last_init?: string; last_error?: string; events: number; calls?: number; [k: string]: unknown}[];
    [k: string]: unknown;
}

/** `GET /status`: the landing page's summary. */
export interface StatusInfo {
    hostname: string;
    version: {
        /** the OpenCCU base version (`3.89.11.20260919`) */
        version: string;
        product: string;
        platform: string;
        variant?: string;
        /** openccu-lite's own version (`1.0.0-dev.30`) */
        lite?: string;
    };
    /** occulited's build (the commit; `-hot` for a hot-deployed binary), when the binary carries one */
    occulited_version?: string;
    uptime_s: number;
    load: number[];
    mem_total_kb: number;
    mem_available_kb: number;
    disks: {mount: string; total_kb: number; used_kb: number}[];
    /** the system's clock, RFC 3339 */
    time: string;
    /** the zone name (`Europe/Berlin`) */
    timezone: string;
    tz?: string;
    hm_mode: string;
    meta_recovered?: boolean;
    unclean_shutdown?: {at: string};
    /** `lxc` or `oci` when the system is a container */
    container?: string;
    /** the boot's clock gate: `rtc`, `ntp` or `timeout`, and whether the clock is synchronised now */
    clock?: {state: string; synchronised: boolean};
    [k: string]: unknown;
}

/** `GET /datastore/history`: the datapoints the system records. */
export interface HistoryList {
    /** what is recorded now: name → `sampled` or `event` */
    datapoints: Record<string, 'sampled' | 'event' | string>;
    /** the built-in set */
    defaults: string[];
    add: string[];
    remove: string[];
    /** series kept */
    series: number;
    /** reports the series cap turned away */
    capped: number;
    rows_per_series: number;
    max_series: number;
}

/** What the slice needs of the client. */
export interface SystemHost {
    request<T>(method: string, path: string, body?: unknown, opts?: {signal?: AbortSignal; timeout?: number}): Promise<T>;
    readonly capabilities: {apis?: Record<string, number>};
    unsupportedError(what: string): OccuLiteError;
}

export interface CallOptions {
    signal?: AbortSignal;
    timeout?: number;
}

const P = '/api/system/v1';

/** hmipserver answers a group command in well under a second, but an XML-RPC init on VirtualDevices
 *  can hold its event loop for 10 s and the API gives each command 30 s: a group write waits 45 s. */
export const GROUPS_TIMEOUT = 45000;

export class SystemAPI {
    private readonly host: SystemHost;

    constructor(host: SystemHost) {
        this.host = host;
    }

    /** `unsupported` before a request when the connected system offers no system API (its
     *  capabilities are known and name none); a system not yet connected is asked. */
    private guard(): void {
        const apis = this.host.capabilities.apis;
        if (apis && apis.system === undefined) throw this.host.unsupportedError('this system offers no system API');
    }

    private async get<T>(path: string, o: CallOptions = {}): Promise<T> {
        this.guard();
        return this.host.request<T>('GET', P + path, undefined, o);
    }

    /** `GET /status`: hostname, versions, uptime, load, memory, disks, time zone, radio mode. */
    status(o: CallOptions = {}): Promise<StatusInfo> {
        return this.get('/status', o);
    }

    /** `GET /radio/health`: every radio interface's duty cycle and carrier sense, sampled by the
     *  system once a minute with its history - what a program polled `listBidcosInterfaces` for. */
    radioHealth(o: CallOptions = {}): Promise<RadioHealth> {
        return this.get('/radio/health', o);
    }

    /** `GET /service-messages`: the active maintenance datapoints with `since` and `seen`, the oldest
     *  first, each device with its name and enums from the metadata store. The stream is
     *  `box.on('serviceMessages', view => …)`. */
    serviceMessages(o: CallOptions = {}): Promise<ServiceMessageView> {
        return this.get('/service-messages', o);
    }

    /** The heating groups: hmipserver's group devices (`INT000000N` on VirtualDevices), through the
     *  system. Errors: `unknown-group` (404), `invalid` (422, the field named), `hmipserver` (502: it
     *  did not answer or refused; a failed save is undone by the system), `unsupported` (501: no
     *  hmipserver here), `forbidden` naming `system:read`/`system:write`. */
    readonly groups = {
        list: (o: CallOptions = {}): Promise<HeatingGroupList> => this.get('/groups', o),
        types: (o: CallOptions = {}): Promise<HeatingGroupType[]> => this.get<{types: HeatingGroupType[]}>('/groups/types', o).then((r) => r.types ?? []),
        get: (id: number, o: CallOptions = {}): Promise<HeatingGroupDetail> => this.get(`/groups/${encodeURIComponent(id)}`, o),
        /** `members` are hmipserver's ids (`GroupMember.id`, the device address on openccu-lite) */
        create: (group: {name: string; type: string; members: string[]; forbid_single_operation?: boolean}, o: CallOptions = {}): Promise<HeatingGroupDetail> => this.write('POST', '/groups', group, {timeout: GROUPS_TIMEOUT, ...o}),
        /** the name and the members as a whole (adding one = the whole new list); a field left out keeps its value */
        update: (id: number, patch: {name?: string; members?: string[]; forbid_single_operation?: boolean}, o: CallOptions = {}): Promise<HeatingGroupDetail> => this.write('PUT', `/groups/${encodeURIComponent(id)}`, patch, {timeout: GROUPS_TIMEOUT, ...o}),
        remove: (id: number, o: CallOptions = {}): Promise<{deleted: number; former_members: GroupMember[]}> => this.write('DELETE', `/groups/${encodeURIComponent(id)}`, {}, {timeout: GROUPS_TIMEOUT, ...o}),
    };

    /** The datapoint history's list: what the system records (`GET /datastore/history`), and
     *  `{add, remove}` for a program that wants more datapoints drawn (`PUT`, kept by the system). */
    readonly datastore = {
        history: (change?: {add?: string[]; remove?: string[]}, o: CallOptions = {}): Promise<HistoryList> => (change ? this.write('PUT', '/datastore/history', {add: change.add ?? [], remove: change.remove ?? []}, o) : this.get('/datastore/history', o)),
    };

    /** A write carries a body always - `{}` for a DELETE: lighttpd's mod_proxy answers 411 to a body-less one. */
    private async write<T>(method: string, path: string, body: unknown, o: CallOptions): Promise<T> {
        this.guard();
        return this.host.request<T>(method, P + path, body ?? {}, o);
    }
}
