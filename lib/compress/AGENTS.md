# Purpose

- Resolves compression selections, applies block state, and emits persistence and notification effects.

# Ownership

- Owns compression tool execution from preparation through finalization.

# Local Contracts

- The complete prepare-resolve-apply-finalize sequence runs under one session-registry lock.
- Failed preparation releases the lock and must not allocate compression IDs or blocks.
- Effectiveness validation runs after protected-content expansion and before ID allocation; non-positive entries and materially undersized emergency batches have no persistence or notification effects.
- Compression loads OpenChamber pin metadata before preparation mutates session state, excludes current pins, and revalidates the snapshot after effectiveness validation and immediately before ID allocation. Initial metadata failure leaves session state unchanged; later metadata failure or pin drift may retain normal preparation bookkeeping but must not allocate run/block IDs, apply or persist the current compression result, or notify.
- Same-session concurrent calls produce ordered, unique run and block IDs.
- Deletion cancellation is checked before state mutation, persistence, and notification effects.
- Permission, initialization, persistence, and notification waits observe the session disposal signal and recheck activity after asynchronous work.

# Work Guidance

- Keep selection and state helpers explicit about the session state they mutate.

# Verification

- Cover different-session concurrency, same-session serialization, multi-entry effectiveness accounting, range/message pressure parity, rejection without side effects, pressure recovery, and same-key rejection recovery.

# Child DOX Index
