/**
 * Supply-chain sentinels for `dsh-tool-underseal` (HANDOFF §5, E1/E2/E3).
 *
 * Three small anti-forgery checks run from the plugin's `apply()` before any
 * tool is registered. The checks are pure functions over an injected minimal
 * synchronous read surface (byte reads + existence probes), so they run
 * without a DSH runtime in `tests/run-sentinel-tests.mjs` (which imports the
 * compiled `lib/sentinels.js`).
 *
 * Fail-closed semantics:
 *
 * - E1 (vendored verifier bytes) and E3 (bundle patch bytes) return a failing
 *   verdict on ANY anomaly — missing or unreadable artifact, missing or
 *   malformed pin document, or a hash mismatch — and `apply()` refuses to
 *   register the eight tools rather than run a drifted verifier or activate a
 *   drifted bundle layer. A missing `python/underseal_adapter.py` is treated
 *   the same way: the package must never fall back to unvetted adapter code.
 * - E2 (skill body) is advisory by design: the skill is guidance, not
 *   authority, so a drift or an unverifiable body returns `ok: false` and
 *   `apply()` downgrades it to a warning while still registering the tools.
 *
 * The expected hash for E1/E3 comes from reading the pin document itself, so
 * a damaged pin (bad JSON, wrong fields) is itself a fail-closed condition
 * rather than a silent "unpinned" state.
 *
 * @module dsh-tool-underseal/sentinels
 */

import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { TextDecoder } from 'node:util'

/** Minimal synchronous filesystem surface the sentinels need. */
export interface SentinelFs {
  /** Read one file's raw bytes; throw on failure (ENOENT means absent). */
  readFileBytes(path: string): Uint8Array
  /** Whether a path exists (any entry kind; the adapter is a regular file). */
  exists(path: string): boolean
}

/** Structured sentinel verdict: `ok` plus a stable machine `code` and a human `reason`. */
export interface SentinelResult {
  readonly ok: boolean
  readonly reason: string
  readonly code: string
}

/** Verified pin document shape (matches `python/underseal.pin.json` and `cordis.pin.json`). */
export interface PinDocument {
  readonly algorithm: string
  readonly path: string
  readonly schema_version: number
  readonly sha256: string
}

/** Outcome of parsing a pin document's bytes. */
export type PinParseResult =
  | { readonly ok: true; readonly pin: PinDocument }
  | { readonly ok: false; readonly reason: string; readonly code: string }

/** E1 — vendored verifier sentinel inputs. */
export interface VerifierSentinelInput {
  /** Absolute path to `python/underseal.py`. */
  readonly verifierPath: string
  /** Absolute path to `python/underseal_adapter.py`. */
  readonly adapterPath: string
  /** Absolute path to `python/underseal.pin.json`. */
  readonly pinPath: string
}

/** E3 — bundle patch sentinel inputs. */
export interface BundleSentinelInput {
  /** Absolute path to `cordis.patch.yml`. */
  readonly bundlePath: string
  /** Absolute path to `cordis.pin.json`. */
  readonly pinPath: string
}

/** Frontmatter split result: decoded frontmatter text plus the raw body byte slice. */
export interface SkillFrontmatterSplit {
  readonly frontmatter: string
  readonly body: Uint8Array
}

const SHA256_HEX = /^[0-9a-fA-F]{64}$/
const utf8 = new TextDecoder('utf-8')

/** SHA-256 of raw bytes as lowercase hex. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * E1 — vendored verifier byte sentinel (fail-closed).
 *
 * Requires the vendored adapter to exist and `python/underseal.py` to hash to
 * the sha256 pinned in `python/underseal.pin.json`.
 */
export function checkVerifierSentinel(fs: SentinelFs, input: VerifierSentinelInput): SentinelResult {
  const { verifierPath, adapterPath, pinPath } = input
  if (!fs.exists(adapterPath)) {
    return {
      ok: false,
      code: 'E1_ADAPTER_MISSING',
      reason: `vendored adapter ${adapterPath} is missing — refusing to run unvetted adapter code (E1 fail-closed)`,
    }
  }
  const pin = readPinDocument(fs, pinPath, basename(verifierPath), 'E1')
  if (!pin.ok) return pin.result
  const verifier = readOrFail(fs, 'E1', 'VERIFIER', verifierPath)
  if (!verifier.ok) return verifier.result
  const actual = sha256Hex(verifier.bytes)
  if (actual !== pin.pin.sha256) {
    return {
      ok: false,
      code: 'E1_HASH_MISMATCH',
      reason: `vendored verifier ${verifierPath} drifted: ${pinPath} pins sha256:${pin.pin.sha256} but the file hashes to sha256:${actual} — refusing to register tools (E1 fail-closed)`,
    }
  }
  return { ok: true, code: 'E1_OK', reason: `vendored verifier ${verifierPath} matches ${pinPath} (sha256:${actual})` }
}

/**
 * E3 — bundle patch byte sentinel (fail-closed).
 *
 * Requires `cordis.patch.yml` to hash to the sha256 pinned in `cordis.pin.json`,
 * so a tampered bundle layer can never activate silently.
 */
export function checkBundleSentinel(fs: SentinelFs, input: BundleSentinelInput): SentinelResult {
  const { bundlePath, pinPath } = input
  const pin = readPinDocument(fs, pinPath, basename(bundlePath), 'E3')
  if (!pin.ok) return pin.result
  const bundle = readOrFail(fs, 'E3', 'BUNDLE', bundlePath)
  if (!bundle.ok) return bundle.result
  const actual = sha256Hex(bundle.bytes)
  if (actual !== pin.pin.sha256) {
    return {
      ok: false,
      code: 'E3_HASH_MISMATCH',
      reason: `bundle patch ${bundlePath} drifted: ${pinPath} pins sha256:${pin.pin.sha256} but the file hashes to sha256:${actual} — refusing to activate the layer (E3 fail-closed)`,
    }
  }
  return { ok: true, code: 'E3_OK', reason: `bundle patch ${bundlePath} matches ${pinPath} (sha256:${actual})` }
}

/**
 * E2 — skill body pin (advisory).
 *
 * Hashes every byte of the SKILL.md body — the byte range after the closing
 * frontmatter `---` line, never re-encoded or trimmed — and compares it with
 * the `metadata.pin` value in the frontmatter. Any anomaly returns `ok: false`
 * (missing/unreadable file, no frontmatter, no pin, or a drifted body); the
 * caller downgrades that to a warning.
 */
export function checkSkillSentinel(fs: SentinelFs, skillPath: string): SentinelResult {
  let raw: Uint8Array
  try {
    raw = fs.readFileBytes(skillPath)
  } catch (error) {
    return isAbsentError(error)
      ? { ok: false, code: 'E2_SKILL_MISSING', reason: `skill ${skillPath} is missing — cannot verify the ceremony body` }
      : { ok: false, code: 'E2_SKILL_READ_FAILED', reason: `failed to read skill ${skillPath}: ${describeError(error)}` }
  }
  const split = splitSkillFrontmatter(raw)
  if (split === null) {
    return { ok: false, code: 'E2_NO_FRONTMATTER', reason: `skill ${skillPath} has no YAML frontmatter — cannot locate the pinned body` }
  }
  const pin = extractMetadataPin(split.frontmatter)
  if (pin === null) {
    return { ok: false, code: 'E2_NO_PIN', reason: `skill ${skillPath} frontmatter has no metadata.pin ("sha256:<hex>") — cannot verify the body` }
  }
  const actual = sha256Hex(split.body)
  if (actual !== pin) {
    return {
      ok: false,
      code: 'E2_HASH_MISMATCH',
      reason: `skill ${skillPath} body drifted: metadata.pin sha256:${pin} != recomputed sha256:${actual}`,
    }
  }
  return { ok: true, code: 'E2_OK', reason: `skill ${skillPath} body matches metadata.pin (sha256:${actual})` }
}

/**
 * Parse a pin document's bytes into a {@link PinDocument}.
 *
 * `expectedPinnedName` is the basename the `path` field must carry (e.g.
 * `underseal.py`). Any deviation — bad JSON, non-object, wrong algorithm,
 * wrong path, wrong schema_version, or a malformed sha256 — fails closed.
 */
export function parsePinDocument(raw: Uint8Array, expectedPinnedName: string): PinParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(utf8.decode(raw))
  } catch (error) {
    return { ok: false, reason: `is not valid JSON (${describeError(error)})`, code: 'PIN_MALFORMED' }
  }
  if (!isRecord(parsed)) {
    return { ok: false, reason: 'is not a JSON object', code: 'PIN_MALFORMED' }
  }
  const { algorithm, path, schema_version: schemaVersion, sha256 } = parsed
  if (algorithm !== 'sha256') {
    return { ok: false, reason: `algorithm is ${JSON.stringify(algorithm)}, expected "sha256"`, code: 'PIN_MALFORMED' }
  }
  if (path !== expectedPinnedName) {
    return { ok: false, reason: `path is ${JSON.stringify(path)}, expected ${JSON.stringify(expectedPinnedName)}`, code: 'PIN_MALFORMED' }
  }
  if (schemaVersion !== 1) {
    return { ok: false, reason: `schema_version is ${JSON.stringify(schemaVersion)}, expected 1`, code: 'PIN_MALFORMED' }
  }
  if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) {
    return { ok: false, reason: 'sha256 must be a 64-char hex string', code: 'PIN_MALFORMED' }
  }
  return {
    ok: true,
    pin: { algorithm, path, schema_version: schemaVersion, sha256: sha256.toLowerCase() },
  }
}

/**
 * Split raw SKILL.md bytes at the frontmatter boundary, mirroring the DSH
 * skill parser: the first line (a standalone `---`) opens the frontmatter and
 * the next standalone `---` line closes it. The body is every byte after that
 * closing line's newline, byte-for-byte (never re-encoded, never trimmed).
 * Returns `null` when there is no such boundary.
 */
export function splitSkillFrontmatter(raw: Uint8Array): SkillFrontmatterSplit | null {
  const firstLf = indexOfByte(raw, 0x0a)
  if (firstLf < 0) return null
  if (decodeLine(raw, 0, firstLf) !== '---') return null
  let lineStart = firstLf + 1
  while (lineStart <= raw.length) {
    const nextLf = indexOfByte(raw, 0x0a, lineStart)
    const lineEnd = nextLf < 0 ? raw.length : nextLf
    if (decodeLine(raw, lineStart, lineEnd) === '---') {
      const bodyStart = nextLf < 0 ? raw.length : nextLf + 1
      return {
        frontmatter: utf8.decode(raw.subarray(firstLf + 1, lineStart)),
        body: raw.subarray(bodyStart),
      }
    }
    if (nextLf < 0) return null
    lineStart = nextLf + 1
  }
  return null
}

/** Read `metadata: { pin: "sha256:<hex>" }` from a frontmatter slice. */
export function extractMetadataPin(frontmatter: string): string | null {
  for (const line of frontmatter.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('metadata:')) continue
    const match = /pin\s*:\s*"sha256:([0-9a-fA-F]{64})"/.exec(trimmed)
    if (match?.[1] !== undefined) return match[1].toLowerCase()
  }
  return null
}

// --- internals ---------------------------------------------------------------

type ReadOrFail =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly result: SentinelResult }

function readPinDocument(
  fs: SentinelFs,
  pinPath: string,
  pinnedName: string,
  prefix: 'E1' | 'E3',
): { readonly ok: true; readonly pin: PinDocument } | { readonly ok: false; readonly result: SentinelResult } {
  const raw = readOrFail(fs, prefix, 'PIN', pinPath)
  if (!raw.ok) return raw
  const parsed = parsePinDocument(raw.bytes, pinnedName)
  if (!parsed.ok) {
    return {
      ok: false,
      result: { ok: false, code: `${prefix}_PIN_MALFORMED`, reason: `${pinPath} ${parsed.reason} (${prefix} fail-closed)` },
    }
  }
  return { ok: true, pin: parsed.pin }
}

function readOrFail(fs: SentinelFs, prefix: 'E1' | 'E3', what: string, path: string): ReadOrFail {
  try {
    return { ok: true, bytes: fs.readFileBytes(path) }
  } catch (error) {
    return { ok: false, result: readFailure(prefix, what, path, error) }
  }
}

function readFailure(prefix: 'E1' | 'E3', what: string, path: string, error: unknown): SentinelResult {
  const label = `${prefix}_${what}`
  if (isAbsentError(error)) {
    return { ok: false, code: `${label}_MISSING`, reason: `${what.toLowerCase()} ${path} is missing (${prefix} fail-closed)` }
  }
  return { ok: false, code: `${label}_READ_FAILED`, reason: `failed to read ${what.toLowerCase()} ${path}: ${describeError(error)} (${prefix} fail-closed)` }
}

function indexOfByte(bytes: Uint8Array, value: number, from = 0): number {
  for (let i = from; i < bytes.length; i++) {
    if (bytes[i] === value) return i
  }
  return -1
}

function decodeLine(bytes: Uint8Array, start: number, end: number): string {
  let line = utf8.decode(bytes.subarray(start, end))
  if (line.endsWith('\r')) line = line.slice(0, -1)
  return line
}

function isAbsentError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
