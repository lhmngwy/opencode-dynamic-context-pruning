/**
 * State persistence module for DCP plugin.
 * Persists pruned tool IDs across sessions so they survive OpenCode restarts.
 * Storage location: ~/.local/share/opencode/storage/plugin/dcp/{sessionId}.json
 */

import * as fs from "fs/promises"
import { existsSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import type { CompressionBlock, PrunedMessageEntry, SessionState, SessionStats } from "./types"
import type { Logger } from "../logger"
import { serializePruneMessagesState } from "./utils"

/** Prune state as stored on disk */
export interface PersistedPruneMessagesState {
    byMessageId: Record<string, PrunedMessageEntry>
    blocksById: Record<string, CompressionBlock>
    activeBlockIds: number[]
    activeByAnchorMessageId: Record<string, number>
    nextBlockId: number
    nextRunId: number
}

export interface PersistedPrune {
    tools?: Record<string, number>
    messages?: PersistedPruneMessagesState
}

export interface PersistedNudges {
    contextLimitAnchors: string[]
    contextLimitCooldown?: number
    contextLimitLastAssistantId?: string | null
    turnNudgeAnchors?: string[]
    iterationNudgeAnchors?: string[]
}

export interface PersistedSessionState {
    sessionName?: string
    manualMode?: boolean
    prune: PersistedPrune
    nudges: PersistedNudges
    stats: SessionStats
    lastUpdated: string
}

export class SessionStateDeletedError extends Error {
    constructor(sessionId: string) {
        super(`Session state ${sessionId} has been durably deleted.`)
        this.name = "SessionStateDeletedError"
    }
}

export interface SessionDeletionOperations {
    markerExists?: (path: string) => boolean
    writeMarker?: (path: string, content: string) => Promise<void>
    renameMarker?: (temporaryPath: string, markerPath: string) => Promise<void>
    retryDelay?: (attempt: number) => Promise<void>
    markerAttempts?: number
}

let deletionMarkerAttemptId = 0

function getStorageDir(): string {
    return join(
        process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
        "opencode",
        "storage",
        "plugin",
        "dcp",
    )
}

async function ensureStorageDir(): Promise<void> {
    const storageDir = getStorageDir()
    if (!existsSync(storageDir)) {
        await fs.mkdir(storageDir, { recursive: true })
    }
}

function getSessionFilePath(sessionId: string): string {
    return join(getStorageDir(), `${sessionId}.json`)
}

function getSessionDeletionMarkerPath(sessionId: string): string {
    return `${getSessionFilePath(sessionId)}.deleted`
}

function isDeletedSession(sessionId: string): boolean {
    return existsSync(getSessionDeletionMarkerPath(sessionId))
}

async function writePersistedSessionState(
    sessionId: string,
    state: PersistedSessionState,
    logger: Logger,
    assertActive?: () => void,
    signal?: AbortSignal,
): Promise<void> {
    await ensureStorageDir()
    assertActive?.()
    if (isDeletedSession(sessionId)) {
        throw new SessionStateDeletedError(sessionId)
    }

    const filePath = getSessionFilePath(sessionId)
    const temporaryFilePath = `${filePath}.tmp`
    const content = JSON.stringify(state, null, 2)
    try {
        await fs.writeFile(temporaryFilePath, content, {
            encoding: "utf-8",
            signal,
        })
        assertActive?.()
        if (isDeletedSession(sessionId)) {
            throw new SessionStateDeletedError(sessionId)
        }
        await fs.rename(temporaryFilePath, filePath)
        assertActive?.()
        if (isDeletedSession(sessionId)) {
            await fs.rm(filePath, { force: true })
            throw new SessionStateDeletedError(sessionId)
        }
    } catch (error) {
        await fs.rm(temporaryFilePath, { force: true })
        try {
            assertActive?.()
        } catch (disposedError) {
            await fs.rm(filePath, { force: true })
            throw disposedError
        }
        throw error
    }

    logger.info("Saved session state to disk", {
        sessionId,
        totalTokensSaved: state.stats.totalPruneTokens,
    })
}

export async function saveSessionState(
    sessionState: SessionState,
    logger: Logger,
    sessionName?: string,
    assertActive?: () => void,
    signal?: AbortSignal,
): Promise<void> {
    try {
        if (!sessionState.sessionId) {
            return
        }

        const state: PersistedSessionState = {
            sessionName: sessionName,
            manualMode: !!sessionState.manualMode,
            prune: {
                tools: Object.fromEntries(sessionState.prune.tools),
                messages: serializePruneMessagesState(sessionState.prune.messages),
            },
            nudges: {
                contextLimitAnchors: Array.from(sessionState.nudges.contextLimitAnchors),
                contextLimitCooldown: sessionState.nudges.contextLimitCooldown,
                contextLimitLastAssistantId: sessionState.nudges.contextLimitLastAssistantId,
                turnNudgeAnchors: Array.from(sessionState.nudges.turnNudgeAnchors),
                iterationNudgeAnchors: Array.from(sessionState.nudges.iterationNudgeAnchors),
            },
            stats: { ...sessionState.stats },
            lastUpdated: new Date().toISOString(),
        }

        await writePersistedSessionState(
            sessionState.sessionId,
            state,
            logger,
            assertActive,
            signal,
        )
    } catch (error: any) {
        logger.error("Failed to save session state", {
            sessionId: sessionState.sessionId,
            error: error?.message,
        })
        assertActive?.()
        if (error instanceof SessionStateDeletedError) {
            throw error
        }
    }
}

export async function deleteSessionState(
    sessionId: string,
    logger: Logger,
    removeFile: (path: string) => Promise<void> = (path) => fs.rm(path, { force: true }),
    operations: SessionDeletionOperations = {},
): Promise<{ removed: boolean }> {
    const filePath = getSessionFilePath(sessionId)
    const markerPath = getSessionDeletionMarkerPath(sessionId)
    const markerExists = operations.markerExists ?? existsSync
    const writeMarker =
        operations.writeMarker ??
        ((path: string, content: string) => fs.writeFile(path, content, "utf-8"))
    const renameMarker = operations.renameMarker ?? ((temporaryPath, path) => fs.rename(temporaryPath, path))
    const retryDelay =
        operations.retryDelay ??
        ((attempt: number) => new Promise<void>((resolve) => setTimeout(resolve, attempt * 10)))
    const markerAttempts = Math.max(1, operations.markerAttempts ?? 3)
    let markerError: unknown

    for (let attempt = 1; attempt <= markerAttempts && !markerExists(markerPath); attempt += 1) {
        const temporaryMarkerPath = `${markerPath}.${process.pid}.${++deletionMarkerAttemptId}.tmp`
        try {
            await ensureStorageDir()
            if (markerExists(markerPath)) {
                break
            }
            await writeMarker(temporaryMarkerPath, "deleted\n")
            if (markerExists(markerPath)) {
                await fs.rm(temporaryMarkerPath, { force: true })
                break
            }
            await renameMarker(temporaryMarkerPath, markerPath)
        } catch (error: any) {
            markerError = error
            await fs.rm(temporaryMarkerPath, { force: true }).catch(() => {})
            if (markerExists(markerPath)) {
                break
            }
            logger.warn("Retrying session deletion fence", {
                sessionId,
                attempt,
                error: error?.message,
            })
            if (attempt < markerAttempts) {
                await retryDelay(attempt)
            }
        }
    }

    const removals = await Promise.allSettled([
        removeFile(filePath),
        removeFile(`${filePath}.tmp`),
    ])
    const failures = removals.filter((result) => result.status === "rejected")
    if (!markerExists(markerPath)) {
        logger.error("Failed to persist session deletion fence", {
            sessionId,
            error: markerError instanceof Error ? markerError.message : String(markerError),
            cleanupFailures: failures.map((result) =>
                result.status === "rejected" && result.reason instanceof Error
                    ? result.reason.message
                    : String(result),
            ),
        })
        throw new AggregateError(
            [markerError, ...failures.map((result) => result.status === "rejected" && result.reason)],
            `Failed to durably delete session state ${sessionId}`,
        )
    }

    if (failures.length === 0) {
        logger.info("Deleted session state from disk", { sessionId })
        return { removed: true }
    }

    logger.warn("Session state deletion remains fenced but physical cleanup is incomplete", {
        sessionId,
        failures: failures.map((result) =>
            result.status === "rejected" && result.reason instanceof Error
                ? result.reason.message
                : String(result),
        ),
    })
    return { removed: false }
}

export async function loadSessionState(
    sessionId: string,
    logger: Logger,
    signal?: AbortSignal,
): Promise<PersistedSessionState | null> {
    try {
        const filePath = getSessionFilePath(sessionId)

        if (isDeletedSession(sessionId) || !existsSync(filePath)) {
            return null
        }

        const content = await fs.readFile(filePath, { encoding: "utf-8", signal })
        if (isDeletedSession(sessionId)) {
            return null
        }
        const state = JSON.parse(content) as PersistedSessionState

        const hasPruneTools = state?.prune?.tools && typeof state.prune.tools === "object"
        const hasPruneMessages = state?.prune?.messages && typeof state.prune.messages === "object"
        const hasNudgeFormat = state?.nudges && typeof state.nudges === "object"
        if (
            !state ||
            !state.prune ||
            !hasPruneTools ||
            !hasPruneMessages ||
            !state.stats ||
            !hasNudgeFormat
        ) {
            logger.warn("Invalid session state file, ignoring", {
                sessionId: sessionId,
            })
            return null
        }

        const rawContextLimitAnchors = Array.isArray(state.nudges.contextLimitAnchors)
            ? state.nudges.contextLimitAnchors
            : []
        const validAnchors = rawContextLimitAnchors.filter(
            (entry): entry is string => typeof entry === "string",
        )
        const dedupedAnchors = [...new Set(validAnchors)]
        if (validAnchors.length !== rawContextLimitAnchors.length) {
            logger.warn("Filtered out malformed contextLimitAnchors entries", {
                sessionId: sessionId,
                original: rawContextLimitAnchors.length,
                valid: validAnchors.length,
            })
        }
        state.nudges.contextLimitAnchors = dedupedAnchors
        state.nudges.contextLimitCooldown =
            typeof state.nudges.contextLimitCooldown === "number" &&
            Number.isFinite(state.nudges.contextLimitCooldown)
                ? Math.max(0, Math.floor(state.nudges.contextLimitCooldown))
                : 0
        state.nudges.contextLimitLastAssistantId =
            typeof state.nudges.contextLimitLastAssistantId === "string"
                ? state.nudges.contextLimitLastAssistantId
                : null

        const rawTurnNudgeAnchors = Array.isArray(state.nudges.turnNudgeAnchors)
            ? state.nudges.turnNudgeAnchors
            : []
        const validSoftAnchors = rawTurnNudgeAnchors.filter(
            (entry): entry is string => typeof entry === "string",
        )
        const dedupedSoftAnchors = [...new Set(validSoftAnchors)]
        if (validSoftAnchors.length !== rawTurnNudgeAnchors.length) {
            logger.warn("Filtered out malformed turnNudgeAnchors entries", {
                sessionId: sessionId,
                original: rawTurnNudgeAnchors.length,
                valid: validSoftAnchors.length,
            })
        }
        state.nudges.turnNudgeAnchors = dedupedSoftAnchors

        const rawIterationNudgeAnchors = Array.isArray(state.nudges.iterationNudgeAnchors)
            ? state.nudges.iterationNudgeAnchors
            : []
        const validIterationAnchors = rawIterationNudgeAnchors.filter(
            (entry): entry is string => typeof entry === "string",
        )
        const dedupedIterationAnchors = [...new Set(validIterationAnchors)]
        if (validIterationAnchors.length !== rawIterationNudgeAnchors.length) {
            logger.warn("Filtered out malformed iterationNudgeAnchors entries", {
                sessionId: sessionId,
                original: rawIterationNudgeAnchors.length,
                valid: validIterationAnchors.length,
            })
        }
        state.nudges.iterationNudgeAnchors = dedupedIterationAnchors

        logger.info("Loaded session state from disk", {
            sessionId: sessionId,
        })

        return state
    } catch (error: any) {
        logger.warn("Failed to load session state", {
            sessionId: sessionId,
            error: error?.message,
        })
        return null
    }
}

function emptyPersistedState(manualMode: boolean): PersistedSessionState {
    return {
        manualMode,
        prune: {
            tools: {},
            messages: {
                byMessageId: {},
                blocksById: {},
                activeBlockIds: [],
                activeByAnchorMessageId: {},
                nextBlockId: 1,
                nextRunId: 1,
            },
        },
        nudges: {
            contextLimitAnchors: [],
            contextLimitCooldown: 0,
            contextLimitLastAssistantId: null,
            turnNudgeAnchors: [],
            iterationNudgeAnchors: [],
        },
        stats: {
            pruneTokenCounter: 0,
            totalPruneTokens: 0,
        },
        lastUpdated: new Date().toISOString(),
    }
}

export async function loadManualModeSetting(
    sessionId: string,
    logger: Logger,
): Promise<boolean | undefined> {
    const state = await loadSessionState(sessionId, logger)
    return typeof state?.manualMode === "boolean" ? state.manualMode : undefined
}

export async function saveManualModeSetting(
    sessionId: string,
    manualMode: boolean,
    logger: Logger,
): Promise<void> {
    const existing = await loadSessionState(sessionId, logger)
    const state = existing ?? emptyPersistedState(manualMode)
    state.manualMode = manualMode
    state.lastUpdated = new Date().toISOString()
    await writePersistedSessionState(sessionId, state, logger)
}

export interface AggregatedStats {
    totalTokens: number
    totalTools: number
    totalMessages: number
    sessionCount: number
}

export async function loadAllSessionStats(logger: Logger): Promise<AggregatedStats> {
    const result: AggregatedStats = {
        totalTokens: 0,
        totalTools: 0,
        totalMessages: 0,
        sessionCount: 0,
    }

    try {
        const storageDir = getStorageDir()
        if (!existsSync(storageDir)) {
            return result
        }

        const files = await fs.readdir(storageDir)
        const jsonFiles = files.filter(
            (f) => f.endsWith(".json") && !existsSync(join(storageDir, `${f}.deleted`)),
        )

        for (const file of jsonFiles) {
            try {
                const filePath = join(storageDir, file)
                const content = await fs.readFile(filePath, "utf-8")
                const state = JSON.parse(content) as PersistedSessionState

                if (state?.stats?.totalPruneTokens && state?.prune) {
                    result.totalTokens += state.stats.totalPruneTokens
                    result.totalTools += state.prune.tools
                        ? Object.keys(state.prune.tools).length
                        : 0
                    result.totalMessages += state.prune.messages?.byMessageId
                        ? Object.keys(state.prune.messages.byMessageId).length
                        : 0
                    result.sessionCount++
                }
            } catch {
                // Skip invalid files
            }
        }

        logger.debug("Loaded all-time stats", result)
    } catch (error: any) {
        logger.warn("Failed to load all-time stats", { error: error?.message })
    }

    return result
}
