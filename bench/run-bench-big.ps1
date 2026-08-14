#Requires -Version 5.1
<#
  BIG-TASK underseal benchmark: condition A (unsealed) vs condition B (sealed
  owner-mode ceremony) on a real coding task, to demonstrate that the protocol
  overhead stays bounded while the task's own tokens dominate.
  Same skeleton as run-bench.ps1; token totals are read afterwards with
  bench/read-session-tokens.mjs from the two newest bench sessions.
#>

$ErrorActionPreference = 'Stop'

$benchRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$wsRoot    = Split-Path -Parent $benchRoot
$adapter   = Join-Path $wsRoot 'python\underseal_adapter.py'
$dshBin    = 'C:\Users\hyper\deepseek-harness\apps\cli\lib\bin.js'
$profile   = 'headless'

$benchHome = Join-Path $benchRoot '.dsh-bench'
$env:DSH_HOME = $benchHome

$python = $null
foreach ($candidate in @('py', 'python')) {
  if (Get-Command $candidate -ErrorAction SilentlyContinue) {
    & $candidate --version *> $null
    if ($LASTEXITCODE -eq 0) { $python = $candidate; break }
  }
}
if (-not $python) { throw 'No working Python launcher found (tried py, python).' }

$fixtureA  = Join-Path $benchRoot 'bench-fixture-A'
$fixtureB  = Join-Path $benchRoot 'bench-fixture-B'
$taskName  = 'big_wordstats'
$role      = 'deepseek_owner'
$dispatch  = 'US-BIG-0001'

$SPEC = @'
Implement a Python module `wordstats.py` using only the standard library. Provide:
(1) count_words(text: str) -> int — the number of words, where words are maximal sequences of Unicode letters or digits;
(2) word_frequencies(text: str) -> dict[str, int] — case-insensitive word counts;
(3) top_words(text: str, n: int) -> list[tuple[str, int]] — the n most frequent words, sorted by count descending, ties broken by word ascending, using the lowercased word as the key.
Include docstrings and type hints.
Also implement `test_wordstats.py` as a unittest suite covering: empty input, mixed-case normalization, punctuation splitting, tie-breaking order, and non-ASCII letters.
Verify your implementation passes `py -m unittest test_wordstats -v` before finishing.
'@

$promptA = $SPEC

$promptB = @'
You are an underseal sealed worker (owner mode). Work strictly inside the sealed assignment scope.

1. First run this exact shell command to activate (it writes the READY evidence):
   py ..\..\python\underseal_adapter.py start --workspace-root . --task-name big_wordstats --expected-mode owner --expected-role deepseek_owner
2. Read the sealed assignment at .underseal/assignments/big_wordstats.assignment.json and implement exactly what it requires.
3. When finished, run this exact shell command to record the DONE outcome:
   py ..\..\python\underseal_adapter.py event --workspace-root . --task-name big_wordstats --expected-mode owner --expected-role deepseek_owner --state DONE --summary "implemented wordstats module and tests"
'@

function Reset-Fixture([string]$path) {
  if (Test-Path $path) { Remove-Item $path -Recurse -Force }
  New-Item -ItemType Directory -Path $path | Out-Null
  Push-Location $path
  git init -q
  git -c user.email=bench@local -c user.name=bench commit -q --allow-empty -m init
  Pop-Location
}

$script:lastSeconds = 0
function Run-Timed([scriptblock]$body) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  # Stream the headless output live (big tasks run for minutes; silence looks
  # like a hang), then stash the elapsed seconds separately so it cannot leak
  # into the return value.
  & $body | ForEach-Object { Write-Output $_ }
  $sw.Stop()
  $script:lastSeconds = $sw.Elapsed.TotalSeconds
}

function Invoke-Adapter([string[]]$adapterArgs) {
  $output = & $python $adapter @adapterArgs 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw ("adapter failed (exit {0}): {1}" -f $LASTEXITCODE, ($output -join "`n"))
  }
  return $output
}

function Check-Task([string]$fixture, [string]$label) {
  Push-Location $fixture
  try {
    # unittest writes its results to stderr; under $ErrorActionPreference='Stop'
    # a 2>&1 merge would turn them into terminating errors. Relax locally.
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $out = & $python -m unittest test_wordstats -v 2>&1
    $ok = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = $prevEap
    Write-Output ("{0} acceptance (unittest): {1}" -f $label, $(if ($ok) { 'PASS' } else { 'FAIL' }))
    if (-not $ok) { Write-Output ($out | Select-Object -Last 8 | Out-String) }
  } finally { Pop-Location }
}

Write-Output '========== CONDITION A (unsealed, big task) =========='
Reset-Fixture $fixtureA
Push-Location $fixtureA
try {
  Run-Timed { & node $dshBin --profile $profile $promptA }
  $tA = $script:lastSeconds
} finally { Pop-Location }
Write-Output ("A wall-clock: {0:N1}s" -f $tA)
Check-Task $fixtureA 'A'

Write-Output ''
Write-Output '========== CONDITION B (sealed owner ceremony, big task) =========='
Reset-Fixture $fixtureB
Push-Location $fixtureB
try {
  $assignment = [ordered]@{
    schema_version    = 1
    document_type     = 'underseal.assignment'
    assignment_id     = 'US-BIG-0001'
    task_name         = $taskName
    revision          = 1
    ceremony          = 'full'
    mode              = 'owner'
    role              = $role
    workspace         = $fixtureB
    path_profile      = 'windows-strict'
    control_paths     = @('.underseal', '.underseal-runs', '.git')
    gate              = @{ status = 'OPEN'; resolved_by = 'principal' }
    objective         = $SPEC.Trim()
    constraints       = @('Use only the Python standard library.', 'Change only files needed for wordstats.py and test_wordstats.py.')
    forbidden_changes = @('Do not modify anything under .underseal, .underseal-runs, or .git.')
    external_effects  = @()
    progress          = @{ path = '.underseal-runs/big_wordstats.events.jsonl'; required = $true }
    terminal_states   = @('DONE', 'CHECKPOINT', 'DECISION_NEEDED', 'BLOCKER_TO_PRINCIPAL', 'CONFLICT_TO_PRINCIPAL')
    recovery          = @{ previous_task_name = $null; preserve_existing_work = $false }
    ownership_root    = '.'
    protected_paths   = @('.underseal', '.underseal-runs', '.git')
    acceptance_outcomes = @('wordstats.py implements count_words, word_frequencies, top_words with the specified behavior.', 'test_wordstats.py passes: py -m unittest test_wordstats -v')
  }
  New-Item -ItemType Directory -Force -Path '.underseal\assignments' | Out-Null
  $assignment | ConvertTo-Json -Depth 6 | Set-Content -Encoding ascii '.underseal\assignments\big_wordstats.assignment.json'

  $null = Invoke-Adapter @('doctor', '--workspace-root', $fixtureB)
  $null = Invoke-Adapter @('seal', '--workspace-root', $fixtureB, '--task-name', $taskName, '--expected-mode', 'owner', '--expected-role', $role, '--dispatch-id', $dispatch)

  git add .underseal .underseal-runs
  git -c user.email=bench@local -c user.name=bench commit -q -m 'lead plane'

  Run-Timed { & node $dshBin --profile $profile $promptB }
  $tB = $script:lastSeconds

  $null = Invoke-Adapter @('audit', '--workspace-root', $fixtureB, '--task-name', $taskName, '--expected-mode', 'owner', '--expected-role', $role)
  $null = Invoke-Adapter @('retire', '--workspace-root', $fixtureB, '--expected-role', $role)
} finally { Pop-Location }
Write-Output ("B wall-clock: {0:N1}s" -f $tB)
Check-Task $fixtureB 'B'

Write-Output ''
Write-Output 'Done. Token totals are read afterwards with bench/read-session-tokens.mjs.'
