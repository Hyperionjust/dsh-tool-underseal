# Contributing

Thanks for helping. This package is a process shell around a frozen verifier —
the Python core is a conformance target, not something to extend here. Please
keep changes to the TypeScript wrapper and the docs.

## Build and test

```sh
npm install
npm run build                       # tsc -p tsconfig.json (strict)
node tests/run-guard-tests.mjs      # 54 assertions
node tests/run-sentinel-tests.mjs   # 39 assertions
```

`tsconfig.verify.json` is a local-only overlay that maps the `@deepseek-ai/*`
specifiers onto a checkout's built type entries; CI and the plain
`tsconfig.json` build resolve the published registry types instead.

## Re-pinning (a new review action)

After a reviewed change to the vendored verifier, the skill body, or the
bundle patch, recompute the sentinel pins:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\repin.ps1
```

Inspect the printed hashes and commit the pin changes as their own supply-chain
review.

## Pull requests

- One concern per PR; describe what changed and why.
- Keep the 8-tool surface and the `UNDERSEAL_ADAPTER_*` marker checks 1:1 with
  the adapter subcommands.
- Update `README.md` (and `README.zh.md`) and `CHANGELOG.md` for any
  user-visible change, including the Known Limitations section when a gap
  opens or closes.
