// MIAORG.1 Task 2 — the acceptance bar: with the org layer NULL, every reader
// behaves EXACTLY as it did when it read locations.settings.customer_agent
// raw, for (a) Stillorgan's real blob shape and (b) a studio with no blob
// (Hatch: off). Resolved settings carry DEFAULTS' nulls where a reader used
// to see `undefined` (T2-A: null means unset), so every pure reader is run on
// the raw blob AND on the resolved settings and must answer the same.
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { mergeAgentSettings } from './settings-resolve'
import { STILLORGAN_BLOB } from './settings-fixtures.test-helpers'
import {
  resolveAgentGate, shouldAgentReply, resolveAgentEffort, resolveVerifyFailHandoff, isWithinQuietHours,
} from './core'
import { resolveLimits } from './auto-reply'
import { resolveHandoffSlaMinutes, resolveAutoResolveHours, shouldSweepLocation } from './handoff-sla'
import { shouldSendWelcome } from './welcome-greeting'
import { proactiveWindowOpen, FOLLOWUP_DEFAULTS, CHECKIN_DEFAULTS } from './followups'
import { bookingMode } from './booking-tools'
import { MIA_HATCH_COPY } from './mia-copy'
import { agentSignal } from '@/lib/integrations-hub'
import { resolveCancellationFormCopy } from '@/lib/cancellation-form/copy'

const TEST_PHONE = STILLORGAN_BLOB.test_phones[0]
const STRANGER = '+353870000777'
const NOON = new Date('2026-10-14T11:00:00Z') // 12:00 Dublin, a Wednesday
const LATE = new Date('2026-10-14T21:30:00Z')
const ZONE = 'Europe/Dublin'

// Every reader of the settings object, as it is called in production.
const READERS = {
  gate: (s) => resolveAgentGate(s),
  effort: (s) => resolveAgentEffort(s?.effort),
  verifyFail: (s) => resolveVerifyFailHandoff(s),
  limits: (s) => resolveLimits(s),
  slaMinutes: (s) => resolveHandoffSlaMinutes(s),
  autoResolve: (s) => resolveAutoResolveHours(s),
  quiet: (s) => [isWithinQuietHours(NOON, s?.quiet_hours, ZONE), isWithinQuietHours(LATE, s?.quiet_hours, ZONE)],
  welcome: (s) => [STRANGER, TEST_PHONE].map((p) => shouldSendWelcome({ settings: s, senderPhone: p, now: NOON, zone: ZONE })),
  reply: (s) => [
    { agent_active: true },
    { agent_active: false, agent_handed_off_at: '2026-10-14T05:00:00Z' }, // 6h ago: inside the 12h cooldown
    { agent_active: false, agent_handed_off_at: '2026-10-13T05:00:00Z' }, // 30h ago: re-arms
  ].map((conversation) => shouldAgentReply({ settings: s, conversation, message: { type: 'text', body: 'hi' }, senderPhone: STRANGER, now: NOON, zone: ZONE })),
  proactive: (s) => proactiveWindowOpen(NOON.getTime(), s, ZONE),
  followups: (s) => ({ ...FOLLOWUP_DEFAULTS, ...(s?.followups || {}) }),
  checkin: (s) => ({ ...CHECKIN_DEFAULTS, ...(s?.first_class_checkin || {}) }),
  followupGate: (s) => !!(s?.enabled || s?.test_mode),
  bookingMode: (s) => bookingMode(s),
  consultationPin: (s) => s?.consultation_event_type_id || null,
  hubMode: (s) => agentSignal(s),
  monthlyTarget: (s) => Number(s?.monthly_points_target) || 0,
  inlineSuggestionOff: (s) => !s?.enabled || s?.inline_suggestion?.enabled === false,
  inlineTimeout: (s) => s?.inline_suggestion?.timeout_ms ?? 5000,
  cancellationCopy: (s) => resolveCancellationFormCopy(s?.cancellation_form),
  membershipCta: (s) => [s?.membership_signup_url ?? null, s?.membership_cta_label ?? null],
  copy: (s) => [
    'holding_message', 'welcome_greeting', 'link_button_text', 'booking_confirmation_text',
    'cancellation_confirmation_text', 'approval_decline_text', 'event_move_confirmation_text',
    'event_move_failed_text', 'booking_issue_handoff_text', 'no_credits_handoff_text',
    'account_conflict_handoff_text', ...Object.keys(MIA_HATCH_COPY), 'tone', 'extra_rules', 'membership_signup_url',
  ].map((k) => String(s?.[k] || '').trim() || null),
  cooldown: (s) => s?.handoff_cooldown_hours ?? 12,
}

describe('no behaviour change on deploy (org layer null)', () => {
  const stillorgan = mergeAgentSettings({ org: null, studio: STILLORGAN_BLOB }).settings
  const hatch = mergeAgentSettings({ org: null, studio: null }).settings

  for (const [name, read] of Object.entries(READERS)) {
    it(`${name}: Stillorgan's real blob reads the same raw and resolved`, () => {
      expect(read(stillorgan)).toEqual(read(STILLORGAN_BLOB))
    })
    it(`${name}: a studio with no blob (Hatch) reads the same as no settings at all`, () => {
      expect(read(hatch)).toEqual(read(null))
    })
  }

  it('the pins are not vacuous: Stillorgan is live with the verify-fail handoff at 2, Hatch is off', () => {
    expect(READERS.gate(stillorgan).enabled).toBe(true)
    expect(READERS.verifyFail(stillorgan)).toBe(2)
    expect(READERS.reply(stillorgan)[0].reply).toBe(true)
    expect(READERS.reply(hatch)[0]).toEqual({ reply: false, reason: 'disabled' })
    expect(READERS.welcome(hatch)[0]).toEqual({ send: false, reason: 'disabled' })
    expect(READERS.followupGate(hatch)).toBe(false)
  })

  it('the agent name a blob-less prompt gets is the default either way', () => {
    // agent_name is the one key whose raw `undefined` and resolved value
    // differ ('Mia'); every reader falls back to DEFAULTS.agent_name or names
    // no one, and the studios Mia runs at (Stillorgan) set it.
    expect(stillorgan.agent_name).toBe(STILLORGAN_BLOB.agent_name)
    expect(hatch.agent_name).toBe('Mia')
  })

  it('shouldSweepLocation is judged on the STUDIO blob, never on resolved settings', () => {
    // Resolved settings always exist (DEFAULTS), so gating on them would sweep
    // every studio; callers pass the studio's own blob (null = never set up).
    expect(shouldSweepLocation(null)).toEqual({ sweep: false, reason: 'no_agent_config' })
    expect(shouldSweepLocation(hatch).sweep).toBe(true) // why callers must not pass resolved settings
  })
})
