import assert from "node:assert/strict"
import test from "node:test"
import { runAbortable } from "../lib/compress/abort"
import { prepareSession } from "../lib/compress/pipeline"
import { createSessionState } from "../lib/state"
import { Logger } from "../lib/logger"

test("runAbortable rejects a stalled operation on timeout", async () => {
    await assert.rejects(
        runAbortable(
            async () => new Promise<never>(() => {}),
            new AbortController().signal,
            "Stalled compression request",
            10,
        ),
        /Stalled compression request timed out after 10ms/,
    )
})

test("prepareSession stops waiting for a stalled permission request when cancelled", async () => {
    const controller = new AbortController()
    const state = createSessionState()
    state.manualMode = "compress-pending"

    const preparation = prepareSession(
        {
            client: {},
            state,
            logger: new Logger(false),
            config: {
                manualMode: { enabled: true },
                compress: { permission: "allow" },
            },
        } as any,
        {
            ask: async () => new Promise<void>(() => {}),
            metadata: () => {},
            sessionID: "ses-cancelled-compression",
            abort: controller.signal,
        },
        "Cancelled compression",
    )

    const rejection = assert.rejects(preparation, /Compression permission cancelled/)
    controller.abort()
    await rejection
    assert.equal(state.manualMode, "active")
})

test("prepareSession passes cancellation to a stalled session message request", async () => {
    const controller = new AbortController()
    let requestSignal: AbortSignal | undefined

    const preparation = prepareSession(
        {
            client: {
                session: {
                    messages: async ({ signal }: { signal?: AbortSignal }) => {
                        requestSignal = signal
                        return new Promise<never>(() => {})
                    },
                },
            },
            state: createSessionState(),
            logger: new Logger(false),
            config: {
                manualMode: { enabled: false },
                compress: { permission: "allow" },
            },
        } as any,
        {
            ask: async () => {},
            metadata: () => {},
            sessionID: "ses-cancelled-session-fetch",
            abort: controller.signal,
        },
        "Cancelled session fetch",
    )

    const rejection = assert.rejects(
        preparation,
        /Loading session messages for compression cancelled/,
    )
    await new Promise((resolve) => setImmediate(resolve))
    controller.abort()

    await rejection
    assert.equal(requestSignal?.aborted, true)
})

test("cancelled session initialization does not leave partial state", async () => {
    const controller = new AbortController()
    const state = createSessionState()
    state.sessionId = "ses-existing"

    const preparation = prepareSession(
        {
            client: {
                session: {
                    messages: async () => ({ data: [] }),
                    get: async () => new Promise<never>(() => {}),
                },
            },
            state,
            logger: new Logger(false),
            config: {
                manualMode: { enabled: false },
                compress: { permission: "allow" },
            },
        } as any,
        {
            ask: async () => {},
            metadata: () => {},
            sessionID: "ses-cancelled-initialization",
            abort: controller.signal,
        },
        "Cancelled initialization",
    )

    const rejection = assert.rejects(preparation, /Initializing compression session cancelled/)
    await new Promise((resolve) => setImmediate(resolve))
    controller.abort()

    await rejection
    assert.equal(state.sessionId, "ses-existing")
})
