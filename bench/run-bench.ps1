#Requires -Version 5.1
<#
  Underseal benchmark: condition A (unsealed) vs condition B (sealed full
  ceremony). Lead-side steps run the vendored adapter through a real Python
  launcher (`py` preferred); only the two `dsh --profile headless` runs
  consume tokens. A bench-local DSH_HOME (bench/.dsh-bench) isolates the
  sessions so token totals are read from one known projection-cache file.
#>

$ErrorActionPreference = 'Stop'

$benchRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$wsRoot    = Split-Path -Parent $benchRoot
$adapter   = Join-Path $wsRoot 'python\underseal_adapter.py'
$dshBin    = 'C:\Users\hyper\deepseek-harness\apps\cli\lib\bin.js'
$profile   = 'headless'

$benchHome = Join-Path $benchRoot '.dsh-bench'
$env:DSH_HOME = $benchHome
$projCache = Join-Path $benchHome 'storages\session_projcache.json'

# Python launcher: prefer `py`; accept `python` only when it actually runs
# (the Windows Store stub exists but exits 9009).
$python = $null
foreach ($candidate in @('py', 'python')) {
  if (Get-Command $candidate -ErrorAction SilentlyContinue) {
    & $candidate --version *> $null
    if ($LASTEXITCODE -eq 0) { $python = $candidate; break }
  }
}
if (-not $python) { throw 'No working Python launcher found (tried py, python). Install Python or adjust the script.' }

$fixtureA  = Join-Path $benchRoot 'bench-fixture-A'
$fixtureB  = Join-Path $benchRoot 'bench-fixture-B'
$taskName  = 'bench_answer'
$role      = 'deepseek_coder'
$dispatch  = 'US-BENCH-0001'

$promptA = 'Create a file named answer.txt in the current directory containing exactly one line: underseal-bench:42'
$promptB = @'
You are an underseal sealed worker (mechanical mode). Work strictly inside the sealed assignment scope.

1. First run this exact shell command to activate (it writes the READY evidence):
   py ..\..\python\underseal_adapter.py start --workspace-root . --task-name bench_answer --expected-mode mechanical --expected-role deepseek_coder
2. Then create a file named answer.txt in the current directory containing exactly one line: underseal-bench:42
3. Then run this exact shell command to record the DONE outcome:
   py ..\..\python\underseal_adapter.py event --workspace-root . --task-name bench_answer --expected-mode mechanical --expected-role deepseek_coder --state DONE --summary "created answer.txt"
Do not change any file other than answer.txt.
'@

function Reset-Fixture([string]$path) {
  if (Test-Path $path) { Remove-Item $path -Recurse -Force }
  New-Item -ItemType Directory -Path $path | Out-Null
  Push-Location $path
  git init -q
  git -c user.email=bench@local -c user.name=bench commit -q --allow-empty -m init
  Pop-Location
}

function Run-Timed([scriptblock]$body) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $null = & $body          # swallow body output; return only the seconds
  $sw.Stop()
  return $sw.Elapsed.TotalSeconds
}

function Invoke-Adapter([string[]]$adapterArgs) {
  $output = & $python $adapter @adapterArgs 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw ("adapter failed (exit {0}): {1}" -f $LASTEXITCODE, ($output -join "`n"))
  }
  return $output
}

function Get-SessionCount {
  if (-not (Test-Path $projCache)) { return 0 }
  try {
    $doc = Get-Content $projCache -Raw | ConvertFrom-Json
    return @($doc.tables.sessions.PSObject.Properties.Name).Count
  } catch { return 0 }
}

function Get-NewestTotals {
  $doc = Get-Content $projCache -Raw | ConvertFrom-Json
  $newest = $null
  foreach ($sid in $doc.tables.sessions.PSObject.Properties.Name) {
    $s = $doc.tables.sessions.$sid
    if ($null -eq $newest -or $s.identity.createdAt -gt $newest.identity.createdAt) { $newest = $s }
  }
  if ($newest -and $newest.rows.tokenUsage -and $newest.rows.tokenUsage.val -and $newest.rows.tokenUsage.val.totals) {
    return $newest.rows.tokenUsage.val.totals
  }
  return $null
}

function Show-Tokens([string]$label) {
  Write-Output ("{0} tokens: read from the DeepSeek platform usage page (cache miss/hit + completion, correlate by this run's timestamp)" -f $label)
}

Write-Output '========== CONDITION A (unsealed) =========='
Reset-Fixture $fixtureA
$beforeA = Get-SessionCount
Push-Location $fixtureA
try {
  $tA = Run-Timed { & node $dshBin --profile $profile $promptA }
} finally { Pop-Location }
Write-Output ("A wall-clock: {0:N1}s" -f $tA)
Write-Output ('A answer.txt: ' + (Get-Content (Join-Path $fixtureA 'answer.txt') -Raw -ErrorAction SilentlyContinue))
Show-Tokens 'A'

Write-Output ''
Write-Output '========== CONDITION B (sealed full ceremony) =========='
Reset-Fixture $fixtureB
Push-Location $fixtureB
try {
  $assignment = [ordered]@{
    schema_version    = 1
    document_type     = 'underseal.assignment'
    assignment_id     = 'US-BENCH-0001'
    task_name         = $taskName
    revision          = 1
    ceremony          = 'full'
    mode              = 'mechanical'
    role              = $role
    workspace         = $fixtureB
    path_profile      = 'windows-strict'
    control_paths     = @('.underseal', '.underseal-runs', '.git')
    gate              = @{ status = 'OPEN'; resolved_by = 'principal' }
    objective         = 'Create answer.txt with exactly one line: underseal-bench:42'
    constraints       = @('No changes outside the declared target answer.txt.')
    forbidden_changes = @('No changes outside the declared target.')
    external_effects  = @()
    progress          = @{ path = '.underseal-runs/bench_answer.events.jsonl'; required = $true }
    terminal_states   = @('DONE', 'CHECKPOINT', 'BLOCKER_TO_LEAD', 'CONFLICT_TO_LEAD')
    recovery          = @{ previous_task_name = $null; preserve_existing_work = $false }
    targets           = @(@{ path = 'answer.txt'; expected_base = 'ABSENT' })
    required_behavior = 'Create answer.txt containing exactly the line underseal-bench:42.'
    acceptance_commands = @('git --no-pager diff --name-only HEAD')
  }
  New-Item -ItemType Directory -Force -Path '.underseal\assignments' | Out-Null
  # ASCII (not utf8): PowerShell 5.1's `-Encoding utf8` writes a BOM, which the
  # underseal parser rejects (E_JSON_BOM). All assignment content is ASCII here.
  $assignment | ConvertTo-Json -Depth 6 | Set-Content -Encoding ascii '.underseal\assignments\bench_answer.assignment.json'

  $null = Invoke-Adapter @('doctor', '--workspace-root', $fixtureB)
  $null = Invoke-Adapter @('seal', '--workspace-root', $fixtureB, '--task-name', $taskName, '--expected-mode', 'mechanical', '--expected-role', $role, '--dispatch-id', $dispatch)

  git add .underseal .underseal-runs
  git -c user.email=bench@local -c user.name=bench commit -q -m 'lead plane'

  $beforeB = Get-SessionCount
  $tB = Run-Timed { & node $dshBin --profile $profile $promptB }

  $null = Invoke-Adapter @('audit', '--workspace-root', $fixtureB, '--task-name', $taskName, '--expected-mode', 'mechanical', '--expected-role', $role)
  $null = Invoke-Adapter @('retire', '--workspace-root', $fixtureB, '--expected-role', $role)
} finally { Pop-Location }
Write-Output ("B wall-clock: {0:N1}s" -f $tB)
Write-Output ('B answer.txt: ' + (Get-Content (Join-Path $fixtureB 'answer.txt') -Raw -ErrorAction SilentlyContinue))
Show-Tokens 'B'

Write-Output ''
Write-Output 'Done. Fill the BENCHMARK.md results table with the A/B token totals above (per 1 task).'
