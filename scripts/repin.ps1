#Requires -Version 5.1
<#
.SYNOPSIS
  Recompute the three supply-chain pins for dsh-tool-underseal.

.DESCRIPTION
  The package's supply-chain sentinels (HANDOFF §5 E1/E2/E3) fail closed when
  a pinned artifact's bytes drift from its pin. This script re-derives the
  three pins from the CURRENT bytes in the package:

    E1  python/underseal.pin.json             <- sha256(python/underseal.py)
    E2  skills/underseal-delegation/SKILL.md frontmatter metadata.pin
                                              <- sha256(body bytes after the
                                                 closing frontmatter '---' line)
    E3  cordis.pin.json                       <- sha256(cordis.patch.yml)

  Re-pinning is a REVIEW ACTION: after running this script the new pin values
  (printed below) must be inspected and the changed files committed as a new
  supply-chain review. The script is idempotent: when nothing changed,
  re-running it leaves every touched file byte-identical.

  Byte-safety: E2 edits only the frontmatter slice of SKILL.md. The closing
  '---' delimiter and the entire body are carried through as raw byte slices
  and written back verbatim, so a multibyte UTF-8 body (and its line endings)
  survives the rewrite untouched. The body hash is computed over those exact
  bytes with Get-FileHash -Algorithm SHA256 (via -InputStream on PowerShell
  7.4+, with a .NET SHA256 fallback on older hosts).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\repin.ps1
#>
[CmdletBinding()]
param(
  [string]$PackageRoot = (Resolve-Path (Join-Path $PSScriptRoot '..') -ErrorAction Stop).Path
)

$ErrorActionPreference = 'Stop'

# --- helpers -----------------------------------------------------------------

function Get-Hex([byte[]]$Bytes) {
  # Prefer Get-FileHash -InputStream (PowerShell 7.4+); fall back to .NET SHA256.
  $stream = [System.IO.MemoryStream]::new($Bytes, $false)
  try {
    try {
      $entry = Get-FileHash -Algorithm SHA256 -InputStream $stream -ErrorAction Stop
      return $entry.Hash.ToLowerInvariant()
    } catch {
      $sha = [System.Security.Cryptography.SHA256]::Create()
      try {
        return ([System.BitConverter]::ToString($sha.ComputeHash($Bytes)) -replace '-', '').ToLowerInvariant()
      } finally {
        $sha.Dispose()
      }
    }
  } finally {
    $stream.Dispose()
  }
}

function Write-PinJson([string]$PinPath, [string]$PinnedName, [string]$Hex) {
  $json = '{"algorithm":"sha256","path":"' + $PinnedName + '","schema_version":1,"sha256":"' + $Hex + '"}'
  # Single-line JSON, LF terminator, no BOM — byte-stable and idempotent.
  [System.IO.File]::WriteAllText($PinPath, $json + "`n", [System.Text.UTF8Encoding]::new($false))
}

function Find-FrontmatterBoundary([byte[]]$Bytes) {
  # Mirrors src/sentinels.ts splitSkillFrontmatter: the first line must be a
  # standalone '---', and the body starts right after the next standalone
  # '---' line's newline. All indices are BYTE offsets; lines are decoded only
  # for the '---' comparison and never written back.
  $lf = [byte]10
  $utf8 = [System.Text.Encoding]::UTF8
  $firstLf = [Array]::IndexOf($Bytes, $lf)
  if ($firstLf -lt 3) { throw "SKILL.md does not start with a '---' frontmatter delimiter" }
  $firstLine = $utf8.GetString([byte[]]$Bytes[0..($firstLf - 1)]).TrimEnd("`r")
  if ($firstLine -ne '---') { throw "SKILL.md does not start with a '---' frontmatter delimiter" }
  $lineStart = $firstLf + 1
  while ($lineStart -le $Bytes.Length) {
    $nextLf = [Array]::IndexOf($Bytes, $lf, $lineStart)
    $lineEnd = if ($nextLf -lt 0) { $Bytes.Length } else { $nextLf }
    $line = if ($lineEnd -gt $lineStart) { $utf8.GetString([byte[]]$Bytes[$lineStart..($lineEnd - 1)]).TrimEnd("`r") } else { '' }
    if ($line -eq '---') {
      $bodyStart = if ($nextLf -lt 0) { $Bytes.Length } else { $nextLf + 1 }
      return [pscustomobject]@{
        FrontmatterStart = $firstLf + 1
        ClosingStart = $lineStart
        BodyStart = $bodyStart
      }
    }
    if ($nextLf -lt 0) { throw "SKILL.md frontmatter has no closing '---' delimiter" }
    $lineStart = $nextLf + 1
  }
  throw "SKILL.md frontmatter has no closing '---' delimiter"
}

function Update-SkillPin([string]$SkillPath) {
  $utf8 = [System.Text.Encoding]::UTF8
  $bytes = [System.IO.File]::ReadAllBytes($SkillPath)
  $boundary = Find-FrontmatterBoundary $bytes

  # Frontmatter is ASCII in this package; decode only this slice for editing.
  $frontmatter = $utf8.GetString([byte[]]$bytes[$boundary.FrontmatterStart..($boundary.ClosingStart - 1)])
  # Closing delimiter and body: raw byte slices, verbatim, never re-encoded.
  $closingLine = [byte[]]$bytes[$boundary.ClosingStart..($boundary.BodyStart - 1)]
  $bodyBytes = if ($boundary.BodyStart -lt $bytes.Length) { [byte[]]$bytes[$boundary.BodyStart..($bytes.Length - 1)] } else { [byte[]]@() }
  $bodyHash = Get-Hex $bodyBytes

  $pinLine = 'metadata: { pin: "sha256:' + $bodyHash + '" }'
  $metadataPattern = '(?m)^[ \t]*metadata:[^\r\n]*$'
  if ($frontmatter -match $metadataPattern) {
    $frontmatter = $frontmatter -replace $metadataPattern, $pinLine
  } else {
    $frontmatter = $frontmatter.TrimEnd([char]10, [char]13) + [char]10 + $pinLine + [char]10
  }

  # Reassemble byte-exactly: opening line (incl. its newline), edited
  # frontmatter, the verbatim closing delimiter, then the untouched body.
  $headBytes = [byte[]]$bytes[0..($boundary.FrontmatterStart - 1)]
  $newBytes = [byte[]]($headBytes + $utf8.GetBytes($frontmatter) + $closingLine + $bodyBytes)
  [System.IO.File]::WriteAllBytes($SkillPath, $newBytes)
  Write-Host ("  pin  SKILL.md body = sha256:{0}  (metadata.pin updated in frontmatter)" -f $bodyHash)
  return $bodyHash
}

# --- main --------------------------------------------------------------------

Write-Host "repin.ps1 — recomputing supply-chain pins for dsh-tool-underseal"
Write-Host "package root: $PackageRoot"

$verifier = Join-Path $PackageRoot 'python\underseal.py'
$verifierPin = Join-Path $PackageRoot 'python\underseal.pin.json'
$bundle = Join-Path $PackageRoot 'cordis.patch.yml'
$bundlePin = Join-Path $PackageRoot 'cordis.pin.json'
$skill = Join-Path $PackageRoot 'skills\underseal-delegation\SKILL.md'

foreach ($path in @($verifier, $bundle, $skill)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "missing pinned artifact: $path" }
}

# E1 — vendored verifier bytes
$verifierHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $verifier).Hash.ToLowerInvariant()
Write-PinJson $verifierPin 'underseal.py' $verifierHash
Write-Host ("  pin  underseal.py     = sha256:{0}" -f $verifierHash)

# E3 — bundle patch bytes
$bundleHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $bundle).Hash.ToLowerInvariant()
Write-PinJson $bundlePin 'cordis.patch.yml' $bundleHash
Write-Host ("  pin  cordis.patch.yml = sha256:{0}" -f $bundleHash)

# E2 — skill body bytes (frontmatter metadata.pin)
Update-SkillPin $skill | Out-Null

Write-Host ""
Write-Host "Done. Inspect the three pin values above — re-pinning is a NEW supply-chain review action."
