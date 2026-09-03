import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import {
    validateCompressionEffectiveness,
    type CompressionEffectivenessEntry,
} from "../lib/compress/effectiveness"
import { createSessionState, type CompressionBlock } from "../lib/state"
import type { ContextLimitStatus } from "../lib/messages/inject/utils"

function pressure(overMaxLimit: boolean, requiredRecoveryTokens = 0): ContextLimitStatus {
    return {
        overMaxLimit,
        overMinLimit: true,
        currentTokens: overMaxLimit ? 5000 : 100,
        maxContextLimit: 1000,
        minContextLimit: 500,
        excessTokens: overMaxLimit ? 4000 : 0,
        requiredRecoveryTokens,
    }
}

function config(summaryBuffer: boolean): PluginConfig {
    return { compress: { summaryBuffer } } as PluginConfig
}

function entry(
    tokenCount: number,
    summaryTokens: number,
    consumedBlockIds: number[] = [],
): CompressionEffectivenessEntry {
    return {
        label: "m0001",
        selection: {
            startReference: { kind: "message", rawIndex: 0, messageId: "msg-1" },
            endReference: { kind: "message", rawIndex: 0, messageId: "msg-1" },
            messageIds: ["msg-1"],
            messageTokenById: new Map([["msg-1", tokenCount]]),
            toolIds: [],
            requiredBlockIds: consumedBlockIds,
        },
        summaryTokens,
        consumedBlockIds,
    }
}

test("compression effectiveness rejects non-positive entries", () => {
    const state = createSessionState()

    assert.throws(
        () => validateCompressionEffectiveness(state, config(true), [entry(100, 100)], pressure(false)),
        /source=100, summary=100, net=0/,
    )
})

test("summary buffering counts newly removed raw source as pressure reduction", () => {
    const state = createSessionState()
    const projection = validateCompressionEffectiveness(
        state,
        config(true),
        [entry(3000, 100)],
        pressure(true, 2048),
    )

    assert.equal(projection.netTokens, 2900)
    assert.equal(projection.pressureReductionTokens, 3000)
})

test("consumed summaries count toward net savings but not buffered pressure recovery", () => {
    const state = createSessionState()
    const block: CompressionBlock = {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 1000,
        summaryTokens: 300,
        durationMs: 0,
        topic: "Existing block",
        startId: "m0001",
        endId: "m0001",
        anchorMessageId: "msg-1",
        compressMessageId: "compress-1",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["msg-1"],
        directToolIds: [],
        effectiveMessageIds: ["msg-1"],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "existing",
    }
    state.prune.messages.blocksById.set(1, block)
    state.prune.messages.activeBlockIds.add(1)
    state.prune.messages.byMessageId.set("msg-1", {
        tokenCount: 1000,
        allBlockIds: [1],
        activeBlockIds: [1],
    })

    const buffered = validateCompressionEffectiveness(
        state,
        config(true),
        [entry(1000, 100, [1])],
        pressure(false),
    )
    const unbuffered = validateCompressionEffectiveness(
        state,
        config(false),
        [entry(1000, 100, [1])],
        pressure(false),
    )

    assert.equal(buffered.sourceTokens, 300)
    assert.equal(buffered.netTokens, 200)
    assert.equal(buffered.pressureReductionTokens, 0)
    assert.equal(unbuffered.pressureReductionTokens, 200)
})

test("multi-entry projection deduplicates shared raw messages and consumed summaries", () => {
    const state = createSessionState()
    const block: CompressionBlock = {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 1000,
        summaryTokens: 300,
        durationMs: 0,
        topic: "Existing block",
        startId: "m0001",
        endId: "m0001",
        anchorMessageId: "active-message",
        compressMessageId: "compress-1",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["active-message"],
        directToolIds: [],
        effectiveMessageIds: ["active-message"],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "existing",
    }
    state.prune.messages.blocksById.set(1, block)
    state.prune.messages.activeBlockIds.add(1)

    const first = entry(0, 100, [1])
    first.label = "first"
    first.selection.messageIds = ["shared", "unique-1"]
    first.selection.messageTokenById = new Map([
        ["shared", 500],
        ["unique-1", 700],
    ])
    const second = entry(0, 200, [1])
    second.label = "second"
    second.selection.messageIds = ["shared", "unique-2"]
    second.selection.messageTokenById = new Map([
        ["shared", 500],
        ["unique-2", 900],
    ])

    const projection = validateCompressionEffectiveness(
        state,
        config(true),
        [first, second],
        pressure(true, 2000),
    )

    assert.equal(projection.sourceTokens, 2400)
    assert.equal(projection.summaryTokens, 300)
    assert.equal(projection.netTokens, 2100)
    assert.equal(projection.pressureReductionTokens, 2100)
})
