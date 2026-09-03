# Purpose

- Provides executable regression coverage for DCP behavior and package contracts.

# Ownership

- Owns test fixtures, deterministic interleavings, and behavioral assertions.

# Local Contracts

- Concurrency tests use deferred promises or barriers rather than timing assumptions.
- Session-isolation tests assert both successful results and isolated in-memory state.
- Every lock-rejection test proves a subsequent operation can acquire the same key.
- Disposal tests prove queued work is cancelled and deleted session keys cannot be recreated.
- Deletion races prove active compression cannot save, notify, or retain state and stale events resolve benignly.
- Boundary tests pause permission, initialization loading, persistence, notification, and timing effects deterministically before deletion.
- Persistence tests prove deletion markers fence restart loading across failed cleanup, exhausted marker attempts remain unresolved, concurrent deletion converges through a deterministic marker barrier, and physical cleanup remains idempotent.

# Work Guidance

- Prefer focused unit tests over sleeps or live OpenCode dependencies.

# Verification

- Run `npm test` from the repository root.

# Child DOX Index
