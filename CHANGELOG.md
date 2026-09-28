# Changelog

## Unreleased

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
