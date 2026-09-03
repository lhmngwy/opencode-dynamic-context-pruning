import { tool } from "@opencode-ai/plugin"
import type { CompressToolContext, ToolContext } from "./types"
import { countTokens } from "../token-utils"
import { MESSAGE_FORMAT_EXTENSION } from "../prompts/extensions/tool"
import { formatIssues, formatResult, resolveMessages, validateArgs } from "./message-utils"
import {
    failCompression,
    finalizeSession,
    prepareSession,
    type NotificationEntry,
} from "./pipeline"
import { appendProtectedPromptInfo, appendProtectedTools } from "./protected-content"
import {
    allocateBlockId,
    allocateRunId,
    applyCompressionState,
    wrapCompressedSummary,
} from "./state"
import type { CompressMessageToolArgs } from "./types"
import { COMPRESSION_API_TIMEOUT_MS, runAbortable } from "./abort"
import { getContextLimitStatus, validateCompressionEffectiveness } from "./effectiveness"

function buildSchema() {
    return {
        topic: tool.schema
            .string()
            .describe(
                "Short label (3-5 words) for the overall batch - e.g., 'Closed Research Notes'",
            ),
        content: tool.schema
            .array(
                tool.schema.object({
                    messageId: tool.schema
                        .string()
                        .describe("Raw message ID to compress (e.g. m0001)"),
                    topic: tool.schema
                        .string()
                        .describe("Short label (3-5 words) for this one message summary"),
                    summary: tool.schema
                        .string()
                        .describe("Complete technical summary replacing that one message"),
                }),
            )
            .describe("Batch of individual message summaries to create in one tool call"),
    }
}

export function createCompressMessageTool(sharedCtx: CompressToolContext): ReturnType<typeof tool> {
    sharedCtx.prompts.reload()
    const runtimePrompts = sharedCtx.prompts.getRuntimePrompts()

    return tool({
        description: runtimePrompts.compressMessage + MESSAGE_FORMAT_EXTENSION,
        args: buildSchema(),
        async execute(args, toolCtx) {
            return sharedCtx.sessions.runExclusive(toolCtx.sessionID, async (state, sessionGuard) => {
                const ctx: ToolContext = { ...sharedCtx, state, sessionGuard }
            const input = args as CompressMessageToolArgs
            validateArgs(input)
            const callId =
                typeof (toolCtx as unknown as { callID?: unknown }).callID === "string"
                    ? (toolCtx as unknown as { callID: string }).callID
                    : undefined

            const { rawMessages, searchContext, signal } = await prepareSession(
                ctx,
                toolCtx,
                `Compress Message: ${input.topic}`,
            )
            const { plans, skippedIssues, skippedCount } = resolveMessages(
                input,
                searchContext,
                ctx.state,
                ctx.config,
            )

            if (plans.length === 0 && skippedCount > 0) {
                throw new Error(formatIssues(skippedIssues, skippedCount))
            }

            const notifications: NotificationEntry[] = []

            const preparedPlans: Array<{
                plan: (typeof plans)[number]
                summaryWithTools: string
                summaryTokens: number
            }> = []

            for (const plan of plans) {
                const summaryWithPromptInfo = appendProtectedPromptInfo(
                    plan.entry.summary,
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

                const nextBlockId = Number.isInteger(ctx.state.prune.messages.nextBlockId)
                    ? Math.max(1, ctx.state.prune.messages.nextBlockId)
                    : 1
                const summaryTokens = countTokens(
                    wrapCompressedSummary(nextBlockId + preparedPlans.length, summaryWithTools),
                )

                preparedPlans.push({
                    plan,
                    summaryWithTools,
                    summaryTokens,
                })
            }

            ctx.sessionGuard.assertActive()
            try {
                validateCompressionEffectiveness(
                    ctx.state,
                    ctx.config,
                    preparedPlans.map(({ plan, summaryTokens }) => ({
                        label: plan.entry.messageId,
                        selection: plan.selection,
                        summaryTokens,
                        consumedBlockIds: [],
                    })),
                    getContextLimitStatus(ctx.config, ctx.state, rawMessages),
                )
            } catch (error) {
                failCompression(ctx, error)
            }
            ctx.sessionGuard.assertActive()
            const runId = allocateRunId(ctx.state)

            for (const { plan, summaryWithTools, summaryTokens } of preparedPlans) {
                const blockId = allocateBlockId(ctx.state)
                const storedSummary = wrapCompressedSummary(blockId, summaryWithTools)

                applyCompressionState(
                    ctx.state,
                    {
                        topic: plan.entry.topic,
                        batchTopic: input.topic,
                        startId: plan.entry.messageId,
                        endId: plan.entry.messageId,
                        mode: "message",
                        runId,
                        compressMessageId: toolCtx.messageID,
                        compressCallId: callId,
                        summaryTokens,
                    },
                    plan.selection,
                    plan.anchorMessageId,
                    blockId,
                    storedSummary,
                    [],
                )

                notifications.push({
                    blockId,
                    runId,
                    summary: summaryWithTools,
                    summaryTokens,
                })
            }

            await finalizeSession(ctx, toolCtx, rawMessages, notifications, input.topic)

            return formatResult(plans.length, skippedIssues, skippedCount)
            })
        },
    })
}
