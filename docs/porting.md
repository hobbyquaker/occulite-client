# Porting a CCU integration to openccu-lite

*Draft (phase 1).* For a program that talks to a Homematic CCU through homematic-xmlrpc, binrpc and/or
homematic-rega and wants to offer openccu-lite as well — keeping its CCU path.

## 1. Who this is for

You run an XML-RPC or BIN-RPC callback server, call `init` on the interface processes, read names and rooms from
ReGa, and maybe system variables and programs. On openccu-lite there is no ReGa, and a program off the system gets no
callbacks. occulite-client is what you use instead; your CCU code stays as it is.

## 2. What is different, in one page

| On a CCU | On openccu-lite |
| --- | --- |
| a callback server the CCU calls (`init`) | a stream the client opens (`/api/rpc/v1/events`); `init` from outside is refused |
| ReGa's numeric ids | refs: `HmIP-RF.000A1B2C3D4E5F:4`, a datapoint `…:4.LEVEL` |
| flat rooms and functions | trees (`room/eg/wohnzimmer`); a channel in a room is in its parents too, if you ask with `inherit` |
| system variables, programs, HM-Script | none |
| optional basic auth, a certificate you ignore | a token with scopes, a pinned certificate |
| a `getParamset` sweep at start | the state store: every value with `ts`, `lc`, `confirmed` in one read |

## 3. Offering both

Put an interface of your own in front of the two paths — `start()`, `stop()`, `values`, `setValue`, `names`,
`rooms`, events — and implement it twice: `backend/ccu.js` wrapping the old libraries, `backend/lite.js` on
occulite-client. Choose *auto*: `probe()` the address; openccu-lite with a token at hand → lite, without one → offer
pairing; a CCU → the old path. Features one side lacks (system variables on lite, `lc` on a CCU) are the backend's
to answer as "not available".

## 4. From homematic-xmlrpc / binrpc

| Old | occulite-client | Note |
| --- | --- | --- |
| `createServer` + `methodCall('init', [url, id])` | `new OccuLite(…)` + `box.on('value', …)`, or `callbackEvents(box, {initIds})` | no ports, no callback address |
| `event` / `system.multicall` callbacks | `value` / `batch` events | `ts` per event; a batch is rebuilt from the stream's mark |
| `newDevices`, `deleteDevices`, `updateDevice`, `replaceDevice`, `readdedDevice` | `devices` event | `listDevices` is never asked of you |
| answering `listDevices` from a cache | nothing | the system does not ask |
| `ping` / re-`init` watchdog | nothing | the client's liveness and resume |
| `listDevices` | `box.devices` | live |
| `getParamsetDescription` | `box.paramsetDescription(ref)` | cached |
| `getParamset` / `getValue` | `box.values`, else `box.getParamset` / `box.getValue` | no sweep at start |
| `putParamset`, `setValue` | the same names, with refs | a `FLOAT` is sent as a double |
| `explicitDouble` | nothing | the client types it from the description |
| any other method | `box.call(iface, method, params)` | the token's level decides |
| outgoing `system.multicall` | `box.batch(iface, calls)` | a JSON-RPC batch |
| basic auth, `rejectUnauthorized: false` | a paired token, a pinned certificate | |
| BIN-RPC-only interfaces (CUxD) | none remotely | on the system itself, keep binrpc on the loopback |

## 5. From homematic-rega

`getChannels` → `box.meta.channels()`; `getRooms` / `getFunctions` → `box.meta.rooms()` / `box.meta.functions()`
(with `{inherit: true}` for the tree semantics); `setName` → `box.rename(ref, name)`; `getValues` → `box.values`.
`getVariables`, `setVariable`, `getPrograms`, `startProgram`, `exec`, scripts → **none**: openccu-lite has no logic
layer of its own; the logic lives in Node-RED/RedMatic, MQTT (retained topics) or your program. Numeric ids → key your
own caches by ref on both paths.

## 6. Common HM-Scripts and their replacements

Names, rooms and functions dumps → `box.meta.snapshot()`; service messages with their times → the system's
service-message view (`box.request('GET', '/api/system/v1/service-messages')`); acknowledging an alarm → `setValue`
of the maintenance datapoint; a user lookup for a login → the system's session.

## 7. Events and reliability

`status` goes `connecting` → `ready`; `degraded` while the stream reconnects (it resumes from the last event id, so
nothing is lost within the system's buffer); `resync` after a gap or another boot, once the values are read again —
republish what you cache. `confirmed: false` is a value the system restored from its own file that no device has
reported since: show it, do not act on it. **Never block a handler:** the system closes a stream that does not read
(`resync overflow`), and the client re-reads.

## 8. Credentials and pairing

A paired token (a program off the system), an addon's own token, the local read token (names only), or a browser
session on the system. Pair with `pair()`: it shows a code, an administrator approves it on the system's Status page,
you store the token and the certificate fingerprint and pass both to the client. A `403` names the scope the token
lacks: pair again with more access.

## 9. Detection

`probe(address)` answers `openccu-lite` (with the version answer and its capabilities), `ccu` or `unreachable`.
`box.capabilities` says what the system offers (`state`, `history`, `pairing`, the API majors).

## 10. Testing your port

`occulite-client/testing`'s `FakeBox` is a fake openccu-lite in one Node http server: run your suite against it for
the lite backend, and against your existing CCU fakes for the other.

## 11. What has no equivalent, and why

System variables, programs, HM-Script, ReGa's numeric ids, the inbox, BIN-RPC-only interfaces remotely — openccu-lite
keeps the radio stack and leaves the logic to the programs on top of it.
