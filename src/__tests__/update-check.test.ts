/**
 * Registry update check — real filesystem, injected clock and fetch, no mocks.
 *
 * The properties that matter are all about restraint: it must not hit the
 * network more than once a day, must not fail a start when the network is
 * gone, must not let a stale mirror walk the known-latest backwards, and must
 * not run at all unless someone asked for it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setSetting } from "../settings"
import {
  checkForUpdate,
  getLatestVersion,
  isUpdateCheckEnabled,
  startUpdateCheck,
  stopUpdateCheck,
} from "../proxy/updateCheck"

let dir: string
let cachePath: string
const savedOptOut = process.env.MERIDIAN_NO_UPDATE_CHECK

beforeEach(async () => {
  delete process.env.MERIDIAN_NO_UPDATE_CHECK
  // The check is off by default, so every test that expects it to run turns
  // it on here rather than each repeating the same setup.
  setSetting("checkForUpdates", true)
  dir = await mkdtemp(join(tmpdir(), "meridian-update-check-"))
  cachePath = join(dir, "update-check.json")
  stopUpdateCheck()
})

afterEach(async () => {
  stopUpdateCheck()
  setSetting("checkForUpdates", undefined)
  if (savedOptOut === undefined) delete process.env.MERIDIAN_NO_UPDATE_CHECK
  else process.env.MERIDIAN_NO_UPDATE_CHECK = savedOptOut
  await rm(dir, { recursive: true, force: true })
})

/** A fetch stub that records how many times the network was touched. */
function countingFetch(value: string | undefined) {
  const state = { calls: 0 }
  return {
    state,
    fetchLatest: async () => {
      state.calls++
      return value
    },
  }
}

describe("checkForUpdate", () => {
  test("disabling while the disk cache is being read prevents a later network request", async () => {
    const { state, fetchLatest } = countingFetch("1.99.0")
    const pending = checkForUpdate({ cachePath, fetchLatest })
    setSetting("checkForUpdates", false)
    expect(await pending).toBeUndefined()
    expect(state.calls).toBe(0)
  })
  test("fetches and caches on a cold start", async () => {
    const { state, fetchLatest } = countingFetch("1.63.0")
    expect(await checkForUpdate({ cachePath, fetchLatest })).toBe("1.63.0")
    expect(state.calls).toBe(1)

    const written = JSON.parse(await readFile(cachePath, "utf8"))
    expect(written.latest).toBe("1.63.0")
    expect(typeof written.checkedAt).toBe("number")
  })

  test("serves a fresh cache without touching the network", async () => {
    const now = 1_000_000
    await writeFile(cachePath, JSON.stringify({ latest: "1.63.0", checkedAt: now - 1000 }))
    const { state, fetchLatest } = countingFetch("9.9.9")

    expect(await checkForUpdate({ cachePath, fetchLatest, now: () => now, ttlMs: 60_000 })).toBe("1.63.0")
    expect(state.calls).toBe(0)
  })

  test("refetches once the cache is older than the TTL", async () => {
    const now = 1_000_000
    await writeFile(cachePath, JSON.stringify({ latest: "1.62.7", checkedAt: now - 90_000 }))
    const { state, fetchLatest } = countingFetch("1.63.0")

    expect(await checkForUpdate({ cachePath, fetchLatest, now: () => now, ttlMs: 60_000 })).toBe("1.63.0")
    expect(state.calls).toBe(1)
  })

  test("a cache stamped in the future is refetched, not trusted forever", async () => {
    // Clock skew or a hand-edited file must not pin the answer permanently.
    const now = 1_000_000
    await writeFile(cachePath, JSON.stringify({ latest: "0.0.1", checkedAt: now + 5_000_000 }))
    const { state, fetchLatest } = countingFetch("1.63.0")

    expect(await checkForUpdate({ cachePath, fetchLatest, now: () => now, ttlMs: 60_000 })).toBe("1.63.0")
    expect(state.calls).toBe(1)
  })

  test("falls back to a stale cache when the registry is unreachable", async () => {
    const now = 1_000_000
    await writeFile(cachePath, JSON.stringify({ latest: "1.62.7", checkedAt: now - 90_000 }))

    const result = await checkForUpdate({
      cachePath,
      now: () => now,
      ttlMs: 60_000,
      fetchLatest: async () => undefined,
    })
    expect(result).toBe("1.62.7")
  })

  test("returns undefined when offline with no cache at all", async () => {
    expect(await checkForUpdate({ cachePath, fetchLatest: async () => undefined })).toBeUndefined()
  })

  test("ignores a corrupt cache file instead of throwing", async () => {
    await writeFile(cachePath, "{not json at all")
    expect(await checkForUpdate({ cachePath, fetchLatest: async () => "1.63.0" })).toBe("1.63.0")
  })

  test("ignores a cache file with the wrong shape", async () => {
    await writeFile(cachePath, JSON.stringify({ latest: 42, checkedAt: "yesterday" }))
    expect(await checkForUpdate({ cachePath, fetchLatest: async () => "1.63.0" })).toBe("1.63.0")
  })

  test("a stale mirror cannot walk the known-latest backwards", async () => {
    const now = 1_000_000
    await writeFile(cachePath, JSON.stringify({ latest: "1.63.0", checkedAt: now - 90_000 }))

    const result = await checkForUpdate({
      cachePath,
      now: () => now,
      ttlMs: 60_000,
      fetchLatest: async () => "1.62.7",
    })
    expect(result).toBe("1.63.0")
    // ...and the regression is not persisted either.
    expect(JSON.parse(await readFile(cachePath, "utf8")).latest).toBe("1.63.0")
  })

  test("an unwritable cache path still returns an answer", async () => {
    const { fetchLatest } = countingFetch("1.63.0")
    const unwritable = join(dir, "not-a-dir.json", "nested", "cache.json")
    await writeFile(join(dir, "not-a-dir.json"), "x")
    expect(await checkForUpdate({ cachePath: unwritable, fetchLatest })).toBe("1.63.0")
  })

  test("does nothing when the operator opted out", async () => {
    process.env.MERIDIAN_NO_UPDATE_CHECK = "1"
    const { state, fetchLatest } = countingFetch("1.63.0")
    expect(await checkForUpdate({ cachePath, fetchLatest })).toBeUndefined()
    expect(state.calls).toBe(0)
  })
})

describe("isUpdateCheckEnabled", () => {
  test("off until the setting turns it on", () => {
    setSetting("checkForUpdates", undefined)
    expect(isUpdateCheckEnabled()).toBe(false)
    setSetting("checkForUpdates", false)
    expect(isUpdateCheckEnabled()).toBe(false)
    setSetting("checkForUpdates", true)
    expect(isUpdateCheckEnabled()).toBe(true)
  })

  test("the env opt-out wins over an enabled setting", () => {
    process.env.MERIDIAN_NO_UPDATE_CHECK = "1"
    expect(isUpdateCheckEnabled()).toBe(false)
  })
})

describe("no network while off", () => {
  // Spies on the real global fetch and leaves fetchLatest at its default, so
  // this covers the registry path an actual install takes rather than a stub.
  const realFetch = globalThis.fetch
  let requested: string[]

  beforeEach(() => {
    requested = []
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request) => {
        requested.push(String(input instanceof Request ? input.url : input))
        return Response.json({ latest: "1.99.0" })
      },
      { preconnect: realFetch.preconnect },
    )
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test("an unset setting makes no request, from start or from a direct check", async () => {
    setSetting("checkForUpdates", undefined)
    await startUpdateCheck({ cachePath })
    expect(await checkForUpdate({ cachePath })).toBeUndefined()

    expect(requested).toEqual([])
    expect(getLatestVersion()).toBeUndefined()
  })

  test("an explicit false makes no request either", async () => {
    setSetting("checkForUpdates", false)
    await startUpdateCheck({ cachePath })
    expect(requested).toEqual([])
  })

  test("the same path does reach the registry once switched on", async () => {
    // The control for the two tests above: without it, a spy that never
    // fires would pass them for the wrong reason.
    await startUpdateCheck({ cachePath })
    expect(requested).toEqual(["https://registry.npmjs.org/-/package/@rynfar/meridian/dist-tags"])
    expect(getLatestVersion()).toBe("1.99.0")
  })
})

describe("startUpdateCheck", () => {
  test("a check still in flight when switched off does not publish afterwards", async () => {
    let release: (value: string) => void = () => {}
    let asked: () => void = () => {}
    const fetching = new Promise<void>((resolve) => { asked = resolve })
    const pending = startUpdateCheck({
      cachePath,
      fetchLatest: () => new Promise<string>((resolve) => { release = resolve; asked() }),
    })
    await fetching
    stopUpdateCheck()
    release("1.99.0")
    await pending

    expect(getLatestVersion()).toBeUndefined()
  })

  test("publishes the resolved version and notifies once", async () => {
    const seen: string[] = []
    await startUpdateCheck({ cachePath, fetchLatest: async () => "1.63.0", onResolved: (v) => seen.push(v) })

    expect(getLatestVersion()).toBe("1.63.0")
    expect(seen).toEqual(["1.63.0"])
  })

  test("is idempotent — a second start does not stack timers or refetch", async () => {
    const { state, fetchLatest } = countingFetch("1.63.0")
    await startUpdateCheck({ cachePath, fetchLatest })
    await startUpdateCheck({ cachePath, fetchLatest })
    expect(state.calls).toBe(1)
  })

  test("stays silent and unstarted when opted out", async () => {
    process.env.MERIDIAN_NO_UPDATE_CHECK = "1"
    const seen: string[] = []
    await startUpdateCheck({ cachePath, fetchLatest: async () => "1.63.0", onResolved: (v) => seen.push(v) })

    expect(getLatestVersion()).toBeUndefined()
    expect(seen).toEqual([])
  })

  test("an unreachable registry leaves no version and does not reject", async () => {
    await startUpdateCheck({ cachePath, fetchLatest: async () => undefined })
    expect(getLatestVersion()).toBeUndefined()
  })

  test("stop clears the published version so a later start re-resolves", async () => {
    await startUpdateCheck({ cachePath, fetchLatest: async () => "1.63.0" })
    stopUpdateCheck()
    expect(getLatestVersion()).toBeUndefined()

    await startUpdateCheck({ cachePath, fetchLatest: async () => "1.64.0", ttlMs: 0 })
    expect(getLatestVersion()).toBe("1.64.0")
  })
})
