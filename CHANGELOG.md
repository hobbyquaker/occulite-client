# Changelog

## Unreleased

- Every request carries `X-Occulite-Request: 1`: openccu-lite refuses a state-changing call on the session cookie
  alone without it (`403 request-header`), so a browser client without `auth` kept working only for reads.
  `REQUEST_HEADER` is exported. `FakeBox` takes a `session` and refuses a cookie-only write without the header, as
  the system does.

## 0.1.0 / 2026-09-25

- First release: one client for openccu-lite's APIs — lite-rpc requests and events, the state
  store, the metadata and pairing. Entry points `occulite-client`, `occulite-client/node`,
  `occulite-client/callbacks` and `occulite-client/testing` (a fake box for tests).
