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
import {
  buildSavePayload, buildOrgSavePayload, numberOrNull, compactObject, bookingLinkErrors, bookingIssuesFromResponse,
  buildTrialDonePayload, trialDoneErrors, ORG_PAYLOAD_DROPPED_KEYS,
} from './save-payload'
import { DEFAULTS } from '@/lib/agent/settings-contract'

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

// MIAORG.1 final review — the Booking link fields (studio-only, always saved).
describe('booking link: editor state -> PUT body -> stored blob', () => {
  const HATCH = { enabled: false, test_mode: true, test_phones: ['+353870000000'] }

  it('an edited link and label are stored, trimmed, whatever `overridden` says', () => {
    const shown = { ...shownFor(HATCH), booking_url: ' https://book.example.test/hatch ', booking_cta_label: ' Book now ' }
    const { blob } = saveThroughPut(shown, [])
    expect(blob.booking_url).toBe('https://book.example.test/hatch')
    expect(blob.booking_cta_label).toBe('Book now')
    expect(mergeAgentSettings({ org: { booking_url: 'https://org.example.test' }, studio: blob }).settings.booking_url).toBe('https://book.example.test/hatch')
  })

  it('a blank link (or label) saves null', () => {
    const shown = { ...shownFor({ ...HATCH, booking_url: 'https://old.example.test', booking_cta_label: 'Go' }), booking_url: '  ', booking_cta_label: '' }
    const { blob } = saveThroughPut(shown, [])
    expect(blob.booking_url).toBe(null)
    expect(blob.booking_cta_label).toBe(null)
  })

  it('a non-http(s) link or a 21-character label is refused by the PUT schema', () => {
    for (const bad of [{ booking_url: 'javascript:alert(1)' }, { booking_url: 'ftp://x.example.test' }, { booking_cta_label: 'x'.repeat(21) }]) {
      const sent = JSON.parse(JSON.stringify(buildSavePayload({ ...shownFor(HATCH), ...bad }, [])))
      expect(StudioSettingsSchema.safeParse(sent).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('bookingLinkErrors agrees with the PUT schema on the cases the editor checks', () => {
    for (const [settings, ok] of [
      [{}, true], [{ booking_url: '' }, true], [{ booking_url: 'https://a.example.test/x' }, true], [{ booking_url: 'http://a.example.test' }, true],
      [{ booking_url: 'javascript:alert(1)' }, false], [{ booking_url: 'ftp://a.example.test' }, false], [{ booking_url: 'book.example.test' }, false],
      [{ booking_url: 'https://' + 'a'.repeat(500) + '.test' }, false],
      [{ booking_cta_label: 'Book a class' }, true], [{ booking_cta_label: 'x'.repeat(20) }, true], [{ booking_cta_label: 'x'.repeat(21) }, false],
    ]) {
      const sent = JSON.parse(JSON.stringify(buildSavePayload({ ...shownFor(HATCH), ...settings }, [])))
      expect(Object.keys(bookingLinkErrors(settings)).length === 0, JSON.stringify(settings)).toBe(ok)
      expect(StudioSettingsSchema.safeParse(sent).success, JSON.stringify(settings)).toBe(ok)
    }
  })

  it('bookingIssuesFromResponse maps the two fields and ignores the rest', () => {
    expect(bookingIssuesFromResponse([{ path: 'booking_url', message: 'Invalid input' }, { path: 'booking_cta_label', message: 'Too long' }, { path: 'tone', message: 'x' }]))
      .toEqual({ booking_url: 'Enter a full link starting with https:// (or http://).', booking_cta_label: 'Too long' })
    expect(bookingIssuesFromResponse(undefined)).toEqual({})
  })

  it('Stillorgan (no link stored) still saves no link', () => {
    const { blob } = saveThroughPut(shownFor(STILLORGAN_BLOB), initialOverridden(STILLORGAN_BLOB))
    expect(blob.booking_url ?? null).toBe(STILLORGAN_BLOB.booking_url ?? null)
    expect(blob.monthly_points_target).toBe(STILLORGAN_BLOB.monthly_points_target)
  })
})

describe('MIAHATCH.4 Hatch copy keys through the real save payload', () => {
  const KEYS = [
    'chat_booking_unavailable_text', 'purchase_offer_intro_text', 'purchase_link_text', 'trial_used_text', 'refund_request_text',
    'purchase_link_open_text', 'purchase_paid_booked_text', 'purchase_paid_class_gone_text', 'purchase_paid_booking_failed_text',
    'purchase_paid_no_class_text', 'pay_done_page_text', 'pay_cancel_page_text',
  ]
  const shown = shownFor({ enabled: true })

  it('the payload carries every key, trimmed, blank as null', () => {
    const p = buildSavePayload({ ...shown, purchase_link_text: '  Pay {product}  ', pay_done_page_text: '   ' }, [])
    for (const k of KEYS) expect(p, k).toHaveProperty(k)
    expect(p.purchase_link_text).toBe('Pay {product}')
    expect(p.pay_done_page_text).toBe(null)
    expect(p.refund_request_text).toBe(null)
  })

  it('an overridden value is stored by the PUT and resolves; a studio blank leaves the org value showing', () => {
    const studioSaved = saveThroughPut({ ...shown, trial_used_text: 'Studio trial text.', refund_request_text: '' }, ['trial_used_text', 'refund_request_text']).blob
    expect(studioSaved.trial_used_text).toBe('Studio trial text.')
    expect(studioSaved).not.toHaveProperty('refund_request_text')
    const resolved = mergeAgentSettings({ org: { refund_request_text: 'Org refund.' }, studio: studioSaved }).settings
    expect(resolved.refund_request_text).toBe('Org refund.')
    expect(resolved.trial_used_text).toBe('Studio trial text.')
  })

  it('buildOrgSavePayload carries them too', () => {
    const { settings } = buildOrgSavePayload({ ...shown, purchase_paid_booked_text: 'Booked {class}.' }, ['purchase_paid_booked_text'], 'org1')
    expect(settings.purchase_paid_booked_text).toBe('Booked {class}.')
  })
})

// MIAHATCH.5 (Ruling 25) — Mia's chat booking switch at a un1t.online studio:
// studio-only, always saved, a real boolean.
describe('un1t_chat_actions_enabled: editor state -> PUT body -> stored blob', () => {
  const HATCH = { enabled: true, test_mode: false }

  it('ticked is stored true, whatever `overridden` says; unticked or never set is false', () => {
    expect(buildSavePayload({ ...shownFor(HATCH), un1t_chat_actions_enabled: true }, []).un1t_chat_actions_enabled).toBe(true)
    expect(saveThroughPut({ ...shownFor(HATCH), un1t_chat_actions_enabled: true }, []).blob.un1t_chat_actions_enabled).toBe(true)
    expect(saveThroughPut({ ...shownFor({ ...HATCH, un1t_chat_actions_enabled: true }), un1t_chat_actions_enabled: false }, []).blob.un1t_chat_actions_enabled).toBe(false)
    expect(saveThroughPut(shownFor(HATCH), []).blob.un1t_chat_actions_enabled).toBe(false)
    expect(buildSavePayload({ ...shownFor(HATCH), un1t_chat_actions_enabled: 'yes' }, []).un1t_chat_actions_enabled).toBe(false)
  })

  it('a saved true survives a re-save untouched (idempotent)', () => {
    const { blob } = saveThroughPut({ ...shownFor(HATCH), un1t_chat_actions_enabled: true }, [])
    expect(saveThroughPut(shownFor(blob), initialOverridden(blob)).blob).toEqual(blob)
  })
})

// TRIALDONE.3 — the studio-only trial-finisher block: editor state -> PUT body
// -> stored blob. Studio-only: the org editor never sends it.
describe('trial_done: editor state -> PUT body -> stored blob', () => {
  const HATCH = { enabled: true }
  const ID_A = '11111111-1111-4111-8111-111111111111'
  const ID_B = '22222222-2222-4222-8222-222222222222'

  it('the editor shows the default block (off) for a studio that never set it', () => {
    expect(shownFor(HATCH).trial_done).toEqual(DEFAULTS.trial_done)
  })

  it('an untouched block is stored whole and off; a second save is idempotent', () => {
    const { blob } = saveThroughPut(shownFor(HATCH), [])
    expect(blob.trial_done).toEqual(DEFAULTS.trial_done)
    expect(saveThroughPut(shownFor(blob), initialOverridden(blob)).blob).toEqual(blob)
  })

  it('every edited field reaches the stored blob, whatever `overridden` says', () => {
    const edited = {
      ...DEFAULTS.trial_done, enabled: true, delay_hours: '5', opener_template: '  my_opener  ', followup_template: 'my_followup',
      mia_instruction: '  Help them carry on.  ', only_contact_ids_text: `${ID_A}, ${ID_B}\n${ID_A}`,
    }
    const { blob } = saveThroughPut({ ...shownFor(HATCH), trial_done: edited }, [])
    expect(blob.trial_done).toEqual({
      ...DEFAULTS.trial_done, enabled: true, delay_hours: 5, opener_template: 'my_opener', followup_template: 'my_followup',
      mia_instruction: 'Help them carry on.', only_contact_ids: [ID_A, ID_B],
    })
  })

  it('a cleared field is left out of the body, so the default fills in (never null)', () => {
    const body = JSON.parse(JSON.stringify(buildTrialDonePayload({ ...DEFAULTS.trial_done, delay_hours: '', opener_template: '  ', mia_instruction: '' })))
    expect(body).not.toHaveProperty('delay_hours')
    expect(body).not.toHaveProperty('opener_template')
    expect(body).not.toHaveProperty('mia_instruction')
    expect(StudioSettingsSchema.safeParse({ enabled: true, trial_done: body }).success).toBe(true)
  })

  it('no block in the editor state sends none (an older GET never writes defaults over a stored block)', () => {
    expect(buildTrialDonePayload(undefined)).toBe(undefined)
    expect('trial_done' in JSON.parse(JSON.stringify(buildSavePayload({ ...shownFor(HATCH), trial_done: undefined }, [])))).toBe(false)
  })

  it('the org editor never sends it', () => {
    expect(ORG_PAYLOAD_DROPPED_KEYS).toContain('trial_done')
    expect(buildOrgSavePayload({ ...shownFor(HATCH), trial_done: { ...DEFAULTS.trial_done, enabled: true } }, [], 'org1').settings).not.toHaveProperty('trial_done')
  })

  it('trialDoneErrors names what the PUT would refuse', () => {
    expect(trialDoneErrors({ trial_done: DEFAULTS.trial_done })).toEqual({})
    expect(trialDoneErrors({})).toEqual({})
    const bad = trialDoneErrors({ trial_done: {
      ...DEFAULTS.trial_done, delay_hours: 0, opener_template: 'Has Caps', followup_template: 'ok_name',
      mia_instruction: 'Welcome \u2014 hi', only_contact_ids_text: 'nope',
    } })
    expect(Object.keys(bad).sort()).toEqual(['delay_hours', 'mia_instruction', 'only_contact_ids', 'opener_template'])
    expect(trialDoneErrors({ trial_done: { ...DEFAULTS.trial_done, delay_hours: 2.5 } })).toHaveProperty('delay_hours')
    expect(trialDoneErrors({ trial_done: { ...DEFAULTS.trial_done, delay_hours: 73 } })).toHaveProperty('delay_hours')
    expect(trialDoneErrors({ trial_done: { ...DEFAULTS.trial_done, delay_hours: '' } })).toEqual({})
    expect(trialDoneErrors({ trial_done: { ...DEFAULTS.trial_done, mia_instruction: 'x'.repeat(1001) } })).toHaveProperty('mia_instruction')
    const many = Array.from({ length: 21 }, (_, i) => `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`).join('\n')
    expect(trialDoneErrors({ trial_done: { ...DEFAULTS.trial_done, only_contact_ids_text: many } })).toHaveProperty('only_contact_ids')
  })
})
