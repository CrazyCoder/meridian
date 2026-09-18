import { expect, test } from 'bun:test'
import { defaults, type Incident } from '../../apps/desktop/src/core'
import { NotificationGate } from '../../apps/desktop/src/notifications'
const incident = (id: string): Incident => ({ id, title: 'Alert', detail: 'private error content', timestamp: 1, severity: 'error' })
const enabled = { ...defaults, notifications: true }
test('notification opt-in defaults to failed recovery only, without raw error content', () => {
  const gate = new NotificationGate()
  expect(gate.choose(incident('service:1'), defaults, 1)).toBeUndefined()
  for (const id of ['exit:1', 'request:1', 'cache:1', 'quota:p:95']) expect(gate.choose(incident(id), enabled, 2)).toBeUndefined()
  expect(gate.choose(incident('service:2'), enabled, 3)?.detail).not.toContain('private')
})
test('cooldowns survive restart and critical recovery bypasses the advisory limit', () => {
  const preferences = { ...enabled, notificationCache: true, notificationQuota: true }
  const gate = new NotificationGate()
  expect(gate.choose(incident('cache:1'), preferences, 100)).toBeDefined()
  expect(gate.choose(incident('quota:p:95'), preferences, 101)).toBeUndefined()
  expect(gate.choose(incident('service:1'), preferences, 102)).toBeDefined()
  const restored = new NotificationGate(gate.snapshot())
  expect(restored.choose(incident('service:2'), preferences, 103)).toBeUndefined()
  expect(restored.choose(incident('cache:2'), preferences, 900_000)).toBeUndefined()
  expect(restored.choose(incident('service:3'), preferences, 900_102)).toBeDefined()
})
test('request notifications require a recent burst and snooze discards burst history', () => {
  const gate = new NotificationGate()
  const preferences = { ...enabled, notificationRequests: true }
  expect(gate.choose(incident('request:1'), preferences, 1)).toBeUndefined()
  expect(gate.choose(incident('request:2'), preferences, 2)).toBeUndefined()
  expect(gate.choose(incident('request:3'), preferences, 120_003)).toBeUndefined()
  expect(gate.choose(incident('request:4'), preferences, 120_004)).toBeUndefined()
  expect(gate.choose(incident('request:5'), { ...preferences, quietUntil: 200_000 }, 120_005)).toBeUndefined()
  expect(gate.choose(incident('request:6'), preferences, 200_001)).toBeUndefined()
  expect(gate.choose(incident('request:7'), preferences, 200_002)).toBeUndefined()
  expect(gate.choose(incident('request:8'), preferences, 200_003)?.title).toBe('Repeated request failures')
})
test('80 percent quota stays in-app even when usage notifications are enabled', () => {
  const gate = new NotificationGate(), preferences = { ...enabled, notificationQuota: true }
  expect(gate.choose(incident('quota:p:80'), preferences, 1)).toBeUndefined()
  expect(gate.choose(incident('quota:p:95'), preferences, 2)).toBeDefined()
})
