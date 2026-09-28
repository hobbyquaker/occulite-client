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
or rejects it.

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
await box.ready()

box.interfaces                                      // [{name, protocol, url_path, running}] - live
await box.listInterfaces()                          // the same from GET /api/rpc/v1/interfaces (needs rpc:read)
box.values.get('HmIP-RF.000A1B2C3D4E5F:1.STATE')    // {value, ts, lc, confirmed}
box.on('value', ev => {})                           // {ref, interface, address, key, value, ts, lc, confirmed, batch?}
box.on('batch', events => {})                       // one system.multicall's events together
box.on('resync', ({reason}) => {})                  // after a gap or another boot: republish if you cache
box.on('interface', ({interface, state}) => {})     // up | down | restarted | added | removed

await box.setValue('HmIP-RF.000A1B2C3D4E5F:4.LEVEL', 1)   // a FLOAT goes as a double
await box.call('BidCos-RF', 'getLinks', ['JEQ0230153:1', 0])
box.meta.name('HmIP-RF.000A1B2C3D4E5F:4')
box.meta.rooms({inherit: true})
await box.history('HmIP-RF.000A1B2C3D4E5F:1.ACTUAL_TEMPERATURE', {maxPoints: 288})
```

In a browser on the system itself, `auth: {session}` with the page's session, and the default `fetch` transport.

The interfaces the client follows come from `GET /api/rpc/v1/interfaces` - the names `InterfacesList.xml` has, as
lite-rpc's paths take them - narrowed to `interfaces: [...]` when you pass one. The list stays behind `rpc:read` (it
tells the radio hardware): a credential without it, or an older system without the route, is no failure - your
`interfaces` option stands, and the stream's `hello` names the rest. `running` follows the `interface` events.

### Authentication

`auth: {token}` (a paired or created API token) or `auth: {session}` (a browser session id) go as
`Authorization: Bearer`. Without either, the default `fetch` transport rides on the browser's session cookie
(`credentials: 'same-origin'`) - so a page served by the system itself needs no option at all. Every request the
client makes carries the header **`X-Occulite-Request: 1`**: openccu-lite refuses a state-changing call whose only
credential is the session cookie without it (`403 request-header`; a custom header is what a cross-site form post
or link cannot send). A Bearer needs no such header; the client sends it anyway, which is harmless. A program that
talks to the API on its own (not through this client) and replays the cookie for its writes has to send it too.

## Handlers written for a callback server

```js
import {callbackEvents} from 'occulite-client/callbacks'

const server = callbackEvents(box, {initIds: {'HmIP-RF': 'myapp_HmIP-RF'}})
server.on('event', (err, [initId, address, key, value], cb) => {})
server.on('system.multicall', (err, [calls], cb) => {})
server.on('newDevices', (err, [initId, descriptions], cb) => {})
```

The same method events and argument lists as homematic-xmlrpc's and binrpc's servers.

## Testing

`occulite-client/testing` ships `FakeBox`, a fake openccu-lite system in one Node http server (the version answer,
lite-rpc's JSON path and stream, the state store, the metadata, pairing). The package's own tests run against it; so
can yours.

```sh
npm test
```

## Licence

MIT
