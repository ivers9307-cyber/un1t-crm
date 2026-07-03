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
  // ─── Trial lifecycle (GLOFOX4.4) ─────────────────────────────
  // The trial-transition tags (glofox_trial_engaged,
  // glofox_trial_credits_low, glofox_trial_ended,
  // glofox_trial_converted — all written by applyMemberSync under
  // GLOFOX4.2) feed these four templates. Each ships INACTIVE; the
  // operator reviews copy, fills in any TODOs, then activates per
  // location.
  //
  // FUNNEL.1 — these templates are comms-only now. They used to open
  // with a move_pipeline_stage step (GLOFOX4.3), but stage placement
  // is classifier-derived: an engaged / credits-low trial classifies
  // into its funnel column automatically, so the move was redundant
  // (and would have been reverted by the next sync anyway).
  {
    id: 'glofox_trial_engaged_to_conversion',
    category: 'Lead conversion',
    name: 'Trial engaged → conversion push',
    description: 'Fires when a trial member crosses 2 attended classes in the last 30 days (tag: glofox_trial_engaged). Sends an email + SMS asking if they\'re ready to talk membership — the funnel board already shows them in the right column (stage placement is automatic). Use this to catch warm trials before their credits run out.',
    trigger_type: 'tag_added',
    trigger_config: { tag: 'glofox_trial_engaged' },
    goal_config: null,
    re_enrolment_cooldown_days: 365,
    send_window: { start_hour: 9, end_hour: 20, skip_days: [] },
    steps: [
      {
        // Small wait so the email doesn't land the instant the tag
        // fires — preserves the ~2h send timing this template had
        // before its move_pipeline_stage step was retired (FUNNEL.1:
        // the classifier places the contact automatically).
        step_type: 'wait',
        delay_days: 0,
        delay_hours: 2,
      },
      {
        step_type: 'email',
        delay_days: 0,
        delay_hours: 0,
        subject: 'Loving the workouts, {{first_name}}? Let\'s talk membership',
        html_content: `<p>Hi {{first_name}},</p>
<p>We've seen you in a couple of classes this week — great work. Before your trial wraps, want to grab 10 minutes with a coach to chat about which membership fits how you train?</p>
<p>Reply to this email with a day that works, or just walk in and ask for the on-shift coach.</p>
<p>UN1T {{location_name}}</p>`,
      },
      {
        step_type: 'sms',
        delay_days: 1,
        delay_hours: 0,
        sms_body: 'UN1T: {{first_name}}, loved having you in this week. Want to chat about membership before your trial ends? Reply with a good time.',
      },
    ],
  },
  {
    id: 'glofox_trial_credits_low_push',
    category: 'Lead conversion',
    name: 'Trial credits low → conversion push',
    description: 'Fires when a trial member\'s credits drop to ≤1 (tag: glofox_trial_credits_low). Sends an SMS-first conversion push — "last class this week, let\'s talk membership" (the funnel board places them automatically). Pairs with the engagement template above; together they cover both "trying hard" and "running out of time" signals.',
    trigger_type: 'tag_added',
    trigger_config: { tag: 'glofox_trial_credits_low' },
    goal_config: null,
    re_enrolment_cooldown_days: 365,
    send_window: { start_hour: 9, end_hour: 20, skip_days: [] },
    steps: [
      {
        step_type: 'sms',
        delay_days: 0,
        delay_hours: 1,
        sms_body: 'UN1T: {{first_name}}, your last trial class is on us. After that, want to lock in a membership? Reply MEMBER and a coach will sort you out.',
      },
      {
        step_type: 'email',
        delay_days: 1,
        delay_hours: 0,
        subject: 'One trial class left, {{first_name}}',
        html_content: `<p>Hi {{first_name}},</p>
<p>Heads up — your trial credits are nearly used up. Don't let the momentum stall: lock in a membership and keep going while it feels easy.</p>
<p>Three quick options:</p>
<ol>
  <li>Monthly — month-to-month, cancel anytime.</li>
  <li>Annual — best value, locked in for the year.</li>
  <li>Class Pack — pay-as-you-go, no membership.</li>
</ol>
<p>Reply with your favourite and a coach will set it up. Or walk in and ask at reception.</p>
<p>UN1T {{location_name}}</p>`,
      },
    ],
  },
  {
    id: 'glofox_trial_ended_winback',
    category: 'Recovery',
    name: 'Trial ended (no sale) → win-back drip',
    description: 'Fires when Glofox flips a member from TRIAL → NO_SALE_TRIAL (tag: glofox_trial_ended). 3-touch comeback: a "what got in the way" email day 1, a special-offer SMS day 7, a "last invite" email day 21. Leaves the deal in Follow-up Needed where the auto-mover put it. 180-day cooldown so the same contact isn\'t cycled through every quarter.',
    trigger_type: 'tag_added',
    trigger_config: { tag: 'glofox_trial_ended' },
    goal_config: null,
    re_enrolment_cooldown_days: 180,
    send_window: { start_hour: 10, end_hour: 19, skip_days: [0, 6] },
    steps: [
      {
        step_type: 'email',
        delay_days: 1,
        delay_hours: 0,
        subject: 'How was your UN1T trial, {{first_name}}?',
        html_content: `<p>Hi {{first_name}},</p>
<p>Saw your trial just ended. Quick honest question — what got in the way? Time, money, the classes themselves, something else? Reply with one word and a coach will read it personally.</p>
<p>We get it if it wasn't a fit. But if you'd like to give it another go, we can sort that too.</p>
<p>UN1T {{location_name}}</p>`,
      },
      {
        step_type: 'sms',
        delay_days: 6,
        delay_hours: 0,
        sms_body: 'UN1T: {{first_name}}, one more class on us this week. Reply with a day if you want to give it another shot.',
      },
      {
        step_type: 'email',
        delay_days: 14,
        delay_hours: 0,
        subject: 'Last invite, {{first_name}}',
        html_content: `<p>Hi {{first_name}},</p>
<p>Last we'll bother you. If you ever want to drop in for a one-off class, the rate is €20 — no membership required, no questions asked. Just reply.</p>
<p>Otherwise, all the best from the UN1T team.</p>`,
      },
    ],
  },
  {
    id: 'glofox_trial_converted_welcome',
    category: 'Welcome',
    name: 'Trial converted → member welcome',
    description: 'Fires when Glofox flips a member from TRIAL → MEMBER (or CREDIT_MEMBER) — tag: glofox_trial_converted. Sends a welcome-to-membership email + SMS. No pipeline move step needed — applyMemberSync\'s GLOFOX2.1.4 auto-mover has already moved the deal to the Member stage by the time this fires.',
    trigger_type: 'tag_added',
    trigger_config: { tag: 'glofox_trial_converted' },
    goal_config: null,
    re_enrolment_cooldown_days: 365,
    send_window: { start_hour: 9, end_hour: 20, skip_days: [] },
    steps: [
      {
        step_type: 'email',
        delay_days: 0,
        delay_hours: 1,
        subject: 'Welcome to UN1T, {{first_name}} 🎉',
        html_content: `<p>Hi {{first_name}},</p>
<p>You're officially a member. Welcome to the UN1T family.</p>
<p>A few things you should know:</p>
<ul>
  <li>Book your classes via the Glofox app — your membership credits load automatically.</li>
  <li>Bring water + your gym kit. We'll handle the rest.</li>
  <li>If you ever need to pause, switch, or upgrade, just reply to this email.</li>
</ul>
<p>See you on the floor.</p>
<p>UN1T {{location_name}}</p>`,
      },
      {
        step_type: 'sms',
        delay_days: 0,
        delay_hours: 4,
        sms_body: 'UN1T: Welcome aboard, {{first_name}}! Your membership is live. Book your next class in the Glofox app.',
      },
    ],
  },

  // ─── Welcome ────────────────────────────────────────────────
  // Fires for every contact that just had a Glofox account created
  // FROM the CRM — booking-form opt-in (GLOFOX3.2), event-
  // registration opt-in (GLOFOX3.3), or the manual "Create in
  // Glofox" button (GLOFOX3.4). The push orchestrator tags the
  // contact 'glofox_account_created' and stashes the one-time
  // passcode on contacts.glofox_passcode so this template's
  // {{glofox_passcode}} merge tag resolves at send time.
  //
  // SHIPS INACTIVE — operator clones, reviews copy, fills in app-
  // store links, then activates. Inactive-by-default avoids us
  // surprise-emailing brand-new members on a first-deploy.
  {
    id: 'glofox_welcome_passcode',
    category: 'Welcome',
    name: 'Glofox welcome + passcode',
    description: 'Fires when CRM creates a new Glofox account for a contact (tag: glofox_account_created). Sends the one-time passcode immediately so the member can log into the Glofox app, with a follow-up nudge the next day if they haven\'t booked yet. SHIPS INACTIVE — operator should review copy and fill in app-store links before activating.',
    trigger_type: 'tag_added',
    trigger_config: { tag: 'glofox_account_created' },
    // No goal_config: this is a transactional welcome, not a
    // conversion drip. Letting it run to completion is the
    // intended path even if the member books mid-sequence.
    goal_config: null,
    // 365-day cooldown — a passcode is minted once per Glofox
    // account; if the same contact somehow re-triggers we don't
    // want to send another passcode (it'd be stale anyway). The
    // operator would re-mint via the manual button in that case,
    // which would re-tag and pass the cooldown.
    re_enrolment_cooldown_days: 365,
    send_window: { start_hour: 8, end_hour: 21, skip_days: [] },
    // All templates clone to status='draft' (from-template route) —
    // the operator MUST review + activate before this sends. Same
    // safe-by-default as every other template; called out explicitly
    // here because the placeholder app-store URLs in step 1's HTML
    // would email broken links to brand-new members.
    steps: [
      {
        // Email 1 — immediate. Lands the passcode + the app links.
        // Operator MUST fill in the iOS/Android URLs (placeholders
        // below) before activating, otherwise members get broken
        // "Download the app" links.
        step_type: 'email',
        delay_days: 0,
        delay_hours: 0,
        subject: 'Welcome to UN1T — your Glofox login is ready, {{first_name}}',
        html_content: `<p>Hi {{first_name}},</p>
<p>Your UN1T account is live. Download the Glofox app and log in with the credentials below to book your first class.</p>
<p><strong>Email:</strong> {{email}}<br />
<strong>One-time passcode:</strong> <code>{{glofox_passcode}}</code></p>
<p>You'll be asked to set your own password the first time you log in.</p>
<p>
  <a href="https://apps.apple.com/app/REPLACE-WITH-IOS-LINK">Download on the App Store</a> ·
  <a href="https://play.google.com/store/apps/details?id=REPLACE-WITH-ANDROID-ID">Get it on Google Play</a>
</p>
<p>Once you're in, your trial credits are already loaded — pick a class on the timetable and tap Book.</p>
<p>See you on the floor.<br />UN1T {{location_name}}</p>`,
      },
      {
        // SMS — same hour-ish window so the member sees the
        // passcode somewhere even if the email lands in junk.
        // 15-minute delay rather than 0 so the email arrives
        // first (most members will see the email and never read
        // the SMS).
        step_type: 'sms',
        delay_days: 0,
        delay_hours: 0.25,
        sms_body: 'UN1T: Hi {{first_name}}, your Glofox login is set. Email: {{email}} · Passcode: {{glofox_passcode}}. Open the Glofox app to book your first class.',
      },
      {
        // Day-2 nudge — only if the member hasn't booked yet.
        // We don't gate on actual booking state from inside the
        // template (the runner doesn't know about Glofox state);
        // the operator can layer a goal_config of type
        // booking_made later if they want auto-exit on first
        // booking.
        step_type: 'email',
        delay_days: 1,
        delay_hours: 22,
        subject: 'Need a hand booking your first class?',
        html_content: `<p>Hi {{first_name}},</p>
<p>Just checking in — did you manage to get logged in and have a look at the timetable?</p>
<p>If anything's not working (passcode didn't arrive, app's grumpy, can't see the schedule), reply to this email and someone from the team will sort it within the hour.</p>
<p>If you'd rather chat in person, we're at the studio Mon–Fri 6am–9pm and weekends 8am–4pm. Just walk in.</p>
<p>UN1T {{location_name}}</p>`,
      },
    ],
  },
  {
    id: 'glofox_booking_cancelled_re_engage',
    category: 'Recovery',
    name: 'Glofox cancellation → re-engage (24h)',
    description: 'Fires when Glofox sends a booking.cancelled webhook (tag: glofox_booking_cancelled). 24 hours later, sends an email + SMS suggesting a different class. Catches the "I cancelled and never rebooked" gap that quietly leads to churn.',
    trigger_type: 'tag_added',
    trigger_config: { tag: 'glofox_booking_cancelled' },
    goal_config: { type: 'booking_made' },
    re_enrolment_cooldown_days: 7,
    send_window: { start_hour: 9, end_hour: 19, skip_days: [] },
    steps: [
      {
        step_type: 'email',
        delay_days: 1,
        delay_hours: 0,
        subject: 'Sorry we missed you, {{first_name}}',
        html_content: '<p>Hi {{first_name}},</p><p>You cancelled yesterday — life happens. If you want to reschedule, the rest of the week\'s timetable is open. Reply with a day that works and we\'ll save you a spot.</p>',
      },
      {
        step_type: 'sms',
        delay_days: 0,
        delay_hours: 4,
        sms_body: 'UN1T: {{first_name}}, want to grab a different class this week? Just reply with a day.',
      },
    ],
  },
  {
    id: 'glofox_membership_cancelled_winback',
    category: 'Recovery',
    name: 'Glofox membership ended → win-back',
    description: 'Fires when Glofox sends a membership.cancelled or membership.ended webhook (tags: glofox_membership_cancelled OR glofox_membership_ended). Three-touch comeback drip starting two days after cancellation: ask why, offer a return path, then a final discount. 180-day cooldown so the same ex-member doesn\'t keep getting cycled through.',
    trigger_type: 'tag_added',
    trigger_config: { tag: 'glofox_membership_cancelled' },
    // FUNNEL.1 — goal is the win-back SUCCEEDING (rejoin stamps
    // converted_at → 'converted'). The old 'dormant' goal inverted under
    // the funnel classifier: ex_member → dormant IMMEDIATELY, so every
    // enrolment would have goal-exited on the first tick before step 1.
    goal_config: { type: 'pipeline_stage', value: 'converted' },
    re_enrolment_cooldown_days: 180,
    send_window: { start_hour: 10, end_hour: 18, skip_days: [0, 6] },
    steps: [
      {
        step_type: 'email',
        delay_days: 2,
        delay_hours: 0,
        subject: 'Sorry to see you go, {{first_name}}',
        html_content: '<p>Hi {{first_name}},</p><p>We saw your membership ended. No hard feelings — but if there\'s anything we could have done differently, we\'d genuinely like to hear it. Reply to this email and someone from the team will read it.</p>',
      },
      {
        step_type: 'email',
        delay_days: 14,
        delay_hours: 0,
        subject: 'Doors are still open, {{first_name}}',
        html_content: '<p>Hi {{first_name}},</p><p>It\'s been two weeks. If you want to drop in for a single class without committing, that\'s totally fine — €20 for any class on the timetable. Reply with a day and we\'ll book you in.</p>',
      },
      {
        step_type: 'email',
        delay_days: 14,
        delay_hours: 0,
        subject: 'Final offer: half off your first month back',
        html_content: '<p>Hi {{first_name}},</p><p>One last note. If you want to give UN1T another shot, your first month back is half price. No questions, no judgement.</p><p>Reply HALF and we\'ll set it up.</p>',
      },
    ],
  },
  {
    id: 'webhook_external_lead_capture',
    category: 'Lead conversion',
    name: 'External lead capture (webhook)',
    description: 'Inbound-webhook starter template. Wire any external system (n8n / Glofox / Zapier / Stripe) to POST to a unique URL — the contact gets a welcome email + an internal task lands on the operator\'s queue. Edit the steps to match your funnel after install.',
    trigger_type: 'webhook',
    trigger_config: {},
    goal_config: null,
    steps: [
      {
        step_type: 'email',
        delay_days: 0,
        delay_hours: 0,
        subject: 'Welcome to UN1T, {{first_name}}',
        html_content: '<p>Hi {{first_name}},</p><p>Thanks for getting in touch — someone from the team will be in contact within the next working day.</p><p>In the meantime, the gym is at UN1T Stillorgan, Dublin if you want to drop in.</p>',
      },
      {
        step_type: 'internal_task',
        delay_days: 0,
        delay_hours: 0,
        config: {
          subject: 'Follow up: external lead capture',
          note: 'Inbound webhook fired. Confirm next step (call, schedule consultation, send pricing, etc).',
          due_offset_minutes: 60 * 4,
        },
      },
    ],
  },
  {
    id: 'consultation_lead_nurture',
    category: 'Lead conversion',
    name: 'Lead nurture from consultation',
    description: 'Three-touch drip starting the day the prospect books a free consultation. Day 0 thanks + what-to-expect, Day 3 social proof, Day 7 trial-class offer. Goal: contact attends their first class.',
    trigger_type: 'booking_created',
    trigger_config: {},
    goal_config: { type: 'pipeline_stage', value: 'first_class' },
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
    audience_filter: { logic: 'and', filters: [{ field: 'lead_source', op: 'eq', value: 'website' }] },
    goal_config: { type: 'pipeline_stage', value: 'first_class' },
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
    goal_config: { type: 'pipeline_stage', value: 'converted' },
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
    description: 'Fires when a contact\'s pipeline stage flips to converted. One email + a tag for downstream targeting.',
    trigger_type: 'pipeline_stage_change',
    trigger_config: { to_status: 'converted' },
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
  // RADAR-DUNNING.1 — automates the churn radar's Overdue chase-list.
  // Build a segment with filter "Membership State = locked" on the
  // Contacts page, clone this template, point its segment trigger at
  // that segment, and the moment a member's payment fails they enter
  // the segment and this dunning drip fires — no manual chasing.
  {
    id: 'overdue_payment_dunning',
    category: 'Recovery',
    name: 'Overdue payment → dunning chase',
    description: 'Automates the chase for members whose Glofox payment has failed. Build a segment of "Membership State = locked" on the Contacts page, then point this template\'s segment trigger at it — the moment a member falls into arrears they enter the segment and a 3-touch dunning drip fires: a gentle same-day heads-up email, a firmer SMS on day 3, a final email on day 7. SHIPS INACTIVE — clone, pick your overdue segment in the editor, review the copy, then activate. 30-day cooldown so a member who lapses, fixes it, then lapses again months later still gets chased.',
    trigger_type: 'segment_added',
    // Empty config — the operator picks their "overdue" segment in the
    // sequence editor after cloning (same pattern as the webhook
    // starter template).
    trigger_config: {},
    goal_config: null,
    re_enrolment_cooldown_days: 30,
    send_window: { start_hour: 9, end_hour: 19, skip_days: [] },
    steps: [
      {
        step_type: 'email',
        delay_days: 0,
        delay_hours: 1,
        subject: 'A quick heads-up about your payment, {{first_name}}',
        html_content: `<p>Hi {{first_name}},</p>
<p>We tried to process your membership payment and it didn't go through — it happens, usually just a card that's expired or been replaced.</p>
<p>Your membership is still active. To keep it that way, update your payment details in the Glofox app, or simply reply to this email and a coach will sort it out with you.</p>
<p>UN1T {{location_name}}</p>`,
      },
      {
        step_type: 'sms',
        delay_days: 3,
        delay_hours: 0,
        sms_body: 'UN1T: Hi {{first_name}}, your membership payment is still outstanding. Update your card in the Glofox app, or reply here and we\'ll help you sort it.',
      },
      {
        step_type: 'email',
        delay_days: 4,
        delay_hours: 0,
        subject: 'Action needed to keep your UN1T membership',
        html_content: `<p>Hi {{first_name}},</p>
<p>Your membership payment is now a week overdue and we don't want you to lose your spot.</p>
<p>Two minutes fixes it: update your payment details in the Glofox app, or reply to this email and we'll take it from there — no awkwardness, we just want to keep you training.</p>
<p>UN1T {{location_name}}</p>`,
      },
    ],
  },
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
