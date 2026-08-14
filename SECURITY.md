# Security Policy

This package is a governance layer: it wraps a frozen, hash-pinned verifier and
fails closed on tampering (E1/E2/E3 sentinels, `UNDERSEAL_ADAPTER_*` markers,
`E_*` error codes). If you find a way to bypass the sealed authorization, forge
evidence, or defeat the supply-chain sentinels, that is a security issue and we
want to know about it privately.

## Reporting a vulnerability

Please do **not** open a public issue for a security bug. Report it through
GitHub's private channel:

1. Open https://github.com/Hyperionjust/dsh-tool-underseal/security
2. Click **Report a vulnerability** (maintainers may need to enable *Private
   vulnerability reporting* under Settings → Code security).

Include:

- which boundary you bypassed (sealed assignment, worker check-in guard, or
  sentinel);
- a minimal reproduction (assignment JSON + the exact command/tool call);
- the DSH version and the `dsh-tool-underseal` version.

You will get an acknowledgement within a few days, and a coordinated fix +
advisory before public disclosure.

## Scope

The Python verifier and protocol are the frozen upstream [underseal](https://github.com/Hyperionjust/underseal)
core (reviewed commit `18f85a6b3bc89a8b3325a9bd665ee51a8ab3d225`); report issues
there separately if they are about the protocol itself rather than this DSH
wrapper.
