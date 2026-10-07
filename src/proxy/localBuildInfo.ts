import type { BuildInfo } from "./buildInfo"

export type BuildState = "current" | "behind" | "rollback" | "incomparable" | "source-changed" | "missing" | "invalid" | "building" | "unknown"
export interface BuildStatus {
  readonly runtime: Readonly<BuildInfo>
  readonly latest?: Readonly<BuildInfo>
  readonly state: BuildState
  readonly buildsBehind?: number
}

export function compareLocalBuilds(runtime: BuildInfo, latest: BuildInfo): Pick<BuildStatus, "state" | "buildsBehind"> {
  if (runtime.kind !== latest.kind) return { state: "incomparable" }
  switch (runtime.kind) {
    case "source":
      if (!runtime.sourceHash || !latest.sourceHash) return { state: "unknown" }
      return { state: runtime.sourceHash === latest.sourceHash ? "current" : "source-changed" }
    case "artifact": {
      if (!runtime.counterScope || !latest.counterScope || runtime.counter === undefined || latest.counter === undefined) return { state: "unknown" }
      if (runtime.counterScope !== latest.counterScope) return { state: "incomparable" }
      const delta = latest.counter - runtime.counter
      if (delta > 0) return { state: "behind", buildsBehind: delta }
      if (delta < 0) return { state: "rollback" }
      return { state: runtime.attemptId && runtime.attemptId === latest.attemptId ? "current" : "incomparable" }
    }
    case undefined: return { state: "unknown" }
  }
}

/** Only public forge URLs leave the Git boundary; userinfo and URL suffixes never do. */
export function repositoryLinks(remote: string, branch: string | undefined, sha: string): Pick<BuildInfo, "branchUrl" | "commitUrl"> {
  try {
    const scp = /^(?:[^@/]+@)?(github\.com|gitlab\.com):(.+)$/.exec(remote)
    const url = new URL(scp ? `https://${scp[1]}/${scp[2]}` : remote)
    if (!["https:", "http:", "ssh:"].includes(url.protocol) || !["github.com", "gitlab.com"].includes(url.hostname)) return {}
    const path = url.pathname.replace(/\.git$/, "").replace(/\/$/, "")
    if (!/^\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(path) || !/^[a-f0-9]{40,64}$/.test(sha)) return {}
    const base = `https://${url.hostname}${path}${url.hostname === "gitlab.com" ? "/-" : ""}`
    return {
      commitUrl: new URL(`${base}/commit/${sha}`).href,
      ...(branch ? { branchUrl: new URL(`${base}/tree/${encodeURIComponent(branch)}`).href } : {}),
    }
  } catch (error) {
    if (error instanceof TypeError) return {}
    throw error
  }
}
