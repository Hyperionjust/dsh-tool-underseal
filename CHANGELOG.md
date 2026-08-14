# Changelog

## 0.1.1 — 2026-08-13

- Docs: field-record section (Codex-era cache/throughput numbers), Chinese
  README, English↔中文 cross-links, uninstall instructions, CI badge.
- Fix `repository` / `homepage` / `bugs` URLs (shipped as placeholders in
  0.1.0).
- CI: build + guard/sentinel test workflow; benchmark template (`BENCHMARK.md`).
- Tests: make the guard suite platform-neutral so CI passes on Linux.

## 0.1.0 — 2026-08-13

- Initial release: 8 sealed tools (`underseal_doctor/pin/seal/start/event/resume/audit/retire`),
  worker check-in guard (`dsh-tool-underseal/guard`), E1/E2/E3 supply-chain
  sentinels, vendored reviewed verifier (byte-pinned), bundled DSH skill.
