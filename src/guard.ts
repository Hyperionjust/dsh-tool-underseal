/**
 * Worker check-in lock ("T2 seam") for the underseal full ceremony.
 *
 * A monotonic execution guard (registered through `ctx.tools.guard`) that
 * denies change-shaped tools — by default `write`, `edit`, `pwsh`, `bash` —
 * while a sealed OPEN full-ceremony assignment exists in the caller's
 * repository whose INITIAL dispatch has produced no READY evidence yet. The
 * denial message points the worker at `underseal_start`. See README
 * § "Worker check-in lock (guard)".
 *
 * Seam choice: `ctx.tools.guard()` over the `tools/pre-execute` waterfall,
 * because the contract makes guard denials monotonic — "Register a monotonic
 * synchronous execution guard after `tools/pre-execute`: returning a reason
 * denies the call, while `undefined` leaves it unchanged … Later waterfall
 * listeners cannot turn a guard denial back into permission." A machine rule
 * must not be reversible by reordering waterfall listeners, so the guard API
 * (not the reorderable pre-execute gate) is the enforcement point. The guard
 * receives the full `Readonly<ToolExecution>` (`name`, `arguments`,
 * `agent`), which is everything this rule needs.
 *
 * All disk reads happen through the pure decision core in `guard-core.ts`;
 * this module only wires it: resolves the session cwd, consults the
 * per-repository verdict cache, invalidates it on `fs/observed` and on
 * `underseal_*` tool results, and registers the guard. Verdicts are cached
 * per repository root so the dispatch path stays O(1) while a verdict is
 * fresh; cache misses do the small bounded reads (assignment/dispatch/events
 * files) synchronously, exactly as the synchronous `ToolGuard` contract
 * requires.
 *
 * @module dsh-tool-underseal/guard
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { evaluateGuard, findRepoRoot, isPathInside, type GuardFs } from './guard-core.js'

export const name = 'underseal-guard'
export const inject = ['tools']

const DEFAULT_BLOCKED_TOOLS = ['write', 'edit', 'pwsh', 'bash']
const DEFAULT_CACHE_TTL_MS = 2000

/** Guard plugin config. */
export interface Config {
  /** Tool names whose mutations are denied while READY evidence is missing (default: `write`, `edit`, `pwsh`, `bash`). */
  blockedTools?: string[]
  /** Verdict cache lifetime in ms per repository (default 2000); the small underseal state files are re-read when stale. */
  cacheTtlMs?: number
}

export const Config: z<Config> = z.object({
  blockedTools: z.array(z.string()).default(DEFAULT_BLOCKED_TOOLS),
  cacheTtlMs: z.number().default(DEFAULT_CACHE_TTL_MS),
})

/** Synchronous node:fs adapter for the decision core (reads only, no sandbox escalation). */
const realFs: GuardFs = {
  stat: (path) => {
    const stats = statSync(path)
    return { isDirectory: stats.isDirectory() }
  },
  readdir: (path) => readdirSync(path),
  readFile: (path) => readFileSync(path, 'utf8'),
}

/** Register the check-in guard on `ctx.tools`. */
export function apply(ctx: Context, config: Config = {}): void {
  const blockedTools = config.blockedTools ?? DEFAULT_BLOCKED_TOOLS
  const cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  assertPositiveInteger('cacheTtlMs', cacheTtlMs)

  interface VerdictEntry {
    repoRoot: string
    at: number
    reason: string | undefined
  }
  // One verdict per repository root; the cwd→repo index avoids re-walking
  // `.git` on every dispatch while a verdict is warm.
  const verdicts = new Map<string, VerdictEntry>()
  const reposByCwd = new Map<string, string>()

  function invalidate(repoRoot: string): void {
    const key = normalizeRepoKey(repoRoot)
    verdicts.delete(key)
    for (const [cwd, root] of reposByCwd) {
      if (normalizeRepoKey(root) === key) reposByCwd.delete(cwd)
    }
  }

  // Any observed filesystem event under a cached repository invalidates it.
  // `fs/observed` is declared by `@deepseek-ai/dsh-fs` (not a dependency of
  // this out-of-tree package); cordis performs no runtime event-name
  // validation (vendor/cordis/src/events.ts `dispatch()`), so a
  // structurally-typed listener is sufficient.
  const onFsObserved = ctx.on as unknown as (
    name: 'fs/observed',
    listener: (target: { readonly displayPath: string }, observation: unknown, actor: object | undefined) => void,
  ) => () => boolean
  onFsObserved('fs/observed', (target) => {
    for (const entry of [...verdicts.values()]) {
      if (isPathInside(entry.repoRoot, target.displayPath)) invalidate(entry.repoRoot)
    }
  })

  // An underseal tool that just succeeded may have changed the evidence the
  // verdict derives from (seal → assignment appears, start → READY line,
  // resume → next dispatch generation, retire → dispatch pointer removed), so
  // drop the whole repository's verdicts immediately instead of waiting out
  // the TTL. `underseal_start`'s READY append goes through the subprocess
  // seam and emits no `fs/observed`, so this is the correctness-critical
  // invalidation for the allow transition.
  ctx.on('tools/result', (exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => {
    if (result.isError || !exec.name.startsWith('underseal_')) return
    const cwd = exec.agent?.session.header.cwd
    if (cwd === undefined || cwd === '') return
    try {
      const root = findRepoRoot(realFs, cwd)
      if (root !== null) invalidate(root)
    } catch {
      // Invalidation is best-effort; the verdict TTL still bounds staleness.
    }
  })

  ctx.tools.guard((execution) => {
    try {
      const cwd = execution.agent?.session.header.cwd
      if (cwd === undefined || cwd === '') return undefined
      if (!blockedTools.includes(execution.name)) return undefined

      let repoRoot: string
      const cwdKey = normalizeRepoKey(cwd)
      const known = reposByCwd.get(cwdKey)
      if (known !== undefined) {
        repoRoot = known
      } else {
        const root = findRepoRoot(realFs, cwd)
        if (root === null) return undefined
        repoRoot = root
        reposByCwd.set(cwdKey, repoRoot)
      }

      const now = Date.now()
      const key = normalizeRepoKey(repoRoot)
      const entry = verdicts.get(key)
      if (entry !== undefined && now - entry.at < cacheTtlMs) return entry.reason

      const verdict = evaluateGuard(realFs, { cwd, toolName: execution.name, blockedTools })
      const reason = verdict.deny ? verdict.reason : undefined
      verdicts.set(key, { repoRoot, at: now, reason })
      return reason
    } catch (error) {
      // A guard must never throw into the pipeline; fail closed instead.
      return `underseal guard: cannot determine readiness (${describeError(error)}) — refusing, fail-closed`
    }
  })
}

/**
 * Normalize a repository path into a cache key so the same repository written
 * differently shares one entry. On Windows: lowercase, unify `/` and `\`,
 * strip trailing separators (drive case and separator style must not split
 * the verdict cache). Elsewhere the path is already canonical.
 */
function normalizeRepoKey(root: string): string {
  if (process.platform !== 'win32') return root
  const unified = root.toLowerCase().replace(/[\\/]+/g, '\\')
  return unified.replace(/[\\/]+$/, '')
}

function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`underseal-guard: ${field} must be a positive integer`)
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
