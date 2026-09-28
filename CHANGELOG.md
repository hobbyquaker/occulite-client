# Changelog

## Unreleased

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
  `functions()` and `membership()` were empty against a real system (B-1).

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
