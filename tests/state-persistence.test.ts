import assert from "node:assert/strict"
import test from "node:test"
import { access, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
    SessionStateDeletedError,
    createSessionState,
    createSessionStateRegistry,
    deleteSessionState,
    loadSessionState,
    saveSessionState,
} from "../lib/state"
import type { Logger } from "../lib/logger"

const testDataHome = join(tmpdir(), `opencode-dcp-persistence-tests-${process.pid}`)
process.env.XDG_DATA_HOME = testDataHome

function storagePaths(sessionId: string) {
    const directory = join(testDataHome, "opencode", "storage", "plugin", "dcp")
    const file = join(directory, `${sessionId}.json`)
    return { directory, file, marker: `${file}.deleted`, temporary: `${file}.tmp` }
}

test("durable deletion fence survives failed cleanup and supports idempotent retry", async () => {
    const sessionID = `session-delete-retry-${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    const warnings: string[] = []
    const logger = {
        info() {},
        debug() {},
        error() {},
        warn(message: string) {
            warnings.push(message)
        },
    } as unknown as Logger
    const paths = storagePaths(sessionID)
    await mkdir(paths.directory, { recursive: true })
    await saveSessionState(state, logger)
    await writeFile(paths.temporary, "stale temporary state", "utf-8")

    const sessions = createSessionStateRegistry([[sessionID, state]])
    let activeStarted!: () => void
    const started = new Promise<void>((resolve) => {
        activeStarted = resolve
    })
    let releaseActive!: () => void
    const activeGate = new Promise<void>((resolve) => {
        releaseActive = resolve
    })
    const active = sessions.runExclusive(sessionID, async (_state, guard) => {
        activeStarted()
        await activeGate
        guard.assertActive()
    })
    const activeRejection = assert.rejects(active, /has been disposed/)
    await started

    const failingRemove = async () => {
        throw new Error("injected removal failure")
    }
    await sessions.dispose(sessionID, () => deleteSessionState(sessionID, logger, failingRemove))
    assert.equal(sessions.peek(sessionID), undefined)
    assert.equal(await loadSessionState(sessionID, logger), null)
    assert.equal(
        warnings.includes("Session state deletion remains fenced but physical cleanup is incomplete"),
        true,
    )
    const replayState = createSessionState()
    replayState.sessionId = sessionID
    await assert.rejects(saveSessionState(replayState, logger), SessionStateDeletedError)

    await access(paths.file)
    await access(paths.temporary)
    releaseActive()
    await activeRejection
    await new Promise<void>((resolve) => setImmediate(resolve))

    const retry = await deleteSessionState(sessionID, logger)
    assert.equal(retry.removed, true)
    await assert.rejects(access(paths.file))
    await assert.rejects(access(paths.temporary))
    assert.equal(await loadSessionState(sessionID, logger), null)
    assert.equal((await deleteSessionState(sessionID, logger)).removed, true)

    await rm(testDataHome, { recursive: true, force: true })
})

test("deletion owns retries for transient marker write and rename failures", async () => {
    const logger = {
        info() {},
        debug() {},
        error() {},
        warn() {},
    } as unknown as Logger

    for (const failure of ["write", "rename"] as const) {
        const sessionID = `session-delete-${failure}-retry-${Date.now()}`
        const state = createSessionState()
        state.sessionId = sessionID
        const paths = storagePaths(sessionID)
        await mkdir(paths.directory, { recursive: true })
        await saveSessionState(state, logger)
        let writeAttempts = 0
        let renameAttempts = 0

        const result = await deleteSessionState(sessionID, logger, undefined, {
            retryDelay: async () => {},
            writeMarker: async (path, content) => {
                writeAttempts += 1
                if (failure === "write" && writeAttempts === 1) {
                    throw new Error("injected marker write failure")
                }
                await writeFile(path, content, "utf-8")
            },
            renameMarker: async (temporaryPath, markerPath) => {
                renameAttempts += 1
                if (failure === "rename" && renameAttempts === 1) {
                    throw new Error("injected marker rename failure")
                }
                await rename(temporaryPath, markerPath)
            },
        })

        assert.equal(result.removed, true)
        await access(paths.marker)
        await assert.rejects(access(paths.file))
        assert.equal(await loadSessionState(sessionID, logger), null)
        const staleState = createSessionState()
        staleState.sessionId = sessionID
        await assert.rejects(saveSessionState(staleState, logger), SessionStateDeletedError)
    }

    await rm(testDataHome, { recursive: true, force: true })
})

test("deletion remains unresolved when durable marker attempts are exhausted", async () => {
    const logger = {
        info() {},
        debug() {},
        error() {},
        warn() {},
    } as unknown as Logger

    for (const failure of ["write", "rename"] as const) {
        const sessionID = `session-delete-${failure}-exhausted-${Date.now()}`
        const state = createSessionState()
        state.sessionId = sessionID
        const paths = storagePaths(sessionID)
        await mkdir(paths.directory, { recursive: true })
        await saveSessionState(state, logger)

        await assert.rejects(
            deleteSessionState(sessionID, logger, undefined, {
                markerAttempts: 2,
                retryDelay: async () => {},
                writeMarker: async (path, content) => {
                    if (failure === "write") {
                        throw new Error("injected marker write exhaustion")
                    }
                    await writeFile(path, content, "utf-8")
                },
                renameMarker: async () => {
                    throw new Error("injected marker rename exhaustion")
                },
            }),
            /Failed to durably delete session state/,
        )
        await assert.rejects(access(paths.file))
        await assert.rejects(access(paths.marker))

        assert.equal((await deleteSessionState(sessionID, logger)).removed, true)
        await access(paths.marker)
        const staleState = createSessionState()
        staleState.sessionId = sessionID
        await assert.rejects(saveSessionState(staleState, logger), SessionStateDeletedError)
        assert.equal(await loadSessionState(sessionID, logger), null)
    }

    await rm(testDataHome, { recursive: true, force: true })
})

test("concurrent deletion attempts converge on one durable fence", async () => {
    const sessionID = `session-delete-concurrent-${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    const logger = {
        info() {},
        debug() {},
        error() {},
        warn() {},
    } as unknown as Logger
    const paths = storagePaths(sessionID)
    await mkdir(paths.directory, { recursive: true })
    await saveSessionState(state, logger)

    const temporaryMarkers: string[] = []
    let releaseRenames!: () => void
    const renamesReleased = new Promise<void>((resolve) => {
        releaseRenames = resolve
    })
    const operations = {
        writeMarker: async (path: string, content: string) => {
            temporaryMarkers.push(path)
            await writeFile(path, content, "utf-8")
        },
        renameMarker: async (temporaryPath: string, markerPath: string) => {
            if (temporaryMarkers.length === 2) {
                releaseRenames()
            }
            await renamesReleased
            await rename(temporaryPath, markerPath)
        },
    }
    const results = await Promise.all([
        deleteSessionState(sessionID, logger, undefined, operations),
        deleteSessionState(sessionID, logger, undefined, operations),
    ])

    assert.deepEqual(results, [{ removed: true }, { removed: true }])
    assert.equal(new Set(temporaryMarkers).size, 2)
    await access(paths.marker)
    await assert.rejects(access(paths.file))
    assert.equal(await loadSessionState(sessionID, logger), null)
    const staleState = createSessionState()
    staleState.sessionId = sessionID
    await assert.rejects(saveSessionState(staleState, logger), SessionStateDeletedError)
    assert.equal((await deleteSessionState(sessionID, logger)).removed, true)
    const remaining = await readdir(paths.directory)
    assert.equal(remaining.some((name) => name.includes(`${sessionID}.json.deleted.`)), false)

    await rm(testDataHome, { recursive: true, force: true })
})
