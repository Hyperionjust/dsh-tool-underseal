#!/usr/bin/env node
/**
 * Self-asserting tests for the supply-chain sentinels (HANDOFF §5 E1/E2/E3).
 *
 * Imports the compiled pure core (`lib/sentinels.js`) — no DSH runtime, no
 * test runner, no subprocess spawning: plain assertions, exit code = result.
 * Run from the package root:  node tests/run-sentinel-tests.mjs
 *
 * All tampering happens on COPY fixtures under tests/.tmp-sentinel-*: the
 * real `python/underseal.py`, `python/underseal.pin.json`,
 * `python/underseal_adapter.py`, `cordis.patch.yml`, `cordis.pin.json`, and
 * `SKILL.md` bytes are never modified — only read (for copying and for the
 * end-to-end "real package passes" check).
 */

import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  checkBundleSentinel,
  checkSkillSentinel,
  checkVerifierSentinel,
  extractMetadataPin,
  parsePinDocument,
  sha256Hex,
  splitSkillFrontmatter,
} from '../lib/sentinels.js'

// --- harness ----------------------------------------------------------------

let passed = 0
let failed = 0
const failures = []

function check(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed++
    failures.push({ name, error })
    console.error(`  FAIL ${name}\n       ${error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n       ') : error}`)
  }
}

function scenario(name) {
  console.log(`\n[${name}]`)
}

// --- fixtures ----------------------------------------------------------------

const TESTS_DIR = fileURLToPath(new URL('.', import.meta.url))
const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
const TMP_ROOT = mkdtempSync(join(TESTS_DIR, '.tmp-sentinel-'))

const REAL = {
  verifier: join(PKG_ROOT, 'python', 'underseal.py'),
  adapter: join(PKG_ROOT, 'python', 'underseal_adapter.py'),
  verifierPin: join(PKG_ROOT, 'python', 'underseal.pin.json'),
  bundle: join(PKG_ROOT, 'cordis.patch.yml'),
  bundlePin: join(PKG_ROOT, 'cordis.pin.json'),
  skill: join(PKG_ROOT, 'skills', 'underseal-delegation', 'SKILL.md'),
}

const FIX = join(TMP_ROOT, 'pkg')
mkdirSync(join(FIX, 'python'), { recursive: true })
mkdirSync(join(FIX, 'skills', 'underseal-delegation'), { recursive: true })

const F = {
  verifier: join(FIX, 'python', 'underseal.py'),
  adapter: join(FIX, 'python', 'underseal_adapter.py'),
  verifierPin: join(FIX, 'python', 'underseal.pin.json'),
  bundle: join(FIX, 'cordis.patch.yml'),
  bundlePin: join(FIX, 'cordis.pin.json'),
  skill: join(FIX, 'skills', 'underseal-delegation', 'SKILL.md'),
}

/** Re-create the pristine copy fixture from the real package bytes. */
function restoreFixture() {
  for (const key of Object.keys(REAL)) copyFileSync(REAL[key], F[key])
}

restoreFixture()

/** Real node:fs adapter matching the SentinelFs contract. */
const realFs = {
  readFileBytes: (p) => new Uint8Array(readFileSync(p)),
  exists: (p) => existsSync(p),
}

/** Flip the last byte of a fixture file (drift simulation). */
function flipLastByte(path) {
  const bytes = readFileSync(path)
  bytes[bytes.length - 1] ^= 0xff
  writeFileSync(path, bytes)
}

const SHA256_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'

scenario('(a) E1 — vendored verifier byte sentinel (fail-closed)')
{
  check('pristine fixture → E1_OK', () => {
    const r = checkVerifierSentinel(realFs, { verifierPath: F.verifier, adapterPath: F.adapter, pinPath: F.verifierPin })
    assert.equal(r.ok, true)
    assert.equal(r.code, 'E1_OK')
  })
  check('one flipped byte in underseal.py → E1_HASH_MISMATCH', () => {
    flipLastByte(F.verifier)
    const r = checkVerifierSentinel(realFs, { verifierPath: F.verifier, adapterPath: F.adapter, pinPath: F.verifierPin })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'E1_HASH_MISMATCH')
    assert.match(r.reason, /drifted/)
    restoreFixture()
    assert.equal(checkVerifierSentinel(realFs, { verifierPath: F.verifier, adapterPath: F.adapter, pinPath: F.verifierPin }).ok, true)
  })
  check('missing underseal_adapter.py → E1_ADAPTER_MISSING', () => {
    rmSync(F.adapter, { force: true })
    const r = checkVerifierSentinel(realFs, { verifierPath: F.verifier, adapterPath: F.adapter, pinPath: F.verifierPin })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'E1_ADAPTER_MISSING')
    restoreFixture()
  })
  check('missing underseal.py → E1_VERIFIER_MISSING', () => {
    rmSync(F.verifier, { force: true })
    const r = checkVerifierSentinel(realFs, { verifierPath: F.verifier, adapterPath: F.adapter, pinPath: F.verifierPin })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'E1_VERIFIER_MISSING')
    restoreFixture()
  })
  check('missing underseal.pin.json → E1_PIN_MISSING', () => {
    rmSync(F.verifierPin, { force: true })
    const r = checkVerifierSentinel(realFs, { verifierPath: F.verifier, adapterPath: F.adapter, pinPath: F.verifierPin })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'E1_PIN_MISSING')
    restoreFixture()
  })
  check('garbage pin bytes → E1_PIN_MALFORMED', () => {
    writeFileSync(F.verifierPin, 'not json at all{{')
    const r = checkVerifierSentinel(realFs, { verifierPath: F.verifier, adapterPath: F.adapter, pinPath: F.verifierPin })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'E1_PIN_MALFORMED')
    restoreFixture()
  })
  check('pin with a wrong-but-valid sha256 → E1_HASH_MISMATCH', () => {
    writeFileSync(F.verifierPin, '{"algorithm":"sha256","path":"underseal.py","schema_version":1,"sha256":"' + 'a'.repeat(64) + '"}')
    const r = checkVerifierSentinel(realFs, { verifierPath: F.verifier, adapterPath: F.adapter, pinPath: F.verifierPin })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'E1_HASH_MISMATCH')
    restoreFixture()
  })
  check('pin with wrong algorithm → E1_PIN_MALFORMED', () => {
    writeFileSync(F.verifierPin, '{"algorithm":"sha1","path":"underseal.py","schema_version":1,"sha256":"' + 'a'.repeat(64) + '"}')
    const r = checkVerifierSentinel(realFs, { verifierPath: F.verifier, adapterPath: F.adapter, pinPath: F.verifierPin })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'E1_PIN_MALFORMED')
    restoreFixture()
  })
  check('pin with wrong path field → E1_PIN_MALFORMED', () => {
    writeFileSync(F.verifierPin, '{"algorithm":"sha256","path":"other.py","schema_version":1,"sha256":"' + 'a'.repeat(64) + '"}')
    const r = checkVerifierSentinel(realFs, { verifierPath: F.verifier, adapterPath: F.adapter, pinPath: F.verifierPin })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'E1_PIN_MALFORMED')
    restoreFixture()
  })
  check('pin with wrong schema_version → E1_PIN_MALFORMED', () => {
    writeFileSync(F.verifierPin, '{"algorithm":"sha256","path":"underseal.py","schema_version":2,"sha256":"' + 'a'.repeat(64) + '"}')
    const r = checkVerifierSentinel(realFs, { verifierPath: F.verifier, adapterPath: F.adapter, pinPath: F.verifierPin })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'E1_PIN_MALFORMED')
    restoreFixture()
  })
  check('pin with short sha256 → E1_PIN_MALFORMED', () => {
    writeFileSync(F.verifierPin, '{"algorithm":"sha256","path":"underseal.py","schema_version":1,"sha256":"abc"}')
    const r = checkVerifierSentinel(realFs, { verifierPath: F.verifier, adapterPath: F.adapter, pinPath: F.verifierPin })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'E1_PIN_MALFORMED')
    restoreFixture()
  })
}

scenario('(b) E3 — bundle patch byte sentinel (fail-closed)')
{
  check('pristine fixture → E3_OK', () => {
    const r = checkBundleSentinel(realFs, { bundlePath: F.bundle, pinPath: F.bundlePin })
    assert.equal(r.ok, true)
    assert.equal(r.code, 'E3_OK')
  })
  check('one flipped byte in cordis.patch.yml → E3_HASH_MISMATCH', () => {
    flipLastByte(F.bundle)
    const r = checkBundleSentinel(realFs, { bundlePath: F.bundle, pinPath: F.bundlePin })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'E3_HASH_MISMATCH')
    assert.match(r.reason, /drifted/)
    restoreFixture()
    assert.equal(checkBundleSentinel(realFs, { bundlePath: F.bundle, pinPath: F.bundlePin }).ok, true)
  })
  check('missing cordis.pin.json → E3_PIN_MISSING', () => {
    rmSync(F.bundlePin, { force: true })
    const r = checkBundleSentinel(realFs, { bundlePath: F.bundle, pinPath: F.bundlePin })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'E3_PIN_MISSING')
    restoreFixture()
  })
  check('corrupt cordis.pin.json (missing field) → E3_PIN_MALFORMED', () => {
    writeFileSync(F.bundlePin, '{"algorithm":"sha256","path":"cordis.patch.yml"}')
    const r = checkBundleSentinel(realFs, { bundlePath: F.bundle, pinPath: F.bundlePin })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'E3_PIN_MALFORMED')
    restoreFixture()
  })
  check('missing cordis.patch.yml → E3_BUNDLE_MISSING', () => {
    rmSync(F.bundle, { force: true })
    const r = checkBundleSentinel(realFs, { bundlePath: F.bundle, pinPath: F.bundlePin })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'E3_BUNDLE_MISSING')
    restoreFixture()
  })
}

scenario('(c) E2 — skill body pin (advisory)')
{
  check('pristine fixture → E2_OK', () => {
    const r = checkSkillSentinel(realFs, F.skill)
    assert.equal(r.ok, true)
    assert.equal(r.code, 'E2_OK')
  })
  check('body drift (appended byte) → E2_HASH_MISMATCH (warning-grade verdict)', () => {
    writeFileSync(F.skill, Buffer.concat([readFileSync(F.skill), Buffer.from('x')]))
    const r = checkSkillSentinel(realFs, F.skill)
    assert.equal(r.ok, false)
    assert.equal(r.code, 'E2_HASH_MISMATCH')
    assert.match(r.reason, /drifted/)
    restoreFixture()
    assert.equal(checkSkillSentinel(realFs, F.skill).ok, true)
  })
  check('missing SKILL.md → E2_SKILL_MISSING', () => {
    rmSync(F.skill, { force: true })
    const r = checkSkillSentinel(realFs, F.skill)
    assert.equal(r.ok, false)
    assert.equal(r.code, 'E2_SKILL_MISSING')
    restoreFixture()
  })
  check('no frontmatter → E2_NO_FRONTMATTER', () => {
    writeFileSync(F.skill, '# No frontmatter here\n', 'utf8')
    const r = checkSkillSentinel(realFs, F.skill)
    assert.equal(r.ok, false)
    assert.equal(r.code, 'E2_NO_FRONTMATTER')
    restoreFixture()
  })
  check('frontmatter without closing delimiter → E2_NO_FRONTMATTER', () => {
    writeFileSync(F.skill, '---\nname: x\ndescription: y\nmetadata: { pin: "sha256:' + 'a'.repeat(64) + '" }\n# body\n', 'utf8')
    const r = checkSkillSentinel(realFs, F.skill)
    assert.equal(r.ok, false)
    assert.equal(r.code, 'E2_NO_FRONTMATTER')
    restoreFixture()
  })
  check('frontmatter without metadata.pin → E2_NO_PIN', () => {
    const text = readFileSync(F.skill, 'utf8')
    writeFileSync(F.skill, text.replace(/^[ \t]*metadata:[^\r\n]*$/m, ''), 'utf8')
    const r = checkSkillSentinel(realFs, F.skill)
    assert.equal(r.ok, false)
    assert.equal(r.code, 'E2_NO_PIN')
    restoreFixture()
  })
  check('metadata.pin with a wrong-but-valid hash → E2_HASH_MISMATCH', () => {
    const text = readFileSync(F.skill, 'utf8')
    writeFileSync(F.skill, text.replace(/sha256:[0-9a-f]{64}/, 'sha256:' + 'b'.repeat(64)), 'utf8')
    const r = checkSkillSentinel(realFs, F.skill)
    assert.equal(r.ok, false)
    assert.equal(r.code, 'E2_HASH_MISMATCH')
    restoreFixture()
  })
}

scenario('(d) pure units')
{
  check('sha256Hex known vector (abc)', () => {
    assert.equal(sha256Hex(new TextEncoder().encode('abc')), SHA256_ABC)
  })
  check('parsePinDocument accepts the exact pin shape and lowercases sha256', () => {
    const r = parsePinDocument(new TextEncoder().encode('{"algorithm":"sha256","path":"underseal.py","schema_version":1,"sha256":"ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789"}'), 'underseal.py')
    assert.equal(r.ok, true)
    if (r.ok) {
      assert.equal(r.pin.algorithm, 'sha256')
      assert.equal(r.pin.path, 'underseal.py')
      assert.equal(r.pin.schema_version, 1)
      assert.equal(r.pin.sha256, 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789')
    }
  })
  check('parsePinDocument rejects non-JSON', () => {
    const r = parsePinDocument(new TextEncoder().encode('{oops'), 'underseal.py')
    assert.equal(r.ok, false)
    assert.equal(r.code, 'PIN_MALFORMED')
  })
  check('parsePinDocument rejects a JSON array', () => {
    const r = parsePinDocument(new TextEncoder().encode('[1,2,3]'), 'underseal.py')
    assert.equal(r.ok, false)
    assert.equal(r.code, 'PIN_MALFORMED')
  })
  check('parsePinDocument rejects wrong algorithm/path/schema_version/sha256', () => {
    assert.equal(parsePinDocument(new TextEncoder().encode('{"algorithm":"md5","path":"underseal.py","schema_version":1,"sha256":"' + 'a'.repeat(64) + '"}'), 'underseal.py').ok, false)
    assert.equal(parsePinDocument(new TextEncoder().encode('{"algorithm":"sha256","path":"x.py","schema_version":1,"sha256":"' + 'a'.repeat(64) + '"}'), 'underseal.py').ok, false)
    assert.equal(parsePinDocument(new TextEncoder().encode('{"algorithm":"sha256","path":"underseal.py","schema_version":0,"sha256":"' + 'a'.repeat(64) + '"}'), 'underseal.py').ok, false)
    assert.equal(parsePinDocument(new TextEncoder().encode('{"algorithm":"sha256","path":"underseal.py","schema_version":1,"sha256":"xyz"}'), 'underseal.py').ok, false)
    assert.equal(parsePinDocument(new TextEncoder().encode('{"algorithm":"sha256","path":"underseal.py","schema_version":1,"sha256":"' + 'z'.repeat(64) + '"}'), 'underseal.py').ok, false)
  })
  check('splitSkillFrontmatter mirrors the DSH boundary (body after closing --- newline)', () => {
    const raw = new TextEncoder().encode('---\nname: x\ndescription: y\n---\n\n# body\n')
    const split = splitSkillFrontmatter(raw)
    assert.notEqual(split, null)
    if (split) {
      assert.equal(split.frontmatter, 'name: x\ndescription: y\n')
      assert.equal(new TextDecoder().decode(split.body), '\n# body\n')
    }
  })
  check('splitSkillFrontmatter returns null without frontmatter / without closing delimiter', () => {
    assert.equal(splitSkillFrontmatter(new TextEncoder().encode('no frontmatter\n')), null)
    assert.equal(splitSkillFrontmatter(new TextEncoder().encode('---\nname: x\n')), null)
    assert.equal(splitSkillFrontmatter(new TextEncoder().encode('---')), null)
  })
  check('splitSkillFrontmatter handles CRLF opening and closing delimiters', () => {
    const raw = new TextEncoder().encode('---\r\nname: x\r\n---\r\n\r\nbody\r\n')
    const split = splitSkillFrontmatter(raw)
    assert.notEqual(split, null)
    if (split) assert.equal(new TextDecoder().decode(split.body), '\r\nbody\r\n')
  })
  check('extractMetadataPin reads sha256 from a metadata line', () => {
    assert.equal(extractMetadataPin('name: x\nmetadata: { pin: "sha256:ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789" }\n'), 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789')
    assert.equal(extractMetadataPin('name: x\n'), null)
    assert.equal(extractMetadataPin('metadata: { other: 1 }\n'), null)
    assert.equal(extractMetadataPin('metadata: { pin: "sha256:short" }\n'), null)
  })
  check('fixture SKILL.md body begins with the blank line after the closing delimiter', () => {
    const split = splitSkillFrontmatter(new Uint8Array(readFileSync(F.skill)))
    assert.notEqual(split, null)
    if (split) {
      const head = new TextDecoder().decode(split.body.subarray(0, 24))
      assert.equal(head, '\n# Underseal Delegation\n')
    }
  })
}

scenario('(e) real package consistency (read-only; sentinel/re-pin parity)')
{
  check('real underseal.py matches python/underseal.pin.json', () => {
    const r = checkVerifierSentinel(realFs, { verifierPath: REAL.verifier, adapterPath: REAL.adapter, pinPath: REAL.verifierPin })
    assert.equal(r.ok, true)
    assert.equal(r.code, 'E1_OK')
  })
  check('real cordis.patch.yml matches cordis.pin.json', () => {
    const r = checkBundleSentinel(realFs, { bundlePath: REAL.bundle, pinPath: REAL.bundlePin })
    assert.equal(r.ok, true)
    assert.equal(r.code, 'E3_OK')
  })
  check('real SKILL.md body matches its metadata.pin', () => {
    const r = checkSkillSentinel(realFs, REAL.skill)
    assert.equal(r.ok, true)
    assert.equal(r.code, 'E2_OK')
  })
  check('repin-produced metadata line has the canonical shape', () => {
    const split = splitSkillFrontmatter(new Uint8Array(readFileSync(REAL.skill)))
    assert.notEqual(split, null)
    if (split) {
      assert.match(split.frontmatter, /^metadata: \{ pin: "sha256:[0-9a-f]{64}" \}$/m)
    }
  })
}

scenario('(f) manifest wiring sanity')
{
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))
  check('package.json files ship sentinels + pins + repin script', () => {
    assert.ok(pkg.files.includes('lib/sentinels.js'))
    assert.ok(pkg.files.includes('cordis.pin.json'))
    assert.ok(pkg.files.includes('scripts/repin.ps1'))
  })
  check('compiled lib artifacts exist', () => {
    readFileSync(join(PKG_ROOT, 'lib', 'sentinels.js'), 'utf8')
    readFileSync(join(PKG_ROOT, 'lib', 'types', 'sentinels.d.ts'), 'utf8')
  })
}

// --- teardown + summary ---------------------------------------------------------

rmSync(TMP_ROOT, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const { name, error } of failures) console.error(`FAILED: ${name} — ${error.message}`)
  process.exitCode = 1
}
