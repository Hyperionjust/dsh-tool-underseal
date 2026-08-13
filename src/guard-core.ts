/**
 * Pure decision core for the underseal worker check-in lock ("T2 seam").
 *
 * This module has no dependencies beyond `node:path` and performs no I/O of
 * its own: every filesystem access goes through the injected {@link GuardFs}
 * interface, so the decision logic unit-tests in a plain Node script without
 * a DSH runtime (see `tests/run-guard-tests.mjs`, which imports the compiled
 * `lib/guard-core.js`).
 *
 * The v1 rule (full ceremony only):
 *
 *   1. Resolve the Git repository root by walking up from the caller's cwd.
 *      No `.git` ancestor → allow ("not applicable").
 *   2. Scan `<repo>/.underseal/assignments/*.assignment.json` for at least one
 *      assignment with `ceremony == "full"` and a gate that is a record whose
 *      `status` is exactly `"OPEN"` (`"CLOSED"` → allow; a missing/non-record
 *      gate or any other status → fail closed). None → allow.
 *   3. That assignment's role must have an INITIAL-generation current
 *      dispatch at `.underseal/dispatch/<role>.current.json`. The generation
 *      is judged only when BOTH `activation_kind` (string) and `generation`
 *      (number) are present and typed; a missing/mistyped field is "unknown"
 *      → fail closed, and an explicit non-INITIAL shape (resume) → allow.
 *   4. The task's evidence log must not contain a READY event line. The log
 *      path comes from `assignment.progress.path` (a repo-relative
 *      forward-slash path) when present and non-empty, else the convention
 *      `.underseal-runs/<task>.events.jsonl`. A torn (unparseable) FINAL line
 *      is tolerated as not-a-READY-line; any earlier malformed line fails
 *      closed as evidence corruption.
 *
 * All three hold → deny the named change-shaped tool (the caller filters the
 * tool name against its blocked list) with a reason that points at
 * `underseal_start`.
 *
 * Fail-closed semantics: any read failure that is NOT one of the explicitly
 * classified "absent" answers rejects, and so does any state the rule cannot
 * positively confirm (an unknown dispatch generation, an unclassifiable gate,
 * or malformed JSON anywhere). "Absent" is classified per structure — a
 * missing assignments directory means "no assignment" (allow), a missing
 * current dispatch means "not bound" (allow), a missing events log means "no
 * READY evidence" (deny).
 *
 * @module dsh-tool-underseal/guard-core
 */

import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Minimal synchronous filesystem surface the decision needs. */
export interface GuardFs {
  /** Stat one path; throw on failure (ENOENT/ENOTDIR mean absent). */
  stat(path: string): { isDirectory: boolean }
  /** List one directory's entry names; throw on failure. */
  readdir(path: string): string[]
  /** Read one UTF-8 text file; throw on failure. */
  readFile(path: string): string
}

/** Decision inputs: who is calling, with which tool, under which policy. */
export interface GuardInput {
  /** The caller agent's session working directory (may be absent). */
  cwd: string | undefined
  /** The tool name about to dispatch. */
  toolName: string
  /** Tool names whose mutations the guard may block. */
  blockedTools: readonly string[]
}

/** Fail-closed denial, or allow. */
export type GuardVerdict =
  | { readonly deny: false }
  | { readonly deny: true; readonly reason: string }

/** True for ENOENT/ENOTDIR — the "absent" answers the rule handles explicitly. */
export function isAbsentError(error: unknown): boolean {
  return hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')
}

/**
 * Walk up from `cwd` to the first ancestor directory containing a `.git`
 * entry and return it. Worktrees/submodules use a `.git` FILE, so any entry
 * counts, not just a directory. Returns `null` when no ancestor has one.
 * Non-absent stat failures propagate so the caller can fail closed.
 */
export function findRepoRoot(fs: GuardFs, cwd: string): string | null {
  let dir = isAbsolute(cwd) ? cwd : resolve(cwd)
  for (;;) {
    let hasGit = false
    try {
      fs.stat(join(dir, '.git'))
      hasGit = true
    } catch (error) {
      if (!isAbsentError(error)) throw error
    }
    if (hasGit) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** Whether `path` is `root` itself or lies under it (case-insensitive on Windows via `path.relative`). */
export function isPathInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** How a dispatch binding's generation classifies. */
export type DispatchGeneration = 'initial' | 'resume' | 'unknown'

/**
 * Classify a dispatch binding's generation without guessing. The frozen
 * adapter always writes both fields — `activation_kind: "INITIAL"` +
 * `generation: 1`, and a resume writes a later generation with a non-INITIAL
 * activation kind — so BOTH fields must be present with the correct types
 * (`activation_kind` string, `generation` number) before the binding can be
 * judged; a missing or mistyped field is `'unknown'`, which the caller treats
 * as fail-closed (guessing would be fail-open). With a well-formed shape,
 * only `activation_kind === "INITIAL"` AND `generation === 1` is `'initial'`;
 * any other typed value is an explicit non-initial generation (`'resume'`).
 */
export function classifyDispatchGeneration(dispatch: unknown): DispatchGeneration {
  if (!isRecord(dispatch)) return 'unknown'
  const activationKind = dispatch.activation_kind
  const generation = dispatch.generation
  if (typeof activationKind !== 'string' || typeof generation !== 'number') return 'unknown'
  if (activationKind !== 'INITIAL' || generation !== 1) return 'resume'
  return 'initial'
}

/**
 * Evaluate the check-in rule for one tool dispatch. Pure: reads only through
 * `fs` and answers from `input`. Returns a denial with a model-facing reason
 * or `{ deny: false }`.
 */
export function evaluateGuard(fs: GuardFs, input: GuardInput): GuardVerdict {
  const { cwd, toolName, blockedTools } = input
  if (cwd === undefined || cwd === '') return { deny: false }
  if (!blockedTools.includes(toolName)) return { deny: false }

  let repoRoot: string
  try {
    const root = findRepoRoot(fs, cwd)
    if (root === null) return { deny: false }
    repoRoot = root
  } catch (error) {
    return failClosed(`locate the repository root from "${cwd}"`, error)
  }

  const assignmentsDir = join(repoRoot, '.underseal', 'assignments')
  let entries: string[]
  try {
    entries = fs.readdir(assignmentsDir)
  } catch (error) {
    // No assignments directory → no assignment → "no OPEN assignment" → allow.
    if (isAbsentError(error)) return { deny: false }
    return failClosed(`list ${assignmentsDir}`, error)
  }
  const assignmentFiles = entries.filter((entry) => entry.endsWith('.assignment.json')).sort()
  if (assignmentFiles.length === 0) return { deny: false }

  for (const file of assignmentFiles) {
    const assignmentPath = join(assignmentsDir, file)
    let raw: string
    try {
      raw = fs.readFile(assignmentPath)
    } catch (error) {
      return failClosed(`read ${assignmentPath}`, error)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      return failClosed(`parse ${assignmentPath}`, error)
    }
    if (!isRecord(parsed)) {
      return failClosed(`parse ${assignmentPath}`, new Error('assignment is not a JSON object'))
    }
    const record = parsed
    if (record.ceremony !== 'full') continue
    const gate = record.gate
    if (!isRecord(gate)) {
      return failClosed(
        `parse ${assignmentPath}`,
        new Error('cannot classify assignment gate (expected an object with status "OPEN" or "CLOSED")'),
      )
    }
    if (gate.status === 'CLOSED') continue
    if (gate.status !== 'OPEN') {
      return failClosed(
        `parse ${assignmentPath}`,
        new Error(`cannot classify assignment gate status ${JSON.stringify(gate.status)} (expected "OPEN" or "CLOSED")`),
      )
    }
    const role = record.role
    const taskName = record.task_name
    if (typeof role !== 'string' || role.length === 0 || typeof taskName !== 'string' || taskName.length === 0) {
      return failClosed(
        `parse ${assignmentPath}`,
        new Error('OPEN full-ceremony assignment is missing role or task_name'),
      )
    }
    const mode = record.mode

    const dispatchPath = join(repoRoot, '.underseal', 'dispatch', `${role}.current.json`)
    let dispatchRaw: string
    try {
      dispatchRaw = fs.readFile(dispatchPath)
    } catch (error) {
      // No current dispatch for this role → this assignment is not bound yet → allow.
      if (isAbsentError(error)) continue
      return failClosed(`read ${dispatchPath}`, error)
    }
    let dispatch: unknown
    try {
      dispatch = JSON.parse(dispatchRaw)
    } catch (error) {
      return failClosed(`parse ${dispatchPath}`, error)
    }
    if (!isRecord(dispatch)) {
      return failClosed(`parse ${dispatchPath}`, new Error('dispatch binding is not a JSON object'))
    }
    // A generation we cannot positively confirm fails closed; an explicit
    // resume generation is not an initial binding and lets this assignment pass.
    const generationKind = classifyDispatchGeneration(dispatch)
    if (generationKind === 'unknown') {
      return failClosed(
        `parse ${dispatchPath}`,
        new Error('cannot confirm the dispatch generation (activation_kind and generation must both be present with correct types)'),
      )
    }
    if (generationKind !== 'initial') continue

    // The evidence log lives at assignment.progress.path when present and
    // non-empty (a repo-relative forward-slash path; join normalizes it),
    // falling back to the convention path otherwise. task_name is guaranteed
    // non-empty by the check above, so the convention path always resolves.
    const progress = record.progress
    let eventsPath: string
    if (isRecord(progress) && typeof progress.path === 'string' && progress.path.trim() !== '') {
      eventsPath = join(repoRoot, progress.path)
    } else {
      eventsPath = join(repoRoot, '.underseal-runs', `${taskName}.events.jsonl`)
    }
    let eventsRaw: string
    try {
      eventsRaw = fs.readFile(eventsPath)
    } catch (error) {
      // No evidence log yet → no READY line → the worker must start first.
      if (isAbsentError(error)) return blockVerdict(repoRoot, taskName, role, mode, toolName)
      return failClosed(`read ${eventsPath}`, error)
    }
    // A torn final write may leave the LAST non-empty line incomplete; treat
    // it as not-a-READY-line. Any earlier malformed line is evidence
    // corruption and fails closed even when a READY line precedes it, so the
    // whole file is scanned for validity (recording READY) without an early
    // break.
    const lines = eventsRaw.split(/\r?\n/)
    let lastNonEmpty = -1
    for (let i = 0; i < lines.length; i++) {
      if ((lines[i] ?? '').trim() !== '') lastNonEmpty = i
    }
    let ready = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''
      if (line.trim() === '') continue
      let event: unknown
      try {
        event = JSON.parse(line)
      } catch (error) {
        if (i === lastNonEmpty) continue
        return failClosed(`parse event line in ${eventsPath}`, error)
      }
      if (isRecord(event) && event.state === 'READY') ready = true
    }
    if (!ready) return blockVerdict(repoRoot, taskName, role, mode, toolName)
  }
  return { deny: false }
}

function blockVerdict(
  repoRoot: string,
  taskName: string,
  role: string,
  mode: unknown,
  toolName: string,
): GuardVerdict {
  const modePart = mode === 'owner' || mode === 'mechanical' ? `, expectedMode="${mode}"` : ''
  return {
    deny: true,
    reason: `underseal guard: ${toolName} denied — sealed full-ceremony assignment "${taskName}" (role "${role}") is OPEN with an INITIAL dispatch and no READY evidence; call underseal_start first (workspaceRoot="${repoRoot}", taskName="${taskName}", expectedRole="${role}"${modePart})`,
  }
}

function failClosed(what: string, error: unknown): GuardVerdict {
  return {
    deny: true,
    reason: `underseal guard: cannot determine readiness (failed to ${what}: ${describeError(error)}) — refusing, fail-closed`,
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
