// MIASETTINGS.1a — fixtures for the Mia settings golden round-trip test
// (round-trip.test.jsx). The `settings` of each GET are built through the real
// contract and merge, so they are valid by construction. Later tasks of the
// redesign reuse these and the section label map.

import { SettingsSchema, buildCustomerAgentSettings } from '@/lib/agent/settings-contract'
import { mergeAgentSettings } from '@/lib/agent/settings-resolve'

const LOCATION = { id: 'loc1', name: 'Test Studio' }
const BRAND = { companyName: 'Gym A', shortName: 'GA' }
const CHECKIN_STATS = { sent_today: 0, total: 0, last: null, last_run: null }

// A GET body shaped like /api/settings/customer-agent's.
export function getBody({ studio = null, org = null, bookings, membershipSourceKey }) {
  const { settings, sources } = mergeAgentSettings({ org, studio })
  return {
    success: true,
    settings: { ...settings, social_enabled: false, glofox_auto_cancel: false },
    studio,
    org,
    sources,
    inherited: mergeAgentSettings({ org, studio: null }).settings,
    location: LOCATION,
    brand: BRAND,
    bookings,
    membership_source_key: membershipSourceKey,
    checkin_stats: CHECKIN_STATS,
  }
}

export const STILLORGAN_GET = getBody({
  org: { tone: 'Org tone', followups: { daily_cap: 80 } },
  studio: { enabled: true, test_mode: false, holding_message: 'Studio holding message' },
  bookings: true,
  membershipSourceKey: 'glofox',
})

export const HATCH_GET = getBody({
  studio: {
    enabled: true,
    test_mode: false,
    trial_done: { enabled: true, delay_hours: 6, daily_cap: 15 },
    purchase_offer_intro_text: 'Here is how you can keep training:',
    trial_used_text: 'You have had your free trial already.',
  },
  bookings: false,
  membershipSourceKey: 'un1t_online',
})

// An old studio that stores the whole blob, enabled and test mode both on.
export const LEGACY_FULL_BLOB_GET = getBody({
  studio: buildCustomerAgentSettings(SettingsSchema.parse({
    enabled: true, test_mode: true, test_phones: ['+353871234567'], tone: 'Warm', handoff_cooldown_hours: 0, monthly_points_target: 600,
    followups: { enabled: true, nudge_after_hours: 4, template_name: 'nudge_v2', daily_cap: 40 },
    quiet_hours: { start: '21:00', end: '07:00' },
  })),
  bookings: true,
  membershipSourceKey: 'glofox',
})

export const HATCH_NO_BLOB_GET = getBody({ studio: null, bookings: false, membershipSourceKey: 'un1t_online' })

// Section keys of the redesigned page -> the menu label. editByLabel clicks the
// menu item for a field's section first once the menu exists.
export const SECTION_LABELS = {
  overview: 'Overview',
  personality: 'Personality and voice',
  handoffs: 'Handoffs',
  bookings: 'Bookings and sales',
  messages: 'Messages',
  followups: 'Follow-ups',
  cancellation: 'Cancellation form',
  knowledge: 'Knowledge',
  'member-app': 'Member app',
}

// One field per future section. `value` is what is typed; `expectKey` is the
// PUT body path that must be the only one to change (the editor's own
// `overridden` list may also gain that path). The cancellation intro is
// `form_intro` in the stored block.
export const EDIT_ONE_PER_SECTION = [
  { section: 'personality', label: 'Agent name', value: 'Maya', expectKey: 'agent_name' },
  { section: 'handoffs', label: 'Hand back to the agent after (hours)', value: '7', expectKey: 'handoff_cooldown_hours' },
  { section: 'bookings', label: 'Membership sign-up link', value: 'https://example.com/join', expectKey: 'membership_signup_url' },
  { section: 'messages', label: 'No-credits escalation message', value: 'Out of credits, the team will help.', expectKey: 'no_credits_handoff_text' },
  // MIASETTINGS.1c — new at the studio, Hatch only (the edits run on HATCH_GET).
  { section: 'messages', label: 'Booking form message (WhatsApp)', value: 'Pick a class below.', expectKey: 'booking_flow_text' },
  { section: 'followups', label: 'Daily cap (per studio)', value: '33', expectKey: 'followups.daily_cap' },
  { section: 'cancellation', label: 'Intro', value: 'Sorry to see you go.', expectKey: 'cancellation_form.form_intro' },
  { section: 'member-app', label: 'Monthly GA Points target', value: '750', expectKey: 'monthly_points_target' },
  { section: 'overview', label: 'Test numbers (comma-separated, e.g. +353871234567)', value: '+353871111111, +353872222222', expectKey: 'test_phones' },
]
