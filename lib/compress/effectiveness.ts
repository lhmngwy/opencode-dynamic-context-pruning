import type { PluginConfig } from "../config"
import type { SessionState, WithParts } from "../state"
import { getModelInfo, isContextOverLimits, type ContextLimitStatus } from "../messages/inject/utils"
import type { SelectionResolution } from "./types"

export interface CompressionEffectivenessEntry {
    label: string
    selection: SelectionResolution
    summaryTokens: number
    consumedBlockIds: number[]
}

export interface CompressionEffectivenessProjection {
    sourceTokens: number
    summaryTokens: number
    netTokens: number
    pressureReductionTokens: number
}

function isMessageActive(state: SessionState, messageId: string): boolean {
    return (state.prune.messages.byMessageId.get(messageId)?.activeBlockIds.length || 0) > 0
}

function activeConsumedSummaryTokens(state: SessionState, blockIds: Iterable<number>): number {
    let total = 0
    for (const blockId of new Set(blockIds)) {
        const block = state.prune.messages.blocksById.get(blockId)
        if (block?.active) {
            total += block.summaryTokens
        }
    }
    return total
}

function newlyCompressedMessageTokens(
    state: SessionState,
    selection: SelectionResolution,
    seenMessageIds?: Set<string>,
): number {
    let total = 0
    for (const messageId of selection.messageIds) {
        if (seenMessageIds?.has(messageId)) {
            continue
        }
        seenMessageIds?.add(messageId)
        if (!isMessageActive(state, messageId)) {
            total += selection.messageTokenById.get(messageId) || 0
        }
    }
    return total
}

export function getContextLimitStatus(
    config: PluginConfig,
    state: SessionState,
    messages: WithParts[],
): ContextLimitStatus {
    const { providerId, modelId } = getModelInfo(messages)
    return isContextOverLimits(config, state, providerId, modelId, messages)
}

export function validateCompressionEffectiveness(
    state: SessionState,
    config: PluginConfig,
    entries: CompressionEffectivenessEntry[],
    pressure: ContextLimitStatus,
): CompressionEffectivenessProjection {
    for (const entry of entries) {
        const rawSourceTokens = newlyCompressedMessageTokens(state, entry.selection)
        const consumedSummaryTokens = activeConsumedSummaryTokens(state, entry.consumedBlockIds)
        const sourceTokens = rawSourceTokens + consumedSummaryTokens
        const netTokens = sourceTokens - entry.summaryTokens
        if (netTokens <= 0) {
            throw new Error(
                `Compression rejected for ${entry.label}: source=${sourceTokens}, summary=${entry.summaryTokens}, net=${netTokens}. Select more closed source context or provide a smaller summary.`,
            )
        }
    }

    const seenMessageIds = new Set<string>()
    const consumedBlockIds = new Set<number>()
    let rawSourceTokens = 0
    let summaryTokens = 0
    for (const entry of entries) {
        rawSourceTokens += newlyCompressedMessageTokens(state, entry.selection, seenMessageIds)
        summaryTokens += entry.summaryTokens
        for (const blockId of entry.consumedBlockIds) {
            consumedBlockIds.add(blockId)
        }
    }

    const consumedSummaryTokens = activeConsumedSummaryTokens(state, consumedBlockIds)
    const sourceTokens = rawSourceTokens + consumedSummaryTokens
    const netTokens = sourceTokens - summaryTokens
    const pressureReductionTokens = config.compress.summaryBuffer ? rawSourceTokens : netTokens

    if (
        pressure.overMaxLimit &&
        pressureReductionTokens < pressure.requiredRecoveryTokens
    ) {
        throw new Error(
            `Compression rejected under context pressure: source=${sourceTokens}, summary=${summaryTokens}, net=${netTokens}, excess=${pressure.excessTokens}, pressureReduction=${pressureReductionTokens}, requiredRecovery=${pressure.requiredRecoveryTokens}. Select a broader oldest closed range or multiple non-overlapping broad ranges in one call.`,
        )
    }

    return {
        sourceTokens,
        summaryTokens,
        netTokens,
        pressureReductionTokens,
    }
}
