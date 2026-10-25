// MIA-HYGIENE.1 — the settings write-through contract. The customer-agent PUT
// used to build its persisted object field-by-field, and twice shipped a
// schema key that validated but never got WRITTEN (#495: followups /
// first_class_checkin / agent_name / handoff_cooldown_hours; audit 2026-08-19:
// effort / handoff_after_verify_failures were read live but unreachable from
// the editor). This suite makes the omission a CI failure instead of a silent
// prod drop: every SettingsSchema key must survive into the built blob.
import { describe, it, expect } from 'vitest'
import {
  SettingsSchema, DEFAULTS, buildCustomerAgentSettings, STUDIO_ONLY_KEYS, INHERITABLE_OBJECT_KEYS,
  StudioSettingsSchema, buildStudioOverrideBlob, OrgSettingsSchema, ORG_REFUSED_KEYS,
  TRIAL_DONE_MIA_INSTRUCTION_DEFAULT, orgSettingsRefusals,
} from './settings-contract'
import { INHERITABLE_OBJECT_FIELDS, INHERITABLE_SCALAR_KEYS, initialOverridden } from './settings-overrides'
import { mergeAgentSettings } from './settings-resolve'

// social_enabled is a top-level sibling on locations.settings (written next to
// customer_agent, not inside it) — the one documented exception.
// CANCEL-FORM.2 — glofox_auto_cancel is the locations.glofox_auto_cancel_memberships
// COLUMN, written by the route next to social_enabled.
const SIBLING_KEYS = ['social_enabled', 'glofox_auto_cancel']

describe('settings write-through contract', () => {
  it('every schema key except documented siblings survives into the written blob', () => {
    const parsed = SettingsSchema.parse({ enabled: true })
    const built = buildCustomerAgentSettings(parsed)
    const missing = Object.keys(SettingsSchema.shape)
      .filter((k) => !SIBLING_KEYS.includes(k))
      .filter((k) => !(k in built))
    expect(missing).toEqual([])
  })

  it('effort round-trips; absent → null (core defaults to medium)', () => {
    expect(
      buildCustomerAgentSettings(SettingsSchema.parse({ enabled: true, effort: 'low' })).effort,
    ).toBe('low')
    expect(buildCustomerAgentSettings(SettingsSchema.parse({ enabled: true })).effort).toBe(null)
  })

  it('rejects an effort value outside the enum', () => {
    expect(SettingsSchema.safeParse({ enabled: true, effort: 'ultra' }).success).toBe(false)
  })

  it('handoff_after_verify_failures round-trips; absent → null (core defaults to 2)', () => {
    expect(
      buildCustomerAgentSettings(
        SettingsSchema.parse({ enabled: true, handoff_after_verify_failures: 3 }),
      ).handoff_after_verify_failures,
    ).toBe(3)
    expect(
      buildCustomerAgentSettings(SettingsSchema.parse({ enabled: true }))
        .handoff_after_verify_failures,
    ).toBe(null)
  })

  // PERSON-ACCT.7 — the deterministic script for the two-live-accounts
  // handoff. A customer-facing string that never reaches the blob is the
  // failure mode this whole file exists for (#495).
  it('account_conflict_handoff_text round-trips; blank → null (core default)', () => {
    expect(
      buildCustomerAgentSettings(
        SettingsSchema.parse({ enabled: true, account_conflict_handoff_text: '  Two accounts — a coach will sort it.  ' }),
      ).account_conflict_handoff_text,
    ).toBe('Two accounts — a coach will sort it.')
    expect(
      buildCustomerAgentSettings(SettingsSchema.parse({ enabled: true, account_conflict_handoff_text: '   ' }))
        .account_conflict_handoff_text,
    ).toBe(null)
    expect(DEFAULTS.account_conflict_handoff_text).toBe(null)
  })

  // MIAHATCH.2 — what Mia says when a member at a un1t.online studio asks her
  // to book or cancel a class there (no chat booking in slice 1).
  it('chat_booking_unavailable_text round-trips; blank → null (mia-copy default)', () => {
    expect(
      buildCustomerAgentSettings(
        SettingsSchema.parse({ enabled: true, chat_booking_unavailable_text: '  Book {studio} online: {link}  ' }),
      ).chat_booking_unavailable_text,
    ).toBe('Book {studio} online: {link}')
    expect(
      buildCustomerAgentSettings(SettingsSchema.parse({ enabled: true, chat_booking_unavailable_text: '   ' }))
        .chat_booking_unavailable_text,
    ).toBe(null)
    expect(buildCustomerAgentSettings(SettingsSchema.parse({ enabled: true })).chat_booking_unavailable_text).toBe(null)
    expect(DEFAULTS.chat_booking_unavailable_text).toBe(null)
    expect(SettingsSchema.safeParse({ enabled: true, chat_booking_unavailable_text: 'x'.repeat(501) }).success).toBe(false)
  })

  it('chat_booking_unavailable_text inherits from the org; a studio value wins', () => {
    expect(INHERITABLE_SCALAR_KEYS).toContain('chat_booking_unavailable_text')
    const org = { chat_booking_unavailable_text: 'Org: book {studio} at {link}' }
    const inherited = mergeAgentSettings({ org, studio: { enabled: true } })
    expect(inherited.settings.chat_booking_unavailable_text).toBe('Org: book {studio} at {link}')
    expect(inherited.sources.chat_booking_unavailable_text).toBe('org')
    const own = mergeAgentSettings({ org, studio: { enabled: true, chat_booking_unavailable_text: 'Studio: {link}' } })
    expect(own.settings.chat_booking_unavailable_text).toBe('Studio: {link}')
    expect(own.sources.chat_booking_unavailable_text).toBe('studio')
  })

  // MIAHATCH.4 (spec 6.6) — the slice-2 Hatch booking and payment copy keys.
  const SLICE2_KEYS = [
    'purchase_offer_intro_text', 'purchase_link_text', 'trial_used_text', 'refund_request_text',
    'purchase_link_open_text', 'purchase_paid_booked_text', 'purchase_paid_class_gone_text',
    'purchase_paid_booking_failed_text', 'purchase_paid_no_class_text', 'pay_done_page_text', 'pay_cancel_page_text',
  ]

  it('every slice-2 copy key round-trips through buildCustomerAgentSettings; blank is null', () => {
    for (const key of SLICE2_KEYS) {
      expect(DEFAULTS[key], key).toBe(null)
      expect(buildCustomerAgentSettings(SettingsSchema.parse({ enabled: true, [key]: '  Hello {product}  ' }))[key], key).toBe('Hello {product}')
      expect(buildCustomerAgentSettings(SettingsSchema.parse({ enabled: true, [key]: '   ' }))[key], key).toBe(null)
      expect(buildCustomerAgentSettings(SettingsSchema.parse({ enabled: true }))[key], key).toBe(null)
      expect(SettingsSchema.safeParse({ enabled: true, [key]: 'x'.repeat(501) }).success, key).toBe(false)
    }
  })

  it('each slice-2 copy key is inheritable from the org; a studio value wins', () => {
    for (const key of SLICE2_KEYS) {
      expect(INHERITABLE_SCALAR_KEYS, key).toContain(key)
      const inherited = mergeAgentSettings({ org: { [key]: 'Org text' }, studio: { enabled: true } })
      expect(inherited.settings[key], key).toBe('Org text')
      expect(inherited.sources[key], key).toBe('org')
      const own = mergeAgentSettings({ org: { [key]: 'Org text' }, studio: { enabled: true, [key]: 'Studio text' } })
      expect(own.settings[key], key).toBe('Studio text')
      expect(own.sources[key], key).toBe('studio')
    }
  })
  // FLOWACK.1 — the WhatsApp Flow booking acknowledgement and holding line.
  for (const key of ['flow_booking_ack_text', 'flow_booking_holding_text', 'flow_booking_duplicate_text']) {
    it(`${key} round-trips, blank → null (default-copy), inherits from the org`, () => {
      expect(buildCustomerAgentSettings(SettingsSchema.parse({ enabled: true, [key]: '  We are on it.  ' }))[key]).toBe('We are on it.')
      expect(buildCustomerAgentSettings(SettingsSchema.parse({ enabled: true, [key]: '   ' }))[key]).toBe(null)
      expect(buildCustomerAgentSettings(SettingsSchema.parse({ enabled: true }))[key]).toBe(null)
      expect(DEFAULTS[key]).toBe(null)
      expect(SettingsSchema.safeParse({ enabled: true, [key]: 'x'.repeat(501) }).success).toBe(false)
      expect(INHERITABLE_SCALAR_KEYS).toContain(key)
      const inherited = mergeAgentSettings({ org: { [key]: 'Org text' }, studio: { enabled: true } })
      expect(inherited.settings[key]).toBe('Org text')
      expect(inherited.sources[key]).toBe('org')
    })
  }

  // CANCEL-FORM.2 — the cancellation-form copy block. Null = every code default
  // (lib/cancellation-form/copy.js); an object round-trips with strings trimmed
  // and blanks nulled so the resolver falls back per key.
  it('cancellation_form round-trips as a nested block; absent → null', () => {
    expect(buildCustomerAgentSettings(SettingsSchema.parse({ enabled: true })).cancellation_form).toBe(null)
    const built = buildCustomerAgentSettings(SettingsSchema.parse({
      enabled: true,
      cancellation_form: {
        form_intro: '  Hi {first_name}  ',
        email_subject: '   ',
        pause_max_weeks: 6,
        notice_days: 14,
        pause_offer_enabled: false,
        reason_labels: { price: ' Too dear ' },
        whatsapp_template_name: 'cancellation_form_link',
        public_base_url: 'https://un1tdublin.com',
      },
    }))
    expect(built.cancellation_form.form_intro).toBe('Hi {first_name}')
    expect(built.cancellation_form.email_subject).toBe(null)
    expect(built.cancellation_form.pause_max_weeks).toBe(6)
    expect(built.cancellation_form.notice_days).toBe(14)
    expect(built.cancellation_form.pause_offer_enabled).toBe(false)
    expect(built.cancellation_form.reason_labels).toEqual({ price: 'Too dear' })
    expect(built.cancellation_form.whatsapp_template_name).toBe('cancellation_form_link')
    expect(built.cancellation_form.public_base_url).toBe('https://un1tdublin.com')
    expect(DEFAULTS.cancellation_form).toBe(null)
  })

  it('cancellation_form rejects a non-URL base url and an out-of-range notice period; blank url → null', () => {
    expect(SettingsSchema.safeParse({ enabled: true, cancellation_form: { public_base_url: 'not a url' } }).success).toBe(false)
    expect(SettingsSchema.safeParse({ enabled: true, cancellation_form: { notice_days: 400 } }).success).toBe(false)
    expect(SettingsSchema.safeParse({ enabled: true, cancellation_form: { whatsapp_button_text: 'x'.repeat(21) } }).success).toBe(false)
    const parsed = SettingsSchema.parse({ enabled: true, cancellation_form: { public_base_url: '' } })
    expect(buildCustomerAgentSettings(parsed).cancellation_form.public_base_url).toBe(null)
  })

  it('glofox_auto_cancel parses as a boolean sibling and is NOT written into the blob', () => {
    const parsed = SettingsSchema.parse({ enabled: true, glofox_auto_cancel: true })
    expect(parsed.glofox_auto_cancel).toBe(true)
    expect(SettingsSchema.parse({ enabled: true }).glofox_auto_cancel).toBe(false)
    expect('glofox_auto_cancel' in buildCustomerAgentSettings(parsed)).toBe(false)
  })

  it('existing transforms hold: trim-to-null, agent_name default, nested merges', () => {
    const built = buildCustomerAgentSettings(
      SettingsSchema.parse({
        enabled: true,
        tone: '  ',
        agent_name: ' ',
        followups: { enabled: true },
      }),
    )
    expect(built.tone).toBe(null)
    expect(built.agent_name).toBe(DEFAULTS.agent_name)
    expect(built.followups).toEqual({ ...DEFAULTS.followups, enabled: true })
  })

  // MIAORG.1 — the keys a studio decides for itself; the org layer never supplies them.
  it('STUDIO_ONLY_KEYS is exactly the agreed list, all real settings keys', () => {
    expect([...STUDIO_ONLY_KEYS].sort()).toEqual([
      'booking_cta_label', 'booking_mode', 'booking_url', 'cancellation_form',
      'consultation_event_type_id', 'enabled', 'membership_cta_label',
      'membership_signup_url', 'monthly_points_target', 'test_mode', 'test_phones',
      'trial_done', 'un1t_chat_actions_enabled',
    ])
    for (const k of STUDIO_ONLY_KEYS) expect(k in DEFAULTS).toBe(true)
    expect(INHERITABLE_OBJECT_KEYS).toEqual(['limits', 'followups', 'first_class_checkin', 'inline_suggestion', 'quiet_hours'])
  })

  // MIAHATCH.5 (Ruling 25) — Mia's switch for booking, cancelling and refund
  // requests in chat at a un1t.online studio. Studio-only (an organisation can
  // never switch it on for every studio), default false, a real boolean only.
  it('un1t_chat_actions_enabled: studio-only boolean, default false, round-trips', () => {
    expect(DEFAULTS.un1t_chat_actions_enabled).toBe(false)
    expect(STUDIO_ONLY_KEYS.has('un1t_chat_actions_enabled')).toBe(true)
    expect(INHERITABLE_SCALAR_KEYS).not.toContain('un1t_chat_actions_enabled')
    expect(SettingsSchema.parse({ enabled: true }).un1t_chat_actions_enabled).toBe(false)
    expect(buildCustomerAgentSettings(SettingsSchema.parse({ enabled: true, un1t_chat_actions_enabled: true })).un1t_chat_actions_enabled).toBe(true)
    expect(buildCustomerAgentSettings(SettingsSchema.parse({ enabled: true })).un1t_chat_actions_enabled).toBe(false)
    for (const bad of ['true', 1, 'yes']) expect(SettingsSchema.safeParse({ enabled: true, un1t_chat_actions_enabled: bad }).success, String(bad)).toBe(false)
    // Always saved by the studio editor, whatever `overridden` says.
    const data = StudioSettingsSchema.parse({ enabled: true, un1t_chat_actions_enabled: true })
    expect(buildStudioOverrideBlob(data, [])).toMatchObject({ un1t_chat_actions_enabled: true })
    // Never from the organisation layer.
    expect(ORG_REFUSED_KEYS.has('un1t_chat_actions_enabled')).toBe(true)
    expect('un1t_chat_actions_enabled' in OrgSettingsSchema.shape).toBe(false)
    expect(mergeAgentSettings({ org: { un1t_chat_actions_enabled: true }, studio: { enabled: true } }).settings.un1t_chat_actions_enabled).toBe(false)
    expect(mergeAgentSettings({ org: null, studio: { enabled: true, un1t_chat_actions_enabled: true } }).settings.un1t_chat_actions_enabled).toBe(true)
  })

  it('booking_url: http(s) only, <= 500, blank -> null, round-trips; default null', () => {
    expect(DEFAULTS.booking_url).toBe(null)
    expect(buildCustomerAgentSettings(SettingsSchema.parse({ enabled: true, booking_url: 'https://un1t.online/hatch' })).booking_url).toBe('https://un1t.online/hatch')
    expect(buildCustomerAgentSettings(SettingsSchema.parse({ enabled: true, booking_url: '' })).booking_url).toBe(null)
    expect(buildCustomerAgentSettings(SettingsSchema.parse({ enabled: true })).booking_url).toBe(null)
    expect(SettingsSchema.safeParse({ enabled: true, booking_url: 'javascript:alert(1)' }).success).toBe(false)
    expect(SettingsSchema.safeParse({ enabled: true, booking_url: 'not a url' }).success).toBe(false)
    expect(SettingsSchema.safeParse({ enabled: true, booking_url: 'https://example.com/' + 'a'.repeat(500) }).success).toBe(false)
  })

  it('booking_cta_label: trimmed, <= 20 (Meta button text), blank -> null; default null', () => {
    expect(DEFAULTS.booking_cta_label).toBe(null)
    expect(buildCustomerAgentSettings(SettingsSchema.parse({ enabled: true, booking_cta_label: '  Book a class  ' })).booking_cta_label).toBe('Book a class')
    expect(buildCustomerAgentSettings(SettingsSchema.parse({ enabled: true, booking_cta_label: '   ' })).booking_cta_label).toBe(null)
    expect(SettingsSchema.safeParse({ enabled: true, booking_cta_label: 'x'.repeat(20) }).success).toBe(true)
    expect(SettingsSchema.safeParse({ enabled: true, booking_cta_label: 'x'.repeat(21) }).success).toBe(false)
  })

  // The handoff SLA was read by handoff-sla.js but missing from the schema, so
  // every editor save erased it.
  it('handoff_sla_minutes survives a build; 5..1440 integer; absent -> null', () => {
    expect(DEFAULTS.handoff_sla_minutes).toBe(null)
    expect(buildCustomerAgentSettings(SettingsSchema.parse({ enabled: true, handoff_sla_minutes: 90 })).handoff_sla_minutes).toBe(90)
    expect(buildCustomerAgentSettings(SettingsSchema.parse({ enabled: true })).handoff_sla_minutes).toBe(null)
    expect(SettingsSchema.safeParse({ enabled: true, handoff_sla_minutes: 4 }).success).toBe(false)
    expect(SettingsSchema.safeParse({ enabled: true, handoff_sla_minutes: 1441 }).success).toBe(false)
    expect(SettingsSchema.safeParse({ enabled: true, handoff_sla_minutes: 10.5 }).success).toBe(false)
  })

  it('{ only } builds a partial blob of just those keys; without it the build is unchanged', () => {
    const parsed = SettingsSchema.parse({ enabled: true, tone: ' warm ', handoff_sla_minutes: 60, agent_name: 'Zed' })
    const full = buildCustomerAgentSettings(parsed)
    const partial = buildCustomerAgentSettings(parsed, { only: new Set(['tone', 'handoff_sla_minutes']) })
    expect(partial).toEqual({ tone: 'warm', handoff_sla_minutes: 60 })
    expect(buildCustomerAgentSettings(parsed, {})).toEqual(full)
    expect(buildCustomerAgentSettings(parsed, { only: undefined })).toEqual(full)
    // a key the builder does not know is ignored, not invented
    expect(buildCustomerAgentSettings(parsed, { only: new Set(['tone', 'nope']) })).toEqual({ tone: 'warm' })
    expect(buildCustomerAgentSettings(parsed, { only: new Set() })).toEqual({})
  })
})

// MIAORG.1 Task 3 — the zod-free override catalogue (settings-overrides.js) is
// a second statement of the contract's keys; these pin the two together so a
// new key cannot be added to one and not the other.
describe('override catalogue matches the contract', () => {
  // Unwrap optional/nullable/default to the inner object schema.
  function objectShape(schema) {
    let s = schema
    for (let i = 0; i < 6 && s && !s.shape; i++) s = s.unwrap ? s.unwrap() : s._def?.innerType
    return s?.shape
  }

  it('studio-only + inheritable scalars + object keys are exactly the DEFAULTS keys', () => {
    const all = [...STUDIO_ONLY_KEYS, ...INHERITABLE_SCALAR_KEYS, ...INHERITABLE_OBJECT_KEYS].sort()
    expect(all).toEqual(Object.keys(DEFAULTS).sort())
    expect(new Set(all).size).toBe(all.length)
  })

  it('each object key\'s fields are exactly its SettingsSchema fields', () => {
    for (const key of INHERITABLE_OBJECT_KEYS) {
      expect([...INHERITABLE_OBJECT_FIELDS[key]].sort(), key).toEqual(Object.keys(objectShape(SettingsSchema.shape[key])).sort())
    }
  })
})

describe('StudioSettingsSchema.overridden (T3-C)', () => {
  it('optional; an array of known paths parses', () => {
    expect(StudioSettingsSchema.parse({ enabled: true }).overridden).toBe(undefined)
    expect(StudioSettingsSchema.parse({ enabled: true, overridden: ['tone', 'followups.daily_cap', 'quiet_hours', 'enabled'] }).overridden)
      .toEqual(['tone', 'followups.daily_cap', 'quiet_hours', 'enabled'])
  })
  it('an unknown entry fails, and the issue names its index', () => {
    const r = StudioSettingsSchema.safeParse({ enabled: true, overridden: ['tone', 'followups.max_per_day'] })
    expect(r.success).toBe(false)
    expect(r.error.issues[0].path).toEqual(['overridden', 1])
  })
  it('not an array of strings fails', () => {
    expect(StudioSettingsSchema.safeParse({ enabled: true, overridden: 'tone' }).success).toBe(false)
    expect(StudioSettingsSchema.safeParse({ enabled: true, overridden: [1] }).success).toBe(false)
  })
})

describe('buildStudioOverrideBlob (MIAORG.1 Task 3)', () => {
  const parse = (body) => StudioSettingsSchema.parse(body)

  it('keeps only the overridden keys plus the studio-only keys the body carries', () => {
    const data = parse({ enabled: true, tone: 'Warm', extra_rules: 'No politics', agent_name: 'Zed', booking_url: 'https://book.example/a' })
    expect(buildStudioOverrideBlob(data, ['tone'])).toEqual({
      enabled: true, test_mode: false, test_phones: [], booking_mode: 'auto',
      un1t_chat_actions_enabled: false,
      booking_url: 'https://book.example/a',
      tone: 'Warm',
    })
  })

  it('studio-only keys are saved whatever overridden says; naming one changes nothing (T3-B)', () => {
    const data = parse({ enabled: false, test_mode: true, test_phones: ['+10000000001'], consultation_event_type_id: 'evt-1' })
    const a = buildStudioOverrideBlob(data, [])
    const b = buildStudioOverrideBlob(data, ['enabled', 'test_mode', 'consultation_event_type_id'])
    expect(a).toEqual(b)
    expect(a).toMatchObject({ enabled: false, test_mode: true, test_phones: ['+10000000001'], consultation_event_type_id: 'evt-1' })
  })

  it('an overridden key left blank is "not set here": no frozen code default (agent_name, cooldown)', () => {
    const data = parse({ enabled: true, agent_name: '  ', handoff_cooldown_hours: null, tone: '' })
    const blob = buildStudioOverrideBlob(data, ['agent_name', 'handoff_cooldown_hours', 'tone'])
    expect(blob).not.toHaveProperty('agent_name')
    expect(blob).not.toHaveProperty('handoff_cooldown_hours')
    expect(blob).not.toHaveProperty('tone')
  })

  it('a set falsy value (0, false) is an override and is kept', () => {
    const data = parse({ enabled: true, handoff_cooldown_hours: 0, followups: { enabled: false } })
    const blob = buildStudioOverrideBlob(data, ['handoff_cooldown_hours', 'followups.enabled'])
    expect(blob.handoff_cooldown_hours).toBe(0)
    expect(blob.followups).toEqual({ enabled: false })
  })

  it('an object key holds ONLY its overridden fields, never the default-filled object (T3-A)', () => {
    const data = parse({ enabled: true, followups: { enabled: true, nudge_after_hours: 3, template_name: null, daily_cap: 50 } })
    expect(buildStudioOverrideBlob(data, ['followups.enabled']).followups).toEqual({ enabled: true })
    expect(buildStudioOverrideBlob(data, [])).not.toHaveProperty('followups')
    // the whole key is shorthand for all of its (set) fields
    expect(buildStudioOverrideBlob(data, ['followups']).followups).toEqual({ enabled: true, nudge_after_hours: 3, daily_cap: 50 })
  })

  it('a partial studio object really inherits the missing fields from the org (pins mergeAgentSettings)', () => {
    const org = { followups: { enabled: false, nudge_after_hours: 6, daily_cap: 80, template_name: 'org_nudge' } }
    const data = parse({ enabled: true, followups: { enabled: true, nudge_after_hours: 3, daily_cap: 50 } })
    const studio = buildStudioOverrideBlob(data, ['followups.enabled'])
    const { settings, sources } = mergeAgentSettings({ org, studio })
    expect(settings.followups).toEqual({ enabled: true, nudge_after_hours: 6, daily_cap: 80, template_name: 'org_nudge' })
    expect(sources.followups).toBe('studio')
  })

  it('an untouched inherited key keeps following the org after a save (Review Focus 1)', () => {
    const data = parse({ enabled: true, tone: 'Org tone v1', agent_name: 'Mia' })
    const studio = buildStudioOverrideBlob(data, [])
    expect(studio).not.toHaveProperty('tone')
    // the org then changes its tone: the studio gets the new one
    const { settings, sources } = mergeAgentSettings({ org: { tone: 'Org tone v2' }, studio })
    expect(settings.tone).toBe('Org tone v2')
    expect(sources.tone).toBe('org')
  })

  it('T3-D: re-saving a legacy full blob with the overrides it implies resolves exactly as before', () => {
    const legacy = buildCustomerAgentSettings(parse({
      enabled: true, test_mode: false, tone: 'Warm', agent_name: 'Mia', handoff_cooldown_hours: 0,
      quiet_hours: { start: '21:00', end: '07:00' },
      followups: { enabled: true, nudge_after_hours: 4, template_name: 'nudge_v2', daily_cap: 40 },
      first_class_checkin: { enabled: true, delay_hours: 2, daily_cap: 20 },
      inline_suggestion: { enabled: false },
      monthly_points_target: 600,
    }))
    // the editor echoes the resolved settings it was shown
    const shown = mergeAgentSettings({ org: null, studio: legacy }).settings
    const resaved = buildStudioOverrideBlob(parse(shown), initialOverridden(legacy))
    // A null object field and an absent one read the same (null = not set;
    // quiet_hours.tz null = the studio's own zone), so compare without them.
    const dropNullFields = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k,
      v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => x != null)) : v]))
    expect(dropNullFields(mergeAgentSettings({ org: null, studio: resaved }).settings)).toEqual(dropNullFields(shown))
    // and every value the legacy blob held is still stored by the studio itself
    expect(resaved).toMatchObject({ tone: 'Warm', agent_name: 'Mia', handoff_cooldown_hours: 0, monthly_points_target: 600 })
    expect(resaved.followups).toEqual({ enabled: true, nudge_after_hours: 4, template_name: 'nudge_v2', daily_cap: 40 })
  })

  it('an object field the client did not SEND is never stored, even with the schema default parsed in', () => {
    const sent = { enabled: true, followups: { enabled: true } }
    const data = parse(sent)
    expect(data.followups.daily_cap).toBe(50)
    expect(buildStudioOverrideBlob(data, ['followups'], { sent }).followups).toEqual({ enabled: true })
    expect(buildStudioOverrideBlob(data, ['followups.daily_cap'], { sent })).not.toHaveProperty('followups')
    // no body at all reaching the builder: nothing object-shaped is stored
    expect(buildStudioOverrideBlob(data, ['followups'], { sent: null })).not.toHaveProperty('followups')
  })

  it('without overridden the route still builds the whole blob (buildCustomerAgentSettings, unchanged)', () => {
    const data = parse({ enabled: true, tone: 'x' })
    expect(Object.keys(buildCustomerAgentSettings(data)).length).toBeGreaterThan(30)
  })
})

// TRIALDONE.3 — the per-studio trial-finisher outreach block. Studio-only and
// off by default: an org value must never switch it on at every studio.
describe('trial_done (TRIALDONE.3)', () => {
  const ID_A = '11111111-1111-4111-8111-111111111111'

  it('DEFAULTS.trial_done matches the spec', () => {
    expect(TRIAL_DONE_MIA_INSTRUCTION_DEFAULT).toBe(
      'This customer finished their trial at {studio} on {date}, and we messaged them about carrying on. Help them choose between the Foundation membership and a class pack. Call list_purchase_options before naming any product or price, lead with the Foundation membership, and once they choose, send the payment link with send_purchase_link. Answer their questions honestly and never pressure them.',
    )
    expect(TRIAL_DONE_MIA_INSTRUCTION_DEFAULT).not.toContain('\u2014')
    expect(DEFAULTS.trial_done).toEqual({
      enabled: false,
      delay_hours: 2,
      stale_after_hours: 24,
      opener_template: 'hatch_trial_done_checkin',
      followup_template: 'hatch_trial_done_followup',
      followup_after_hours: 22,
      followup_max_hours: 30,
      nudge_after_hours: 3,
      nudge_max_hours: 20,
      daily_cap: 20,
      only_contact_ids: [],
      mia_instruction: TRIAL_DONE_MIA_INSTRUCTION_DEFAULT,
    })
  })

  it('trial_done is studio-only: an org blob\'s trial_done is ignored, the studio\'s wins', () => {
    expect(STUDIO_ONLY_KEYS.has('trial_done')).toBe(true)
    expect(INHERITABLE_OBJECT_KEYS).not.toContain('trial_done')
    expect(INHERITABLE_SCALAR_KEYS).not.toContain('trial_done')
    expect(ORG_REFUSED_KEYS.has('trial_done')).toBe(true)
    expect('trial_done' in OrgSettingsSchema.shape).toBe(false)
    const orgOn = { trial_done: { enabled: true, daily_cap: 99 } }
    const ignored = mergeAgentSettings({ org: orgOn, studio: { enabled: true } })
    expect(ignored.settings.trial_done).toEqual(DEFAULTS.trial_done)
    expect(ignored.sources.trial_done).toBe('default')
    const own = mergeAgentSettings({ org: orgOn, studio: { enabled: true, trial_done: { ...DEFAULTS.trial_done, enabled: true, daily_cap: 5 } } })
    expect(own.settings.trial_done).toMatchObject({ enabled: true, daily_cap: 5 })
    expect(own.sources.trial_done).toBe('studio')
  })

  it('the org PUT refuses a trial_done in the body', () => {
    const issues = orgSettingsRefusals({ trial_done: { enabled: true } })
    expect(issues.map((i) => i.path)).toContain('settings.trial_done')
  })

  it('absent -> the full default block, off; a partial block is filled from DEFAULTS', () => {
    expect(buildCustomerAgentSettings(SettingsSchema.parse({ enabled: true })).trial_done).toEqual(DEFAULTS.trial_done)
    const built = buildCustomerAgentSettings(SettingsSchema.parse({ enabled: true, trial_done: { enabled: true, delay_hours: 4 } }))
    expect(built.trial_done).toEqual({ ...DEFAULTS.trial_done, enabled: true, delay_hours: 4 })
  })

  it('round-trips every field through the studio save', () => {
    const block = {
      enabled: true, delay_hours: 6, stale_after_hours: 30, opener_template: 'my_opener', followup_template: 'my_followup',
      followup_after_hours: 20, followup_max_hours: 40, nudge_after_hours: 5, nudge_max_hours: 25, daily_cap: 7,
      only_contact_ids: [ID_A], mia_instruction: 'Help {studio} members carry on after {date}.',
    }
    const data = StudioSettingsSchema.parse({ enabled: true, trial_done: block })
    expect(buildStudioOverrideBlob(data, []).trial_done).toEqual(block)
    expect(buildCustomerAgentSettings(SettingsSchema.parse({ enabled: true, trial_done: block })).trial_done).toEqual(block)
    // a studio body that never mentions it stores nothing for it
    expect(buildStudioOverrideBlob(StudioSettingsSchema.parse({ enabled: true }), [])).not.toHaveProperty('trial_done')
  })

  it('rejects an em-dash in mia_instruction (customer-facing copy rule)', () => {
    const bad = SettingsSchema.safeParse({ enabled: true, trial_done: { mia_instruction: 'Welcome back \u2014 let us help.' } })
    expect(bad.success).toBe(false)
    expect(StudioSettingsSchema.safeParse({ enabled: true, trial_done: { mia_instruction: 'a \u2014 b' } }).success).toBe(false)
    expect(SettingsSchema.safeParse({ enabled: true, trial_done: { mia_instruction: 'Welcome back, let us help.' } }).success).toBe(true)
  })

  it('bounds: hours 1-72 integers, daily_cap 1-200, template charset, instruction 1-1000, up to 20 uuids', () => {
    const ok = (td) => SettingsSchema.safeParse({ enabled: true, trial_done: td }).success
    for (const f of ['delay_hours', 'stale_after_hours', 'followup_after_hours', 'followup_max_hours', 'nudge_after_hours', 'nudge_max_hours']) {
      expect(ok({ [f]: 1 }), f).toBe(true)
      expect(ok({ [f]: 72 }), f).toBe(true)
      expect(ok({ [f]: 0 }), f).toBe(false)
      expect(ok({ [f]: 73 }), f).toBe(false)
      expect(ok({ [f]: 2.5 }), f).toBe(false)
    }
    expect(ok({ daily_cap: 1 })).toBe(true)
    expect(ok({ daily_cap: 200 })).toBe(true)
    expect(ok({ daily_cap: 0 })).toBe(false)
    expect(ok({ daily_cap: 201 })).toBe(false)
    for (const f of ['opener_template', 'followup_template']) {
      expect(ok({ [f]: 'abc_123' }), f).toBe(true)
      expect(ok({ [f]: 'Has Caps' }), f).toBe(false)
      expect(ok({ [f]: 'has-dash' }), f).toBe(false)
      expect(ok({ [f]: '' }), f).toBe(false)
      expect(ok({ [f]: 'a'.repeat(513) }), f).toBe(false)
    }
    expect(ok({ mia_instruction: '' })).toBe(false)
    expect(ok({ mia_instruction: 'x'.repeat(1000) })).toBe(true)
    expect(ok({ mia_instruction: 'x'.repeat(1001) })).toBe(false)
    expect(ok({ only_contact_ids: Array(20).fill(ID_A) })).toBe(true)
    expect(ok({ only_contact_ids: Array(21).fill(ID_A) })).toBe(false)
    expect(ok({ only_contact_ids: ['not-a-uuid'] })).toBe(false)
  })
})
