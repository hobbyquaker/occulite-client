# Notice

The files under `cases/` and `store/` are a verbatim copy of the conformance fixtures of
[occulited](https://github.com/hobbyquaker/occulited) (`fixtures/`), the metadata store's contract
(its decision D-16): test data, copied so this package's tests run offline. They are occulited's and
carry its licence (GPL-3.0); nothing of them is part of the published package (`files` in
package.json lists `dist`, `docs`, the readme, the changelog and the licence only). Set
`OPENCCU_LITE_FIXTURES=/path/to/occulited/fixtures` to run the upstream files instead of the copy.
