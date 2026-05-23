# Platform opportunity roadmap — whole-platform review (2026-05-23)

A balanced, whole-platform review of the UN1T CRM: missing features,
improvements to what exists, and complementary additions. Captured so we
can reference and re-prioritise it in later sessions.

Also delivered as an interactive impact-vs-effort artifact in Cowork
(artifact id: `un1t-platform-roadmap`).

Positions (impact 1–5, effort 1–5) are judgement calls, not estimates —
re-rank freely.

## Cross-cutting insight

The platform is **excellent at surfacing who to act on and weak at
acting**. Three radars, multi-signal scoring, weekly snapshots and
digests are all in place — but the Churn Radar and Lead Radar
"contacted" buttons only *log a note*. The SMS, WhatsApp, email and
sequences infrastructure is already built. Wiring them together (#1) is
the highest-leverage, lowest-effort move on the board and makes several
other items more valuable.

## Whole-category gaps

Things that genuinely don't exist yet, confirmed by code search:

- **Referral program** — `referral` is only a lead-source tag; no engine.
- **Member NPS / feedback** — no surveys, no sentiment capture.
- **Reviews / reputation management** — no Google-review prompting.
- **Marketing attribution** — ad spend is managed but never tied to
  conversions/revenue.
- **Analytics / BI layer** — only operational dashboards + a weekly
  report skill; no MRR / churn-rate / LTV / cohort view.

## The 19 opportunities

Impact / Effort are 1–5. Type is `missing` / `improvement` / `complement`.

### Acquisition

**1 · One-click outreach from the radars** — improvement — impact 5, effort 2
The radars identify exactly who to contact, but the "contacted" button
only logs a note. Wire it to send a templated WhatsApp / SMS / email in
one click. The send infrastructure already exists — highest leverage,
smallest build.

**2 · Referral engine** — complement — impact 5, effort 3
Member referral links, tracking and attribution, a reward on conversion,
and the referred lead dropped into the Lead Radar funnel. Cheapest,
highest-converting acquisition channel a boutique gym has.

**3 · Speed-to-lead auto-response** — missing — impact 4, effort 2
Instant automated first reply to every new enquiry + an SLA timer
flagging leads not personally contacted within minutes. Conversion falls
off a cliff after the first few minutes.

**4 · Marketing attribution & channel ROI** — missing — impact 4, effort 3
Tie lead source + ad spend to conversions and revenue so every channel
shows a real cost-per-member and return. Closes the loop on ad budgets.

### Retention

**5 · Member NPS & feedback loop** — missing — impact 5, effort 3
Periodic NPS / post-class feedback; the score becomes a Churn Radar
signal and detractors get flagged for follow-up. Sentiment is the
earliest churn signal there is.

**6 · New-member onboarding journey** — complement — impact 5, effort 3
A designed first-90-days automation (welcome → first class → week-one
check-in → 30/60/90-day touchpoints). First 90 days is where most new
members are lost; the sequences engine already exists.

**7 · Reviews & reputation engine** — missing — impact 4, effort 2
Prompt happy / high-NPS members for a Google review at the right moment;
route unhappy ones to private feedback. The Google rating is the gym's
storefront.

**8 · Win-back automation** — improvement — impact 4, effort 3
Finish the deferred overdue-payment dunning sequence and add lapsed-
member win-back campaigns off the Churn Radar. Recovers revenue that
leaks while waiting for a manual nudge.

**9 · Milestone celebrations** — complement — impact 3, effort 1
Auto-celebrate a member's 50th class, one-year anniversary or a new PB
via WhatsApp / email and on the studio TVs. Cheap, high-value
recognition; the data to detect milestones already exists.

### Member experience

**10 · Streaks & challenges retention loop** — complement — impact 4, effort 4
Extend the heart-rate achievements engine into member-facing attendance
streaks and monthly challenges that build a training habit. Turns a
per-class novelty into an ongoing engagement loop.

**11 · Member engagement app / portal** — complement — impact 4, effort 5
A light member-facing surface (HR results, streaks, achievements,
challenges, referral link) — booking stays in Glofox. Biggest build;
best treated as a phased bet.

### Analytics

**12 · Analytics & BI hub** — missing — impact 5, effort 4
A proper reporting surface: MRR, member growth, churn rate, LTV,
cost-per-acquisition, cohort-retention curves. No single place to see
business health over time today.

**13 · Class & capacity analytics** — missing — impact 4, effort 3
Which classes / time slots fill or die, no-show rates, coach-level
attendance — the numbers that should drive the timetable.

**14 · Proactive AI insights** — improvement — impact 3, effort 3
Expand the in-app assistant from answer-on-demand into a weekly
proactive insight digest + natural-language reporting.

### Revenue

**15 · Corporate / B2B memberships** — missing — impact 3, effort 4
Manage corporate accounts, bulk seats and consolidated invoicing for
nearby employers. A Dublin gym near offices has a B2B channel today's
per-member tooling can't serve.

**17 · Retail / merch tracking** — missing — impact 2, effort 3
Bring merchandise and supplement sales into the Orders / revenue
picture. Incremental margin currently invisible to the platform; lower
priority unless retail volume is meaningful.

### Operations

**16 · Coach performance scorecards** — improvement — impact 3, effort 3
Per-coach metrics: classes taught, attendance drawn, no-show rate,
retention of the members they coach. Supports development, scheduling
and pay conversations.

### Platform

**18 · Mobile radar quick-actions** — improvement — impact 3, effort 2
Add the one-click outreach (#1) to the read-only mobile radar so coaches
can act on at-risk members from the gym floor.

**19 · Unified contact comms timeline** — improvement — impact 3, effort 3
One per-contact view merging every email, SMS and WhatsApp exchange into
a single chronological history.

## Quadrant summary

**Quick wins** (high impact, low effort): #1 one-click outreach,
#3 speed-to-lead, #7 reviews engine, #9 milestone celebrations,
#18 mobile radar quick-actions.

**Big bets** (high impact, higher effort): #2 referral engine,
#5 NPS / feedback loop, #6 onboarding journey, #12 analytics hub,
#10 streaks & challenges, #11 member engagement app.

**Suggested first move:** #1 (one-click radar outreach) — it is the
cheapest build, unlocks the value already sitting in the radars, and
makes #8, #18 and the radar surfaces meaningfully better.
