import { tool } from "@opencode-ai/plugin"
import type { CompressToolContext, ToolContext } from "./types"
import { countTokens } from "../token-utils"
import { RANGE_FORMAT_EXTENSION } from "../prompts/extensions/tool"
import {
    failCompression,
    finalizeSession,
    prepareSession,
    type NotificationEntry,
} from "./pipeline"
import {
    appendProtectedPromptInfo,
    appendProtectedTools,
    appendProtectedUserMessages,
} from "./protected-content"
import {
    appendMissingBlockSummaries,
    injectBlockPlaceholders,
    parseBlockPlaceholders,
    resolveRanges,
    validateArgs,
    validateNonOverlapping,
    validateSummaryPlaceholders,
} from "./range-utils"
import {
    COMPRESSED_BLOCK_HEADER,
    allocateBlockId,
    allocateRunId,
    applyCompressionState,
    wrapCompressedSummary,
} from "./state"
import type { CompressRangeToolArgs } from "./types"
import { COMPRESSION_API_TIMEOUT_MS, runAbortable } from "./abort"
import { getContextLimitStatus, validateCompressionEffectiveness } from "./effectiveness"

function buildSchema() {
    return {
        topic: tool.schema
            .string()
            .describe("Short label (3-5 words) for display - e.g., 'Auth System Exploration'"),
        content: tool.schema
            .array(
                tool.schema.object({
                    startId: tool.schema
                        .string()
                        .describe(
                            "Message or block ID marking the beginning of range (e.g. m0001, b2)",
                        ),
                    endId: tool.schema
                        .string()
                        .describe("Message or block ID marking the end of range (e.g. m0012, b5)"),
                    summary: tool.schema
                        .string()
                        .describe("Complete technical summary replacing all content in range"),
                }),
            )
            .describe(
                "One or more ranges to compress, each with start/end boundaries and a summary",
            ),
    }
}

export function createCompressRangeTool(sharedCtx: CompressToolContext): ReturnType<typeof tool> {
    sharedCtx.prompts.reload()
    const runtimePrompts = sharedCtx.prompts.getRuntimePrompts()

    return tool({
        description: runtimePrompts.compressRange + RANGE_FORMAT_EXTENSION,
        args: buildSchema(),
        async execute(args, toolCtx) {
            return sharedCtx.sessions.runExclusive(toolCtx.sessionID, async (state, sessionGuard) => {
                const ctx: ToolContext = { ...sharedCtx, state, sessionGuard }
            const input = args as CompressRangeToolArgs
            validateArgs(input)
            const callId =
                typeof (toolCtx as unknown as { callID?: unknown }).callID === "string"
                    ? (toolCtx as unknown as { callID: string }).callID
                    : undefined

            const { rawMessages, searchContext, signal } = await prepareSession(
                ctx,
                toolCtx,
                `Compress Range: ${input.topic}`,
            )
            const resolvedPlans = resolveRanges(input, searchContext, ctx.state)
            validateNonOverlapping(resolvedPlans)

            const notifications: NotificationEntry[] = []
            const preparedPlans: Array<{
                entry: (typeof resolvedPlans)[number]["entry"]
                selection: (typeof resolvedPlans)[number]["selection"]
                anchorMessageId: string
                finalSummary: string
                consumedBlockIds: number[]
                summaryTokens: number
            }> = []
            let totalCompressedMessages = 0

            for (const plan of resolvedPlans) {
                const parsedPlaceholders = parseBlockPlaceholders(plan.entry.summary)
                const missingBlockIds = validateSummaryPlaceholders(
                    parsedPlaceholders,
                    plan.selection.requiredBlockIds,
                    plan.selection.startReference,
                    plan.selection.endReference,
                    searchContext.summaryByBlockId,
                )

                const injected = injectBlockPlaceholders(
                    plan.entry.summary,
                    parsedPlaceholders,
                    searchContext.summaryByBlockId,
                    plan.selection.startReference,
                    plan.selection.endReference,
                )

                const summaryWithUsers = appendProtectedUserMessages(
                    injected.expandedSummary,
                    plan.selection,
                    searchContext,
                    ctx.state,
                    ctx.config.compress.protectUserMessages,
                )

                const summaryWithPromptInfo = appendProtectedPromptInfo(
                    summaryWithUsers,
                    plan.selection,
                    searchContext,
                    ctx.state,
                    ctx.config.compress.protectTags,
                )

                const summaryWithTools = await runAbortable(
                    (requestSignal) =>
                        appendProtectedTools(
                            ctx.client,
                            ctx.state,
                            ctx.config.experimental.allowSubAgents,
                            summaryWithPromptInfo,
                            plan.selection,
                            searchContext,
                            ctx.config.compress.protectedTools,
                            ctx.config.protectedFilePatterns,
                            requestSignal,
                        ),
                    signal,
                    "Loading protected compression content",
                    COMPRESSION_API_TIMEOUT_MS,
                ).catch((error) => failCompression(ctx, error))
                ctx.sessionGuard.assertActive()

                const completedSummary = appendMissingBlockSummaries(
                    summaryWithTools,
                    missingBlockIds,
                    searchContext.summaryByBlockId,
                    injected.consumedBlockIds,
                )

                const nextBlockId = Number.isInteger(ctx.state.prune.messages.nextBlockId)
                    ? Math.max(1, ctx.state.prune.messages.nextBlockId)
                    : 1
                const summaryTokens = countTokens(
                    wrapCompressedSummary(nextBlockId + preparedPlans.length, completedSummary.expandedSummary),
                )

                preparedPlans.push({
                    entry: plan.entry,
                    selection: plan.selection,
                    anchorMessageId: plan.anchorMessageId,
                    finalSummary: completedSummary.expandedSummary,
                    consumedBlockIds: completedSummary.consumedBlockIds,
                    summaryTokens,
                })
            }

            ctx.sessionGuard.assertActive()
            try {
                validateCompressionEffectiveness(
                    ctx.state,
                    ctx.config,
                    preparedPlans.map((plan) => ({
                        label: `${plan.entry.startId}-${plan.entry.endId}`,
                        selection: plan.selection,
                        summaryTokens: plan.summaryTokens,
                        consumedBlockIds: plan.consumedBlockIds,
                    })),
                    getContextLimitStatus(ctx.config, ctx.state, rawMessages),
                )
            } catch (error) {
                failCompression(ctx, error)
            }
            ctx.sessionGuard.assertActive()
            const runId = allocateRunId(ctx.state)

            for (const preparedPlan of preparedPlans) {
                const blockId = allocateBlockId(ctx.state)
                const storedSummary = wrapCompressedSummary(blockId, preparedPlan.finalSummary)
                const summaryTokens = preparedPlan.summaryTokens

                const applied = applyCompressionState(
                    ctx.state,
                    {
                        topic: input.topic,
                        batchTopic: input.topic,
                        startId: preparedPlan.entry.startId,
                        endId: preparedPlan.entry.endId,
                        mode: "range",
                        runId,
                        compressMessageId: toolCtx.messageID,
                        compressCallId: callId,
                        summaryTokens,
                    },
                    preparedPlan.selection,
                    preparedPlan.anchorMessageId,
                    blockId,
                    storedSummary,
                    preparedPlan.consumedBlockIds,
                )

                totalCompressedMessages += applied.messageIds.length

                notifications.push({
                    blockId,
                    runId,
                    summary: preparedPlan.finalSummary,
                    summaryTokens,
                })
            }

            await finalizeSession(ctx, toolCtx, rawMessages, notifications, input.topic)

            return `Compressed ${totalCompressedMessages} messages into ${COMPRESSED_BLOCK_HEADER}.`
            })
        },
    })
}
