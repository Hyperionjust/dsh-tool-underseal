# dsh-tool-underseal

**English** | [中文](README.zh.md)

![CI](https://github.com/Hyperionjust/dsh-tool-underseal/actions/workflows/ci.yml/badge.svg)

> **The one-breath pitch:** chat is transport, not authorization. Authority is a
> hash-sealed assignment file; evidence is append-only and re-derivable by any
> third party; and every boundary fails closed — sealed tools, a worker
> check-in lock, and byte-pinned supply-chain sentinels — behind a single
> `dsh plugin add dsh-tool-underseal`.

> **Tested on DSH 0.1.0-rc.5** — runtime mounting smoke test passed: `dsh plugin
> add` + `dsh --dump-config` mounts both layers (`underseal` and
> `underseal-guard`), and the full ceremony chain
> (doctor → seal → start → event → audit → retire) ran end to end through the
> vendored adapter in a real Git repository. Two field notes: when `dsh plugin
> add` takes a **local path containing spaces**, wrap it in literal double
> quotes (`dsh plugin --profile p add '"D:\Project Hyperion\A_Deepseek Harness Workspace\underseal-dsh"'`) —
> the CLI joins pnpm args through a shell without quoting; and after sealing,
> commit the lead plane (`.underseal/`, `.underseal-runs/`) before the worker
> starts — the normative scope audit fails closed on uncommitted control-plane
> files (see the bundled skill).

Model-facing typed tools that wrap the frozen, reviewed underseal adapter for
the DeepSeek Harness.

Underseal is a hash-sealed, file-authorization protocol for delegating bounded
work between AI agents. Its frozen Python verifier is the only authority; this
package is a **process shell only** — it never reimplements validation. Each
tool spawns the vendored adapter through the `ctx.subprocess` seam, requires
the adapter's canonical `UNDERSEAL_ADAPTER_*` marker, and throws with the
adapter's `E_*` diagnostic on failure.

The package also ships a DSH skill (`skills/underseal-delegation/SKILL.md`) that
documents the delegation workflow in DSH terms (subagent / subagent_fork /
workflow / goal), and reference files under
`skills/underseal-delegation/references/`.

## Field record: the ceremony's shape in production

A three-day production run of the original underseal workflow (Codex as lead,
DeepSeek workers, August 2026) left OpenAI-side metering worth reading as a
design signal — with two caveats: it predates this DSH plugin, and it mixes
Codex's own context with underseal's, so no clean per-part attribution exists.

| Metric (3 days, weighted) | Value |
|---|---|
| Input cache hit rate | **99.164%** |
| Total input | 289,510,152 tokens |
| Total output | 1,669,568 tokens |
| Input/output ratio | ≈ **173:1** |
| Effective input cost at 0.1× cached reads | ≈ 31.1M tokens (≈ 89% saved) |

Two honest readings:

1. **The 99% cache hit rate is a property to keep.** Sealed assignments,
   receipts, dispatch bindings, and ceremony rules are stable, hash-bound
   text, so long prompt prefixes cache almost perfectly. Protocol stability
   is cache-friendliness.
2. **The 173:1 ratio is the tax of carrying the ceremony inside the chat.**
   The same roughly 100K-token prefix was re-read thousands of times; caching
   made it cheap but did not make it light — rate limits, latency, and the
   exposed prompt surface all paid for it.

This plugin is the correction: authority lives in files, not in the prompt.
A steady-state turn carries the 8 tool schemas (~1–2K tokens) plus bounded
tool results (`{marker, payload, exitCode, stdout, stderr}`); the assignment
is read exactly once by the worker that must obey it, and evidence never
re-enters the context. A normalized per-task benchmark (sealed vs. unsealed,
same task) is in [BENCHMARK.md](BENCHMARK.md) — run it and fill in a real Δ.

## Status: out-of-tree bundle

This directory is an **out-of-tree** plugin package that doubles as an
installable DSH **bundle**: `package.json` declares
`dsh.bundle = { patch: "./cordis.patch.yml" }`, so `dsh plugin add` activates
its layer automatically. It compiles with a plain `tsc -p .` (see
`tsconfig.json`) and is not yet registered in the monorepo's
`tsconfig.host.json` / `knip.json` / root workspaces. See
[Inlining](#inlining-into-the-monorepo).

## Install

Three official forms ([publish guide](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/user/develop/basic/publish.md)):

```sh
# 1. npm (preferred): prebuilt lib/ ships in the published package
dsh plugin --profile <name> add dsh-tool-underseal

# 2. Git checkout: pnpm runs this package's `prepare` (tsc -p .) after fetch;
#    the first add fails until you allowlist the build in the profile's
#    pnpm-workspace.yaml (copy the exact key pnpm printed):
#      allowBuilds:
#        dsh-tool-underseal: true
#    then re-run, pinning a commit:
dsh plugin --profile <name> add github:you/dsh-tool-underseal#<sha>

# 3. Tarball: no build permission needed at all
pnpm pack
dsh plugin --profile <name> add ./dsh-tool-underseal-0.1.0.tgz
```

Verify the layer without booting, then boot:

```sh
dsh --profile <name> --dump-config   # shows a "# == dsh-tool-underseal" layer
dsh --profile <name>
```

Uninstall: `dsh plugin --profile <name> remove dsh-tool-underseal` removes both
the dependency and its layer.

Treat `allowBuilds` as what it is: permission to execute this package's code
at install time, outside any agent sandbox. Prefer the npm or tarball forms
when you do not want to grant it.

## Service API

Two plugins ship in this package:

- Plugin name: `tool-underseal`
- `inject`: `['tools', 'subprocess']` — the plugin loads only when both the tool
  registry (`ctx.tools`) and a subprocess provider (`ctx.subprocess`) exist.
- Contribution: registers eight model-facing tools on `ctx.tools`.

- Plugin name: `underseal-guard` (subpath `dsh-tool-underseal/guard`)
- `inject`: `['tools']`
- Contribution: registers one monotonic execution guard on `ctx.tools` — the
  worker check-in lock (see [Worker check-in lock](#worker-check-in-lock-guard)).

### Config

`tool-underseal`:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `adapterPath` | string | vendored `python/underseal_adapter.py` (absolute, resolved at load) | Adapter script; when `pythonPath` is empty, an executable name or absolute path instead. |
| `pythonPath` | string | `python` (Windows) / `python3` (POSIX) | Interpreter prefix for the `.py` adapter script. Empty string spawns `adapterPath` directly as an executable. |
| `cwd` | string | `process.cwd()` | Child working directory. The adapter resolves its workspace from `--workspace-root`, so this only affects `PATH`-relative tooling. |
| `graceMs` | number | `30000` | Grace period (ms) for the subprocess terminate escalation. |
| `outputMaxBytes` | number | `65536` | In-memory cap per output stream before tail retention. |
| `spillMaxBytes` | number | `4194304` | Whole-stream spill cap per output stream. |

`underseal-guard`:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `blockedTools` | string[] | `['write', 'edit', 'pwsh', 'bash']` | Tool names whose mutations are denied while READY evidence is missing. |
| `cacheTtlMs` | number | `2000` | Verdict cache lifetime (ms) per repository; the small underseal state files are re-read when stale. |

Defaults are self-contained: the reviewed adapter is vendored inside the
package, so a bare `dsh plugin add` needs only a Python interpreter on the
host. Override `pythonPath: ''` + `adapterPath: underseal-adapter` to use a
separately provisioned console-script install instead.

## Vendored verifier

`python/` carries the exact reviewed bytes, not a moving branch:

- Upstream: `https://github.com/Hyperionjust/underseal`
- Reviewed upstream commit: `18f85a6b3bc89a8b3325a9bd665ee51a8ab3d225`
- The `underseal.py` bytes match `python/underseal.pin.json` (SHA-256
  `130c86e0…`); `python/.gitattributes` forces LF so checkout-time CRLF
  rewriting cannot drift the pinned bytes.
- Apache-2.0: `LICENSE` and `NOTICE` ship alongside.

Treat every vendored-verifier update as a new supply-chain review
(`skills/underseal-delegation/references/maintenance.md`).

## Supply-chain sentinels

The plugin runs three byte-level anti-forgery checks inside `apply()` before
registering any tool, so a tampered package cannot activate silently:

- **E1 — vendored verifier bytes.** SHA-256 of `python/underseal.py` must equal
  the pin in `python/underseal.pin.json`; `python/underseal_adapter.py` must
  exist. On any mismatch the plugin logs `error` and registers **nothing**
  (the whole package goes silent rather than run a drifted verifier).
- **E2 — skill body pin.** Every byte of the
  `skills/underseal-delegation/SKILL.md` body (the range after the closing
  frontmatter `---` line) is hashed and compared with the `metadata.pin` value
  in its frontmatter. Drift logs a `warn` and still loads the skill — the
  skill is guidance, not authority, so E2 never blocks tool registration.
- **E3 — bundle patch bytes.** SHA-256 of `cordis.patch.yml` must equal the
  pin in `cordis.pin.json`. A mismatch logs `error` and registers nothing,
  preventing a supply-chain-rewritten layer from activating.

Pin file locations: `python/underseal.pin.json` (E1), the `metadata.pin`
frontmatter line of `skills/underseal-delegation/SKILL.md` (E2), and
`cordis.pin.json` (E3). The expected hash always comes from the pin document
itself, so a missing, corrupt, or malformed pin is itself a fail-closed
condition.

**Re-pinning is a new review action.** After a reviewed change to the
verifier, the skill body, or the bundle patch, recompute the pins with:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\repin.ps1
```

The script prints the three new SHA-256 values, rewrites the two pin JSON
files, and updates the SKILL.md frontmatter `metadata.pin` line (body bytes
are never touched). It is idempotent: re-running it with nothing changed
leaves every file byte-identical. Inspect the printed values and commit the
changed pin files as a new supply-chain review.

## Tools

Every tool returns the same canonical value on success
(`output.schema`, `additionalProperties: false`):

```ts
{ marker: string, payload: JsonValue, exitCode: 0, stdout: string, stderr: string }
```

`marker` is the adapter's exact success token; `payload` is the parsed JSON the
adapter emitted after it. On **any** failure (non-zero exit, or missing the
expected marker) the tool **throws** with the adapter's `E_*` code and stderr —
there is no success value with a failure marker. No tool runs acceptance
commands, performs Git commits, or performs network operations; each mirrors
exactly one adapter subcommand.

| Tool | Adapter subcommand | Required marker | Args | Lead / Worker |
|---|---|---|---|---|
| `underseal_doctor` | `doctor` | `UNDERSEAL_ADAPTER_OK` | `workspaceRoot` | read-only, either |
| `underseal_pin` | `pin` | `UNDERSEAL_ADAPTER_PIN_OK` | `workspaceRoot`, `replace?` | lead |
| `underseal_seal` | `seal` | `UNDERSEAL_ADAPTER_SEALED` | `workspaceRoot`, `taskName`, `expectedMode` (`owner\|mechanical`), `expectedRole`, `dispatchId?` | lead |
| `underseal_start` | `start` | `UNDERSEAL_ADAPTER_READY` | `workspaceRoot`, `taskName`, `expectedMode`, `expectedRole`, `summary?` | worker |
| `underseal_event` | `event` | `UNDERSEAL_ADAPTER_EVENT_OK` | `workspaceRoot`, `taskName`, `expectedMode`, `expectedRole`, `state`, `summary` | worker |
| `underseal_resume` | `resume` | `UNDERSEAL_ADAPTER_RESUMED` | `workspaceRoot`, `expectedRole`, `hostSameAgentConfirmed` | lead |
| `underseal_audit` | `audit` | `UNDERSEAL_ADAPTER_AUDIT_OK` | `workspaceRoot`, `taskName`, `expectedMode`, `expectedRole` | lead |
| `underseal_retire` | `retire` | `UNDERSEAL_ADAPTER_RETIRED` | `workspaceRoot`, `expectedRole` | lead |

Notes that are load-bearing for the protocol:

- **`expectedRole` is a free string**, validated against the Underseal role
  grammar `[a-z][a-z0-9_]{0,63}` (the adapter's `--expected-role` is
  `type=_role_name`, not a fixed enum). `deepseek_owner` / `deepseek_coder`
  are this skill's convention, not the adapter's closed set.
- **`underseal_event.state`** is the adapter's `PROGRESS_STATES` minus `READY`.
  The CLI accepts `READY` as a legal choice, but `READY` is the activation
  boundary that `underseal_start` owns; the enum excludes it so workers cannot
  emit a second activation event through the generic event path.
- **`underseal_resume.hostSameAgentConfirmed`** is a required boolean; the tool
  refuses `false` without invoking the adapter, and only passes
  `--host-same-agent-confirmed` when `true`.
- **`underseal_seal.dispatchId`** is required for a `full`-ceremony assignment
  and must be omitted for `lite` (the adapter enforces both directions).

## Skill

The bundled skill documents the whole ceremony in DSH terms. DSH's
filesystem skill provider does not scan npm package directories, so link it
into a scanned root once per machine or project:

```sh
# project-scoped (committed to the repo):
mkdir -p .dsh/skills
cp -r node_modules/dsh-tool-underseal/skills/underseal-delegation .dsh/skills/

# or user-scoped:
cp -r node_modules/dsh-tool-underseal/skills/underseal-delegation ~/.agents/skills/
```

The session skill catalog then lists `underseal-delegation`; loading it (the
`skill` tool or a `/underseal-delegation` gesture) injects the workflow whose
steps name these tools.

## Worker check-in lock (guard)

The second plugin (`dsh-tool-underseal/guard`, plugin name `underseal-guard`)
turns "call `underseal_start` before touching project files" from skill
guidance into a machine rule in the tool pipeline.

### Enforcement seam

The guard registers through `ctx.tools.guard()`, **not** the reorderable
`tools/pre-execute` waterfall. The contract (packages/core/tools README,
"Public API") makes the difference explicit:

> `ctx.tools.guard(guard: ToolGuard): () => void` — Register a **monotonic
> synchronous execution guard after `tools/pre-execute`**: returning a reason
> denies the call, while `undefined` leaves it unchanged. A plain-context guard
> applies globally … **Later waterfall listeners cannot turn a guard denial
> back into permission.**

and `ToolGuard` is `(execution) => string | undefined`, evaluated "after the
reorderable pre-execute waterfall and before dispatch". A machine rule must
not be reversible by reordering a waterfall, so the monotonic guard API is the
enforcement point. The guard receives the full identity-protected
`Readonly<ToolExecution>` (`name`, `arguments`, `agent`), which supplies the
caller agent's `session.header.cwd` for the repository lookup.

### Decision (v1, full ceremony only)

For each dispatch, when the tool name is in `blockedTools` (default `write`,
`edit`, `pwsh`, `bash`):

1. Walk up from `session.header.cwd` to the Git repository root (any `.git`
   entry). No `.git` (or no usable cwd) → allow.
2. Scan `<repo>/.underseal/assignments/*.assignment.json`; require at least
   one assignment with `ceremony == "full"` and `gate.status == "OPEN"`.
   None → allow. `lite` ceremonies are out of scope for v1.
3. That assignment's role must have an INITIAL-generation current dispatch at
   `.underseal/dispatch/<role>.current.json` (a resume dispatch — non-INITIAL
   activation kind or generation > 1 — does not satisfy this).
4. `.underseal-runs/<task>.events.jsonl` must contain no `READY` event line.

All three hold → the tool call is denied with a reason naming the assignment
and pointing at `underseal_start` (including the `workspaceRoot`/`taskName`/
`expectedRole`/`expectedMode` arguments it needs). **Fail-closed:** any read
error that is not an explicitly classified "absent" answer (no assignments
directory → allow; no current dispatch → allow; no events log → deny) rejects
the call, as does any malformed JSON. The decision core is a pure function
(`src/guard-core.ts`) over a minimal injected read interface, so it runs
without a DSH runtime in `tests/run-guard-tests.mjs`.

### Caching

Verdicts are cached per repository root so the dispatch path is O(1) while
fresh. The cache is invalidated (a) by `fs/observed` events under the
repository (the fs tools emit them after reads/writes), (b) immediately after
any successful `underseal_*` tool result — `underseal_start`'s READY append
goes through the subprocess seam and emits no `fs/observed`, so this is what
makes the block→allow transition immediate — and (c) by a short TTL
(`cacheTtlMs`, default 2000 ms) as a staleness bound for subprocess-driven
changes that emit neither signal. Cache misses re-read the small state files
synchronously, as the synchronous `ToolGuard` contract requires.

### Known limitations of the seam

This is a **program gate inside the tool pipeline, not an OS sandbox**:

- It only sees tool dispatches that flow through the DSH registry. A model
  that reaches the host outside the tool layer, a host-level subprocess the
  tool layer does not mediate, or a remote backend reached through ACP
  bypasses it entirely.
- It blocks by tool name, not by target path: v1 denies `write`/`edit`/
  `pwsh`/`bash` everywhere while the evidence is missing, even for writes
  outside the repository.
- The authoritative acceptance review remains `underseal_audit`; the guard is
  a hygiene gate, not evidence.

## Model Experience

### Tool schemas

#### What the model sees

Eight tool schemas named `underseal_doctor`, `underseal_pin`, `underseal_seal`,
`underseal_start`, `underseal_event`, `underseal_resume`, `underseal_audit`,
`underseal_retire`, each with the parameters and the shared canonical result
schema described under [Tools](#tools). Schemas flow into prompt assembly
automatically via `ctx.tools`.

#### Token effect

Fixed schema cost per request where each tool is visible, plus the tool's
`description` prose.

#### KV Cache effect

Prefix-stable while tool definitions and visibility are unchanged; restriction,
shadowing, or plugin lifecycle changes may invalidate reuse from that schema.

### Tool result

#### What the model sees

On success, `output.render` emits one text block:

```markdown
underseal <label> succeeded (<marker>, exit 0)
<payload as indented JSON>
```

On failure the tool throws; the model sees an `Error: underseal <label> failed
[E_*] (exit N): <stderr>` message rather than a success card.

#### Token effect

Data-dependent tool-result tokens; failures add only the bounded error message
(the adapter already truncates its own `git` stderr to 500 chars).

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix.

### Skill catalog

#### What the model sees

When the bundled `skills/underseal-delegation/SKILL.md` is linked into a
scanned root (see [Skill](#skill)), the session catalog lists
`underseal-delegation` with its `description` summary. Loading it injects the
DSH-first delegation workflow, whose steps name these tools.

#### Token effect

One catalog summary line when available; the full skill body is loaded only on
demand via the `skill` tool or a direct `/underseal-delegation` gesture.

#### KV Cache effect

Append-only; catalog replacement republishes the whole `<available_skills>`
list.

## Inlining into the monorepo

When this package is moved under `packages/`:

1. Replace `tsconfig.json` with the package template shape
   (`extends: "../../../tsconfig.base.json"`, `rootDir: "src"`,
   `outDir: "lib/types"`, project `references` to `vendor/cordis`,
   `vendor/schemastery`, `core/tools`, `subprocess/subprocess`).
2. Register the package in `tsconfig.host.json` `references` (one aggregate
   only — Host), and in `knip.json` if discovery needs it.
3. Re-add the workspace-constraint invariants (`private: true`, root-version
   match, the full `files` gate). The current `package.json` omits `private`
   on purpose because this is a distributable out-of-tree package.

## Known Limitations and Deferred Work

- **Not built inside the monorepo toolchain** — the package is verified with a
  standalone overlay (`tsconfig.verify.json` maps the four `@deepseek-ai/*`
  specifiers onto the checkout's built type entries): strict `tsc` exits 0, the
  guard/sentinel suites pass (54 + 39 assertions), and a runtime smoke test on
  DSH 0.1.0-rc.5 mounted both layers and ran the full ceremony chain. It has
  not been compiled through the monorepo's tsdown/tsc project-reference build.
- **Published-line drift** — peer ranges are pinned against the npm registry:
  `@deepseek-ai/cordis@^4.0.1` and `@deepseek-ai/schemastery@^3.18.1` match the
  vendored build sources exactly; `@deepseek-ai/dsh-tools`/`@deepseek-ai/dsh-subprocess@^0.1.0-rc.0`
  admit the published `0.1.0-rc.6` line, which is newer than the locally tested
  `0.1.0-rc.5`. Re-run the smoke test after the first real install resolves
  versions, and tighten the range if rc.6 changes the seams this package uses.
- **Windows subprocess capture** — the plugin deliberately routes every spawn
  through `ctx.subprocess` rather than `node:child_process`, because the
  harness sandbox denies piped-stdio capture from a bare Node spawn (EPERM on
  named pipes); `ctx.subprocess` collect mode is the sanctioned path and the
  only one exercised here.
- **Python interpreter required** — the vendored adapter runs under the host's
  `python`/`python3`; the package does not ship or install an interpreter.
- **`graceMs` upper bound** — the subprocess seam caps grace at
  `MAX_TIMER_DELAY_MS`; the plugin asserts only positive-integer, leaving the
  upper bound to the seam and documenting it here.
- **`resume` host-same-agent** — `hostSameAgentConfirmed` is an assertion the
  human/model makes, not a fact the plugin can verify; the plugin only refuses
  `false` and forwards `true` to the adapter.
- **No UI cards** — tools fall back to the generic card; terminal/diff
  presentation and a `presentationMeta` projector are deferred.
- **Guard is a pipeline gate, not an OS sandbox** — the worker check-in lock
  ([Worker check-in lock](#worker-check-in-lock-guard)) denies change-shaped
  tool dispatches while READY evidence is missing, but it cannot see host-level
  processes the tool layer does not mediate or remote ACP backends, and it
  blocks by tool name rather than target path (v1). The authoritative review
  remains `underseal_audit`; the adapter's fail-closed verifier and the human
  workflow still own the final boundary.
- **No resident watcher** — the sentinels
  ([Supply-chain sentinels](#supply-chain-sentinels)) run once at plugin
  `apply()`. A resident watcher that raises an immediate alarm on
  `fs/observed` mutations under `python/` (or the bundle patch / skill file)
  is not yet implemented; drift surfaces at the next plugin load or repin.
