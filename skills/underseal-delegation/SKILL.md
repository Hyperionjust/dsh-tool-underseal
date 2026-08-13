---
name: underseal-delegation
description: Use when delegating implementation or mechanical work from a DeepSeek Harness (DSH) lead agent to another agent across projects; when creating, sealing, resuming, retiring, or auditing an Underseal assignment; or when a cross-provider handoff needs a project-local verifier pin and append-only evidence. Provides a DSH-first workflow around the model-facing underseal_* tools (which wrap the vendored, reviewed underseal adapter bundled with the dsh-tool-underseal plugin) plus a Windows-first fallback to the raw CLI. Do not use when a nearer AGENTS.md disables delegation, the host forbids subagents, or the task is trivial enough to complete directly.
whenToUse: Use for any cross-agent or cross-provider delegation that must be hash-sealed, scope-audited, and append-only evidenced; for Underseal assignment lifecycle management (seal/start/event/resume/audit/retire/pin/doctor); or when a lead needs a verifier pin that a third party can independently re-derive.
metadata: { pin: "sha256:f06b5f969b7bfd59030d2f84e114cdc779099ea7bc8474cf779e82d0aba39b15" }
---

# Underseal Delegation

Treat chat as transport only. Treat the exact project-local assignment,
receipt, verifier pin, and full-ceremony dispatch binding as authority.

Use the model-facing `underseal_*` tools (they wrap the vendored, reviewed
`underseal-adapter` bundled with the `dsh-tool-underseal` plugin and do
byte-sensitive writes on your behalf). Fall back to the raw CLI only when the
tools are not mounted. Do not reproduce canonical receipts, dispatch documents,
or progress events by hand on Windows.

## Select the delegation mode

- Use `owner` with role `deepseek_owner` for non-trivial outcome-based work in
  one exclusive subtree. Pair it with an independent senior holdmaster.
- Use `mechanical` with role `deepseek_coder` only after behavior, exact targets,
  expected bases, and acceptance commands are frozen.
- Use the `full` ceremony by default. Use `lite` only for a single uninterrupted
  run that cannot resume.
- Obey nearer `AGENTS.md`, current host restrictions, and explicit user scope.
  Fall back to a DSH `subagent`/`subagent_fork` (or the `workflow` tool for
  large fan-out, `goal` tools for a long-running objective) when the sealed
  adapter path is unavailable.

Read [assignment-templates.md](references/assignment-templates.md) when drafting
an assignment. Read [maintenance.md](references/maintenance.md) only when the
global commands are missing, the project pin drifts, or the installed package
must be updated.

## Prepare the lead plane

1. Resolve the repository root and inspect the current branch and dirty tree.
2. Require a real Git `HEAD`. Underseal's normative scope audit compares the
   delegated result with `HEAD`.
3. Use a fresh task name that matches the active global naming convention.
   Never reuse a completed, unknown, recovery, or rework task name.
4. Ensure no other writer owns the same workspace or overlapping subtree.
5. Check readiness with the `underseal_doctor` tool (workspace root only).
6. Write exactly one assignment at
   `.underseal/assignments/<task_name>.assignment.json` with `apply_patch`.
   Use the exact Windows workspace path with escaped backslashes in JSON and
   forward slashes for project-relative paths.
7. Seal it with the `underseal_seal` tool, passing the exact `workspaceRoot`,
   `taskName`, `expectedMode` (`owner` or `mechanical`), `expectedRole`
   (`deepseek_owner` or `deepseek_coder`), and `dispatchId` for a full-ceremony
   assignment. Require the `UNDERSEAL_ADAPTER_SEALED` marker in the result.

   Raw-CLI fallback:

   ```powershell
   underseal-adapter seal `
     --workspace-root <absolute-repository-root> `
     --task-name <task_name> `
     --expected-mode <owner-or-mechanical> `
     --expected-role <deepseek_owner-or-deepseek_coder> `
     --dispatch-id <UPPERCASE-DISPATCH-ID>
   ```

8. Require the `UNDERSEAL_ADAPTER_SEALED` marker. Inspect the generated pin,
   receipt, dispatch pointer, and the two byte-preservation attribute files at
   `.underseal/.gitattributes` and `.underseal-runs/.gitattributes`. These keep
   Git from rewriting sealed JSON or evidence to CRLF. Do not continue after
   any `E_*` result.
9. Commit the lead plane before spawning the worker. Otherwise its pre-existing
   untracked `.underseal/` files make the later scope audit correctly fail.
   Follow the active branch and checkpoint-commit rules: review `git status`,
   run `git diff --check`, scan the staged paths for likely secrets, and stage
   only the exact `.underseal/` files plus `.underseal-runs/.gitattributes`.
   If a permitted checkpoint commit cannot be made, do not dispatch.

Never let the worker run `underseal_pin`, `underseal_seal`, `underseal_resume`,
or `underseal_retire`; those tools write the lead-owned control plane.

## Dispatch the worker

Create the DSH worker only when current instructions authorize subagent use.
Use the `subagent` tool (or `subagent_fork` to inherit this conversation), and
make the child's durable task name exactly match the sealed `task_name`.

Send only these three facts in the handoff message:

```text
Workspace root: <absolute-repository-root>
Task name: <task_name>
Role: <deepseek_owner-or-deepseek_coder>
```

Do not restate the objective, constraints, targets, expected bases, acceptance
commands, or external effects in chat. The worker must read them from the
sealed assignment after activation succeeds.

## Start and record worker evidence

Make the worker's first project-affecting action the `underseal_start` tool,
passing `workspaceRoot`, `taskName`, `expectedMode`, and `expectedRole`.

Require the `UNDERSEAL_ADAPTER_READY` marker in the result before reading
project files for the purpose of changing them. Then read the assignment and
work strictly inside its sealed scope.

Record material boundaries without secrets, personal data, full command output,
or configuration, using the `underseal_event` tool with an adapter-legal
`state` (`TOOL_STARTED`, `PROGRESS`, `DONE`, `CHECKPOINT`, `BLOCKER_TO_LEAD`,
`DECISION_NEEDED`, …) and a `summary` of at most 500 characters.

Use `PROGRESS` sparingly. End at exactly one assignment-authorized outcome such
as `DONE`, `CHECKPOINT`, `BLOCKER_TO_LEAD`, or `DECISION_NEEDED`. Stop work
after writing `CHECKPOINT` or a halting outcome.

## Resume only a confirmed same-agent checkpoint

Resume only a `full` task whose last outcome is `CHECKPOINT`, whose prior agent
is still the same host-reported agent, and whose tree audit remains in scope.
The lead calls the `underseal_resume` tool with `hostSameAgentConfirmed: true`
only after confirming the same agent resumes; the tool refuses a false value.

Raw-CLI fallback:

```powershell
underseal-adapter resume `
  --workspace-root <absolute-repository-root> `
  --expected-role <deepseek_owner-or-deepseek_coder> `
  --host-same-agent-confirmed
```

Require the `UNDERSEAL_ADAPTER_RESUMED` marker, then trigger the same live
agent with the same three-fact handoff. Its next action is `underseal_start`,
which appends the required new-generation `READY` boundary.

Do not use this path for a dead, completed, replaced, or unknown worker. Use a
fresh task name and fresh sealed assignment under the active recovery rules.

## Re-derive acceptance as lead

When the worker reports an outcome, do not accept its chat claim. Run the
`underseal_audit` tool with `workspaceRoot`, `taskName`, `expectedMode`, and
`expectedRole`.

Require the `UNDERSEAL_ADAPTER_AUDIT_OK` marker. This validates the evidence
and feeds the verifier the exact union of:

- `git diff --name-only -z --no-renames HEAD`
- `git ls-files --others --exclude-standard -z`

Then inspect the actual diff, run only the reviewed sealed acceptance commands,
and obtain the independent senior verdict required by the active global rules.
The sealed `external_effects` field records scope; it never substitutes for
human authorization to push, publish, deploy, message people, spend money, or
access credentials.

After an accepted `DONE` outcome, retire the full dispatch as lead with the
`underseal_retire` tool (`workspaceRoot` + `expectedRole`).

Raw-CLI fallback:

```powershell
underseal-adapter retire `
  --workspace-root <absolute-repository-root> `
  --expected-role <deepseek_owner-or-deepseek_coder>
```

Review and checkpoint the resulting archive/pointer change under the active Git
rules. Use a fresh sealed task for every holdmaster `REWORK` verdict.

## Preserve the boundary with Project Covenant

Use this skill only for Underseal's delegation envelope and evidence lifecycle.
Do not claim that Project Covenant init, revise, recover, audit, or delivery
workflows exist merely because this adapter can install Underseal documents.
The Covenant skill's implemented deterministic foundation remains a separate
layer.
