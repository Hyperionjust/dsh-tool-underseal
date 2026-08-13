# Installation and maintenance

## Provenance

- Upstream: `https://github.com/Hyperionjust/underseal`
- Reviewed upstream commit: `18f85a6b3bc89a8b3325a9bd665ee51a8ab3d225`
- Upstream package version: `0.1.0`
- Local integration version: `0.1.0+codex.2`

The installed integration preserves the upstream protocol surface of exactly
nine `underseal` subcommands. It adds a separate `underseal-adapter` executable,
one Windows compatibility correction that forces CLI stdout/stderr to LF, and
project-local Git attributes that prevent checkout-time CRLF rewriting of the
control and evidence planes.
The adapter never runs network operations, acceptance commands, Git commits,
or agent dispatch itself.

## Bundled source

The installable local package lives under
`scripts/underseal-codex-package/`. It contains the reviewed Underseal core,
the adapter, license and notice, and the upstream tests plus adapter integration
tests in the development source. The installed tool is built from this reviewed
local package, not from a moving Git branch.

## Where the adapter comes from under DSH

The `dsh-tool-underseal` plugin vendors the reviewed adapter — it does not
bundle a Python interpreter and it never reimplements the verifier. It spawns
the adapter through the DSH `ctx.subprocess` seam:

- **Default**: the vendored, pinned `python/underseal_adapter.py` shipped
  inside the npm package, run under the platform `python`/`python3` launcher
  (config `pythonPath`). The vendored `underseal.py` bytes match
  `python/underseal.pin.json`, and `python/.gitattributes` forces LF so
  checkout-time CRLF rewriting cannot drift the pin.
- **Console-script override**: set `pythonPath` to the empty string and
  `adapterPath` to `underseal-adapter` (or an absolute script path) to use a
  separately provisioned installation, e.g. one built with `uv tool install`
  from this reviewed local package.
- **cwd override**: `cwd` selects the child working directory; the adapter
  still resolves the workspace from its own `--workspace-root`, so this only
  matters for PATH-relative tooling.

The plugin is the distribution shell: the frozen verifier travels as reviewed
bytes inside the package, never as a TypeScript reimplementation.

## Reinstall or update

Treat an update as a new supply-chain review.

1. Fetch a specific upstream commit, not an unpinned branch.
2. Review the actual diff and recompute `underseal.pin.json` from the exact
   `underseal.py` bytes.
3. Preserve the nine-command core surface. Put convenience behavior in the
   separate adapter.
4. Run the complete upstream and adapter suites on Windows.
5. Install with the existing `uv` tool manager from the reviewed local package.
6. Run `underseal --help`, `underseal-adapter --help`, and an isolated full
   lifecycle smoke test (or exercise the `underseal_*` tools end-to-end).
7. Replace a project's pin only after reviewing the verifier change, using:

   ```powershell
   underseal-adapter pin --workspace-root <repo> --replace
   ```

   or the `underseal_pin` tool with `replace: true`.

8. Commit the reviewed pin change before the next dispatch.

Never auto-replace project pins after a global update. Pin drift is a deliberate
stop that prevents an unreviewed global verifier from silently changing an
existing project's authorization semantics.
