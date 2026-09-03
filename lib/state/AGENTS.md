# Purpose

- Owns session-scoped mutable state, keyed serialization, persistence, and cache synchronization.

# Ownership

- The session registry owns live state identity and same-session operation ordering.

# Local Contracts

- A live `SessionState` belongs to one registry key and is never reused for another session.
- Registry locks release after success or failure and do not serialize different session keys.
- Initialization and persistence occur inside the same-session critical section.
- Session deletion cancels queued work, removes live state, and prevents that session key from being recreated.
- Active operations and detached initialization use the registry guard to stop commit effects after deletion is observed; disposal clears pending timing state.
- Persisted updates use abortable temporary-file replacement. Deletion marker establishment owns bounded retries, converges across concurrent attempts, and must succeed before deletion can report success.
- Deletion durably fences loading before idempotent final and temporary file cleanup, and unresolved fence-plus-cleanup failure remains observable.

# Work Guidance

- Do not replace keyed locking with a global mutex or clone-and-merge state.

# Verification

- Test ownership, same-key ordering, cross-key parallelism, failure release, and disposal.

# Child DOX Index
