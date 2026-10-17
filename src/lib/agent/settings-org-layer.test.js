// MIAORG.1 Task 4 — the organisation layer's contract, the studio's quiet-hours
// opt-out (T4-A) and the studio-zone rule for org quiet hours (T4-B), pinned
// end to end through the resolver and the reply gate. Fictional ids.
import { describe, it, expect } from 'vitest'
import {
  SettingsSchema, StudioSettingsSchema, OrgSettingsSchema, ORG_REFUSED_KEYS, STUDIO_ONLY_KEYS,
  orgSettingsRefusals, buildOrgLayer, buildStudioOverrideBlob, buildCustomerAgentSettings,
} from './settings-contract'
import { mergeAgentSettings } from './settings-resolve'
import { shouldAgentReply, isWithinQuietHours } from './core'
import { initialOverridden } from './settings-overrides'

const ORG_QUIET = { quiet_hours: { start: '22:00', end: '07:00' } }
const TEXT = { type: 'text', body: 'Hi, are you open?' }
const PHONE = '+353800000001'
// 03:00 on the Dublin wall clock (Irish summer time, UTC+1).
const THREE_AM_DUBLIN = new Date('2026-07-01T02:00:00Z')

describe('quiet_hours.off — the studio opt-out (T4-A)', () => {
  it('the schema takes { off: true } with no window, and still refuses a half window', () => {
    expect(SettingsSchema.safeParse({ enabled: true, quiet_hours: { off: true } }).success).toBe(true)
    expect(SettingsSchema.safeParse({ enabled: true, quiet_hours: { start: '22:00', end: '07:00' } }).success).toBe(true)
    const half = SettingsSchema.safeParse({ enabled: true, quiet_hours: { start: '22:00' } })
    expect(half.success).toBe(false)
    expect(half.error.issues[0].path).toEqual(['quiet_hours', 'end'])
    expect(SettingsSchema.safeParse({ enabled: true, quiet_hours: { start: null, end: null } }).success).toBe(false)
  })

  it('a studio off wins over the org window: start/end null, source studio', () => {
    const { settings, sources } = mergeAgentSettings({ org: ORG_QUIET, studio: { enabled: true, quiet_hours: { off: true } } })
    expect(settings.quiet_hours).toEqual({ start: null, end: null, tz: null, off: true })
    expect(sources.quiet_hours).toBe('studio')
  })

  it('off also wins over a window stored beside it at the studio', () => {
    const { settings } = mergeAgentSettings({ org: null, studio: { quiet_hours: { start: '20:00', end: '08:00', off: true } } })
    expect(settings.quiet_hours.start).toBe(null)
    expect(settings.quiet_hours.end).toBe(null)
  })

  it('off at the ORG layer is ignored, and off:false at the studio is not a setting', () => {
    const a = mergeAgentSettings({ org: { quiet_hours: { start: '22:00', end: '07:00', off: true } }, studio: null })
    expect(a.settings.quiet_hours).toEqual({ start: '22:00', end: '07:00' })
    expect(a.sources.quiet_hours).toBe('org')
    const b = mergeAgentSettings({ org: ORG_QUIET, studio: { quiet_hours: { off: false } } })
    expect(b.settings.quiet_hours).toEqual({ start: '22:00', end: '07:00' })
    expect(b.sources.quiet_hours).toBe('org')
  })

  it('isWithinQuietHours is untouched: start/end null is never quiet', () => {
    const off = mergeAgentSettings({ org: ORG_QUIET, studio: { quiet_hours: { off: true } } }).settings.quiet_hours
    expect(isWithinQuietHours(THREE_AM_DUBLIN, off, 'Europe/Dublin')).toBe(false)
  })

  it('org quiet hours set, studio off: shouldAgentReply replies at 03:00', () => {
    const withOff = mergeAgentSettings({ org: ORG_QUIET, studio: { enabled: true, quiet_hours: { off: true } } }).settings
    expect(shouldAgentReply({ settings: withOff, conversation: null, message: TEXT, senderPhone: PHONE, now: THREE_AM_DUBLIN, zone: 'Europe/Dublin' }).reply).toBe(true)
    // control: the same studio without the opt-out inherits the org window
    const inherits = mergeAgentSettings({ org: ORG_QUIET, studio: { enabled: true } }).settings
    expect(shouldAgentReply({ settings: inherits, conversation: null, message: TEXT, senderPhone: PHONE, now: THREE_AM_DUBLIN, zone: 'Europe/Dublin' }))
      .toMatchObject({ reply: false, reason: 'quiet_hours' })
  })

  it('the studio override blob stores { off: true } alone, and never off:false', () => {
    const data = StudioSettingsSchema.parse({ enabled: true, quiet_hours: { off: true } })
    const { overridden, ...rest } = data
    expect(buildStudioOverrideBlob(rest, ['quiet_hours.off'], { sent: { quiet_hours: { off: true } } }).quiet_hours).toEqual({ off: true })
    // off ticked with a window still overridden: the window is not stored
    const both = SettingsSchema.parse({ enabled: true, quiet_hours: { start: '22:00', end: '07:00', off: true } })
    expect(buildStudioOverrideBlob(both, ['quiet_hours'], { sent: { quiet_hours: { start: '22:00', end: '07:00', off: true } } }).quiet_hours).toEqual({ off: true })
    const unticked = SettingsSchema.parse({ enabled: true, quiet_hours: { start: '22:00', end: '07:00', off: false } })
    expect(buildStudioOverrideBlob(unticked, ['quiet_hours'], { sent: { quiet_hours: { start: '22:00', end: '07:00', off: false } } }).quiet_hours)
      .toEqual({ start: '22:00', end: '07:00' })
    expect(overridden).toBe(undefined)
  })

  it('the legacy full build stores the opt-out the same way', () => {
    expect(buildCustomerAgentSettings(SettingsSchema.parse({ enabled: true, quiet_hours: { off: true } })).quiet_hours).toEqual({ off: true })
    expect(buildCustomerAgentSettings(SettingsSchema.parse({ enabled: true, quiet_hours: { start: '21:00', end: '07:00' } })).quiet_hours)
      .toEqual({ start: '21:00', end: '07:00', tz: null })
  })

  it('initialOverridden carries the opt-out, so the next save keeps it', () => {
    expect(initialOverridden({ enabled: true, quiet_hours: { off: true } })).toEqual(['quiet_hours.off'])
  })
})

describe('org quiet hours run on each studio\'s own clock (T4-B)', () => {
  // 23:30 in Dublin is 18:30 in New York (both on summer time).
  const LATE_DUBLIN = new Date('2026-07-01T22:30:00Z')

  it('an inherited window has no zone, so the reply gate reads it in the studio zone', () => {
    const settings = mergeAgentSettings({ org: ORG_QUIET, studio: { enabled: true } }).settings
    expect(settings.quiet_hours.tz ?? null).toBe(null)
    expect(shouldAgentReply({ settings, conversation: null, message: TEXT, senderPhone: PHONE, now: LATE_DUBLIN, zone: 'Europe/Dublin' }).reason).toBe('quiet_hours')
    expect(shouldAgentReply({ settings, conversation: null, message: TEXT, senderPhone: PHONE, now: LATE_DUBLIN, zone: 'America/New_York' }).reply).toBe(true)
  })

  it('the org layer never stores a zone, whatever the editor sends', () => {
    const sent = { quiet_hours: { start: '22:00', end: '07:00', tz: 'America/New_York' } }
    const layer = buildOrgLayer(OrgSettingsSchema.parse(sent), ['quiet_hours'], { sent })
    expect(layer).toEqual({ quiet_hours: { start: '22:00', end: '07:00' } })
  })
})

describe('the organisation layer contract', () => {
  it('OrgSettingsSchema knows no studio-only key and no studio sibling', () => {
    for (const k of [...STUDIO_ONLY_KEYS, 'social_enabled', 'glofox_auto_cancel']) {
      expect(ORG_REFUSED_KEYS.has(k), k).toBe(true)
      expect(OrgSettingsSchema.shape[k], k).toBe(undefined)
    }
    // `enabled` is required on the studio schema; the org schema parses without it
    expect(OrgSettingsSchema.safeParse({ tone: 'Warm' }).success).toBe(true)
  })

  it('orgSettingsRefusals names each studio-only key and the quiet-hours opt-out', () => {
    expect(orgSettingsRefusals({ tone: 'Warm' })).toEqual([])
    const issues = orgSettingsRefusals({ enabled: true, booking_url: 'https://book.example', quiet_hours: { off: true } }, ['tone', 'quiet_hours.off'])
    expect(issues.map((i) => i.path)).toEqual(['settings.enabled', 'settings.booking_url', 'settings.quiet_hours.off', 'overridden.1'])
  })

  it('buildOrgLayer stores only what the organisation sets, never a schema default', () => {
    const sent = { tone: 'Warm', agent_name: '', followups: { enabled: true }, extra_rules: 'Be kind' }
    const layer = buildOrgLayer(OrgSettingsSchema.parse(sent), ['tone', 'agent_name', 'followups.enabled'], { sent })
    // extra_rules was sent but not set; agent_name was blank; followups' other
    // fields were filled in by parsing and never sent.
    expect(layer).toEqual({ tone: 'Warm', followups: { enabled: true } })
  })

  it('nothing set is null (the organisation sets nothing)', () => {
    expect(buildOrgLayer(OrgSettingsSchema.parse({ tone: '' }), ['tone'], { sent: { tone: '' } })).toBe(null)
  })

  it('a half quiet-hours window is dropped', () => {
    const data = { quiet_hours: { start: '22:00', end: '07:00' } }
    expect(buildOrgLayer(OrgSettingsSchema.parse(data), ['quiet_hours.start'], { sent: data })).toBe(null)
  })
})
