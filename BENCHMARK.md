# Token benchmark: sealed vs. unsealed delegation

The README's [field record](README.md#field-record-the-ceremonys-shape-in-production)
shows a three-day, 99.164% input-cache-hit production run of the *original*
underseal workflow — and, honestly, that a 173:1 input/output ratio is the tax
of carrying the ceremony inside the chat. This document is the experiment that
turns that historical record into a normalized, per-task number: **what does
sealing a task actually cost, in tokens and wall time?**

The claim under test:

> `dsh-tool-underseal` adds a bounded, per-task protocol overhead — a few
> thousand tokens at seal/start/audit — rather than per-turn context growth.
> A steady-state turn carries only the 8 tool schemas plus bounded tool
> results.

## Method

For **one fixed mechanical task** (same objective, same target files, same
acceptance command), run it twice in fresh sessions:

| Condition | What happens |
|---|---|
| **A — unsealed** | A worker subagent is dispatched with the task in the prompt, as usual. |
| **B — sealed** | The same task is sealed (`underseal_seal`), the worker activates with `underseal_start`, records `underseal_event`s, and the lead runs `underseal_audit` + `underseal_retire`. |

Keep the worker prompt text identical apart from the three-fact handoff in B
(workspace root, task name, role). Use the same model, the same preset, and
the same `dsh` version for both runs.

Collect per-session token metrics with the harness token-meter plugin (enable
it for both conditions identically), or from your provider's per-request
usage. Record each metric **divided by the number of completed tasks**.

## Metrics

| Metric | Why it matters |
|---|---|
| model requests / task | Are agent turns multiplying? |
| total input / task | Overall context cost. |
| uncached input / task | Truly new information per task. |
| cached read / task | How much stable prefix is re-carried. |
| output / task | Actual produced work. |
| cost / task | The bottom line. |
| wall-clock time / task | Does the ceremony actually save time? |

## Results template

| Metric | A unsealed | B sealed | Δ (B − A) |
|---|---:|---:|---:|
| model requests / task | 3 | 7 | +4 |
| total input / task | 24,984 | 75,084 | +50,100 |
| uncached input / task | 408 | 10,828 | +10,420 |
| cached read / task | 24,576 | 64,256 | +39,680 |
| output / task | 265 | 1,543 | +1,278 |
| cost / task | | | |
| wall-clock time / task | 17.3s | 27.5s | +10.2s |

### First measured run (2026-08-14)

Trivial mechanical task (create one file with one line), DSH 0.1.0-rc.5,
`deepseek-v4-flash`, run by `bench/run-bench.ps1`; the numbers were read from
the provider usage records in the session logs (`bench/read-session-tokens.mjs`).

Reading: sealing adds a bounded, one-time per-task cost — four extra model
round-trips, ~10.4K uncached input tokens (ceremony instructions, the
assignment read, and the two evidence round-trips), and ~10 seconds of wall
clock — in exchange for a hash-sealed authorization boundary and a scope audit
any third party can re-derive. The Δ does not grow with the task's own work:
the worker's task tokens are the same in both arms.

Caveats: n=1 (single task); the B arm carried the ceremony instructions in the
worker prompt, so this is an upper bound — in a deployment where the bundled
skill supplies the ceremony from a cached prefix, the marginal cost is lower;
and the provider cache was warm across runs, so both arms' uncached figures
are smaller than a cold-cache first run would show.

### Second measured run — big task (2026-08-14)

Real coding task (implement `wordstats.py` with three functions plus a 16-test
`unittest` suite, self-verified), DSH 0.1.0-rc.5, `deepseek-v4-flash`, the
sealed arm in owner mode (`bench/run-bench-big.ps1`).

| Metric | A unsealed | B sealed | Δ (B − A) |
|---|---:|---:|---:|
| model requests / task | 6 | 13 | +7 |
| total input / task | 74,369 | 208,043 | +133,674 |
| uncached input / task | 2,049 | 12,331 | +10,282 |
| cached read / task | 72,320 | 195,712 | +123,392 |
| output / task | 5,138 | 8,472 | +3,334 |
| wall-clock time / task | 38.0s | 92.3s | +54.3s |

| Seal overhead as % of the task's total input | 41.7% (small task) | 13.8% (big task) |

Reading: the uncached-token Δ is essentially identical to the trivial run
(+10,420 → +10,282) — **the seal overhead is a flat ~10.4K-token per-task
constant, not a percentage tax**. As the task grew, that constant's share of
total input fell from 42% to 14%, and it keeps shrinking. A trivial task pays
proportionally more; real work amortizes the seal into the noise. Wall-clock
grew more than tokens (+10.2s on the small task, +54.3s on the big one)
because the ceremony adds model round-trips whose latency scales with the
model's reasoning, not with a fixed constant.

## Expected outcome

The Δ column should be **small and bounded**: B adds one assignment file read
(which the worker must read once anyway), a handful of adapter round-trips
whose results are small JSON (`{marker, payload, exitCode, stdout, stderr}`),
and the 8 tool schemas in the steady-state prefix. If Δ grows with task length
or turn count, that is a bug in the plugin's context footprint — open an issue.

Contributions that fill in a real Δ row with the dsh version, model, preset,
and task description are welcome.
