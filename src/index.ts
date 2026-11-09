// occulite-client: one client for openccu-lite's APIs (openccu-lite task 196). The platform-neutral
// part; occulite-client/node adds the pinned https transport, probe() and pair().
export {OccuLite, REQUEST_HEADER, SPEAKS, type Auth, type AuthProvider, type Capabilities, type Credential, type DevicesEvent, type Mode, type HmipInfo, type Info, type InterfaceInfo, type Options, type Status, type SweepResult, type Value, type ValueEvent} from './client.ts';
export {META_SNAPSHOT_KEY, descriptionKey, memoryCache, type DescriptionCache} from './cache.ts';
export {OccuLiteError, abortError, httpError, type CertificateInfo} from './errors.ts';
export {GROUPS_TIMEOUT, SystemAPI, type CallOptions, type GroupMember, type HeatingGroup, type HeatingGroupDetail, type HeatingGroupList, type HeatingGroupType, type HistoryList, type RadioHealth, type RadioInterfaceHealth, type RadioSample, type RpcFeed, type StatusInfo, type SystemHost} from './system.ts';
export type {DeviceDescription, ParamDescription, ParamValue, ParamsetDescription, ServiceMessage, ServiceMessageView, SpecialValue} from './types.ts';
export {MetaCopy, type MetaDocument, type MetaEnum, type MetaErrorCode, type MetaEvent, type MetaNode, type MetaObject, type MetaWriter, type NodeInfo, type NodeRef, type WriteOptions, type WriteResult} from './meta.ts';
export {SCOPE_INCLUDES, covers, normalizeScopes} from './scopes.ts';
export {datapointRef, deviceOf, parseDatapointRef, parseRef, ref} from './refs.ts';
export {parseSSE, type SSEMessage} from './sse.ts';
export {fetchTransport, type Transport, type TransportResponse} from './transport.ts';
