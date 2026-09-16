# Purpose

- Implements DCP hooks, commands, compression, state management, persistence, prompts, and UI integration.

# Ownership

- This document owns cross-runtime integration contracts under `lib/`.
- `compress/` owns compression transactions; `state/` owns session state and serialization.

# Local Contracts

- Hooks select state using the session ID supplied by their own invocation or event.
- No hook may fall back to mutable state selected by another session.
- Same-session mutations and saves use the registry critical section.
- Events for deleted sessions resolve as benign stale input without recreating state.
- Active event persistence uses the registry disposal guard; unrelated event failures remain observable.
- Context-limit injection reports current pressure and observes the persisted post-compression cooldown once per distinct assistant response before creating another emergency anchor.
- OpenChamber pin metadata is a fail-closed runtime input: unsuccessful session reads skip DCP pruning, while successful reads preserve every currently pinned raw message and all of its tool parts.

# Work Guidance

- Pass explicit state into pure or session-local helpers; keep session selection at hook and tool boundaries.

# Verification

- Use the repository-root verification commands.

# Child DOX Index

- `compress/AGENTS.md` - Compression transaction requirements.
- `state/AGENTS.md` - Session registry and persistence requirements.
