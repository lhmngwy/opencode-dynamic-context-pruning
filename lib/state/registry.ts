import { createSessionState, resetSessionState } from "./state"
import type { SessionState } from "./types"

interface SessionEntry {
    state: SessionState
    tail: Promise<void>
    controller: AbortController
}

export class SessionDisposedError extends Error {
    constructor(sessionId: string) {
        super(`Session state ${sessionId} has been disposed.`)
        this.name = "SessionDisposedError"
    }
}

export interface SessionOperationGuard {
    signal: AbortSignal
    isActive(): boolean
    assertActive(): void
}

export interface SessionStateRegistry {
    peek(sessionId: string): SessionState | undefined
    runExclusive<T>(
        sessionId: string,
        operation: (state: SessionState, guard: SessionOperationGuard) => Promise<T> | T,
    ): Promise<T>
    dispose(sessionId: string, cleanup?: () => Promise<unknown>): Promise<void>
}

export function createSessionStateRegistry(
    initialStates: Iterable<readonly [string, SessionState]> = [],
): SessionStateRegistry {
    const entries = new Map<string, SessionEntry>()
    const disposedSessionIds = new Set<string>()
    for (const [sessionId, state] of initialStates) {
        if (state.sessionId !== null && state.sessionId !== sessionId) {
            throw new Error(`Session state ${state.sessionId} cannot be registered as ${sessionId}.`)
        }
        entries.set(sessionId, {
            state,
            tail: Promise.resolve(),
            controller: new AbortController(),
        })
    }

    const getEntry = (sessionId: string): SessionEntry => {
        const existing = entries.get(sessionId)
        if (existing) {
            return existing
        }

        const entry = {
            state: createSessionState(),
            tail: Promise.resolve(),
            controller: new AbortController(),
        }
        entries.set(sessionId, entry)
        return entry
    }

    const runExclusive = async <T>(
        sessionId: string,
        operation: (state: SessionState, guard: SessionOperationGuard) => Promise<T> | T,
    ): Promise<T> => {
        if (disposedSessionIds.has(sessionId)) {
            throw new SessionDisposedError(sessionId)
        }
        const entry = getEntry(sessionId)
        const guard: SessionOperationGuard = {
            signal: entry.controller.signal,
            isActive: () =>
                !disposedSessionIds.has(sessionId) && !entry.controller.signal.aborted,
            assertActive() {
                if (!this.isActive()) {
                    throw new SessionDisposedError(sessionId)
                }
            },
        }
        const previous = entry.tail
        let release!: () => void
        entry.tail = new Promise<void>((resolve) => {
            release = resolve
        })

        await previous
        try {
            guard.assertActive()
            const result = await operation(entry.state, guard)
            guard.assertActive()
            return result
        } finally {
            release()
        }
    }

    return {
        peek(sessionId) {
            if (disposedSessionIds.has(sessionId)) {
                return undefined
            }
            return entries.get(sessionId)?.state
        },
        runExclusive,
        async dispose(sessionId, cleanup) {
            const entry = entries.get(sessionId)
            if (!entry) {
                disposedSessionIds.add(sessionId)
                await cleanup?.()
                return
            }

            disposedSessionIds.add(sessionId)
            entry.controller.abort(new SessionDisposedError(sessionId))
            resetSessionState(entry.state, true)
            const initialCleanup = cleanup?.()
            void entry.tail
                .then(async () => {
                    await initialCleanup?.catch(() => {})
                    resetSessionState(entry.state, true)
                    entries.delete(sessionId)
                    await cleanup?.()
                })
                .catch(() => {})
            await initialCleanup
        },
    }
}
