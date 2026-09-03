import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { isContextOverLimits } from "../lib/messages/inject/utils"
import { buildContextPressureGuidance } from "../lib/messages/inject/utils"
import { injectCompressNudges } from "../lib/messages/inject/inject"
import { wrapCompressedSummary } from "../lib/compress/state"
import { createSessionState, type WithParts } from "../lib/state"
import type { CompressionBlock } from "../lib/state"
import { getCurrentTokenUsage } from "../lib/token-utils"
import { Logger } from "../lib/logger"
import { CONTEXT_LIMIT_NUDGE } from "../lib/prompts/context-limit-nudge"

function buildConfig(maxContextLimit: number, minContextLimit = 1): PluginConfig {
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
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            maxContextLimit,
            minContextLimit,
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

function textPart(messageID: string, sessionID: string, id: string, text: string) {
    return {
        id,
        messageID,
        sessionID,
        type: "text" as const,
        text,
    }
}

function repeatedWord(word: string, count: number): string {
    return Array.from({ length: count }, () => word).join(" ")
}

function buildCompactedMessages(): WithParts[] {
    const sessionID = "ses_compaction_token_usage"

    return [
        {
            info: {
                id: "msg-user-summary",
                role: "user",
                sessionID,
                agent: "assistant",
                time: { created: 1 },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg-user-summary",
                    sessionID,
                    "msg-user-summary-part",
                    `[Compressed conversation section]\n${repeatedWord("summary", 120)}`,
                ),
            ],
        },
        {
            info: {
                id: "msg-assistant-summary",
                role: "assistant",
                sessionID,
                agent: "assistant",
                summary: true,
                time: { created: 2 },
                tokens: {
                    input: 86000,
                    output: 1200,
                    reasoning: 300,
                    cache: {
                        read: 5000,
                        write: 0,
                    },
                },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg-assistant-summary",
                    sessionID,
                    "msg-assistant-summary-part",
                    `Compaction summary. ${repeatedWord("carry", 180)}`,
                ),
            ],
        },
        {
            info: {
                id: "msg-user-follow-up",
                role: "user",
                sessionID,
                agent: "assistant",
                time: { created: 3 },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg-user-follow-up",
                    sessionID,
                    "msg-user-follow-up-part",
                    `Continue from here. ${repeatedWord("next", 40)}`,
                ),
            ],
        },
    ]
}

function buildPostCompactionAssistantMessage(): WithParts {
    const sessionID = "ses_compaction_token_usage"

    return {
        info: {
            id: "msg-assistant-post-compaction",
            role: "assistant",
            sessionID,
            agent: "assistant",
            time: { created: 4 },
            tokens: {
                input: 2400,
                output: 600,
                reasoning: 150,
                cache: {
                    read: 300,
                    write: 0,
                },
            },
        } as WithParts["info"],
        parts: [
            textPart(
                "msg-assistant-post-compaction",
                sessionID,
                "msg-assistant-post-compaction-part",
                `Fresh post-compaction reply. ${repeatedWord("done", 60)}`,
            ),
        ],
    }
}

function createActiveBlock(
    blockId: number,
    summary: string,
    summaryTokens: number,
): CompressionBlock {
    return {
        blockId,
        runId: blockId,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens,
        mode: "message",
        topic: `Summary ${blockId}`,
        batchTopic: `Summary ${blockId}`,
        startId: "m0001",
        endId: "m0001",
        anchorMessageId: `msg-${blockId}`,
        compressMessageId: `compress-${blockId}`,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [],
        effectiveToolIds: [],
        createdAt: blockId,
        summary,
    }
}

test("getCurrentTokenUsage returns 0 until a fresh assistant follows compaction", () => {
    const messages = buildCompactedMessages()
    const state = createSessionState()
    state.lastCompaction = 2

    assert.equal(getCurrentTokenUsage(state, messages), 0)
})

test("isContextOverLimits ignores stale summary totals and resumes with fresh reported totals", () => {
    const messages = buildCompactedMessages()
    const state = createSessionState()
    state.lastCompaction = 2

    const staleAssistantTotal = 86000 + 1200 + 300 + 5000
    assert.equal(getCurrentTokenUsage(state, messages), 0)

    const underLimit = isContextOverLimits(
        buildConfig(staleAssistantTotal - 1, 1),
        state,
        undefined,
        undefined,
        messages,
    )

    assert.equal(underLimit.overMaxLimit, false)
    assert.equal(underLimit.overMinLimit, false)

    messages.push(buildPostCompactionAssistantMessage())
    const freshReportedTotal = 2400 + 600 + 150 + 300

    assert.equal(getCurrentTokenUsage(state, messages), freshReportedTotal)

    const overLimit = isContextOverLimits(
        buildConfig(freshReportedTotal - 1, 1),
        state,
        undefined,
        undefined,
        messages,
    )

    assert.equal(overLimit.overMaxLimit, true)
})

test("isContextOverLimits extends the max threshold by active summary tokens", () => {
    const messages = buildCompactedMessages()
    messages.push(buildPostCompactionAssistantMessage())

    const state = createSessionState()
    state.lastCompaction = 2

    const storedSummary = wrapCompressedSummary(7, repeatedWord("summary", 120))
    state.prune.messages.blocksById.set(7, createActiveBlock(7, storedSummary, 1000))
    state.prune.messages.activeBlockIds.add(7)

    const freshReportedTotal = 2400 + 600 + 150 + 300

    const underExtendedLimit = isContextOverLimits(
        buildConfig(freshReportedTotal - 1, 1),
        state,
        undefined,
        undefined,
        messages,
    )

    assert.equal(underExtendedLimit.overMaxLimit, false)

    const overExtendedLimit = isContextOverLimits(
        buildConfig(freshReportedTotal - 1001, 1),
        state,
        undefined,
        undefined,
        messages,
    )

    assert.equal(overExtendedLimit.overMaxLimit, true)
})

test("isContextOverLimits does not extend the max threshold when summaryBuffer is disabled", () => {
    const messages = buildCompactedMessages()
    messages.push(buildPostCompactionAssistantMessage())

    const state = createSessionState()
    state.lastCompaction = 2

    const storedSummary = wrapCompressedSummary(7, repeatedWord("summary", 120))
    state.prune.messages.blocksById.set(7, createActiveBlock(7, storedSummary, 1000))
    state.prune.messages.activeBlockIds.add(7)

    const freshReportedTotal = 2400 + 600 + 150 + 300
    const config = buildConfig(freshReportedTotal - 1, 1)
    config.compress.summaryBuffer = false

    const overLimit = isContextOverLimits(config, state, undefined, undefined, messages)

    assert.equal(overLimit.overMaxLimit, true)
})

test("context pressure status reports excess and a bounded recovery target", () => {
    const messages = buildCompactedMessages()
    messages.push(buildPostCompactionAssistantMessage())
    const state = createSessionState()
    state.lastCompaction = 2
    const status = isContextOverLimits(buildConfig(1000, 500), state, undefined, undefined, messages)

    assert.equal(status.currentTokens, 3450)
    assert.equal(status.maxContextLimit, 1000)
    assert.equal(status.excessTokens, 2450)
    assert.equal(status.requiredRecoveryTokens, 2048)
    assert.match(buildContextPressureGuidance(status), /recover at least 2048 pressure tokens/)
    assert.match(buildContextPressureGuidance(status), /Do not select a singleton/)
})

test("successful over-limit compression observes the configured nudge cooldown", async () => {
    const sessionID = "ses_context_limit_cooldown"
    const state = createSessionState()
    const config = buildConfig(1000, 500)
    const user: WithParts = {
        info: {
            id: "msg-user",
            role: "user",
            sessionID,
            agent: "assistant",
            model: { providerID: "anthropic", modelID: "claude-test" },
            time: { created: 1 },
        } as WithParts["info"],
        parts: [textPart("msg-user", sessionID, "user-part", "Start")],
    }
    const compressAssistant: WithParts = {
        info: {
            id: "msg-compress",
            role: "assistant",
            sessionID,
            agent: "assistant",
            time: { created: 2 },
            tokens: {
                input: 3000,
                output: 100,
                reasoning: 0,
                cache: { read: 0, write: 0 },
            },
        } as WithParts["info"],
        parts: [
            {
                id: "compress-part",
                messageID: "msg-compress",
                sessionID,
                type: "tool",
                tool: "compress",
                callID: "compress-call",
                state: { status: "completed", input: {}, output: "done" },
            } as WithParts["parts"][number],
        ],
    }
    const messages = [user, compressAssistant]
    const prompts = {
        contextLimitNudge: CONTEXT_LIMIT_NUDGE,
        turnNudge: "",
        iterationNudge: "",
    } as any
    let saves = 0
    const persistState = async () => {
        saves++
    }

    await injectCompressNudges(
        state,
        config,
        new Logger(false),
        messages,
        prompts,
        undefined,
        persistState,
    )
    assert.equal(state.nudges.contextLimitCooldown, 5)
    assert.equal(state.nudges.contextLimitLastAssistantId, "msg-compress")
    assert.equal(saves, 1)

    await injectCompressNudges(
        state,
        config,
        new Logger(false),
        messages,
        prompts,
        undefined,
        persistState,
    )
    assert.equal(state.nudges.contextLimitCooldown, 5)
    assert.equal(saves, 1)

    for (let index = 1; index <= 5; index++) {
        const messageID = `msg-assistant-${index}`
        messages.push({
            info: {
                id: messageID,
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: index + 2 },
                tokens: {
                    input: 3000,
                    output: 100,
                    reasoning: 0,
                    cache: { read: 0, write: 0 },
                },
            } as WithParts["info"],
            parts: [textPart(messageID, sessionID, `${messageID}-part`, "Continue")],
        })
        await injectCompressNudges(
            state,
            config,
            new Logger(false),
            messages,
            prompts,
            undefined,
            persistState,
        )

        if (index < 5) {
            assert.equal(state.nudges.contextLimitAnchors.size, 0)
            assert.equal(state.nudges.contextLimitCooldown, 5 - index)
        }

        const cooldown = state.nudges.contextLimitCooldown
        const saveCount = saves
        await injectCompressNudges(
            state,
            config,
            new Logger(false),
            messages,
            prompts,
            undefined,
            persistState,
        )
        assert.equal(state.nudges.contextLimitCooldown, cooldown)
        assert.equal(saves, saveCount)
    }

    assert.equal(state.nudges.contextLimitCooldown, 0)
    assert.deepEqual(Array.from(state.nudges.contextLimitAnchors), ["msg-assistant-5"])
    assert.match((messages.at(-1)?.parts[0] as { text: string }).text, /Current context usage is 3100/)
    assert.match((messages.at(-1)?.parts[0] as { text: string }).text, /effective maximum is 1000/)
    assert.match((messages.at(-1)?.parts[0] as { text: string }).text, /2100 tokens of excess/)
    assert.match((messages.at(-1)?.parts[0] as { text: string }).text, /recover at least 2048/)

    const reloaded = createSessionState()
    reloaded.nudges.contextLimitCooldown = state.nudges.contextLimitCooldown
    reloaded.nudges.contextLimitLastAssistantId = state.nudges.contextLimitLastAssistantId
    reloaded.nudges.contextLimitAnchors = new Set(state.nudges.contextLimitAnchors)
    await injectCompressNudges(
        reloaded,
        config,
        new Logger(false),
        messages,
        prompts,
        undefined,
        persistState,
    )
    assert.equal(saves, 6)
    assert.deepEqual(Array.from(reloaded.nudges.contextLimitAnchors), ["msg-assistant-5"])

    messages.push({
        info: {
            id: "msg-assistant-under-limit",
            role: "assistant",
            sessionID,
            agent: "assistant",
            time: { created: 8 },
            tokens: {
                input: 100,
                output: 50,
                reasoning: 0,
                cache: { read: 0, write: 0 },
            },
        } as WithParts["info"],
        parts: [
            textPart(
                "msg-assistant-under-limit",
                sessionID,
                "msg-assistant-under-limit-part",
                "Recovered",
            ),
        ],
    })
    await injectCompressNudges(
        state,
        config,
        new Logger(false),
        messages,
        prompts,
        undefined,
        persistState,
    )

    assert.equal(state.nudges.contextLimitCooldown, 0)
    assert.equal(state.nudges.contextLimitAnchors.size, 0)
    const saveCount = saves
    await injectCompressNudges(
        state,
        config,
        new Logger(false),
        messages,
        prompts,
        undefined,
        persistState,
    )
    assert.equal(saves, saveCount)
})
