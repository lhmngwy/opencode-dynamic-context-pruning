import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import {
    contextObligatoryMessageIdsEqual,
    loadContextObligatoryMessageIds,
    parseContextObligatoryMessageIds,
} from "../lib/messages/context-obligatory"
import { buildSearchContext, resolveSelection } from "../lib/compress/search"
import { prune } from "../lib/messages/prune"
import { Logger } from "../lib/logger"
import { createSessionState, type WithParts } from "../lib/state"

function buildConfig(): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        manualMode: { enabled: false, automaticStrategies: true },
        turnProtection: { enabled: false, turns: 4 },
        experimental: { allowSubAgents: false, customPrompts: false },
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
            deduplication: { enabled: false, protectedTools: [] },
            purgeErrors: { enabled: false, turns: 4, protectedTools: [] },
        },
    }
}

function textMessage(id: string, role: "user" | "assistant", text: string): WithParts {
    return {
        info: {
            id,
            role,
            sessionID: "session-1",
            agent: "assistant",
            model:
                role === "user"
                    ? { providerID: "openai", modelID: "test-model" }
                    : undefined,
            time: { created: id === "user-1" ? 1 : 2 },
        } as WithParts["info"],
        parts: [
            {
                id: `${id}-text`,
                messageID: id,
                sessionID: "session-1",
                type: "text",
                text,
            },
        ],
    }
}

function assistantWithTools(): WithParts {
    return {
        info: {
            id: "assistant-1",
            role: "assistant",
            sessionID: "session-1",
            agent: "assistant",
            time: { created: 2 },
        } as WithParts["info"],
        parts: [
            {
                id: "read-part",
                messageID: "assistant-1",
                sessionID: "session-1",
                type: "tool",
                tool: "read",
                callID: "read-call",
                state: {
                    status: "completed",
                    input: { filePath: "/tmp/example" },
                    output: "original output",
                },
            },
            {
                id: "question-part",
                messageID: "assistant-1",
                sessionID: "session-1",
                type: "tool",
                tool: "question",
                callID: "question-call",
                state: {
                    status: "completed",
                    input: { questions: [{ question: "Continue?" }] },
                    output: "yes",
                },
            },
            {
                id: "error-part",
                messageID: "assistant-1",
                sessionID: "session-1",
                type: "tool",
                tool: "bash",
                callID: "error-call",
                state: {
                    status: "error",
                    input: { command: "false", description: "expected failure" },
                    error: "exit 1",
                },
            },
        ],
    } as WithParts
}

test("OpenChamber pin metadata accepts valid records and ignores malformed duplicates", () => {
    const pins = parseContextObligatoryMessageIds({
        metadata: {
            openchamber: {
                context_obligatory_messages: [
                    { id: "user-1", createdAt: 1, role: "user" },
                    { id: "user-1", createdAt: 2, role: "user" },
                    { id: "assistant-1", createdAt: 3, role: "assistant" },
                    { id: "", createdAt: 4, role: "user" },
                    { id: "bad-time", createdAt: Number.NaN, role: "user" },
                    { id: "bad-role", createdAt: 5, role: "system" },
                    null,
                ],
            },
        },
    })

    assert.deepEqual([...pins], ["user-1", "assistant-1"])
    assert.equal(contextObligatoryMessageIdsEqual(pins, new Set(["assistant-1", "user-1"])), true)
    assert.equal(contextObligatoryMessageIdsEqual(pins, new Set(["user-1"])), false)
    assert.deepEqual([...parseContextObligatoryMessageIds({ metadata: {} })], [])
})

test("pin metadata request failures propagate", async () => {
    await assert.rejects(
        loadContextObligatoryMessageIds(
            { session: { get: async () => Promise.reject(new Error("metadata unavailable")) } },
            "session-1",
        ),
        /metadata unavailable/,
    )

    await assert.rejects(
        loadContextObligatoryMessageIds(
            { session: { get: async () => ({ data: undefined, error: { status: 500 } }) } },
            "session-1",
        ),
        /Unable to load pinned-message metadata/,
    )
})

test("compression selection excludes pinned messages and their tool calls", () => {
    const state = createSessionState()
    const user = textMessage("user-1", "user", "request")
    const pinned = assistantWithTools()
    const remaining = textMessage("assistant-2", "assistant", "remaining response")
    const context = buildSearchContext(state, [user, pinned, remaining], new Set(["assistant-1"]))

    const selection = resolveSelection(
        context,
        { type: "message", ref: "m0001", rawIndex: 0, messageId: "user-1" },
        { type: "message", ref: "m0003", rawIndex: 2, messageId: "assistant-2" },
    )

    assert.deepEqual(selection.messageIds, ["user-1", "assistant-2"])
    assert.deepEqual(selection.toolIds, [])

    assert.throws(
        () =>
            resolveSelection(
                context,
                { type: "message", ref: "m0002", rawIndex: 1, messageId: "assistant-1" },
                { type: "message", ref: "m0002", rawIndex: 1, messageId: "assistant-1" },
            ),
        /Pinned messages cannot be compressed/,
    )
})

test("current pins preserve raw compressed messages and all tool parts until unpinned", () => {
    const state = createSessionState()
    const config = buildConfig()
    const logger = new Logger(false)
    const user = textMessage("user-1", "user", "request")
    const assistant = assistantWithTools()

    state.prune.messages.byMessageId.set("assistant-1", {
        tokenCount: 100,
        allBlockIds: [1],
        activeBlockIds: [1],
    })
    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 100,
        summaryTokens: 10,
        mode: "range",
        topic: "Earlier response",
        batchTopic: "Earlier response",
        startId: "m0002",
        endId: "m0002",
        anchorMessageId: "assistant-1",
        compressMessageId: "compress-1",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["assistant-1"],
        directToolIds: ["read-call", "question-call", "error-call"],
        effectiveMessageIds: ["assistant-1"],
        effectiveToolIds: ["read-call", "question-call", "error-call"],
        createdAt: 1,
        summary: "[Compressed conversation section]\nEarlier summary\n",
    })
    state.prune.messages.activeBlockIds.add(1)
    state.prune.messages.activeByAnchorMessageId.set("assistant-1", 1)
    state.prune.tools.set("read-call", 100)
    state.prune.tools.set("question-call", 100)
    state.prune.tools.set("error-call", 100)

    const pinnedMessages = structuredClone([user, assistant])
    prune(state, logger, config, pinnedMessages, new Set(["assistant-1"]))

    const preserved = pinnedMessages.find((message) => message.info.id === "assistant-1")
    assert.ok(preserved)
    assert.equal((preserved.parts[0] as any).state.output, "original output")
    assert.deepEqual((preserved.parts[1] as any).state.input.questions, [
        { question: "Continue?" },
    ])
    assert.equal((preserved.parts[2] as any).state.input.command, "false")
    assert.equal((preserved.parts[2] as any).state.input.description, "expected failure")

    const unpinnedMessages = structuredClone([user, assistant])
    prune(state, logger, config, unpinnedMessages)
    assert.equal(
        unpinnedMessages.some((message) => message.info.id === "assistant-1"),
        false,
    )
})
