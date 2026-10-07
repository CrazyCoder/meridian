/** Stable internal failure classification shared by provenance leaves. */
export class BuildProvenanceError extends Error {
  constructor(readonly reason: "git" | "inputs-changed" | "invalid" | "building" | "gate") {
    super(`Build provenance unavailable: ${reason}`)
  }
}
