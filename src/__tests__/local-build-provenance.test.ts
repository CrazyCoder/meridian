import { describe, expect, test } from "bun:test"
import { compareLocalBuilds, repositoryLinks } from "../proxy/localBuildInfo"

const artifact = { source: "local" as const, version: "1.77.1", kind: "artifact" as const, counterScope: "scope-a", counter: 4, attemptId: "attempt-a" }

describe("local build identity", () => {
  test("reports behind only within the same successful-build stream", () => {
    const latest = { ...artifact, counter: 7, attemptId: "attempt-b" }
    expect(compareLocalBuilds(artifact, latest)).toEqual({ state: "behind", buildsBehind: 3 })
  })
  test("reports independent worktrees as incomparable", () => {
    expect(compareLocalBuilds(artifact, { ...artifact, counterScope: "scope-b" }).state).toBe("incomparable")
  })
  test("reports rollback instead of a negative behind count", () => {
    expect(compareLocalBuilds(artifact, { ...artifact, counter: 2 }).state).toBe("rollback")
  })
  test("requires exact attempt identity at equal counters", () => {
    expect(compareLocalBuilds(artifact, { ...artifact, attemptId: "other" }).state).toBe("incomparable")
    expect(compareLocalBuilds(artifact, artifact).state).toBe("current")
  })
  test("does not interpret source edits as another artifact build", () => {
    const source = { source: "local" as const, version: "1.77.1", kind: "source" as const, sourceHash: "one" }
    expect(compareLocalBuilds(source, { ...source, sourceHash: "two" }).state).toBe("source-changed")
    expect(compareLocalBuilds(source, artifact).state).toBe("incomparable")
  })
  test("strips credentials and encodes branch links", () => {
    expect(repositoryLinks("https://user:password@github.com/owner/repo.git?token=secret#secret", "feat/a b", "a".repeat(40))).toEqual({
      branchUrl: "https://github.com/owner/repo/tree/feat%2Fa%20b",
      commitUrl: `https://github.com/owner/repo/commit/${"a".repeat(40)}`,
    })
    expect(repositoryLinks("git@gitlab.com:group/project.git", "main", "b".repeat(40)).branchUrl).toBe("https://gitlab.com/group/project/-/tree/main")
    expect(repositoryLinks("https://example.com/repo", "main", "abc")).toEqual({})
  })
})
