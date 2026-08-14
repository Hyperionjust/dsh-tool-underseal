# Underseal token benchmark runner

Runs the sealed-vs-unsealed benchmark from `BENCHMARK.md` in one script:
condition A (unsealed subagent-style headless run) and condition B (sealed
full ceremony: doctor -> seal -> worker -> audit -> retire). The lead-side
steps (doctor/seal/audit/retire) run the vendored adapter directly — no model
needed — so only the two `dsh --profile headless` runs consume tokens.

## Prerequisites

1. A built `dsh` CLI at `C:\Users\hyper\deepseek-harness\apps\cli\lib\bin.js`
   (the script invokes it via `node`, so no `dsh` on PATH is needed; the
   fixture directory is the headless workspace root because that is where the
   CLI is launched). If your checkout lives elsewhere, edit `$dshBin` in the
   script.
2. A DeepSeek API key in your terminal environment:

   ```powershell
   $env:DEEPSEEK_API_KEY = "sk-..."   # do NOT paste it into any chat
   ```

3. A working Python launcher — the script prefers `py` and falls back to
   `python` only if it actually runs (the Windows Store stub exits 9009, so a
   real Python install is required). The benchmark keeps its own harness home
   at `bench/.dsh-bench`, so it never touches your real `$DSH_HOME`.

## Run

```powershell
powershell -ExecutionPolicy Bypass -File bench\run-bench.ps1
```

The script prints, for each condition, the wall-clock time and the final
`answer.txt` content. It recreates `bench-fixture-A` / `bench-fixture-B` fresh
each run.

## Reading the token numbers

The headless profile does not persist the session projection cache, so the
script cannot read token buckets back locally; read them from the DeepSeek
platform usage page (per-request breakdown), correlating by the run timestamps
the script prints:

| BENCHMARK.md metric | DeepSeek usage field |
|---|---|
| uncached input | cache miss tokens |
| cached read | cache hit tokens |
| output | completion tokens |

Fill the `BENCHMARK.md` results table with each metric divided by 1 task (one
task per condition here).
