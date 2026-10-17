// MIAORG.1 Task 3 — the studio editor's REAL save payload (buildSavePayload,
// the function saveSettings calls), run end to end against Stillorgan's live
// key set: what the editor is shown -> the overrides it starts from -> the PUT
// body -> the PUT's schema -> the override-only blob. The first save after
// this ships must change nothing about how Stillorgan resolves (T3-D), and a
// second save must store the same blob again.
import { describe, it, expect } from 'vitest'
import { StudioSettingsSchema, buildStudioOverrideBlob, buildCustomerAgentSettings } from '@/lib/agent/settings-contract'
import { mergeAgentSettings } from '@/lib/agent/settings-resolve'
import { initialOverridden } from '@/lib/agent/settings-overrides'
import { STILLORGAN_BLOB } from '@/lib/agent/settings-fixtures.test-helpers'
import { buildSavePayload, numberOrNull, compactObject } from './save-payload'

// What GET hands the editor (the resolved settings + the two siblings).
const shownFor = (studio, org = null) => ({
  ...mergeAgentSettings({ org, studio }).settings, social_enabled: false, glofox_auto_cancel: false,
})

// One Save, as the route performs it: the body travels as JSON (undefined
// fields vanish, exactly as fetch sends them), is parsed, then built.
function saveThroughPut(shown, overridden) {
  const sent = JSON.parse(JSON.stringify(buildSavePayload(shown, overridden)))
  const parsed = StudioSettingsSchema.safeParse(sent)
  if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues))
  const { overridden: list, ...data } = parsed.data
  return { blob: buildStudioOverrideBlob(data, list, { sent }), data }
}

describe('Stillorgan round trip through the real save payload (T3-D)', () => {
  const shown = shownFor(STILLORGAN_BLOB)
  const overridden = initialOverridden(STILLORGAN_BLOB)
  const { blob } = saveThroughPut(shown, overridden)

  it('every value Stillorgan stores is stored again, value for value', () => {
    for (const [k, v] of Object.entries(STILLORGAN_BLOB)) {
      if (v !== null) expect(blob[k], k).toEqual(v)
    }
  })

  it('Stillorgan resolves exactly as before the save', () => {
    expect(mergeAgentSettings({ org: null, studio: blob }).settings).toEqual(mergeAgentSettings({ org: null, studio: STILLORGAN_BLOB }).settings)
  })

  it('a second save (after the editor re-reads) stores the same blob: idempotent', () => {
    const again = saveThroughPut(shownFor(blob), initialOverridden(blob)).blob
    expect(again).toEqual(blob)
  })

  it('once an org layer exists, the save still keeps Stillorgan\'s own values over it', () => {
    const org = { tone: 'Org tone', extra_rules: 'Org rules', followups: { daily_cap: 99 } }
    const resolved = mergeAgentSettings({ org, studio: blob }).settings
    expect(resolved.tone).toBe(STILLORGAN_BLOB.tone)
    expect(resolved.extra_rules).toBe(STILLORGAN_BLOB.extra_rules)
    expect(resolved.followups.daily_cap).toBe(STILLORGAN_BLOB.followups.daily_cap)
  })
})

describe('a cleared number is "not stored", never the code default', () => {
  const shown = shownFor({ enabled: true })

  it('top-level numbers: cleared -> null; a typed 0 stays 0', () => {
    expect(numberOrNull('')).toBe(null)
    expect(numberOrNull(null)).toBe(null)
    expect(numberOrNull('abc')).toBe(null)
    expect(numberOrNull('0')).toBe(0)
    expect(numberOrNull(0)).toBe(0)
    const p = buildSavePayload({ ...shown, handoff_cooldown_hours: null, auto_resolve_after_reply_hours: null, auto_resolve_stale_hours: 0 }, [])
    expect(p.handoff_cooldown_hours).toBe(null)
    expect(p.auto_resolve_after_reply_hours).toBe(null)
    expect(p.auto_resolve_stale_hours).toBe(0)
  })

  it('an overridden-but-cleared top-level number is not stored (the org/default shows through)', () => {
    const { blob } = saveThroughPut({ ...shown, handoff_cooldown_hours: null, auto_resolve_stale_hours: 0 }, ['handoff_cooldown_hours', 'auto_resolve_stale_hours'])
    expect(blob).not.toHaveProperty('handoff_cooldown_hours')
    expect(blob.auto_resolve_stale_hours).toBe(0)
    const resolved = mergeAgentSettings({ org: { handoff_cooldown_hours: 6 }, studio: blob }).settings
    expect(resolved.handoff_cooldown_hours).toBe(6)
  })

  it('follow-up / check-in numbers: cleared -> left out of the body (the schema refuses null)', () => {
    const p = buildSavePayload({ ...shown, followups: { enabled: true, nudge_after_hours: null, daily_cap: '' }, first_class_checkin: { delay_hours: null, daily_cap: 7 } }, [])
    const sent = JSON.parse(JSON.stringify(p))
    expect(sent.followups).toEqual({ enabled: true, template_name: null })
    expect(sent.first_class_checkin).toEqual({ enabled: false, template_name: null, daily_cap: 7 })
    expect(StudioSettingsSchema.safeParse(sent).success).toBe(true)
  })

  it('an overridden-but-cleared follow-up number is not stored, even though parsing fills in a default', () => {
    const { blob, data } = saveThroughPut(
      { ...shown, followups: { enabled: true, nudge_after_hours: null, daily_cap: null } },
      ['followups.enabled', 'followups.nudge_after_hours', 'followups.daily_cap'],
    )
    expect(data.followups.daily_cap).toBe(50) // the schema default, in the parsed body
    expect(blob.followups).toEqual({ enabled: true }) // ...but never stored as an override
    const resolved = mergeAgentSettings({ org: { followups: { daily_cap: 80 } }, studio: blob }).settings
    expect(resolved.followups.daily_cap).toBe(80)
  })

  it('the legacy path (no overridden) still gets today\'s code defaults for the same body', () => {
    const sent = JSON.parse(JSON.stringify(buildSavePayload({ ...shown, handoff_cooldown_hours: null, followups: { enabled: true, daily_cap: null } }, [])))
    delete sent.overridden
    const full = buildCustomerAgentSettings(StudioSettingsSchema.parse(sent))
    expect(full.handoff_cooldown_hours).toBe(12)
    expect(full.followups.daily_cap).toBe(50)
  })

  it('compactObject drops unset limit fields; all unset -> null', () => {
    expect(compactObject({ max_replies_per_location_per_day: 300, max_replies_per_conversation_per_hour: null })).toEqual({ max_replies_per_location_per_day: 300 })
    expect(compactObject({ a: null })).toBe(null)
    expect(compactObject(null)).toBe(null)
  })
})

// MIAORG.1 Task 4 — the quiet-hours opt-out and the ORG editor's body.
describe('quiet hours opt-out in the studio body (T4-A)', () => {
  it('{ off: true } is sent alone; otherwise both ends or nothing', async () => {
    const { buildQuietHoursPayload } = await import('./save-payload')
    expect(buildQuietHoursPayload({ start: null, end: null, tz: null, off: true })).toEqual({ off: true })
    expect(buildQuietHoursPayload({ start: '21:00', end: '07:00', off: false })).toEqual({ start: '21:00', end: '07:00', tz: null })
    expect(buildQuietHoursPayload({ start: '21:00' })).toBe(null)
    expect(buildQuietHoursPayload(null)).toBe(null)
  })

  it('a studio that ticks "No quiet hours" stores { off: true } and resolves to none under an org window', () => {
    const shown = { ...shownFor({ enabled: true }), quiet_hours: { start: null, end: null, tz: null, off: true } }
    const { blob } = saveThroughPut(shown, ['quiet_hours.off'])
    expect(blob.quiet_hours).toEqual({ off: true })
    const resolved = mergeAgentSettings({ org: { quiet_hours: { start: '22:00', end: '07:00' } }, studio: blob }).settings
    expect([resolved.quiet_hours.start, resolved.quiet_hours.end]).toEqual([null, null])
  })
})

describe('buildOrgSavePayload (the org editor body)', () => {
  it('drops exactly the keys an organisation cannot hold', async () => {
    const { ORG_PAYLOAD_DROPPED_KEYS } = await import('./save-payload')
    const { ORG_REFUSED_KEYS } = await import('@/lib/agent/settings-contract')
    expect([...ORG_PAYLOAD_DROPPED_KEYS].sort()).toEqual([...ORG_REFUSED_KEYS].sort())
  })

  it('round trip: a stored org layer, loaded and saved untouched, stores the same layer', async () => {
    const { buildOrgSavePayload } = await import('./save-payload')
    const { OrgSettingsSchema, buildOrgLayer, orgSettingsRefusals } = await import('@/lib/agent/settings-contract')
    const layer = {
      tone: 'Org tone', agent_name: 'Ava', handoff_cooldown_hours: 0, effort: 'high',
      followups: { enabled: true, daily_cap: 80 }, inline_suggestion: { enabled: false },
      quiet_hours: { start: '22:00', end: '07:00' }, limits: { max_replies_per_location_per_day: 300 },
    }
    const shown = mergeAgentSettings({ org: layer, studio: null }).settings
    const body = JSON.parse(JSON.stringify(buildOrgSavePayload(shown, initialOverridden(layer), 'org-1')))
    expect(orgSettingsRefusals(body.settings, body.overridden)).toEqual([])
    const parsed = OrgSettingsSchema.parse(body.settings)
    expect(buildOrgLayer(parsed, body.overridden, { sent: body.settings })).toEqual(layer)
  })
})
