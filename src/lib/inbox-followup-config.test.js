import { describe, it, expect, vi } from 'vitest'

const resolve = vi.fn()
vi.mock('@/lib/agent/settings-resolve', () => ({ resolveAgentSettings: (...a) => resolve(...a) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

import { followupConfigFromSettings, readInboxFollowupConfig } from './inbox-followup-config'

const DEF = { quietHours: 48, nudgeEnabled: false }
const withSt = (st, agent = { enabled: true }) => ({ ...agent, followups: { staff_threads: st } })

describe('followupConfigFromSettings', () => {
  it('missing settings or section gives the default', () => {
    expect(followupConfigFromSettings(undefined)).toEqual(DEF)
    expect(followupConfigFromSettings(null)).toEqual(DEF)
    expect(followupConfigFromSettings({})).toEqual(DEF)
    expect(followupConfigFromSettings({ followups: {} })).toEqual(DEF)
  })
  it('junk gives the default', () => {
    expect(followupConfigFromSettings(withSt('x'))).toEqual(DEF)
    expect(followupConfigFromSettings(withSt({ quiet_after_hours: 'soon', nudge_enabled: 'yes' }))).toEqual(DEF)
    expect(followupConfigFromSettings(withSt({ quiet_after_hours: NaN }))).toEqual(DEF)
  })
  it('reads hours and the nudge switch', () => {
    expect(followupConfigFromSettings(withSt({ quiet_after_hours: 72, nudge_enabled: true })))
      .toEqual({ quietHours: 72, nudgeEnabled: true })
  })
  it('the nudge switch counts only while the agent is on (enabled or test mode)', () => {
    const st = { quiet_after_hours: 72, nudge_enabled: true }
    expect(followupConfigFromSettings(withSt(st, { enabled: false })).nudgeEnabled).toBe(false)
    expect(followupConfigFromSettings(withSt(st, {})).nudgeEnabled).toBe(false)
    expect(followupConfigFromSettings(withSt(st, { enabled: false, test_mode: true })).nudgeEnabled).toBe(true)
    expect(followupConfigFromSettings(withSt(st, { enabled: true })).nudgeEnabled).toBe(true)
    expect(followupConfigFromSettings({ followups: { staff_threads: st } }).quietHours).toBe(72) // quiet hours still read
  })
  it('clamps hours to 4..336', () => {
    expect(followupConfigFromSettings(withSt({ quiet_after_hours: 2 })).quietHours).toBe(4)
    expect(followupConfigFromSettings(withSt({ quiet_after_hours: 9999 })).quietHours).toBe(336)
  })
})

describe('readInboxFollowupConfig', () => {
  it('reads through the resolved settings', async () => {
    resolve.mockResolvedValueOnce({ ok: true, settings: withSt({ quiet_after_hours: 24, nudge_enabled: true }) })
    expect(await readInboxFollowupConfig({}, 'loc-1')).toEqual({ quietHours: 24, nudgeEnabled: true })
    expect(resolve).toHaveBeenCalledWith({}, 'loc-1')
  })
  it('a failed read returns the default', async () => {
    resolve.mockResolvedValueOnce({ ok: false, reason: 'read_failed' })
    expect(await readInboxFollowupConfig({}, 'loc-1')).toEqual(DEF)
  })
  it('a throw returns the default', async () => {
    resolve.mockRejectedValueOnce(new Error('boom'))
    expect(await readInboxFollowupConfig({}, 'loc-1')).toEqual(DEF)
  })
})
