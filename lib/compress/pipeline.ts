import type { WithParts } from "../state"
import { ensureSessionInitialized, refreshManualMode } from "../state"
import { saveSessionState } from "../state/persistence"
import { assignMessageRefs } from "../message-ids"
import { isIgnoredUserMessage } from "../messages/query"
import { deduplicate, purgeErrors } from "../strategies"
import { getCurrentParams, getCurrentTokenUsage } from "../token-utils"
import { buildCompressChatNotification, sendCompressNotification } from "../ui/notification"
import type { ToolContext } from "./types"
import { buildSearchContext, fetchSessionMessages } from "./search"
import type { SearchContext } from "./types"
import { applyPendingCompressionDurations } from "./timing"
import {
    COMPRESSION_API_TIMEOUT_MS,
    COMPRESSION_NOTIFICATION_TIMEOUT_MS,
    runAbortable,
} from "./abort"

interface RunContext {
    ask(input: {
        permission: string
        patterns: string[]
        always: string[]
        metadata: Record<string, unknown>
    }): Promise<void>
    metadata(input: { title: string }): void
    sessionID: string
    abort?: AbortSignal
}

export interface NotificationEntry {
    blockId: number
    runId: number
    summary: string
    summaryTokens: number
}

export interface PreparedSession {
    rawMessages: WithParts[]
    searchContext: SearchContext
    signal: AbortSignal
}

export function failCompression(ctx: ToolContext, error: unknown): never {
    if (ctx.state.manualMode === "compress-pending") {
        ctx.state.manualMode = "active"
    }
    throw error
}

export async function prepareSession(
    ctx: ToolContext,
    toolCtx: RunContext,
    title: string,
): Promise<PreparedSession> {
    const signal = toolCtx.abort ?? new AbortController().signal
    await refreshManualMode(ctx.state, toolCtx.sessionID, ctx.logger, ctx.config.manualMode.enabled)

    if (ctx.state.manualMode && ctx.state.manualMode !== "compress-pending") {
        throw new Error(
            "Manual mode: compress blocked. Do not retry until `<compress triggered manually>` appears in user context.",
        )
    }

    await runAbortable(
        () =>
            toolCtx.ask({
                permission: "compress",
                patterns: ["*"],
                always: ["*"],
                metadata: {},
            }),
        signal,
        "Compression permission",
        ctx.config.compress.permission === "ask" ? undefined : COMPRESSION_API_TIMEOUT_MS,
    ).catch((error) => failCompression(ctx, error))

    toolCtx.metadata({ title })

    const cachedMessages = ctx.messageCache?.get(toolCtx.sessionID)
    if (ctx.messageCache && !cachedMessages) {
        failCompression(
            ctx,
            new Error("Compression context snapshot unavailable; retry on the next turn."),
        )
    }
    if (ctx.messageCache && ctx.state.sessionId !== toolCtx.sessionID) {
        failCompression(
            ctx,
            new Error("Compression session changed before execution; retry on the next turn."),
        )
    }
    const rawMessages =
        cachedMessages ??
        (await runAbortable(
            (requestSignal) => fetchSessionMessages(ctx.client, toolCtx.sessionID, requestSignal),
            signal,
            "Loading session messages for compression",
            COMPRESSION_API_TIMEOUT_MS,
        ).catch((error) => failCompression(ctx, error)))

    await runAbortable(
        (requestSignal) =>
            ensureSessionInitialized(
                ctx.client,
                ctx.state,
                toolCtx.sessionID,
                ctx.logger,
                rawMessages,
                ctx.config.manualMode.enabled,
                requestSignal,
            ),
        signal,
        "Initializing compression session",
        COMPRESSION_API_TIMEOUT_MS,
    ).catch((error) => failCompression(ctx, error))

    assignMessageRefs(ctx.state, rawMessages)

    deduplicate(ctx.state, ctx.logger, ctx.config, rawMessages)
    purgeErrors(ctx.state, ctx.logger, ctx.config, rawMessages)

    return {
        rawMessages,
        searchContext: buildSearchContext(ctx.state, rawMessages),
        signal,
    }
}

export async function finalizeSession(
    ctx: ToolContext,
    toolCtx: RunContext,
    rawMessages: WithParts[],
    entries: NotificationEntry[],
    batchTopic: string | undefined,
): Promise<void> {
    ctx.state.manualMode = ctx.state.manualMode ? "active" : false
    applyPendingCompressionDurations(ctx.state)
    await saveSessionState(ctx.state, ctx.logger)

    const params = getCurrentParams(ctx.state, rawMessages, ctx.logger)
    const contextTokensBefore = getCurrentTokenUsage(ctx.state, rawMessages)
    const sessionMessageIds = rawMessages
        .filter((msg) => !isIgnoredUserMessage(msg))
        .map((msg) => msg.info.id)

    if (ctx.config.pruneNotificationType === "chat") {
        if (ctx.config.pruneNotification !== "off" && entries.length > 0) {
            const pending = ctx.notificationQueue?.get(toolCtx.sessionID) ?? []
            pending.push({
                sessionId: toolCtx.sessionID,
                text: buildCompressChatNotification(ctx.state, entries, contextTokensBefore),
                params,
            })
            ctx.notificationQueue?.set(toolCtx.sessionID, pending)
        }
        return
    }

    try {
        const signal = toolCtx.abort ?? new AbortController().signal
        await runAbortable(
            (requestSignal) =>
                sendCompressNotification(
                    ctx.client,
                    ctx.logger,
                    ctx.config,
                    ctx.state,
                    toolCtx.sessionID,
                    entries,
                    batchTopic,
                    sessionMessageIds,
                    params,
                    contextTokensBefore,
                    requestSignal,
                ),
            signal,
            "Sending compression notification",
            COMPRESSION_NOTIFICATION_TIMEOUT_MS,
        )
    } catch (error: any) {
        ctx.logger.warn("Failed to send compression notification", {
            sessionId: toolCtx.sessionID,
            error: error?.message,
        })
    }
}
