# WAORGNUMBER — WhatsApp numbers shared across an organisation

**Date:** 2026-10-17 · **Status:** design settled with Richard in chat, awaiting review
**Supersedes parts of:** WAHOMESTUDIO.1 (`2026-10-15-wa-home-studio-threads-design.md`) R1, R2, R4(b), R5, and the "every send that does not start from a thread still refuses" half of WACONFIGFALLBACK.1.
**Unblocks:** Hatch radar outreach (`2026-10-17-hatch-radar-arrears-briefing-design.md` §5, G7) and Mia's sends at Hatch (`2026-10-17-mia-at-hatch-design.md`), both on branch `un1t/hatch-sales-specs`.

## 1. Why

Richard, 17 Oct 2026: *"WhatsApp should now be shared across the organisation, with routing of the messages dictated by what automation sent the message and where that training member resides."*

UN1T Group has four studios and one WhatsApp number, Stillorgan's +353 1 578 9401 on one WhatsApp Business Account (WABA `995298903094551`). Hatch Street has no number. So today Hatch can only answer threads a customer opened (WAHOMESTUDIO.1). Every send that starts from an automation or a contact throws `WhatsAppNumberMissingError`. That covers radar win-back and outreach, campaigns and drips, sequences, booking and event confirmations, the ad-lead welcome, the contact-page composer, the cancellation form, and Mia's follow-ups. In the caller table (`tests/whatsapp-config-callers.test.js`), that is 14 of 26 rows.

The env-number fallback was retired (WACONFIGFALLBACK.1) because it caused this harm: a send "for" a studio went from another studio's number, and the customer's reply landed in the wrong inbox and the wrong Mia. This design shares a number on purpose, within one organisation, and makes the reply land at the studio that spoke.

Live state, 17 Oct:

| Studio (UN1T Group) | Number | Templates | Threads | WA consent rows (in / out) |
|---|---|---|---|---|
| UN1T Stillorgan | +353 1 578 9401 (default, cloud_api) | 21 approved | 1,443 | 6,963 / 1,972 |
| UN1T Hatch Street | none | 0 (3 `hatch_*` templates sit at Stillorgan) | 114 | 282 / 10 |
| Pride Training Club (host events) | none | 0 | 0 | none |
| Test Studio | none | 0 | 0 | 0 / 1 |

Four Stillorgan templates name "UN1T Stillorgan" in their text: `booking_class_confirmed_`, `booking_consult_confirmed`, `meta_ad_whatsapp_lead` and `book_first_visit`.

## 2. Goals

1. **A number belongs to the organisation.** Org admins add and remove numbers. Each studio switches each of its organisation's numbers on or off, and marks one as its default. A studio with nothing switched on still cannot send (WACONFIGFALLBACK.1 still applies to it), so Pride and Test Studio stay silent.
2. **An outbound send for studio S goes from a number switched on at S.** The thread, the message rows, Mia's context and inbox filing all belong to S, the studio the automation acted for.
3. **A reply lands at the studio that last spoke.** That is the studio that messaged the member most recently within 7 days, otherwise the member's home studio.
4. **Templates stay per studio.** Hatch's template editor manages Hatch's templates, created on the WABA of a number Hatch has switched on. A Hatch send can only use a Hatch template.
5. **WhatsApp consent is per studio.** A send for S needs the member's WhatsApp consent at S. STOP opts the member out only at the studio whose thread it arrived in.
6. **One daily limit per number,** shared by every studio using it. Blasts and drips at Hatch need an org admin's sign-off for the first 30 days.
7. **Every sender works at Hatch** once Hatch switches the number on: radar, campaigns and drips, sequences, booking and event confirmations, the ad-lead welcome, the composer, the cancellation form, and Mia's follow-ups and check-ins.

## 3. Non-goals and anti-goals

- **Never cross organisations.** A number is switched on only at studios of its own organisation. A database trigger enforces this, not just the app.
- **Never re-open the env-number fallback.** `WHATSAPP_ACCESS_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` stay retired.
- **Never send studio S's message with another studio's template.** A template that names Stillorgan must not reach a Hatch member.
- **Never borrow consent.** Stillorgan's consent row never licenses a Hatch send.
- **Mia is not switched on at Hatch here.** This work makes her follow-ups and check-ins route correctly at Hatch. Richard flips her on after the Mia-at-Hatch spec ships, because without it she would answer Hatch members with Stillorgan's Glofox tools.
- **Not in scope:**
  - The number's Meta display name. Richard is renaming it to a neutral "UN1T" in Meta Business Manager himself.
  - WhatsApp Flows at Hatch. A Flow belongs to one WABA, and `settings.whatsapp_flow` is per studio; nothing changes there.
  - Instagram.
  - Moving a template between studios from the UI. The three `hatch_*` rows move once, by migration.
- **Anti-goal: Hatch switching on surprises anyone.** Before Richard ticks Hatch, he sees a list of every Hatch automation that will start sending (§8 step 6).

## 4. Rules (the contract)

### R1 — numbers are organisation-owned, switched on per studio

- `whatsapp_numbers` gains `organization_id uuid NOT NULL` (FK `organizations`), backfilled from `locations.organization_id` of the row's `location_id`.
- `whatsapp_numbers.location_id` stays, renamed in meaning only: it is the number's **home studio**. New-enquiry threads land there (R4 step 4), and so do coexistence history and echoes when no other rule decides. A `COMMENT` says so.
- `whatsapp_numbers.is_default` is deprecated (`COMMENT 'DEPRECATED (mig N)'`, still written for one release, then dropped later). The per-studio default moves to the new link table.
- **New table `location_whatsapp_numbers`** records "switched on at this studio":
  - Columns: `location_id` (FK locations, cascade), `whatsapp_number_id` (FK whatsapp_numbers, cascade), `is_default bool not null default false`, `created_at`, `created_by uuid`.
  - Primary key `(location_id, whatsapp_number_id)`; a partial unique index on `(location_id) WHERE is_default`.
  - A BEFORE INSERT OR UPDATE trigger raises when the number's `organization_id` differs from the location's.
  - Closed to client sessions (the mig 677 default ACL; state the REVOKE anyway).
- **Backfill:** one link row per existing `whatsapp_numbers` row, `(location_id, id, is_default)`. Stillorgan keeps exactly what it has. Hatch is **not** switched on by the migration; that is Richard's go-live tick (§8).
- `whatsapp_numbers.is_active` stays the organisation-wide off switch. A number is usable at S when it is `is_active` **and** has a link row at S.

### R2 — resolution

- `getLocationWhatsAppNumberConfig(S)` returns S's switched-on, active numbers: the link-row default first, then the most recently switched on. It returns null if there are none and throws on a failed read, as today.
- `getWhatsAppConfig(S)` keeps its contract: S's number, or `WhatsAppNumberMissingError` when nothing is switched on at S.
- **The config shape changes:**
  - `locationId` becomes the studio the config was resolved **for** (S).
  - New fields `homeLocationId` (the number's `location_id`) and `organizationId`.
  - The builder audits every reader of a config's `.locationId`. Known readers: `getConversationReplyConfig`, `templateLocationIdFor`, `whatsapp-media-server.js`, and `followups.js` via `threadCanReply`.
- New helper `getLocationNumberForWaba(S, wabaId)`: S's switched-on active number on that WABA, default first, else null. Template sends use it (R5).
- `getConversationNumberConfig(S, conv)` returns the thread's stamped number when it is active **and switched on at S**. Clause (b) of WAHOMESTUDIO R4 ("a same-org sibling's number while S has none") stays only until §8 step 7, then it is deleted.
- `resolveWhatsAppNumberByPhoneNumberId` is unchanged. The webhook still gets `{ numberId, homeLocationId }`.

### R3 — outbound filing: the automation's studio

- `getOrCreateConversation(db, contact, S)` files the thread at **S**: the studio the broadcast, sequence, radar, booking, ad welcome or follow-up acted for.
  - A new thread is stamped with the number the send uses.
  - An existing thread at S with no stamp is stamped.
  - An existing stamp that is no longer switched on at S is replaced.
- `numberlessHomeStudio` stops deciding the filing studio once Hatch is switched on (§8 step 7 deletes it). This **reverses WAHOMESTUDIO R1 on purpose** (Richard, Q8): a Stillorgan campaign to a member whose home is Hatch files at Stillorgan, because Stillorgan is the one speaking.
- Staff sends from the contact page (composer) and the cancellation form send for the **contact's home studio**. That is the studio they use today (`contact.location_id`). They file through `getOrCreateConversation(db, contact, home)` instead of `getOrCreateContactConversation`, which picks the most recent thread at any studio and could pair a thread at one studio with another studio's number. *(Builder's call taken here: home studio. A studio picker on the composer is a possible follow-up.)*

### R4 — inbound routing: who spoke last

For an inbound message to number N (organisation O) from `wa_phone` P (or BSUID), after the existing org-fenced contact match:

1. **Candidate studios:** studios with N switched on (link rows), plus N's home studio.
2. **Quoted message:** if the inbound quotes a message (`context.id`) whose thread is at a candidate studio, that thread wins. A Flow reply (`nfm_reply`) carries the context of the Flow message, so it lands with the studio that sent the Flow. *(My call: a reply to a specific message belongs with that message.)*
2b. **Click-to-WhatsApp ad:** if the inbound carries an ad referral whose ad belongs to a candidate studio (`ad_entities.external_id` → its studio, the same lookup WASTUDIOPICK uses), that studio's thread wins, even for a known member. The CTWA Lead event is then attributed to the studio that paid for the ad. *(My call.)*
3. **Recent outbound:** among P's threads at candidate studios, the thread with the most recent **outbound** message (any sender: staff, Mia, automation) sent within the last 7 days wins.
4. **Home studio:** otherwise, the matched contact's home studio, when it is a candidate.
5. **Number's home studio:** otherwise, N's home studio (Stillorgan for this number). For an unknown sender, the existing studio picker (WASTUDIOPICK) still runs when it is ticked there. Its studio list becomes "studios with N switched on and `wa_studio_picker.listed`", replacing "siblings with no number of their own".
6. The winning thread is stamped with N when N is switched on there. Consent keywords (R6), Mia, the welcome greeting, the ad/CTWA handling and the push all act at the winning studio (today's `actingLocationId` distinction goes away).

A member of both studios therefore has one chat on their phone and up to two threads in the CRM, one per studio. The unique key `(location_id, wa_phone)` already allows that.

**Dual members:**
- A dual member is one `contacts` row at their home studio, plus a `contact_memberships` row at the other studio (mig 731). "Home studio" in step 4 means `contacts.location_id`.
- On 17 Oct there were 10 contacts homed elsewhere with a Hatch membership, and all 10 already have a Hatch consent row (9 opted in). So Hatch campaigns reach them, and no consent backfill is needed.
- The composer (R3) sends for the home studio. A membership at the other studio does not change that. *(My call: 10 people; a studio picker on the composer is the follow-up if it matters.)*

The coexistence ingest (`whatsapp-coexistence-ingest.js`) uses the same function for echoes and history. The F1 moved-thread fallback (`findMovedNumberlessThread`) and the WANUMBERLESS/R2 home-studio branch are replaced by this function. Write it as one pure-ish helper (`routeInboundThread`) that both the webhook and the ingest call.

### R5 — templates per studio on a shared WABA

- `whatsapp_templates` gains `business_account_id text` (the WABA the template lives on).
  - Backfill: each row's studio's default number's WABA. All 21 rows are Stillorgan's.
  - Partial unique index `(business_account_id, name, language) WHERE business_account_id IS NOT NULL`. Prod has no duplicates as of 17 Oct, and that is checked again in the migration.
- **Ownership:** `whatsapp_templates.location_id` is the studio that manages the template. Only staff with template permission at that studio can create, edit, resubmit, delete or upload media for it (`canManageWaTemplatesAt`, unchanged).
- **Create at S:**
  - The template goes on the WABA of S's default switched-on number.
  - A name already used on that WABA, at any studio, is refused with a 409: "That name is already used by UN1T Stillorgan on this WhatsApp account. Pick another name."
- **Sync at S** (`GET /api/whatsapp/templates?sync=true`). For each WABA among S's switched-on numbers, fetch from Meta, then:
  - update status and content on **S's own rows** for that WABA;
  - skip a template another studio already owns;
  - adopt a template no studio owns **only when S is the number's home studio**.
  - So syncing at Hatch never copies Stillorgan's templates into Hatch, and a template made directly in Meta's UI appears at the number's home studio.
  - Pagination: the sync fetches every page. Today it reads one page of 100.
- **Delete, resubmit, upload media:** all three run on the template's own WABA, through `getLocationNumberForWaba(template.location_id, template.business_account_id)`. None means 409 ("the number this template lives on is switched off at this studio").
- **Send:**
  - Every sender already reads templates `.eq('location_id', S)`. That stays.
  - The number a template send goes from is `getLocationNumberForWaba(S, template.business_account_id)`. Thread template sends (`getConversationReplyConfig(..., { template: true })`) use the thread number when its WABA matches the template's, otherwise the WABA lookup.
  - `templateLocationIdFor` and the `?conversation_id=` picker branch return the **thread's own studio**. A thread at Hatch shows Hatch templates.
- **Template status webhook:** matches `meta_template_id`. Meta's ids are globally unique and prod has no duplicates, so the same migration adds a partial unique index on `meta_template_id WHERE meta_template_id IS NOT NULL`. That makes the webhook's `.maybeSingle()` structural, not just de facto.
- **One-off data move** (mig, after the R5 code ships): `hatch_3_free_classes`, `hatch_book_your_week` and `hatch_first_class_waiting` (ids in §8) move to Hatch's `location_id`. Three sent Stillorgan broadcasts reference them, and that history stays as it is.
- **Fixed-purpose templates, chosen per studio.** Some senders hard-code a template name and look it up at the studio:
  - `booking_class_confirmed_` (`automations/booking-whatsapp-confirm.js:19`)
  - `booking_consult_confirmed` (`api/public/book/route.js:259`)
  - `event_waitlist_offer` (`lib/event-waitlist.js:47`)
  - the ad-lead welcome, `meta_ad_whatsapp_lead`
  - any others the builder finds by grepping for literal template names passed to a send.

  On a shared WABA, Hatch can never own a template with Stillorgan's name, so name lookup cannot work for Hatch.
  - New studio setting `locations.settings.whatsapp_purpose_templates`, e.g. `{ class_confirmed, consult_confirmed, event_waitlist_offer, meta_ad_welcome }`. Each value is a `whatsapp_templates.id` at that studio.
  - The studio's WhatsApp tab gets "Templates used for automatic messages": one picker per purpose, listing that studio's APPROVED templates of the right category.
  - Senders resolve the purpose through one helper: the setting's template, else today's hard-coded name at that studio, so Stillorgan is unchanged with no setting. A template id outside the studio is ignored and logged.
  - Until Hatch creates and Meta approves its own versions, and someone picks them, those sends skip quietly at Hatch (`send_failed` / not configured, as today). *(My call. This follows from Richard's "templates live per studio" and the operator-editable rule.)*

### R6 — consent per studio

- **STOP/UNSUBSCRIBE in a thread at studio S** (`applyWhatsappConsentKeyword`):
  - Upsert `contact_location_preferences (contact, S).whatsapp_marketing = false`, with `unsubscribed_at`.
  - Write `consent_log` with `location_id = S`.
  - Send the acknowledgement through the thread.
  - It **no longer** writes `contact_preferences.whatsapp_marketing`, and no longer sets `contacts.wa_status = 'opted_out'`. Both are contact-wide, and the mirror trigger (`sync_contact_location_preferences_trigger`) fans a contact-wide false out to every studio.
  - The ack copy names the studio: "You won't get WhatsApp marketing from UN1T Hatch Street any more. Reply START to opt back in." It is operator-editable per studio (customer-comms-editable rule), with this as the default.
- **START in a thread at S:** upsert the S row to `whatsapp_marketing = true` (insert when absent, `source 'whatsapp_keyword'`) and write `consent_log` with `location_id = S`.
- **Meta's own "stop promotions" preference** (`applyMetaUserPreference`) is a number-level control on Meta's side: Meta itself stops marketing templates from that business. It stays contact-wide, now scoped to contacts in the number's organisation (today's lookup is unscoped, `.limit(1)`). *(My call.)*
- **Historic `wa_status = 'opted_out'`** rows set by earlier, contact-wide STOPs stay as they are. The member said stop when STOP meant everything. *(My call.)*
- **Gates.** Each marketing WhatsApp send checks the S row (`contact_location_preferences.whatsapp_marketing = true`, row absent = no):
  - Already per studio: broadcasts and drips (`contact_location_audience`), sequences (`locationConsent`).
  - To change: Mia's follow-up and check-in templates (`followups.js` reads `contact_preferences.whatsapp_marketing`).
  - Unchanged: transactional paths keep `_administrative` + `wa_status` (booking confirmations), and radar outreach and the composer stay utility-only.
- **Risk Richard accepted:** a member who STOPs Hatch can still get Stillorgan messages from the same number. If they block or report the number, that lowers the quality rating both studios share. R7 limits the blast exposure.

### R7 — one limit per number, and Hatch blast sign-off

- **Daily limit:** `countBusinessInitiatedContactsLast24h` counts template sends across **every studio with that number switched on**. That replaces `[S, ...numberlessSiblingLocationIds]`.
  - `getSendBudget` takes the number. Blast and drip gates call it with the number they send from.
  - A studio with two numbers still over-counts (the existing accepted limitation; a per-message number column is a possible follow-up).
- **Quality:**
  - `refresh-whatsapp-health` and `applyNumberEvent` pause drips and push admins at **every studio with the number switched on**, not just `n.location_id`.
  - WABA-level events (`handleAccountUpdateEvent`, `applyNumberEvent` with `wabaId`) resolve to studios with any number on that WABA switched on.
- **Sign-off:**
  - New studio setting `locations.settings.whatsapp_blast_signoff_until` (ISO date). New columns `whatsapp_broadcasts.signed_off_by uuid` and `signed_off_at timestamptz`.
  - While the date is in the future, a broadcast or drip at that studio sends only if `signed_off_by` is set.
    - An org admin of the studio's organisation (`assertOrganizationAdmin`, master passes) sets it by sending, scheduling or starting the broadcast, or by pressing "Sign off" on a draft someone else made.
    - Anyone else's send, schedule or start answers 403: "Blasts at UN1T Hatch Street need sign-off from an organisation admin until 16 Nov 2026." The UI shows that line with a "Request sign-off" note in place of the button.
  - Because the cron has no actor, the gate sits in `sendBroadcast` / `sendDripChunk` and reads the row:
    - a scheduled blast without sign-off stays draft and managers are pushed (the existing refusal path);
    - a drip without sign-off pauses.
  - Covers broadcasts and drips only. Sequences are per-contact journeys, not blasts. Hatch has no broadcasts today, so nothing is caught mid-flight.
  - Set for Hatch at go-live to go-live + 30 days.

### R8 — who manages what

- **Org admins** (`profile_organizations.role = 'org_admin'`, master passes) add, edit, deactivate and delete numbers, choose a number's home studio, and run Embedded Signup.
  - New org-level routes: `/api/organizations/[id]/whatsapp/numbers` (+ `[numberId]`, + `embedded-signup`), guarded by `assertOrganizationAdmin`.
  - The existing per-location routes stop writing `whatsapp_numbers`. Each one either redirects or answers 410 with a pointer to the org page. The builder picks one, and nothing on mobile calls them.
- **Studio admins** (ADMIN_ROLES at the studio: master, owner, manager) switch an organisation number on or off at their studio and choose the studio default: `PUT /api/locations/[id]/whatsapp/numbers` with `{ numberId, on, isDefault }`. *(My call: ADMIN_ROLES, not MANAGER_ROLES, so head coaches can't switch a studio's WhatsApp on.)*
  - Switching off the default with another number still on promotes the newest remaining number to default.
  - Switching off the last one is allowed: the studio stops sending.
- **UI:**
  - There is no org settings page today; org surfaces are separate pages such as `/settings/billing` and `/settings/api-keys`. So this is a **new page** `/settings/whatsapp-numbers` (org admins) on a **new route tree** `/api/organizations/[id]/whatsapp/*`. It holds today's add, edit and Embedded Signup forms, moved, plus a home-studio picker.
  - The studio's integrations WhatsApp tab (`WhatsAppIntegrationTab.jsx`) lists the organisation's numbers, each with an on/off switch and a default radio, and links to the org page for adding a number.
  - The Integrations Hub drawer follows the same split.
- **Number-level settings that affect every studio using the number:**
  - Conversational automation (chat openers, `setConversationalAutomation`) and block (`setWhatsAppUserBlockState`).
  - Chat openers: editable only by org admins or at the number's home studio. *(My call.)*
  - Block: still allowed from any thread, but the confirm dialog says "This blocks them from messaging +353 1 578 9401 at every studio that uses it." *(My call.)*

## 5. Per-caller decisions (`tests/whatsapp-config-callers.test.js`)

The refusal semantics stay as they are. A studio with no number switched on gets the same 409, quiet skip or recorded skip it gets today. What changes is that "has a number" now means "has one switched on". Each row's `why` is rewritten to name WAORGNUMBER. The table stays exact, so a changed call count fails until the row is updated.

| Caller | Studio the send is for | Change |
|---|---|---|
| `src/lib/whatsapp.js` (resolver) | as passed | `resolveConfig` via R2. Template sends pick the number by the template's WABA. `sendBroadcast` / `sendDripChunk` budget per number (R7) and sign-off check (R7). |
| `whatsapp-own-number.js` (resolver) | as passed | Same contract. "Own" now means "switched on at S". |
| `whatsapp-media-server.js` | message's studio | Thread number when switched on there, else S's number. The sibling branch is deleted at §8 step 7. |
| `webhooks/whatsapp/route.js` | R4 winner | R4 `routeInboundThread`. Account and number events resolve to studios through link rows (R7). |
| `conversational-automation/route.js` | number's home | Org admin or home studio only (R8). |
| `templates/route.js` | S | Create on S's default WABA with a name-clash 409. Sync per R5. Picker by thread → thread's studio. |
| `templates/[id]/route.js` | template's studio | Delete on the template's WABA via `getLocationNumberForWaba`. |
| `templates/[id]/resubmit/route.js` | template's studio | Same. |
| `templates/upload-media/route.js` | S | S's default number's app and token. |
| `contacts/[id]/whatsapp/route.js` | contact's home | `getOrCreateConversation(home)`. Template number by WABA. 409 when home has nothing switched on. |
| `contacts/[id]/cancellation-form/route.js` | contact's home | Same. |
| `churn-radar/action/route.js` | radar's studio | Unchanged code path. Works at Hatch once Hatch is switched on. The refusal copy becomes "No WhatsApp number is switched on at UN1T Hatch Street." |
| `whatsapp/broadcasts/[id]/send/route.js` | broadcast's studio | R7 sign-off (403) before the existing 409 path. |
| `cron/run-whatsapp-broadcasts/route.js` | broadcast's studio | R7 sign-off: a scheduled send at a sign-off studio scheduled by a non-admin stays draft and managers are pushed (the existing refusal path). |
| `conversations/[id]/send` | thread's studio | Thread's own templates. Template number by WABA. A Flow across WABAs stays a 400. |
| `conversations/[id]/react`, `block`, `send-flow`, `whatsapp-carousel-send.js` | thread's studio | Through the thread. Block copy per R8. |
| `agent/auto-reply.js`, `agent/welcome-greeting.js`, `agent/notify.js` | thread's studio | Unchanged. The thread is at the right studio by R4. |
| `whatsapp-consent.js` | thread's studio | R6. |
| `agent/followups.js` | follow-up's studio | Drop the through-thread special case for numberless studios (§8 step 7). A studio with a number switched on sends with `{ locationId }` like Stillorgan. Template consent per R6. |
| `automations/booking-whatsapp-confirm.js` | booking's studio | Template via the studio's purpose setting (R5), falling back to today's name. Skips at Hatch until one is picked. |
| `automations/meta-ad-whatsapp-welcome.js` | ad's studio | Same (purpose `meta_ad_welcome`). |
| `cancellation-form/confirm.js` | thread's studio | Studio templates. Number by WABA. |
| `radar-outreach.js` | radar's studio | Unchanged code. Files at the radar studio (R3). |
| `sequences/steps.js` | sequence's studio | Unchanged code. Files at the sequence studio (R3). |
| `wa-studio-pick/resolve.js` | R4 | Studio list per R4 step 5. |

**Not callers but touched:**
- `getOrCreateConversation` (R3), `whatsapp-coexistence-ingest.js` (R4), `whatsapp-budget.js` (R7), `refresh-whatsapp-health` and `whatsapp-number-events.js` (R7).
- `whatsapp-thread-location.js`: `numberlessHomeStudio` and `numberlessSiblingLocationIds` are deleted at §8 step 7.
- `move_whatsapp_conversation` (mig 723): its "stamp the source studio's default number" reads the link table. A new migration re-creates the function, keeping its grants (`REVOKE … FROM PUBLIC, anon, authenticated`).

## 6. Invariant changes (CLAUDE.md, in the PR that ships each)

- **WACONFIGFALLBACK.1** becomes: "A location with no WhatsApp number **switched on** (`location_whatsapp_numbers` + an active `whatsapp_numbers` row) cannot send." The env tier stays retired. The WAHOMESTUDIO.1 exception paragraph is replaced by:
  - **WAORGNUMBER.1:** numbers belong to an organisation and are switched on per studio. A send for S goes from a number switched on at S. Its thread files at S. A reply files at the studio that quoted message or last outbound (7 days) belongs to, else the home studio, else the number's home studio. A number is never switched on outside its organisation (trigger). Templates are per studio and unique per WABA. A template send's number is picked by the template's WABA. STOP and START are per studio.
- **The consent invariant gains:** "STOP/START on WhatsApp write the thread studio's `contact_location_preferences` row only."

## 7. Testing

- **Migration static tests**, like `tests/migration-696-*.test.js`:
  - the link table, the org trigger, the backfill, the deprecation comment, the closed ACL;
  - the template column, the unique index and the duplicate check;
  - the re-created `move_whatsapp_conversation` and its grants.
- **Resolver:**
  - a switched-on number resolves;
  - a switched-off one refuses;
  - an inactive number refuses even when switched on;
  - another organisation's number is refused by the trigger (an SQL-level test where the harness allows, otherwise the static check);
  - the default ordering;
  - `getLocationNumberForWaba`;
  - config `locationId` / `homeLocationId`.
- **`routeInboundThread`:** a quoted message wins; the most recent outbound within 7 days wins; outbound older than 7 days falls through to home; home not switched on → number's home; unknown sender → number's home and the picker; a member of two studios; BSUID-only senders.
- **`getOrCreateConversation`:** files at S, stamps, replaces an off stamp.
- **Templates:** create on S's WABA; name clash 409; sync adopts only at the home studio, skips other studios' rows, and pages; the send picks its number by WABA; the thread picker shows the thread studio's rows.
- **Consent:** STOP at Hatch writes only Hatch's row and a log row with `location_id`, and leaves `wa_status` and `contact_preferences` alone; START upserts; Mia follow-ups gate on the studio row; the Meta preference is org-scoped.
- **Budget:** counts across every studio with the number on; the sign-off 403 for a non-admin; an admin passes; scheduled-send behaviour.
- **Numbers admin:** org routes guarded by `assertOrganizationAdmin`; the studio toggle guarded by ADMIN_ROLES at the studio; a toggle cannot reach another organisation's number; default promotion.
- **Health and events:** pause and push at every studio with the number on.
- `tests/whatsapp-config-callers.test.js` updated row by row. `check:select-columns`, `check:rpc-names`, `check:location-scoping` and `check:route-guards` all pass.
- **Live:** §8 steps 6–8.

## 8. Rollout

Migrations are forward-only and applied via the Supabase MCP, each before the code that reads it. Every PR adds `docs/changelog/entries/<PR>.md`.

1. **PR 1: org numbers + switch-on + resolver + admin UI** (mig: `organization_id`, link table + trigger + backfill, `is_default` deprecation, `move_whatsapp_conversation` re-created).
   - Behaviour-neutral: Stillorgan's link row reproduces today, and the WAHOMESTUDIO sibling clause stays.
   - Ships R1, R2 and R8, plus R7's health and events fan-out.
2. **PR 2: templates per studio** (mig: `business_account_id`, backfill, the two unique indexes, `whatsapp_broadcasts.signed_off_*` can ride here or in PR 4). Ships R5 code, including the per-studio purpose templates and their picker. Then a data mig moves the three `hatch_*` rows (`d67d6570-f64b-4d5c-8e19-fe3729f29c3d`, `9118c478-5958-4655-9737-8e5c33bcc0fc`, `a0e011b2-67a2-4121-833b-fa867ee8b8bf`) to Hatch.
3. **PR 3: per-studio WhatsApp consent.** R6, plus the editable ack copy.
4. **PR 4: per-number budget + blast sign-off + the composer, cancellation form and radar changes.** R3 for staff sends, and R7.
5. **PR 5: inbound routing.** R4 (`routeInboundThread`, webhook + coexistence ingest, studio picker list) and R3's outbound filing at S.
   - Before Hatch is switched on, `numberlessHomeStudio` keeps applying where the home studio has nothing switched on, so Hatch threads keep filing at Hatch. Once Hatch is on, it no longer fires.
6. **Go-live check (Richard).** I produce a dry-run list of every Hatch automation that will start sending: active sequences with WhatsApp steps, scheduled broadcasts and drips, booking- and event-confirmation settings, the ad-welcome flag, and radar. Richard reviews it, then switches +353 1 578 9401 on at Hatch in the studio WhatsApp tab and sets `whatsapp_blast_signoff_until`.
   - **Live smoke**, with a test contact on Richard's phone homed at Hatch, with Hatch consent:
     1. He messages the number. It lands in the Hatch inbox, and that opens the 24-hour window.
     2. A staff free-text reply and a radar win-back (free text, `sendTextMessage`) arrive from the number and file in the same Hatch thread.
     3. STOP opts out at Hatch only: the Stillorgan row is untouched, and so is `wa_status`. START restores it.
   - A template smoke (radar outreach needs an APPROVED UTILITY template at the studio) follows once Hatch's first utility template is approved.
7. **PR 6: cleanup.** Delete WAHOMESTUDIO's sibling clause (R2), `numberlessHomeStudio`, `numberlessSiblingLocationIds`, `findMovedNumberlessThread` and `followups.js`'s through-thread branch. Rewrite the invariants (§6).
8. **Mia at Hatch:** after the Mia-at-Hatch spec ships, Richard flips `customer_agent.enabled` at Hatch. Not part of this work.

**Rollback:**
- PRs 1–5 revert cleanly. The link table and the new columns stay on disk, unread.
- Switching Hatch off (untick) returns Hatch to today's behaviour until PR 6.
- After PR 6, switching Hatch off makes Hatch threads unanswerable, which is what "off" means.

## 9. Risks

- **Shared quality rating.** One studio's badly received blast can restrict the number for both. Mitigated by the shared limit, the sign-off window and the existing auto-pause, which now fans out to every studio.
- **Wrong-studio replies for dual members.** "Last outbound in 7 days" can mis-file a reply about the other studio. Staff can move the thread (`move_whatsapp_conversation`), and the quoted-message rule catches direct replies.
- **Per-studio STOP versus one chat.** The member sees one chat. A STOP aimed at "all of UN1T" only stops the studio whose thread it reached. Richard decided this (Q6). The ack names the studio, so the member knows.
- **Template ownership drift.** Templates created directly in Meta's UI land at the number's home studio. Hatch must create its templates in the CRM.
- **The config `locationId` meaning changes.** A missed reader could file or authorise against the wrong studio. Mitigated by the audit in R2, and by tests on every reader named there.
