/**
 * Model-facing typed tools that wrap the frozen `underseal-adapter` CLI.
 *
 * This package is a process shell only: it never reimplements Underseal
 * validation. Every tool spawns the existing Python adapter through the
 * `ctx.subprocess` seam and surfaces the adapter's canonical
 * `UNDERSEAL_ADAPTER_*` marker plus its JSON payload, or throws with the
 * adapter's `E_*` diagnostic on failure. The adapter never runs network
 * operations, never runs acceptance commands, and never performs Git commits;
 * the tools below mirror that boundary exactly — they only ever invoke the
 * adapter's own subcommands.
 *
 * @module dsh-tool-underseal
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue, JsonValue } from '@deepseek-ai/dsh-tools'
// Type-only: brings the `ctx.subprocess` service augmentation into scope.
import type {} from '@deepseek-ai/dsh-subprocess'
import {
  checkBundleSentinel,
  checkSkillSentinel,
  checkVerifierSentinel,
  type SentinelFs,
} from './sentinels.js'

export const name = 'tool-underseal'
export const inject = ['tools', 'subprocess']

/**
 * The reviewed, pinned adapter vendored beside this module. `python/` ships
 * inside the published package (`files`), so a bare `dsh plugin add` is
 * self-contained: no separately provisioned underseal installation is needed.
 */
const VENDORED_ADAPTER = fileURLToPath(new URL('../python/underseal_adapter.py', import.meta.url))
const DEFAULT_ADAPTER_PATH = VENDORED_ADAPTER
const DEFAULT_PYTHON = process.platform === 'win32' ? 'python' : 'python3'
const DEFAULT_GRACE_MS = 30_000
const DEFAULT_OUTPUT_MAX_BYTES = 64 * 1024
const DEFAULT_SPILL_MAX_BYTES = 4 * 1024 * 1024

// Supply-chain sentinel targets (HANDOFF §5 E1/E2/E3). Every pinned artifact
// resolves with the same `fileURLToPath(new URL(...))` pattern as the
// vendored adapter above, so the paths stay correct in the published package.
const VENDORED_VERIFIER = fileURLToPath(new URL('../python/underseal.py', import.meta.url))
const VENDORED_VERIFIER_PIN = fileURLToPath(new URL('../python/underseal.pin.json', import.meta.url))
const BUNDLE_PATCH = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
const BUNDLE_PATCH_PIN = fileURLToPath(new URL('../cordis.pin.json', import.meta.url))
const SKILL_FILE = fileURLToPath(new URL('../skills/underseal-delegation/SKILL.md', import.meta.url))

/** Protocol bound on a progress-event `summary` (underseal spec §7.2). */
const MAX_SUMMARY_CHARS = 500

/** `mode` enum, matching the adapter's `--expected-mode` choices (`underseal.MODES`). */
const MODES = ['owner', 'mechanical'] as const

/**
 * `event --state` vocabulary: the adapter's `PROGRESS_STATES` minus `READY`.
 * (The CLI accepts READY as a legal choice, but READY is the activation
 * boundary that `start` owns; this enum excludes it so workers cannot emit a
 * second activation event through the generic event path.)
 */
const EVENT_STATES = [
  'TOOL_STARTED',
  'PROGRESS',
  'CHECKPOINT',
  'BLOCKED',
  'WAITING_USER',
  'DONE',
  'DECISION_NEEDED',
  'BLOCKER_TO_PRINCIPAL',
  'CONFLICT_TO_PRINCIPAL',
  'BLOCKER_TO_LEAD',
  'CONFLICT_TO_LEAD',
] as const

const TASK_NAME_GRAMMAR = /^[a-z][a-z0-9_]{0,63}$/
const DISPATCH_ID_GRAMMAR = /^[A-Z][A-Z0-9-]{2,127}$/
const ERROR_CODE_GRAMMAR = /^(E_[A-Z0-9_]+):/m

/** Adapter process-and-collection configuration. */
export interface Config {
  /** Adapter script (default: the vendored reviewed `python/underseal_adapter.py`); when `pythonPath` is empty, a console-script/executable name or absolute path. */
  adapterPath?: string
  /** Python interpreter prefix for a `.py` adapter script (default: platform `python`/`python3`). Empty string spawns `adapterPath` as an executable instead. */
  pythonPath?: string
  /** Working directory for the spawned adapter. Defaults to the process cwd (the adapter locates the workspace via `--workspace-root`). */
  cwd?: string
  /** Grace period (ms) for process-tree terminate escalation. */
  graceMs?: number
  /** In-memory byte cap per output stream before the retained tail. */
  outputMaxBytes?: number
  /** Whole-stream spill byte cap per output stream. */
  spillMaxBytes?: number
}

export const Config: z<Config> = z.object({
  adapterPath: z.string().default(DEFAULT_ADAPTER_PATH),
  pythonPath: z.string().default(DEFAULT_PYTHON),
  cwd: z.string().default(''),
  graceMs: z.number().default(DEFAULT_GRACE_MS),
  outputMaxBytes: z.number().default(DEFAULT_OUTPUT_MAX_BYTES),
  spillMaxBytes: z.number().default(DEFAULT_SPILL_MAX_BYTES),
})

interface ResolvedConfig {
  adapterPath: string
  pythonPath: string
  cwd: string
  graceMs: number
  outputMaxBytes: number
  spillMaxBytes: number
}

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    marker: { type: 'string', required: true },
    payload: { type: 'json', required: true },
    exitCode: { type: 'integer', required: true },
    stdout: { type: 'string', required: true },
    stderr: { type: 'string', required: true },
  },
} as const

/** Honest canonical result shared by every tool (success path only; failures throw). */
type UndersealResult = InferValue<typeof RESULT_SCHEMA>

interface RunOutcome {
  exitCode: number | null
  stdout: string
  stderr: string
}

/** Register the eight model-facing Underseal tools on `ctx.tools`. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved: ResolvedConfig = {
    adapterPath: config.adapterPath ?? DEFAULT_ADAPTER_PATH,
    pythonPath: config.pythonPath ?? DEFAULT_PYTHON,
    cwd: config.cwd === '' || config.cwd === undefined ? process.cwd() : config.cwd,
    graceMs: config.graceMs ?? DEFAULT_GRACE_MS,
    outputMaxBytes: config.outputMaxBytes ?? DEFAULT_OUTPUT_MAX_BYTES,
    spillMaxBytes: config.spillMaxBytes ?? DEFAULT_SPILL_MAX_BYTES,
  }
  assertPositiveInteger('graceMs', resolved.graceMs)
  assertPositiveInteger('outputMaxBytes', resolved.outputMaxBytes)
  assertPositiveInteger('spillMaxBytes', resolved.spillMaxBytes)

  // Supply-chain sentinels run before anything is registered. E1 and E3 are
  // fail-closed: a drifted verifier or bundle layer mutes the whole package
  // rather than running unvetted bytes. E2 is advisory (warning only).
  const sentinelFs: SentinelFs = {
    readFileBytes: (path) => readFileSync(path),
    exists: (path) => existsSync(path),
  }
  const verifierCheck = checkVerifierSentinel(sentinelFs, {
    verifierPath: VENDORED_VERIFIER,
    adapterPath: VENDORED_ADAPTER,
    pinPath: VENDORED_VERIFIER_PIN,
  })
  if (!verifierCheck.ok) {
    ctx.logger.error(`underseal sentinel E1 rejected the vendored verifier (${verifierCheck.code}): ${verifierCheck.reason} — refusing to register any underseal tool (fail-closed)`)
    return
  }
  const bundleCheck = checkBundleSentinel(sentinelFs, {
    bundlePath: BUNDLE_PATCH,
    pinPath: BUNDLE_PATCH_PIN,
  })
  if (!bundleCheck.ok) {
    ctx.logger.error(`underseal sentinel E3 rejected the bundle patch (${bundleCheck.code}): ${bundleCheck.reason} — refusing to register any underseal tool (fail-closed)`)
    return
  }
  const skillCheck = checkSkillSentinel(sentinelFs, SKILL_FILE)
  if (!skillCheck.ok) {
    ctx.logger.warn(`underseal sentinel E2 flagged the skill body (${skillCheck.code}): ${skillCheck.reason} — loading the ceremony skill unpinned (warning only; tools still register)`)
  }

  ctx.tools.register(defineTool({
    name: 'underseal_doctor',
    description: 'Check Underseal workspace readiness: the workspace is the Git repository root, HEAD resolves, and the project-local verifier pin matches the installed verifier. Returns UNDERSEAL_ADAPTER_OK. Read-only.',
    parameters: {
      workspaceRoot: { type: 'string', required: true, description: 'Absolute repository root (must be the Git repository root for normative scope auditing).' },
    },
    output: { schema: RESULT_SCHEMA, render: (_args, value) => [{ type: 'text', text: renderText('doctor', value) }] },
    async execute(args, exec) {
      assertWorkspaceRoot(args.workspaceRoot)
      return invoke(ctx, resolved, 'doctor', 'UNDERSEAL_ADAPTER_OK', ['doctor', '--workspace-root', args.workspaceRoot], exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'underseal_pin',
    description: 'Install the project-local verifier pin and the byte-preservation .gitattributes files. Lead-only control-plane write; never run from a worker. Set replace only after reviewing pin drift. Returns UNDERSEAL_ADAPTER_PIN_OK.',
    parameters: {
      workspaceRoot: { type: 'string', required: true, description: 'Absolute repository root (must be the Git repository root).' },
      replace: { type: 'boolean', description: 'Replace a drifted project pin after review. Defaults to false (pin drift fails closed).' },
    },
    output: { schema: RESULT_SCHEMA, render: (_args, value) => [{ type: 'text', text: renderText('pin', value) }] },
    async execute(args, exec) {
      assertWorkspaceRoot(args.workspaceRoot)
      const flags = ['pin', '--workspace-root', args.workspaceRoot]
      if (args.replace === true) flags.push('--replace')
      return invoke(ctx, resolved, 'pin', 'UNDERSEAL_ADAPTER_PIN_OK', flags, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'underseal_seal',
    description: 'Seal a task: render the receipt and, for a full-ceremony assignment, the initial dispatch binding. The assignment file must already exist at .underseal/assignments/<task-name>.assignment.json. Requires UNDERSEAL_ADAPTER_SEALED. Lead-only.',
    parameters: {
      workspaceRoot: { type: 'string', required: true, description: 'Absolute repository root (must be the Git repository root).' },
      taskName: { type: 'string', required: true, description: 'Exact task_name, matching the assignment filename stem and progress filename stem.' },
      expectedMode: { type: 'string', required: true, enum: MODES, description: 'Cross-check that must match the sealed assignment mode.' },
      expectedRole: { type: 'string', required: true, description: 'Cross-check that must match the sealed assignment role (convention: deepseek_owner or deepseek_coder).' },
      dispatchId: { type: 'string', description: 'Required for full ceremony; must be omitted for lite. Uppercase dispatch id (e.g. US-LEXER-0007-A).' },
    },
    output: { schema: RESULT_SCHEMA, render: (_args, value) => [{ type: 'text', text: renderText('seal', value) }] },
    async execute(args, exec) {
      assertWorkspaceRoot(args.workspaceRoot)
      assertTaskName(args.taskName)
      assertRoleName(args.expectedRole)
      if (args.dispatchId !== undefined && args.dispatchId !== '') assertDispatchId(args.dispatchId)
      const flags = [
        'seal', '--workspace-root', args.workspaceRoot, '--task-name', args.taskName,
        '--expected-mode', args.expectedMode, '--expected-role', args.expectedRole,
      ]
      if (args.dispatchId !== undefined && args.dispatchId !== '') flags.push('--dispatch-id', args.dispatchId)
      return invoke(ctx, resolved, 'seal', 'UNDERSEAL_ADAPTER_SEALED', flags, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'underseal_start',
    description: 'Worker activation: verify the sealed assignment and append the READY evidence event. Must be the first project-affecting action, before any project write. Requires UNDERSEAL_ADAPTER_READY.',
    parameters: {
      workspaceRoot: { type: 'string', required: true, description: 'Absolute repository root.' },
      taskName: { type: 'string', required: true, description: 'Exact task_name matching the sealed assignment.' },
      expectedMode: { type: 'string', required: true, enum: MODES, description: 'Cross-check that must match the sealed assignment mode.' },
      expectedRole: { type: 'string', required: true, description: 'Cross-check that must match the sealed assignment role.' },
      summary: { type: 'string', description: 'Optional READY summary (≤ 500 chars). Defaults to the adapter verbatim.' },
    },
    output: { schema: RESULT_SCHEMA, render: (_args, value) => [{ type: 'text', text: renderText('start', value) }] },
    async execute(args, exec) {
      assertWorkspaceRoot(args.workspaceRoot)
      assertTaskName(args.taskName)
      assertRoleName(args.expectedRole)
      if (args.summary !== undefined && args.summary !== '') assertSummary(args.summary)
      const flags = [
        'start', '--workspace-root', args.workspaceRoot, '--task-name', args.taskName,
        '--expected-mode', args.expectedMode, '--expected-role', args.expectedRole,
      ]
      if (args.summary !== undefined && args.summary !== '') flags.push('--summary', args.summary)
      return invoke(ctx, resolved, 'start', 'UNDERSEAL_ADAPTER_READY', flags, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'underseal_event',
    description: 'Append one validated progress/outcome event to the worker evidence log. state excludes READY (use underseal_start). summary ≤ 500 chars. Returns UNDERSEAL_ADAPTER_EVENT_OK.',
    parameters: {
      workspaceRoot: { type: 'string', required: true, description: 'Absolute repository root.' },
      taskName: { type: 'string', required: true, description: 'Exact task_name matching the sealed assignment.' },
      expectedMode: { type: 'string', required: true, enum: MODES, description: 'Cross-check that must match the sealed assignment mode.' },
      expectedRole: { type: 'string', required: true, description: 'Cross-check that must match the sealed assignment role.' },
      state: { type: 'string', required: true, enum: EVENT_STATES, description: 'Progress or outcome state to append (never READY).' },
      summary: { type: 'string', required: true, description: 'Event summary (non-empty, ≤ 500 chars).' },
    },
    output: { schema: RESULT_SCHEMA, render: (_args, value) => [{ type: 'text', text: renderText('event', value) }] },
    async execute(args, exec) {
      assertWorkspaceRoot(args.workspaceRoot)
      assertTaskName(args.taskName)
      assertRoleName(args.expectedRole)
      assertSummary(args.summary)
      return invoke(ctx, resolved, 'event', 'UNDERSEAL_ADAPTER_EVENT_OK', [
        'event', '--workspace-root', args.workspaceRoot, '--task-name', args.taskName,
        '--expected-mode', args.expectedMode, '--expected-role', args.expectedRole,
        '--state', args.state, '--summary', args.summary,
      ], exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'underseal_resume',
    description: 'Resume a full-ceremony task from CHECKPOINT: install the next-generation RESUME binding. hostSameAgentConfirmed must be explicitly true only after confirming the same agent resumes. Returns UNDERSEAL_ADAPTER_RESUMED. Lead-only.',
    parameters: {
      workspaceRoot: { type: 'string', required: true, description: 'Absolute repository root.' },
      expectedRole: { type: 'string', required: true, description: 'Role whose dispatch pointer is being resumed.' },
      hostSameAgentConfirmed: { type: 'boolean', required: true, description: 'Explicit confirmation that the same host-reported agent is resuming. Never auto-fill true.' },
    },
    output: { schema: RESULT_SCHEMA, render: (_args, value) => [{ type: 'text', text: renderText('resume', value) }] },
    async execute(args, exec) {
      assertWorkspaceRoot(args.workspaceRoot)
      assertRoleName(args.expectedRole)
      if (!args.hostSameAgentConfirmed) {
        throw new Error('underseal resume: host same-agent confirmation is required — confirm the same agent resumes the full-ceremony CHECKPOINT before setting hostSameAgentConfirmed to true')
      }
      return invoke(ctx, resolved, 'resume', 'UNDERSEAL_ADAPTER_RESUMED', [
        'resume', '--workspace-root', args.workspaceRoot, '--expected-role', args.expectedRole,
        '--host-same-agent-confirmed',
      ], exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'underseal_audit',
    description: 'Lead acceptance: validate the worker progress evidence and the normative Git scope against the sealed assignment. Requires UNDERSEAL_ADAPTER_AUDIT_OK. Lead-only.',
    parameters: {
      workspaceRoot: { type: 'string', required: true, description: 'Absolute repository root (must be the Git repository root).' },
      taskName: { type: 'string', required: true, description: 'Exact task_name matching the sealed assignment.' },
      expectedMode: { type: 'string', required: true, enum: MODES, description: 'Cross-check that must match the sealed assignment mode.' },
      expectedRole: { type: 'string', required: true, description: 'Cross-check that must match the sealed assignment role.' },
    },
    output: { schema: RESULT_SCHEMA, render: (_args, value) => [{ type: 'text', text: renderText('audit', value) }] },
    async execute(args, exec) {
      assertWorkspaceRoot(args.workspaceRoot)
      assertTaskName(args.taskName)
      assertRoleName(args.expectedRole)
      return invoke(ctx, resolved, 'audit', 'UNDERSEAL_ADAPTER_AUDIT_OK', [
        'audit', '--workspace-root', args.workspaceRoot, '--task-name', args.taskName,
        '--expected-mode', args.expectedMode, '--expected-role', args.expectedRole,
      ], exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'underseal_retire',
    description: 'Archive and remove a finished full-ceremony dispatch pointer. Requires a halting outcome in evidence. Returns UNDERSEAL_ADAPTER_RETIRED. Lead-only.',
    parameters: {
      workspaceRoot: { type: 'string', required: true, description: 'Absolute repository root.' },
      expectedRole: { type: 'string', required: true, description: 'Role whose finished dispatch pointer is being retired.' },
    },
    output: { schema: RESULT_SCHEMA, render: (_args, value) => [{ type: 'text', text: renderText('retire', value) }] },
    async execute(args, exec) {
      assertWorkspaceRoot(args.workspaceRoot)
      assertRoleName(args.expectedRole)
      return invoke(ctx, resolved, 'retire', 'UNDERSEAL_ADAPTER_RETIRED', [
        'retire', '--workspace-root', args.workspaceRoot, '--expected-role', args.expectedRole,
      ], exec.signal)
    },
  }))
}

/** Spawn the adapter through `ctx.subprocess`, collect both streams, and settle. */
async function runAdapter(
  ctx: Context,
  config: ResolvedConfig,
  subcommandArgs: readonly string[],
  signal: AbortSignal,
): Promise<RunOutcome> {
  // Empty pythonPath means `adapterPath` is itself the executable (console
  // script); otherwise resolve the interpreter and pass the script as argv[1].
  const scriptMode = config.pythonPath !== ''
  const program = scriptMode ? config.pythonPath : config.adapterPath
  const executable = await ctx.subprocess.resolveExecutable(program, undefined, signal)
  signal.throwIfAborted()
  const prefix = scriptMode ? [config.adapterPath] : []
  const handle = ctx.subprocess.spawn({
    argv: [executable, ...prefix, ...subcommandArgs],
    cwd: config.cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: config.outputMaxBytes, spill: { maxBytes: config.spillMaxBytes } },
      stderr: { maxBytes: config.outputMaxBytes, spill: { maxBytes: config.spillMaxBytes } },
    },
    graceMs: config.graceMs,
    signal,
  })
  const outcome = await handle.done
  const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
  const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
  return { exitCode: outcome.exitCode, stdout, stderr }
}

/** Run the adapter and require the exact success marker (fail closed otherwise). */
async function invoke(
  ctx: Context,
  config: ResolvedConfig,
  label: string,
  expectedMarker: string,
  flagArgs: readonly string[],
  signal: AbortSignal,
): Promise<UndersealResult> {
  const outcome = await runAdapter(ctx, config, flagArgs, signal)
  return parseResult(outcome, expectedMarker, label)
}

/** Convert a settled run into a success result, or throw a fail-closed error. */
function parseResult(outcome: RunOutcome, expectedMarker: string, label: string): UndersealResult {
  if (outcome.exitCode !== 0) {
    throw adapterFailure(label, outcome, null)
  }
  const parsed = extractMarker(outcome.stdout, expectedMarker)
  if (parsed === null) {
    throw adapterFailure(label, outcome, expectedMarker)
  }
  return {
    marker: parsed.token,
    payload: parsed.payload,
    exitCode: 0,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
  }
}

/** Find the expected `UNDERSEAL_ADAPTER_* <json>` line in stdout and parse its payload. */
function extractMarker(stdout: string, expected: string): { token: string; payload: JsonValue } | null {
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length === 0) continue
    const space = line.indexOf(' ')
    const token = space === -1 ? line : line.slice(0, space)
    if (token !== expected) continue
    let payload: JsonValue = null
    if (space !== -1) {
      try {
        payload = JSON.parse(line.slice(space + 1)) as JsonValue
      } catch {
        payload = null
      }
    }
    return { token, payload }
  }
  return null
}

/** Build the fail-closed error message from the run's exit code and stderr. */
function adapterFailure(label: string, outcome: RunOutcome, missingMarker: string | null): Error {
  const code = extractErrorCode(outcome.stderr)
  const detail = (outcome.stderr.trim() || outcome.stdout.trim() || 'no diagnostic output').split(/\r?\n/)[0] ?? 'no diagnostic output'
  const missing = missingMarker === null ? '' : ` (missing ${missingMarker})`
  const codeText = code === null ? '' : ` [${code}]`
  return new Error(`underseal ${label} failed${missing}${codeText} (exit ${outcome.exitCode ?? 'signal'}): ${detail}`)
}

function extractErrorCode(stderr: string): string | null {
  const match = ERROR_CODE_GRAMMAR.exec(stderr)
  const code = match?.[1]
  return code === undefined ? null : code
}

/** Pure model-facing prose for one success result. */
function renderText(label: string, value: UndersealResult): string {
  const payloadText = value.payload === null ? '' : `\n${JSON.stringify(value.payload, null, 2)}`
  return `underseal ${label} succeeded (${value.marker}, exit ${value.exitCode})${payloadText}`
}

function assertWorkspaceRoot(value: string): void {
  if (value.trim().length === 0) {
    throw new Error('underseal: workspace_root must be a non-empty absolute path')
  }
}

function assertTaskName(value: string): void {
  if (!TASK_NAME_GRAMMAR.test(value)) {
    throw new Error(`underseal: invalid task name "${value}" (must match ${TASK_NAME_GRAMMAR.source})`)
  }
}

function assertRoleName(value: string): void {
  if (!TASK_NAME_GRAMMAR.test(value)) {
    throw new Error(`underseal: invalid role "${value}" (must match ${TASK_NAME_GRAMMAR.source})`)
  }
}

function assertDispatchId(value: string): void {
  if (!DISPATCH_ID_GRAMMAR.test(value)) {
    throw new Error(`underseal: invalid dispatch id "${value}" (must match ${DISPATCH_ID_GRAMMAR.source})`)
  }
}

function assertSummary(value: string): void {
  if (value.trim().length === 0) {
    throw new Error('underseal: summary must be non-empty')
  }
  if (value.length > MAX_SUMMARY_CHARS) {
    throw new Error(`underseal: summary must be at most ${MAX_SUMMARY_CHARS} characters (got ${value.length})`)
  }
}

function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-underseal: ${field} must be a positive integer`)
  }
}
