// The shapes the interface processes answer, typed once for every consumer (task 10): the
// listDevices description, the paramset description, and the service message of the system's view.
// Hand-written from the CCU's XML-RPC API documentation; every field beyond ADDRESS and TYPE is
// optional because a channel lacks a device's fields and the other way round, and an index
// signature takes what a process adds (hmipserver's, CUxD's). A list field (CHILDREN, PARAMSETS,
// TEAM_CHANNELS) is a string on some processes: read it with a guard.

/** One entry of `listDevices` (a device or a channel), as the interface process sends it. */
export interface DeviceDescription {
    /** `000A1B2C3D4E5F` for a device, `000A1B2C3D4E5F:4` for a channel */
    ADDRESS: string;
    /** the device type (`HmIP-PDT`) or the channel type (`DIMMER_VIRTUAL_RECEIVER`) */
    TYPE: string;
    /** the device's address on a channel; empty or absent on a device */
    PARENT?: string;
    /** the device's TYPE, on a channel */
    PARENT_TYPE?: string;
    /** the channel addresses, on a device */
    CHILDREN?: string[];
    /** the paramsets the entry has: `MASTER`, `VALUES`, `LINK` */
    PARAMSETS?: string[];
    /** bit field: 1 visible, 2 internal, 8 not deletable */
    FLAGS?: number;
    /** 0 none, 1 sender, 2 receiver */
    DIRECTION?: number;
    LINK_SOURCE_ROLES?: string;
    LINK_TARGET_ROLES?: string;
    /** the description's version, on a device */
    VERSION?: number;
    /** the firmware version, on a device (`1.2.0`) */
    FIRMWARE?: string;
    AVAILABLE_FIRMWARE?: string;
    FIRMWARE_UPDATE_STATE?: string;
    UPDATABLE?: boolean | number;
    /** bit field: 1 always, 2 burst, 4 config, 8 wakeup, 16 lazy config */
    RX_MODE?: number;
    /** the interface's own name for the device's interface (a LAN gateway's serial) */
    INTERFACE?: string;
    ROAMING?: boolean | number;
    RF_ADDRESS?: number;
    AES_ACTIVE?: boolean | number;
    /** the paired channel of a two-channel device, on a channel */
    GROUP?: string;
    /** the team (a smoke-detector or virtual team) the channel belongs to */
    TEAM?: string;
    TEAM_TAG?: string;
    TEAM_CHANNELS?: string[];
    /** the channel's index, on a channel */
    INDEX?: number;
    /** `CCU` for the radio module's own device, on HmIP */
    SUBTYPE?: string;
    [k: string]: unknown;
}

/** A value as a paramset carries it. */
export type ParamValue = boolean | number | string;

/** One entry of a `SPECIAL` list: a value with a meaning of its own (`NOT_USED`). */
export interface SpecialValue {
    ID: string;
    VALUE: ParamValue;
}

/** One parameter's description, as `getParamsetDescription` gives it. */
export interface ParamDescription {
    /** `BOOL`, `INTEGER`, `FLOAT`, `ENUM`, `STRING`, `ACTION` */
    TYPE: string;
    /** bit field: 1 read, 2 write, 4 event */
    OPERATIONS: number;
    /** bit field: 1 visible, 2 internal, 4 transform, 8 service, 16 sticky */
    FLAGS?: number;
    DEFAULT?: ParamValue;
    /** a number, or an enum name on HmIP */
    MIN?: ParamValue;
    /** a number, or an enum name on HmIP */
    MAX?: ParamValue;
    UNIT?: string;
    /** the parameter's own name, repeated */
    ID?: string;
    TAB_ORDER?: number;
    /** the WebUI's hint: `SWITCH.STATE`, `BUTTON.SHORT`, `NONE` */
    CONTROL?: string;
    SPECIAL?: SpecialValue[];
    /** an ENUM's names, in index order */
    VALUE_LIST?: string[];
    [k: string]: unknown;
}

/** A whole paramset description: parameter name → its description. */
export type ParamsetDescription = Record<string, ParamDescription>;

/** One service message of the system's view (`GET /api/system/v1/service-messages`): a maintenance
 *  datapoint active on a device's channel 0 - `UNREACH`, `LOWBAT`, `CONFIG_PENDING`, an `ERROR_*`
 *  code -, with when it started and how the system saw it start. */
export interface ServiceMessage {
    interface: string;
    /** the device's address */
    address: string;
    /** the channel the datapoint is on (`<address>:0`) */
    channel: string;
    /** the datapoint: `UNREACH`, `LOWBAT`, `SABOTAGE`, `ERROR_CODE`, … */
    key: string;
    /** the active value: true, a code, a text */
    value: unknown;
    /** RFC 3339: when it became active - or, for `seen: 'start'`, at least since */
    since: string;
    /** `event` when the system watched it happen, `start` when a sweep found it active */
    seen: 'event' | 'start' | string;
    /** the device's type, when known */
    type?: string;
    /** the device's name from the metadata store, when there is one */
    name?: string;
    /** the device's enum paths (rooms, functions) from the metadata store */
    enums?: string[];
    [k: string]: unknown;
}

/** The service-message view. */
export interface ServiceMessageView {
    count: number;
    /** the oldest first */
    messages: ServiceMessage[];
    /** when the last sweep ran (RFC 3339; the zero time `0001-01-01T00:00:00Z` before the first) */
    swept: string;
    /** the interfaces that did not answer the sweep, with the error (their entries are kept) */
    errors: Record<string, string>;
    /** the system's view of its RPC process (`GET /radio/health`'s `feed`), when it has one */
    feed?: unknown;
    [k: string]: unknown;
}
