# UN1TWELCOME — welcome email for every new un1t.online account

Date: 2026-10-28 · Owner: Richard · Status: design, awaiting approval
Mockup: `docs/superpowers/specs/2026-10-28-un1t-welcome-email-mockup.html`

## Why

Every new account at a studio on un1t.online (Hatch Street today) should get a
welcome email telling them to download the **un1t.online app**, because that
app is where they book classes. Today only accounts the CRM makes (class funnel,
`/trial` purchase) get any email, and that email says only "your account is
made, a set-password code is coming". People who sign up directly on
un1t.online get nothing from us.

## Goals

1. Every un1t.online account first seen **after deploy** gets the welcome,
   whether they made it themselves or the CRM made it.
2. Accounts the CRM makes still get **one** email: their existing account email
   gains the same app wording and links, and the sequence's welcome step is
   skipped for them, but **only if that account email actually went out**.
3. The welcome is an **email sequence** Richard can see and edit in
   Communications, so follow-ups can be added later without code.
4. It goes out about **15 minutes** after the account appears (the next sync),
   inside the sequence's send window.
5. It is an **account email**: sent on Postmark's transactional (outbound)
   stream with no unsubscribe footer, and it reaches people who haven't opted
   in to marketing.
6. App Store / Google Play links are a **studio setting**, used by both emails
   through one merge tag.
7. The email shows the **UN1T logo** at the top.

## Non-goals

- No backfill. Nobody first seen before deploy gets it.
- No WhatsApp or push, only email.
- No check for whether un1t.online sends its own welcome (Richard: ignore).
- No Glofox studios: this is for studios whose `membership_source = 'un1t_online'`.
- No follow-up steps in v1. The sequence has one email step; Richard adds more later.
- No change to dunning's lane: it stays on the marketing stream as today.

## Anti-goals (failure even if it "works")

- Anyone first seen before deploy gets the email.
- A CRM-made account gets two welcome-type emails, or none.
- A person gets the welcome twice (re-sync, re-match, a second studio row).
- The sweep re-reads the same rows every tick for ever (the DETAILBACKFILL.1 class).
- A failure in the welcome sweep stops or fails the un1t.online sync.
- A marketing sequence starts going out on the transactional stream.

## Decisions (Richard's)

| Question | Answer |
|---|---|
| App to download | un1t.online app |
| CRM-made accounts | Enrol them, skip step 1; their account email carries the app wording |
| Existing accounts | New ones only |
| Where the words live | An email sequence |
| Timing | Next sync (~15 min) |
| Links | Studio setting + merge tag |
| Consent | Account email, not marketing |
| Stream | Transactional stream, no unsubscribe footer (accepted as the bigger build) |
| The existing "First Class Booking Nudge" | Keep both; the nudge comes after the welcome |
| Logo | UN1T logo at the top |
| Build the sequence | Yes, Claude builds it |

## How it works

### 1. Spotting a new account

The 15-minute `un1t-online-sync` cron does a full pull and upserts
`un1t_clients` (only mapped columns plus `contact_id`). The mirror write
(`src/lib/un1t-online-mirror-write.js`) inserts a row, with `crm_written_at`,
when the CRM creates an account. Neither tells us "this row is new", so:

- **Migration** adds three columns to `un1t_clients`:
  - `first_seen_at timestamptz NOT NULL DEFAULT now()`
  - `welcome_checked_at timestamptz`: the sweep's cursor, stamped on every attempt
  - `account_email_sent_at timestamptz`: set when `sendUn1tAccountEmail` reports `sent: true` (§5)
- The same migration sets `welcome_checked_at = now()` on **every existing
  row**. That is what makes "new ones only" structural.
- `un1t_clients` is service-role only (mig 726), so no client grant is needed.
  Say so in the migration. The sync upsert never names the new columns
  (checked), and mig 744's keep-the-CRM-write trigger doesn't touch them.

### 2. The welcome sweep (an arm of `un1t-online-sync`)

After a studio's sync run, call `sweepUn1tWelcomes(db, locationId)` (new
`src/lib/un1t-online-welcome.js`). It runs inside its own try/catch and never
fails the sync.

0. **No active `un1t_account_created` sequence at the location → return
   without reading or stamping anything.** Rows wait, so accounts that arrive
   between deploy and Richard switching the sequence on are welcomed once it is
   on. This reads one small query per tick, not the rows. (Claude's call:
   "new" means first seen after deploy, not after activation.)
1. Select `un1t_clients` at the location where `welcome_checked_at IS NULL`,
   ordered by `first_seen_at`, page ≤ 500, `.range()`-paginated.
2. For each row:
   - **No `contact_id` yet**: if `first_seen_at` is under 48 h old, leave it.
     Otherwise stamp it with outcome `no_contact`.
   - **Contact has no email** (the sync can create name-only contacts): stamp
     `no_email` and don't enrol. `sendEmailStep` would throw, not skip.
   - **CRM-made test**: `crmMade = account_email_sent_at IS NOT NULL`. A CRM-made
     account whose account email failed is treated like a self-signup and gets
     the welcome. (Claude's call: no one ends up with zero emails.)
   - Call `triggerSequencesForUn1tAccountCreated(contactId, { locationId, crmMade, un1tUserId })`.
   - Stamp `welcome_checked_at = now()` **whatever the trigger answered**,
     failure included. Log a failure with `logError`. The per-row outcome goes in
     a structured log line (builder may add a column instead).
3. Every write checks its `error` (BAREWRITE rules). Arm the sweep's file in
   `no-unchecked-supabase-write`.

**Heartbeat:** the arm gets its own `cron_heartbeats` row (`un1t-welcome-sweep`),
stamped when the sweep finished without a fault of its own, including a run with
nothing to do and a run skipped because no sequence is active. Apply the row's
migration after the code deploys.

### 3. New sequence trigger `un1t_account_created`

- Register the value in the trigger enum in `src/app/api/sequences/route.js` and
  `[id]/route.js`, `src/lib/sequences/graph/schema.js`, `graph/view.js`,
  `src/lib/sequences/agent/prompt.js`, the automations list components, and the
  picker label in `src/components/sequences/SequenceSettings.jsx` ("When a new
  un1t.online account is created"). There is no DB CHECK on `trigger_type`.
- `triggerSequencesForUn1tAccountCreated` in `src/lib/sequences/triggers.js`
  follows the `contact_created` pattern: it finds active sequences at the
  location with this trigger and enrols with `sourceType: 'un1t_account_created'`
  and `sourceRef` = the `un1t_user_id`.
- **Once per person per sequence, ever** is already guaranteed by the unique
  `(sequence_id, contact_id)` index and `ON CONFLICT DO NOTHING` in
  `src/lib/sequences/enrol.js`. Don't pass `allowReenrol`.
- **Start past step 1:** `enrolContacts` always writes `current_step_order: 0`
  today. Add a `startStepOrder` option (default 0). The trigger passes 1 when
  `crmMade`. On a one-step sequence the enrolment then completes with nothing
  sent; check the scheduler handles "no next step" as completion.

### 4. Account lane: consent and stream

- Add `'un1t_account_created'` to `TRANSACTIONAL_SOURCE_TYPES` in
  `src/lib/sequences/steps.js`. This skips the marketing-consent gate and the
  frequency cap. Bounced, complained and suppressed addresses are still blocked,
  and so is "not on this location's list" (un1t.online-synced contacts get their
  `contact_location_preferences` row from mig 489's trigger and UN1TDUAL.3).
- **New: an account-stream list**, `ACCOUNT_STREAM_SOURCE_TYPES =
  ['un1t_account_created']`, separate from the transactional list so dunning is
  unchanged. For an enrolment whose `source_type` is in it, `sendEmailStep`:
  - sends through `sendTransactionalEmail` (outbound stream) instead of `sendMarketingEmail`
  - adds no unsubscribe footer or List-Unsubscribe headers, and doesn't require
    an `unsubscribe_token`
  - uses the studio inbox as Reply-To (`getLocationInboxReplyTo`), as the account email does
  - still writes the `email_sends` row, with the `Metadata.crm_send` marker
    (POSTMARK-RACE rules), so opens and deliveries track as they do today
- As with the transactional lane, this belongs to how the contact was enrolled,
  never to the sequence. The same sequence enrolled by hand stays marketing.
  Test that explicitly.

### 5. App links setting, merge tag, and the account email

- Setting: `locations.settings.un1t_online.app_links = { ios_url, android_url }`.
  Edit it on the un1t.online card in the Integrations hub, through that card's
  existing service-role settings route. Validate both as `https://` URLs; either
  may be blank.
- Merge tag `{{app_download_links}}` (registered in `src/lib/merge-tags.js`,
  offered, with a description). It renders two black buttons, "Download on the
  App Store" and "Get it on Google Play", as email-safe HTML in the mockup's
  style, and leaves out a blank one. With both blank it renders nothing and logs
  a `logWarn`. `sendEmailStep` reads the setting once per send into the extras
  it hands to `applyMergeTags`, which stays pure.
- `sendUn1tAccountEmail` (`src/lib/un1t-online-funnel-emails.js`; both
  `class_funnel` and `trial_purchase`) appends an **app section** below the
  operator's body, rendered by the same helper:
  > **Book your classes in the un1t.online app**
  > Download the app and log in with this email address once you've set your
  > password. That's where you'll book and manage every class.
  > [App Store] [Google Play]

  It's appended, not a placeholder, so saved copy picks it up. It's left out
  when both links are blank. Its heading and body are operator-editable
  (`account_email_app_heading` / `account_email_app_body` on the class-funnel
  copy block, with these words as the default).
- When it reports `sent: true`, the caller stamps `un1t_clients.account_email_sent_at`
  for that `(location_id, un1t_user_id)`. Both callers already hold the
  un1t.online user id. Check the error; on failure, log it. The worst case is
  then a second, welcome email, never none.

### 6. The logo

The email's header shows the studio logo from `getLocationBranding(db, locationId)`
(`company_settings.logo_url`) on white with a 4 px black rule beneath, as in
the mockup. **Hatch Street has no logo set today** (checked:
`company_settings.logo_url` is null; Stillorgan has the UN1T "We train as one"
logo). Before switch-on, Claude sets Hatch's logo to the same UN1T logo through
the branding settings (`/api/settings/branding`). Fallback when a studio has
no logo: the "UN1T" text wordmark.

### 7. The existing "First Class Booking Nudge"

`un1t-online-sync`'s `fireSignupTriggers` fires `contact_created` for fresh
un1t.online sign-ups, which at Hatch would enrol them in "New Lead – First
Class Booking Nudge". Checked 28 Oct: that sequence is **inactive** and its
first message is WhatsApp after a 5-minute wait. So nothing clashes today, and
v1 changes nothing there. Richard said "keep both, nudge later": if the nudge
is switched on, its first wait should be raised (for example to 1 day) so the
welcome lands first. Note this in the welcome template's description.

### 8. The sequence Claude builds

Add a template to `src/lib/sequence-templates.js` (id `un1t_account_welcome`,
category "Onboarding"). After deploy, create the live sequence at Hatch Street
from it **as a draft**. Richard reviews it and switches it on.

- Name: **Welcome: new un1t.online account**
- Trigger: `un1t_account_created`
- Send window: 08:00–21:00, every day
- Step 1: email, immediate. The HTML is the mockup with merge tags in place of
  the sample values: logo resolved at send time, `{{first_name}}`,
  `{{location_name}}`, `{{app_download_links}}`. The footer reads "You're
  getting this because you created an account at {{location_name}}" and has no
  unsubscribe link.

**Subject:** Welcome to {{location_name}}, {{first_name}}
**Preheader:** Download the un1t.online app to book your first class.
**Body:** as in the mockup: a welcome, "everything happens in the un1t.online
app", the store buttons, "three steps to your first class" (download, log in
with this email, pick a class and tap Book), "reply to this email" for help, and
the sign-off from the studio team.

## Constraints (from the CLAUDE.md invariants that bite here)

- Service-role code only. No client grants on the new columns.
- Backfill-cursor rule: stamp on every attempt, order by the cursor, page < 1000.
- `check:select-columns` must pass for every new select.
- The `un1t_write_events` ledger isn't needed. `crm_written_at` and
  `account_email_sent_at` carry the signal.
- Customer-facing copy is operator-editable (the sequence, plus the two new copy fields).
- The arm gets its own heartbeat row.
- Apply the migration through Supabase MCP on `iyvtbjjxdggiadzwwvdj` **before**
  the code deploys (the heartbeat row comes after). Run `get_advisors` afterwards.

## Left to the builder

- Whether the sweep outcome gets a column or only a log line.
- Button styling detail beyond the mockup.
- Tests: the sweep (old rows never selected; no active sequence leaves rows
  untouched; unmatched rows wait, then get stamped; no-email gets stamped;
  crmMade starts at step 2; a failure still stamps); the trigger; the
  `startStepOrder` option; the account stream (transactional sender, no footer,
  no token needed, manual enrolment stays marketing); the merge tag with blank,
  one or both links; the account email appendix and the `account_email_sent_at` stamp.

## Claude's calls (for Richard to check)

1. "New" means first seen after **deploy**. Accounts made before you switch the
   sequence on still get welcomed once it's on.
2. A CRM-made account counts as "already welcomed" only if its account email
   actually sent. Otherwise it gets the sequence welcome.
3. Hatch Street gets the UN1T logo set in its branding, since it has none today.
4. The booking nudge is left alone because it's inactive and WhatsApp-only.
   Raising its wait is noted for when it's switched on.
5. The sequence ships as a draft; you switch it on.
