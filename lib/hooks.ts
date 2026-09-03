import {
    createSessionState,
    SessionDisposedError,
    deleteSessionState,
    type SessionState,
    type SessionStateRegistry,
    type WithParts,
} from "./state"
import type { Logger } from "./logger"
import type { PluginConfig } from "./config"
import { assignMessageRefs } from "./message-ids"
import {
    buildPriorityMap,
    buildToolIdList,
    injectCompressNudges,
    injectExtendedSubAgentResults,
    injectMessageIds,
    prune,
    stripHallucinations,
    stripHallucinationsFromString,
    stripStaleMetadata,
    syncCompressionBlocks,
} from "./messages"
import { renderSystemPrompt, type PromptStore } from "./prompts"
import { buildProtectedToolsExtension } from "./prompts/extensions/system"
import {
    applyPendingCompressionDurations,
    buildCompressionTimingKey,
    consumeCompressionStart,
    resolveCompressionDuration,
} from "./compress/timing"
import { filterMessages, filterMessagesInPlace } from "./messages/shape"
import {
    applyPendingManualTrigger,
    handleContextCommand,
    handleDecompressCommand,
    handleHelpCommand,
    handleManualToggleCommand,
    handleManualTriggerCommand,
    handleRecompressCommand,
    handleStatsCommand,
    handleSweepCommand,
} from "./commands"
import { type HostPermissionSnapshot } from "./host-permissions"
import { compressPermission, syncCompressPermissionState } from "./compress-permission"
import { checkSession, ensureSessionInitialized, saveSessionState, syncToolCache } from "./state"
import { cacheSystemPromptTokens } from "./ui/utils"

const INTERNAL_AGENT_SIGNATURES = [
    "You are a title generator",
    "You are a helpful AI assistant tasked with summarizing conversations",
    "You are an anchored context summarization assistant for coding sessions",
    "Summarize what was done in this conversation",
]

function isInternalAgentCall(systemPrompts: string[]): boolean {
    const primaryPrompt = systemPrompts[0]
    if (typeof primaryPrompt !== "string" || primaryPrompt.length === 0) {
        return false
    }

    return INTERNAL_AGENT_SIGNATURES.some((signature) => primaryPrompt.includes(signature))
}

export function createSystemPromptHandler(
    sessions: SessionStateRegistry,
    logger: Logger,
    config: PluginConfig,
    prompts: PromptStore,
) {
    return async (
        input: { sessionID?: string; model: { limit: { context: number } } },
        output: { system: string[] },
    ) => {
        const applyPrompt = async (state: SessionState) => {
            if (input.model?.limit?.context) {
                state.modelContextLimit = input.model.limit.context
                logger.debug("Cached model context limit", { limit: state.modelContextLimit })
            }

            if (state.isSubAgent && !config.experimental.allowSubAgents) {
                return
            }

            if (isInternalAgentCall(output.system)) {
                logger.info("Skipping DCP system prompt injection for internal agent")
                return
            }

            const effectivePermission = input.sessionID
                ? compressPermission(state, config)
                : config.compress.permission

            if (effectivePermission === "deny") {
                return
            }

            prompts.reload()
            const runtimePrompts = prompts.getRuntimePrompts()
            const newPrompt = renderSystemPrompt(
                runtimePrompts,
                buildProtectedToolsExtension(config.compress.protectedTools),
                !!state.manualMode,
                state.isSubAgent && config.experimental.allowSubAgents,
            )
            if (output.system.length > 0) {
                output.system[output.system.length - 1] += "\n\n" + newPrompt
            } else {
                output.system.push(newPrompt)
            }
        }

        if (input.sessionID) {
            await sessions.runExclusive(input.sessionID, applyPrompt)
        } else {
            await applyPrompt(createSessionState())
        }
    }
}

export function createChatMessageTransformHandler(
    client: any,
    sessions: SessionStateRegistry,
    logger: Logger,
    config: PluginConfig,
    prompts: PromptStore,
    hostPermissions: HostPermissionSnapshot,
    messageCache?: Map<string, WithParts[]>,
) {
    return async (input: {}, output: { messages: WithParts[] }) => {
        const receivedMessages = Array.isArray(output.messages) ? output.messages.length : 0
        const messages = filterMessagesInPlace(output.messages)
        if (messages.length !== receivedMessages) {
            logger.warn("Skipping messages with unexpected shape during chat transform", {
                received: receivedMessages,
                usable: messages.length,
            })
        }

        const messageSessionId = messages[0]?.info.sessionID
        if (
            typeof messageSessionId !== "string" ||
            !messages.every((message) => message.info.sessionID === messageSessionId)
        ) {
            stripHallucinations(output.messages)
            return
        }

        await sessions.runExclusive(messageSessionId, async (state, guard) => {
            await checkSession(client, state, logger, output.messages, config.manualMode.enabled, guard)

        syncCompressPermissionState(state, config, hostPermissions, output.messages)

        if (state.isSubAgent && !config.experimental.allowSubAgents) {
            return
        }

        stripHallucinations(output.messages)
        cacheSystemPromptTokens(state, output.messages)
        assignMessageRefs(state, output.messages)
        syncCompressionBlocks(state, logger, output.messages)
        syncToolCache(state, config, logger, output.messages)
        buildToolIdList(state, output.messages)
        if (messageCache) {
            messageCache.delete(messageSessionId)
            messageCache.set(messageSessionId, structuredClone(output.messages))
        }
        prune(state, logger, config, output.messages)
        await injectExtendedSubAgentResults(
            client,
            state,
            logger,
            output.messages,
            config.experimental.allowSubAgents,
        )
        const compressionPriorities = buildPriorityMap(config, state, output.messages)
        prompts.reload()
        await injectCompressNudges(
            state,
            config,
            logger,
            output.messages,
            prompts.getRuntimePrompts(),
            compressionPriorities,
        )
        injectMessageIds(state, config, output.messages, compressionPriorities)
        applyPendingManualTrigger(state, output.messages, logger)
        stripStaleMetadata(output.messages)

        if (state.sessionId) {
            await logger.saveContext(state.sessionId, output.messages)
        }
        })
    }
}

export function createCommandExecuteHandler(
    client: any,
    sessions: SessionStateRegistry,
    logger: Logger,
    config: PluginConfig,
    workingDirectory: string,
    hostPermissions: HostPermissionSnapshot,
) {
    return async (
        input: { command: string; sessionID: string; arguments: string },
        output: { parts: any[] },
    ) => {
        if (!config.commands.enabled) {
            return
        }

        if (input.command === "dcp" || input.command === "dcp-compress") {
            return sessions.runExclusive(input.sessionID, async (state, guard) => {
            const messagesResponse = await client.session.messages({
                path: { id: input.sessionID },
            })
            const messages = filterMessages(messagesResponse.data || messagesResponse)

            await ensureSessionInitialized(
                client,
                state,
                input.sessionID,
                logger,
                messages,
                config.manualMode.enabled,
                guard.signal,
                () => guard.assertActive(),
            )

            syncCompressPermissionState(state, config, hostPermissions, messages)

            const effectivePermission = compressPermission(state, config)
            if (effectivePermission === "deny") {
                return
            }

            const args = (input.arguments || "").trim().split(/\s+/).filter(Boolean)
            const isCompressCommand = input.command === "dcp-compress"
            const subcommand = isCompressCommand ? "compress" : args[0]?.toLowerCase() || ""
            const subArgs = isCompressCommand ? args : args.slice(1)

            const commandCtx = {
                client,
                state,
                config,
                logger,
                sessionId: input.sessionID,
                messages,
            }

            if (subcommand === "context") {
                await handleContextCommand(commandCtx)
                return
            }

            if (subcommand === "stats") {
                await handleStatsCommand(commandCtx)
                return
            }

            if (subcommand === "sweep") {
                await handleSweepCommand({
                    ...commandCtx,
                    args: subArgs,
                    workingDirectory,
                })
                return
            }

            if (subcommand === "manual") {
                await handleManualToggleCommand(commandCtx, subArgs[0]?.toLowerCase())
                return
            }

            if (subcommand === "compress") {
                const userFocus = subArgs.join(" ").trim()
                const prompt = await handleManualTriggerCommand(commandCtx, "compress", userFocus)
                if (!prompt) {
                    throw new Error("__DCP_MANUAL_TRIGGER_BLOCKED__")
                }

                state.manualMode = "compress-pending"
                state.pendingManualTrigger = {
                    sessionId: input.sessionID,
                    prompt,
                }
                const rawArgs = (input.arguments || "").trim()
                output.parts.length = 0
                output.parts.push({
                    type: "text",
                    text: isCompressCommand
                        ? rawArgs
                            ? `/dcp-compress ${rawArgs}`
                            : "/dcp-compress"
                        : rawArgs
                          ? `/dcp ${rawArgs}`
                          : `/dcp ${subcommand}`,
                })
                return
            }

            if (subcommand === "decompress") {
                await handleDecompressCommand({
                    ...commandCtx,
                    args: subArgs,
                })
                return
            }

            if (subcommand === "recompress") {
                await handleRecompressCommand({
                    ...commandCtx,
                    args: subArgs,
                })
                return
            }

            await handleHelpCommand(commandCtx)
            return
            })
        }
    }
}

export function createTextCompleteHandler() {
    return async (
        _input: { sessionID: string; messageID: string; partID: string },
        output: { text: string },
    ) => {
        output.text = stripHallucinationsFromString(output.text)
    }
}

export function createEventHandler(
    sessions: SessionStateRegistry,
    logger: Logger,
    messageCache?: Map<string, WithParts[]>,
    persistSessionState: typeof saveSessionState = saveSessionState,
) {
    return async (input: { event: any }) => {
        const eventType = input.event?.type
        const sessionId =
            input.event?.properties?.sessionID ??
            input.event?.properties?.part?.sessionID ??
            (eventType === "session.deleted" ? input.event?.properties?.info?.id : undefined)
        const reportedStatus = input.event?.properties?.status?.type
        const isIdle =
            eventType === "session.idle" ||
            (eventType === "session.status" && reportedStatus === "idle")
        if (isIdle && typeof sessionId === "string") {
            messageCache?.delete(sessionId)
        }

        if (eventType === "session.deleted" && typeof sessionId === "string") {
            messageCache?.delete(sessionId)
            await sessions.dispose(sessionId, () => deleteSessionState(sessionId, logger))
            return
        }

        const eventTime =
            typeof input.event?.time === "number" && Number.isFinite(input.event.time)
                ? input.event.time
                : typeof input.event?.properties?.time === "number" &&
                    Number.isFinite(input.event.properties.time)
                  ? input.event.properties.time
                  : undefined

        if (input.event.type !== "message.part.updated") {
            return
        }

        if (typeof sessionId !== "string") {
            return
        }

        try {
            await sessions.runExclusive(sessionId, async (state, guard) => {
        guard.assertActive()

        const part = input.event.properties?.part
        if (part?.type !== "tool" || part.tool !== "compress") {
            return
        }

        if (part.state.status === "pending") {
            if (typeof part.callID !== "string" || typeof part.messageID !== "string") {
                return
            }

            const startedAt = eventTime ?? Date.now()
            const key = buildCompressionTimingKey(part.messageID, part.callID)
            if (state.compressionTiming.startsByCallId.has(key)) {
                return
            }
            state.compressionTiming.startsByCallId.set(key, startedAt)
            guard.assertActive()
            logger.debug("Recorded compression start", {
                messageID: part.messageID,
                callID: part.callID,
                startedAt,
            })
            return
        }

        if (part.state.status === "completed") {
            if (typeof part.callID !== "string" || typeof part.messageID !== "string") {
                return
            }

            const key = buildCompressionTimingKey(part.messageID, part.callID)
            const start = consumeCompressionStart(state, part.messageID, part.callID)
            const durationMs = resolveCompressionDuration(start, eventTime, part.state.time)
            if (typeof durationMs !== "number") {
                return
            }

            state.compressionTiming.pendingByCallId.set(key, {
                messageId: part.messageID,
                callId: part.callID,
                durationMs,
            })

            guard.assertActive()
            const updates = applyPendingCompressionDurations(state)
            if (updates === 0) {
                return
            }

            await persistSessionState(
                state,
                logger,
                undefined,
                () => guard.assertActive(),
                guard.signal,
            )
            guard.assertActive()

            logger.info("Attached compression time to blocks", {
                messageID: part.messageID,
                callID: part.callID,
                blocks: updates,
                durationMs,
            })
            return
        }

        if (part.state.status === "running") {
            return
        }

        if (typeof part.callID === "string" && typeof part.messageID === "string") {
            state.compressionTiming.startsByCallId.delete(
                buildCompressionTimingKey(part.messageID, part.callID),
            )
        }
            })
        } catch (error) {
            if (error instanceof SessionDisposedError) {
                return
            }
            throw error
        }
    }
}
