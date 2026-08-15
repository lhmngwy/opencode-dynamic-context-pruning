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
    signal: AbortSignal,
    label: string,
    timeoutMs?: number,
): Promise<T> {
    if (signal.aborted) {
        throw abortError(signal.reason, label)
    }

    const controller = new AbortController()
    const onExternalAbort = () => controller.abort(abortError(signal.reason, label))
    signal.addEventListener("abort", onExternalAbort, { once: true })

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
        signal.removeEventListener("abort", onExternalAbort)
        if (timeout !== undefined) {
            clearTimeout(timeout)
        }
    }
}
