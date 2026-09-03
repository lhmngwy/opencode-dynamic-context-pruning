import assert from "node:assert/strict"
import test from "node:test"
import { createSessionStateRegistry } from "../lib/state"

function deferred() {
    let resolve!: () => void
    const promise = new Promise<void>((done) => {
        resolve = done
    })
    return { promise, resolve }
}

test("session registry serializes operations for one session", async () => {
    const sessions = createSessionStateRegistry()
    const gate = deferred()
    const events: string[] = []

    const first = sessions.runExclusive("session-1", async () => {
        events.push("first-start")
        await gate.promise
        events.push("first-end")
    })
    const second = sessions.runExclusive("session-1", () => {
        events.push("second")
    })

    await Promise.resolve()
    assert.deepEqual(events, ["first-start"])
    gate.resolve()
    await Promise.all([first, second])
    assert.deepEqual(events, ["first-start", "first-end", "second"])
})

test("session registry permits operations for different sessions concurrently", async () => {
    const sessions = createSessionStateRegistry()
    const gate = deferred()
    const started = new Set<string>()

    const run = (sessionId: string) =>
        sessions.runExclusive(sessionId, async () => {
            started.add(sessionId)
            await gate.promise
        })

    const first = run("session-1")
    const second = run("session-2")
    await Promise.resolve()
    assert.deepEqual(started, new Set(["session-1", "session-2"]))
    gate.resolve()
    await Promise.all([first, second])
})

test("session registry releases a lock after rejection", async () => {
    const sessions = createSessionStateRegistry()
    await assert.rejects(
        sessions.runExclusive("session-1", () => {
            throw new Error("expected failure")
        }),
        /expected failure/,
    )

    const result = await sessions.runExclusive("session-1", () => "recovered")
    assert.equal(result, "recovered")
})

test("session disposal cancels queued work and prevents recreation", async () => {
    const sessions = createSessionStateRegistry()
    const gate = deferred()
    const started = deferred()
    let queuedRan = false

    const active = sessions.runExclusive("session-1", async (state, guard) => {
        state.sessionId = "session-1"
        started.resolve()
        await gate.promise
        guard.assertActive()
        state.currentTurn += 1
    })
    const activeRejection = assert.rejects(active, /has been disposed/)
    await started.promise
    const queued = sessions.runExclusive("session-1", () => {
        queuedRan = true
    })
    const queuedRejection = assert.rejects(queued, /has been disposed/)
    const disposed = sessions.dispose("session-1")

    gate.resolve()
    await activeRejection
    await queuedRejection
    await disposed
    assert.equal(queuedRan, false)
    assert.equal(sessions.peek("session-1"), undefined)
    await assert.rejects(sessions.runExclusive("session-1", () => {}), /has been disposed/)
})

test("session disposal returns before active work and clears late mutations", async () => {
    const sessions = createSessionStateRegistry()
    const gate = deferred()
    const started = deferred()
    let retainedState: ReturnType<typeof sessions.peek>
    let cleanupCalls = 0

    const active = sessions.runExclusive("session-1", async (state) => {
        retainedState = state
        state.sessionId = "session-1"
        started.resolve()
        await gate.promise
        state.currentTurn = 99
    })
    const rejection = assert.rejects(active, /has been disposed/)
    await started.promise

    await sessions.dispose("session-1", async () => {
        cleanupCalls += 1
    })
    assert.equal(cleanupCalls, 1)
    assert.equal(sessions.peek("session-1"), undefined)

    gate.resolve()
    await rejection
    await Promise.resolve()
    assert.equal(retainedState?.currentTurn, 0)
    assert.equal(retainedState?.sessionId, null)
    assert.equal(cleanupCalls, 2)
})
