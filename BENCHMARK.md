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
| model requests / task | | | |
| total input / task | | | |
| uncached input / task | | | |
| cached read / task | | | |
| output / task | | | |
| cost / task | | | |
| wall-clock time / task | | | |

## Expected outcome

The Δ column should be **small and bounded**: B adds one assignment file read
(which the worker must read once anyway), a handful of adapter round-trips
whose results are small JSON (`{marker, payload, exitCode, stdout, stderr}`),
and the 8 tool schemas in the steady-state prefix. If Δ grows with task length
or turn count, that is a bug in the plugin's context footprint — open an issue.

Contributions that fill in a real Δ row with the dsh version, model, preset,
and task description are welcome.
