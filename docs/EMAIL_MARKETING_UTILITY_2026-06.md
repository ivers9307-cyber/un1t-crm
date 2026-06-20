# Email Marketing / Utility send type (2026-06)

**Status:** design — awaiting review
**Scope:** let the operator pick **Marketing** or **Utility** when composing an email. Marketing applies the marketing opt-in (today's behavior); Utility is for booking/transactional content — it ignores the marketing opt-out (but still honors the transactional opt-out + hard deliverability signals) and sends via Postmark's transactional stream.

The motivating case pairs with the new event-registration filter: *"email everyone registered for Saturday's workshop with a logistics update"* → audience = "Registered for event X", type = **Utility**, so it reaches registrants even if they opted out of marketing.

---

## 1. Background — what already exists

- **Two Postmark streams** (`src/lib/postmark.js`): `broadcast` (marketing — appends the unsubscribe footer + `List-Unsubscribe` header) and `outbound` (transactional — no footer). The sender **already** suppresses the footer/header when `stream === 'outbound'` (postmark.js ~L91, L148). So the send side largely works; it's just never driven per-campaign.
- **`campaigns.postmark_stream`** column already exists (mig 005, `DEFAULT 'broadcast'`) but is **dormant** — `email-draft` never sets it, and `campaign-sender.js` always sends `broadcast` + gates the audience on `email_marketing`.
- **Audience query** (`buildAudienceQuery` / `buildAudienceQueryAsync`) is **single-table on `contacts`** (deliberate — avoids the PostgREST count-under-embed bug) and hardcodes `.eq('email_marketing', true).not('email_status','in','("bounced","complained")')`.
- **Consent model** (`contact_preferences`): `email_marketing` (broadcasts) vs `email_administrative` (transactional). Reminders/confirmations gate on `email_administrative`. **`email_marketing` is denormalized onto `contacts` (mig 155); `email_administrative` is NOT** — it lives only on `contact_preferences`.

---

## 2. Data model — denormalize `email_administrative` (migration 301)

To keep the audience query single-table and count-safe, denormalize `email_administrative` onto `contacts`, mirroring mig 155 exactly:

- `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_administrative BOOLEAN NOT NULL DEFAULT TRUE;`
- **Backfill** from `contact_preferences` (`COALESCE(p.email_administrative, true)`).
- **Trigger** `sync_contacts_email_administrative()` + `AFTER INSERT OR UPDATE OF email_administrative ON contact_preferences` — copies onto `contacts.email_administrative` (verbatim shape of mig 155's `sync_contacts_email_marketing`, incl. `SET search_path = ''` and the `IS DISTINCT FROM` guard).
- **No index.** Unlike `email_marketing` (many opt-outs → a partial `WHERE email_marketing=true` index is selective), `email_administrative=true` is the near-universal default (~99% of rows), so a partial index on `=true` indexes almost everything — low selectivity, not worth the write cost. The `location_id` filter + existing indexes suffice.

`contact_preferences` remains the source of truth; the `contacts` mirror is read-only to app code (write to `contact_preferences`, the trigger propagates).

---

## 3. Audience consent gate — parameterized

`buildAudienceQuery` / `buildAudienceQueryAsync` (`src/lib/postmark.js`) gain a `consentField` option (default `'email_marketing'` — zero behavior change for existing callers):

```js
buildAudienceQueryAsync(db, filter, locationId, { columns, selectOpts, consentField = 'email_marketing' })
// gate becomes: .eq(consentField, true).not('email_status','in','("bounced","complained")')
```

- **Marketing** (`broadcast`) → `consentField = 'email_marketing'` (unchanged).
- **Utility** (`outbound`) → `consentField = 'email_administrative'`.

The hard-bounce/complaint exclusion stays for **both** — a Utility email never goes to a bounced/complained address. (Note: `email_marketing=false` from a marketing unsubscribe does NOT block Utility — that's the whole point; the transactional opt-out is the separate `email_administrative` flag.)

`consentField` is whitelisted to exactly `{'email_marketing','email_administrative'}` in the helper (defense-in-depth — never interpolate an arbitrary column).

---

## 4. Send path

`campaign-sender.js` reads `campaign.postmark_stream` once and derives:
- `consentField` for the audience query (`outbound → email_administrative`, else `email_marketing`).
- The Postmark `MessageStream` passed to the batch sender (`campaign.postmark_stream`).
- For `outbound`: **do not build/append the unsubscribe URL** (the sender already suppresses the footer + `List-Unsubscribe` header for `outbound`; we also leave the `{{unsubscribe_url}}` merge tag empty so a Utility template has no marketing chrome).

`/api/campaigns/[id]/preview` (the preview/count route) reads the campaign's `postmark_stream` and passes the matching `consentField`, so the preview count reflects the real Utility/Marketing audience.

---

## 5. Composer UI + persistence

- **`UnifiedSendComposer`** email step: a **Marketing / Utility** segmented toggle, default **Marketing**. Helper line under Utility: *"Booking/transactional only — ignores marketing opt-out. Using this for marketing breaches consent."*
- The choice posts to **`/api/communications/email-draft`** as `email_type: 'marketing' | 'utility'` (Zod enum, default `'marketing'`). The route maps it to the insert: `postmark_stream: email_type === 'utility' ? 'outbound' : 'broadcast'`.
- **`CampaignEditor`** surfaces the same toggle (editable) so the type is visible/changeable when finalizing in the Unlayer editor. It persists via the existing campaign update route (`PUT /api/campaigns/[id]`), which gains an optional `email_type: 'marketing'|'utility'` field mapped server-side to `postmark_stream` (manager-gated as today). **API surfaces speak `email_type`; only the DB layer uses `postmark_stream`** — the frontend never touches `broadcast`/`outbound`.

---

## 6. Live count — unchanged (explicit non-goal)

The composer's `/api/communications/audience-count` stays **channel-agnostic** (it already doesn't apply `email_marketing` today — it counts all filter-matching contacts at the location). We are NOT coupling that shared, multi-channel count to the email type. The *actual* per-type reachable count surfaces in the email preview/send result (§4), which is the right place for an email-specific number.

---

## 7. Compliance note

Utility = operator asserts the content is transactional (same trust model as WhatsApp's MARKETING-vs-UTILITY template categories). No per-booking linkage is enforced. The helper text is the guardrail; we deliberately don't hard-block (the operator is the business owner). Misusing Utility for marketing is a consent breach — the wording makes that explicit.

---

## 8. Testing

- **Audience helpers**: `consentField` defaults to `email_marketing`; switches to `email_administrative` when passed; rejects any other value; hard bounced/complained excluded for both.
- **Migration**: contract test that the trigger keeps `contacts.email_administrative` in sync with `contact_preferences.email_administrative` (mirror mig 155's test if present).
- **email-draft route**: `email_type:'utility'` → inserted `postmark_stream:'outbound'`; omitted/`'marketing'` → `'broadcast'`.
- **campaign-sender**: an `outbound` campaign uses the `email_administrative` consent field + `outbound` MessageStream + no unsubscribe footer (assert via the sender's per-email payload).
- **CampaignEditor / campaign PUT**: `postmark_stream` round-trips.

---

## 9. Out of scope

- SMS / WhatsApp send-type selection (own consent models; WA already has template categories).
- Per-booking linkage / verification that a Utility send truly relates to a booking.
- Changing the shared audience-count semantics (§6).

---

## 10. File change list

**Migration:** `supabase/migrations/301_denormalise_email_administrative.sql` (+ test if the repo tests migrations).
**Edited libs:** `src/lib/postmark.js` (`consentField` param on both builders), `src/lib/campaign-sender.js` (stream-driven consent + send stream + footer).
**Edited routes:** `src/app/api/communications/email-draft/route.js` (`email_type` → `postmark_stream`), `src/app/api/campaigns/[id]/preview/route.js` (consent field from stream), `src/app/api/campaigns/[id]` PUT (accept `email_type`, map to `postmark_stream`).
**Edited UI:** `src/components/communications/UnifiedSendComposer.jsx` (toggle + helper), `src/components/CampaignEditor.jsx` (toggle).
**Tests:** `src/lib/postmark.test.js` (or equivalent), `email-draft` route test, `campaign-sender` test.
