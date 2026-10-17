// MIAORG.1 — the Mia settings resolver: DEFAULTS <- org <- studio. Fictional ids.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { logError, logWarn } from '@/lib/log'
import { mergeAgentSettings, resolveAgentSettings, resolveAgentSettingsForLocation } from './settings-resolve'
import { DEFAULTS, STUDIO_ONLY_KEYS } from './settings-contract'

const LOC = 'a0000000-0000-0000-0000-0000000000a1'
const ORG = 'b0000000-0000-0000-0000-0000000000b1'

describe('mergeAgentSettings', () => {
  it('with no org and no studio blob it is DEFAULTS, every source "default"', () => {
    const { settings, sources } = mergeAgentSettings({ org: null, studio: null })
    expect(settings).toEqual(DEFAULTS)
    expect(Object.values(sources).every((s) => s === 'default')).toBe(true)
    expect(Object.keys(sources).sort()).toEqual(Object.keys(DEFAULTS).sort())
  })

  it('does not hand out (or mutate) the DEFAULTS objects', () => {
    const { settings } = mergeAgentSettings({ org: null, studio: null })
    settings.followups.daily_cap = 999
    expect(DEFAULTS.followups.daily_cap).toBe(50)
  })

  it('a studio blob with no org resolves exactly to DEFAULTS <- studio (no behaviour change on deploy)', () => {
    const studio = { enabled: true, test_mode: false, tone: 'Warm', handoff_cooldown_hours: 6, followups: { enabled: true, nudge_after_hours: 4, template_name: 'nudge', daily_cap: 30 } }
    const { settings } = mergeAgentSettings({ org: null, studio })
    expect(settings).toEqual({ ...DEFAULTS, ...studio })
  })

  it('studio beats org beats default; null at the studio means inherit', () => {
    const { settings, sources } = mergeAgentSettings({
      org: { tone: 'Org tone', extra_rules: 'Org rules', agent_name: 'Org Mia', holding_message: 'Org hold' },
      studio: { tone: 'Studio tone', extra_rules: null, agent_name: undefined },
    })
    expect(settings.tone).toBe('Studio tone')
    expect(settings.extra_rules).toBe('Org rules')
    expect(settings.agent_name).toBe('Org Mia')
    expect(settings.holding_message).toBe('Org hold')
    expect(settings.welcome_greeting).toBe(null)
    expect(sources.tone).toBe('studio')
    expect(sources.extra_rules).toBe('org')
    expect(sources.agent_name).toBe('org')
    expect(sources.welcome_greeting).toBe('default')
  })

  it('falsy-but-set values count as set (0, false, empty array)', () => {
    const { settings, sources } = mergeAgentSettings({
      org: { auto_resolve_stale_hours: 24, handoff_cooldown_hours: 12 },
      studio: { auto_resolve_stale_hours: 0 },
    })
    expect(settings.auto_resolve_stale_hours).toBe(0)
    expect(sources.auto_resolve_stale_hours).toBe('studio')
  })

  it('NEVER inherits a studio-only key from the org, whatever the org holds', () => {
    const org = {
      enabled: true, test_mode: true, test_phones: ['15555550100'], consultation_event_type_id: 'evt-1',
      booking_mode: 'draft', cancellation_form: { form_intro: 'x' }, booking_url: 'https://example.com/book',
      booking_cta_label: 'Book', membership_signup_url: 'https://example.com/join', membership_cta_label: 'Join',
    }
    const { settings, sources } = mergeAgentSettings({ org, studio: null })
    for (const k of STUDIO_ONLY_KEYS) {
      expect(settings[k]).toEqual(DEFAULTS[k])
      expect(sources[k]).toBe('default')
    }
    expect(settings.enabled).toBe(false)
  })

  it('an org enabled:true never turns a studio on; the studio keeps its own value', () => {
    expect(mergeAgentSettings({ org: { enabled: true }, studio: { enabled: false } }).settings.enabled).toBe(false)
    expect(mergeAgentSettings({ org: { enabled: true }, studio: {} }).settings.enabled).toBe(false)
    expect(mergeAgentSettings({ org: { enabled: false }, studio: { enabled: true } }).settings.enabled).toBe(true)
  })

  it('a studio-only key still resolves from the studio itself', () => {
    const { settings, sources } = mergeAgentSettings({
      org: { booking_mode: 'draft' },
      studio: { booking_mode: 'auto', booking_url: 'https://un1t.online/hatch', test_phones: ['15555550101'] },
    })
    expect(settings.booking_mode).toBe('auto')
    expect(settings.booking_url).toBe('https://un1t.online/hatch')
    expect(settings.test_phones).toEqual(['15555550101'])
    expect(sources.booking_url).toBe('studio')
  })

  it('object keys merge per field, org under studio', () => {
    const { settings } = mergeAgentSettings({
      org: {
        limits: { max_replies_per_conversation_per_hour: 10, max_replies_per_location_per_day: 300 },
        followups: { enabled: true, nudge_after_hours: 5, template_name: 'org_nudge', daily_cap: 80 },
        quiet_hours: { start: '22:00', end: '07:00', tz: null },
      },
      studio: {
        limits: { max_replies_per_location_per_day: 100 },
        followups: { daily_cap: 20 },
      },
    })
    expect(settings.limits).toEqual({ max_replies_per_conversation_per_hour: 10, max_replies_per_location_per_day: 100 })
    expect(settings.followups).toEqual({ enabled: true, nudge_after_hours: 5, template_name: 'org_nudge', daily_cap: 20 })
    expect(settings.quiet_hours).toEqual({ start: '22:00', end: '07:00', tz: null })
  })

  it('a null field never blanks a value from a lower layer, but is carried where none exists', () => {
    const { settings } = mergeAgentSettings({
      org: { followups: { enabled: true, nudge_after_hours: null, template_name: null } },
      studio: { quiet_hours: { start: '22:00', end: '07:00', tz: null }, followups: { daily_cap: null } },
    })
    expect(settings.followups).toEqual({ enabled: true, nudge_after_hours: 3, template_name: null, daily_cap: 50 })
    expect(settings.quiet_hours).toEqual({ start: '22:00', end: '07:00', tz: null })
  })

  it('an object key set only at the org overlays the code default per field', () => {
    const { settings } = mergeAgentSettings({ org: { followups: { enabled: true } }, studio: null })
    expect(settings.followups).toEqual({ ...DEFAULTS.followups, enabled: true })
  })

  it('a studio object null means inherit; a non-object value merges nothing', () => {
    const org = { limits: { max_replies_per_location_per_day: 300 }, quiet_hours: { start: '22:00', end: '07:00' } }
    const a = mergeAgentSettings({ org, studio: { limits: null, quiet_hours: null } })
    expect(a.settings.limits).toEqual({ max_replies_per_location_per_day: 300 })
    expect(a.settings.quiet_hours).toEqual({ start: '22:00', end: '07:00' })
    // quiet_hours is only merged when it is an object: a stray string/array is ignored, not spread
    const b = mergeAgentSettings({ org: { quiet_hours: 'late' }, studio: { quiet_hours: ['x'] } })
    expect(b.settings.quiet_hours).toBe(null)
    expect(b.sources.quiet_hours).toBe('default')
  })

  it('sources for object keys: studio if the studio set ANY field, else org if the org did, else default', () => {
    const { sources } = mergeAgentSettings({
      org: { limits: { max_replies_per_location_per_day: 300 }, followups: { enabled: true } },
      studio: { followups: { daily_cap: 20 }, first_class_checkin: { enabled: null } },
    })
    expect(sources.followups).toBe('studio')
    expect(sources.limits).toBe('org')
    expect(sources.first_class_checkin).toBe('default')
    expect(sources.inline_suggestion).toBe('default')
    expect(sources.quiet_hours).toBe('default')
  })

  it('a stored key the contract no longer knows survives from the studio (no silent drop)', () => {
    const { settings, sources } = mergeAgentSettings({ org: null, studio: { legacy_thing: 7 } })
    expect(settings.legacy_thing).toBe(7)
    expect(sources.legacy_thing).toBe('studio')
  })

  it('non-object blobs are treated as absent', () => {
    expect(mergeAgentSettings({ org: 'x', studio: [1] }).settings).toEqual(DEFAULTS)
  })
})

// A tiny supabase-shaped fake: from(t).select().eq().maybeSingle() resolving { data, error }.
function fakeDb({ locations, orgSettings }) {
  const calls = []
  return {
    calls,
    from(table) {
      const q = { table, filters: {} }
      const chain = {
        select(cols) { q.cols = cols; return chain },
        eq(k, v) { q.filters[k] = v; return chain },
        maybeSingle() {
          calls.push({ ...q })
          const src = table === 'locations' ? locations : table === 'org_settings' ? orgSettings : null
          if (typeof src === 'function') return Promise.resolve().then(src)
          return Promise.resolve(src)
        },
      }
      return chain
    },
  }
}
// MIAORG.1 Task 5 — membership_source rides on the row (Mia's capability).
const locRow = (settings = null) => ({ id: LOC, name: 'Hatch', timezone: 'Europe/Dublin', organization_id: ORG, membership_source: 'un1t_online', settings })

describe('resolveAgentSettings', () => {
  beforeEach(() => vi.clearAllMocks())

  it('merges org under studio and returns the raw layers + the location row', async () => {
    const db = fakeDb({
      locations: { data: locRow({ customer_agent: { enabled: true, tone: 'Studio' }, wa_card_sets: { a: 1 } }), error: null },
      orgSettings: { data: { customer_agent: { tone: 'Org', extra_rules: 'Org rules' } }, error: null },
    })
    const r = await resolveAgentSettings(db, LOC)
    expect(r.ok).toBe(true)
    expect(r.settings.enabled).toBe(true)
    expect(r.settings.tone).toBe('Studio')
    expect(r.settings.extra_rules).toBe('Org rules')
    expect(r.sources.extra_rules).toBe('org')
    expect(r.studio).toEqual({ enabled: true, tone: 'Studio' })
    expect(r.org).toEqual({ tone: 'Org', extra_rules: 'Org rules' })
    expect(r.location).toEqual(locRow({ customer_agent: { enabled: true, tone: 'Studio' }, wa_card_sets: { a: 1 } }))
    expect(db.calls[0].filters).toEqual({ id: LOC })
    expect(db.calls[0].cols).toBe('id, name, timezone, organization_id, membership_source, settings')
    expect(r.location.membership_source).toBe('un1t_online')
    expect(db.calls[1].filters).toEqual({ organization_id: ORG })
  })

  it('org column NULL, or no org_settings row: the studio resolves as it does today', async () => {
    const studio = { enabled: true, tone: 'Studio' }
    for (const orgSettings of [{ data: { customer_agent: null }, error: null }, { data: null, error: null }]) {
      const db = fakeDb({ locations: { data: locRow({ customer_agent: studio }), error: null }, orgSettings })
      const r = await resolveAgentSettings(db, LOC)
      expect(r.ok).toBe(true)
      expect(r.org).toBe(null)
      expect(r.settings).toEqual({ ...DEFAULTS, ...studio })
    }
    expect(logError).not.toHaveBeenCalled()
  })

  it('a studio with no blob at all (Hatch) resolves off: enabled false, studio null', async () => {
    const db = fakeDb({
      locations: { data: locRow({}), error: null },
      orgSettings: { data: { customer_agent: { enabled: true, tone: 'Org' } }, error: null },
    })
    const r = await resolveAgentSettings(db, LOC)
    expect(r.ok).toBe(true)
    expect(r.studio).toBe(null)
    expect(r.settings.enabled).toBe(false)
    expect(r.settings.tone).toBe('Org')
  })

  it('org read ERROR: logged, resolves without the org layer, org null', async () => {
    const db = fakeDb({
      locations: { data: locRow({ customer_agent: { enabled: true, tone: 'Studio' } }), error: null },
      orgSettings: { data: null, error: { message: 'boom', code: '57014' } },
    })
    const r = await resolveAgentSettings(db, LOC)
    expect(r.ok).toBe(true)
    expect(r.org).toBe(null)
    expect(r.settings).toEqual({ ...DEFAULTS, enabled: true, tone: 'Studio' })
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError.mock.calls[0][0]).toBe('agent-settings')
  })

  it('org read THROWS: same as an error, never louder', async () => {
    const db = fakeDb({
      locations: { data: locRow({ customer_agent: { enabled: true } }), error: null },
      orgSettings: () => { throw new Error('network') },
    })
    const r = await resolveAgentSettings(db, LOC)
    expect(r.ok).toBe(true)
    expect(r.org).toBe(null)
    expect(logError).toHaveBeenCalledTimes(1)
  })

  // MIAORG.1 final review — defence in depth behind mig 729's write fence.
  it('an INVALID org layer (one the org editor would refuse) is logged and treated as no org layer', async () => {
    const studio = { enabled: true, tone: 'Studio' }
    for (const bad of [
      { handoff_after_verify_failures: 0, tone: 'Org' }, // would switch off the verify-fail net
      { effort: 'turbo' },
      { limits: { max_replies_per_location_per_day: -5 } },
      { quiet_hours: { start: '22:00' } }, // half a window
      { tone: 42 },
    ]) {
      vi.clearAllMocks()
      const db = fakeDb({ locations: { data: locRow({ customer_agent: studio }), error: null }, orgSettings: { data: { customer_agent: bad }, error: null } })
      const r = await resolveAgentSettings(db, LOC)
      expect(r.ok).toBe(true)
      expect(r.org).toBe(null)
      expect(r.settings).toEqual({ ...DEFAULTS, ...studio })
      expect(r.settings.handoff_after_verify_failures).toBe(null) // core.js's default (2) applies, never 0
      expect(logError).toHaveBeenCalledTimes(1)
      expect(logError.mock.calls[0][0]).toBe('agent-settings')
      expect(logError.mock.calls[0][1]).toMatch(/invalid/)
      expect(logError.mock.calls[0][2]).toMatchObject({ locationId: LOC, organizationId: ORG })
      expect(logError.mock.calls[0][2].issues.length).toBeGreaterThan(0)
    }
  })

  it('a VALID org layer is used RAW: no schema default fills a field the organisation never set', async () => {
    const db = fakeDb({
      locations: { data: locRow({ customer_agent: { enabled: true } }), error: null },
      orgSettings: { data: { customer_agent: { followups: { template_name: 'nudge_v2' }, enabled: true } }, error: null },
    })
    const r = await resolveAgentSettings(db, LOC)
    expect(r.org).toEqual({ followups: { template_name: 'nudge_v2' }, enabled: true })
    // DEFAULTS' followups under the org's one field; nothing the parse would add
    expect(r.settings.followups).toEqual({ ...DEFAULTS.followups, template_name: 'nudge_v2' })
    expect(r.settings.enabled).toBe(true) // the studio's own, never the org's
    expect(logError).not.toHaveBeenCalled()
  })

  it('studio read error -> { ok:false, reason:"read_failed" } and the org is not even read', async () => {
    const db = fakeDb({ locations: { data: null, error: { message: 'down' } }, orgSettings: { data: { customer_agent: { tone: 'x' } }, error: null } })
    expect(await resolveAgentSettings(db, LOC)).toEqual({ ok: false, reason: 'read_failed' })
    expect(db.calls).toHaveLength(1)
  })

  it('studio read throws -> read_failed', async () => {
    const db = fakeDb({ locations: () => { throw new Error('network') }, orgSettings: { data: null, error: null } })
    expect(await resolveAgentSettings(db, LOC)).toEqual({ ok: false, reason: 'read_failed' })
  })

  it('no such location -> { ok:false, reason:"not_found" }', async () => {
    const db = fakeDb({ locations: { data: null, error: null }, orgSettings: { data: null, error: null } })
    expect(await resolveAgentSettings(db, LOC)).toEqual({ ok: false, reason: 'not_found' })
  })

  it('no locationId -> not_found without a query; a location with no org skips the org read', async () => {
    const db = fakeDb({ locations: { data: { ...locRow({ customer_agent: { enabled: true } }), organization_id: null }, error: null }, orgSettings: { data: null, error: null } })
    expect(await resolveAgentSettings(db, null)).toEqual({ ok: false, reason: 'not_found' })
    expect(db.calls).toHaveLength(0)
    const r = await resolveAgentSettings(db, LOC)
    expect(r.ok).toBe(true)
    expect(r.org).toBe(null)
    expect(db.calls).toHaveLength(1)
  })
})

// MIAORG.1 Task 2 — callers that loop every location resolve per row and read
// each organisation's layer once per run (orgCache), never once per studio.
describe('resolveAgentSettingsForLocation + orgCache', () => {
  beforeEach(() => vi.clearAllMocks())
  const LOC2 = 'a0000000-0000-0000-0000-0000000000a2'
  const ORG2 = 'b0000000-0000-0000-0000-0000000000b2'

  it('resolves a location row already in hand without re-reading the studio', async () => {
    const db = fakeDb({ locations: { data: null, error: { message: 'must not be read' } }, orgSettings: { data: { customer_agent: { tone: 'Org' } }, error: null } })
    const r = await resolveAgentSettingsForLocation(db, locRow({ customer_agent: { enabled: true } }))
    expect(r.ok).toBe(true)
    expect(r.settings.enabled).toBe(true)
    expect(r.settings.tone).toBe('Org')
    expect(db.calls.map((c) => c.table)).toEqual(['org_settings'])
  })

  it('a row whose select left organization_id OFF is re-read by id (logged), so the org layer still arrives', async () => {
    const db = fakeDb({ locations: { data: locRow({ customer_agent: { enabled: true } }), error: null }, orgSettings: { data: { customer_agent: { tone: 'Org' } }, error: null } })
    const narrow = { id: LOC, name: 'Hatch', settings: { customer_agent: { enabled: true } } } // no organization_id key
    const r = await resolveAgentSettingsForLocation(db, narrow)
    expect(r.ok).toBe(true)
    expect(r.settings.tone).toBe('Org')
    expect(r.location.organization_id).toBe(ORG)
    expect(db.calls.map((c) => c.table)).toEqual(['locations', 'org_settings'])
    expect(db.calls[0].filters).toEqual({ id: LOC })
    expect(logWarn).toHaveBeenCalledTimes(1)
    expect(logWarn.mock.calls[0][0]).toBe('agent-settings')
  })

  it('organization_id: null means no organisation: no org layer, no extra read, nothing logged', async () => {
    const db = fakeDb({ locations: { data: null, error: { message: 'must not be read' } }, orgSettings: { data: { customer_agent: { tone: 'Org' } }, error: null } })
    const r = await resolveAgentSettingsForLocation(db, { ...locRow({ customer_agent: { enabled: true } }), organization_id: null })
    expect(r.ok).toBe(true)
    expect(r.org).toBe(null)
    expect(r.settings.tone).toBe(null)
    expect(db.calls).toHaveLength(0)
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('a studio row read without an organization_id column (a narrow fake) never loops', async () => {
    const db = fakeDb({ locations: { data: { id: LOC, settings: { customer_agent: { enabled: true } } }, error: null }, orgSettings: { data: null, error: null } })
    const r = await resolveAgentSettings(db, LOC)
    expect(r.ok).toBe(true)
    expect(r.location.organization_id).toBe(null)
    expect(db.calls).toHaveLength(1)
  })

  it('a missing row is not_found, with no query', async () => {
    const db = fakeDb({ locations: { data: null, error: null }, orgSettings: { data: null, error: null } })
    expect(await resolveAgentSettingsForLocation(db, null)).toEqual({ ok: false, reason: 'not_found' })
    expect(db.calls).toHaveLength(0)
  })

  it('orgCache: one org read per organisation per run, shared across its studios', async () => {
    const db = fakeDb({ locations: { data: null, error: null }, orgSettings: { data: { customer_agent: { tone: 'Org' } }, error: null } })
    const orgCache = new Map()
    const rows = [locRow({ customer_agent: { enabled: true } }), { ...locRow({}), id: LOC2 }, { ...locRow({}), id: 'a3', organization_id: ORG2 }]
    const out = []
    for (const row of rows) out.push(await resolveAgentSettingsForLocation(db, row, { orgCache }))
    expect(out.every((r) => r.ok && r.settings.tone === 'Org')).toBe(true)
    expect(db.calls.filter((c) => c.table === 'org_settings').map((c) => c.filters.organization_id)).toEqual([ORG, ORG2])
  })

  it('orgCache: a failed org read is logged once and the run resolves without the org layer', async () => {
    const db = fakeDb({ locations: { data: null, error: null }, orgSettings: { data: null, error: { message: 'boom' } } })
    const orgCache = new Map()
    const a = await resolveAgentSettingsForLocation(db, locRow({ customer_agent: { enabled: true, tone: 'Studio' } }), { orgCache })
    const b = await resolveAgentSettingsForLocation(db, { ...locRow({}), id: LOC2 }, { orgCache })
    expect(a.settings).toEqual({ ...DEFAULTS, enabled: true, tone: 'Studio' })
    expect(b.settings).toEqual(DEFAULTS)
    expect(logError).toHaveBeenCalledTimes(1)
  })

  it('resolveAgentSettings takes the same orgCache (backwards-compatible optional param)', async () => {
    const db = fakeDb({ locations: { data: locRow({ customer_agent: { enabled: true } }), error: null }, orgSettings: { data: { customer_agent: { tone: 'Org' } }, error: null } })
    const orgCache = new Map()
    await resolveAgentSettings(db, LOC, { orgCache })
    const r = await resolveAgentSettings(db, LOC, { orgCache })
    expect(r.settings.tone).toBe('Org')
    expect(db.calls.filter((c) => c.table === 'org_settings')).toHaveLength(1)
  })
})
