// MIAORG.1 Task 4 — the fields the ORGANISATION defaults editor shows: every
// inheritable field the studio editor edits (CustomerAgentClient.jsx), with
// the same labels, limits and help, and none of the studio-only ones
// (enabled, test mode, booking mode, the links, the cancellation form, the
// monthly points target). One
// declarative list rendered by OrgDefaultsClient, rather than 30 hand-written
// inputs. `limits` and `handoff_sla_minutes` have no editor here, as at the
// studio; a stored value is echoed on Save, never dropped.
//
// kind: text | textarea | number | select | checkbox | quiet_hours
// paths: the override paths the field sets (one, or the quiet-hours pair).

import {
  DEFAULT_CHAT_BOOKING_UNAVAILABLE_TEXT, DEFAULT_BOOKING_FLOW_TEXT, DEFAULT_FLOW_BOOKING_ACK_TEXT,
  DEFAULT_FLOW_BOOKING_HOLDING_TEXT, DEFAULT_FLOW_BOOKING_DUPLICATE_TEXT,
} from '@/lib/agent/default-copy'
import { HATCH_COPY_FIELDS, HATCH_COPY_GROUP_TITLE } from './hatch-copy-fields'

export const ORG_FIELD_GROUPS = [
  {
    id: 'behaviour',
    title: 'Behaviour',
    fields: [
      { id: 'handoff_cooldown_hours', paths: ['handoff_cooldown_hours'], kind: 'number', min: 0, max: 168, label: 'Hand back to the agent after (hours)',
        help: 'After a handoff, the agent stays out of the thread until staff resolve it, or until this many hours pass. 0 = only a resolve brings the agent back.' },
      { id: 'auto_resolve_after_reply_hours', paths: ['auto_resolve_after_reply_hours'], kind: 'number', min: 0, max: 720, label: 'Auto-resolve after a reply + quiet (hours)',
        help: 'Once a team member has replied to a handed-off conversation and it goes quiet this long, it is marked resolved. 0 = off.' },
      { id: 'auto_resolve_stale_hours', paths: ['auto_resolve_stale_hours'], kind: 'number', min: 0, max: 720, label: 'Auto-resolve when fully stale (hours)',
        help: 'If nothing happens in a handed-off conversation for this long, it resolves on its own. 0 = off.' },
      { id: 'effort', paths: ['effort'], kind: 'select', label: 'Reasoning effort',
        options: [['', 'Default (medium)'], ['low', 'Low: fastest and cheapest'], ['medium', 'Medium: balanced'], ['high', 'High: more thorough, slower'], ['max', 'Max: most thorough, slowest']],
        help: 'How much the agent thinks before replying.' },
      { id: 'handoff_after_verify_failures', paths: ['handoff_after_verify_failures'], kind: 'number', min: 1, max: 5, label: 'Hand off after failed ID checks',
        placeholder: '2', help: 'After this many failed identity checks in a row, the agent hands the conversation to a human. Blank = the default (2).' },
      { id: 'agent_name', paths: ['agent_name'], kind: 'text', maxLength: 40, label: 'Agent name', placeholder: 'Mia',
        help: 'The agent introduces itself by this name as the studio\'s AI assistant on first contact.' },
      { id: 'tone', paths: ['tone'], kind: 'textarea', maxLength: 2000, label: 'Tone and voice', placeholder: 'e.g. Warm, upbeat, brief. Use first names. No emojis.' },
      { id: 'extra_rules', paths: ['extra_rules'], kind: 'textarea', maxLength: 2000, label: 'Extra rules (optional)', placeholder: 'e.g. Never discuss competitor pricing.' },
      { id: 'quiet_hours', paths: ['quiet_hours'], kind: 'quiet_hours', label: 'Quiet hours (optional)',
        help: 'Each studio reads these on its own clock. A studio can switch quiet hours off for itself.' },
    ],
  },
  {
    id: 'messages',
    title: 'Messages to customers',
    fields: [
      { id: 'holding_message', paths: ['holding_message'], kind: 'text', maxLength: 500, label: 'Hand-off message',
        help: 'Sent to the customer when the agent hands the chat to a human. Blank = the default.' },
      { id: 'booking_confirmation_text', paths: ['booking_confirmation_text'], kind: 'text', maxLength: 500, label: 'Booking confirmation message',
        placeholder: "Good news, you're booked in for {class}. See you there.", help: '{class} becomes what was booked and when.' },
      { id: 'cancellation_confirmation_text', paths: ['cancellation_confirmation_text'], kind: 'text', maxLength: 500, label: 'Cancellation confirmation message',
        placeholder: 'All sorted, your booking for {class} has been cancelled. Hope to see you at another class soon.' },
      { id: 'event_move_confirmation_text', paths: ['event_move_confirmation_text'], kind: 'text', maxLength: 500, label: 'Event move confirmation message',
        placeholder: 'Done, your entry is now on {event}.' },
      { id: 'event_move_failed_text', paths: ['event_move_failed_text'], kind: 'text', maxLength: 500, label: 'Event move not possible message',
        placeholder: 'We could not move your entry: {reason}. The team will be in touch.' },
      { id: 'booking_issue_handoff_text', paths: ['booking_issue_handoff_text'], kind: 'text', maxLength: 500, label: 'Booking issue handoff message',
        placeholder: "There seems to be an issue with your account, so I'm handing this over to the team to sort it out. You'll hear from them shortly once it's resolved." },
      { id: 'no_credits_handoff_text', paths: ['no_credits_handoff_text'], kind: 'text', maxLength: 500, label: 'No-credits escalation message',
        placeholder: "You're out of class credits at the moment so I can't book that one straight away. I'll escalate this to a team member to help you out now." },
      { id: 'account_conflict_handoff_text', paths: ['account_conflict_handoff_text'], kind: 'text', maxLength: 500, label: 'Duplicate-account escalation message',
        placeholder: "You have more than one account with us so I want to get this booking exactly right. I'll get a team member to sort it for you now." },
      // MIAHATCH.2 — the studio editor shows this field in its Hatch payments and booking group (MIAHATCH.4).
      { id: 'chat_booking_unavailable_text', paths: ['chat_booking_unavailable_text'], kind: 'text', maxLength: 500, label: 'Chat booking not available message (un1t.online studios)',
        placeholder: DEFAULT_CHAT_BOOKING_UNAVAILABLE_TEXT, help: '{studio} becomes the studio name and {link} its booking link. With no booking link, a text that needs {link} is not used: the customer is told the team will help them book.' },
      // MIAFLOW.1 — the line on the booking Flow Mia sends where the studio's Flow is switched on.
      { id: 'booking_flow_text', paths: ['booking_flow_text'], kind: 'text', maxLength: 500, label: 'Booking form message (studios with the WhatsApp booking Flow)',
        placeholder: DEFAULT_BOOKING_FLOW_TEXT, help: 'Shown on the booking form Mia sends in WhatsApp, above its button.' },
      { id: 'flow_booking_ack_text', paths: ['flow_booking_ack_text'], kind: 'text', maxLength: 500, label: 'Booking form received message (WhatsApp)',
        placeholder: DEFAULT_FLOW_BOOKING_ACK_TEXT, help: 'Sent once when a customer books a class through the WhatsApp booking form, while the booking is made. The confirmation follows when it is booked.' },
      { id: 'flow_booking_holding_text', paths: ['flow_booking_holding_text'], kind: 'text', maxLength: 500, label: 'Booking form needs the team message (WhatsApp)',
        placeholder: DEFAULT_FLOW_BOOKING_HOLDING_TEXT, help: 'Sent when a class booked through the WhatsApp booking form could not be completed automatically and goes to the team in Approvals.' },
      { id: 'flow_booking_duplicate_text', paths: ['flow_booking_duplicate_text'], kind: 'text', maxLength: 500, label: 'Booking form sent twice message (WhatsApp)',
        placeholder: DEFAULT_FLOW_BOOKING_DUPLICATE_TEXT, help: 'Sent when a customer sends the WhatsApp booking form for a class they have already asked for. If that class is already booked they get the booking confirmation instead.' },
      { id: 'approval_decline_text', paths: ['approval_decline_text'], kind: 'text', maxLength: 500, label: 'Request declined message',
        placeholder: "Sorry, we couldn't complete that request this time. The team will be in touch to help." },
      { id: 'welcome_greeting', paths: ['welcome_greeting'], kind: 'textarea', maxLength: 500, label: 'Welcome greeting (sent when someone opens the chat without typing)',
        help: 'Blank = the default, built from the agent name and each studio\'s brand.' },
      { id: 'link_button_text', paths: ['link_button_text'], kind: 'text', maxLength: 25, label: 'Link button label', placeholder: 'Open link' },
    ],
  },
  // MIAHATCH.4 — the copy a un1t.online studio's customers see about buying and
  // paying (chat_booking_unavailable_text stays under Messages above).
  {
    id: 'hatch',
    title: `${HATCH_COPY_GROUP_TITLE} (un1t.online studios)`,
    fields: HATCH_COPY_FIELDS.filter((f) => f.key !== 'chat_booking_unavailable_text').map((f) => ({
      id: f.key, paths: [f.key], kind: 'text', maxLength: 500, label: f.label, placeholder: f.placeholder, help: f.help,
    })),
  },
  {
    id: 'followups',
    title: 'Proactive follow-ups',
    fields: [
      { id: 'followups.enabled', paths: ['followups.enabled'], kind: 'checkbox', label: 'Enable proactive follow-ups' },
      { id: 'followups.nudge_after_hours', paths: ['followups.nudge_after_hours'], kind: 'number', min: 1, max: 18, label: 'Nudge after (hours)' },
      { id: 'followups.template_name', paths: ['followups.template_name'], kind: 'text', maxLength: 512, label: 'Outside-window template name',
        help: 'The approved WhatsApp template\'s name. Each studio needs an approved template with this name on its own number.' },
      { id: 'followups.daily_cap', paths: ['followups.daily_cap'], kind: 'number', min: 1, max: 500, label: 'Daily cap (per studio)' },
    ],
  },
  {
    id: 'checkin',
    title: 'First-class check-in',
    fields: [
      { id: 'first_class_checkin.enabled', paths: ['first_class_checkin.enabled'], kind: 'checkbox', label: 'Enable first-class check-ins' },
      { id: 'first_class_checkin.delay_hours', paths: ['first_class_checkin.delay_hours'], kind: 'number', min: 1, max: 24, label: 'Send after (hours)' },
      { id: 'first_class_checkin.template_name', paths: ['first_class_checkin.template_name'], kind: 'text', maxLength: 512, label: 'Check-in template name',
        help: 'Each studio needs an approved template with this name on its own number.' },
      { id: 'first_class_checkin.daily_cap', paths: ['first_class_checkin.daily_cap'], kind: 'number', min: 1, max: 200, label: 'Daily cap (per studio)' },
    ],
  },
  {
    id: 'inline',
    title: 'Inline suggestion after approvals',
    fields: [
      { id: 'inline_suggestion.enabled', paths: ['inline_suggestion.enabled'], kind: 'checkbox', label: 'Enable inline suggestions' },
    ],
  },
]

export const ORG_FIELDS = ORG_FIELD_GROUPS.flatMap((g) => g.fields)

// Inheritable settings the org editor deliberately does NOT show (no editor at
// the studio either). A stored value is echoed on Save, never dropped
// (buildOrgSavePayload). A whole object key stands for all of its fields.
// org-fields.test.js pins ORG_FIELDS + this list to the inheritable catalogue,
// so a new inheritable setting fails CI until it is shown here or listed.
export const ORG_FIELDS_NOT_EDITED = Object.freeze(['handoff_sla_minutes', 'limits'])
