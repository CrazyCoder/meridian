import { number, object, type Incident, type Preferences } from './core'

/** Desktop delivery is deliberately narrower than the in-app incident history. */
export class NotificationGate {
  private sent: Record<string, number> = {}
  private failures: number[] = []
  constructor(saved?: unknown) {
    for (const key of ['service', 'request', 'cache', 'quota', 'advisory']) {
      const timestamp = number(object(saved)[key])
      if (timestamp !== undefined && timestamp >= 0) this.sent[key] = timestamp
    }
  }
  snapshot() { return { ...this.sent } }
  choose(incident: Incident, preferences: Preferences, now = Date.now()): Incident | undefined {
    if (!preferences.notifications || now < preferences.quietUntil) { this.failures = []; return }
    const category = incident.id.split(':')[0]
    let detail: string
    if (category === 'service' && preferences.notificationCritical) detail = 'Automatic recovery could not restart Meridian. Open the app to inspect service logs.'
    else if (category === 'request' && preferences.notificationRequests) {
      this.failures = [...this.failures.filter(time => now - time < 120_000), now]
      if (this.failures.length < 3) return
      this.failures = []
      detail = 'Several requests failed within two minutes. Open Requests to investigate.'
    } else if (category === 'cache' && preferences.notificationCache) detail = 'Three consecutive continuations had very low cache reuse. Open Requests to investigate.'
    else if (category === 'quota' && preferences.notificationQuota && /:(95|100)$/.test(incident.id)) detail = 'An account has used at least 95% of a usage window. Open the menu bar to check limits or switch accounts.'
    else return
    const cooldown = category === 'service' ? 900_000 : 1_800_000
    if (this.sent[category] !== undefined && now - this.sent[category]! < cooldown) return
    if (category !== 'service' && this.sent.advisory !== undefined && now - this.sent.advisory < 300_000) return
    this.sent[category] = now
    if (category !== 'service') this.sent.advisory = now
    return { ...incident, title: category === 'request' ? 'Repeated request failures' : incident.title, detail }
  }
}
