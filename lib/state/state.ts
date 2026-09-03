import type { SessionState, ToolParameterEntry, WithParts } from "./types"
import type { Logger } from "../logger"
import { applyPendingCompressionDurations } from "../compress/timing"
import { loadManualModeSetting, loadSessionState, saveSessionState } from "./persistence"
import {
    isSubAgentSession,
    findLastCompactionTimestamp,
    countTurns,
    resetOnCompaction,
    createPruneMessagesState,
    loadPruneMessagesState,
    loadPruneMap,
    collectTurnNudgeAnchors,
} from "./utils"
import { getLastUserMessage } from "../messages/query"
import type { SessionOperationGuard } from "./registry"

export const checkSession = async (
    client: any,
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
    manualModeDefault: boolean,
    sessionGuard?: SessionOperationGuard,
): Promise<void> => {
    const lastUserMessage = getLastUserMessage(messages)
    if (!lastUserMessage) {
        return
    }

    const lastSessionId = lastUserMessage.info.sessionID

    if (state.sessionId === null || state.sessionId !== lastSessionId) {
        logger.info(`Session changed: ${state.sessionId} -> ${lastSessionId}`)
        try {
            await ensureSessionInitialized(
                client,
                state,
                lastSessionId,
                logger,
                messages,
                manualModeDefault,
                sessionGuard?.signal,
                () => sessionGuard?.assertActive(),
            )
        } catch (err: any) {
            sessionGuard?.assertActive()
            logger.error("Failed to initialize session state", { error: err.message })
        }
    }

    sessionGuard?.assertActive()
    const lastCompactionTimestamp = findLastCompactionTimestamp(messages)
    if (lastCompactionTimestamp > state.lastCompaction) {
        state.lastCompaction = lastCompactionTimestamp
        resetOnCompaction(state)
        logger.info("Detected compaction - reset stale state", {
            timestamp: lastCompactionTimestamp,
        })

        await saveSessionState(
            state,
            logger,
            undefined,
            () => sessionGuard?.assertActive(),
            sessionGuard?.signal,
        ).catch((error) => {
            sessionGuard?.assertActive()
            logger.warn("Failed to persist state reset after compaction", {
                error: error instanceof Error ? error.message : String(error),
            })
        })
    }

    state.currentTurn = countTurns(state, messages)
    await refreshManualMode(state, lastSessionId, logger, manualModeDefault)
}

export function createSessionState(): SessionState {
    return {
        sessionId: null,
        isSubAgent: false,
        manualMode: false,
        compressPermission: undefined,
        pendingManualTrigger: null,
        prune: {
            tools: new Map<string, number>(),
            messages: createPruneMessagesState(),
        },
        nudges: {
            contextLimitAnchors: new Set<string>(),
            turnNudgeAnchors: new Set<string>(),
            iterationNudgeAnchors: new Set<string>(),
        },
        stats: {
            pruneTokenCounter: 0,
            totalPruneTokens: 0,
        },
        compressionTiming: {
            startsByCallId: new Map<string, number>(),
            pendingByCallId: new Map(),
        },
        toolParameters: new Map<string, ToolParameterEntry>(),
        subAgentResultCache: new Map<string, string>(),
        toolIdList: [],
        messageIds: {
            byRawId: new Map<string, string>(),
            byRef: new Map<string, string>(),
            nextRef: 1,
        },
        lastCompaction: 0,
        currentTurn: 0,
        modelContextLimit: undefined,
        systemPromptTokens: undefined,
    }
}

export function resetSessionState(state: SessionState, clearCompressionTiming = false): void {
    state.sessionId = null
    state.isSubAgent = false
    state.manualMode = false
    state.compressPermission = undefined
    state.pendingManualTrigger = null
    state.prune = {
        tools: new Map<string, number>(),
        messages: createPruneMessagesState(),
    }
    state.nudges = {
        contextLimitAnchors: new Set<string>(),
        turnNudgeAnchors: new Set<string>(),
        iterationNudgeAnchors: new Set<string>(),
    }
    state.stats = {
        pruneTokenCounter: 0,
        totalPruneTokens: 0,
    }
    if (clearCompressionTiming) {
        state.compressionTiming.startsByCallId.clear()
        state.compressionTiming.pendingByCallId.clear()
    }
    state.toolParameters.clear()
    state.subAgentResultCache.clear()
    state.toolIdList = []
    state.messageIds = {
        byRawId: new Map<string, string>(),
        byRef: new Map<string, string>(),
        nextRef: 1,
    }
    state.lastCompaction = 0
    state.currentTurn = 0
    state.modelContextLimit = undefined
    state.systemPromptTokens = undefined
}

export async function ensureSessionInitialized(
    client: any,
    state: SessionState,
    sessionId: string,
    logger: Logger,
    messages: WithParts[],
    manualModeEnabled: boolean,
    signal?: AbortSignal,
    assertActive?: () => void,
    loadPersistedState: typeof loadSessionState = loadSessionState,
    persistSessionState: typeof saveSessionState = saveSessionState,
): Promise<void> {
    assertActive?.()
    if (state.sessionId === sessionId) {
        return
    }

    // logger.info("session ID = " + sessionId)
    // logger.info("Initializing session state", { sessionId: sessionId })

    const isSubAgent = await isSubAgentSession(client, sessionId, signal)
    assertActive?.()

    resetSessionState(state)
    state.manualMode = manualModeEnabled ? "active" : false
    state.sessionId = sessionId
    state.isSubAgent = isSubAgent
    // logger.info("isSubAgent = " + isSubAgent)

    state.lastCompaction = findLastCompactionTimestamp(messages)
    state.currentTurn = countTurns(state, messages)
    state.nudges.turnNudgeAnchors = collectTurnNudgeAnchors(messages)

    const persisted = await loadPersistedState(sessionId, logger, signal)
    assertActive?.()
    if (persisted === null) {
        return
    }

    if (typeof persisted.manualMode === "boolean") {
        state.manualMode = persisted.manualMode ? "active" : false
    }

    state.prune.tools = loadPruneMap(persisted.prune.tools)
    state.prune.messages = loadPruneMessagesState(persisted.prune.messages)
    state.nudges.contextLimitAnchors = new Set<string>(persisted.nudges.contextLimitAnchors || [])
    state.nudges.turnNudgeAnchors = new Set<string>([
        ...state.nudges.turnNudgeAnchors,
        ...(persisted.nudges.turnNudgeAnchors || []),
    ])
    state.nudges.iterationNudgeAnchors = new Set<string>(
        persisted.nudges.iterationNudgeAnchors || [],
    )
    state.stats = {
        pruneTokenCounter: persisted.stats?.pruneTokenCounter || 0,
        totalPruneTokens: persisted.stats?.totalPruneTokens || 0,
    }

    const applied = applyPendingCompressionDurations(state)
    if (applied > 0) {
        await persistSessionState(state, logger, undefined, assertActive, signal)
        assertActive?.()
    }
}

export async function refreshManualMode(
    state: SessionState,
    sessionId: string,
    logger: Logger,
    manualModeDefault: boolean,
): Promise<void> {
    if (state.manualMode === "compress-pending") {
        return
    }

    const persisted = await loadManualModeSetting(sessionId, logger)
    const enabled = persisted ?? manualModeDefault
    state.manualMode = enabled ? "active" : false
}
