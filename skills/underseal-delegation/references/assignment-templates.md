# Assignment templates

Replace every `REPLACE_*` value before sealing. Keep the assignment readable;
the receipt, dispatch, and progress records—not the assignment—must be canonical
one-line JSON.

## Owner, full ceremony

Use an exclusive `ownership_root`. If it is `.`, protect every control path as
shown. If it is a narrow subtree that cannot reach those paths, use an empty
`protected_paths` list.

```json
{
  "schema_version": 1,
  "document_type": "underseal.assignment",
  "assignment_id": "US-REPLACE-OWNER-0001",
  "task_name": "ds_owner_replace_task",
  "revision": 1,
  "ceremony": "full",
  "mode": "owner",
  "role": "deepseek_owner",
  "workspace": "C:\\REPLACE\\ABSOLUTE\\REPOSITORY",
  "path_profile": "windows-strict",
  "control_paths": [".underseal", ".underseal-runs", ".git"],
  "gate": {"status": "OPEN", "resolved_by": "principal"},
  "objective": "REPLACE_WITH_ONE_CONCRETE_OUTCOME",
  "constraints": ["REPLACE_WITH_REAL_BOUNDARY"],
  "forbidden_changes": ["REPLACE_WITH_EXPLICIT_PROHIBITION"],
  "external_effects": [],
  "progress": {
    "path": ".underseal-runs/ds_owner_replace_task.events.jsonl",
    "required": true
  },
  "terminal_states": [
    "DONE",
    "CHECKPOINT",
    "DECISION_NEEDED",
    "BLOCKER_TO_PRINCIPAL",
    "CONFLICT_TO_PRINCIPAL"
  ],
  "recovery": {
    "previous_task_name": null,
    "preserve_existing_work": false
  },
  "ownership_root": ".",
  "protected_paths": [".underseal", ".underseal-runs", ".git"],
  "acceptance_outcomes": ["REPLACE_WITH_OBSERVABLE_ACCEPTANCE_OUTCOME"]
}
```

## Mechanical, full ceremony

Compute each existing file's exact SHA-256 before sealing. Use `ABSENT` only
when no file, directory, or symlink occupies the path.

```json
{
  "schema_version": 1,
  "document_type": "underseal.assignment",
  "assignment_id": "US-REPLACE-MECH-0001",
  "task_name": "ds_coder_replace_task",
  "revision": 1,
  "ceremony": "full",
  "mode": "mechanical",
  "role": "deepseek_coder",
  "workspace": "C:\\REPLACE\\ABSOLUTE\\REPOSITORY",
  "path_profile": "windows-strict",
  "control_paths": [".underseal", ".underseal-runs", ".git"],
  "gate": {"status": "OPEN", "resolved_by": "principal"},
  "objective": "REPLACE_WITH_FROZEN_OBJECTIVE",
  "constraints": ["REPLACE_WITH_FROZEN_CONSTRAINT"],
  "forbidden_changes": ["No changes outside the declared targets."],
  "external_effects": [],
  "progress": {
    "path": ".underseal-runs/ds_coder_replace_task.events.jsonl",
    "required": true
  },
  "terminal_states": [
    "DONE",
    "CHECKPOINT",
    "BLOCKER_TO_LEAD",
    "CONFLICT_TO_LEAD"
  ],
  "recovery": {
    "previous_task_name": null,
    "preserve_existing_work": false
  },
  "targets": [
    {
      "path": "src/replace-file.ts",
      "expected_base": "REPLACE_WITH_64_LOWERCASE_SHA256_OR_ABSENT"
    }
  ],
  "required_behavior": "REPLACE_WITH_EXACT_TESTABLE_BEHAVIOR",
  "acceptance_commands": ["REPLACE_WITH_REVIEWED_NONINTERACTIVE_COMMAND"]
}
```

## Rules that commonly fail closed

- Make `task_name`, assignment filename, progress filename, and DSH subagent
  task name identical.
- Use `ds_owner_*` and `ds_coder_*` task names under the active global policy,
  and the matching `deepseek_owner` / `deepseek_coder` roles.
- Keep Windows absolute workspace paths backslash-only. Keep project-relative
  paths forward-slash-only.
- Include `.underseal`, `.underseal-runs`, and `.git` in `control_paths`.
- Never declare `CHECKPOINT` for `lite`.
- Keep `external_effects` empty unless the principal explicitly authorized a
  listed effect and current hold points are satisfied.
- Use only registered effects: `LOCAL_COMMIT`, `NETWORK`, `PUSH`, `MERGE`,
  `PUBLISH`, `DEPLOY`, `CREDENTIAL_ACCESS`, or `EXTERNAL_MUTATION`.
- Do not reuse stale progress. A `lite` task requires an absent evidence file;
  a `full` resume derives its boundary from the sealed dispatch lineage.
