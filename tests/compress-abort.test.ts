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

test("prepareSession stops waiting for an explicitly requested permission when cancelled", async () => {
    const controller = new AbortController()
    const state = createSessionState()
    state.manualMode = "compress-pending"

    const preparation = prepareSession(
        {
            client: { session: { get: async () => ({ data: {} }) } },
            state,
            logger: new Logger(false),
            config: {
                manualMode: { enabled: true },
                compress: { permission: "ask" },
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

test("prepareSession does not re-enter the host permission API when compression is allowed", async () => {
    const sessionID = "ses-allowed-compression"
    const state = createSessionState()
    state.sessionId = sessionID
    let permissionRequests = 0

    await prepareSession(
        {
            client: { session: { get: async () => ({ data: {} }) } },
            state,
            logger: new Logger(false),
            config: {
                manualMode: { enabled: false, automaticStrategies: true },
                compress: { permission: "allow" },
                strategies: {
                    deduplication: { enabled: false },
                    purgeErrors: { enabled: false },
                },
            },
            messageCache: new Map([[sessionID, []]]),
        } as any,
        {
            ask: async () => {
                permissionRequests += 1
                return new Promise<void>(() => {})
            },
            metadata: () => {},
            sessionID,
        },
        "Allowed compression",
    )

    assert.equal(permissionRequests, 0)
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

test("prepareSession uses the transformed message cache without re-entering the session API", async () => {
    const sessionID = "ses-cached-compression"
    const state = createSessionState()
    state.sessionId = sessionID
    let sessionFetches = 0

    const prepared = await prepareSession(
        {
            client: {
                session: {
                    get: async () => ({ data: {} }),
                    messages: async () => {
                        sessionFetches += 1
                        return new Promise<never>(() => {})
                    },
                },
            },
            state,
            logger: new Logger(false),
            config: {
                manualMode: { enabled: false, automaticStrategies: true },
                compress: { permission: "allow" },
                strategies: {
                    deduplication: { enabled: false },
                    purgeErrors: { enabled: false },
                },
            },
            messageCache: new Map([[sessionID, []]]),
        } as any,
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
        },
        "Cached compression",
    )

    assert.deepEqual(prepared.rawMessages, [])
    assert.equal(sessionFetches, 0)
})

test("prepareSession fails safely when the runtime message snapshot is unavailable", async () => {
    let sessionFetches = 0
    await assert.rejects(
        prepareSession(
            {
                client: {
                    session: {
                        messages: async () => {
                            sessionFetches += 1
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
                messageCache: new Map(),
            } as any,
            {
                ask: async () => {},
                metadata: () => {},
                sessionID: "ses-missing-snapshot",
            },
            "Missing snapshot",
        ),
        /Compression context snapshot unavailable/,
    )
    assert.equal(sessionFetches, 0)
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
