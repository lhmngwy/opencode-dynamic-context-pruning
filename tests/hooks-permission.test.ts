import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { after, before } from "node:test"
import type { PluginConfig } from "../lib/config"
import {
    createChatMessageTransformHandler,
    createCommandExecuteHandler,
    createEventHandler,
    createSystemPromptHandler,
    createTextCompleteHandler,
} from "../lib/hooks"
import { Logger } from "../lib/logger"
import {
    createSessionState,
    createSessionStateRegistry,
    ensureSessionInitialized,
    refreshManualMode,
    saveManualModeSetting,
    saveSessionState,
    type WithParts,
} from "../lib/state"
import { resolveEffectiveCompressPermission } from "../lib/host-permissions"

let testDataHome = ""
let previousDataHome: string | undefined

before(async () => {
    previousDataHome = process.env.XDG_DATA_HOME
    testDataHome = await mkdtemp(join(tmpdir(), "opencode-dcp-hooks-tests-"))
    process.env.XDG_DATA_HOME = testDataHome
})

after(async () => {
    if (previousDataHome === undefined) {
        delete process.env.XDG_DATA_HOME
    } else {
        process.env.XDG_DATA_HOME = previousDataHome
    }

    if (testDataHome) {
        await rm(testDataHome, { recursive: true, force: true })
    }
})

function buildConfig(permission: "allow" | "ask" | "deny" = "allow"): PluginConfig {
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
            allowSubAgents: false,
            customPrompts: false,
        },
        protectedFilePatterns: [],
        compress: {
            mode: "message",
            permission,
            showCompression: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: ["task"],
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

function buildMessage(id: string, role: "user" | "assistant", text: string): WithParts {
    return {
        info: {
            id,
            role,
            sessionID: "session-1",
            agent: "assistant",
            time: { created: 1 },
        } as WithParts["info"],
        parts: [
            {
                id: `${id}-part`,
                messageID: id,
                sessionID: "session-1",
                type: "text",
                text,
            },
        ],
    }
}

test("effective compression permission preserves explicit host ask policies", () => {
    assert.equal(
        resolveEffectiveCompressPermission(
            "allow",
            {
                global: { compress: "ask" },
                agents: {},
            },
            "assistant",
        ),
        "ask",
    )
    assert.equal(
        resolveEffectiveCompressPermission(
            "allow",
            {
                global: { compress: "allow" },
                agents: { assistant: { compress: "deny" } },
            },
            "assistant",
        ),
        "deny",
    )
})

test("system prompt handler caches full model context for percentage thresholds", async () => {
    const state = createSessionState()
    const handler = createSystemPromptHandler(
        createSessionStateRegistry([["session-1", state]]),
        new Logger(false),
        buildConfig("deny"),
        {
        reload() {},
        getRuntimePrompts() {
            return {} as any
        },
        } as any,
    )

    await handler(
        {
            sessionID: "session-1",
            model: {
                limit: {
                    context: 200000,
                    output: 131072,
                },
            },
        } as any,
        { system: ["base system"] },
    )

    assert.equal(state.modelContextLimit, 200000)
})

function buildPromptStore() {
    return {
        reload() {},
        getRuntimePrompts() {
            return {
                system: "DCP-RUNTIME-PROMPT",
                manualExtension: "",
                subagentExtension: "",
            }
        },
    } as any
}

test("system prompt handler injects nudges for main session with bundled internal prompts", async () => {
    const state = createSessionState()
    const handler = createSystemPromptHandler(
        createSessionStateRegistry([["session-1", state]]),
        new Logger(false),
        buildConfig("allow"),
        buildPromptStore(),
    )
    const output = {
        system: [
            "You are the primary coding assistant for this repository.",
            "You are a title generator for short session names.",
        ],
    }

    await handler(
        {
            sessionID: "session-1",
            model: { limit: { context: 200000 } },
        } as any,
        output,
    )

    assert.match(output.system[output.system.length - 1], /DCP-RUNTIME-PROMPT/)
})

test("system prompt handler skips injection for internal agent calls", async () => {
    const state = createSessionState()
    const handler = createSystemPromptHandler(
        createSessionStateRegistry([["session-1", state]]),
        new Logger(false),
        buildConfig("allow"),
        buildPromptStore(),
    )
    const output = {
        system: ["You are a title generator. Return only a short title."],
    }

    await handler(
        {
            sessionID: "session-1",
            model: { limit: { context: 200000 } },
        } as any,
        output,
    )

    assert.equal(output.system.length, 1)
    assert.doesNotMatch(output.system[0], /DCP-RUNTIME-PROMPT/)
})

test("chat message transform strips hallucinated tags even when compress is denied", async () => {
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig("deny")
    const handler = createChatMessageTransformHandler(
        { session: { get: async () => ({}) } } as any,
        createSessionStateRegistry([["session-1", state]]),
        logger,
        config,
        {
            reload() {},
            getRuntimePrompts() {
                return {} as any
            },
        } as any,
        { global: undefined, agents: {} },
    )
    const output = {
        messages: [buildMessage("assistant-1", "assistant", "alpha <dcp>beta</dcp> omega")],
    }

    await handler({}, output)

    assert.equal(output.messages[0]?.parts[0]?.type, "text")
    assert.equal((output.messages[0]?.parts[0] as any).text, "alpha  omega")
})

test("chat message transform caches an isolated pre-prune snapshot", async () => {
    const state = createSessionState()
    state.sessionId = "session-1"
    state.prune.tools.set("call-1", 100)
    const config = buildConfig("deny")
    config.strategies.deduplication.enabled = false
    config.strategies.purgeErrors.enabled = false
    const messageCache = new Map<string, WithParts[]>()
    const handler = createChatMessageTransformHandler(
        { session: { get: async () => ({ data: {} }) } } as any,
        createSessionStateRegistry([["session-1", state]]),
        new Logger(false),
        config,
        {
            reload() {},
            getRuntimePrompts() {
                return {} as any
            },
        } as any,
        { global: undefined, agents: {} },
        messageCache,
    )
    const output = {
        messages: [
            buildMessage("user-1", "user", "request"),
            {
                info: {
                    id: "assistant-1",
                    role: "assistant",
                    sessionID: "session-1",
                    model: { providerID: "openai", modelID: "test-model" },
                    time: { created: 2 },
                },
                parts: [
                    {
                        id: "tool-1",
                        messageID: "assistant-1",
                        sessionID: "session-1",
                        type: "tool",
                        callID: "call-1",
                        tool: "read",
                        state: {
                            status: "completed",
                            input: { filePath: "/tmp/example" },
                            output: "original large output",
                        },
                    },
                ],
            } as WithParts,
        ],
    }
    ;(output.messages[0]?.info as any).model = {
        providerID: "openai",
        modelID: "test-model",
    }

    await handler({}, output)

    assert.notEqual((output.messages[1]?.parts[0] as any).state.output, "original large output")
    assert.equal(
        (messageCache.get("session-1")?.[1]?.parts[0] as any).state.output,
        "original large output",
    )
})

test("chat message transform skips pruning when pin metadata is unavailable", async () => {
    const state = createSessionState()
    state.sessionId = "session-1"
    state.prune.tools.set("call-1", 100)
    const config = buildConfig("deny")
    config.strategies.deduplication.enabled = false
    config.strategies.purgeErrors.enabled = false
    const logger = new Logger(false)
    const warnings: string[] = []
    logger.warn = ((message: string) => {
        warnings.push(message)
        return Promise.resolve()
    }) as typeof logger.warn
    const handler = createChatMessageTransformHandler(
        {
            session: {
                get: async () => ({ data: undefined, error: { status: 503 } }),
            },
        } as any,
        createSessionStateRegistry([["session-1", state]]),
        logger,
        config,
        {
            reload() {},
            getRuntimePrompts() {
                return {} as any
            },
        } as any,
        { global: undefined, agents: {} },
    )
    const output = {
        messages: [
            {
                ...buildMessage("user-1", "user", "request"),
                info: {
                    ...buildMessage("user-1", "user", "request").info,
                    model: { providerID: "openai", modelID: "test-model" },
                },
            },
            {
                info: {
                    id: "assistant-1",
                    role: "assistant",
                    sessionID: "session-1",
                    model: { providerID: "openai", modelID: "test-model" },
                    time: { created: 2 },
                },
                parts: [
                    {
                        id: "tool-1",
                        messageID: "assistant-1",
                        sessionID: "session-1",
                        type: "tool",
                        callID: "call-1",
                        tool: "read",
                        state: {
                            status: "completed",
                            input: { filePath: "/tmp/example" },
                            output: "original large output",
                        },
                    },
                ],
            } as WithParts,
        ],
    }

    await handler({}, output)

    assert.equal((output.messages[1]?.parts[0] as any).state.output, "original large output")
    assert.deepEqual(warnings, ["Skipping DCP pruning because pinned messages could not be loaded"])
})

test("chat message transform drops messages without info instead of crashing", async () => {
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig("deny")
    const handler = createChatMessageTransformHandler(
        { session: { get: async () => ({}) } } as any,
        createSessionStateRegistry([["session-1", state]]),
        logger,
        config,
        {
            reload() {},
            getRuntimePrompts() {
                return {} as any
            },
        } as any,
        { global: undefined, agents: {} },
    )
    const output = {
        messages: [
            {
                role: "user",
                time: 1,
                parts: [
                    {
                        type: "text",
                        text: "Carica le skill di laravel",
                    },
                ],
            } as any,
        ],
    }

    await handler({}, output as any)

    assert.equal(state.sessionId, null)
    assert.equal(output.messages.length, 0)
})

test("command execute exits after effective permission resolves to deny", async () => {
    let sessionMessagesCalls = 0
    const output = { parts: [] as any[] }
    const handler = createCommandExecuteHandler(
        {
            session: {
                messages: async () => {
                    sessionMessagesCalls += 1
                    return { data: [] }
                },
            },
        } as any,
        createSessionStateRegistry(),
        new Logger(false),
        buildConfig("deny"),
        "/tmp",
        { global: undefined, agents: {} },
    )

    await handler({ command: "dcp", sessionID: "session-1", arguments: "context" }, output)

    assert.equal(sessionMessagesCalls, 1)
    assert.deepEqual(output.parts, [])
})

test("text complete strips hallucinated metadata tags", async () => {
    const output = { text: "alpha <dcp>beta</dcp> omega" }
    const handler = createTextCompleteHandler()

    await handler({ sessionID: "session-1", messageID: "message-1", partID: "part-1" }, output)

    assert.equal(output.text, "alpha  omega")
})

test("event hook attaches durations to matching blocks by message and call id", async () => {
    const state = createSessionState()
    state.sessionId = "session-1"
    const handler = createEventHandler(
        createSessionStateRegistry([["session-1", state]]),
        new Logger(false),
    )
    const originalNow = Date.now
    Date.now = () => 100

    try {
        await handler({
            event: {
                type: "message.part.updated",
                properties: {
                    part: {
                        type: "tool",
                        tool: "compress",
                        callID: "call-1",
                        messageID: "message-1",
                        sessionID: "session-1",
                        state: {
                            status: "pending",
                            input: {},
                            raw: "",
                        },
                    },
                },
            },
        })

        await handler({
            event: {
                type: "message.part.updated",
                properties: {
                    part: {
                        type: "tool",
                        tool: "compress",
                        callID: "call-2",
                        messageID: "message-1",
                        sessionID: "session-1",
                        state: {
                            status: "pending",
                            input: {},
                            raw: "",
                        },
                    },
                },
            },
        })

        await handler({
            event: {
                type: "message.part.updated",
                properties: {
                    part: {
                        type: "tool",
                        tool: "compress",
                        callID: "call-1",
                        messageID: "message-1",
                        sessionID: "session-1",
                        state: {
                            status: "running",
                            input: {},
                            time: { start: 325 },
                        },
                    },
                },
            },
        })

        await handler({
            event: {
                type: "message.part.updated",
                properties: {
                    part: {
                        type: "tool",
                        tool: "compress",
                        callID: "call-2",
                        messageID: "message-1",
                        sessionID: "session-1",
                        state: {
                            status: "running",
                            input: {},
                            time: { start: 410 },
                        },
                    },
                },
            },
        })
        state.prune.messages.blocksById.set(1, {
            blockId: 1,
            runId: 1,
            active: true,
            deactivatedByUser: false,
            compressedTokens: 0,
            summaryTokens: 0,
            durationMs: 0,
            mode: "message",
            topic: "one",
            batchTopic: "one",
            startId: "m0001",
            endId: "m0001",
            anchorMessageId: "msg-a",
            compressMessageId: "message-1",
            compressCallId: "call-1",
            includedBlockIds: [],
            consumedBlockIds: [],
            parentBlockIds: [],
            directMessageIds: [],
            directToolIds: [],
            effectiveMessageIds: ["msg-a"],
            effectiveToolIds: [],
            createdAt: 1,
            summary: "a",
        })
        state.prune.messages.blocksById.set(2, {
            blockId: 2,
            runId: 2,
            active: true,
            deactivatedByUser: false,
            compressedTokens: 0,
            summaryTokens: 0,
            durationMs: 0,
            mode: "message",
            topic: "two",
            batchTopic: "two",
            startId: "m0002",
            endId: "m0002",
            anchorMessageId: "msg-b",
            compressMessageId: "message-1",
            compressCallId: "call-2",
            includedBlockIds: [],
            consumedBlockIds: [],
            parentBlockIds: [],
            directMessageIds: [],
            directToolIds: [],
            effectiveMessageIds: ["msg-b"],
            effectiveToolIds: [],
            createdAt: 2,
            summary: "b",
        })

        await handler({
            event: {
                type: "message.part.updated",
                properties: {
                    part: {
                        type: "tool",
                        tool: "compress",
                        callID: "call-2",
                        messageID: "message-1",
                        sessionID: "session-1",
                        state: {
                            status: "completed",
                            input: {},
                            output: "done",
                            title: "",
                            metadata: {},
                            time: { start: 410, end: 500 },
                        },
                    },
                },
            },
        })

        await handler({
            event: {
                type: "message.part.updated",
                properties: {
                    part: {
                        type: "tool",
                        tool: "compress",
                        callID: "call-1",
                        messageID: "message-1",
                        sessionID: "session-1",
                        state: {
                            status: "completed",
                            input: {},
                            output: "done",
                            title: "",
                            metadata: {},
                            time: { start: 325, end: 500 },
                        },
                    },
                },
            },
        })
    } finally {
        Date.now = originalNow
    }

    assert.equal(state.prune.messages.blocksById.get(1)?.durationMs, 225)
    assert.equal(state.prune.messages.blocksById.get(2)?.durationMs, 310)
})

test("event hook falls back to completed runtime when running duration missing", async () => {
    const state = createSessionState()
    state.sessionId = "session-1"
    const handler = createEventHandler(
        createSessionStateRegistry([["session-1", state]]),
        new Logger(false),
    )

    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        durationMs: 0,
        mode: "message",
        topic: "one",
        batchTopic: "one",
        startId: "m0001",
        endId: "m0001",
        anchorMessageId: "msg-a",
        compressMessageId: "message-1",
        compressCallId: "call-3",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: ["msg-a"],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "a",
    })

    await handler({
        event: {
            type: "message.part.updated",
            properties: {
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "call-3",
                    messageID: "message-1",
                    sessionID: "session-1",
                    state: {
                        status: "completed",
                        input: {},
                        output: "done",
                        title: "",
                        metadata: {},
                        time: { start: 500, end: 940 },
                    },
                },
            },
        },
    })

    assert.equal(state.prune.messages.blocksById.get(1)?.durationMs, 440)
})

test("event hook queues duration updates until the matching session is loaded", async () => {
    const logger = new Logger(false)
    const targetSessionId = `session-target-${process.pid}-${Date.now()}`
    const otherSessionId = `session-other-${process.pid}-${Date.now()}`
    const persistedState = createSessionState()
    persistedState.sessionId = targetSessionId
    persistedState.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        durationMs: 0,
        mode: "message",
        topic: "one",
        batchTopic: "one",
        startId: "m0001",
        endId: "m0001",
        anchorMessageId: "msg-a",
        compressMessageId: "message-1",
        compressCallId: "call-remote",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: ["msg-a"],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "a",
    })
    await saveSessionState(persistedState, logger)

    const targetState = createSessionState()
    const otherState = createSessionState()
    otherState.sessionId = otherSessionId
    const sessions = createSessionStateRegistry([
        [targetSessionId, targetState],
        [otherSessionId, otherState],
    ])
    const handler = createEventHandler(sessions, logger)

    await handler({
        event: {
            type: "message.part.updated",
            properties: {
                sessionID: targetSessionId,
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "call-remote",
                    messageID: "message-1",
                    state: {
                        status: "pending",
                        input: {},
                        raw: "",
                    },
                },
            },
            time: 100,
        },
    })

    await handler({
        event: {
            type: "message.part.updated",
            properties: {
                sessionID: targetSessionId,
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "call-remote",
                    messageID: "message-1",
                    state: {
                        status: "completed",
                        input: {},
                        output: "done",
                        title: "",
                        metadata: {},
                        time: { start: 350, end: 500 },
                    },
                },
            },
        },
    })

    assert.equal(targetState.compressionTiming.pendingByCallId.has("message-1:call-remote"), true)
    assert.equal(targetState.compressionTiming.startsByCallId.has("message-1:call-remote"), false)
    assert.equal(otherState.compressionTiming.pendingByCallId.size, 0)

    await ensureSessionInitialized(
        {
            session: {
                get: async () => ({ data: { parentID: null } }),
            },
        } as any,
        targetState,
        targetSessionId,
        logger,
        [
            {
                info: {
                    id: "msg-user-1",
                    role: "user",
                    sessionID: targetSessionId,
                    agent: "assistant",
                    time: { created: 1 },
                } as WithParts["info"],
                parts: [],
            },
        ],
        false,
    )

    assert.equal(targetState.prune.messages.blocksById.get(1)?.durationMs, 250)
    assert.equal(targetState.compressionTiming.pendingByCallId.has("message-1:call-remote"), false)
})

test("event hook keeps same call id distinct across message ids", async () => {
    const state = createSessionState()
    state.sessionId = "session-1"
    const handler = createEventHandler(
        createSessionStateRegistry([["session-1", state]]),
        new Logger(false),
    )

    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        durationMs: 0,
        mode: "message",
        topic: "one",
        batchTopic: "one",
        startId: "m0001",
        endId: "m0001",
        anchorMessageId: "msg-a",
        compressMessageId: "message-1",
        compressCallId: "shared-call",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: ["msg-a"],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "a",
    })
    state.prune.messages.blocksById.set(2, {
        blockId: 2,
        runId: 2,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        durationMs: 0,
        mode: "message",
        topic: "two",
        batchTopic: "two",
        startId: "m0002",
        endId: "m0002",
        anchorMessageId: "msg-b",
        compressMessageId: "message-2",
        compressCallId: "shared-call",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: ["msg-b"],
        effectiveToolIds: [],
        createdAt: 2,
        summary: "b",
    })

    await handler({
        event: {
            type: "message.part.updated",
            properties: {
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "shared-call",
                    messageID: "message-1",
                    sessionID: "session-1",
                    state: {
                        status: "pending",
                        input: {},
                        raw: "",
                    },
                },
            },
            time: 100,
        },
    })

    await handler({
        event: {
            type: "message.part.updated",
            properties: {
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "shared-call",
                    messageID: "message-2",
                    sessionID: "session-1",
                    state: {
                        status: "pending",
                        input: {},
                        raw: "",
                    },
                },
            },
            time: 200,
        },
    })

    await handler({
        event: {
            type: "message.part.updated",
            properties: {
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "shared-call",
                    messageID: "message-2",
                    sessionID: "session-1",
                    state: {
                        status: "completed",
                        input: {},
                        output: "done",
                        title: "",
                        metadata: {},
                        time: { start: 350, end: 500 },
                    },
                },
            },
        },
    })

    await handler({
        event: {
            type: "message.part.updated",
            properties: {
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "shared-call",
                    messageID: "message-1",
                    sessionID: "session-1",
                    state: {
                        status: "completed",
                        input: {},
                        output: "done",
                        title: "",
                        metadata: {},
                        time: { start: 450, end: 700 },
                    },
                },
            },
        },
    })

    assert.equal(state.prune.messages.blocksById.get(1)?.durationMs, 350)
    assert.equal(state.prune.messages.blocksById.get(2)?.durationMs, 150)
})

test("event hook ignores queued and late events for a deleted session", async () => {
    const sessionID = `session-deleted-event-${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    const sessions = createSessionStateRegistry([[sessionID, state]])
    const handler = createEventHandler(sessions, new Logger(false))
    let releaseActive!: () => void
    const activeGate = new Promise<void>((resolve) => {
        releaseActive = resolve
    })
    let activeStarted!: () => void
    const started = new Promise<void>((resolve) => {
        activeStarted = resolve
    })
    const active = sessions.runExclusive(sessionID, async () => {
        activeStarted()
        await activeGate
    })
    const activeRejection = assert.rejects(active, /has been disposed/)
    await started

    const partEvent = {
        event: {
            type: "message.part.updated",
            properties: {
                sessionID,
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "call-deleted",
                    messageID: "message-deleted",
                    state: { status: "pending", input: {}, raw: "" },
                },
            },
            time: 100,
        },
    }
    const queuedEvent = handler(partEvent)
    const deletion = handler({
        event: {
            type: "session.deleted",
            properties: { info: { id: sessionID } },
        },
    })
    assert.equal(sessions.peek(sessionID), undefined)
    const lateEvent = handler(partEvent)

    releaseActive()
    await Promise.all([activeRejection, queuedEvent, lateEvent, deletion])

    assert.equal(sessions.peek(sessionID), undefined)
    await handler(partEvent)
    assert.equal(sessions.peek(sessionID), undefined)
    await assert.rejects(sessions.runExclusive(sessionID, () => {}), /has been disposed/)
})

test("session deletion aborts active timing persistence without hiding other failures", async () => {
    const sessionID = `session-deleted-timing-${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 1,
        summaryTokens: 1,
        durationMs: 0,
        mode: "message",
        topic: "timing",
        batchTopic: "timing",
        startId: "m0001",
        endId: "m0001",
        anchorMessageId: "msg-a",
        compressMessageId: "message-timing",
        compressCallId: "call-timing",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "timing",
    })
    const timingBlock = structuredClone(state.prune.messages.blocksById.get(1)!)
    state.compressionTiming.startsByCallId.set("message-timing:call-timing", 100)
    const sessions = createSessionStateRegistry([[sessionID, state]])
    let persistStarted!: () => void
    const started = new Promise<void>((resolve) => {
        persistStarted = resolve
    })
    let persisted = false
    const persist = async (
        _state: typeof state,
        _logger: Logger,
        _name?: string,
        assertActive?: () => void,
        signal?: AbortSignal,
    ) => {
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
    }
    const handler = createEventHandler(sessions, new Logger(false), undefined, persist)
    const completedEvent = {
        event: {
            type: "message.part.updated",
            properties: {
                sessionID,
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "call-timing",
                    messageID: "message-timing",
                    sessionID,
                    state: {
                        status: "completed",
                        input: {},
                        output: "done",
                        time: { start: 150, end: 250 },
                    },
                },
            },
        },
    }

    const event = handler(completedEvent)
    await started
    await handler({
        event: { type: "session.deleted", properties: { info: { id: sessionID } } },
    })
    await event
    assert.equal(persisted, false)
    assert.equal(state.compressionTiming.pendingByCallId.size, 0)
    assert.equal(sessions.peek(sessionID), undefined)
    await assert.rejects(sessions.runExclusive(sessionID, () => {}), /has been disposed/)

    const failingSessionID = `${sessionID}-failure`
    const failingState = createSessionState()
    failingState.sessionId = failingSessionID
    failingState.prune.messages.blocksById.set(1, {
        ...timingBlock,
        durationMs: 0,
    })
    failingState.compressionTiming.startsByCallId.set("message-timing:call-timing", 100)
    const failingHandler = createEventHandler(
        createSessionStateRegistry([[failingSessionID, failingState]]),
        new Logger(false),
        undefined,
        async () => {
            throw new Error("expected persistence failure")
        },
    )
    const failingEvent = structuredClone(completedEvent)
    failingEvent.event.properties.sessionID = failingSessionID
    failingEvent.event.properties.part.sessionID = failingSessionID
    await assert.rejects(failingHandler(failingEvent), /expected persistence failure/)
})

test("manual mode persisted setting refreshes server session state", async () => {
    const logger = new Logger(false)
    const sessionId = `manual-mode-${Date.now()}-${Math.random().toString(16).slice(2)}`

    await saveManualModeSetting(sessionId, true, logger)

    const state = createSessionState()
    state.sessionId = sessionId
    state.manualMode = false

    await refreshManualMode(state, sessionId, logger, false)
    assert.equal(state.manualMode, "active")

    await saveManualModeSetting(sessionId, false, logger)
    await refreshManualMode(state, sessionId, logger, true)
    assert.equal(state.manualMode, false)
})
