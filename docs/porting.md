# Porting a CCU integration to openccu-lite

For a program that talks to a Homematic CCU through homematic-xmlrpc, binrpc and/or homematic-rega and wants to offer
openccu-lite as well - **keeping its CCU path**. Nothing here is a migration: CCU3 and OpenCCU users keep what they
have; openccu-lite users get a second connection type built on occulite-client.

Contents: [1. Who this is for](#1-who-this-is-for) · [2. What is different](#2-what-is-different-in-one-page) ·
[3. Offering both](#3-offering-both) · [4. From homematic-xmlrpc / binrpc](#4-from-homematic-xmlrpc--binrpc) ·
[5. From homematic-rega](#5-from-homematic-rega) · [6. HM-Scripts](#6-common-hm-scripts-and-their-replacements) ·
[7. Events and reliability](#7-events-and-reliability) · [8. Credentials](#8-credentials-and-pairing) ·
[9. Detection](#9-detection) · [10. Testing](#10-testing-your-port) · [11. No equivalent](#11-what-has-no-equivalent-and-why) ·
[12. What changes for your users](#12-what-changes-for-your-users-a-changelog-checklist) · [13. CommonJS](#13-commonjs-consumers)

## 1. Who this is for

You run an XML-RPC or BIN-RPC callback server, call `init` on the interface processes, read names and rooms from
ReGa, and maybe system variables and programs. On openccu-lite there is no ReGa, and a program off the system gets no
callbacks: `init` from outside is refused. occulite-client is what you use instead; your CCU code stays as it is.

The package is one client for openccu-lite's HTTP APIs: lite-rpc (requests over a JSON-RPC path, the events as a
stream the client opens), the state store (every value with its times at connect), the metadata API (names, rooms,
functions - trees), the system API's slice the consumers use (service messages, heating groups, status, radio
health), pairing and TLS trust. Zero runtime dependencies, ESM, TypeScript types, Node ≥ 20.19 and browsers.

## 2. What is different, in one page

| On a CCU | On openccu-lite |
| --- | --- |
| a callback server the CCU calls (`init`, `event`, `newDevices`, …) | a stream the client opens (`GET /api/rpc/v1/events`); `init` from outside is refused |
| ReGa's numeric ids | refs: `HmIP-RF.000A1B2C3D4E5F:4`, a datapoint `…:4.LEVEL` |
| flat rooms and functions | trees (`room/eg/wohnzimmer`); a channel in a room is in its parents too, if you ask with `inherit` |
| system variables, programs, HM-Script | none - the logic lives in the programs on top (Node-RED, MQTT, yours) |
| optional basic auth, a certificate you ignore | a token with scopes (paired, or an addon's own), a pinned certificate or a CA |
| a `getParamset` sweep at start, one call per channel | the state store: the datapoints the system keeps, with `ts`, `lc`, `confirmed`, in one read - plus the client's paced sweep for the rest (§4) |
| `listBidcosInterfaces` polled for the duty cycle | `box.system.radioHealth()`: sampled by the system once a minute, with history |
| ReGa's alarm list and its scripts | `box.system.serviceMessages()` and the `serviceMessages` event |
| `groups.gson` read from disk | `box.system.groups` |
| one program, one CCU, on the LAN | any number of programs, on the system or off it, each with its own token and its own two streams |

## 3. Offering both

Put an interface of your own in front of the two paths and implement it twice: `backend/ccu.js` wrapping the old
libraries, `backend/lite.js` on occulite-client. Everything above it - your MQTT topics, your nodes, your UI - does
not care which one runs. The choice is *auto* by default: `probe()` the address (§9); openccu-lite with a token at
hand → lite, without one → offer pairing; a CCU → the old path; unreachable → try again, it is never a CCU.

Features one side lacks are the backend's to answer as "not available", not to fake: system variables and programs
on lite (§11), `lc`/`confirmed` and the datapoint history on a CCU, the tree semantics of rooms on a CCU.

### The worked example: hm2mqtt.js

hm2mqtt.js is the smallest of the consumers and already ESM, so it is the example. Its port is its own task in that
project; what follows is that plan's shape, written before the port landed - the file names are its.

**Before** (3.7.x): `index.js` talks to `lib/rpc.js` (`RpcServers`, one callback server per protocol; `RpcConnection`
with `createClient`, `methodCall`, `init` and its 1/2/4/8/15 s retry, the ping watchdog, `system.multicall` batching
and `batchHints()`) and to `lib/rega.js` (`RegaSync`: `channelName`, `channelAddress`, `rooms`, `functions`,
`hasVariable`/`hasProgram`, `setVariable`, `programActive`, `programExecute`, `syncNames`, `startPolling`/`stopPolling`,
`load`/`save`, the `names`/`sysvar`/`program`/`polled`/`error` events); `lib/metadata.js` keeps `devices.json` and
`paramsets.json` (a `getParamsetDescription` per channel on every connect). Beside them `lib/meta.js` (724 lines) is
a hand-written client of the metadata API only - names on openccu-lite, nothing else; events and writes still went
over loopback callbacks there.

**After:** `index.js` talks to **one backend interface** - what it used of `regaSync` and of the connections
(`methodCall`, the `event`/`newDevices`/`deleteDevices`/`connected` events, the counters) - and `lib/meta.js` is gone:

```
backend/
  ccu.js    wraps lib/rpc.js + lib/rega.js + lib/metadata.js unchanged   ← a rename-only step, gated by the existing tests
  lite.js   occulite-client                                              ← below
index.js    unchanged in what it does; picks the backend (--backend auto|ccu|openccu-lite)
```

`backend/lite.js`, in outline:

```js
import {OccuLite} from 'occulite-client'
import {createClient, probe, pair, fileCache} from 'occulite-client/node'

export class LiteBackend extends EventEmitter {
  async start() {
    this.box = createClient({url, auth: 'auto', addon: 'hm2mqtt', trust: {fingerprint256}, values: 'all',
      cache: fileCache(join(stateDir, 'occulite-cache.json'), {seed: 'paramsets.json'})})
    this.box.on('batch', evs => this.handleEvents(evs, batchHints(evs)))   // batchHints() from lib/rpc.js is pure: keep it
    this.box.on('value', ev => { if (!ev.batch) this.handleEvent(ev) })    // single events; swept values carry source: 'sweep'
    this.box.on('devices', d => d.kind === 'deleted' ? metadata.removeDevices(d.refs) : metadata.addDevices(d.descriptions))
    this.box.on('interface', i => this.publishConnected(i.interface, i.state !== 'down'))
    this.box.on('status', s => this.updateConnected(s.state === 'ready'))
    this.box.on('resync', () => this.republishRetained())
    this.box.on('sweep', r => log.info(`swept ${r.channels} channels, ${r.values} values, ${r.seconds} s`))
    await this.box.ready()
    for (const [ref, v] of this.box.values) this.publish(ref, v)          // every retained topic before the first event
  }
  channelName(ref)   { return this.box.meta.name(ref) }
  rooms(ref)         { return this.box.meta.membershipNames(ref, {inherit: false}).rooms }   // today's direct-room semantics
  setValue(ref, v)   { return this.box.setValue(ref, v) }                 // a FLOAT goes as a double
  putParamset(...a)  { return this.box.putParamset(...a) }
  rpc(iface, m, p)   { return this.box.call(iface, m, p) }                // the token's tier decides (§8)
  dutyCycle()        { return this.box.system.radioHealth() }             // replaces listBidcosInterfaces every 90 s
  hasVariable()      { return false }                                      // sysvars and programs: CCU-only, one log line
}
```

What the port drops on openccu-lite: the callback servers, `init`, the ping watchdog, the port probing of the
interface processes (`/api/rpc/v1/interfaces` lists them, and the stream says when one comes up), the
`--listen-address`/`--init-address` options (ignored with one log line). What stays for the CCU: all of it.

## 4. From homematic-xmlrpc / binrpc

| Old | occulite-client | Note |
| --- | --- | --- |
| `createServer` + `methodCall('init', [url, id])` | `new OccuLite(…)` + `box.on('value', …)`, or `callbackEvents(box, {initId})` (§4.1) | no ports, no callback address, no `init` |
| `event` / `system.multicall` callbacks | `value` / `batch` events | `ts` per event; a batch is rebuilt from the stream's mark |
| `newDevices`, `deleteDevices`, `updateDevice`, `replaceDevice`, `readdedDevice` | `devices` event (`kind: new \| deleted \| updated \| replaced \| readded`) | `listDevices` is never asked of you; `newDevices` carries the descriptions |
| answering `listDevices` from a cache | nothing | the system does not ask |
| `ping` / re-`init` watchdog | nothing | the client's liveness (45 s of silence reopens the stream) and resume |
| `listDevices` | `box.devices` (`DeviceDescription` by ref) | live; `box.interfaces` lists the interfaces with `running` |
| `getParamsetDescription` | `box.paramsetDescription(ref, paramset)` | cached by device type, firmware, version and channel type; `fileCache()` keeps it across restarts and takes your `paramsets.json` as seed |
| `getParamset(VALUES)` / `getValue` at start | `box.values`, and **`values: 'all'`** for the rest | **`box.values` is not every datapoint** - see below |
| `getParamset` / `getValue` later | `box.getParamset(ref)` / `box.getValue(ref)` | on BidCos each one costs a frame pair on the air; never as a poll |
| `putParamset`, `setValue` | the same names, with refs | a `FLOAT` is sent as a typed double: no `explicitDouble` |
| `listBidcosInterfaces` (duty cycle) | `box.system.radioHealth()` | sampled once a minute by the system, with history; the call still works |
| any other method | `box.call(iface, method, params)` | the token's tier decides (§8): **an unknown method needs `rpc:admin`** |
| outgoing `system.multicall` | `box.batch(iface, calls)` | a JSON-RPC batch, checked per call |
| basic auth, `rejectUnauthorized: false` | a paired token, a pinned certificate or a CA | §8 |
| BIN-RPC-only interfaces (CUxD) | none remotely | on the system itself, keep binrpc on the loopback |

**`box.values` is not every datapoint.** The system's state store keeps a chosen set - what its own cards draw and the
service datapoints (`UNREACH`, `LOWBAT`, `CONFIG_PENDING`, …) - not every datapoint a channel has. A program that
publishes or caches everything passes **`values: 'all'`**: after `ready()` the client reads the `VALUES` of every
channel with one paced `getParamset` each (200 ms apart by default) and adds what the store lacks as
`{source: 'sweep', confirmed: true, lc: undefined}`, each as a `value` event with `source: 'sweep'`; the `sweep` event
says when it is through, `box.sweep(refs)` runs it for a device paired later. On the air it is free for HmIP
(hmipserver answers from its cache); rfd asks a BidCos actuator for its status on every such call, so the sweep reads
a BidCos channel once, paced, and skips a device whose `UNREACH` is set. Do not poll `getParamset` yourself.

### 4.1 The `callbacks` module: handlers written for a callback server

`callbackEvents(box, opts)` from `occulite-client/callbacks` emits the stream's events with the argument lists the
CCU's interface processes send, `params` always an array, and a no-op callback - so a table of handlers written for
homematic-xmlrpc's or binrpc's `createServer` feeds from the stream unchanged:

| Method | Arguments | Note |
| --- | --- | --- |
| `event` | `[initId, address, key, value]` | swept values (`source: 'sweep'`) are **not** turned into `event` calls |
| `system.multicall` | `[[{methodName: 'event', params: [initId, address, key, value]}, …]]` | one call per stream batch (`batches: false` gives single `event`s) |
| `newDevices` | `[initId, descriptions]` | the descriptions, as `listDevices` gives them |
| `deleteDevices` | `[initId, addresses]` | |
| `updateDevice` | `[initId, address, hint]` | `hint` as the interface sent it (0 unspecified, 1 the links changed, 2 the description changed); `0` from a system whose stream carries none |
| `replaceDevice` | `[initId, oldAddress, newAddress]` | the stream's `old`/`new` |
| `readdedDevice` | `[initId, addresses]` | |
| `interface` | `[initId, interface, state]` | synthetic, only with `interfaceEvents: true`: `up`, `down`, `restarted`, `added`, `removed` - for a program that drove its per-interface status from `init`'s success |

**Never emitted:** `listDevices` (the system does not ask a client for its device list), `init`, `setReadyConfig`,
`system.listMethods` - your handlers for them stay for the CCU path. `initId` is a string, or a function of the
interface name (the ids programs derive - `nr_<6 chars>_<iface>`, `mb_<iface>`, `hm2mqtt_hm_<iface>` - work as they
are); `initIds: {iface: id}` pins single ones.

## 5. From homematic-rega

| Old | occulite-client | Note |
| --- | --- | --- |
| `getChannels` | `box.meta.channels()` | live |
| `getRooms` / `getFunctions` | `box.meta.rooms({inherit})` / `box.meta.functions({inherit})` | trees; with `inherit` a node's members include its descendants' |
| a channel's rooms | `box.meta.membership(ref)` (`{rooms, functions}`, most specific first, ancestors included) or `membershipNames(ref)` | with `{inherit: false}` the directly assigned nodes only |
| `setName` | `box.rename(ref, name)` / `box.meta.objects.rename()` | `{revision, changed}`; `{ifMatch}` for a guarded write |
| `getValues` | `box.values` | §4 |
| `getVariables`, `setVariable`, `getPrograms`, `startProgram`, `setProgram`, `exec`, scripts | **none** | §11 |
| the `${roomBathroom}` translation keys | not needed | the import translated them; names are plain strings |
| numeric ids | refs | key your own caches by ref on both paths |

The metadata is a **live copy**: the snapshot at connect (or the last one from the cache before the system answers),
then the change stream applied in place - `box.meta.name(ref)` is a Map lookup, never a request; `box.on('meta', ev)`
tells you what changed, and `box.on('metaSettled', ({revision, reread}) => …)` that the copy is in step again: right
after a change applied in place, or once the snapshot is read again for one the copy cannot apply (a created or
deleted node, an import, a gap) - **derive your names on `metaSettled`, not on `meta`**, whose copy still holds the
old state in the second case. The writes mirror the API (`objects.patch/put/delete/bulk`, `enums.*`, `tree.*`,
`import`, `export`) and need `meta:write`.

## 6. Common HM-Scripts and their replacements

| The script did | On openccu-lite |
| --- | --- |
| dump names, rooms and functions | `box.meta.snapshot()` |
| the alarm list with first and last time | `box.system.serviceMessages()` (`since`, `seen: 'event' \| 'start'`, the device's name and rooms) and `box.on('serviceMessages')` |
| acknowledge an alarm | `setValue` of the maintenance datapoint (the CCU's own acknowledge lives in the WebUI) |
| the inbox confirm | nothing: there is no inbox |
| read `groups.gson` | `box.system.groups.list()` / `get(id)`; `create`/`update`/`remove` through hmipserver |
| a user lookup for a login | the system's session (`/api/auth/v1/state`) |
| the duty cycle | `box.system.radioHealth()` |
| anything with system variables or programs | §11 |

## 7. Events and reliability

`status` goes `connecting` → `ready` (the first complete picture is loaded: device lists of the running interfaces,
values, metadata); `degraded` while the stream reconnects - it resumes from the last event id, so nothing is lost
within the system's buffer (300 s, 5 000 events); `resync` after a gap, an overflow or another boot of the system,
once the values are read again - **republish what you cache**; `offline` when the credential is refused (retrying
does not help; re-read your token or pair again). `confirmed: false` is a value the system restored from its own
file that no device has reported since: show it (as *uncertain*), do not act on it.

**Never block a handler:** the system closes a stream that does not read (`resync overflow`), and the client
re-reads everything. Hand the work to a queue and return.

**Interfaces that are not running, and ones that appear later.** `ready()` does not wait for a stopped interface
process; it is `running: false` in `box.interfaces`, and its devices come when it comes up (`interface {state: 'up'}`,
then a `devices {kind: 'new'}` with the descriptions). hmipserver starts after rfd: a program the system starts early
sees `interface {state: 'added'}` for `HmIP-RF` a while after `ready()`.

**Timeouts:** every request has one (`timeout`, default 30 s) and rejects `timeout`, never `unreachable`; `connectTimeout`
bounds `ready()`. A request the system does not answer is a slow system, not a missing one.

**Reverse proxies:** the streams are plain HTTP with `text/event-stream`; a proxy in front of the system must not
buffer them (nginx: `proxy_buffering off`, or honour `X-Accel-Buffering: no`, which the system sends) and must allow a
read timeout above 45 s, or the client sees a silent stream every minute and reopens it.

## 8. Credentials and pairing

Four credentials, one `auth` option:

| Credential | Where | Scopes | How |
| --- | --- | --- | --- |
| a **paired token** | a program off the system, or one that wants more than the addon token has | what the administrator approved | `pair()` once, store `token` and `fingerprint256` |
| the **addon's own token** | an addon on the system | the manifest's `runtime.api_scopes` (never `*`, `auth:admin`, `power`, `backup`) | `/run/occulite/addon-tokens/<id>.api`; `nodeAuth('auto', {addon})` reads it |
| the **local token** | any program on the system | `meta:read` only: **names only** | `/usr/local/etc/occulite/local-token`; `'auto'` falls back to it |
| a **browser session** | a page served by the system | the user's role | `auth: {session}` with the page's session id, or nothing (the cookie) |

**On the system:** `createClient({url: 'http://127.0.0.1', auth: 'auto', addon: '<id>'})` tries `OCCULITE_TOKEN`,
the addon token, the local token, none. Declare `runtime.api_scopes` in the manifest (`["meta:read", "rpc:operate"]`
for a program that publishes values and switches devices) or you get the local token and with it **`mode:
'names-only'`**: the metadata is loaded and followed, `ready()` resolves, `box.devices` and `box.values` stay empty,
and every RPC method rejects `forbidden` naming `rpc:read`. Show *"names only: pair for devices and values"* and offer
pairing. The token files are read again once after a `401`, so a token created later is picked up without a restart.

**Off the system: pairing.** `pair({url, app, appVersion, instance, access, purpose, onCode})` asks the system for a
token, shows a six-digit code, and waits (up to five minutes) for an administrator to approve it on the system's
Status page with one click; it answers the token, the scopes and the certificate's fingerprint - store both, pass
`auth: {token}` and `trust: {fingerprint256}` from then on. `access` is one level per area:

| Area | Levels | What a method needs |
| --- | --- | --- |
| `devices` | `read` · `operate` · `configure` · `administer` | reads and the stream `read`; `setValue`, `putParamset(…, VALUES)` `operate`; paramsets, links, install mode, teams `configure`; delete, re-key, firmware, restore and **every unknown method** `administer` (`rpc:admin`) |
| `names` | `read` · `configure` | the metadata reads; the writes |
| `system` | `read` · `configure` | status, radio health, service messages, the groups list; the groups' writes, the history list |

The last line of the first row surprises a program that forwards arbitrary methods (an `rpc/#` topic, a `ccu-rpc`
node): on openccu-lite the token's tier limits what its users can call - a documented behaviour change (§12), not a
bug. **The auth state and the pairing answer list only the highest tier**: `devices: 'administer'` reads back as
`rpc:admin`, with no `rpc:read`, `rpc:operate` or `rpc:configure` beside it; `box.hasScope('rpc:operate')` (or
`covers(scopes, …)`) knows the tiers - never compare scope names yourself. A `403` names the scope the token lacks (`OccuLiteError.scope`): tell the operator to pair again with more
access, or to grant it in the API tokens panel; the scopes can only be narrowed on an existing token.

**Streams per token: two.** One connection uses one for the events and one for the metadata (a third for the service
messages while a `serviceMessages` handler is registered; it is opened lazily and closed with the last handler). **A
second instance with the same token gets `too-many-streams`** - pair per instance (`instance: os.hostname()`), never
copy a token between two programs.

**TLS.** `trust: {fingerprint256}` accepts exactly the pinned certificate; `trust: {ca}` a CA (PEM) beside Node's store;
nothing means Node's store. A refused certificate rejects `certificate` with the leaf, the chain and the CA to offer
(`ca.pem`); `probe()` returns the same, so a settings dialog can show *pin this certificate* or *trust this CA* before
the first connection. Never `insecure: true` beyond pairing's first contact.

## 9. Detection

```js
const r = await probe(address, {timeout: 5000})
// {kind: 'openccu-lite' | 'ccu' | 'unreachable', reachable, reason?, url, info?, fingerprint256?, certificate?, ca?}
```

`kind` is what answered. **`reachable` and `reason` tell apart what every program used to lump together:** `reachable:
false` with `reason: 'timeout'` (the system accepts the connection and does not answer - still booting, or a Pi under
load), `'refused'` (nothing listens yet) or `'dns'`; `reachable: true` with `reason: 'certificate'` (the system is
there; the trust you passed refuses its certificate). **A timeout is never a CCU:** a program that took a timed-out
detection for "no openccu-lite" and started its ReGa polls stayed in that mode for good while the system answered a
minute later. Use `probeUntil(address, {schedule, signal})` at start - it probes again while unreachable (1, 2, 4, 8,
then every 15 s) and resolves with the first answer - and decide on `kind`, never on the absence of an answer.
`box.capabilities` (from `info.capabilities`) says what the system offers: `state`, `history`, `pairing`, the API
majors, `limits.streams_per_token`.

Discovery on the LAN (the eQ-3 UDP answer on 43439) is what it was on a CCU: openccu-lite answers it too; keep your
discovery and `probe()` what it finds.

## 10. Testing your port

`occulite-client/testing`'s `FakeBox` is a fake openccu-lite in one Node http server: the version answer with its
capabilities, the auth state, lite-rpc's interfaces, JSON path and event stream (`hello`, device lists, events with
batch marks, `resync`), the state store, the history, the metadata snapshot and its change stream, pairing, token
rotation, and the system API's slice (status, radio health, service messages with their stream, an in-memory heating
group store). Run your suite against it for the lite backend, and against your existing CCU fakes for the other:

```js
import {FakeBox} from 'occulite-client/testing'
const fake = new FakeBox({token: 't', devices: {'HmIP-RF': [...]}, values: {...}, storeKeys: ['STATE'], meta: {...}})
const url = await fake.start()
// ... your backend against url with auth: {token: 't'} ...
fake.event('HmIP-RF', '000A1B2C3D4E5F:1', 'STATE', true)   // an event on the stream
fake.setInterface('BidCos-RF', false)                       // an interface goes down
fake.dropStreams()                                          // the system restarts: the client resumes
await fake.stop()
```

`storeKeys` makes the fake's state store keep a subset, so the sweep has something to do; `failing` names channels
whose `getParamset` faults; `hang` and `resume()` play a system that is still booting; `scopes` a token with less.

## 11. What has no equivalent, and why

System variables, programs, HM-Script, ReGa's numeric ids, the inbox, BIN-RPC-only interfaces remotely. openccu-lite
keeps the radio stack and leaves the logic layer to the programs on top of it - Node-RED/RedMatic's context and
flows, MQTT's retained topics, your program's own state. A port does not fake them: no empty `getVariables()`, no
`setVariable` that pretends. The backend answers "not available" and the user sees one line saying so.

## 12. What changes for your users (a CHANGELOG checklist)

What a consumer's release notes say about its openccu-lite connection:

- **Values at connect:** every value the system has is there before the first event (retained topics, caches, initial
  states) - with `ts`, `lc` and `confirmed`; `confirmed: false` (*uncertain*) for a value restored after a restart.
- **Events arrive as a stream:** no callback ports to open or forward, no `--listen-address`/`--init-address`, no
  `init`, no ping; a few milliseconds later than a callback on the same LAN (the system's stream in between).
- **No sweep of your own at start** - the client's paced one (`values: 'all'`) instead; BidCos devices are asked once.
- **Tier limits:** what a token may call depends on the access approved at pairing; arbitrary methods (`rpc/#`, a
  `ccu-rpc` node) need *administer*; a `403` names the missing scope.
- **Names with tree semantics:** a channel's rooms include the parents (unless you keep `inherit: false`); functions
  and any other enum the same way.
- **No system variables, programs or scripts** on openccu-lite (one line in the log, the topics or nodes stay
  CCU-only).
- **Pairing instead of a token field:** a code shown by the program, one click on the system's Status page; the
  certificate is pinned from then on.
- **Interfaces that appear later are followed** (hmipserver after rfd) - no restart after the radio stack came up.
- **Service messages, heating groups and the duty cycle** come from the system (`box.system`), not from ReGa scripts or
  `listBidcosInterfaces` polls.

## 13. CommonJS consumers

The package is ESM only. A CommonJS consumer loads it with `require()` on Node ≥ 20.19 / ≥ 22.12 (the package's
engines; `require(esm)` is stable there - node-red-contrib-ccu does this for homematic-rega 2 already):

```js
const {OccuLite} = require('occulite-client')
const {createClient, probe} = require('occulite-client/node')
```

**Load it lazily** - inside the code path that found openccu-lite - so a CCU-only installation never loads it
(`const {OccuLite} = require('occulite-client')` at the top of a Node-RED node would, at every start). The package's
own CI `require()`s its built `dist` from a `.cjs` file, so this stays true.
