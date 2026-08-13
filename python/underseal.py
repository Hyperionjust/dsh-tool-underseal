#!/usr/bin/env python3
"""Underseal: sealed, task-name-bound delegation contracts for agent workspaces.

Underseal turns a lead-owned workspace file into the single authorization
source for a delegated worker run.  Neither a cross-model message body nor a
host-visible task label may grant authority: only a sealed assignment document,
its paired receipt, and -- for the full ceremony -- an installed dispatch
binding can.  Every check is fail-closed.  An unknown field, a missing file, a
broken hash, a downgraded ceremony, or an out-of-scope path stops the run with
a stable ``E_*`` error code and a nonzero exit status.

The verifier is deliberately standalone.  It imports only the Python standard
library and never imports project code that a worker may be allowed to edit.

Two planes stay separate on purpose.  The lead plane under ``.underseal`` holds
assignments, receipts, and dispatch bindings, and is never writable by a worker.
The worker evidence plane under ``.underseal-runs`` holds append-only progress
records.  A worker that can write its own evidence still cannot write its own
authority, and evidence is never accepted as a substitute for a seal.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import unicodedata
from pathlib import Path
from typing import NoReturn


# ---------------------------------------------------------------------------
# Vocabulary
# ---------------------------------------------------------------------------

SAFE_INTEGER_MAX = (1 << 53) - 1

TASK_NAME_RE = re.compile(r"[a-z][a-z0-9_]{0,63}\Z")
ROLE_NAME_RE = re.compile(r"[a-z][a-z0-9_]{0,63}\Z")
ASSIGNMENT_ID_RE = re.compile(r"[A-Z][A-Z0-9-]{2,127}\Z")
DISPATCH_ID_RE = re.compile(r"[A-Z][A-Z0-9-]{2,127}\Z")
HASH_RE = re.compile(r"[0-9a-f]{64}\Z")
TERMINAL_RE = re.compile(r"[A-Z][A-Z0-9_]{1,63}\Z")
GATE_RE = re.compile(r"[A-Z][A-Z0-9_]{1,63}\Z")
#: The only entries a dispatch directory may hold besides ``archive/``.
CURRENT_DISPATCH_NAME_RE = re.compile(r"[a-z][a-z0-9_]{0,63}\.current\.json\Z")
_DRIVE_RE = re.compile(r"[A-Za-z]:")
_WINDOWS_ABSOLUTE_RE = re.compile(r"[A-Za-z]:\\")

ASSIGNMENT_TYPE = "underseal.assignment"
RECEIPT_TYPE = "underseal.receipt"
DISPATCH_TYPE = "underseal.dispatch_binding"

ASSIGNMENT_SCHEMA_VERSION = 1
RECEIPT_SCHEMA_VERSION = 1
DISPATCH_SCHEMA_VERSION = 1
PIN_SCHEMA_VERSION = 1

CONTROL_DIRECTORY = ".underseal"
ASSIGNMENT_DIRECTORY = f"{CONTROL_DIRECTORY}/assignments"
DISPATCH_DIRECTORY = f"{CONTROL_DIRECTORY}/dispatch"
DISPATCH_ARCHIVE_NAME = "archive"
DISPATCH_ARCHIVE_DIRECTORY = f"{DISPATCH_DIRECTORY}/{DISPATCH_ARCHIVE_NAME}"
RUN_DIRECTORY = ".underseal-runs"

ASSIGNMENT_SUFFIX = ".assignment.json"
RECEIPT_SUFFIX = ".receipt.json"
CURRENT_DISPATCH_SUFFIX = ".current.json"
PROGRESS_SUFFIX = ".events.jsonl"

#: Paths the lead plane always owns.  A sealed assignment must declare at least
#: these; a lead may seal more (for example the directory holding this
#: verifier and its pin file).
REQUIRED_CONTROL_PATHS = (CONTROL_DIRECTORY, RUN_DIRECTORY, ".git")

MODES = ("owner", "mechanical")
CEREMONIES = ("lite", "full")

PATH_PROFILE_PORTABLE = "portable"
PATH_PROFILE_WINDOWS_STRICT = "windows-strict"
PATH_PROFILES = (PATH_PROFILE_PORTABLE, PATH_PROFILE_WINDOWS_STRICT)

ACTIVATION_KINDS = ("INITIAL", "RESUME")

#: The only gate status under which a delegated run may execute.  Any other
#: status is a legal document that simply does not authorize work yet.
GATE_STATUS_OPEN = "OPEN"

OWNER_TERMINALS = {
    "DONE",
    "CHECKPOINT",
    "DECISION_NEEDED",
    "BLOCKER_TO_PRINCIPAL",
    "CONFLICT_TO_PRINCIPAL",
}
MECHANICAL_TERMINALS = {
    "DONE",
    "CHECKPOINT",
    "BLOCKER_TO_LEAD",
    "CONFLICT_TO_LEAD",
}
PROGRESS_STATES = {
    "READY",
    "TOOL_STARTED",
    "PROGRESS",
    "CHECKPOINT",
    "BLOCKED",
    "WAITING_USER",
} | OWNER_TERMINALS | MECHANICAL_TERMINALS

#: Outcome states.  A worker may emit one of these only when the sealed
#: assignment declares it in ``terminal_states``.  ``CHECKPOINT`` is an outcome
#: like any other: it reports how the delegated run came to rest, so the lead
#: authorizes it in advance rather than discovering it after the fact.
OUTCOME_STATES = OWNER_TERMINALS | MECHANICAL_TERMINALS

#: Halting outcomes: the declared outcomes that close a run.  ``CHECKPOINT`` is
#: a declarable outcome that does not close the run, so it stays resumable.
RUN_ENDING_STATES = OUTCOME_STATES - {"CHECKPOINT"}

EXTERNAL_EFFECTS = {
    "LOCAL_COMMIT",
    "NETWORK",
    "PUSH",
    "MERGE",
    "PUBLISH",
    "DEPLOY",
    "CREDENTIAL_ACCESS",
    "EXTERNAL_MUTATION",
}

_COMMON_FIELDS = {
    "schema_version",
    "document_type",
    "assignment_id",
    "task_name",
    "revision",
    "ceremony",
    "mode",
    "role",
    "workspace",
    "path_profile",
    "control_paths",
    "gate",
    "objective",
    "constraints",
    "forbidden_changes",
    "external_effects",
    "progress",
    "terminal_states",
    "recovery",
}
_OWNER_FIELDS = _COMMON_FIELDS | {
    "ownership_root",
    "protected_paths",
    "acceptance_outcomes",
}
_MECHANICAL_FIELDS = _COMMON_FIELDS | {
    "targets",
    "required_behavior",
    "acceptance_commands",
}
_RECEIPT_FIELDS = {
    "schema_version",
    "document_type",
    "assignment_id",
    "task_name",
    "assignment_document",
    "assignment_semantic_payload",
}
_DISPATCH_FIELDS = {
    "schema_version",
    "document_type",
    "activation_kind",
    "dispatch_id",
    "generation",
    "workspace",
    "role",
    "mode",
    "task_name",
    "assignment_id",
    "revision",
    "assignment_document",
    "receipt_document",
    "binding_document",
    "resume",
}
_DISPATCH_BINDING_FIELDS = {
    "schema_version",
    "document_type",
    "dispatch_id",
    "workspace",
    "role",
    "mode",
    "task_name",
    "assignment_id",
    "revision",
    "assignment_document",
    "receipt_document",
}
_DISPATCH_RESUME_FIELDS = {
    "event_count",
    "host_same_agent_confirmed",
    "last_seq",
    "last_state",
    "previous_dispatch_document",
    "previous_generation",
    "progress_document",
}
_FULL_PROGRESS_EVENT_FIELDS = {
    "assignment_document_sha256",
    "dispatch_binding_sha256",
    "dispatch_id",
    "seq",
    "state",
    "summary",
    "task_name",
}
_LITE_PROGRESS_EVENT_FIELDS = {
    "assignment_document_sha256",
    "seq",
    "state",
    "summary",
    "task_name",
}
_PIN_FIELDS = {"algorithm", "path", "schema_version", "sha256"}

#: Wildcard, redirection, and quoting characters.  These are rejected on every
#: platform: they make a sealed scope declaration ambiguous for any consumer
#: that expands globs or splits shell words, which is a scope-integrity issue
#: rather than a Windows portability issue.
_INVALID_PATH_CHARACTERS = set('<>"|?*')

#: Reserved Windows device names, enforced only under the ``windows-strict``
#: path profile.
_RESERVED_NAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{number}" for number in range(1, 10)),
    *(f"LPT{number}" for number in range(1, 10)),
    "COM¹",
    "COM²",
    "COM³",
    "LPT¹",
    "LPT²",
    "LPT³",
}

_MAX_PATH_LENGTH = 1024
_MAX_SUMMARY_LENGTH = 500
_MAX_GENERATION = 1000


class UndersealError(ValueError):
    """Stable verifier error surfaced to the lead and to the worker."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _error(code: str, message: str) -> NoReturn:
    raise UndersealError(code, message)


# ---------------------------------------------------------------------------
# Restricted JSON: strict parsing and canonical emission
# ---------------------------------------------------------------------------


def _parse_int(token: str) -> int:
    value = int(token)
    if value < -SAFE_INTEGER_MAX or value > SAFE_INTEGER_MAX:
        _error("E_JSON_INTEGER", "integer is outside the safe JSON domain")
    return value


def _reject_number(token: str) -> NoReturn:
    _error("E_JSON_NUMBER", f"unsupported JSON number token: {token}")


def _pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            _error("E_JSON_DUPLICATE_KEY", f"duplicate JSON object key: {key}")
        result[key] = value
    return result


def _validate_string(value: str) -> None:
    for character in value:
        if 0xD800 <= ord(character) <= 0xDFFF:
            _error("E_JSON_SURROGATE", "lone UTF-16 surrogate is forbidden")


def _validate_json(value: object) -> None:
    if value is None or type(value) is bool:
        return
    if type(value) is int:
        if value < -SAFE_INTEGER_MAX or value > SAFE_INTEGER_MAX:
            _error("E_JSON_INTEGER", "integer is outside the safe JSON domain")
        return
    if type(value) is str:
        _validate_string(value)
        return
    if type(value) is list:
        for item in value:
            _validate_json(item)
        return
    if type(value) is dict:
        for key, item in value.items():
            if type(key) is not str:
                _error("E_JSON_TYPE", "JSON object keys must be exact strings")
            _validate_string(key)
            _validate_json(item)
        return
    _error("E_JSON_TYPE", f"unsupported JSON value type: {type(value).__name__}")


def parse_json_bytes(data: bytes) -> object:
    """Parse exact bytes as restricted JSON, rejecting every ambiguous form."""

    if type(data) is not bytes:
        _error("E_JSON_INPUT_TYPE", "JSON input must be exact bytes")
    if data.startswith(b"\xef\xbb\xbf"):
        _error("E_JSON_BOM", "UTF-8 BOM is forbidden")
    try:
        text = data.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        _error("E_JSON_UTF8", f"invalid UTF-8 at byte {exc.start}")
    try:
        value = json.loads(
            text,
            object_pairs_hook=_pairs,
            parse_int=_parse_int,
            parse_float=_reject_number,
            parse_constant=_reject_number,
        )
        _validate_json(value)
    except UndersealError:
        raise
    except RecursionError:
        _error("E_JSON_DEPTH", "JSON nesting exceeds the interpreter limit")
    except json.JSONDecodeError as exc:
        _error("E_JSON_SYNTAX", f"invalid JSON at character {exc.pos}")
    return value


def _utf16_sort_key(value: str) -> bytes:
    return value.encode("utf-16-be")


def _emit_canonical(value: object) -> str:
    if value is None:
        return "null"
    if type(value) is bool:
        return "true" if value else "false"
    if type(value) is int:
        return str(value)
    if type(value) is str:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if type(value) is list:
        return "[" + ",".join(_emit_canonical(item) for item in value) + "]"
    if type(value) is dict:
        keys = sorted(value, key=_utf16_sort_key)
        return "{" + ",".join(
            _emit_canonical(key) + ":" + _emit_canonical(value[key])
            for key in keys
        ) + "}"
    _error("E_JSON_TYPE", "value is outside the restricted JSON domain")


def canonicalize(value: object) -> bytes:
    """Emit one canonical JSON encoding: UTF-16 code-unit key order, no space."""

    try:
        _validate_json(value)
        return _emit_canonical(value).encode("utf-8")
    except RecursionError:
        _error("E_JSON_DEPTH", "JSON nesting exceeds the interpreter limit")


def sha256_hex(data: bytes) -> str:
    if type(data) is not bytes:
        _error("E_HASH_INPUT_TYPE", "hash input must be exact bytes")
    return hashlib.sha256(data).hexdigest()


def _typed_hash(kind: str, data: bytes) -> dict[str, str]:
    return {"hash_kind": kind, "algorithm": "sha256", "value": sha256_hex(data)}


# ---------------------------------------------------------------------------
# Schema primitives
# ---------------------------------------------------------------------------


def _expect_exact_keys(value: object, expected: set[str], pointer: str) -> dict:
    if type(value) is not dict:
        _error("E_SCHEMA_TYPE", f"{pointer} must be an object")
    actual = set(value)
    if actual != expected:
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        _error("E_SCHEMA_KEYS", f"{pointer} keys mismatch; missing={missing}, extra={extra}")
    return value


def _expect_string(value: object, pointer: str, *, max_length: int = 10000) -> str:
    if type(value) is not str or not value or len(value) > max_length:
        _error("E_SCHEMA_VALUE", f"{pointer} must be a nonempty bounded string")
    _validate_string(value)
    return value


def _expect_bool(value: object, pointer: str) -> bool:
    if type(value) is not bool:
        _error("E_SCHEMA_TYPE", f"{pointer} must be a boolean")
    return value


def _expect_positive_int(value: object, pointer: str, code: str) -> int:
    if type(value) is not int or value <= 0:
        _error(code, f"{pointer} must be a positive integer")
    return value


def _string_list(value: object, pointer: str, *, allow_empty: bool = False) -> list[str]:
    if type(value) is not list or (not allow_empty and not value):
        _error("E_SCHEMA_VALUE", f"{pointer} must be a list of strings")
    result: list[str] = []
    for index, item in enumerate(value):
        result.append(_expect_string(item, f"{pointer}/{index}"))
    if len(set(result)) != len(result):
        _error("E_SCHEMA_VALUE", f"{pointer} must not contain duplicates")
    return result


# ---------------------------------------------------------------------------
# Path discipline
# ---------------------------------------------------------------------------


def _collision_key(path: str) -> str:
    """Case-folded key for path collision and containment tests.

    ``str.casefold`` is used rather than a platform path-normalisation helper so
    that the same document yields the same verdict on every operating system.
    Case-insensitive filesystems exist on all mainstream platforms, so two paths
    that differ only by case are treated as one declaration everywhere.
    """

    return path.casefold()


def validate_project_relative_path(
    value: object,
    profile: str,
    *,
    allow_root: bool = False,
) -> str:
    """Validate one project-relative path under a sealed path profile.

    The security-critical rules are always enforced, on every platform:
    traversal segments, absolute and UNC prefixes, drive qualifiers, both
    separator conventions, empty segments, colons, control characters, lone
    surrogates, non-NFC text, and wildcard or redirection characters.

    Only the Windows-specific portability rules -- reserved device names and
    trailing dot or space -- are governed by ``profile``.
    """

    if profile not in PATH_PROFILES:
        _error("E_PATH_PROFILE", "unknown path profile")
    if type(value) is not str:
        _error("E_TARGET_PATH", "project-relative path must be an exact string")
    if allow_root and value == ".":
        return value
    if not value:
        _error("E_TARGET_PATH", "project-relative path must not be empty")
    if len(value) > _MAX_PATH_LENGTH:
        _error("E_TARGET_PATH", "project-relative path is too long")
    if unicodedata.normalize("NFC", value) != value:
        _error("E_TARGET_PATH", "project-relative path must already be NFC")
    if value.startswith(("/", "\\")):
        _error("E_TARGET_PATH", "absolute and UNC paths are forbidden")
    if _DRIVE_RE.match(value):
        _error("E_TARGET_PATH", "drive-qualified paths are forbidden")
    if "\\" in value:
        _error("E_TARGET_PATH", "project-relative paths must use forward slashes only")
    if ":" in value:
        _error("E_TARGET_PATH", "the colon is forbidden in project-relative paths")
    for segment in value.split("/"):
        if not segment:
            _error("E_TARGET_PATH", "empty path segments are forbidden")
        if segment in {".", ".."}:
            _error("E_TARGET_PATH", "dot and traversal path segments are forbidden")
        for character in segment:
            codepoint = ord(character)
            if codepoint < 32 or codepoint == 127:
                _error("E_TARGET_PATH", "control characters are forbidden")
            if 0xD800 <= codepoint <= 0xDFFF:
                _error("E_TARGET_PATH", "lone surrogates are forbidden")
            if character in _INVALID_PATH_CHARACTERS:
                _error("E_TARGET_PATH", "wildcard and redirection characters are forbidden")
        if profile == PATH_PROFILE_WINDOWS_STRICT:
            if segment.endswith((".", " ")):
                _error("E_TARGET_PATH", "path segments must not end with a dot or space")
            if segment.split(".", 1)[0].upper() in _RESERVED_NAMES:
                _error("E_TARGET_PATH", "Windows reserved device name is forbidden")
    return value


def _validate_unique_paths(
    values: object,
    pointer: str,
    profile: str,
    *,
    allow_root: bool = False,
) -> list[str]:
    if type(values) is not list:
        _error("E_SCHEMA_TYPE", f"{pointer} must be a list")
    result = [
        validate_project_relative_path(item, profile, allow_root=allow_root)
        for item in values
    ]
    keys = [_collision_key(item) for item in result]
    if len(set(keys)) != len(keys):
        _error("E_TARGET_PATH", f"{pointer} contains case-colliding paths")
    return result


def _is_within(path: str, root: str) -> bool:
    """Return whether ``path`` is ``root`` itself or lies inside its subtree."""

    if root == ".":
        return True
    path_key = _collision_key(path)
    root_key = _collision_key(root)
    return path_key == root_key or path_key.startswith(root_key + "/")


def _validate_workspace(value: object) -> str:
    """Validate the sealed absolute workspace path in POSIX or Windows form."""

    workspace = _expect_string(value, "/workspace", max_length=_MAX_PATH_LENGTH)
    for character in workspace:
        codepoint = ord(character)
        if codepoint < 32 or codepoint == 127 or 0xD800 <= codepoint <= 0xDFFF:
            _error("E_WORKSPACE", "workspace must not contain control characters or surrogates")
    if _WINDOWS_ABSOLUTE_RE.match(workspace):
        if "/" in workspace:
            _error("E_WORKSPACE", "a Windows workspace must use backslash separators only")
        separator = "\\"
        body = workspace[3:]
    elif workspace.startswith("/"):
        if workspace.startswith("//"):
            _error("E_WORKSPACE", "an implementation-defined double-slash root is forbidden")
        if "\\" in workspace:
            _error("E_WORKSPACE", "a POSIX workspace must use forward slash separators only")
        separator = "/"
        body = workspace[1:]
    else:
        _error(
            "E_WORKSPACE",
            "workspace must be an absolute POSIX path or a drive-qualified Windows path",
        )
    if body:
        for part in body.split(separator):
            if not part:
                _error("E_WORKSPACE", "workspace must not contain empty path segments")
            if part in {".", ".."}:
                _error("E_WORKSPACE", "workspace must not contain dot segments")
    return workspace


def _same_workspace(workspace_root: Path, declared: str) -> bool:
    """Return whether the sealed workspace text designates this workspace root.

    Identity is decided by the filesystem rather than by text normalisation, so
    the verdict does not depend on the host's case-folding rules.
    """

    try:
        declared_path = Path(declared).resolve(strict=True)
    except OSError:
        return False
    if str(workspace_root) == str(declared_path):
        return True
    try:
        return workspace_root.samefile(declared_path)
    except OSError:
        return False


# ---------------------------------------------------------------------------
# Assignment document
# ---------------------------------------------------------------------------


def _validate_progress(value: object, task_name: str) -> dict:
    progress = _expect_exact_keys(value, {"path", "required"}, "/progress")
    expected_path = f"{RUN_DIRECTORY}/{task_name}{PROGRESS_SUFFIX}"
    if progress["path"] != expected_path:
        _error("E_PROGRESS_PATH", f"progress path must be {expected_path}")
    if not _expect_bool(progress["required"], "/progress/required"):
        _error(
            "E_PROGRESS_REQUIRED",
            "/progress/required must be true; evidence is never optional",
        )
    return progress


def _validate_recovery(value: object, task_name: str) -> dict:
    recovery = _expect_exact_keys(
        value,
        {"previous_task_name", "preserve_existing_work"},
        "/recovery",
    )
    previous = recovery["previous_task_name"]
    if previous is not None:
        if type(previous) is not str or not TASK_NAME_RE.fullmatch(previous):
            _error("E_TASK_NAME", "/recovery/previous_task_name is invalid")
        if previous == task_name:
            _error("E_TASK_NAME", "a recovery task must use a fresh task name")
    _expect_bool(recovery["preserve_existing_work"], "/recovery/preserve_existing_work")
    if previous is None and recovery["preserve_existing_work"]:
        _error("E_SCHEMA_VALUE", "initial assignments cannot claim recovery work")
    return recovery


def _validate_control_paths(value: object, profile: str) -> list[str]:
    control_paths = _validate_unique_paths(value, "/control_paths", profile)
    if not control_paths:
        _error("E_CONTROL_PATH", "/control_paths must be a nonempty list")
    keys = {_collision_key(item) for item in control_paths}
    for required in REQUIRED_CONTROL_PATHS:
        if _collision_key(required) not in keys:
            _error("E_CONTROL_PATH", f"/control_paths must include {required}")
    return control_paths


def validate_assignment(value: object) -> dict:
    """Validate one sealed assignment document and return it unchanged."""

    if type(value) is not dict:
        _error("E_SCHEMA_TYPE", "assignment must be an object")
    schema_version = value.get("schema_version")
    if type(schema_version) is not int or schema_version != ASSIGNMENT_SCHEMA_VERSION:
        _error("E_SCHEMA_VERSION", "unsupported assignment schema version")

    mode = value.get("mode")
    if mode == "owner":
        assignment = _expect_exact_keys(value, _OWNER_FIELDS, "/")
        allowed_terminals = OWNER_TERMINALS
    elif mode == "mechanical":
        assignment = _expect_exact_keys(value, _MECHANICAL_FIELDS, "/")
        allowed_terminals = MECHANICAL_TERMINALS
    else:
        _error("E_ASSIGNMENT_MODE", "/mode must be owner or mechanical")

    if assignment["document_type"] != ASSIGNMENT_TYPE:
        _error("E_DOCUMENT_TYPE", "invalid assignment document type")

    assignment_id = _expect_string(assignment["assignment_id"], "/assignment_id", max_length=128)
    if not ASSIGNMENT_ID_RE.fullmatch(assignment_id):
        _error("E_ASSIGNMENT_ID", "assignment_id is not canonical")

    task_name = _expect_string(assignment["task_name"], "/task_name", max_length=64)
    if not TASK_NAME_RE.fullmatch(task_name):
        _error("E_TASK_NAME", "task_name is not canonical")

    _expect_positive_int(assignment["revision"], "/revision", "E_REVISION")

    ceremony = assignment["ceremony"]
    if type(ceremony) is not str or ceremony not in CEREMONIES:
        _error("E_CEREMONY", "/ceremony must be lite or full")

    role = _expect_string(assignment["role"], "/role", max_length=64)
    if not ROLE_NAME_RE.fullmatch(role):
        _error("E_ROLE_NAME", "role name is not canonical")

    _validate_workspace(assignment["workspace"])

    profile = assignment["path_profile"]
    if type(profile) is not str or profile not in PATH_PROFILES:
        _error("E_PATH_PROFILE", "/path_profile must be portable or windows-strict")

    control_paths = _validate_control_paths(assignment["control_paths"], profile)

    gate = _expect_exact_keys(assignment["gate"], {"status", "resolved_by"}, "/gate")
    gate_status = _expect_string(gate["status"], "/gate/status", max_length=64)
    if not GATE_RE.fullmatch(gate_status):
        _error("E_GATE", "gate status is not canonical")
    _expect_string(gate["resolved_by"], "/gate/resolved_by", max_length=128)

    _expect_string(assignment["objective"], "/objective")
    _string_list(assignment["constraints"], "/constraints")
    _string_list(assignment["forbidden_changes"], "/forbidden_changes")
    external_effects = _string_list(
        assignment["external_effects"],
        "/external_effects",
        allow_empty=True,
    )
    if not set(external_effects).issubset(EXTERNAL_EFFECTS):
        _error("E_EXTERNAL_EFFECT", "assignment contains an unknown external effect")

    _validate_progress(assignment["progress"], task_name)

    terminal_states = _string_list(assignment["terminal_states"], "/terminal_states")
    if any(not TERMINAL_RE.fullmatch(state) for state in terminal_states):
        _error("E_TERMINAL_STATE", "terminal state is not canonical")
    if not set(terminal_states).issubset(allowed_terminals) or "DONE" not in terminal_states:
        _error("E_TERMINAL_STATE", "terminal states do not match the assignment mode")
    if ceremony == "lite" and "CHECKPOINT" in terminal_states:
        _error(
            "E_TERMINAL_STATE",
            "the lite ceremony has no resume chain and cannot declare CHECKPOINT; "
            "continue under a fresh task name with recovery.previous_task_name",
        )

    _validate_recovery(assignment["recovery"], task_name)

    if mode == "owner":
        ownership_root = validate_project_relative_path(
            assignment["ownership_root"],
            profile,
            allow_root=True,
        )
        protected = _validate_unique_paths(
            assignment["protected_paths"],
            "/protected_paths",
            profile,
        )
        for control in control_paths:
            if not _is_within(control, ownership_root):
                continue
            if not any(_is_within(control, entry) for entry in protected):
                _error(
                    "E_CONTROL_PATH",
                    f"ownership root must protect the control path {control}",
                )
        _string_list(assignment["acceptance_outcomes"], "/acceptance_outcomes")
    else:
        targets = assignment["targets"]
        if type(targets) is not list or not targets:
            _error("E_TARGETS", "/targets must be a nonempty list")
        paths: list[str] = []
        for index, target_value in enumerate(targets):
            target = _expect_exact_keys(
                target_value,
                {"path", "expected_base"},
                f"/targets/{index}",
            )
            path = validate_project_relative_path(target["path"], profile)
            for control in control_paths:
                if _is_within(path, control) or _is_within(control, path):
                    _error(
                        "E_TARGET_PATH",
                        "mechanical targets cannot reach control-plane paths",
                    )
            expected_base = target["expected_base"]
            if expected_base != "ABSENT" and (
                type(expected_base) is not str or not HASH_RE.fullmatch(expected_base)
            ):
                _error("E_TARGET_BASE", "expected_base must be ABSENT or lowercase SHA-256")
            paths.append(path)
        _validate_unique_paths(paths, "/targets/path", profile)
        _expect_string(assignment["required_behavior"], "/required_behavior")
        _string_list(assignment["acceptance_commands"], "/acceptance_commands")
    return assignment


def _validate_typed_hash(value: object, expected_kind: str, pointer: str) -> dict:
    result = _expect_exact_keys(value, {"hash_kind", "algorithm", "value"}, pointer)
    if result["hash_kind"] != expected_kind or result["algorithm"] != "sha256":
        _error("E_HASH_TYPE", f"{pointer} has the wrong typed-hash domain")
    if type(result["value"]) is not str or not HASH_RE.fullmatch(result["value"]):
        _error("E_HASH_VALUE", f"{pointer}/value is not lowercase SHA-256")
    return result


# ---------------------------------------------------------------------------
# Lead-plane and evidence-plane locations
# ---------------------------------------------------------------------------


def assignment_path_for(workspace_root: Path, task_name: str) -> Path:
    if not TASK_NAME_RE.fullmatch(task_name):
        _error("E_TASK_NAME", "task name is not canonical")
    return workspace_root / ASSIGNMENT_DIRECTORY / f"{task_name}{ASSIGNMENT_SUFFIX}"


def receipt_path_for(assignment_path: Path) -> Path:
    if not assignment_path.name.endswith(ASSIGNMENT_SUFFIX):
        _error("E_ASSIGNMENT_PATH", f"assignment filename must end with {ASSIGNMENT_SUFFIX}")
    stem = assignment_path.name[: -len(ASSIGNMENT_SUFFIX)]
    return assignment_path.with_name(stem + RECEIPT_SUFFIX)


def dispatch_path_for(workspace_root: Path, expected_role: str) -> Path:
    if type(expected_role) is not str or not ROLE_NAME_RE.fullmatch(expected_role):
        _error("E_ROLE_NAME", "role name is not canonical")
    return (
        workspace_root
        / DISPATCH_DIRECTORY
        / f"{expected_role}{CURRENT_DISPATCH_SUFFIX}"
    )


def dispatch_archive_path_for(
    workspace_root: Path,
    dispatch_id: str,
    generation: int,
) -> Path:
    if type(dispatch_id) is not str or not DISPATCH_ID_RE.fullmatch(dispatch_id):
        _error("E_DISPATCH_ID", "dispatch id is not canonical")
    if type(generation) is not int or generation <= 0 or generation > _MAX_GENERATION:
        _error(
            "E_DISPATCH_GENERATION",
            f"dispatch generation must be between one and {_MAX_GENERATION}",
        )
    return (
        workspace_root
        / DISPATCH_ARCHIVE_DIRECTORY
        / f"{dispatch_id}.g{generation}.json"
    )


def _task_name_from_assignment_path(path: Path) -> str:
    if not path.name.endswith(ASSIGNMENT_SUFFIX):
        _error("E_ASSIGNMENT_PATH", f"assignment filename must end with {ASSIGNMENT_SUFFIX}")
    task_name = path.name[: -len(ASSIGNMENT_SUFFIX)]
    if not TASK_NAME_RE.fullmatch(task_name):
        _error("E_TASK_NAME", "assignment filename has an invalid task name")
    return task_name


# ---------------------------------------------------------------------------
# Receipt
# ---------------------------------------------------------------------------


def render_receipt(assignment_path: Path) -> dict:
    """Render the receipt that seals one assignment by two independent hashes."""

    data = assignment_path.read_bytes()
    assignment = validate_assignment(parse_json_bytes(data))
    task_name = _task_name_from_assignment_path(assignment_path)
    if assignment["task_name"] != task_name:
        _error("E_TASK_NAME", "assignment filename and task_name differ")
    return {
        "schema_version": RECEIPT_SCHEMA_VERSION,
        "document_type": RECEIPT_TYPE,
        "assignment_id": assignment["assignment_id"],
        "task_name": task_name,
        "assignment_document": _typed_hash("document", data),
        "assignment_semantic_payload": _typed_hash(
            "semantic_payload",
            canonicalize(assignment),
        ),
    }


def _validate_receipt(value: object) -> dict:
    receipt = _expect_exact_keys(value, _RECEIPT_FIELDS, "/")
    if type(receipt["schema_version"]) is not int or receipt["schema_version"] != RECEIPT_SCHEMA_VERSION:
        _error("E_SCHEMA_VERSION", "unsupported receipt schema version")
    if receipt["document_type"] != RECEIPT_TYPE:
        _error("E_DOCUMENT_TYPE", "invalid receipt document type")
    assignment_id = _expect_string(receipt["assignment_id"], "/assignment_id", max_length=128)
    if not ASSIGNMENT_ID_RE.fullmatch(assignment_id):
        _error("E_ASSIGNMENT_ID", "receipt assignment_id is not canonical")
    task_name = _expect_string(receipt["task_name"], "/task_name", max_length=64)
    if not TASK_NAME_RE.fullmatch(task_name):
        _error("E_TASK_NAME", "receipt task name is not canonical")
    _validate_typed_hash(receipt["assignment_document"], "document", "/assignment_document")
    _validate_typed_hash(
        receipt["assignment_semantic_payload"],
        "semantic_payload",
        "/assignment_semantic_payload",
    )
    return receipt


# ---------------------------------------------------------------------------
# Seal verification
# ---------------------------------------------------------------------------


def verify_assignment(
    task_name: str,
    workspace_root: Path,
    expected_mode: str | None = None,
    expected_role: str | None = None,
) -> tuple[dict, dict]:
    """Verify the sealed assignment and its receipt for one exact task name.

    This is the seal layer.  It never reads the evidence plane and never reads
    a dispatch binding, so it is safe to call from every higher layer and it
    stays callable at the exact moment a worker needs it: before its first
    project write, when no evidence exists yet.
    """

    workspace_root = workspace_root.resolve(strict=True)
    assignment_path = assignment_path_for(workspace_root, task_name)
    receipt_path = receipt_path_for(assignment_path)
    assignment_bytes = assignment_path.read_bytes()
    receipt_bytes = receipt_path.read_bytes()
    assignment = validate_assignment(parse_json_bytes(assignment_bytes))
    receipt = _validate_receipt(parse_json_bytes(receipt_bytes))
    expected_receipt = render_receipt(assignment_path)
    if receipt_bytes != canonicalize(receipt) + b"\n":
        _error("E_RECEIPT_CANONICAL", "receipt must be one canonical JSON line")
    if receipt != expected_receipt:
        if receipt["assignment_document"] != expected_receipt["assignment_document"]:
            _error("E_DOCUMENT_HASH", "assignment exact-byte hash does not match receipt")
        if receipt["assignment_semantic_payload"] != expected_receipt["assignment_semantic_payload"]:
            _error("E_SEMANTIC_HASH", "assignment semantic hash does not match receipt")
        _error("E_RECEIPT_BINDING", "receipt metadata does not match assignment")
    if assignment["task_name"] != task_name or receipt["task_name"] != task_name:
        _error("E_TASK_NAME", "task-name binding failed")
    if expected_mode is not None and assignment["mode"] != expected_mode:
        _error("E_ASSIGNMENT_MODE", "assignment mode does not match the expected mode")
    if expected_role is not None and assignment["role"] != expected_role:
        _error("E_ROLE", "assignment role does not match the expected role")
    if not _same_workspace(workspace_root, assignment["workspace"]):
        _error("E_WORKSPACE", "assignment workspace does not match the current workspace")
    ack = {
        "assignment_document_sha256": expected_receipt["assignment_document"]["value"],
        "assignment_id": assignment["assignment_id"],
        "ceremony": assignment["ceremony"],
        "gate": assignment["gate"],
        "mode": assignment["mode"],
        "ownership_root": assignment.get("ownership_root"),
        "path_profile": assignment["path_profile"],
        "progress_path": assignment["progress"]["path"],
        "revision": assignment["revision"],
        "role": assignment["role"],
        "task_name": task_name,
    }
    return assignment, ack


def _require_full_ceremony(assignment: dict) -> None:
    """Reject any attempt to run the dispatch chain on a lite assignment."""

    if assignment["ceremony"] != "full":
        _error(
            "E_CEREMONY",
            "the sealed assignment declares the lite ceremony and has no dispatch chain",
        )


def _require_open_gate(assignment: dict) -> None:
    """Refuse to advance a delegated run whose sealed gate is not open.

    The gate is a lead decision carried inside the sealed document, so a closed
    gate cannot be argued away from the command line.  ``verify`` stays outside
    this rule on purpose: reading a seal is not executing under it, and a lead
    must stay able to inspect a document whose gate it has just closed.
    """

    status = assignment["gate"]["status"]
    if status != GATE_STATUS_OPEN:
        _error(
            "E_GATE_NOT_OPEN",
            f"the sealed gate status is {status}, not {GATE_STATUS_OPEN}",
        )


# ---------------------------------------------------------------------------
# Dispatch binding
# ---------------------------------------------------------------------------


def _dispatch_binding_payload(dispatch: dict) -> dict:
    return {key: dispatch[key] for key in _DISPATCH_BINDING_FIELDS}


def _validate_dispatch(value: object) -> dict:
    dispatch = _expect_exact_keys(value, _DISPATCH_FIELDS, "/")
    if type(dispatch["schema_version"]) is not int or dispatch["schema_version"] != DISPATCH_SCHEMA_VERSION:
        _error("E_SCHEMA_VERSION", "unsupported dispatch schema version")
    if dispatch["document_type"] != DISPATCH_TYPE:
        _error("E_DOCUMENT_TYPE", "invalid dispatch document type")
    activation_kind = dispatch["activation_kind"]
    if activation_kind not in ACTIVATION_KINDS:
        _error("E_DISPATCH_ACTIVATION", "activation kind must be INITIAL or RESUME")
    dispatch_id = _expect_string(dispatch["dispatch_id"], "/dispatch_id", max_length=128)
    if not DISPATCH_ID_RE.fullmatch(dispatch_id):
        _error("E_DISPATCH_ID", "dispatch id is not canonical")
    generation = dispatch["generation"]
    if type(generation) is not int or generation <= 0 or generation > _MAX_GENERATION:
        _error(
            "E_DISPATCH_GENERATION",
            f"dispatch generation must be between one and {_MAX_GENERATION}",
        )
    _validate_workspace(dispatch["workspace"])
    role = _expect_string(dispatch["role"], "/role", max_length=64)
    if not ROLE_NAME_RE.fullmatch(role):
        _error("E_ROLE_NAME", "dispatch role name is not canonical")
    if dispatch["mode"] not in MODES:
        _error("E_DISPATCH_ROLE", "dispatch mode must be owner or mechanical")
    task_name = _expect_string(dispatch["task_name"], "/task_name", max_length=64)
    if not TASK_NAME_RE.fullmatch(task_name):
        _error("E_TASK_NAME", "dispatch task name is not canonical")
    assignment_id = _expect_string(dispatch["assignment_id"], "/assignment_id", max_length=128)
    if not ASSIGNMENT_ID_RE.fullmatch(assignment_id):
        _error("E_ASSIGNMENT_ID", "dispatch assignment id is not canonical")
    _expect_positive_int(dispatch["revision"], "/revision", "E_REVISION")
    _validate_typed_hash(
        dispatch["assignment_document"],
        "assignment_document",
        "/assignment_document",
    )
    _validate_typed_hash(
        dispatch["receipt_document"],
        "receipt_document",
        "/receipt_document",
    )
    _validate_typed_hash(
        dispatch["binding_document"],
        "dispatch_binding",
        "/binding_document",
    )
    expected_binding = _typed_hash(
        "dispatch_binding",
        canonicalize(_dispatch_binding_payload(dispatch)),
    )
    if dispatch["binding_document"] != expected_binding:
        _error("E_DISPATCH_BINDING", "dispatch binding hash does not match its bound fields")

    resume = dispatch["resume"]
    if activation_kind == "INITIAL":
        if generation != 1 or resume is not None:
            _error("E_DISPATCH_ACTIVATION", "INITIAL requires generation one and null resume")
    else:
        if generation <= 1:
            _error("E_DISPATCH_ACTIVATION", "RESUME requires generation greater than one")
        resume = _expect_exact_keys(resume, _DISPATCH_RESUME_FIELDS, "/resume")
        if resume["host_same_agent_confirmed"] is not True:
            _error("E_DISPATCH_RESUME", "RESUME requires host-confirmed same-agent identity")
        event_count = resume["event_count"]
        last_seq = resume["last_seq"]
        if type(event_count) is not int or event_count <= 0:
            _error("E_DISPATCH_RESUME", "resume event count must be positive")
        if type(last_seq) is not int or last_seq != event_count:
            _error("E_DISPATCH_RESUME", "resume last sequence must equal event count")
        previous_generation = resume["previous_generation"]
        if type(previous_generation) is not int or previous_generation != generation - 1:
            _error("E_DISPATCH_RESUME", "resume must reference the previous generation")
        last_state = resume["last_state"]
        if type(last_state) is not str or last_state not in PROGRESS_STATES:
            _error("E_DISPATCH_RESUME", "resume last state is invalid")
        if last_state in RUN_ENDING_STATES:
            _error("E_DISPATCH_RESUME", "terminal progress cannot be resumed")
        _validate_typed_hash(
            resume["previous_dispatch_document"],
            "dispatch_document",
            "/resume/previous_dispatch_document",
        )
        _validate_typed_hash(
            resume["progress_document"],
            "progress_document",
            "/resume/progress_document",
        )
    return dispatch


def _require_single_dispatch_path(workspace_root: Path, expected_role: str) -> Path:
    """Enforce the single-pointer invariant on the whole dispatch directory.

    Roles are free strings, so the invariant is enforced by scanning the fixed
    dispatch directory rather than by consulting a closed role table.  The scan
    is exhaustive rather than filtered: the directory may hold the ``archive``
    subdirectory and at most one canonically named current binding, which must
    be a regular file.  Everything else -- a second pointer, a placeholder such
    as ``.gitkeep``, a stray file, or a *directory* wearing a pointer name --
    makes the live binding ambiguous, and an ambiguous binding is refused.
    """

    selected = dispatch_path_for(workspace_root, expected_role)
    directory = workspace_root / DISPATCH_DIRECTORY
    try:
        entries = sorted(directory.iterdir(), key=lambda item: item.name)
    except FileNotFoundError:
        return selected
    except NotADirectoryError:
        _error("E_DISPATCH_CONFLICT", "the dispatch location is not a directory")
    pointers: list[str] = []
    for entry in entries:
        name = entry.name
        if name == DISPATCH_ARCHIVE_NAME:
            if not entry.is_dir():
                _error(
                    "E_DISPATCH_CONFLICT",
                    f"the dispatch archive entry {name!r} is not a directory",
                )
            continue
        if not CURRENT_DISPATCH_NAME_RE.fullmatch(name) or not entry.is_file():
            _error(
                "E_DISPATCH_CONFLICT",
                f"the dispatch directory holds an unexpected entry: {name!r}",
            )
        pointers.append(name)
    if len(pointers) > 1:
        _error(
            "E_DISPATCH_CONFLICT",
            "the dispatch directory holds more than one current binding",
        )
    if pointers and pointers[0] != selected.name:
        _error(
            "E_DISPATCH_CONFLICT",
            "another role already holds the current binding for this workspace",
        )
    return selected


def _read_canonical_dispatch(path: Path) -> tuple[dict, bytes]:
    data = path.read_bytes()
    dispatch = _validate_dispatch(parse_json_bytes(data))
    if data != canonicalize(dispatch) + b"\n":
        _error("E_DISPATCH_CANONICAL", "dispatch must be one canonical JSON line")
    return dispatch, data


def _verify_dispatch_archive_chain(workspace_root: Path, dispatch: dict) -> set[int]:
    """Rebuild every generation boundary from the immutable archive chain."""

    required_ready_sequences = {1}
    if dispatch["activation_kind"] == "INITIAL":
        return required_ready_sequences
    newer_event_count = dispatch["resume"]["event_count"]
    required_ready_sequences.add(newer_event_count + 1)
    expected_hash = dispatch["resume"]["previous_dispatch_document"]["value"]
    generation = dispatch["generation"] - 1
    while generation >= 1:
        archive_path = dispatch_archive_path_for(
            workspace_root,
            dispatch["dispatch_id"],
            generation,
        )
        archived, archived_bytes = _read_canonical_dispatch(archive_path)
        if sha256_hex(archived_bytes) != expected_hash:
            _error("E_DISPATCH_HISTORY", "archived dispatch exact-byte hash mismatch")
        if (
            archived["dispatch_id"] != dispatch["dispatch_id"]
            or archived["generation"] != generation
            or archived["binding_document"] != dispatch["binding_document"]
        ):
            _error("E_DISPATCH_HISTORY", "archived dispatch binding or generation mismatch")
        if generation == 1:
            if archived["activation_kind"] != "INITIAL":
                _error("E_DISPATCH_HISTORY", "dispatch history must begin with INITIAL")
            return required_ready_sequences
        if archived["activation_kind"] != "RESUME":
            _error("E_DISPATCH_HISTORY", "intermediate dispatch history must be RESUME")
        archived_event_count = archived["resume"]["event_count"]
        if archived_event_count >= newer_event_count:
            _error(
                "E_DISPATCH_HISTORY",
                "resume event counts must increase across generations",
            )
        required_ready_sequences.add(archived_event_count + 1)
        newer_event_count = archived_event_count
        expected_hash = archived["resume"]["previous_dispatch_document"]["value"]
        generation -= 1
    _error("E_DISPATCH_HISTORY", "dispatch history did not terminate at generation one")


def _verify_dispatch_core(
    workspace_root: Path,
    expected_role: str,
) -> tuple[dict, dict, dict, bytes, set[int]]:
    workspace_root = workspace_root.resolve(strict=True)
    selected = _require_single_dispatch_path(workspace_root, expected_role)
    dispatch, dispatch_bytes = _read_canonical_dispatch(selected)
    if dispatch["role"] != expected_role:
        _error("E_DISPATCH_ROLE", "the fixed dispatch path does not match its role field")
    if not _same_workspace(workspace_root, dispatch["workspace"]):
        _error("E_WORKSPACE", "dispatch workspace does not match the current workspace")
    assignment, assignment_ack = verify_assignment(
        dispatch["task_name"],
        workspace_root,
        expected_role=expected_role,
    )
    _require_full_ceremony(assignment)
    if (
        dispatch["assignment_id"] != assignment["assignment_id"]
        or dispatch["revision"] != assignment["revision"]
        or dispatch["role"] != assignment["role"]
        or dispatch["mode"] != assignment["mode"]
    ):
        _error("E_DISPATCH_BINDING", "dispatch metadata does not match assignment")
    if (
        dispatch["assignment_document"]["value"]
        != assignment_ack["assignment_document_sha256"]
    ):
        _error("E_DISPATCH_BINDING", "dispatch assignment hash does not match")
    assignment_path = assignment_path_for(workspace_root, dispatch["task_name"])
    receipt_bytes = receipt_path_for(assignment_path).read_bytes()
    if dispatch["receipt_document"]["value"] != sha256_hex(receipt_bytes):
        _error("E_DISPATCH_BINDING", "dispatch receipt hash does not match")
    required_ready_sequences = _verify_dispatch_archive_chain(workspace_root, dispatch)
    dispatch_ack = dict(assignment_ack)
    dispatch_ack.update(
        {
            "activation_kind": dispatch["activation_kind"],
            "dispatch_binding_sha256": dispatch["binding_document"]["value"],
            "dispatch_document_sha256": sha256_hex(dispatch_bytes),
            "dispatch_id": dispatch["dispatch_id"],
            "generation": dispatch["generation"],
        }
    )
    return assignment, dispatch, dispatch_ack, dispatch_bytes, required_ready_sequences


def _build_dispatch(
    workspace_root: Path,
    assignment: dict,
    assignment_ack: dict,
    *,
    dispatch_id: str,
    generation: int,
    activation_kind: str,
    resume: dict | None,
) -> dict:
    assignment_path = assignment_path_for(workspace_root, assignment["task_name"])
    receipt_bytes = receipt_path_for(assignment_path).read_bytes()
    dispatch = {
        "schema_version": DISPATCH_SCHEMA_VERSION,
        "document_type": DISPATCH_TYPE,
        "activation_kind": activation_kind,
        "dispatch_id": dispatch_id,
        "generation": generation,
        "workspace": assignment["workspace"],
        "role": assignment["role"],
        "mode": assignment["mode"],
        "task_name": assignment["task_name"],
        "assignment_id": assignment["assignment_id"],
        "revision": assignment["revision"],
        "assignment_document": {
            "hash_kind": "assignment_document",
            "algorithm": "sha256",
            "value": assignment_ack["assignment_document_sha256"],
        },
        "receipt_document": _typed_hash("receipt_document", receipt_bytes),
        "binding_document": None,
        "resume": resume,
    }
    dispatch["binding_document"] = _typed_hash(
        "dispatch_binding",
        canonicalize(_dispatch_binding_payload(dispatch)),
    )
    return _validate_dispatch(dispatch)


def render_initial_dispatch(
    workspace_root: Path,
    task_name: str,
    expected_role: str,
    dispatch_id: str,
) -> dict:
    workspace_root = workspace_root.resolve(strict=True)
    selected = _require_single_dispatch_path(workspace_root, expected_role)
    if selected.exists():
        _error("E_DISPATCH_ACTIVE", "the selected role already has an active dispatch")
    assignment, assignment_ack = verify_assignment(
        task_name,
        workspace_root,
        expected_role=expected_role,
    )
    _require_full_ceremony(assignment)
    _require_open_gate(assignment)
    progress_path = workspace_root / assignment["progress"]["path"]
    if progress_path.exists():
        _error("E_DISPATCH_PROGRESS", "INITIAL requires the progress file to be absent")
    return _build_dispatch(
        workspace_root,
        assignment,
        assignment_ack,
        dispatch_id=dispatch_id,
        generation=1,
        activation_kind="INITIAL",
        resume=None,
    )


def render_resume_dispatch(
    workspace_root: Path,
    expected_role: str,
) -> tuple[dict, Path, bytes]:
    workspace_root = workspace_root.resolve(strict=True)
    assignment, current, ack, current_bytes, required_ready_sequences = _verify_dispatch_core(
        workspace_root,
        expected_role,
    )
    _require_open_gate(assignment)
    progress_path = workspace_root / assignment["progress"]["path"]
    progress_bytes = progress_path.read_bytes()
    events = validate_progress_bytes(
        progress_bytes,
        assignment,
        ack["assignment_document_sha256"],
        dispatch_id=ack["dispatch_id"],
        dispatch_binding_sha256=ack["dispatch_binding_sha256"],
        required_ready_sequences=required_ready_sequences,
    )
    last = events[-1]
    if last["state"] in RUN_ENDING_STATES:
        _error("E_DISPATCH_RESUME", "terminal progress cannot be resumed")
    archive_path = dispatch_archive_path_for(
        workspace_root,
        current["dispatch_id"],
        current["generation"],
    )
    if archive_path.exists():
        _error("E_DISPATCH_HISTORY", "the previous dispatch archive already exists")
    resume = {
        "event_count": len(events),
        "host_same_agent_confirmed": True,
        "last_seq": last["seq"],
        "last_state": last["state"],
        "previous_dispatch_document": _typed_hash("dispatch_document", current_bytes),
        "previous_generation": current["generation"],
        "progress_document": _typed_hash("progress_document", progress_bytes),
    }
    updated = _build_dispatch(
        workspace_root,
        assignment,
        ack,
        dispatch_id=current["dispatch_id"],
        generation=current["generation"] + 1,
        activation_kind="RESUME",
        resume=resume,
    )
    return updated, archive_path, current_bytes


def resolve_dispatch(workspace_root: Path, expected_role: str) -> tuple[dict, dict]:
    """Resolve the installed current binding: the worker's first authorized act."""

    workspace_root = workspace_root.resolve(strict=True)
    assignment, dispatch, ack, _, required_ready_sequences = _verify_dispatch_core(
        workspace_root,
        expected_role,
    )
    _require_open_gate(assignment)
    progress_path = workspace_root / assignment["progress"]["path"]
    if dispatch["activation_kind"] == "INITIAL":
        if progress_path.exists():
            _error("E_DISPATCH_PROGRESS", "INITIAL requires the progress file to be absent")
    else:
        progress_bytes = progress_path.read_bytes()
        events = validate_progress_bytes(
            progress_bytes,
            assignment,
            ack["assignment_document_sha256"],
            dispatch_id=ack["dispatch_id"],
            dispatch_binding_sha256=ack["dispatch_binding_sha256"],
            required_ready_sequences=(
                required_ready_sequences - {dispatch["resume"]["event_count"] + 1}
            ),
        )
        resume = dispatch["resume"]
        last = events[-1]
        if (
            len(events) != resume["event_count"]
            or last["seq"] != resume["last_seq"]
            or last["state"] != resume["last_state"]
            or sha256_hex(progress_bytes) != resume["progress_document"]["value"]
        ):
            _error("E_DISPATCH_RESUME", "progress does not match the sealed resume snapshot")
    return assignment, ack


def retire_dispatch(
    workspace_root: Path,
    expected_role: str,
) -> tuple[dict, Path, bytes]:
    """Close a finished lineage: the mirror image of an INITIAL activation.

    A lineage must end as verifiably as it begins.  Retirement is refused unless
    the installed binding verifies in full and the evidence record it governs
    ends at a halting outcome the sealed assignment authorized, so a pointer can
    never be dropped to make an unfinished or unauthorized run disappear.  A
    ``CHECKPOINT`` is a pause rather than an end, so it does not qualify.

    Like every other command this one only reads and reports.  It returns the
    archive location and the exact bytes to archive there; installing the
    archive and deleting the pointer are lead-plane writes, exactly as with an
    INITIAL or RESUME binding.  A verifier that wrote the lead plane would hand
    every caller of the verifier -- the worker included -- a lever on the plane
    the worker must never be able to touch.
    """

    workspace_root = workspace_root.resolve(strict=True)
    assignment, dispatch, ack, dispatch_bytes, required_ready_sequences = (
        _verify_dispatch_core(workspace_root, expected_role)
    )
    progress_path = workspace_root / assignment["progress"]["path"]
    events = validate_progress_bytes(
        _read_progress_bytes(progress_path),
        assignment,
        ack["assignment_document_sha256"],
        dispatch_id=ack["dispatch_id"],
        dispatch_binding_sha256=ack["dispatch_binding_sha256"],
        required_ready_sequences=required_ready_sequences,
    )
    last = events[-1]
    if last["state"] not in RUN_ENDING_STATES:
        _error(
            "E_PROGRESS_STATE",
            "the run has not reached an authorized halting outcome; "
            f"the last progress state is {last['state']}",
        )
    archive_path = dispatch_archive_path_for(
        workspace_root,
        dispatch["dispatch_id"],
        dispatch["generation"],
    )
    if archive_path.exists():
        _error("E_DISPATCH_HISTORY", "the final dispatch archive already exists")
    retired = {
        "dispatch_id": dispatch["dispatch_id"],
        "event_count": len(events),
        "generation": dispatch["generation"],
        "last_state": last["state"],
        "role": dispatch["role"],
        "task_name": dispatch["task_name"],
    }
    return retired, archive_path, dispatch_bytes


# ---------------------------------------------------------------------------
# Evidence plane
# ---------------------------------------------------------------------------


def validate_progress_bytes(
    data: bytes,
    assignment: dict,
    assignment_document_sha256: str,
    *,
    dispatch_id: str | None = None,
    dispatch_binding_sha256: str | None = None,
    required_ready_sequences: set[int] | None = None,
) -> list[dict]:
    """Validate the append-only evidence record for one sealed assignment.

    The event schema is selected by the sealed ceremony, never by a caller
    preference: a full-ceremony event carries dispatch identity, a lite event
    does not, and exact-key checking makes each shape unusable under the other
    ceremony.
    """

    if type(data) is not bytes:
        _error("E_PROGRESS_TYPE", "progress input must be exact bytes")
    if not data or not data.endswith(b"\n"):
        _error("E_PROGRESS_FORMAT", "progress JSONL must be nonempty and end with LF")

    ceremony = assignment["ceremony"]
    if ceremony == "full":
        if dispatch_id is None or dispatch_binding_sha256 is None:
            _error("E_CEREMONY", "full assignments require dispatch-bound progress validation")
        fields = _FULL_PROGRESS_EVENT_FIELDS
    elif ceremony == "lite":
        if dispatch_id is not None or dispatch_binding_sha256 is not None:
            _error("E_CEREMONY", "lite assignments have no dispatch binding")
        fields = _LITE_PROGRESS_EVENT_FIELDS
    else:
        _error("E_CEREMONY", "the assignment declares an unknown ceremony")

    if required_ready_sequences is None:
        required_ready_sequences = {1}
    if 1 not in required_ready_sequences or any(
        type(sequence) is not int or sequence <= 0
        for sequence in required_ready_sequences
    ):
        _error("E_PROGRESS_STATE", "required READY sequences are invalid")
    if ceremony == "lite" and required_ready_sequences != {1}:
        _error("E_CEREMONY", "a lite assignment has exactly one activation boundary")

    events: list[dict] = []
    terminal_seen = False
    allowed_terminals = set(assignment["terminal_states"])
    for index, line in enumerate(data.splitlines(), start=1):
        event = _expect_exact_keys(
            parse_json_bytes(line),
            fields,
            f"/line/{index}",
        )
        if canonicalize(event) != line:
            _error("E_PROGRESS_CANONICAL", f"progress line {index} is not canonical JSON")
        if event["task_name"] != assignment["task_name"]:
            _error("E_PROGRESS_BINDING", "progress task name does not match assignment")
        if event["assignment_document_sha256"] != assignment_document_sha256:
            _error("E_PROGRESS_BINDING", "progress assignment hash does not match")
        if ceremony == "full":
            if event["dispatch_id"] != dispatch_id:
                _error("E_PROGRESS_BINDING", "progress dispatch id does not match")
            if event["dispatch_binding_sha256"] != dispatch_binding_sha256:
                _error("E_PROGRESS_BINDING", "progress dispatch binding hash does not match")
        if type(event["seq"]) is not int or event["seq"] != index:
            _error("E_PROGRESS_SEQUENCE", "progress sequence must be contiguous from one")
        state = event["state"]
        if type(state) is not str or state not in PROGRESS_STATES:
            _error("E_PROGRESS_STATE", "unknown progress state")
        _expect_string(event["summary"], f"/line/{index}/summary", max_length=_MAX_SUMMARY_LENGTH)
        if index in required_ready_sequences and state != "READY":
            _error(
                "E_PROGRESS_STATE",
                f"progress event {index} must be READY at its activation boundary",
            )
        if terminal_seen:
            _error("E_PROGRESS_STATE", "no progress event may follow a terminal event")
        if state in OUTCOME_STATES:
            if state not in allowed_terminals:
                _error(
                    "E_PROGRESS_STATE",
                    f"the assignment does not declare the outcome state {state}",
                )
            if state in RUN_ENDING_STATES:
                terminal_seen = True
        events.append(event)
    missing_ready = sorted(
        sequence for sequence in required_ready_sequences if sequence > len(events)
    )
    if missing_ready:
        _error(
            "E_PROGRESS_STATE",
            f"progress is missing READY activation boundary {missing_ready[0]}",
        )
    return events


def _read_progress_bytes(progress_path: Path) -> bytes:
    """Read the evidence record, failing closed when there is none.

    Every sealed assignment requires evidence, so a missing record is never an
    implicit pass.  It is not authorization to proceed and it is not acceptance
    either: it simply fails the acceptance gate.
    """

    try:
        return progress_path.read_bytes()
    except FileNotFoundError:
        _error(
            "E_PROGRESS_MISSING",
            "the sealed assignment requires a progress record and none exists",
        )


def validate_progress(
    task_name: str,
    workspace_root: Path,
    expected_mode: str | None = None,
    expected_role: str | None = None,
) -> tuple[dict, list[dict]]:
    """Run the acceptance-gate evidence check for the sealed ceremony."""

    workspace_root = workspace_root.resolve(strict=True)
    assignment, ack = verify_assignment(
        task_name,
        workspace_root,
        expected_mode,
        expected_role,
    )
    _require_open_gate(assignment)
    progress_path = workspace_root / assignment["progress"]["path"]
    if assignment["ceremony"] == "lite":
        events = validate_progress_bytes(
            _read_progress_bytes(progress_path),
            assignment,
            ack["assignment_document_sha256"],
        )
        return assignment, events
    _, dispatch, dispatch_ack, _, required_ready_sequences = _verify_dispatch_core(
        workspace_root,
        assignment["role"],
    )
    if dispatch["task_name"] != task_name:
        _error("E_DISPATCH_BINDING", "the active dispatch does not match this task name")
    events = validate_progress_bytes(
        _read_progress_bytes(progress_path),
        assignment,
        dispatch_ack["assignment_document_sha256"],
        dispatch_id=dispatch_ack["dispatch_id"],
        dispatch_binding_sha256=dispatch_ack["dispatch_binding_sha256"],
        required_ready_sequences=required_ready_sequences,
    )
    return assignment, events


# ---------------------------------------------------------------------------
# Base assertions
# ---------------------------------------------------------------------------


def _base_entry_present(path: Path) -> bool:
    """Return whether anything at all occupies ``path``.

    A dangling symlink is still an entry, so the test is deliberately wider than
    ``Path.exists``: ``ABSENT`` asserts that nothing is there, not that nothing
    readable is there.
    """

    return path.exists() or path.is_symlink()


def verify_bases(task_name: str, workspace_root: Path) -> tuple[dict, int]:
    """Check every sealed ``expected_base`` assertion against the real tree.

    A sealed assignment states what it expects to find before the work starts:
    ``ABSENT`` for a path it expects to create, or the exact SHA-256 of the file
    it expects to modify.  A base that has already drifted means the sealed plan
    was written against a tree that no longer exists, so the lead must re-seal
    instead of letting a worker edit a file nobody described.

    This is a standalone audit and is deliberately not wired into the dispatch
    path.  The dispatch chain proves authority; re-hashing declared files at
    every activation would charge every run for a check a lead needs only at a
    delegation boundary.
    """

    workspace_root = workspace_root.resolve(strict=True)
    assignment, _ = verify_assignment(task_name, workspace_root)
    checked = 0
    for target in assignment.get("targets", ()):
        path = target["path"]
        expected_base = target["expected_base"]
        actual = workspace_root / path
        checked += 1
        if expected_base == "ABSENT":
            if _base_entry_present(actual):
                _error(
                    "E_BASE_MISMATCH",
                    f"the sealed base declares {path} absent but it exists",
                )
            continue
        if not actual.is_file():
            _error(
                "E_BASE_MISMATCH",
                f"the sealed base asserts a hash for {path} but it is not a file",
            )
        if sha256_hex(actual.read_bytes()) != expected_base:
            _error("E_BASE_MISMATCH", f"the sealed base hash does not match {path}")
    return assignment, checked


# ---------------------------------------------------------------------------
# Scope audit
# ---------------------------------------------------------------------------


def parse_scope_paths(data: bytes, profile: str) -> list[str]:
    """Parse a NUL-separated list of changed project-relative paths.

    The list is produced by the lead, from ``git diff --name-only -z`` plus
    ``git ls-files --others --exclude-standard -z``.  NUL separation is the only
    accepted form, because a real filename may contain a newline: a line-based
    parser would silently split one out-of-scope path into two fragments that
    each look in-scope, which turns the audit into a bypass.  A trailing
    separator is optional.  This function never shells out; it only reads the
    bytes it is handed.
    """

    if type(data) is not bytes:
        _error("E_SCOPE_INPUT", "path list input must be exact bytes")
    if data.startswith(b"\xef\xbb\xbf"):
        _error("E_SCOPE_INPUT", "UTF-8 BOM is forbidden in the path list")
    try:
        text = data.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        _error("E_SCOPE_INPUT", f"invalid UTF-8 in the path list at byte {exc.start}")
    if not text:
        return []
    if text.endswith("\x00"):
        text = text[:-1]
    ordered: list[str] = []
    seen: set[str] = set()
    for number, entry in enumerate(text.split("\x00"), start=1):
        if not entry:
            _error("E_SCOPE_INPUT", f"path list entry {number} is empty")
        if "\n" in entry:
            _error(
                "E_SCOPE_INPUT",
                f"path list entry {number} contains a newline; the list must be "
                "NUL-separated, so use git diff -z and git ls-files -z",
            )
        if entry.startswith('"'):
            _error(
                "E_SCOPE_INPUT",
                f"path list entry {number} is quoted; disable path quoting in the producer",
            )
        try:
            path = validate_project_relative_path(entry, profile)
        except UndersealError as exc:
            _error(exc.code, f"path list entry {number}: {exc}")
        key = _collision_key(path)
        if key in seen:
            continue
        seen.add(key)
        ordered.append(path)
    return ordered


def _audit_one_path(assignment: dict, path: str) -> None:
    #: The audited task's own evidence file is the single exemption inside the
    #: worker run directory: the worker is required to write it, so it appears
    #: in every honest change list.  Every other path under that directory --
    #: another task's record included -- stays a control-plane violation.
    if _collision_key(path) == _collision_key(assignment["progress"]["path"]):
        return
    for control in assignment["control_paths"]:
        if _is_within(path, control) or _is_within(control, path):
            _error(
                "E_SCOPE_VIOLATION",
                f"changed path reaches a control-plane path: {path}",
            )
    if assignment["mode"] == "mechanical":
        targets = [target["path"] for target in assignment["targets"]]
        if not any(_is_within(path, target) for target in targets):
            _error(
                "E_SCOPE_VIOLATION",
                f"changed path is outside the sealed targets: {path}",
            )
        return
    if not _is_within(path, assignment["ownership_root"]):
        _error(
            "E_SCOPE_VIOLATION",
            f"changed path is outside the sealed ownership root: {path}",
        )
    for protected in assignment["protected_paths"]:
        if _is_within(path, protected) or _is_within(protected, path):
            _error(
                "E_SCOPE_VIOLATION",
                f"changed path reaches a protected path: {path}",
            )


def audit_scope(assignment: dict, paths: list[str]) -> int:
    """Check every changed path against the sealed scope, in list order.

    The first violating path stops the audit, so the reported path is the first
    one a lead must explain.
    """

    for path in paths:
        _audit_one_path(assignment, path)
    return len(paths)


# ---------------------------------------------------------------------------
# Verifier pin
# ---------------------------------------------------------------------------


def verify_pin(script_path: Path, pin_path: Path) -> dict:
    """Check that the verifier bytes match the pin the lead committed."""

    pin_bytes = pin_path.read_bytes()
    pin = _expect_exact_keys(parse_json_bytes(pin_bytes), _PIN_FIELDS, "/")
    if pin_bytes != canonicalize(pin) + b"\n":
        _error("E_PIN_CANONICAL", "pin file must be one canonical JSON line")
    if type(pin["schema_version"]) is not int or pin["schema_version"] != PIN_SCHEMA_VERSION:
        _error("E_PIN_SCHEMA", "unsupported pin schema version")
    if pin["algorithm"] != "sha256":
        _error("E_PIN_ALGORITHM", "pin algorithm must be sha256")
    pinned_path = validate_project_relative_path(pin["path"], PATH_PROFILE_WINDOWS_STRICT)
    if pinned_path.rsplit("/", 1)[-1] != script_path.name:
        _error("E_PIN_PATH", "the pinned filename does not match this verifier filename")
    if type(pin["sha256"]) is not str or not HASH_RE.fullmatch(pin["sha256"]):
        _error("E_PIN_HASH", "pin sha256 is invalid")
    if sha256_hex(script_path.read_bytes()) != pin["sha256"]:
        _error("E_PIN_MISMATCH", "verifier bytes do not match the pinned SHA-256")
    return pin


# ---------------------------------------------------------------------------
# Command line
# ---------------------------------------------------------------------------


def _role_name(value: str) -> str:
    if not ROLE_NAME_RE.fullmatch(value):
        raise argparse.ArgumentTypeError(
            "role name must match [a-z][a-z0-9_]{0,63}"
        )
    return value


def _build_parser() -> argparse.ArgumentParser:
    summary = (__doc__ or "").strip().splitlines()[0]
    parser = argparse.ArgumentParser(prog="underseal", description=summary)
    subparsers = parser.add_subparsers(dest="command", required=True)

    render = subparsers.add_parser(
        "render-receipt",
        help="render the canonical receipt that seals one assignment",
    )
    render.add_argument("--assignment", required=True, type=Path)

    verify = subparsers.add_parser(
        "verify",
        help="verify the sealed assignment and its receipt for one task name",
    )
    verify.add_argument("--workspace-root", required=True, type=Path)
    verify.add_argument("--task-name", required=True)
    verify.add_argument("--expected-mode", choices=MODES)
    verify.add_argument("--expected-role", type=_role_name)

    render_dispatch = subparsers.add_parser(
        "render-dispatch",
        help="render an INITIAL or RESUME dispatch binding (full ceremony only)",
    )
    render_dispatch.add_argument("--workspace-root", required=True, type=Path)
    render_dispatch.add_argument("--expected-role", required=True, type=_role_name)
    render_dispatch.add_argument(
        "--activation-kind",
        required=True,
        choices=ACTIVATION_KINDS,
    )
    render_dispatch.add_argument("--task-name")
    render_dispatch.add_argument("--dispatch-id")

    resolve = subparsers.add_parser(
        "resolve-dispatch",
        help="resolve the installed current binding (full ceremony only)",
    )
    resolve.add_argument("--workspace-root", required=True, type=Path)
    resolve.add_argument("--expected-role", required=True, type=_role_name)

    retire = subparsers.add_parser(
        "retire-dispatch",
        help="render the final archive that retires the current binding",
    )
    retire.add_argument("--workspace-root", required=True, type=Path)
    retire.add_argument("--expected-role", required=True, type=_role_name)

    progress = subparsers.add_parser(
        "validate-progress",
        help="validate the append-only evidence record for one task name",
    )
    progress.add_argument("--workspace-root", required=True, type=Path)
    progress.add_argument("--task-name", required=True)
    progress.add_argument("--expected-mode", choices=MODES)
    progress.add_argument("--expected-role", type=_role_name)

    scope = subparsers.add_parser(
        "audit-scope",
        help="check a list of changed paths against the sealed scope",
    )
    scope.add_argument("--workspace-root", required=True, type=Path)
    scope.add_argument("--task-name", required=True)
    scope.add_argument("--expected-mode", choices=MODES)
    scope.add_argument("--expected-role", type=_role_name)
    scope.add_argument(
        "--paths-file",
        type=Path,
        help="file of NUL-separated project-relative paths; stdin when omitted",
    )

    bases = subparsers.add_parser(
        "verify-bases",
        help="check the sealed expected_base assertions against the workspace",
    )
    bases.add_argument("--workspace-root", required=True, type=Path)
    bases.add_argument("--task-name", required=True)

    pin = subparsers.add_parser(
        "verify-pin",
        help="check that the verifier bytes match the committed pin",
    )
    pin.add_argument("--pin", required=True, type=Path)
    return parser


def _configure_cli_newlines() -> None:
    """Keep protocol markers byte-identical on every supported platform."""

    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(newline="\n")


def _emit(marker: str, value: object) -> None:
    print(marker + " " + canonicalize(value).decode("utf-8"))


def _read_scope_input(paths_file: Path | None) -> bytes:
    if paths_file is not None:
        return paths_file.resolve(strict=True).read_bytes()
    stream = sys.stdin
    try:
        interactive = stream.isatty()
    except (AttributeError, ValueError):
        interactive = False
    if interactive:
        _error(
            "E_CLI_ARGUMENT",
            "audit-scope needs --paths-file or a piped path list on stdin",
        )
    buffer = getattr(stream, "buffer", None)
    if buffer is None:
        _error("E_CLI_ARGUMENT", "stdin does not expose a byte stream")
    return buffer.read()


def _command_render_dispatch(args: argparse.Namespace) -> None:
    if args.activation_kind == "INITIAL":
        if args.task_name is None or args.dispatch_id is None:
            _error("E_CLI_ARGUMENT", "INITIAL requires --task-name and --dispatch-id")
        dispatch = render_initial_dispatch(
            args.workspace_root,
            args.task_name,
            args.expected_role,
            args.dispatch_id,
        )
        _emit("UNDERSEAL_DISPATCH_BINDING", dispatch)
        return
    if args.task_name is not None or args.dispatch_id is not None:
        _error(
            "E_CLI_ARGUMENT",
            "RESUME derives task and dispatch identity from the current binding",
        )
    dispatch, archive_path, previous_bytes = render_resume_dispatch(
        args.workspace_root,
        args.expected_role,
    )
    relative_archive = archive_path.relative_to(
        args.workspace_root.resolve(strict=True)
    ).as_posix()
    print("UNDERSEAL_DISPATCH_ARCHIVE_PATH " + relative_archive)
    print(
        "UNDERSEAL_DISPATCH_ARCHIVE_DOCUMENT "
        + previous_bytes.rstrip(b"\n").decode("utf-8")
    )
    _emit("UNDERSEAL_DISPATCH_BINDING", dispatch)


def main(argv: list[str] | None = None) -> int:
    _configure_cli_newlines()
    parser = _build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "render-receipt":
            receipt = render_receipt(args.assignment.resolve(strict=True))
            _emit("UNDERSEAL_RECEIPT", receipt)
        elif args.command == "verify":
            _, ack = verify_assignment(
                args.task_name,
                args.workspace_root,
                args.expected_mode,
                args.expected_role,
            )
            _emit("UNDERSEAL_ACK", ack)
        elif args.command == "render-dispatch":
            _command_render_dispatch(args)
        elif args.command == "resolve-dispatch":
            _, ack = resolve_dispatch(args.workspace_root, args.expected_role)
            _emit("UNDERSEAL_DISPATCH_ACK", ack)
        elif args.command == "retire-dispatch":
            retired, archive_path, final_bytes = retire_dispatch(
                args.workspace_root,
                args.expected_role,
            )
            relative_archive = archive_path.relative_to(
                args.workspace_root.resolve(strict=True)
            ).as_posix()
            print("UNDERSEAL_DISPATCH_ARCHIVE_PATH " + relative_archive)
            print(
                "UNDERSEAL_DISPATCH_ARCHIVE_DOCUMENT "
                + final_bytes.rstrip(b"\n").decode("utf-8")
            )
            _emit("UNDERSEAL_DISPATCH_RETIRED", retired)
        elif args.command == "validate-progress":
            _, events = validate_progress(
                args.task_name,
                args.workspace_root,
                args.expected_mode,
                args.expected_role,
            )
            print(f"UNDERSEAL_PROGRESS_OK {len(events)}")
        elif args.command == "audit-scope":
            assignment, _ = verify_assignment(
                args.task_name,
                args.workspace_root,
                args.expected_mode,
                args.expected_role,
            )
            paths = parse_scope_paths(
                _read_scope_input(args.paths_file),
                assignment["path_profile"],
            )
            print(f"UNDERSEAL_SCOPE_OK {audit_scope(assignment, paths)}")
        elif args.command == "verify-bases":
            _, checked = verify_bases(args.task_name, args.workspace_root)
            print(f"UNDERSEAL_BASES_OK {checked}")
        elif args.command == "verify-pin":
            pin = verify_pin(
                Path(__file__).resolve(strict=True),
                args.pin.resolve(strict=True),
            )
            print("UNDERSEAL_PIN_OK " + pin["sha256"])
        return 0
    except (UndersealError, OSError) as exc:
        if isinstance(exc, UndersealError):
            code = exc.code
        else:
            code = "E_IO"
        print(f"{code}: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
