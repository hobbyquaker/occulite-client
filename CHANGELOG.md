# Changelog

## 0.3.0 / 2026-10-02

- `httpError(status, body)` and `abortError(signal, what)` are exported from the package root: an adapter maps and
  tests the client's errors without building `OccuLiteError`s by hand.
- `FakeBox.dropMetaStreams()` ends the metadata change streams (a consumer's reconnect test reached into a private
  field), `metaStreamsOpen` counts them.
- Every request carries `Accept: application/json` (the streams `text/event-stream`, as before): a proxy in front of
  the system that negotiates by it answers JSON, not HTML.
- The `callbacks` module passes `updateDevice`'s `hint` as the interface process sent it (0 unspecified, 1 the links
  changed, 2 the description changed) and `replaceDevice`'s old and new address as the stream names them (`old`/`new`,
  since openccu-lite's daemon carries them); from an older system the hint is 0 and the addresses keep their order. The
  `devices` event carries `hint`, `old` and `new` (`DevicesEvent`, exported); `FakeBox.updateDevice()` and
  `FakeBox.replaceDevice()` emit them.

## 0.2.0 / 2026-09-29

What the consumers' ports need (hm2mqtt.js, node-red-contrib-ccu, matterbridge-homematic, homematic-manager): timeouts
and credentials that work unattended, interfaces that come late, every value, a description cache, the metadata API
complete, the system API's slice, typed descriptions and certificates, and the porting guide `docs/porting.md`.

### Breaking changes against 0.1.0

- `box.interfaces` is `InterfaceInfo[]` (`{name, protocol, url_path, running}`), no longer `string[]`; the names are
  `box.interfaces.map((i) => i.name)`.
- `box.meta.membership(ref, opts)` answers the nodes (`{rooms: NodeRef[], functions: NodeRef[]}`, each
  `{path, id, name, depth}`, most specific first, ancestors included), and its second argument is an options object
  (`{inherit, lang}`) instead of a `lang` string. 0.1.0's names-only answer is `membershipNames(ref, opts)`.
- `box.rename()` and `box.assign()` answer `{revision, changed}` (a `304` as `changed: false`).
- `trust.ca` is trusted beside Node's default authorities, and as a partial chain; in 0.1.0 it replaced them.
- Without an `interfaces` option, the event stream and the state read carry no interface filter (a later interface is
  followed); `ready()` waits for the device lists of running interfaces only.
- Requests time out (`timeout`, default 30 s; `probe()` 5 s): a system that accepts a connection and does not answer
  rejects `timeout`, or is `unreachable` with `reason: 'timeout'` for `probe()`, where 0.1.0 waited without end; an
  aborted request rejects `aborted`.
- Every request carries `X-Occulite-Request: 1` (openccu-lite refuses a cookie-only write without it).

### Changes

- **`docs/porting.md` complete:** the worked example (hm2mqtt.js's structure before and after its port, `backend/lite.js`
  in outline), *`box.values` is not every datapoint* and the sweep (the draft's *no sweep at start* row was wrong),
  the `callbacks` module's argument lists and what it never emits, the four credentials and the tiers a method needs
  (an unknown method needs *administer*), the two streams per token, detection (*a timeout is never a CCU*,
  `probeUntil`), the system slice in the HM-Script and homematic-rega tables, reverse proxies, a CHANGELOG checklist
  of what changes for a consumer's users, and the CommonJS note (`require(esm)`, load it lazily). A test
  `require()`s the built `dist` from a `.cjs` file (every entry point).

- **The system API's slice, `box.system`** (typed, thin): `status()`, `radioHealth()`, `serviceMessages()`,
  `groups.list/types/get/create/update/remove` (a write waits `GROUPS_TIMEOUT`, 45 s; a DELETE carries `{}`),
  `datastore.history()` and `datastore.history({add, remove})`; every method rejects `unsupported` without a request
  when the system's capabilities name no system API, and `forbidden` naming `system:read`/`system:write` as the API
  does. The **`serviceMessages` event** carries the view from `GET /api/system/v1/service-messages/stream`, a stream
  opened with the first handler and closed with the last (the token's stream limit), reopened with the backoff; a
  refused credential or a system without the route ends it with one `error` event. The types `StatusInfo`,
  `RadioHealth`, `RadioInterfaceHealth`, `RadioSample`, `RpcFeed`, `HeatingGroup`, `HeatingGroupDetail`,
  `HeatingGroupType`, `GroupMember`, `HistoryList` are exported. `FakeBox` serves the routes with fixtures and an
  in-memory group store (`status`, `radioHealth`, `serviceMessages` with `setServiceMessages()`, `groups`,
  `groupTypes`, `systemApi: false` for a system without the API, `systemRequests`, `serviceStreamsOpened`).

- **Types:** `DeviceDescription` (the `listDevices` entry), `ParamsetDescription`/`ParamDescription`,
  `ParamValue`, `SpecialValue`, `ServiceMessage`/`ServiceMessageView` exported from the root; `box.devices` is
  `Map<string, DeviceDescription>`, `paramsetDescription()` answers a `ParamsetDescription`. `Info` gained `format` and a
  typed `hmip`; `probe()`'s `info` is typed.
- **Certificates:** over `https` the Node transport takes every connection over its own TLS socket and judges the
  certificate by hand (Node's path dropped the socket before anything about an untrusted certificate could be read), so
  a `certificate` error carries the leaf (`certificate`, now with `altNames`, `ca` and `pem`), the **`chain`** as sent
  and the **`ca`** to offer - the topmost authority in the chain, with its PEM - and `reason` is `pin` or Node's code
  (`DEPTH_ZERO_SELF_SIGNED_CERT`, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, `ERR_TLS_CERT_ALTNAME_INVALID`, …). `trust.ca`
  is trusted beside Node's defaults (it replaced them before) and as a partial chain (an issuing CA alone). `probe()`
  returns `certificate`, `chain` and `ca` for every `https` answer; `nodeTransport()` has `lastCertificate()`,
  `lastChain()`, `lastCA()`; `describeCertificate()` and `toPEM()` are exported from `occulite-client/node`.
  `npm run check` also compiles the tests and a consumer-shaped usage of the types (`tsconfig.test.json`).

- The metadata API complete on `box.meta`: `objects.patch/put/delete/bulk/rename/assign`,
  `enums.create/update/delete/list`, `tree.create/update/delete`, `import(document, {mode})`, `export({format})` -
  every write answers `{revision, changed}` (a `304` as `changed: false`), takes `{ifMatch}` (→ `revision-conflict`),
  a DELETE carries `{}`; the API's error codes typed (`MetaErrorCode`). `membership(ref, {inherit = true, lang})`
  answers the nodes (`{path, id, name, depth}`) most specific first, ancestors included; `membershipNames()` the
  names, each once (what `membership()` answered in 0.1.0); `query(path, {orphaned})` is the format's subtree query;
  `nodeAt()`, `hasPath()`. The copy applies `node.moved` (member paths rewritten), `node.updated` and `enum.updated`
  in place. `box.rename()`/`box.assign()` answer `{revision, changed}` now. The tests run occulited's conformance
  fixtures (vendored under `test/fixtures/meta/`, `OPENCCU_LITE_FIXTURES` for an upstream checkout) against the
  copy's reads. `FakeBox` records every metadata write (`metaWrites`), checks `If-Match`, answers a `{}` PATCH with
  `304`, refuses writes to a credential without `meta:write`, and has `metaMembers` for `has-members`.

- `callbacks`: `initId` as a string or a function of the interface (beside `initIds`), the synthetic `interface`
  method with `interfaceEvents: true` (`[initId, iface, state]`), the argument lists documented; `updateDevice`'s
  hint stays `0` (the stream carries none); `listDevices` is never emitted.

- The description cache: `paramsetDescription()` is keyed by device type, firmware, version, channel type and
  paramset (`iface/TYPE/FIRMWARE/VERSION/chType/paramset`, the consumers' `paramsets.json` key; `descriptionKey()`
  exported, `box.descriptionKey(ref)`), so one `getParamsetDescription` serves every channel of a type; a channel not
  in `box.devices` is asked per channel as before. `Options.cache: DescriptionCache` - `memoryCache()` (default) or
  `occulite-client/node`'s `fileCache(path, {seed, debounceMs})` (one JSON file, debounced atomic writes, a
  consumer's existing file as the seed). The metadata snapshot is kept under `meta/snapshot` and loaded before the
  system answers. `FakeBox`: `metaRoute: false`.

- `values: 'all'`: a paced `getParamset(VALUES)` sweep after `ready()` for the datapoints the state store does not
  keep (`sweepPaceMs`, default 200 ms; the `sweep` event with its counts; `box.sweep(refs?)` for a re-run or a device
  paired later). Swept values carry `source: 'sweep'`, `confirmed: true` and no `lc`; the store's entries are never
  overwritten; a BidCos device whose `UNREACH` is set is left out (rfd asks the device on the air for every call). `Value`
  gained `source`. `FakeBox`: `storeKeys`, `failing`, `getParamset(VALUES)` answers the channel's values, the state's
  first page names `datapoints`.

- `ready()` waits for the device lists of the running interfaces only (a stopped process no longer holds it for
  `readyTimeout`; the system's `newDevices {error}` snapshot for it is taken as "nothing to wait for"). An interface
  that appears or comes up after connect is followed: `listDevices` once, the descriptions into `box.devices` and out
  as one `devices {kind: 'new'}` event; a live `newDevices` with addresses only gets its descriptions the same way.
  Without an `interfaces` option the stream and the state read carry no interface filter (a filter hides the
  `interface added` of a later one). `FakeBox`: `addInterface()`, `setInterface()`, `listDevices`, the snapshot's
  error for a non-running interface.

- Fixed: `MetaCopy` read an enum's nodes from `nodes`/`children`, but the format's key is `tree` - `rooms()`,
  `functions()` and `membership()` were empty against a real system.

- Credentials: `auth` takes an `AuthProvider` beside `{token}`/`{session}`; `occulite-client/node` has
  `nodeAuth('auto' | {token} | {session} | {addon} | {local: true})` - `'auto'` is `OCCULITE_TOKEN`, the addon's
  token file, the local token, none - and `createClient({url, auth, trust, addon, …})` wiring it with the pinned
  transport. The token files are read again once after a `401`. `box.credential` says which one is in use; without
  any, `ready()` rejects `unauthenticated` with the hint to pair (a system answering `authenticated: false` too).
- **Names-only mode:** a credential without `rpc:read` (the local token) no longer ends `ready()` at
  `/api/rpc/v1/interfaces`; the client loads and follows the metadata only, `box.mode === 'names-only'`, and every
  RPC method rejects `forbidden` naming `rpc:read` without a request. `FakeBox` answers the open auth state with
  `authenticated: false` to a request without any credential.

- Timeouts everywhere: `timeout` per request (default 30 s; `request(…, {timeout, signal})` per call),
  `connectTimeout` for the whole `ready()`, `ready({signal})`; a request the system does not answer rejects
  `timeout`, an aborted one `aborted` - both distinct from `unreachable`. A stream silent for `streamTimeout`
  (default 45 s) is reopened. `ready()`'s device-list timer is cleared, so a closed client no longer holds the
  process for 30 s.
- `probe(address, {timeout = 5000, signal, trust})` answers `reachable` and `reason` (`timeout`, `refused`, `dns`,
  `certificate`, `aborted`) beside `kind` - a timeout is never a CCU - and `probeUntil()` retries while unreachable
  with the 1/2/4/8/15 s schedule. `OccuLiteError.reason` names a transport error's cause.
- `pair({timeout, signal})`: an overall timeout withdraws the request and rejects `timeout`; every poll has its own
  limit; a request left on the way out is withdrawn.
- `FakeBox`: `hang` (accept, never answer) with `resume()`, `pingInterval`, `streamsOpened`, and the pairing poll
  honours `wait=`.

- `box.interfaces` is the typed list from `GET /api/rpc/v1/interfaces` - `[{name, protocol, url_path, running}]`,
  narrowed to the `interfaces` option - and stays live from the stream's `hello` and `interface` events;
  `box.listInterfaces()` reads the route. A credential without `rpc:read` (403) or a system without the route (404)
  no longer ends `ready()`: the option's names stand and the `hello` completes them. `FakeBox` takes
  `interfaces: [{name, running}]`, `interfacesRoute: false` for an older system, and refuses every lite-rpc route
  to a credential without `rpc:read`, as the system does.

- Every request carries `X-Occulite-Request: 1`: openccu-lite refuses a state-changing call on the session cookie
  alone without it (`403 request-header`), so a browser client without `auth` kept working only for reads.
  `REQUEST_HEADER` is exported. `FakeBox` takes a `session` and refuses a cookie-only write without the header, as
  the system does.

## 0.1.0 / 2026-09-25

- First release: one client for openccu-lite's APIs — lite-rpc requests and events, the state
  store, the metadata and pairing. Entry points `occulite-client`, `occulite-client/node`,
  `occulite-client/callbacks` and `occulite-client/testing` (a fake box for tests).
