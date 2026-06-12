# AGENT-CHECKIN — post-first-class check-in (spec, 2026-06-12)

**Status: SPEC ONLY — awaiting Richard's sign-off.** Requested in the Tier-2
batch ("6 needs to be properly scoped with a specific plan on how to
communicate with them"). The highest-converting moment in the funnel: someone
just finished their first class and nobody asks how it went.

## Who gets a check-in (eligibility)

A contact qualifies when ALL of:

1. **Funnel position** — `pipeline_stage_slug` in `new_lead`, `active_trial`,
   `hot_conversion`. Established members never get one (their "first class"
   was long ago; `last_attended_at` alone can't tell a true first-timer from a
   returning regular — the stage gate does).
2. **Fresh attendance** — `last_attended_at` within the last 24h (set by the
   existing Glofox attendance sync: webhooks + nightly aggregates; we don't
   add any new Glofox calls).
3. **Never checked in before** — `contacts.first_class_checkin_at IS NULL`
   (new column, one small migration). Once-ever per contact, full stop.
4. **Reachable** — has a phone, not opted out.

Detection runs on the existing 15-minute `agent-followups` cron tick (one
cron, two jobs) — no new schedule, same heartbeat.

## The communication plan (the 24h-window problem, case by case)

Timing: send 2h (configurable) after `last_attended_at`, Dublin daytime only
(09:00–20:00); attendance landing in the evening rolls to next morning —
"how was your class yesterday?" still works.

**Case A — they have an open WhatsApp window** (they messaged us within 24h —
typically because they booked the class through Mia that morning):
- **Free-form Mia message**, composed with the thread context and the actual
  class name: *"Hey Sarah — how did you find FUS1ON this morning? 💪"*
- Free (no template fee), conversational, the best version of this feature.
  Booking-via-Mia customers get this automatically — a nice flywheel: the
  more bookings she takes, the more check-ins are free-form.

**Case B — no open window** (booked via the Glofox app or front desk; most
first-timers — many have NEVER messaged the studio):
- WhatsApp only permits an **approved template**. An "how was your class?"
  relationship message is **MARKETING** in Meta's taxonomy (it's not a
  transaction notification — don't fight the category, see the WA-TMPL
  lessons), so it is **`whatsapp_marketing` consent-gated** like a campaign.
- Suggested template `mia_first_class_checkin_v1` (editable any time in the
  Templates manager, selected via a picker in agent settings — same pattern
  as follow-ups):
  > *Hi {{1}}, Mia from UN1T here 👋 How did you find your first {{2}} class
  > today? Reply and let me know how you got on — I'd love to hear it.*
  Variables: `{{1}}` first name, `{{2}}` class name (from the attended
  booking in `recent_bookings`).
- No consent / no phone → skip silently (logged). An email fallback is
  possible later but out of scope v1.

**Either way, the reply is the product.** Any response re-opens the 24h
window and the normal agent takes over with a dedicated prompt section:

- **Positive** → celebrate briefly, then move: offer to book their next
  class on the spot (the booking tools are right there — "Want me to grab
  you a spot for Thursday?"). v1 keeps the next step to *another booking*,
  not a membership pitch — softer, and the team can sell once they're a
  regular face. (Flag for decision below.)
- **Negative / complaint** → empathise in one sentence, NO defensiveness, and
  **hand off to the team immediately** with the context — a bad first
  impression is exactly what a human should rescue, fast.
- **Lukewarm / unclear** → one gentle open question, then offer the team.

## Safety rails

- Once-ever per contact (`first_class_checkin_at` stamp, set on send).
- Separate daily cap, default 20/location (a check-in burst after a busy
  Saturday shouldn't eat the follow-ups cap).
- Dublin daytime only; skips: handed-off threads, human-active threads,
  opted-out, pause/cancel cycles in flight.
- Every send recorded in-thread (`source='agent'`) + an `activities` timeline
  entry on the contact ("Mia checked in after first class"); every skip logs
  a structured reason.
- Default OFF: `settings.customer_agent.first_class_checkin.enabled`.

## Settings shape

```jsonc
"customer_agent": {
  "first_class_checkin": {
    "enabled": false,
    "delay_hours": 2,          // after last_attended_at
    "template_name": null,      // Case-B template (null = Case-A-only)
    "daily_cap": 20
  }
}
```

## Build size (when approved)

One migration (`contacts.first_class_checkin_at`), ~80 lines in
`followups.js` (new candidate source feeding the existing send paths), one
prompt section, settings card extension, red-first tests for eligibility +
case routing. One PR.

## Decisions for Richard

1. **Template copy** above — approve/edit (then create + submit it in
   Templates, marketing category, like the follow-up one).
2. **Positive-path goal**: next-booking only (recommended v1) or also
   surface membership/consultation when they're a trial?
3. **Delay** (default 2h) and **daily cap** (default 20) comfortable?
