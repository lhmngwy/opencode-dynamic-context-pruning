export const COMPRESSION_API_TIMEOUT_MS = 30_000
export const COMPRESSION_NOTIFICATION_TIMEOUT_MS = 5_000

function abortError(reason: unknown, label: string): Error {
    if (reason instanceof Error && reason.name !== "AbortError") {
        return reason
    }

    const error = new Error(`${label} cancelled`)
    error.name = "AbortError"
    return error
}

export async function runAbortable<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal | readonly AbortSignal[],
    label: string,
    timeoutMs?: number,
): Promise<T> {
    const signals = Array.isArray(signal) ? signal : [signal]
    const alreadyAborted = signals.find((entry) => entry.aborted)
    if (alreadyAborted) {
        throw abortError(alreadyAborted.reason, label)
    }

    const controller = new AbortController()
    const externalAbortHandlers = signals.map((entry) => {
        const handler = () => controller.abort(abortError(entry.reason, label))
        entry.addEventListener("abort", handler, { once: true })
        return { signal: entry, handler }
    })

    const timeout =
        timeoutMs === undefined
            ? undefined
            : setTimeout(
                  () => controller.abort(new Error(`${label} timed out after ${timeoutMs}ms`)),
                  timeoutMs,
              )

    const aborted = new Promise<never>((_, reject) => {
        const rejectOnAbort = () => reject(abortError(controller.signal.reason, label))
        if (controller.signal.aborted) {
            rejectOnAbort()
            return
        }
        controller.signal.addEventListener("abort", rejectOnAbort, { once: true })
    })

    try {
        return await Promise.race([operation(controller.signal), aborted])
    } finally {
        for (const entry of externalAbortHandlers) {
            entry.signal.removeEventListener("abort", entry.handler)
        }
        if (timeout !== undefined) {
            clearTimeout(timeout)
        }
    }
}
