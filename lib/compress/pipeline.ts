import type { WithParts } from "../state"
import { ensureSessionInitialized, refreshManualMode } from "../state"
import { saveSessionState } from "../state/persistence"
import { assignMessageRefs } from "../message-ids"
import { isIgnoredUserMessage } from "../messages/query"
import {
    contextObligatoryMessageIdsEqual,
    loadContextObligatoryMessageIds,
} from "../messages/context-obligatory"
import { compressPermission } from "../compress-permission"
import { deduplicate, purgeErrors } from "../strategies"
import { getCurrentParams, getCurrentTokenUsage } from "../token-utils"
import { sendCompressNotification } from "../ui/notification"
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
    pinnedMessageIds: ReadonlySet<string>
    signal: readonly AbortSignal[]
}

export function failCompression(ctx: ToolContext, error: unknown): never {
    if ((!ctx.sessionGuard || ctx.sessionGuard.isActive()) && ctx.state.manualMode === "compress-pending") {
        ctx.state.manualMode = "active"
    }
    throw error
}

export async function prepareSession(
    ctx: ToolContext,
    toolCtx: RunContext,
    title: string,
): Promise<PreparedSession> {
    ctx.sessionGuard?.assertActive()
    const signal = [toolCtx.abort, ctx.sessionGuard?.signal].filter(
        (entry): entry is AbortSignal => entry !== undefined,
    )
    const pinnedMessageIds = await runAbortable(
        (requestSignal) =>
            loadContextObligatoryMessageIds(ctx.client, toolCtx.sessionID, requestSignal),
        signal,
        "Loading pinned messages for compression",
        COMPRESSION_API_TIMEOUT_MS,
    )
    ctx.sessionGuard?.assertActive()

    await refreshManualMode(ctx.state, toolCtx.sessionID, ctx.logger, ctx.config.manualMode.enabled)
    ctx.sessionGuard?.assertActive()

    if (ctx.state.manualMode && ctx.state.manualMode !== "compress-pending") {
        throw new Error(
            "Manual mode: compress blocked. Do not retry until `<compress triggered manually>` appears in user context.",
        )
    }

    const permission = compressPermission(ctx.state, ctx.config)
    if (permission === "deny") {
        failCompression(ctx, new Error("Compression permission denied."))
    }
    if (permission === "ask") {
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
            COMPRESSION_API_TIMEOUT_MS,
        ).catch((error) => failCompression(ctx, error))
        ctx.sessionGuard?.assertActive()
    }

    ctx.sessionGuard?.assertActive()
    toolCtx.metadata({ title })

    const cachedMessages = ctx.messageCache?.get(toolCtx.sessionID)
    if (ctx.messageCache && !cachedMessages) {
        failCompression(
            ctx,
            new Error("Compression context snapshot unavailable; retry on the next turn."),
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
    ctx.sessionGuard?.assertActive()

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
                () => ctx.sessionGuard?.assertActive(),
                ctx.loadSessionState,
                ctx.saveSessionState,
            ),
        signal,
        "Initializing compression session",
        COMPRESSION_API_TIMEOUT_MS,
    ).catch((error) => failCompression(ctx, error))

    ctx.sessionGuard?.assertActive()
    assignMessageRefs(ctx.state, rawMessages)

    deduplicate(ctx.state, ctx.logger, ctx.config, rawMessages)
    purgeErrors(ctx.state, ctx.logger, ctx.config, rawMessages)

    return {
        rawMessages,
        searchContext: buildSearchContext(ctx.state, rawMessages, pinnedMessageIds),
        pinnedMessageIds,
        signal,
    }
}

export async function assertPinnedMessagesUnchanged(
    ctx: ToolContext,
    toolCtx: RunContext,
    prepared: PreparedSession,
): Promise<void> {
    const currentPinnedMessageIds = await runAbortable(
        (requestSignal) =>
            loadContextObligatoryMessageIds(ctx.client, toolCtx.sessionID, requestSignal),
        prepared.signal,
        "Revalidating pinned messages for compression",
        COMPRESSION_API_TIMEOUT_MS,
    ).catch((error) => failCompression(ctx, error))
    ctx.sessionGuard?.assertActive()

    if (!contextObligatoryMessageIdsEqual(prepared.pinnedMessageIds, currentPinnedMessageIds)) {
        failCompression(
            ctx,
            new Error("Pinned messages changed during compression; retry with the current context."),
        )
    }
}

export async function finalizeSession(
    ctx: ToolContext,
    toolCtx: RunContext,
    rawMessages: WithParts[],
    entries: NotificationEntry[],
    batchTopic: string | undefined,
): Promise<void> {
    ctx.sessionGuard?.assertActive()
    if (ctx.state.manualMode === "compress-pending") {
        ctx.state.manualMode = false
        await refreshManualMode(
            ctx.state,
            toolCtx.sessionID,
            ctx.logger,
            ctx.config.manualMode.enabled,
        )
        ctx.sessionGuard?.assertActive()
    }
    applyPendingCompressionDurations(ctx.state)
    ctx.sessionGuard?.assertActive()
    const persistSessionState = ctx.saveSessionState ?? saveSessionState
    await persistSessionState(
        ctx.state,
        ctx.logger,
        undefined,
        () => ctx.sessionGuard?.assertActive(),
        ctx.sessionGuard?.signal,
    )
    ctx.sessionGuard?.assertActive()

    if (ctx.config.pruneNotificationType === "chat") {
        return
    }

    const params = getCurrentParams(ctx.state, rawMessages, ctx.logger)
    const contextTokensBefore = getCurrentTokenUsage(ctx.state, rawMessages)
    const sessionMessageIds = rawMessages
        .filter((msg) => !isIgnoredUserMessage(msg))
        .map((msg) => msg.info.id)

    try {
        ctx.sessionGuard?.assertActive()
        const signal = [toolCtx.abort, ctx.sessionGuard?.signal].filter(
            (entry): entry is AbortSignal => entry !== undefined,
        )
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
        ctx.sessionGuard?.assertActive()
    } catch (error: any) {
        ctx.sessionGuard?.assertActive()
        ctx.logger.warn("Failed to send compression notification", {
            sessionId: toolCtx.sessionID,
            error: error?.message,
        })
    }
    ctx.sessionGuard?.assertActive()
}
