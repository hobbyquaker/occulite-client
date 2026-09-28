// occulite-client: one client for openccu-lite's APIs (openccu-lite task 196). The platform-neutral
// part; occulite-client/node adds the pinned https transport, probe() and pair().
export {OccuLite, REQUEST_HEADER, SPEAKS, type Auth, type AuthProvider, type Capabilities, type Credential, type Mode, type Info, type InterfaceInfo, type Options, type Status, type Value, type ValueEvent} from './client.ts';
export {OccuLiteError, type CertificateInfo} from './errors.ts';
export {MetaCopy, type MetaDocument, type MetaEvent, type MetaObject, type NodeInfo} from './meta.ts';
export {datapointRef, deviceOf, parseDatapointRef, parseRef, ref} from './refs.ts';
export {parseSSE, type SSEMessage} from './sse.ts';
export {fetchTransport, type Transport, type TransportResponse} from './transport.ts';
