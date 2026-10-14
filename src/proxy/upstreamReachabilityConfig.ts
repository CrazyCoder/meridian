/** Dynamic configuration acquisition belongs at the proxy orchestration boundary. */
import { env } from "../env"
import { loadSettings } from "../settings"
import { reachabilityThresholdsFromConfiguration, type ReachabilityThresholds } from "./upstreamReachability"

/**
 * Reread environment aliases and settings on every tracker evaluation. Keep
 * source acquisition separate from the I/O-free normalizer and state machine.
 */
export function resolveReachabilityThresholds(
  readEnv: (suffix: string) => string | undefined = env,
  readSettings: () => unknown = loadSettings,
): ReachabilityThresholds {
  const settings = readSettings()
  return reachabilityThresholdsFromConfiguration({
    unreachableAfterMs: readEnv("UPSTREAM_UNREACHABLE_AFTER_MS"),
    holdMs: readEnv("UPSTREAM_UNREACHABLE_HOLD_MS"),
    minFailures: readEnv("UPSTREAM_UNREACHABLE_MIN_FAILURES"),
  }, settings)
}
