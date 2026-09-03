import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test, { after, before } from "node:test"
import { createCompressRangeTool } from "../lib/compress/range"
import { createEventHandler } from "../lib/hooks"
import {
    createSessionState,
    createSessionStateRegistry,
    deleteSessionState,
    loadSessionState,
    type WithParts,
} from "../lib/state"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"

let testRoot = ""
let testDataHome = ""
let testConfigHome = ""
let previousDataHome: string | undefined
let previousConfigHome: string | undefined

before(async () => {
    previousDataHome = process.env.XDG_DATA_HOME
    previousConfigHome = process.env.XDG_CONFIG_HOME
    testRoot = await mkdtemp(join(tmpdir(), "opencode-dcp-range-tests-"))
    testDataHome = join(testRoot, "data")
    testConfigHome = join(testRoot, "config")
    await mkdir(testDataHome, { recursive: true })
    await mkdir(testConfigHome, { recursive: true })
    process.env.XDG_DATA_HOME = testDataHome
    process.env.XDG_CONFIG_HOME = testConfigHome
})

after(async () => {
    if (previousDataHome === undefined) {
        delete process.env.XDG_DATA_HOME
    } else {
        process.env.XDG_DATA_HOME = previousDataHome
    }
    if (previousConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME
    } else {
        process.env.XDG_CONFIG_HOME = previousConfigHome
    }

    if (testRoot) {
        await rm(testRoot, { recursive: true, force: true })
    }
})

function buildConfig(): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: {
            enabled: true,
            protectedTools: [],
        },
        manualMode: {
            enabled: false,
            automaticStrategies: true,
        },
        turnProtection: {
            enabled: false,
            turns: 4,
        },
        experimental: {
            allowSubAgents: true,
            customPrompts: false,
        },
        protectedFilePatterns: [],
        compress: {
            mode: "range",
            permission: "allow",
            showCompression: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
        },
        strategies: {
            deduplication: {
                enabled: true,
                protectedTools: [],
            },
            purgeErrors: {
                enabled: true,
                turns: 4,
                protectedTools: [],
            },
        },
    }
}

function textPart(messageID: string, sessionID: string, id: string, text: string) {
    return {
        id,
        messageID,
        sessionID,
        type: "text" as const,
        text,
    }
}

function buildMessages(sessionID: string): WithParts[] {
    return [
        {
            info: {
                id: "msg-subagent-prompt",
                role: "user",
                sessionID,
                agent: "codebase-analyzer",
                model: {
                    providerID: "anthropic",
                    modelID: "claude-test",
                },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [textPart("msg-subagent-prompt", sessionID, "part-1", "Investigate the issue")],
        },
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "codebase-analyzer",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                textPart("msg-assistant-1", sessionID, "part-2", "I found the relevant code path"),
            ],
        },
        {
            info: {
                id: "msg-user-2",
                role: "user",
                sessionID,
                agent: "codebase-analyzer",
                model: {
                    providerID: "anthropic",
                    modelID: "claude-test",
                },
                time: { created: 3 },
            } as WithParts["info"],
            parts: [
                textPart("msg-user-2", sessionID, "part-3", "Please compress the initial findings"),
            ],
        },
    ]
}

test("compress range uses state owned by its session registry entry", async () => {
    const sessionID = `ses_subagent_compress_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()

    const logger = new Logger(false)
    const tool = createCompressRangeTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: "ses_parent" } }),
            },
        },
        sessions: createSessionStateRegistry([[sessionID, state]]),
        logger,
        config: buildConfig(),
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
    } as any)

    const result = await tool.execute(
        {
            topic: "Subagent race fix",
            content: [
                {
                    startId: "m0001",
                    endId: "m0002",
                    summary: "Captured the initial investigation and follow-up request.",
                },
            ],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-compress",
        },
    )

    assert.equal(result, "Compressed 2 messages into [Compressed conversation section].")
    assert.equal(state.sessionId, sessionID)
    assert.equal(state.isSubAgent, true)
    assert.equal(state.messageIds.byRef.get("m0001"), "msg-assistant-1")
    assert.equal(state.messageIds.byRef.get("m0002"), "msg-user-2")
    assert.equal(state.prune.messages.blocksById.size, 1)
})

test("compress range isolates concurrent sessions", async () => {
    const firstSessionID = `ses_concurrent_first_${Date.now()}`
    const secondSessionID = `ses_concurrent_second_${Date.now()}`
    const messages = new Map([
        [firstSessionID, buildMessages(firstSessionID)],
        [secondSessionID, buildMessages(secondSessionID)],
    ])
    const sessions = createSessionStateRegistry()
    let initialized = 0
    let releaseInitialization!: () => void
    const initializationBarrier = new Promise<void>((resolve) => {
        releaseInitialization = resolve
    })
    const tool = createCompressRangeTool({
        client: {
            session: {
                messages: async ({ path }: any) => ({ data: messages.get(path.id) }),
                get: async () => {
                    initialized += 1
                    if (initialized === 2) {
                        releaseInitialization()
                    }
                    await initializationBarrier
                    return { data: { parentID: "ses_parent" } }
                },
            },
        },
        sessions,
        logger: new Logger(false),
        config: buildConfig(),
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
    } as any)

    const compress = (sessionID: string) =>
        tool.execute(
            {
                topic: "Concurrent session",
                content: [
                    {
                        startId: "m0001",
                        endId: "m0002",
                        summary: `Summary for ${sessionID}.`,
                    },
                ],
            },
            {
                ask: async () => {},
                metadata: () => {},
                sessionID,
                messageID: `msg-compress-${sessionID}`,
            },
        )

    const [firstResult, secondResult] = await Promise.all([
        compress(firstSessionID),
        compress(secondSessionID),
    ])

    assert.equal(firstResult, "Compressed 2 messages into [Compressed conversation section].")
    assert.equal(secondResult, "Compressed 2 messages into [Compressed conversation section].")
    assert.equal(sessions.peek(firstSessionID)?.sessionId, firstSessionID)
    assert.equal(sessions.peek(secondSessionID)?.sessionId, secondSessionID)
    assert.equal(sessions.peek(firstSessionID)?.prune.messages.blocksById.size, 1)
    assert.equal(sessions.peek(secondSessionID)?.prune.messages.blocksById.size, 1)
})

test("compress range serializes concurrent calls for one session", async () => {
    const sessionID = `ses_concurrent_same_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const sessions = createSessionStateRegistry()
    let messageRequests = 0
    let firstRequestStarted!: () => void
    const requestStarted = new Promise<void>((resolve) => {
        firstRequestStarted = resolve
    })
    let releaseFirstRequest!: () => void
    const firstRequestGate = new Promise<void>((resolve) => {
        releaseFirstRequest = resolve
    })
    const tool = createCompressRangeTool({
        client: {
            session: {
                messages: async () => {
                    messageRequests += 1
                    if (messageRequests === 1) {
                        firstRequestStarted()
                        await firstRequestGate
                    }
                    return { data: rawMessages }
                },
                get: async () => ({ data: { parentID: "ses_parent" } }),
            },
        },
        sessions,
        logger: new Logger(false),
        config: buildConfig(),
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
    } as any)
    const args = {
        topic: "Serialized session",
        content: [
            {
                startId: "m0001",
                endId: "m0002",
                summary: "Serialized summary.",
            },
        ],
    }
    const context = (messageID: string) => ({
        ask: async () => {},
        metadata: () => {},
        sessionID,
        messageID,
    })

    const first = tool.execute(args, context("msg-compress-first"))
    await requestStarted
    const second = tool.execute(args, context("msg-compress-second"))
    await Promise.resolve()
    assert.equal(messageRequests, 1)
    releaseFirstRequest()
    const results = await Promise.all([first, second])

    assert.equal(results.length, 2)
    assert.equal(messageRequests, 2)
    assert.equal(sessions.peek(sessionID)?.prune.messages.nextRunId, 3)
    assert.equal(sessions.peek(sessionID)?.prune.messages.nextBlockId, 3)
})

test("session deletion cancels active compression before state commit", async () => {
    const sessionID = `ses_deleted_compression_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const sessions = createSessionStateRegistry()
    let requestStarted!: () => void
    const started = new Promise<void>((resolve) => {
        requestStarted = resolve
    })
    let releaseRequest!: () => void
    const requestGate = new Promise<void>((resolve) => {
        releaseRequest = resolve
    })
    const saved: string[] = []
    const logger = new Logger(false)
    logger.info = ((message: string) => {
        saved.push(message)
        return Promise.resolve()
    }) as typeof logger.info
    let notifications = 0
    const config = buildConfig()
    config.pruneNotification = "minimal"
    config.pruneNotificationType = "toast"
    const tool = createCompressRangeTool({
        client: {
            session: {
                messages: async () => {
                    requestStarted()
                    await requestGate
                    return { data: rawMessages }
                },
                get: async () => ({ data: { parentID: "ses_parent" } }),
            },
            tui: {
                showToast: async () => {
                    notifications += 1
                },
            },
        },
        sessions,
        logger,
        config,
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
    } as any)

    const compression = tool.execute(
        {
            topic: "Deleted session",
            content: [
                {
                    startId: "m0001",
                    endId: "m0002",
                    summary: "This compression must not commit after deletion.",
                },
            ],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-compress-deleted",
        },
    )
    const compressionRejection = assert.rejects(compression, /has been disposed/)
    await started
    const state = sessions.peek(sessionID)
    assert.ok(state)
    const disposal = sessions.dispose(sessionID)
    assert.equal(sessions.peek(sessionID), undefined)

    releaseRequest()
    await compressionRejection
    await disposal

    assert.equal(state.prune.messages.blocksById.size, 0)
    assert.equal(state.sessionId, null)
    assert.equal(saved.includes("Saved session state to disk"), false)
    assert.equal(notifications, 0)
})

test("session deletion aborts pending permission without waiting", async () => {
    const sessionID = `ses_deleted_permission_${Date.now()}`
    const sessions = createSessionStateRegistry()
    const config = buildConfig()
    config.compress.permission = "ask"
    let askStarted!: () => void
    const started = new Promise<void>((resolve) => {
        askStarted = resolve
    })
    let releaseAsk!: () => void
    const askGate = new Promise<void>((resolve) => {
        releaseAsk = resolve
    })
    const tool = createCompressRangeTool({
        client: { session: { messages: async () => ({ data: buildMessages(sessionID) }) } },
        sessions,
        logger: new Logger(false),
        config,
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
    } as any)

    const compression = tool.execute(
        {
            topic: "Deleted permission",
            content: [{ startId: "m0001", endId: "m0002", summary: "Never committed." }],
        },
        {
            ask: async () => {
                askStarted()
                await askGate
            },
            metadata: () => {},
            sessionID,
            messageID: "msg-deleted-permission",
        },
    )
    const rejection = assert.rejects(compression, /has been disposed/)
    await started
    await sessions.dispose(sessionID)
    assert.equal(sessions.peek(sessionID), undefined)
    releaseAsk()
    await rejection
})

test("session deletion fences detached initialization after persisted loading", async () => {
    const sessionID = `ses_deleted_initialization_${Date.now()}`
    const state = createSessionState()
    state.compressionTiming.pendingByCallId.set("message-init:call-init", {
        messageId: "message-init",
        callId: "call-init",
        durationMs: 250,
    })
    const sessions = createSessionStateRegistry([[sessionID, state]])
    const logger = new Logger(false)
    let loadStarted!: () => void
    const started = new Promise<void>((resolve) => {
        loadStarted = resolve
    })
    let releaseLoad!: () => void
    const loadGate = new Promise<void>((resolve) => {
        releaseLoad = resolve
    })
    let loadFinished!: () => void
    const finished = new Promise<void>((resolve) => {
        loadFinished = resolve
    })
    let persisted = false
    const tool = createCompressRangeTool({
        client: {
            session: {
                messages: async () => ({ data: buildMessages(sessionID) }),
                get: async () => ({ data: { parentID: "ses_parent" } }),
            },
        },
        sessions,
        logger,
        config: buildConfig(),
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
        loadSessionState: async () => {
            loadStarted()
            await loadGate
            loadFinished()
            return {
                manualMode: false,
                prune: {
                    tools: {},
                    messages: {
                        byMessageId: {},
                        blocksById: {},
                        activeBlockIds: [],
                        activeByAnchorMessageId: {},
                        nextBlockId: 1,
                        nextRunId: 1,
                    },
                },
                nudges: {
                    contextLimitAnchors: [],
                    turnNudgeAnchors: [],
                    iterationNudgeAnchors: [],
                },
                stats: { pruneTokenCounter: 0, totalPruneTokens: 0 },
                lastUpdated: new Date().toISOString(),
            }
        },
        saveSessionState: async () => {
            persisted = true
        },
    } as any)

    const compression = tool.execute(
        {
            topic: "Deleted initialization",
            content: [{ startId: "m0001", endId: "m0002", summary: "Never restored." }],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "message-init",
        },
    )
    const rejection = assert.rejects(compression, /has been disposed/)
    await started
    await sessions.dispose(sessionID, () => deleteSessionState(sessionID, logger))
    assert.equal(state.compressionTiming.pendingByCallId.size, 0)
    releaseLoad()
    await rejection
    await finished
    await new Promise<void>((resolve) => setImmediate(resolve))

    assert.equal(persisted, false)
    assert.equal(state.sessionId, null)
    assert.equal(state.prune.messages.blocksById.size, 0)
    assert.equal(state.compressionTiming.pendingByCallId.size, 0)
    assert.equal(await loadSessionState(sessionID, logger), null)
})

test("session deletion aborts pending persistence before commit", async () => {
    const sessionID = `ses_deleted_persistence_${Date.now()}`
    const sessions = createSessionStateRegistry()
    let persistStarted!: () => void
    const started = new Promise<void>((resolve) => {
        persistStarted = resolve
    })
    let persisted = false
    const tool = createCompressRangeTool({
        client: {
            session: {
                messages: async () => ({ data: buildMessages(sessionID) }),
                get: async () => ({ data: { parentID: "ses_parent" } }),
            },
        },
        sessions,
        logger: new Logger(false),
        config: buildConfig(),
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
        saveSessionState: async (_state, _logger, _name, assertActive, signal) => {
            persistStarted()
            await new Promise<void>((resolve, reject) => {
                if (signal?.aborted) {
                    reject(signal.reason)
                    return
                }
                signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
            })
            assertActive?.()
            persisted = true
        },
    } as any)

    const compression = tool.execute(
        {
            topic: "Deleted persistence",
            content: [{ startId: "m0001", endId: "m0002", summary: "Never persisted." }],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-deleted-persistence",
        },
    )
    const rejection = assert.rejects(compression, /has been disposed/)
    await started
    await sessions.dispose(sessionID)
    await rejection
    assert.equal(persisted, false)
    assert.equal(sessions.peek(sessionID), undefined)
})

test("session deletion aborts toast delivery and removes durable state", async () => {
    const sessionID = `ses_deleted_toast_${Date.now()}`
    const sessions = createSessionStateRegistry()
    const logger = new Logger(false)
    const config = buildConfig()
    config.pruneNotification = "minimal"
    config.pruneNotificationType = "toast"
    let toastStarted!: () => void
    const started = new Promise<void>((resolve) => {
        toastStarted = resolve
    })
    let delivered = false
    const client = {
        session: {
            messages: async () => ({ data: buildMessages(sessionID) }),
            get: async () => ({ data: { parentID: "ses_parent" } }),
        },
        tui: {
            showToast: async ({ signal }: { signal: AbortSignal }) => {
                toastStarted()
                await new Promise<void>((resolve, reject) => {
                    signal.addEventListener("abort", () => reject(signal.reason), { once: true })
                })
                delivered = true
            },
        },
    }
    const tool = createCompressRangeTool({
        client,
        sessions,
        logger,
        config,
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
    } as any)

    const compression = tool.execute(
        {
            topic: "Deleted toast",
            content: [{ startId: "m0001", endId: "m0002", summary: "No notification." }],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-deleted-toast",
        },
    )
    const rejection = assert.rejects(compression, /has been disposed/)
    await started
    const handler = createEventHandler(sessions, logger)
    await handler({
        event: { type: "session.deleted", properties: { info: { id: sessionID } } },
    })
    await rejection
    assert.equal(delivered, false)
    assert.equal(await loadSessionState(sessionID, logger), null)
})

test("compress range mode appends protected prompt info", async () => {
    const sessionID = `ses_range_protect_tag_${Date.now()}`
    const rawMessages: WithParts[] = [
        {
            info: {
                id: "msg-user-1",
                role: "user",
                sessionID,
                agent: "assistant",
                model: {
                    providerID: "anthropic",
                    modelID: "claude-test",
                },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg-user-1",
                    sessionID,
                    "part-user-1",
                    "Investigate the release. <protect>Keep the npm publish token note.</protect>",
                ),
            ],
        },
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [textPart("msg-assistant-1", sessionID, "part-assistant-1", "I checked it")],
        },
    ]

    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig()
    config.compress.protectTags = true
    const tool = createCompressRangeTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: null } }),
            },
        },
        sessions: createSessionStateRegistry([[sessionID, state]]),
        logger,
        config,
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
    } as any)

    await tool.execute(
        {
            topic: "Protected range",
            content: [
                {
                    startId: "m0001",
                    endId: "m0002",
                    summary: "Captured release investigation.",
                },
            ],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-compress-range-protect-tag",
        },
    )

    const block = Array.from(state.prune.messages.blocksById.values())[0]
    assert.match(
        block?.summary || "",
        /The following protected prompt information was included in this conversation verbatim:/,
    )
    assert.match(block?.summary || "", /Keep the npm publish token note\./)
})

test("compress range mode batches multiple ranges into one notification", async () => {
    const sessionID = `ses_range_compress_batch_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig()
    config.pruneNotification = "detailed"
    config.pruneNotificationType = "toast"

    const toastCalls: string[] = []
    const tool = createCompressRangeTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: "ses_parent" } }),
            },
            tui: {
                showToast: async ({ body }: { body: { message: string } }) => {
                    toastCalls.push(body.message)
                },
            },
        },
        sessions: createSessionStateRegistry([[sessionID, state]]),
        logger,
        config,
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
    } as any)

    const result = await tool.execute(
        {
            topic: "Batch stale notes",
            content: [
                {
                    startId: "m0001",
                    endId: "m0001",
                    summary: "Captured the initial assistant investigation.",
                },
                {
                    startId: "m0002",
                    endId: "m0002",
                    summary: "Captured the follow-up user request.",
                },
            ],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-compress-range-batch",
        },
    )

    assert.equal(result, "Compressed 2 messages into [Compressed conversation section].")
    assert.equal(state.prune.messages.blocksById.size, 2)
    assert.equal(toastCalls.length, 1)
    assert.match(toastCalls[0] || "", /▣ DCP \| -[^,\n]+ removed, \+[^\s\n]+ summary/)
    assert.match(toastCalls[0] || "", /Compression #1/)
    assert.match(toastCalls[0] || "", /▣ Compression #1 -[^,\n]+ removed, \+[^\s\n]+ summary/)
    assert.match(toastCalls[0] || "", /Topic: Batch stale notes/)
    assert.match(toastCalls[0] || "", /Items: 2 messages/)
})

test("compress range mode rejects overlapping batched ranges", async () => {
    const sessionID = `ses_range_compress_overlap_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    const logger = new Logger(false)
    const tool = createCompressRangeTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: "ses_parent" } }),
            },
        },
        sessions: createSessionStateRegistry([[sessionID, state]]),
        logger,
        config: buildConfig(),
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
    } as any)

    await assert.rejects(
        tool.execute(
            {
                topic: "Overlapping ranges",
                content: [
                    {
                        startId: "m0001",
                        endId: "m0002",
                        summary: "Captured the initial investigation and follow-up request.",
                    },
                    {
                        startId: "m0002",
                        endId: "m0002",
                        summary: "Captured the follow-up request again.",
                    },
                ],
            },
            {
                ask: async () => {},
                metadata: () => {},
                sessionID,
                messageID: "msg-compress-range-overlap",
            },
        ),
        /Overlapping ranges cannot be compressed in the same batch/,
    )

    assert.equal(state.prune.messages.blocksById.size, 0)
})
