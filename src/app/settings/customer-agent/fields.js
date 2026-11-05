// MIASETTINGS.1b — the ONE field registry for Mia's settings. The studio
// editor (CustomerAgentClient) and the organisation editor (org-fields.js →
// OrgDefaultsClient) both read it, so a field's label, help, limits and
// placeholder are written once. Data only: no React here.
//
// One entry per setting:
//   id         unique key (the settings path for a plain field)
//   paths      the settings / override paths the entry edits
//   kind       text | textarea | number | select | checkbox | custom
//   section    one of SECTION_KEYS (where the studio page shows it)
//   group      messages only: one of MESSAGE_GROUPS
//   scope      studio | org | both (org = the organisation editor shows it)
//   label      string, or (ctx) => string (resolved by fieldsFor)
//   help, maxLength, min, max, step, options ([value, label] pairs)
//   placeholder string, or (ctx) => string (resolved by fieldsFor)
//   when       (ctx) => boolean, studio scope only (ignored at the org)
//   org        per-scope differences at the organisation (behaviour only,
//              plus the "(un1t.online studios)" suffix): label, help, kind,
//              placeholder, maxLength
//   component  kind 'custom' only: the named editor that renders it
//   fallback   number fields: the code default shown as the placeholder when
//              nothing is inherited (the studio editor's inheritedNumber)
//   inputType  text fields rendered as another input type ('url')
//   noneLabel  template pickers: the "no template" option's text
//   checkedByDefault  checkbox stored as anything but false reads as on
//
// ctx = { membershipSourceKey, bookings, brand: { companyName, shortName }, agentName }
//
// Staff copy rules: sentence case, no em or en dash, "and" not "&". A
// message's help does not say "Leave blank to use the default shown": the
// Messages section says it once. fields.test.js pins all of this, and that
// every field today's studio editor shows is here exactly once.

import {
  defaultHoldingMessage, defaultWelcomeGreeting, DEFAULT_BOOKING_CTA_LABEL, DEFAULT_BOOKING_FLOW_TEXT,
  DEFAULT_FLOW_BOOKING_ACK_TEXT, DEFAULT_FLOW_BOOKING_HOLDING_TEXT, DEFAULT_FLOW_BOOKING_DUPLICATE_TEXT,
} from '@/lib/agent/default-copy'
import { productName } from '@/lib/brand-name'
import { BOOKING_CTA_LABEL_MAX } from './save-payload'
import { HATCH_COPY_FIELDS } from './hatch-copy-fields'

export const SECTION_KEYS = Object.freeze([
  'overview', 'personality', 'handoffs', 'bookings', 'messages', 'followups', 'cancellation', 'knowledge', 'member-app',
])

export const MESSAGE_GROUPS = Object.freeze([
  Object.freeze({ key: 'greeting', title: 'Greeting and links' }),
  Object.freeze({ key: 'bookings', title: 'Bookings' }),
  Object.freeze({ key: 'booking-form', title: 'WhatsApp booking form' }),
  Object.freeze({ key: 'events-credits', title: 'Events and credits' }),
  Object.freeze({ key: 'hatch-payments', title: 'Payments at Hatch' }),
])

// Hatch only = a un1t.online studio (Hatch Street).
const isHatch = (ctx) => ctx.membershipSourceKey === 'un1t_online'
// The booking link shows where the studio's source takes no bookings, and at
// a un1t.online studio (the fallback link). Today's showBookingLink.
const showBookingLink = (ctx) => ctx.bookings !== true || ctx.membershipSourceKey === 'un1t_online'

const message = (id, group, label, placeholder, help, extra = {}) => ({
  id, paths: [id], kind: 'text', section: 'messages', group, scope: 'both', label, maxLength: 500,
  ...(placeholder !== undefined ? { placeholder } : {}), ...(help ? { help } : {}), ...extra,
})

const WELCOME_HELP = 'Sent instantly when someone opens a brand-new chat (e.g. from a click-to-WhatsApp ad) without sending a message. Uses the agent\'s on/off, test-mode, and quiet-hours switches.'
const TEMPLATE_VARS_FOLLOWUP = 'Variables: {{1}} first name, {{2}} topic.'

const FIELDS = [
  // ── Overview ────────────────────────────────────────────────
  { id: 'status', paths: ['enabled', 'test_mode', 'test_phones'], kind: 'custom', component: 'StatusSwitch',
    section: 'overview', scope: 'studio', label: 'Status',
    help: 'Off, Test or Live. In Test the agent replies only to the test numbers.' },
  { id: 'quiet_hours', paths: ['quiet_hours'], kind: 'custom', component: 'QuietHours',
    section: 'overview', scope: 'both', label: 'Quiet hours (optional)',
    help: 'The agent stays quiet and a human replies.',
    org: { kind: 'quiet_hours', help: 'Each studio reads these on its own clock. A studio can switch quiet hours off for itself.' } },

  // ── Personality and voice ───────────────────────────────────
  { id: 'agent_name', paths: ['agent_name'], kind: 'text', section: 'personality', scope: 'both', maxLength: 40,
    label: 'Agent name', placeholder: 'Mia',
    help: 'The agent introduces itself by this name as the studio\'s AI assistant on first contact (Meta\'s AI-messaging rules require the disclosure).' },
  { id: 'tone', paths: ['tone'], kind: 'textarea', section: 'personality', scope: 'both', maxLength: 2000,
    label: 'Tone and voice', placeholder: 'e.g. Warm, upbeat, brief. Use first names. No emojis.' },
  { id: 'extra_rules', paths: ['extra_rules'], kind: 'textarea', section: 'personality', scope: 'both', maxLength: 2000,
    label: 'Extra rules (optional)', placeholder: 'e.g. Never discuss competitor pricing.' },
  { id: 'effort', paths: ['effort'], kind: 'select', section: 'personality', scope: 'both', label: 'Reasoning effort',
    options: [
      ['', 'Default (medium)'], ['low', 'Low: fastest and cheapest, for simple chat'], ['medium', 'Medium: balanced'],
      ['high', 'High: more thorough, slower'], ['max', 'Max: most thorough, slowest'],
    ],
    help: 'How much the agent thinks before replying. Medium suits most studios. Raise it if you see shallow answers on booking or identity questions; lower it for faster, cheaper replies.' },
  { id: 'voices', paths: [], kind: 'custom', component: 'Voices', section: 'personality', scope: 'studio',
    label: 'Mia\'s voices' },

  // ── Handoffs ────────────────────────────────────────────────
  { id: 'handoff_cooldown_hours', paths: ['handoff_cooldown_hours'], kind: 'number', section: 'handoffs', scope: 'both',
    min: 0, max: 168, fallback: 12, label: 'Hand back to the agent after (hours)',
    help: 'After the agent hands a conversation to a human, it stays out of that thread until a staff member resolves it in the inbox (which hands it straight back), or until this many hours pass. 0 = only a resolve brings the agent back.' },
  { id: 'auto_resolve_after_reply_hours', paths: ['auto_resolve_after_reply_hours'], kind: 'number', section: 'handoffs', scope: 'both',
    min: 0, max: 720, fallback: 8, label: 'Auto-resolve after a reply + quiet (hours)',
    help: 'Once a team member has replied to a handed-off conversation and it then goes quiet for this long, the handoff is marked resolved and the agent is back on duty for the next message. 0 = off.' },
  { id: 'auto_resolve_stale_hours', paths: ['auto_resolve_stale_hours'], kind: 'number', section: 'handoffs', scope: 'both',
    min: 0, max: 720, fallback: 48, label: 'Auto-resolve when fully stale (hours)',
    help: 'If nothing at all happens in a handed-off conversation for this long, it resolves on its own so the customer\'s next message doesn\'t land in silence. 0 = off.' },
  { id: 'handoff_after_verify_failures', paths: ['handoff_after_verify_failures'], kind: 'number', section: 'handoffs', scope: 'both',
    min: 1, max: 5, placeholder: '2', label: 'Hand off after failed ID checks',
    help: 'After this many failed identity checks in a row, the agent stops asking and hands the conversation to a human instead of looping the customer. Blank = the default (2).' },
  { id: 'holding_message', paths: ['holding_message'], kind: 'text', section: 'handoffs', scope: 'both', maxLength: 500,
    label: 'Hand-off message', placeholder: (ctx) => defaultHoldingMessage(ctx.brand.companyName),
    help: 'Sent to the customer when the agent hands the chat to a human.',
    // No brand at the organisation, so no default to show: say what blank does.
    org: { placeholder: undefined, help: 'Sent to the customer when the agent hands the chat to a human. Blank = the default, built from each studio\'s brand.' } },

  // ── Bookings and sales ──────────────────────────────────────
  { id: 'booking_mode', paths: ['booking_mode'], kind: 'select', section: 'bookings', scope: 'studio', label: 'Class bookings',
    options: [
      ['auto', 'Book immediately (agent books verified members straight in)'],
      ['draft', 'Queue for approval (one tap in Approvals books it + confirms to the member)'],
    ] },
  { id: 'membership_signup_url', paths: ['membership_signup_url'], kind: 'text', section: 'bookings', scope: 'studio', maxLength: 512,
    label: 'Membership sign-up link', placeholder: 'https://…',
    help: 'Shared when someone wants to join: sign-up and payment happen on this page. Update it here any time (offers, new landing pages); leave blank and the agent hands membership sign-ups to the team instead.' },
  { id: 'booking_url', paths: ['booking_url'], kind: 'text', inputType: 'url', section: 'bookings', scope: 'studio', maxLength: 500,
    label: 'Booking link', placeholder: 'https://…', when: showBookingLink,
    help: 'Mia sends this link when a customer wants to book. Used where class booking isn\'t connected. Leave blank and Mia hands bookings to the team instead.' },
  { id: 'booking_cta_label', paths: ['booking_cta_label'], kind: 'text', section: 'bookings', scope: 'studio', maxLength: BOOKING_CTA_LABEL_MAX,
    label: 'Booking button label', placeholder: DEFAULT_BOOKING_CTA_LABEL, when: showBookingLink,
    help: `The text on the link's button, up to ${BOOKING_CTA_LABEL_MAX} characters.` },
  { id: 'un1t_chat_actions_enabled', paths: ['un1t_chat_actions_enabled'], kind: 'checkbox', section: 'bookings', scope: 'studio', when: isHatch,
    label: 'Mia can book and cancel classes, send payment links and pass refund requests to the team in chat at this studio',
    help: 'Off: Mia answers questions and shares the booking link, as now. On: on WhatsApp, Mia books and cancels classes, sends payment links for the offers listed under What Mia can sell, and passes refund requests to the team, once un1t.online writes are also switched on for this studio.' },
  { id: 'offers', paths: [], kind: 'custom', component: 'Offers', section: 'bookings', scope: 'studio', when: isHatch,
    label: 'What Mia can sell' },

  // ── Messages: Greeting and links ────────────────────────────
  message('welcome_greeting', 'greeting', 'Welcome greeting (sent when someone opens the chat without typing)',
    (ctx) => defaultWelcomeGreeting({ agentName: ctx.agentName, brand: ctx.brand.companyName }),
    WELCOME_HELP,
    { kind: 'textarea', org: { placeholder: undefined, help: `${WELCOME_HELP} Blank = the default, built from the agent name and each studio's brand.` } }),
  message('link_button_text', 'greeting', 'Link button label (shown on tappable link messages)', 'Open link',
    'When the agent sends a link, it appears as a tappable button with this label.', { maxLength: 25 }),

  // ── Messages: Bookings ──────────────────────────────────────
  message('booking_confirmation_text', 'bookings', 'Booking confirmation message',
    "Good news, you're booked in for {class}. See you there.",
    'Sent to the customer when you approve a booking the agent drafted, and when staff book them from the Book panel with the chat confirmation ticked. {class} becomes what was booked and when.'),
  message('cancellation_confirmation_text', 'bookings', 'Cancellation confirmation message',
    'All sorted, your booking for {class} has been cancelled. Hope to see you at another class soon.',
    'Sent to the customer when you approve a cancellation the agent drafted. {class} becomes the class name and time.'),
  message('class_move_confirmation_text', 'bookings', 'Class move confirmation message',
    'All sorted, your booking has been moved from {from} to {to}. See you there.',
    'Sent to the customer when a class booking is moved to another class: when you approve a move the agent drafted, and when staff move it from the contact page with the chat confirmation ticked. {from} and {to} become each class with its day and time.'),
  message('booking_issue_handoff_text', 'bookings', 'Booking issue handoff message',
    "There seems to be an issue with your account, so I'm handing this over to the team to sort it out. You'll hear from them shortly once it's resolved.",
    'What the agent tells the customer when the booking system rejects a booking (for example no credits left) and the request is sent to the team to fix.'),
  message('no_credits_handoff_text', 'bookings', 'No-credits escalation message',
    "You're out of class credits at the moment so I can't book that one straight away. I'll escalate this to a team member to help you out now.",
    'Sent word-for-word when a customer asks to book but has no credits or active membership. The conversation is handed to the team immediately and the booking request appears in Approvals.'),
  message('account_conflict_handoff_text', 'bookings', 'Duplicate-account escalation message',
    "You have more than one account with us so I want to get this booking exactly right. I'll get a team member to sort it for you now.",
    'Sent word-for-word when a customer has more than one account holding a live membership or credits, so the agent will not guess which one to book. The conversation is handed to the team and the booking request appears in Approvals with the accounts listed.'),
  message('approval_decline_text', 'bookings', 'Request declined message',
    "Sorry, we couldn't complete that request this time. The team will be in touch to help.",
    'Sent to the customer when you decline a request the agent queued.'),

  // ── Messages: WhatsApp booking form ─────────────────────────
  // booking_flow_text is new at the studio, and Hatch only there: Mia sends
  // the booking form only where she does not book in chat.
  message('booking_flow_text', 'booking-form', 'Booking form message (WhatsApp)', DEFAULT_BOOKING_FLOW_TEXT,
    'Shown on the booking form Mia sends in WhatsApp, above its button.',
    { when: isHatch, org: { label: 'Booking form message (studios with the WhatsApp booking Flow)' } }),
  message('flow_booking_ack_text', 'booking-form', 'Booking form received message (WhatsApp)', DEFAULT_FLOW_BOOKING_ACK_TEXT,
    'Sent once when a customer books a class through the WhatsApp booking form, while the booking is made. When it is booked they get the booking confirmation (the confirmation template, or the booking confirmation message).'),
  message('flow_booking_holding_text', 'booking-form', 'Booking form needs the team message (WhatsApp)', DEFAULT_FLOW_BOOKING_HOLDING_TEXT,
    'Sent when a class booked through the WhatsApp booking form could not be booked automatically and goes to the team in Approvals. Approving or declining the request there then tells the customer in the chat.'),
  message('flow_booking_duplicate_text', 'booking-form', 'Booking form sent twice message (WhatsApp)', DEFAULT_FLOW_BOOKING_DUPLICATE_TEXT,
    'Sent when a customer sends the WhatsApp booking form for a class they have already asked for. If that class is already booked they get the booking confirmation instead.'),
  message('flow_paid_trial_text', 'booking-form', 'Booking form paid trial reply (WhatsApp)',
    'New to us? Start with our paid trial here: https://…',
    'When set, someone new to the studio who books through the WhatsApp booking form is not booked and gets no free trial: they are sent this message instead, so put your paid trial link in it. Members, returners and anyone with credits still book as normal. Leave blank to book new people with the free trial as before.'),

  // ── Messages: Events and credits ────────────────────────────
  message('event_move_confirmation_text', 'events-credits', 'Event move confirmation message',
    'Done, your entry is now on {event}.',
    'Sent to the customer when you approve an event move the agent asked for. {event} becomes the new event, date and time. A line about the new tickets email, and one about a link for any extra cost, are added after it when they apply.'),
  message('event_move_failed_text', 'events-credits', 'Event move not possible message',
    'We could not move your entry: {reason}. The team will be in touch.',
    'Sent to the customer when you approve an event move but it cannot be done (for example the time has filled). {reason} becomes a short plain reason.'),
  message('comp_credits_confirmation_text', 'events-credits', 'Complimentary credits message',
    "Good news, we've added {credits} to your {studio} account, use them by {date}. See you soon.",
    'Sent to the customer when staff add complimentary credits from the contact page with the WhatsApp box ticked (only while the WhatsApp window is open). {credits} becomes how many credits were added, {date} the use-by day and {studio} the studio name.'),

  // ── Messages: Payments at Hatch (Hatch only at the studio) ──
  ...HATCH_COPY_FIELDS.map(({ key, label, placeholder, help }) => message(key, 'hatch-payments', label, placeholder, help, {
    when: isHatch,
    // The organisation editor lists this one under its Messages group, so it
    // carries the Hatch suffix there (the rest sit under the group titled so).
    ...(key === 'chat_booking_unavailable_text' ? { org: { label: `${label} (un1t.online studios)` } } : {}),
  })),

  // ── Follow-ups ──────────────────────────────────────────────
  { id: 'followups.enabled', paths: ['followups.enabled'], kind: 'checkbox', section: 'followups', scope: 'both',
    label: 'Enable proactive follow-ups' },
  { id: 'followups.nudge_after_hours', paths: ['followups.nudge_after_hours'], kind: 'number', section: 'followups', scope: 'both',
    min: 1, max: 18, fallback: 3, label: 'Nudge after (hours)',
    help: 'How long they\'re quiet before the in-window nudge (sent up to 20h after, daytime only).' },
  { id: 'followups.template_name', paths: ['followups.template_name'], kind: 'custom', component: 'TemplatePicker',
    section: 'followups', scope: 'both', maxLength: 512, label: 'Outside-window template', noneLabel: 'None (in-window nudge only)',
    help: `Approved templates only. Edit the wording in WhatsApp → Templates and re-select here. ${TEMPLATE_VARS_FOLLOWUP} Marketing consent is required and enforced.`,
    org: { kind: 'text', label: 'Outside-window template name',
      help: 'The approved WhatsApp template\'s name. Each studio needs an approved template with this name on its own number.' } },
  { id: 'followups.daily_cap', paths: ['followups.daily_cap'], kind: 'number', section: 'followups', scope: 'both',
    min: 1, max: 500, fallback: 50, label: 'Daily cap (per studio)', help: 'Hard ceiling on proactive sends per day.' },
  { id: 'first_class_checkin.enabled', paths: ['first_class_checkin.enabled'], kind: 'checkbox', section: 'followups', scope: 'both',
    label: 'Enable first-class check-ins' },
  { id: 'first_class_checkin.delay_hours', paths: ['first_class_checkin.delay_hours'], kind: 'number', section: 'followups', scope: 'both',
    min: 1, max: 24, fallback: 2, label: 'Send after (hours)',
    help: 'Hours after the class before the check-in (daytime only; evening classes roll to next morning).' },
  { id: 'first_class_checkin.template_name', paths: ['first_class_checkin.template_name'], kind: 'custom', component: 'TemplatePicker',
    section: 'followups', scope: 'both', maxLength: 512, label: 'Check-in template', noneLabel: 'None (open-window check-ins only)',
    help: 'Used when they have no open chat window. Variables: {{1}} first name, {{2}} class name. Marketing consent required and enforced.',
    org: { kind: 'text', label: 'Check-in template name',
      help: 'Each studio needs an approved template with this name on its own number.' } },
  { id: 'first_class_checkin.daily_cap', paths: ['first_class_checkin.daily_cap'], kind: 'number', section: 'followups', scope: 'both',
    min: 1, max: 200, fallback: 20, label: 'Daily cap (per studio)', help: 'Each contact only ever gets one check-in.' },
  { id: 'trial_done', paths: ['trial_done'], kind: 'custom', component: 'TrialDone', section: 'followups', scope: 'studio', when: isHatch,
    label: 'Trial finisher follow-up' },
  { id: 'inline_suggestion.enabled', paths: ['inline_suggestion.enabled'], kind: 'checkbox', section: 'followups', scope: 'both',
    checkedByDefault: true, label: 'Enable inline suggestions' },

  // ── Cancellation form ───────────────────────────────────────
  { id: 'glofox_auto_cancel', paths: ['glofox_auto_cancel'], kind: 'checkbox', section: 'cancellation', scope: 'studio',
    label: 'Cancel memberships in Glofox automatically when a cancellation is approved',
    help: 'Off: approving marks the request approved and you make the change in Glofox by hand (today\'s behaviour). On: approving calls Glofox to end the membership on the requested date, and the result shows on the card. Glofox is connected at Stillorgan only.' },
  { id: 'cancellation_form', paths: ['cancellation_form'], kind: 'custom', component: 'CancellationForm',
    section: 'cancellation', scope: 'studio', label: 'Membership cancellation form' },

  // ── Knowledge ───────────────────────────────────────────────
  { id: 'knowledge', paths: [], kind: 'custom', component: 'Knowledge', section: 'knowledge', scope: 'studio', label: 'Knowledge' },

  // ── Member app ──────────────────────────────────────────────
  { id: 'monthly_points_target', paths: ['monthly_points_target'], kind: 'number', section: 'member-app', scope: 'studio',
    min: 0, step: 50, label: (ctx) => `Monthly ${productName(ctx.brand.shortName, 'points')} target`,
    help: 'Shared monthly goal that drives member tiers. Blank = tiers off.' },
  { id: 'social_enabled', paths: ['social_enabled'], kind: 'checkbox', section: 'member-app', scope: 'studio',
    label: 'Member social (friends, feed and kudos)',
    help: 'Lets members at this location add friends, see each other\'s activity, and react.' },
  { id: 'membership_cta_label', paths: ['membership_cta_label'], kind: 'text', section: 'member-app', scope: 'studio', maxLength: 60,
    label: 'Post-class join CTA wording', placeholder: 'Become a member',
    help: 'Button text shown to trials and prospects in the post-class report (the join CTA). Active members get no CTA: booking lives in the member app. Leave blank to use the default shown.' },
]

const deepFreeze = (f) => {
  if (f.options) { f.options.forEach(Object.freeze); Object.freeze(f.options) }
  if (f.org) Object.freeze(f.org)
  Object.freeze(f.paths)
  return Object.freeze(f)
}

export const AGENT_FIELDS = Object.freeze(FIELDS.map(deepFreeze))

const resolve = (v, ctx) => (typeof v === 'function' ? v(ctx) : v)

/**
 * The fields one scope shows, in registry order. `section` null = every
 * section. Studio scope applies each field's `when`; organisation scope
 * ignores it (every org field shows, whichever studio the admin works from)
 * and applies the field's `org` differences. Labels and placeholders built
 * from ctx come back as strings. Returns copies, never registry entries.
 */
export function fieldsFor(scope, section = null, ctx = {}) {
  const c = { ...ctx, brand: ctx?.brand || {} }
  const org = scope === 'org'
  const out = []
  for (const f of AGENT_FIELDS) {
    if (org ? f.scope === 'studio' : f.scope === 'org') continue
    if (section != null && f.section !== section) continue
    if (!org && f.when && !f.when(c)) continue
    const { when: _when, org: orgDiff, ...base } = f
    const merged = org && orgDiff ? { ...base, ...orgDiff } : base
    out.push({ ...merged, label: resolve(merged.label, c), placeholder: resolve(merged.placeholder, c) })
  }
  return out
}
