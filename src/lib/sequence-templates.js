// sequence-templates — pre-built recipes operators can clone +
// customise instead of building from scratch (Tier 3B).
//
// Each template is a complete sequence shape: name, trigger,
// optional config + goal + send_window, and an array of steps.
// /api/sequences/from-template clones one of these into a fresh
// draft so the operator can rename / edit / activate.
//
// Adding a template: append a new entry below. Keep ids stable
// (operators may bookmark / link by id). category groups them in
// the picker UI.

export const SEQUENCE_TEMPLATES = [
  // ─── Race ────────────────────────────────────────────────────
  {
    id: 'race_welcome',
    category: 'Races',
    name: 'Race welcome series',
    description: 'Three-message series for new race competitors. Welcome → race-day reminder → post-race thanks.',
    trigger_type: 'race_registered',
    trigger_config: {},
    goal_config: null,
    send_window: { start_hour: 9, end_hour: 19, skip_days: [] },
    steps: [
      {
        step_type: 'email',
        delay_days: 0,
        delay_hours: 0,
        subject: 'You\'re in for {{event_name}}!',
        html_content: '<p>Hi {{first_name}},</p><p>Welcome to the team. Your race is coming up — bring water, a towel, and your race-day energy.</p><p>See you there,<br/>UN1T</p>',
      },
      {
        step_type: 'sms',
        delay_days: 0,
        delay_hours: 0,
        sms_body: 'UN1T: Hey {{first_name}}, your race is tomorrow! Arrive 30min early. Looking forward to seeing you.',
      },
      {
        step_type: 'email',
        delay_days: 1,
        delay_hours: 0,
        subject: 'Thanks for racing',
        html_content: '<p>Hi {{first_name}},</p><p>Big effort today. Recovery time. Photos + results coming soon.</p><p>If you loved the format, you\'d love our membership — drop in any time for a class.</p>',
      },
    ],
  },
  {
    id: 'race_finished_member_upsell',
    category: 'Races',
    name: 'Race finisher → trial pitch',
    description: 'Fires when a non-member finishes a race. Two emails over a week pitching a trial.',
    trigger_type: 'race_finished',
    trigger_config: {},
    audience_filter: { logic: 'and', filters: [{ field: 'lead_status', op: 'eq', value: 'competition_competitor' }] },
    goal_config: { type: 'lead_status', value: 'active_trial' },
    steps: [
      {
        step_type: 'email',
        delay_days: 1,
        delay_hours: 0,
        subject: 'How was {{event_name}}, {{first_name}}?',
        html_content: '<p>Hi {{first_name}},</p><p>Hope you\'re recovering well. We saw what you put down out there.</p><p>If you want to keep that intensity, we\'ve got you covered — first class on us.</p>',
      },
      {
        step_type: 'email',
        delay_days: 6,
        delay_hours: 0,
        subject: 'Last call: your free class',
        html_content: '<p>Quick reminder, {{first_name}}: that free class is still available.</p><p>Reply with a day that works.</p>',
      },
    ],
  },

  // ─── Welcome / Trial ─────────────────────────────────────────
  {
    id: 'first_booking_welcome',
    category: 'Welcome',
    name: 'First-booking welcome series',
    description: 'Fires only on the contact\'s very first booking. 3 emails: prep guide, day-after follow-up, week-on check-in.',
    trigger_type: 'first_booking',
    trigger_config: {},
    goal_config: { type: 'lead_status', value: 'member' },
    send_window: { start_hour: 9, end_hour: 18, skip_days: [] },
    steps: [
      {
        step_type: 'email',
        delay_days: 0,
        delay_hours: 0,
        subject: 'Welcome to UN1T, {{first_name}}',
        html_content: '<p>Hi {{first_name}},</p><p>Your first class is locked in. Here\'s how to make the most of it: arrive 10 minutes early, water bottle, comfy gym kit.</p><p>See you on the floor.</p>',
      },
      {
        step_type: 'email',
        delay_days: 1,
        delay_hours: 0,
        subject: 'How was your first class?',
        html_content: '<p>Hi {{first_name}},</p><p>Hope you enjoyed yesterday. Most people are sore today — that means it worked.</p><p>Book your next class while the fire\'s still in your legs.</p>',
      },
      {
        step_type: 'email',
        delay_days: 6,
        delay_hours: 0,
        subject: 'A week in — ready for membership?',
        html_content: '<p>Hi {{first_name}},</p><p>You\'ve had a week to feel the difference. Time to commit?</p><p>Members get 4× the classes for less per session. Reply YES and we\'ll set you up.</p>',
      },
    ],
  },
  {
    id: 'lead_status_member_welcome',
    category: 'Welcome',
    name: 'New member welcome',
    description: 'Fires when a contact\'s status flips to member. One email + a tag for downstream targeting.',
    trigger_type: 'status_change',
    trigger_config: { to_status: 'member' },
    goal_config: null,
    steps: [
      {
        step_type: 'email',
        delay_days: 0,
        delay_hours: 0,
        subject: 'Welcome to the squad, {{first_name}}',
        html_content: '<p>Big move. You\'re officially part of UN1T now.</p><p>What to expect this week: 4 classes, the Slack invite, the inside info.</p>',
      },
      {
        step_type: 'apply_tag',
        delay_days: 0,
        delay_hours: 0,
        config: { tag: 'newly_joined_member' },
      },
    ],
  },

  // ─── Recovery / Win-back ────────────────────────────────────
  {
    id: 'cart_recovery',
    category: 'Recovery',
    name: 'Cart abandonment recovery',
    description: 'Fires when a buyer abandons a checkout (race or car deposit). Single email, then SMS the next day.',
    trigger_type: 'order_abandoned',
    trigger_config: {},
    goal_config: { type: 'tag_added', tag: 'race_completed' },
    send_window: { start_hour: 9, end_hour: 17, skip_days: [0, 6] },
    steps: [
      {
        step_type: 'email',
        delay_days: 0,
        delay_hours: 1,
        subject: 'Did something go wrong?',
        html_content: '<p>Hi {{first_name}},</p><p>You started a payment with us but didn\'t finish. If you hit a snag, just hit reply — we\'ll sort it.</p>',
      },
      {
        step_type: 'sms',
        delay_days: 1,
        delay_hours: 0,
        sms_body: 'UN1T: Quick nudge {{first_name}} — your spot is still open. Reply with any questions.',
      },
    ],
  },
  {
    id: 'win_back_60d',
    category: 'Recovery',
    name: 'Win-back: inactive 60 days',
    description: 'Fires when a contact hasn\'t been emailed (or opened) in 60 days. Single re-engagement email.',
    trigger_type: 'inactivity',
    trigger_config: { signal: 'last_email_open_at', days_inactive: 60 },
    goal_config: { type: 'booking_made' },
    steps: [
      {
        step_type: 'email',
        delay_days: 0,
        delay_hours: 0,
        subject: 'Long time no see, {{first_name}}',
        html_content: '<p>Hi {{first_name}},</p><p>It\'s been a while. The team\'s missed you.</p><p>If a free class would help you get back on the floor, hit reply.</p>',
      },
    ],
  },

  // ─── Internal ────────────────────────────────────────────────
  {
    id: 'failed_payment_internal_followup',
    category: 'Internal',
    name: 'Failed payment → internal follow-up',
    description: 'Creates an internal task when a buyer\'s payment fails so a staff member can call them.',
    trigger_type: 'order_failed',
    trigger_config: {},
    goal_config: null,
    steps: [
      {
        step_type: 'internal_task',
        delay_days: 0,
        delay_hours: 0,
        config: {
          subject: 'Call this contact — payment failed',
          note: 'Their checkout failed. Find out why and re-issue the link.',
          due_offset_minutes: 60,
        },
      },
    ],
  },
  {
    id: 'race_finisher_promote_competitor',
    category: 'Internal',
    name: 'Race finisher → tag as engaged',
    description: 'Pure operations: tag finishers so a separate retargeting flow can pick them up.',
    trigger_type: 'race_finished',
    trigger_config: {},
    goal_config: null,
    steps: [
      {
        step_type: 'apply_tag',
        delay_days: 0,
        delay_hours: 0,
        config: { tag: 'engaged_competitor' },
      },
    ],
  },

  // ─── Anniversary ─────────────────────────────────────────────
  {
    id: 'anniversary_one_year',
    category: 'Anniversary',
    name: '1-year anniversary',
    description: 'Fires 365 days after lead_created_at. Re-fires every year.',
    trigger_type: 'anniversary',
    trigger_config: { from_field: 'lead_created_at', days_after: 365 },
    // Mig 090: lets the sequence fire once a year. 350 leaves a safety
    // buffer so next year's enrolment isn't blocked by clock drift.
    re_enrolment_cooldown_days: 350,
    steps: [
      {
        step_type: 'email',
        delay_days: 0,
        delay_hours: 0,
        subject: 'A year with UN1T 🎉',
        html_content: '<p>Hi {{first_name}},</p><p>Happy UN1T anniversary. A year ago today you signed up. Look how far you\'ve come.</p>',
      },
    ],
  },
]

export const TEMPLATE_CATEGORIES = ['Races', 'Welcome', 'Recovery', 'Internal', 'Anniversary']

export function getTemplate(id) {
  return SEQUENCE_TEMPLATES.find((t) => t.id === id) || null
}
