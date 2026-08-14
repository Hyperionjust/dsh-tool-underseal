#!/usr/bin/env node
/**
 * Self-asserting tests for the underseal worker check-in lock decision core.
 *
 * Imports the compiled pure core (`lib/guard-core.js`) — no DSH runtime, no
 * test runner, no subprocess spawning: plain assertions, exit code = result.
 * Run from the package root:  node tests/run-guard-tests.mjs
 *
 * Fixture repositories are generated at runtime under tests/.tmp-guard-* and
 * removed afterwards. The JSON shapes mirror the real underseal artifacts
 * (assignment / dispatch binding / events jsonl as produced by the frozen
 * adapter and observed in the smoke field).
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateGuard, findRepoRoot, isAbsentError, classifyDispatchGeneration, isPathInside } from '../lib/guard-core.js'

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
const TMP_ROOT = mkdtempSync(join(TESTS_DIR, '.tmp-guard-'))

/** Real node:fs adapter matching the GuardFs contract. */
const realFs = {
  stat: (p) => {
    const s = statSync(p)
    return { isDirectory: s.isDirectory() }
  },
  readdir: (p) => readdirSync(p),
  readFile: (p) => readFileSync(p, 'utf8'),
}

/** Wrap realFs, injecting failures on selected calls. */
function fakeFs({ statThrow, readdirThrow, readFileThrow } = {}) {
  return {
    stat: (p) => {
      const err = statThrow && statThrow(p)
      if (err) throw err
      return realFs.stat(p)
    },
    readdir: (p) => {
      const err = readdirThrow && readdirThrow(p)
      if (err) throw err
      return realFs.readdir(p)
    },
    readFile: (p) => {
      const err = readFileThrow && readFileThrow(p)
      if (err) throw err
      return realFs.readFile(p)
    },
  }
}

const errWithCode = (code, message) => Object.assign(new Error(message), { code })

const ASSIGNMENT = (overrides = {}) => ({
  schema_version: 1,
  document_type: 'underseal.assignment',
  assignment_id: 'US-TEST-0001',
  task_name: 'worker_task_alpha',
  revision: 1,
  ceremony: 'full',
  mode: 'mechanical',
  role: 'deepseek_coder',
  workspace: 'C:\\repo',
  path_profile: 'windows-strict',
  control_paths: ['.underseal', '.underseal-runs', '.git'],
  gate: { status: 'OPEN', resolved_by: 'principal' },
  objective: 'append exactly one line to note.txt',
  constraints: [],
  forbidden_changes: [],
  external_effects: [],
  progress: { path: '.underseal-runs/worker_task_alpha.events.jsonl', required: true },
  terminal_states: ['DONE', 'CHECKPOINT', 'BLOCKER_TO_LEAD', 'CONFLICT_TO_LEAD'],
  recovery: { previous_task_name: null, preserve_existing_work: false },
  targets: [{ path: 'note.txt', expected_base: 'ABSENT' }],
  required_behavior: 'create note.txt',
  acceptance_commands: ['git --no-pager diff --name-only HEAD'],
  ...overrides,
})

const DISPATCH = (overrides = {}) => ({
  activation_kind: 'INITIAL',
  assignment_document: { algorithm: 'sha256', hash_kind: 'assignment_document', value: 'a'.repeat(64) },
  assignment_id: 'US-TEST-0001',
  binding_document: { algorithm: 'sha256', hash_kind: 'dispatch_binding', value: 'b'.repeat(64) },
  dispatch_id: 'US-TEST-0001',
  document_type: 'underseal.dispatch_binding',
  generation: 1,
  mode: 'mechanical',
  receipt_document: { algorithm: 'sha256', hash_kind: 'receipt_document', value: 'c'.repeat(64) },
  resume: null,
  revision: 1,
  role: 'deepseek_coder',
  schema_version: 1,
  task_name: 'worker_task_alpha',
  workspace: 'C:\\repo',
  ...overrides,
})

const READY_EVENT = { assignment_document_sha256: 'a'.repeat(64), dispatch_binding_sha256: 'b'.repeat(64), dispatch_id: 'US-TEST-0001', seq: 1, state: 'READY', summary: 'activated', task_name: 'worker_task_alpha' }
const PROGRESS_EVENT = { assignment_document_sha256: 'a'.repeat(64), dispatch_binding_sha256: 'b'.repeat(64), dispatch_id: 'US-TEST-0001', seq: 2, state: 'PROGRESS', summary: 'working', task_name: 'worker_task_alpha' }

let repoCounter = 0

/**
 * Build a fixture repository.
 * @param {object} opts
 * @param {object} opts.assignment assignment JSON (task_name/role drive the filenames)
 * @param {object|null} opts.dispatch current dispatch JSON, or null to omit the file
 * @param {Array<object>|null} opts.events event lines for the events jsonl, or null to omit the file
 * @param {boolean} opts.withGit whether to create a .git marker
 * @returns {{root: string, task: string, role: string}}
 */
function buildRepo({ assignment = ASSIGNMENT(), dispatch = DISPATCH(), events = null, withGit = true } = {}) {
  const root = join(TMP_ROOT, `repo-${++repoCounter}`)
  if (withGit) mkdirSync(join(root, '.git'), { recursive: true })
  mkdirSync(join(root, '.underseal', 'assignments'), { recursive: true })
  mkdirSync(join(root, '.underseal', 'dispatch'), { recursive: true })
  mkdirSync(join(root, '.underseal-runs'), { recursive: true })
  const task = assignment.task_name
  const role = assignment.role
  writeFileSync(join(root, '.underseal', 'assignments', `${task}.assignment.json`), JSON.stringify(assignment, null, 2))
  if (dispatch !== null) {
    writeFileSync(join(root, '.underseal', 'dispatch', `${role}.current.json`), JSON.stringify(dispatch))
  }
  if (events !== null) {
    writeFileSync(join(root, '.underseal-runs', `${task}.events.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
  }
  return { root, task, role }
}

const BLOCKED = ['write', 'edit', 'pwsh', 'bash']
const inputs = (root) => ({ cwd: root, toolName: 'write', blockedTools: BLOCKED })

// --- scenarios ----------------------------------------------------------------

scenario('(a) OPEN full + INITIAL dispatch + no READY → block write/edit/pwsh/bash')
{
  const r = buildRepo()
  for (const tool of BLOCKED) {
    check(`denies ${tool}`, () => {
      const v = evaluateGuard(realFs, { cwd: r.root, toolName: tool, blockedTools: BLOCKED })
      assert.equal(v.deny, true)
      assert.match(v.reason, /underseal_start/)
      assert.match(v.reason, /worker_task_alpha/)
      assert.match(v.reason, /deepseek_coder/)
      assert.match(v.reason, new RegExp(`${tool} denied`))
    })
  }
  check('nested cwd still finds the repository root', () => {
    const nested = join(r.root, 'sub', 'deep')
    mkdirSync(nested, { recursive: true })
    const v = evaluateGuard(realFs, { cwd: nested, toolName: 'write', blockedTools: BLOCKED })
    assert.equal(v.deny, true)
  })
  check('events file with only non-READY lines still blocks', () => {
    const r2 = buildRepo({ events: [PROGRESS_EVENT] })
    const v = evaluateGuard(realFs, inputs(r2.root))
    assert.equal(v.deny, true)
  })
}

scenario('(b) READY line present → allow')
{
  const r = buildRepo({ events: [READY_EVENT] })
  for (const tool of BLOCKED) {
    check(`allows ${tool} after READY`, () => {
      const v = evaluateGuard(realFs, { cwd: r.root, toolName: tool, blockedTools: BLOCKED })
      assert.equal(v.deny, false)
    })
  }
}

scenario('(c) read failures → fail-closed denial')
{
  const r = buildRepo()
  const errEacces = errWithCode('EACCES', 'permission denied')
  check('dispatch read EACCES rejects', () => {
    const fs = fakeFs({
      readFileThrow: (p) => (p.includes('dispatch') && p.endsWith('.current.json') ? errEacces : null),
    })
    const v = evaluateGuard(fs, inputs(r.root))
    assert.equal(v.deny, true)
    assert.match(v.reason, /fail-closed/)
  })
  check('assignments readdir EACCES rejects', () => {
    const fs = fakeFs({ readdirThrow: (p) => (p.endsWith('assignments') ? errEacces : null) })
    const v = evaluateGuard(fs, inputs(r.root))
    assert.equal(v.deny, true)
    assert.match(v.reason, /fail-closed/)
  })
  check('assignment read EIO rejects', () => {
    const fs = fakeFs({
      readFileThrow: (p) => (p.endsWith('.assignment.json') ? errWithCode('EIO', 'input/output error') : null),
    })
    const v = evaluateGuard(fs, inputs(r.root))
    assert.equal(v.deny, true)
    assert.match(v.reason, /fail-closed/)
  })
  check('mid-walk .git stat EACCES rejects', () => {
    const fs = fakeFs({
      statThrow: (p) => (p.endsWith('.git') ? errEacces : null),
    })
    const v = evaluateGuard(fs, inputs(r.root))
    assert.equal(v.deny, true)
    assert.match(v.reason, /fail-closed/)
  })
  check('malformed assignment JSON rejects', () => {
    const r2 = buildRepo()
    writeFileSync(join(r2.root, '.underseal', 'assignments', `${r2.task}.assignment.json`), '{ not json')
    const v = evaluateGuard(realFs, inputs(r2.root))
    assert.equal(v.deny, true)
    assert.match(v.reason, /fail-closed/)
  })
  check('non-final malformed events line → fail-closed deny (corruption)', () => {
    const r2 = buildRepo({ events: [READY_EVENT] })
    writeFileSync(join(r2.root, '.underseal-runs', `${r2.task}.events.jsonl`), JSON.stringify(READY_EVENT) + '\n{ broken line\n' + JSON.stringify(PROGRESS_EVENT) + '\n')
    const v = evaluateGuard(realFs, inputs(r2.root))
    assert.equal(v.deny, true)
    assert.match(v.reason, /fail-closed/)
  })
}

scenario('(c2) torn final write tolerated')
{
  check('torn final line after READY → READY still detected → allow', () => {
    const r = buildRepo({ events: [READY_EVENT] })
    writeFileSync(join(r.root, '.underseal-runs', `${r.task}.events.jsonl`), JSON.stringify(READY_EVENT) + '\n{"seq":9,"state":"PROG')
    assert.equal(evaluateGuard(realFs, inputs(r.root)).deny, false)
  })
  check('torn final line without READY → treated as non-READY → deny', () => {
    const r = buildRepo({ events: [PROGRESS_EVENT] })
    writeFileSync(join(r.root, '.underseal-runs', `${r.task}.events.jsonl`), JSON.stringify(PROGRESS_EVENT) + '\n{"seq":9,"state":"PROG')
    const v = evaluateGuard(realFs, inputs(r.root))
    assert.equal(v.deny, true)
    assert.match(v.reason, /underseal_start/)
  })
  check('torn final line with trailing newline (empty tail segment) → tolerated → allow', () => {
    const r = buildRepo({ events: [READY_EVENT] })
    writeFileSync(join(r.root, '.underseal-runs', `${r.task}.events.jsonl`), JSON.stringify(READY_EVENT) + '\n{"seq":9,"state":"PROG\n')
    assert.equal(evaluateGuard(realFs, inputs(r.root)).deny, false)
  })
}

scenario('(c3) progress.path event location')
{
  check('progress.path custom file with READY → allow', () => {
    const r = buildRepo({ assignment: ASSIGNMENT({ progress: { path: 'custom/events.jsonl', required: true } }) })
    mkdirSync(join(r.root, 'custom'), { recursive: true })
    writeFileSync(join(r.root, 'custom', 'events.jsonl'), JSON.stringify(READY_EVENT) + '\n')
    assert.equal(evaluateGuard(realFs, inputs(r.root)).deny, false)
  })
  check('progress.path custom file without READY wins over convention READY → deny', () => {
    const r = buildRepo({
      assignment: ASSIGNMENT({ progress: { path: 'custom/events.jsonl', required: true } }),
      events: [READY_EVENT], // READY sits at the CONVENTION path — must be ignored
    })
    mkdirSync(join(r.root, 'custom'), { recursive: true })
    writeFileSync(join(r.root, 'custom', 'events.jsonl'), JSON.stringify(PROGRESS_EVENT) + '\n')
    const v = evaluateGuard(realFs, inputs(r.root))
    assert.equal(v.deny, true)
    assert.match(v.reason, /underseal_start/)
  })
  check('progress missing → convention path used → allow', () => {
    const r = buildRepo({ assignment: ASSIGNMENT({ progress: undefined }), events: [READY_EVENT] })
    assert.equal(evaluateGuard(realFs, inputs(r.root)).deny, false)
  })
  check('progress.path empty string → fallback convention → allow', () => {
    const r = buildRepo({ assignment: ASSIGNMENT({ progress: { path: '', required: true } }), events: [READY_EVENT] })
    assert.equal(evaluateGuard(realFs, inputs(r.root)).deny, false)
  })
  check('progress.path non-string → fallback convention → allow', () => {
    const r = buildRepo({ assignment: ASSIGNMENT({ progress: { path: 123, required: true } }), events: [READY_EVENT] })
    assert.equal(evaluateGuard(realFs, inputs(r.root)).deny, false)
  })
}

scenario('(d) not blocked: lite / no assignment / CLOSED / no .git / no cwd / non-blocked tool')
{
  check('lite ceremony → allow', () => {
    const r = buildRepo({ assignment: ASSIGNMENT({ ceremony: 'lite' }) })
    assert.equal(evaluateGuard(realFs, inputs(r.root)).deny, false)
  })
  check('no assignments directory → allow', () => {
    const root = join(TMP_ROOT, `repo-${++repoCounter}-noassign`)
    mkdirSync(join(root, '.git'), { recursive: true })
    const v = evaluateGuard(realFs, { cwd: root, toolName: 'write', blockedTools: BLOCKED })
    assert.equal(v.deny, false)
  })
  check('empty assignments directory → allow', () => {
    const root = join(TMP_ROOT, `repo-${++repoCounter}-emptyassign`)
    mkdirSync(join(root, '.git'), { recursive: true })
    mkdirSync(join(root, '.underseal', 'assignments'), { recursive: true })
    const v = evaluateGuard(realFs, { cwd: root, toolName: 'write', blockedTools: BLOCKED })
    assert.equal(v.deny, false)
  })
  check('gate CLOSED → allow', () => {
    const r = buildRepo({ assignment: ASSIGNMENT({ gate: { status: 'CLOSED', resolved_by: 'principal' } }) })
    assert.equal(evaluateGuard(realFs, inputs(r.root)).deny, false)
  })
  check('gate missing → fail-closed deny', () => {
    const r = buildRepo({ assignment: ASSIGNMENT({ gate: undefined }) })
    const v = evaluateGuard(realFs, inputs(r.root))
    assert.equal(v.deny, true)
    assert.match(v.reason, /fail-closed/)
    assert.match(v.reason, /cannot classify assignment gate/)
  })
  check('gate non-record → fail-closed deny', () => {
    const r = buildRepo({ assignment: ASSIGNMENT({ gate: 'OPEN' }) })
    const v = evaluateGuard(realFs, inputs(r.root))
    assert.equal(v.deny, true)
    assert.match(v.reason, /fail-closed/)
  })
  check('gate.status unknown value → fail-closed deny', () => {
    const r = buildRepo({ assignment: ASSIGNMENT({ gate: { status: 'PENDING', resolved_by: 'principal' } }) })
    const v = evaluateGuard(realFs, inputs(r.root))
    assert.equal(v.deny, true)
    assert.match(v.reason, /fail-closed/)
    assert.match(v.reason, /cannot classify assignment gate status/)
  })
  check('no .git anywhere → allow', () => {
    const root = join(TMP_ROOT, `repo-${++repoCounter}-nogit`)
    mkdirSync(join(root, '.underseal', 'assignments'), { recursive: true })
    writeFileSync(join(root, '.underseal', 'assignments', 'worker_task_alpha.assignment.json'), JSON.stringify(ASSIGNMENT()))
    const v = evaluateGuard(realFs, { cwd: root, toolName: 'write', blockedTools: BLOCKED })
    assert.equal(v.deny, false)
  })
  check('no current dispatch → allow', () => {
    const r = buildRepo({ dispatch: null })
    assert.equal(evaluateGuard(realFs, inputs(r.root)).deny, false)
  })
  check('cwd undefined → allow', () => {
    const v = evaluateGuard(realFs, { cwd: undefined, toolName: 'write', blockedTools: BLOCKED })
    assert.equal(v.deny, false)
  })
  check('empty cwd → allow', () => {
    const v = evaluateGuard(realFs, { cwd: '', toolName: 'write', blockedTools: BLOCKED })
    assert.equal(v.deny, false)
  })
  check('non-blocked tool (underseal_start) → allow', () => {
    const r = buildRepo()
    const v = evaluateGuard(realFs, { cwd: r.root, toolName: 'underseal_start', blockedTools: BLOCKED })
    assert.equal(v.deny, false)
  })
  check('non-blocked tool (read) → allow', () => {
    const r = buildRepo()
    const v = evaluateGuard(realFs, { cwd: r.root, toolName: 'read', blockedTools: BLOCKED })
    assert.equal(v.deny, false)
  })
}

scenario('(e) resume generation dispatch → allow')
{
  check('activation_kind RESUME + generation 2 → allow', () => {
    const r = buildRepo({ dispatch: DISPATCH({ activation_kind: 'RESUME', generation: 2 }) })
    assert.equal(evaluateGuard(realFs, inputs(r.root)).deny, false)
  })
  check('activation_kind RESUME + generation 1 (explicit marker wins) → allow', () => {
    const r = buildRepo({ dispatch: DISPATCH({ activation_kind: 'RESUME', generation: 1 }) })
    assert.equal(evaluateGuard(realFs, inputs(r.root)).deny, false)
  })
  check('INITIAL + generation 3 → allow (non-initial generation)', () => {
    const r = buildRepo({ dispatch: DISPATCH({ activation_kind: 'INITIAL', generation: 3 }) })
    assert.equal(evaluateGuard(realFs, inputs(r.root)).deny, false)
  })
  check('generation 2 without activation_kind → unknown → fail-closed deny', () => {
    const r = buildRepo({ dispatch: DISPATCH({ activation_kind: undefined, generation: 2 }) })
    const v = evaluateGuard(realFs, inputs(r.root))
    assert.equal(v.deny, true)
    assert.match(v.reason, /fail-closed/)
    assert.match(v.reason, /cannot confirm the dispatch generation/)
  })
}

scenario('(f) dispatch shape strictness (unknown generation fails closed)')
{
  check('generation 1 only (activation_kind missing) → fail-closed deny', () => {
    const r = buildRepo({ dispatch: DISPATCH({ activation_kind: undefined }) })
    const v = evaluateGuard(realFs, inputs(r.root))
    assert.equal(v.deny, true)
    assert.match(v.reason, /fail-closed/)
    assert.match(v.reason, /cannot confirm the dispatch generation/)
  })
  check('activation_kind INITIAL only (generation missing) → fail-closed deny', () => {
    const r = buildRepo({ dispatch: DISPATCH({ generation: undefined }) })
    const v = evaluateGuard(realFs, inputs(r.root))
    assert.equal(v.deny, true)
    assert.match(v.reason, /fail-closed/)
  })
  check('generation as string "1" → fail-closed deny', () => {
    const r = buildRepo({ dispatch: DISPATCH({ generation: '1' }) })
    const v = evaluateGuard(realFs, inputs(r.root))
    assert.equal(v.deny, true)
    assert.match(v.reason, /fail-closed/)
  })
  check('generation missing + READY present → fail-closed deny (never guess)', () => {
    const r = buildRepo({ dispatch: DISPATCH({ generation: undefined }), events: [READY_EVENT] })
    const v = evaluateGuard(realFs, inputs(r.root))
    assert.equal(v.deny, true)
    assert.match(v.reason, /fail-closed/)
  })
  check('missing role on assignment → fail-closed', () => {
    const r = buildRepo({ assignment: ASSIGNMENT({ role: undefined }) })
    const v = evaluateGuard(realFs, inputs(r.root))
    assert.equal(v.deny, true)
    assert.match(v.reason, /fail-closed/)
  })
  check('mode owner renders expectedMode in the reason', () => {
    const r = buildRepo({ assignment: ASSIGNMENT({ mode: 'owner' }) })
    const v = evaluateGuard(realFs, inputs(r.root))
    assert.equal(v.deny, true)
    assert.match(v.reason, /expectedMode="owner"/)
  })
}

scenario('(g) helper units')
{
  check('isAbsentError classifies ENOENT/ENOTDIR only', () => {
    assert.equal(isAbsentError(errWithCode('ENOENT', 'x')), true)
    assert.equal(isAbsentError(errWithCode('ENOTDIR', 'x')), true)
    assert.equal(isAbsentError(errWithCode('EACCES', 'x')), false)
    assert.equal(isAbsentError(new Error('plain')), false)
    assert.equal(isAbsentError(undefined), false)
  })
  check('classifyDispatchGeneration contract', () => {
    assert.equal(classifyDispatchGeneration(DISPATCH()), 'initial')
    assert.equal(classifyDispatchGeneration(DISPATCH({ activation_kind: 'RESUME' })), 'resume')
    assert.equal(classifyDispatchGeneration(DISPATCH({ activation_kind: 'RESUME', generation: 2 })), 'resume')
    assert.equal(classifyDispatchGeneration(DISPATCH({ activation_kind: 'INITIAL', generation: 3 })), 'resume')
    // Missing or mistyped fields are never guessed → unknown.
    assert.equal(classifyDispatchGeneration(DISPATCH({ activation_kind: undefined })), 'unknown')
    assert.equal(classifyDispatchGeneration(DISPATCH({ generation: undefined })), 'unknown')
    assert.equal(classifyDispatchGeneration(DISPATCH({ generation: '1' })), 'unknown')
    assert.equal(classifyDispatchGeneration(DISPATCH({ activation_kind: 42 })), 'unknown')
    assert.equal(classifyDispatchGeneration(null), 'unknown')
    assert.equal(classifyDispatchGeneration('INITIAL'), 'unknown')
  })
  check('findRepoRoot walks up and returns null without .git', () => {
    const r = buildRepo()
    const nested = join(r.root, 'a', 'b', 'c')
    mkdirSync(nested, { recursive: true })
    assert.equal(findRepoRoot(realFs, nested), r.root)
    // Simulate "no .git anywhere" with a stat that always reports absence, so
    // the walk is unaffected by the test running inside a real git checkout.
    const noGitFs = { stat: () => { throw errWithCode('ENOENT', 'absent') }, readdir: realFs.readdir, readFile: realFs.readFile }
    assert.equal(findRepoRoot(noGitFs, join(r.root, 'x', 'y')), null)
  })
  check('isPathInside containment', () => {
    // Platform-neutral: build absolute paths with resolve/join instead of
    // hardcoding a drive letter, so the suite passes on both Windows and Linux.
    const root = resolve('/repo')
    const sibling = resolve('/repo2')
    assert.equal(isPathInside(root, root), true)
    assert.equal(isPathInside(root, join(root, 'sub', 'file.txt')), true)
    assert.equal(isPathInside(root, join(sibling, 'file.txt')), false)
    assert.equal(isPathInside(root, resolve('/other')), false)
  })
}

scenario('(h) manifest wiring sanity')
{
  const pkg = JSON.parse(readFileSync(join(TESTS_DIR, '..', 'package.json'), 'utf8'))
  check('package.json exports ./guard with lib types+default', () => {
    assert.equal(pkg.exports['./guard'].types, './lib/types/guard.d.ts')
    assert.equal(pkg.exports['./guard'].default, './lib/guard.js')
  })
  check('package.json files ship guard.js and guard-core.js', () => {
    assert.ok(pkg.files.includes('lib/guard.js'))
    assert.ok(pkg.files.includes('lib/guard-core.js'))
  })
  check('compiled lib artifacts exist', () => {
    readFileSync(join(TESTS_DIR, '..', 'lib', 'guard.js'), 'utf8')
    readFileSync(join(TESTS_DIR, '..', 'lib', 'guard-core.js'), 'utf8')
  })
}

// --- teardown + summary ---------------------------------------------------------

rmSync(TMP_ROOT, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const { name, error } of failures) console.error(`FAILED: ${name} — ${error.message}`)
  process.exitCode = 1
}
