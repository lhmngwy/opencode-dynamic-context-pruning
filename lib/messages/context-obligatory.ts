const OPENCHAMBER_METADATA_KEY = "openchamber"
const PINNED_MESSAGES_KEY = "context_obligatory_messages"

interface SessionMetadataResponse {
    metadata?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseContextObligatoryMessageIds(session: unknown): Set<string> {
    if (!isRecord(session) || !isRecord(session.metadata)) {
        return new Set()
    }

    const openchamber = session.metadata[OPENCHAMBER_METADATA_KEY]
    if (!isRecord(openchamber)) {
        return new Set()
    }

    const entries = openchamber[PINNED_MESSAGES_KEY]
    if (!Array.isArray(entries)) {
        return new Set()
    }

    const ids = new Set<string>()
    for (const entry of entries) {
        if (!isRecord(entry)) {
            continue
        }
        if (
            typeof entry.id !== "string" ||
            entry.id.length === 0 ||
            typeof entry.createdAt !== "number" ||
            !Number.isFinite(entry.createdAt) ||
            (entry.role !== "user" && entry.role !== "assistant")
        ) {
            continue
        }
        ids.add(entry.id)
    }

    return ids
}

export async function loadContextObligatoryMessageIds(
    client: any,
    sessionId: string,
    signal?: AbortSignal,
): Promise<Set<string>> {
    const response = await client.session.get({ path: { id: sessionId }, signal })
    if (!response || response.error || response.data === undefined) {
        throw new Error(`Unable to load pinned-message metadata for session ${sessionId}`)
    }
    const session = response.data as SessionMetadataResponse
    return parseContextObligatoryMessageIds(session)
}

export function contextObligatoryMessageIdsEqual(
    left: ReadonlySet<string>,
    right: ReadonlySet<string>,
): boolean {
    if (left.size !== right.size) {
        return false
    }
    for (const id of left) {
        if (!right.has(id)) {
            return false
        }
    }
    return true
}
