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
  // ─── Lead conversion ─────────────────────────────────────────
  // Templates for the top of the funnel — turning consultation
  // bookings + landing-page leads into trial classes + members.
  // Added as part of the Flows/Automations gallery work after the
  // un1tdublin.com landing page started capturing consultations.
  {
    id: 'consultation_reminder',
    category: 'Lead conversion',
    name: 'Consultation reminder',
    description: 'For free consultations booked via /welcome. Email reminder 24h before the slot, SMS nudge 1h before. Cuts no-shows by giving the prospect two touch points before their arrival.',
    trigger_type: 'event_reminder',
    // hours_before=24 → the sequence enrols the booking 24h before
    // the consultation time. Step 1 fires immediately (T-24h email),
    // step 2 waits 23h then sends the T-1h SMS.
    trigger_config: { hours_before: 24 },
    goal_config: null,
    send_window: { start_hour: 7, end_hour: 22, skip_days: [] },
    steps: [
      {
        step_type: 'email',
        delay_days: 0,
        delay_hours: 0,
        subject: 'See you tomorrow, {{first_name}}',
        html_content: '<p>Hi {{first_name}},</p><p>Your consultation\'s booked for tomorrow. Arrive 5 minutes early so we can chat through your goals before we move.</p><p>Bring water + comfy gym kit. We\'ll handle the rest.</p><p>UN1T Stillorgan, Dublin.</p>',
      },
      {
        step_type: 'sms',
        delay_days: 0,
        delay_hours: 23,
        sms_body: 'UN1T: {{first_name}}, your consultation\'s in 1 hour. See you at Stillorgan. Reply if you need to change anything.',
      },
    ],
  },
  {
    id: 'consultation_lead_nurture',
    category: 'Lead conversion',
    name: 'Lead nurture from consultation',
    description: 'Three-touch drip starting the day the prospect books a free consultation. Day 0 thanks + what-to-expect, Day 3 social proof, Day 7 trial-class offer. Goal: contact becomes an active_trial.',
    trigger_type: 'booking_created',
    trigger_config: {},
    goal_config: { type: 'lead_status', value: 'active_trial' },
    send_window: { start_hour: 9, end_hour: 19, skip_days: [] },
    steps: [
      {
        step_type: 'email',
        delay_days: 0,
        delay_hours: 1,
        subject: 'Welcome to UN1T, {{first_name}} — what\'s next',
        html_content: '<p>Hi {{first_name}},</p><p>Thanks for booking your consultation. Here\'s what to expect: a 30-minute chat about your goals + a tour of the floor + a short movement screen so we know where you\'re at.</p><p>No pressure, no commitment. Just a conversation.</p><p>See you soon,<br/>UN1T</p>',
      },
      {
        step_type: 'email',
        delay_days: 3,
        delay_hours: 0,
        subject: 'How our members talk about UN1T',
        html_content: '<p>Hi {{first_name}},</p><p>People often ask "what makes UN1T different?" The short answer: coaches who know your name and a room that shows up.</p><p>Read what members say about training here: <a href="https://un1tdublin.com">un1tdublin.com</a></p><p>Looking forward to meeting you.</p>',
      },
      {
        step_type: 'email',
        delay_days: 7,
        delay_hours: 0,
        subject: 'Your first class is on us',
        html_content: '<p>Hi {{first_name}},</p><p>If our consultation showed you what we\'re about, the next step is feeling it on the floor.</p><p>Reply YES and we\'ll book you in for a free trial class this week.</p>',
      },
    ],
  },

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
  {
    id: 'lapsing_member_cascade',
    category: 'Recovery',
    name: 'Lapsing member cascade (30 / 60 / 90 day)',
    description: 'Fires when a contact goes 30 days without opening an email. Three touch points spaced 30 days apart: friendly nudge, a "would Saturday work" check-in, and a half-off-comeback offer. Re-enrolment locked for 120 days after exit so the same contact doesn\'t bounce between attempts.',
    trigger_type: 'inactivity',
    trigger_config: { signal: 'last_email_open_at', days_inactive: 30 },
    goal_config: { type: 'booking_made' },
    re_enrolment_cooldown_days: 120,
    send_window: { start_hour: 9, end_hour: 19, skip_days: [] },
    steps: [
      // T+0 (30d inactive) — light touch
      {
        step_type: 'email',
        delay_days: 0,
        delay_hours: 0,
        subject: 'Quick check-in, {{first_name}}',
        html_content: '<p>Hi {{first_name}},</p><p>Haven\'t seen you in a few weeks. Hope life\'s good.</p><p>If you want to drop back in this week, just reply — we\'ll save you a spot.</p>',
      },
      // T+30 (60d inactive) — more specific ask
      {
        step_type: 'email',
        delay_days: 30,
        delay_hours: 0,
        subject: 'Would Saturday morning work?',
        html_content: '<p>Hi {{first_name}},</p><p>Most members who come back start with a Saturday class — quieter, longer, more chat with the coach.</p><p>Want me to put you down for this Saturday at 10am?</p>',
      },
      // T+60 (90d inactive) — final offer
      {
        step_type: 'email',
        delay_days: 30,
        delay_hours: 0,
        subject: 'Half off your first month back',
        html_content: '<p>Hi {{first_name}},</p><p>It\'s been three months. The first step back is the hardest — so we\'re halving your first month if you want to give UN1T another go.</p><p>Reply HALF and I\'ll set it up. No long contract, no fuss.</p>',
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
  {
    id: 'birthday_wishes',
    category: 'Anniversary',
    name: 'Birthday wishes + free class',
    description: 'Fires on each contact\'s birthday (uses contact.dob). Email at 9am plus an SMS later in the morning so the message lands on both channels. Re-fires every year with a 350-day cooldown.',
    trigger_type: 'anniversary',
    trigger_config: { from_field: 'dob', days_after: 0 },
    re_enrolment_cooldown_days: 350,
    send_window: { start_hour: 9, end_hour: 19, skip_days: [] },
    steps: [
      {
        step_type: 'email',
        delay_days: 0,
        delay_hours: 0,
        subject: 'Happy birthday, {{first_name}} 🎂',
        html_content: '<p>Hi {{first_name}},</p><p>Happy birthday from the UN1T team — hope today\'s a good one.</p><p>Drop in any time this week for a free birthday class. Just reply with a day that works.</p>',
      },
      {
        step_type: 'sms',
        delay_days: 0,
        delay_hours: 2,
        sms_body: 'UN1T: Happy birthday {{first_name}}! Free class on us this week — reply with a day.',
      },
    ],
  },
]

export const TEMPLATE_CATEGORIES = ['Lead conversion', 'Welcome', 'Recovery', 'Anniversary', 'Races', 'Internal']

export function getTemplate(id) {
  return SEQUENCE_TEMPLATES.find((t) => t.id === id) || null
}
