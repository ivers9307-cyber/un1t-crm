# Hatch Street: Trial done → membership or class pack (design)

Date: 2026-10-19. Owner: Richard. Status: draft for approval.

## Intent

When a Hatch Street lead finishes their trial, nobody reliably talks to
them about what comes next, and the moment passes. This automation starts
that conversation on WhatsApp two hours after the trial ends. Mia then
helps them choose between a membership and a class pack and sends a
un1t.online payment link for what they pick. Paying applies the product
to their un1t.online profile, and the pipeline moves them to Converted on
its own.

Success means every eligible trial finisher hears from Hatch the same
day, can ask questions and buy without staff, and nobody is charged
wrongly.

## Who (Richard)

A Hatch Street contact enters **Trial done** when either:

- they have **attended 3** trial classes, or
- they have **attended 2** and their **trial has expired**.

Someone who attended 0 or 1 classes before the trial expired is **not**
included (Claude's reading of Richard's rule; he did not mention them).

Left out (Richard): **active Stillorgan members**, **staff**, and
**anyone who has already bought something** at Hatch: any paid pack, any
membership or subscription past or present.

Today the Hatch board's classifier puts a person in `trial_done` only on
3 attended (`TRIAL_DONE_MIN_ATTENDED`,
`src/lib/membership/reads/un1t-pipeline-dates.js`). The "2 attended +
expired trial" case is new and is added to the un1t.online classifier,
so the board and this automation agree.

**"Expired" (from the live product, checked 19 Oct):** "The UN1T Trial"
(`674d62bf…`) has `credits_per_period = 3` and `expire_credits_in_days =
7`. So a trial expires **7 days after the trial was granted** (the €0
trial purchase: its `un1t_transactions` row, or D's `op='trial'` ledger
row). The builder reads `expire_credits_in_days` from the synced product
rather than hard-coding 7. A person with 2 attended whose grant is more
than that many days old, and who has bought nothing, is Trial done.

**Attendance is marked promptly at Hatch (checked 19 Oct):** in the last
14 days every un1t.online booking more than 2 hours past its start was
already ATTENDED, NO_SHOW or CANCELLED (219 / 11 / 56; no undecided
BOOKED rows). So only `attended` counts, as today, and the 24-hour stale
rule below is a safety net, not the normal case.

Shared contacts (SHAREDCONTACT.1, #2146): a person whose contact record
is at Stillorgan but who trialled at Hatch is eligible if they are not
an active Stillorgan member. Everything acts as Hatch: Hatch's consent
row, Hatch's thread, Hatch's offer.

## When (Richard)

- 3 attended: **2 hours after the 3rd class ends**, the same day.
- 2 attended + expired: **2 hours after the expiry time** (grant +
  `expire_credits_in_days`), held to daytime (Claude's call).
- Either way, only in Hatch's daytime sending hours (studio clock). A
  message that falls outside them waits for the next morning. Quiet
  hours and the 24-hour marketing frequency cap apply as for every
  sequence.

Timing depends on the attendance arriving: un1t.online syncs every 15
minutes and the board reclassifies hourly. The 2-hour clock runs from
the class end time, not from when the CRM noticed. If the CRM notices
late (for example, a sync outage) and it is more than 24 hours after the
trigger, the opener is not sent (Claude's call: a "how was your trial?"
three days later reads as a mistake). The builder records that skip.

## The conversation (Richard: a conversation, run by Mia)

1. **Opener.** WhatsApp lets a business start a conversation only with
   an approved template. Hatch gets a new MARKETING template (draft
   below, Richard approves before it goes to Meta). It is sent once per
   person, ever, consent-gated on Hatch's WhatsApp marketing row.
2. **Mia takes over on reply.** When they reply, the 24-hour window
   opens and Mia (live at Hatch since 19 Oct, replies only) answers. She
   knows the thread is a trial-done conversation: her context says they
   finished their trial on {date}, and that her goal is to help them
   choose a membership or a class pack. She answers questions honestly
   and never pushes. She follows all of Mia's existing rules, including
   never showing class capacity.
3. **The offer.** Mia offers what is in Hatch's offer list (the
   `mia_purchase_offers` table, MIAHATCH.4/.6), with these
   defaults:
   - **Membership (lead): The Foundation Monthly Membership, €189 a
     month** (`669d7b78-0634-4e2c-9a9a-350a7fc94c91`). Richard chose this
     one. Note: it is a **private** product in un1t.online, which the
     offer list allows.
   - **Class pack (lead): 10 Class Pack, €220**
     (`c7bbedea-1e11-4091-9823-a3f5e8fb5c97`).
   - If asked, the other public options: 3-month (€567), 6-month
     (€1,134) and annual (€2,268) Foundation memberships, and the 5 (€125),
     20 (€400) and 30 (€540) class packs. The builder seeds the offer list
     with these; staff can change it in Mia's settings.
4. **The sale.** When they choose, Mia sends a un1t.online payment link
   for that product through MIAHATCH.6's flow (`createCheckoutLink`
   with their un1t.online user id, the `/pay-done` return page, the
   `mia_purchase_intents` row). **un1t.online's payment link takes the
   payment and applies the product in one step** (Richard: follow
   un1t.online). Nothing is applied before they pay.
5. **No reply.** **One follow-up the next day** (Richard). Since they
   never replied, the 24-hour window never opened, so the follow-up is
   a second approved template, sent about 22–26 hours after the opener
   in daytime hours (Claude's reading of "next day but within the 24
   hour window"). If they replied and then went quiet, the same single
   follow-up rule applies: one in-window nudge from Mia, written by her,
   inside the 24-hour window. **This is built for trial-done threads
   only** (Claude's call): Mia's general follow-up ladder
   (`src/lib/agent/followups.js`) stays switched off at Hatch, as the
   Mia-at-Hatch rollout decided, and is not turned on by this work.
   After the one follow-up, nothing more is automated; staff can pick it
   up from the board.

### Template drafts (Richard to approve or rewrite)

No em-dashes in customer messages (Richard's rule). Signed as the other
Hatch templates are.

**Opener** `hatch_trial_done_checkin` (MARKETING, {{1}} = first name):

> Hi {{1}}, well done on finishing your trial at UN1T Hatch Street! 🏋️‍♂️
> I wanted to reach out personally because we have a few spots left on our
> limited Foundation membership pricing.
> Would you like me to send over the details for that, or are you looking
> more at class packs?
> Garrett, Studio Owner
>
> (Richard's wording, 19 Oct.)

**Follow-up** `hatch_trial_done_followup` (MARKETING, {{1}} = first
name):

> Hey {{1}}, just bumping this in case it got buried in your notifications!
> Let me know if you want me to save you one of those Foundation slots
> before they're gone. 👍
> Garrett
>
> (Richard's wording, 19 Oct; his "— Garrett" sign-off written without the
> em-dash, per his no-em-dash rule for customer messages.)

Quick-reply buttons are optional. If used, they are plain replies such
as "Tell me more" that reach Mia (#2064), never an opt-out button
(Richard's call).

## After the sale

- The pipeline moves them to **Converted** on its own once the purchase
  syncs from un1t.online (Richard: "should follow the pipeline"). No
  manual stage move.
- If they paid while a class booking was in play, MIAHATCH.6 books it.
  Otherwise Mia confirms the purchase in the thread.
- Anything else (welcome message, first-booking prompt) is out of scope
  here.

## Anti-goals (Richard: "all of the above")

This fails even if it technically works if it:

- **charges anyone twice.** One live payment link per person
  (MIAHATCH.4's unique index, used by MIAHATCH.6). A double payment that still happens files
  a refund card for staff and is never refunded automatically.
- **charges someone who only asked a question.** Nothing is charged by
  the CRM at all. The only way money moves is the customer completing
  un1t.online's payment page.
- **messages someone who has already joined**, or a Stillorgan member,
  or staff. The eligibility check runs again immediately before each
  template send, not only when they enter the column.
- messages anyone twice for the same trial, or sends the follow-up after
  they have replied or bought.

## Constraints

- **No charging the card on file.** Richard scrapped it. The
  `POST /purchases/charge` guard stays as it is (€0 trial only).
- **un1t.online writes only through D's client**
  (`src/lib/un1t-online-write.js` / `-ops.js`): ledgered, judged on the
  body, never blind-retried, `writes_enabled`-gated.
- **WhatsApp:** templates are per studio and unique per WABA. A template
  made in Meta's UI is adopted by Stillorgan on refresh and must be moved
  to Hatch. Sends go from the org number switched on at Hatch, and the
  thread files at Hatch.
- **Consent:** Hatch's `contact_location_preferences.whatsapp_marketing`.
  A missing row means no send.
- **Customer-facing copy is operator-editable** (template names in
  settings, Mia's trial-done instructions in Mia's settings, with
  defaults).
- Mia stays on the Anthropic Messages API.
- Default **off**, behind a Hatch setting that Richard switches on.
  Tested end to end with the MIA TEST contact up to receiving a payment
  link. Richard tests paying by hand.

## Dependencies

- **The sale path is built and merged, switched off** (checked 19 Oct):
  MIAHATCH.4 (#2142: offer and intent tables), MIAHATCH.5 (#2144: book,
  cancel, refund cards) and **MIAHATCH.6 (#2147: offers, one payment
  link, trial first, book after payment; mig 755)**, all behind Hatch's
  off-by-default switches. This work does not rebuild any of it. It
  needs MIAHATCH.6's upsell switch on at Hatch (Richard switches it on,
  after the MIA TEST pass) and the offer list seeded as above.
- SHAREDCONTACT.1 (#2146, merged).
- Two new Hatch WhatsApp templates approved by Meta and filed at Hatch.

## Left to the builder

- Whether the opener and follow-up run as a **sequence** (a
  `pipeline_stage_change` to `trial_done` with waits, a branch and
  WhatsApp steps) or as a **Mia check-in runner** like
  `runFirstClassCheckins`. Either way it must meet the timing,
  once-only, recheck-before-send and daytime rules above, and record a
  structured reason for every skip. Note: a sequence trigger from a deal
  move currently skips `cross_location` for a contact whose home is
  another studio (`triggerSequencesForDealPlacement`), which would miss
  shared contacts. A runner keyed on Hatch's board avoids that.
- How Mia learns the thread is a trial-done conversation (a thread
  marker, a context block keyed on the opener having been sent, etc.).
- How "trial expired" is read from the un1t.online mirror.
- The settings UI shape (switch, template names, delay).
- Tests, including: the eligibility table (3 attended; 2 + expired; 1 +
  expired excluded; Stillorgan member, staff, prior purchase excluded),
  once-only, the recheck before each send, daytime holding, the 24-hour
  stale skip, the follow-up suppressed by a reply or a purchase, and the
  one-live-link rule.
