"""Lead/worker adapter for using Underseal from Codex on Windows.

The adapter does not weaken or extend the Underseal protocol.  It installs
exact bytes rendered by the verifier, appends canonical progress evidence,
and runs the normative Git scope feed without shell text conversion.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path
from typing import NoReturn

import underseal


ADAPTER_VERSION = "0.1.1"
PIN_RELATIVE_PATH = Path(".underseal") / "underseal.pin.json"
BYTE_ATTRIBUTE_PATHS = (
    Path(".underseal") / ".gitattributes",
    Path(".underseal-runs") / ".gitattributes",
)
BYTE_ATTRIBUTE_BYTES = b"* -text\n"


class AdapterError(RuntimeError):
    """Stable adapter failure reported without a traceback."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _error(code: str, message: str) -> NoReturn:
    raise AdapterError(code, message)


def _emit(marker: str, value: object) -> None:
    payload = underseal.canonicalize(value)
    sys.stdout.buffer.write(marker.encode("ascii") + b" " + payload + b"\n")
    sys.stdout.buffer.flush()


def _workspace(value: str | Path) -> Path:
    root = Path(value).resolve(strict=True)
    if not root.is_dir():
        _error("E_ADAPTER_WORKSPACE", "workspace root must be a directory")
    return root


def _module_path() -> Path:
    module_file = getattr(underseal, "__file__", None)
    if not module_file:
        _error("E_ADAPTER_INSTALL", "cannot locate the installed underseal module")
    return Path(module_file).resolve(strict=True)


def _pin_document() -> dict:
    return {
        "algorithm": "sha256",
        "path": "underseal.py",
        "schema_version": 1,
        "sha256": underseal.sha256_hex(_module_path().read_bytes()),
    }


def _pin_bytes() -> bytes:
    return underseal.canonicalize(_pin_document()) + b"\n"


def _pin_path(root: Path) -> Path:
    return root / PIN_RELATIVE_PATH


def _write_new_or_identical(path: Path, data: bytes, label: str) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() or path.is_symlink():
        if not path.is_file() or path.read_bytes() != data:
            _error(
                "E_ADAPTER_CONFLICT",
                f"existing {label} differs; refuse to overwrite {path}",
            )
        return False
    try:
        with path.open("xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    except FileExistsError:
        _error("E_ADAPTER_CONFLICT", f"{label} appeared concurrently: {path}")
    return True


def _atomic_replace(path: Path, expected: bytes, replacement: bytes, label: str) -> None:
    if not path.is_file() or path.read_bytes() != expected:
        _error("E_ADAPTER_CONFLICT", f"current {label} changed before replacement")
    temporary = path.with_name(f".{path.name}.underseal-{os.getpid()}.tmp")
    if temporary.exists() or temporary.is_symlink():
        _error("E_ADAPTER_CONFLICT", f"temporary path is already occupied: {temporary}")
    try:
        with temporary.open("xb") as stream:
            stream.write(replacement)
            stream.flush()
            os.fsync(stream.fileno())
        if path.read_bytes() != expected:
            _error("E_ADAPTER_CONFLICT", f"current {label} changed during replacement")
        os.replace(temporary, path)
    finally:
        if temporary.exists() and temporary.is_file():
            temporary.unlink()


def _install_pin(root: Path, *, replace: bool) -> tuple[Path, bool]:
    path = _pin_path(root)
    data = _pin_bytes()
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() or path.is_symlink():
        if not path.is_file():
            _error("E_ADAPTER_CONFLICT", f"pin path is not a file: {path}")
        current = path.read_bytes()
        if current != data:
            if not replace:
                _error(
                    "E_ADAPTER_PIN_DRIFT",
                    "project pin differs from the installed verifier; review before replacing it",
                )
            _atomic_replace(path, current, data, "pin")
            created = True
        else:
            created = False
    else:
        created = _write_new_or_identical(path, data, "pin")
    underseal.verify_pin(_module_path(), path)
    return path, created


def _install_byte_attributes(root: Path) -> list[str]:
    installed: list[str] = []
    for relative in BYTE_ATTRIBUTE_PATHS:
        path = root / relative
        _write_new_or_identical(path, BYTE_ATTRIBUTE_BYTES, "byte-preservation attributes")
        installed.append(relative.as_posix())
    return installed


def _verify_project_pin(root: Path) -> dict:
    path = _pin_path(root)
    if not path.is_file():
        _error(
            "E_ADAPTER_PIN_MISSING",
            f"project-local verifier pin is missing: {PIN_RELATIVE_PATH.as_posix()}",
        )
    return underseal.verify_pin(_module_path(), path)


def _git(root: Path, *arguments: str) -> bytes:
    try:
        completed = subprocess.run(
            ["git", "-C", str(root), *arguments],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except FileNotFoundError:
        _error("E_ADAPTER_GIT", "git is not available on PATH")
    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", errors="replace").strip()
        if len(detail) > 500:
            detail = detail[:500] + "..."
        _error("E_ADAPTER_GIT", detail or "git command failed")
    return completed.stdout


def _verify_git_root(root: Path) -> None:
    reported = _git(root, "rev-parse", "--show-toplevel").decode(
        "utf-8", errors="strict"
    ).strip()
    try:
        actual = Path(reported).resolve(strict=True)
    except OSError:
        _error("E_ADAPTER_GIT", "git reported an unreadable repository root")
    try:
        same = root.samefile(actual)
    except OSError:
        same = False
    if not same:
        _error(
            "E_ADAPTER_GIT",
            "workspace root must be the repository root for normative scope auditing",
        )


def _require_open_gate(assignment: dict) -> None:
    if assignment["gate"]["status"] != underseal.GATE_STATUS_OPEN:
        _error("E_ADAPTER_GATE", "sealed assignment gate is not OPEN")


def _progress_path(root: Path, assignment: dict) -> Path:
    return root / assignment["progress"]["path"]


def _append_exact(path: Path, before: bytes, line: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if before:
        if not path.is_file() or path.read_bytes() != before:
            _error("E_ADAPTER_CONFLICT", "progress changed before append")
        with path.open("r+b") as stream:
            current = stream.read()
            if current != before:
                _error("E_ADAPTER_CONFLICT", "progress changed during append")
            stream.seek(0, os.SEEK_END)
            stream.write(line)
            stream.flush()
            os.fsync(stream.fileno())
        return
    if path.exists() or path.is_symlink():
        _error("E_ADAPTER_CONFLICT", "progress file must be absent at initial activation")
    with path.open("xb") as stream:
        stream.write(line)
        stream.flush()
        os.fsync(stream.fileno())


def _event(
    assignment: dict,
    ack: dict,
    *,
    seq: int,
    state: str,
    summary: str,
) -> dict:
    event = {
        "assignment_document_sha256": ack["assignment_document_sha256"],
        "seq": seq,
        "state": state,
        "summary": summary,
        "task_name": assignment["task_name"],
    }
    if assignment["ceremony"] == "full":
        event["dispatch_binding_sha256"] = ack["dispatch_binding_sha256"]
        event["dispatch_id"] = ack["dispatch_id"]
    return event


def _validate_candidate_progress(
    data: bytes,
    assignment: dict,
    ack: dict,
    required_ready_sequences: set[int],
) -> list[dict]:
    if assignment["ceremony"] == "lite":
        return underseal.validate_progress_bytes(
            data,
            assignment,
            ack["assignment_document_sha256"],
            required_ready_sequences=required_ready_sequences,
        )
    return underseal.validate_progress_bytes(
        data,
        assignment,
        ack["assignment_document_sha256"],
        dispatch_id=ack["dispatch_id"],
        dispatch_binding_sha256=ack["dispatch_binding_sha256"],
        required_ready_sequences=required_ready_sequences,
    )


def command_doctor(args: argparse.Namespace) -> None:
    root = _workspace(args.workspace_root)
    _verify_git_root(root)
    branch = _git(root, "branch", "--show-current").decode("utf-8", errors="strict").strip()
    head = _git(root, "rev-parse", "HEAD").decode("ascii", errors="strict").strip()
    pin_path = _pin_path(root)
    pin_status = "missing"
    if pin_path.exists() or pin_path.is_symlink():
        _verify_project_pin(root)
        pin_status = "matched"
    _emit(
        "UNDERSEAL_ADAPTER_OK",
        {
            "adapter_version": ADAPTER_VERSION,
            "branch": branch or "DETACHED",
            "head": head,
            "pin_status": pin_status,
            "verifier_sha256": _pin_document()["sha256"],
            "workspace": str(root),
        },
    )


def command_pin(args: argparse.Namespace) -> None:
    root = _workspace(args.workspace_root)
    _verify_git_root(root)
    attributes = _install_byte_attributes(root)
    path, changed = _install_pin(root, replace=args.replace)
    _emit(
        "UNDERSEAL_ADAPTER_PIN_OK",
        {
            "attributes": attributes,
            "changed": changed,
            "path": path.relative_to(root).as_posix(),
            "sha256": _pin_document()["sha256"],
        },
    )


def command_seal(args: argparse.Namespace) -> None:
    root = _workspace(args.workspace_root)
    _verify_git_root(root)
    attributes = _install_byte_attributes(root)
    _install_pin(root, replace=False)
    assignment_path = underseal.assignment_path_for(root, args.task_name)
    receipt = underseal.render_receipt(assignment_path.resolve(strict=True))
    receipt_path = underseal.receipt_path_for(assignment_path)
    _write_new_or_identical(
        receipt_path,
        underseal.canonicalize(receipt) + b"\n",
        "receipt",
    )
    assignment, ack = underseal.verify_assignment(
        args.task_name,
        root,
        args.expected_mode,
        args.expected_role,
    )
    _require_open_gate(assignment)
    _, bases_checked = underseal.verify_bases(args.task_name, root)
    dispatch_path: str | None = None
    if assignment["ceremony"] == "full":
        if not args.dispatch_id:
            _error("E_ADAPTER_ARGUMENT", "full ceremony requires --dispatch-id")
        dispatch = underseal.render_initial_dispatch(
            root,
            args.task_name,
            args.expected_role,
            args.dispatch_id,
        )
        target = underseal.dispatch_path_for(root, args.expected_role)
        _write_new_or_identical(
            target,
            underseal.canonicalize(dispatch) + b"\n",
            "dispatch binding",
        )
        dispatch_path = target.relative_to(root).as_posix()
    elif args.dispatch_id:
        _error("E_ADAPTER_ARGUMENT", "lite ceremony must not receive --dispatch-id")
    _emit(
        "UNDERSEAL_ADAPTER_SEALED",
        {
            "assignment_document_sha256": ack["assignment_document_sha256"],
            "attributes": attributes,
            "bases_checked": bases_checked,
            "ceremony": assignment["ceremony"],
            "dispatch_path": dispatch_path,
            "receipt_path": receipt_path.relative_to(root).as_posix(),
            "task_name": args.task_name,
        },
    )


def command_start(args: argparse.Namespace) -> None:
    root = _workspace(args.workspace_root)
    _verify_project_pin(root)
    assignment, basic_ack = underseal.verify_assignment(
        args.task_name,
        root,
        args.expected_mode,
        args.expected_role,
    )
    _require_open_gate(assignment)
    path = _progress_path(root, assignment)
    if assignment["ceremony"] == "lite":
        if path.exists() or path.is_symlink():
            _error("E_ADAPTER_STALE_PROGRESS", "lite activation requires absent progress")
        ack = basic_ack
        before = b""
        ready_sequences = {1}
    else:
        resolved_assignment, ack = underseal.resolve_dispatch(root, args.expected_role)
        if resolved_assignment["task_name"] != args.task_name:
            _error("E_ADAPTER_DISPATCH", "active dispatch belongs to another task")
        _, _, verified_ack, _, ready_sequences = underseal._verify_dispatch_core(
            root, args.expected_role
        )
        if verified_ack != ack:
            _error("E_ADAPTER_DISPATCH", "dispatch changed during activation")
        before = path.read_bytes() if path.is_file() else b""
    seq = len(before.splitlines()) + 1
    event = _event(
        assignment,
        ack,
        seq=seq,
        state="READY",
        summary=args.summary,
    )
    line = underseal.canonicalize(event) + b"\n"
    events = _validate_candidate_progress(
        before + line,
        assignment,
        ack,
        ready_sequences,
    )
    _append_exact(path, before, line)
    _emit(
        "UNDERSEAL_ADAPTER_READY",
        {
            "event_count": len(events),
            "progress_path": path.relative_to(root).as_posix(),
            "seq": seq,
            "task_name": args.task_name,
        },
    )


def command_event(args: argparse.Namespace) -> None:
    if args.state == "READY":
        _error("E_ADAPTER_ARGUMENT", "use start to write an activation READY event")
    root = _workspace(args.workspace_root)
    _verify_project_pin(root)
    assignment, basic_ack = underseal.verify_assignment(
        args.task_name,
        root,
        args.expected_mode,
        args.expected_role,
    )
    _require_open_gate(assignment)
    path = _progress_path(root, assignment)
    if not path.is_file():
        _error("E_ADAPTER_PROGRESS", "progress is missing; run start first")
    before = path.read_bytes()
    if assignment["ceremony"] == "lite":
        ack = basic_ack
        ready_sequences = {1}
        existing = _validate_candidate_progress(before, assignment, ack, ready_sequences)
    else:
        _, dispatch, ack, _, ready_sequences = underseal._verify_dispatch_core(
            root, args.expected_role
        )
        if dispatch["task_name"] != args.task_name:
            _error("E_ADAPTER_DISPATCH", "active dispatch belongs to another task")
        existing = _validate_candidate_progress(before, assignment, ack, ready_sequences)
    seq = len(existing) + 1
    event = _event(
        assignment,
        ack,
        seq=seq,
        state=args.state,
        summary=args.summary,
    )
    line = underseal.canonicalize(event) + b"\n"
    events = _validate_candidate_progress(
        before + line,
        assignment,
        ack,
        ready_sequences,
    )
    _append_exact(path, before, line)
    _emit(
        "UNDERSEAL_ADAPTER_EVENT_OK",
        {
            "event_count": len(events),
            "seq": seq,
            "state": args.state,
            "task_name": args.task_name,
        },
    )


def _install_archive_then_replace(
    archive_path: Path,
    archive_bytes: bytes,
    pointer_path: Path,
    pointer_before: bytes,
    pointer_after: bytes | None,
) -> None:
    created = _write_new_or_identical(archive_path, archive_bytes, "dispatch archive")
    try:
        if pointer_after is None:
            if not pointer_path.is_file() or pointer_path.read_bytes() != pointer_before:
                _error("E_ADAPTER_CONFLICT", "dispatch pointer changed before retirement")
            pointer_path.unlink()
        else:
            _atomic_replace(
                pointer_path,
                pointer_before,
                pointer_after,
                "dispatch pointer",
            )
    except Exception:
        if created and archive_path.is_file() and archive_path.read_bytes() == archive_bytes:
            archive_path.unlink()
        raise


def command_resume(args: argparse.Namespace) -> None:
    if not args.host_same_agent_confirmed:
        _error("E_ADAPTER_RESUME", "host same-agent confirmation is required")
    root = _workspace(args.workspace_root)
    _verify_project_pin(root)
    updated, archive_path, previous_bytes = underseal.render_resume_dispatch(
        root, args.expected_role
    )
    pointer = underseal.dispatch_path_for(root, args.expected_role)
    updated_bytes = underseal.canonicalize(updated) + b"\n"
    _install_archive_then_replace(
        archive_path,
        previous_bytes,
        pointer,
        previous_bytes,
        updated_bytes,
    )
    _emit(
        "UNDERSEAL_ADAPTER_RESUMED",
        {
            "archive_path": archive_path.relative_to(root).as_posix(),
            "dispatch_id": updated["dispatch_id"],
            "generation": updated["generation"],
            "task_name": updated["task_name"],
        },
    )


def command_audit(args: argparse.Namespace) -> None:
    root = _workspace(args.workspace_root)
    _verify_git_root(root)
    _verify_project_pin(root)
    assignment, events = underseal.validate_progress(
        args.task_name,
        root,
        args.expected_mode,
        args.expected_role,
    )
    changed = _git(root, "diff", "--name-only", "-z", "--no-renames", "HEAD")
    untracked = _git(root, "ls-files", "--others", "--exclude-standard", "-z")
    paths = underseal.parse_scope_paths(changed + untracked, assignment["path_profile"])
    accepted = underseal.audit_scope(assignment, paths)
    _emit(
        "UNDERSEAL_ADAPTER_AUDIT_OK",
        {
            "event_count": len(events),
            "path_count": accepted,
            "task_name": args.task_name,
        },
    )


def command_retire(args: argparse.Namespace) -> None:
    root = _workspace(args.workspace_root)
    _verify_project_pin(root)
    retired, archive_path, final_bytes = underseal.retire_dispatch(
        root, args.expected_role
    )
    pointer = underseal.dispatch_path_for(root, args.expected_role)
    _install_archive_then_replace(
        archive_path,
        final_bytes,
        pointer,
        final_bytes,
        None,
    )
    _emit(
        "UNDERSEAL_ADAPTER_RETIRED",
        {
            "archive_path": archive_path.relative_to(root).as_posix(),
            **retired,
        },
    )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="underseal-adapter",
        description="Windows-first Codex adapter for an unchanged Underseal protocol core.",
    )
    parser.add_argument("--version", action="version", version=ADAPTER_VERSION)
    subparsers = parser.add_subparsers(dest="command", required=True)

    doctor = subparsers.add_parser("doctor", help="check Git, HEAD, verifier, and pin")
    doctor.add_argument("--workspace-root", required=True)
    doctor.set_defaults(handler=command_doctor)

    pin = subparsers.add_parser("pin", help="install the project-local verifier pin")
    pin.add_argument("--workspace-root", required=True)
    pin.add_argument("--replace", action="store_true")
    pin.set_defaults(handler=command_pin)

    seal = subparsers.add_parser("seal", help="render receipt and initial dispatch")
    seal.add_argument("--workspace-root", required=True)
    seal.add_argument("--task-name", required=True)
    seal.add_argument("--expected-mode", required=True, choices=underseal.MODES)
    seal.add_argument("--expected-role", required=True, type=underseal._role_name)
    seal.add_argument("--dispatch-id")
    seal.set_defaults(handler=command_seal)

    start = subparsers.add_parser("start", help="verify activation and append READY")
    start.add_argument("--workspace-root", required=True)
    start.add_argument("--task-name", required=True)
    start.add_argument("--expected-mode", required=True, choices=underseal.MODES)
    start.add_argument("--expected-role", required=True, type=underseal._role_name)
    start.add_argument(
        "--summary",
        default="verified sealed activation before project writes",
    )
    start.set_defaults(handler=command_start)

    event = subparsers.add_parser("event", help="append one validated progress event")
    event.add_argument("--workspace-root", required=True)
    event.add_argument("--task-name", required=True)
    event.add_argument("--expected-mode", required=True, choices=underseal.MODES)
    event.add_argument("--expected-role", required=True, type=underseal._role_name)
    event.add_argument("--state", required=True, choices=sorted(underseal.PROGRESS_STATES))
    event.add_argument("--summary", required=True)
    event.set_defaults(handler=command_event)

    resume = subparsers.add_parser("resume", help="install a verified RESUME binding")
    resume.add_argument("--workspace-root", required=True)
    resume.add_argument("--expected-role", required=True, type=underseal._role_name)
    resume.add_argument("--host-same-agent-confirmed", action="store_true")
    resume.set_defaults(handler=command_resume)

    audit = subparsers.add_parser("audit", help="validate evidence and normative Git scope")
    audit.add_argument("--workspace-root", required=True)
    audit.add_argument("--task-name", required=True)
    audit.add_argument("--expected-mode", required=True, choices=underseal.MODES)
    audit.add_argument("--expected-role", required=True, type=underseal._role_name)
    audit.set_defaults(handler=command_audit)

    retire = subparsers.add_parser("retire", help="archive and remove a finished pointer")
    retire.add_argument("--workspace-root", required=True)
    retire.add_argument("--expected-role", required=True, type=underseal._role_name)
    retire.set_defaults(handler=command_retire)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    try:
        args.handler(args)
        return 0
    except (AdapterError, underseal.UndersealError, OSError) as exc:
        if isinstance(exc, AdapterError):
            code = exc.code
        elif isinstance(exc, underseal.UndersealError):
            code = exc.code
        else:
            code = "E_ADAPTER_IO"
        sys.stderr.buffer.write(f"{code}: {exc}\n".encode("utf-8", errors="replace"))
        sys.stderr.buffer.flush()
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
