# occulite-client

One client for openccu-lite's APIs — lite-rpc's
requests and event stream, the state store, the datapoint history, the metadata (names, rooms, functions) and
client pairing — for hm2mqtt.js, node-red-contrib-ccu, Homematic Manager and any other program that talks to a
Homematic system running openccu-lite.

- **No callbacks:** the events arrive as a stream the client opens; no ports, no callback address, no `init`.
- **A complete picture at connect:** every value with `ts`, `lc` and `confirmed` from the system's state store, the
  device descriptions, the metadata — then only changes.
- **The connection's reliability is the client's:** reconnect with backoff, resume by the last event id, re-read after
  a resync, the events of one multicall delivered together.
- **Pairing instead of copying a token:** the program asks, shows a code, an administrator approves it on the system's
  Status page, the program gets its token and pins the system's certificate.
- **Zero runtime dependencies**, TypeScript, ESM; Node ≥ 20.19 and browsers.

Classic CCUs (XML-RPC/BIN-RPC callbacks, ReGa) are not in it: keep homematic-xmlrpc, binrpc and homematic-rega for
them — [docs/porting.md](docs/porting.md) shows how a program offers both.

## Pairing (Node)

```js
import {pair} from 'occulite-client/node'

const paired = await pair({
  url: 'https://192.168.1.20',
  app: 'hm2mqtt.js', appVersion: '3.7.0', instance: os.hostname(),
  access: {devices: 'operate', names: 'read'},          // one level per area
  purpose: {devices: 'publishes values to MQTT and switches on MQTT commands'},
  onCode: code => console.log(`Pairing code ${code} - approve it on the system's Status page`),
})
// store paired.token and paired.fingerprint256
```

The levels: **devices** `read` · `operate` · `configure` · `administer` (may pair and delete devices), **names** (names
and rooms) `read` · `configure`, **system** `read` · `configure`. The administrator approves exactly what was asked,
or rejects it. `signal` withdraws the request (the promise rejects `aborted`); `timeout` (ms) withdraws it too and
rejects `timeout` - the system itself lets a request expire after five minutes.

## Detection

```js
import {probe, probeUntil} from 'occulite-client/node'

const r = await probe('192.168.1.20', {timeout: 5000})
// {kind: 'openccu-lite' | 'ccu' | 'unreachable', reachable, reason?, url, info?, fingerprint256?, certificate?}
```

`kind` is what answered: `openccu-lite` (with the version answer in `info` and the certificate's `fingerprint256`),
`ccu` (any other HTTP answer, a WebUI's HTML included) or `unreachable`. **`reachable`** and **`reason`** tell the
cases apart that every program used to lump together: `reachable: false` with `timeout` (the system accepts the
connection and does not answer - still booting, or a Pi under load: try again) or `refused` (nothing listens there
yet) or `dns`; `reachable: true` with `reason: 'certificate'` (the system is there and the `trust` you passed refuses
its certificate, which is in `certificate`). **A timeout is never a CCU.** `probeUntil(address, {schedule, signal})`
probes again while the address is unreachable - 1, 2, 4, 8, then every 15 s by default - and resolves with the first
answer.

### Certificates and trust

Over `https://` the Node transport judges the system's certificate itself, before anything - the credential least of
all - is written: `trust: {fingerprint256}` accepts exactly the certificate pinned at pairing, `trust: {ca}` (PEM)
trusts that authority beside Node's own store (an issuing CA alone is enough - a step-ca sends only its intermediate;
the name must still fit the host), no `trust` means Node's store, and `{insecure: true}` is for pairing's first
contact only. A refused certificate rejects `certificate` with everything a trust dialog shows: `certificate` (the
leaf: `subject`, `issuer`, `fingerprint256`, `validFrom`, `validTo`, `altNames`, `pem`), `chain` (as the system sent
it, the leaf first), **`ca`** (the topmost authority in that chain with its `pem` - what a *Trust the CA* button
stores; absent for a self-signed certificate, which is pinned instead), and `reason` (`pin`, or Node's word:
`DEPTH_ZERO_SELF_SIGNED_CERT`, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, `CERT_HAS_EXPIRED`,
`ERR_TLS_CERT_ALTNAME_INVALID`, …). `probe()` returns the same three (`certificate`, `chain`, `ca`) for any `https`
answer, so a settings dialog can offer the pin and the CA before the first connection.

```js
const r = await probe('https://192.168.1.20', {trust: {}})     // judge it, trust nothing yet
if (r.reason === 'certificate') offer({pin: r.certificate.fingerprint256, ca: r.ca?.pem})
```

## Connecting

```js
import {OccuLite} from 'occulite-client'
import {nodeTransport} from 'occulite-client/node'

const box = new OccuLite({
  url: 'https://192.168.1.20',
  auth: {token},
  transport: nodeTransport({fingerprint256}),   // the certificate pinned at pairing
})
box.on('status', s => console.log(s.state))     // connecting | ready | degraded | offline | closed
await box.ready({signal})                       // rejects unauthenticated | forbidden | unsupported | certificate | timeout | aborted

box.devices.get('HmIP-RF.000A1B2C3D4E5F')           // DeviceDescription, as listDevices gives it
box.interfaces                                      // [{name, protocol, url_path, running}] - live
await box.listInterfaces()                          // the same from GET /api/rpc/v1/interfaces (needs rpc:read)
box.values.get('HmIP-RF.000A1B2C3D4E5F:1.STATE')    // {value, ts, lc, confirmed, source}
box.on('value', ev => {})                           // {ref, interface, address, key, value, ts, lc, confirmed, batch?}
box.on('batch', events => {})                       // one system.multicall's events together
box.on('resync', ({reason}) => {})                  // after a gap or another boot: republish if you cache
box.on('interface', ({interface, state}) => {})     // up | down | restarted | added | removed

await box.setValue('HmIP-RF.000A1B2C3D4E5F:4.LEVEL', 1)   // a FLOAT goes as a double
await box.call('BidCos-RF', 'getLinks', ['JEQ0230153:1', 0])
box.meta.name('HmIP-RF.000A1B2C3D4E5F:4')
box.meta.rooms({inherit: true})
box.meta.membership(ref)                            // {rooms: [{path, id, name, depth}], functions} - most specific first
await box.history('HmIP-RF.000A1B2C3D4E5F:1.ACTUAL_TEMPERATURE', {maxPoints: 288})
```

In a browser on the system itself, `auth: {session}` with the page's session, and the default `fetch` transport.

**Typed shapes.** `box.devices` holds `DeviceDescription`s (the `listDevices` entry: `ADDRESS`, `TYPE`, `PARENT`,
`CHILDREN`, `PARAMSETS`, `FIRMWARE`, `VERSION`, `FLAGS`, `RX_MODE`, `INTERFACE`, `ROAMING`, `RF_ADDRESS`,
`AES_ACTIVE`, `LINK_SOURCE_ROLES`, `DIRECTION`, `GROUP`, `TEAM`, `INDEX`, `SUBTYPE`, … and an index signature for what a
process adds), `paramsetDescription()` answers a `ParamsetDescription` (`ParamDescription` per key: `TYPE`,
`OPERATIONS`, `FLAGS`, `DEFAULT`, `MIN`, `MAX`, `UNIT`, `ID`, `TAB_ORDER`, `CONTROL`, `SPECIAL`, `VALUE_LIST`), the
service messages are `ServiceMessage`s - all exported from the package root, hand-written from the CCU's XML-RPC
documentation. A list field (`CHILDREN`, `PARAMSETS`, `TEAM_CHANNELS`) is a string on some processes: guard it.

**Every value, or the state store's.** `box.values` is filled from the system's state store at connect - but the
store keeps only a chosen set of datapoints (what the system's own cards draw, and the service datapoints such as
`UNREACH` and `LOWBAT`), not every one a channel has. A program that wants everything (a retained topic per datapoint,
a value cache) passes **`values: 'all'`**: after `ready()` the client reads the `VALUES` of every channel with one
`getParamset` each, paced (`sweepPaceMs`, default 200 ms), and puts what the store did not have into `box.values` as
`{source: 'sweep', confirmed: true, lc: undefined}`, each as a `value` event with `source: 'sweep'` (the `callbacks`
module turns no such value into an `event` call). The **`sweep`** event `{done, channels, read, failed, skipped,
values, seconds}` says when it is through; `box.sweep(refs?)` runs it again, for everything or for the channels (or
devices) named - a device paired later is swept on its own. On the air it costs nothing for HmIP (hmipserver answers
from its cache); rfd asks a BidCos actuator for its status on every `getParamset(VALUES)`, so the sweep reads a BidCos
channel once and never as a poll, and leaves out a BidCos device whose `UNREACH` is set. The stream keeps everything
current afterwards.

### The system API's slice

`box.system` is the thin, typed part of the system API the consumers use; everything else is `box.request()`. Every
method rejects `unsupported` when the connected system offers no system API, and `forbidden` naming `system:read` or
`system:write` when the token lacks it (pair with `system: 'read'` or `'configure'`).

```js
await box.system.status()             // StatusInfo: hostname, versions, uptime, load, memory, disks, timezone, hm_mode
await box.system.radioHealth()        // RadioHealth: every radio's duty_cycle and carrier_sense, sampled once a minute, with history
await box.system.serviceMessages()    // ServiceMessageView: {count, messages: [{interface, address, key, value, since, seen, name, enums}], swept, errors}
box.on('serviceMessages', view => {}) // the same view whenever the active set changes (a stream, opened with the first handler)
await box.system.groups.list()        // {groups: [{id, name, type, type_label, device, ref}], devices_to_configure}
await box.system.groups.types()       // [{id, label, assignable: [{id, serial, type}], leftover}]
await box.system.groups.get(id)       // HeatingGroupDetail: members, assignable, leftover, forbid_single_operation, device_name
await box.system.groups.create({name, type, members, forbid_single_operation})
await box.system.groups.update(id, {name, members, forbid_single_operation})   // the members as a whole
await box.system.groups.remove(id)    // {deleted, former_members}
await box.system.datastore.history()                              // HistoryList: what the system records
await box.system.datastore.history({add: ['POWER'], remove: []})  // for a program that wants more datapoints drawn
```

The **service messages** are what a CCU's alarm list showed - the maintenance datapoints active on channel 0
(`UNREACH`, `LOWBAT`, `CONFIG_PENDING`, `SABOTAGE`, the `ERROR_*` codes), each with `since` and whether the system
watched it start (`seen: 'event'`) or found it active at a sweep (`'start'`: at least since), and the device's name
and rooms from the metadata. The stream `GET /api/system/v1/service-messages/stream` is one more of the token's
streams (two per token; a connection uses one for the events and one for the metadata already, so a second instance
with the same token gets `too-many-streams`): the client opens it with the first `serviceMessages` handler, closes it
with the last, and reopens it like the others. **The heating groups** are hmipserver's group devices (`INT000000N`
on `VirtualDevices`): a member id is the device address, a group's writes wait up to 45 s (`GROUPS_TIMEOUT`), and the
errors are the API's - `unknown-group`, `invalid` (the field named), `hmipserver` (502: it refused or did not
answer; a failed save is undone by the system), `unsupported` (501: a system without hmipserver). **The radio
health** replaces polling `listBidcosInterfaces` for a duty cycle: the system samples once a minute and keeps the
last 500 samples per radio (`history`).

### The metadata

`box.meta` is a live copy of the system's names and taxonomy (rooms, functions and any other enum - trees, not
ReGa's flat lists): the snapshot at connect, then the change stream applied in place. Reads: `name(ref)`,
`object(ref)`, `channels()`, `rooms()` / `functions()` / `nodes(enum, {inherit, lang})` (each node with its member
refs; with `inherit` a node's members include its descendants'), `query(path, {orphaned})` (the format's subtree
query, `unknown-path` for a path that is not there), `membership(ref, {inherit = true, lang})` (the nodes an object
is in - the node and its ancestors, most specific first, as a program that showed ReGa's flat rooms wants them;
`membershipNames()` gives the names, each once), `snapshot()`.

The writes mirror the API's routes and every one answers `{revision, changed}` (`changed: false` for a `304`) and
takes `{ifMatch: revision}` - `revision-conflict` when the store moved on:

```js
await box.meta.objects.patch(ref, {name, enums, meta}, {ifMatch})   // PATCH; put(), delete(), rename(), assign()
await box.meta.objects.bulk({set: {[ref]: {name}}, delete: [ref]})  // one revision, all or nothing
await box.meta.enums.create('floor', {de: 'Etagen', en: 'Floors'})  // update(id, {name}), delete(id, {detach}), list()
await box.meta.tree.create('room', {parent: 'room/eg', id: 'bad', name: 'Bad', icon, position})
await box.meta.tree.update('room/eg/bad', {name, icon, parent, position})   // parent: a move (null = to the root)
await box.meta.tree.delete('room/eg/bad', {detach: true})           // has-members (detail.refs) without detach
await box.meta.import(document, {mode: 'merge'})                    // a whole document (JSON, or YAML as a string)
await box.meta.export({format: 'yaml'})
```

The errors are the API's, as `OccuLiteError.code` (`MetaErrorCode`): `unknown-object`, `unknown-path`,
`duplicate-id`, `has-members` (with `detail.refs`), `invalid-move`, `revision-conflict`, `forbidden` naming
`meta:write`, … The copy follows a `node.moved` (the member paths rewritten as the store did), a node's rename or
icon and an enum's rename in place; a created or deleted node or enum and an import make it fetch the snapshot
again. The tests run occulited's conformance corpus (its metadata fixtures) against the copy's tree semantics.

**The description cache.** `paramsetDescription(ref, paramset)` is answered from a cache keyed by the device's
`TYPE`, `FIRMWARE` and `VERSION`, the channel's `TYPE` and the paramset - `iface/TYPE/FIRMWARE/VERSION/chType/paramset`,
the key node-red-contrib-ccu's, hm2mqtt.js's and matterbridge-homematic's `paramsets.json` files use - so a
200-channel system asks `getParamsetDescription` once per channel type, not 200 times, and the typed double needs
no request before a write. `memoryCache()` is the default; `fileCache(path, {seed})` from `occulite-client/node`
keeps it across restarts in one JSON file (debounced writes, a temporary file and a rename) and takes an existing
`paramsets.json` as `seed`. The metadata snapshot goes into the same cache under `meta/snapshot`, so names are there
before the system answers (and stay when it does not). `box.descriptionKey(ref, paramset)` gives the key.

```js
import {createClient, fileCache} from 'occulite-client/node'
const cache = fileCache('/var/lib/myapp/occulite-cache.json', {seed: 'paramsets.json'})
const box = createClient({url, auth: {token}, trust: {fingerprint256}, cache})
```

**Timeouts.** Every request has one - `timeout` (default 30 s; `box.request(…, {timeout, signal})` per call) - and
rejects `timeout`, never `unreachable`, when the system does not answer in time. `connectTimeout` (default 60 s)
bounds the whole `ready()`; `readyTimeout` (default 30 s) is how long it waits for the device lists before it
resolves anyway. A stream that is silent for `streamTimeout` (default 45 s; the system pings every 15 s) is
reopened. Nothing the client starts keeps a Node process alive once `close()` was called.

The interfaces the client follows come from `GET /api/rpc/v1/interfaces` - the names `InterfacesList.xml` has, as
lite-rpc's paths take them - narrowed to `interfaces: [...]` when you pass one. The list stays behind `rpc:read` (it
tells the radio hardware): a credential without it, or an older system without the route, is no failure - your
`interfaces` option stands, and the stream's `hello` names the rest. `running` follows the `interface` events.

**Interfaces that are not running, and ones that appear later.** `ready()` waits for the device lists of the
running interfaces only: a stopped `hs485d` does not hold it for `readyTimeout`; it is `running: false` in
`box.interfaces`, reported through `on('interface')`, and its devices are taken when it comes up. An interface that
appears after connect - hmipserver starting after rfd on a system that starts your program early - is followed: the
client reads its device list (`listDevices`) and reports it as a `devices {kind: 'new'}` event with the
descriptions, as a CCU's `newDevices` would. Without an `interfaces` option the stream is opened without an interface
filter, so nothing that appears later is hidden by it; with one, only the named interfaces are followed. A live
`newDevices` that names addresses only (a device paired) gets its descriptions the same way before the event goes out.

### Authentication

`auth: {token}` (a paired or created API token) or `auth: {session}` (a browser session id) go as
`Authorization: Bearer`. Without either, the default `fetch` transport rides on the browser's session cookie
(`credentials: 'same-origin'`) - so a page served by the system itself needs no option at all. **On the system, in
Node,** `createClient()` from `occulite-client/node` resolves the credential for you:

```js
import {createClient} from 'occulite-client/node'

const box = createClient({url: 'http://127.0.0.1', auth: 'auto', addon: 'hm2mqtt', trust: {fingerprint256}})
// 'auto': OCCULITE_TOKEN in the environment → the addon's own token (/run/occulite/addon-tokens/<addon>.api,
// from the manifest's runtime.api_scopes) → the local token (/usr/local/etc/occulite/local-token) → none
await box.ready()
box.credential   // 'token' | 'addon' | 'local' | 'session' | 'none' - for your status line
box.mode         // 'full' | 'names-only'
box.scopes       // the auth state's list: the highest tier only, e.g. ['meta:read', 'rpc:operate']
box.hasScope('rpc:read')   // true: each rpc tier includes the ones before it, a write its read, '*' everything
```

`auth` also takes `{token}`, `{session}`, `{addon: '<id>'}`, `{local: true}` or your own `AuthProvider`
(`{resolve(reason)}`); `localTokenFile` and `addonTokenDir` override the paths. The token files are read again once
after a `401`, so a token created or minted later is picked up without a restart. Without any credential `ready()`
rejects `unauthenticated` with the hint to pair or pass a token.

**Scopes.** openccu-lite lists only the highest scope a token holds: a token paired for devices at *operate* reads
`['meta:read', 'rpc:operate']`, with no `rpc:read` beside it, because each rpc tier includes the ones before it
(`rpc:operate` → `rpc:read`, `rpc:configure` → both, `rpc:admin` → all three), a write its read (`meta:write` →
`meta:read`, `system:write` → `system:read`) and `*` everything. Never look for a scope in `box.scopes` literally:
`box.hasScope(scope)`, or `covers(scopes, scope)` from the package root for a list of your own, answers as the system
decides.

**Names only.** The local token carries `meta:read` alone - every addon has it without any declaration. A credential
that does not cover `rpc:read` puts the client in `mode: 'names-only'`: the metadata (names, rooms, functions) is loaded and
followed, `ready()` resolves, and every RPC method (`setValue`, `call`, `history`, …) rejects `forbidden` naming
`rpc:read` without a request; `box.devices` and `box.values` stay empty. Show *"names only: pair for devices and
values"* and offer pairing.

Every request the client makes carries the header **`X-Occulite-Request: 1`**: openccu-lite refuses a state-changing call whose only
credential is the session cookie without it (`403 request-header`; a custom header is what a cross-site form post
or link cannot send). A Bearer needs no such header; the client sends it anyway, which is harmless. A program that
talks to the API on its own (not through this client) and replays the cookie for its writes has to send it too.

## Handlers written for a callback server

```js
import {callbackEvents} from 'occulite-client/callbacks'

const server = callbackEvents(box, {initId: iface => `myapp_${iface}`, interfaceEvents: true})
server.on('event', (err, [initId, address, key, value], cb) => {})
server.on('system.multicall', (err, [calls], cb) => {})           // calls: [{methodName: 'event', params: [...]}]
server.on('newDevices', (err, [initId, descriptions], cb) => {})
server.on('deleteDevices', (err, [initId, addresses], cb) => {})
server.on('updateDevice', (err, [initId, address, hint], cb) => {})   // hint as the interface sent it: 0, 1 links, 2 description
server.on('replaceDevice', (err, [initId, oldAddress, newAddress], cb) => {})
server.on('readdedDevice', (err, [initId, addresses], cb) => {})
server.on('interface', (err, [initId, iface, state], cb) => {})   // synthetic, with interfaceEvents: true
```

The same method events and argument lists as homematic-xmlrpc's and binrpc's servers (`params` is always an
array), so a table of handlers written for `createServer` feeds from the stream unchanged. `initId` is a string, or
a function of the interface name (the ids programs derive - `nr_<6 chars>_<iface>`, `mb_<iface>` - work as they
are); `initIds: {iface: id}` pins single ones. `interface` is a method no callback server ever had: off by default,
it tells a program that drove its per-interface status from `init`'s success where the interface stands (`up`,
`down`, `restarted`, `added`, `removed`). **Never emitted:** `listDevices` (the system does not ask a client for its
device list), `init`, `setReadyConfig`, `system.listMethods` - your handlers for them stay for the CCU path.
`newDevices` carries the descriptions, as on a CCU (the client fetches them when the stream names addresses only).
`updateDevice`'s `hint` is the one the interface process sent (0 unspecified, 1 the links changed, 2 the description
changed - read it again), from a system whose stream carries it; an older one gives 0. `replaceDevice`'s old and new
address are the stream's `old`/`new`.

## Testing

`occulite-client/testing` ships `FakeBox`, a fake openccu-lite system in one Node http server (the version answer,
lite-rpc's JSON path and stream, the state store, the metadata, pairing). The package's own tests run against it; so
can yours: `box.event()`, `box.push()`, `box.updateDevice()`, `box.replaceDevice()` put messages on the stream,
`box.dropStreams()` and `box.dropMetaStreams()` end the event and the metadata change streams for a reconnect test
(`streamsOpened`, `metaStreamsOpened` count the reopen), `box.calls` records the lite-rpc calls. `scopes` is checked
and answered as the system does it: the auth state lists the highest tier only, and a pairing request is approved
with the scopes of its `access` (`devices: 'operate'` → `rpc:operate`; `box.tokens` holds the tokens issued, each a
credential beside `token`); an unknown area or level is a `422`. The errors the client
throws are `OccuLiteError`s; `httpError(status, body)` and `abortError(signal)` build the same ones, for an adapter's
mapping and its tests.

```sh
npm test
```

## Licence

MIT
