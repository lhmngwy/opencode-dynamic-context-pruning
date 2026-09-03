# Purpose

- DCP is an OpenCode plugin that reduces conversation context while preserving recoverable summaries and session state.

# Ownership

- This document owns repository-wide architecture, contribution, and verification contracts.
- `lib/` owns runtime implementation; `tests/` owns executable regression coverage.

# Local Contracts

- Mutable runtime state is owned by exactly one OpenCode session for its lifetime.
- Operations for the same session serialize through the session registry; operations for different sessions remain concurrent.
- Compression preparation, resolution, mutation, and persistence execute as one same-session critical section.
- Persisted state must never be written under a different session identity.
- Session deletion invalidates active and queued work before further state, persistence, or notification commits.
- Deletion aborts pending session operations and persists a deletion fence before best-effort physical cleanup so stale state cannot replay after restart.

# Work Guidance

- Keep changes compatible with the supported OpenCode plugin and SDK peer dependency ranges.
- Update README behavior documentation when user-visible configuration or runtime behavior changes.
- Follow `CONTRIBUTING.md`; avoid unrelated cleanup in focused fixes.

# User Preferences

- Do not run formatters or linters in this repository; preserve upstream-friendly diffs and verify behavior without normalization churn.

# Verification

- Run `npm run typecheck`, `npm test`, and `npm run check:package` on the unchanged candidate.

# Child DOX Index

- `lib/AGENTS.md` - Runtime architecture and implementation boundaries.
- `tests/AGENTS.md` - Regression and concurrency test requirements.
