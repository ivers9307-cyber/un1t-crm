# Hatch Street waitlist — lead-capture form — design

**Date:** 2026-06-08
**Status:** Approved (design) — pending spec review → implementation plan
**Author:** Claude (brainstormed with Richard)

## Problem

The new Hatch Street studio opens in September. We need a public **lead-capture
(founding-member waitlist) form** on the marketing site so interest can be
collected now, ahead of opening. The CRM has no general lead-capture primitive —
public submissions today only exist as the *Booking* widget (`/api/public/book`)
and *Event* signup (`/api/public/events/[slug]/register`), both of which assume a
bookable slot / event. A pre-open waitlist needs neither.

## Decisions locked during brainstorming

- **Goal:** founding-member **waitlist** (capture interest pre-open), not a booking
  slot or a paid pre-sale.
- **Fields:** name, email, phone + a consent checkbox. **No qualifier fields**
  (highest conversion).
- **Follow-up:** **capture only** for now — instant on-page thank-you, no automated
  messages. The nurture sequence is built later; the form must leave a clean seam
  so it can be attached with zero code.
- **Approach:** build a reusable **`lead_form` landing-page block** + a
  **`/api/public/leads`** endpoint (the durable, on-pattern primitive), not a
  bespoke page and not a bent Event block.
- **Consent:** one explicit, unticked checkbox granting all three marketing
  channels (email + SMS + WhatsApp).
- **Pipeline:** create a `new_lead` deal so leads appear in the pipeline.
- **Spam:** honeypot + rate-limit, no captcha.

## Goals

- A master/owner can drop a waitlist form onto any studio marketing page from the
  existing landing-page editor.
- A visitor submits name/email/phone + consent and is captured as a Hatch
  `new_lead` with consent recorded and a nurture tag applied.
- The nurture sequence can be attached **later with no code** (trigger on the tag,
  or bulk-enrol the segment).

## Non-goals

- The nurture/drip content itself (built later in the sequence builder).
- Booking slots, events, or payments.
- Qualifier fields, multi-step forms, double opt-in (all deferred; easy to add).
- A new lead/contact data model — reuse `contacts` / `deals` / `contact_preferences`
  / `consent_log` / `contact_tags`.

## Architecture

A new **`lead_form` block** (operator-editable, in the existing block system)
renders the form on a studio page. On submit it POSTs to a new public
**`/api/public/leads`** endpoint, which captures the lead by reusing the existing
contacts/deals/consent/tags tables. No migration (blocks live in the schemaless
`landing_page_settings.blocks` JSONB).

```
visitor → <LeadFormBlock> (on /hatch-street) → POST /api/public/leads
  → resolve+validate location from public_path
  → find-or-create contact (Hatch) → contact_preferences + consent_log
  → contact_tags(+hatch-founding-member) → triggerSequencesForTagsAdded (no-op for now)
  → ensure new_lead deal
  → { success: true } → on-page thank-you
```

## Components

### 1. `lead_form` block type — `src/lib/landing-page-blocks.js`
Add to `BLOCK_TYPES` (alongside `booking`/`event`) with a factory matching the
existing pattern (`() => ({ id: newBlockId(), type: 'lead_form', ... })`) and a
Zod entry. Operator-editable fields:

| Field | Default | Purpose |
|---|---|---|
| `heading` | "Join the founding members" | Section headline |
| `subtext` | "Be first through the doors at Hatch Street this September." | Sub-copy |
| `button_label` | "Join the waitlist" | Submit button |
| `success_message` | "You're on the list — we'll be in touch." | Post-submit state |
| `consent_label` | (the consent sentence, below) | Checkbox label |
| `tag` | `hatch-founding-member` | Nurture-seam tag stamped on every lead |
| `lead_source` | `hatch_launch` | Attribution |

### 2. `<LeadFormBlock>` renderer — `src/components/landing-page/BlockRenderers.jsx`
A client component: name / email / phone inputs + the consent checkbox + a hidden
honeypot field; POSTs to `/api/public/leads`; swaps to `success_message` on success;
inline error on failure. It needs the page's `public_path` (see Data flow) — so
**`BlockRenderer` gains a `publicPath` prop** threaded from the studio page; all
other block renderers ignore it.

### 3. Block editor panel — `src/components/LandingPageSettingsForm.jsx`
Add an edit panel for the `lead_form` block's fields (the seven above), matching how
the existing blocks are edited. `tag` + `lead_source` are advanced/optional with the
defaults pre-filled.

### 4. `POST /api/public/leads` — `src/app/api/public/leads/route.js` (new)
- `export const runtime = 'nodejs'`. Public — already covered by the `/api/public/`
  prefix in both the proxy `publicPaths` and the `un1t-marketing` brand allowlist
  (no proxy change).
- **Rate-limit** at the top: `checkRateLimit(db, 'lead:'+ip, { max: 8, windowMs: 15*60_000 })` (fail-open, like the booking endpoint), `rateLimitResponse()` on trip.
- **Honeypot:** a body field (e.g. `company`) that must be empty; if filled, return
  `{ success: true }` **without** writing anything (silent bot trap).
- **Validate** with Zod (`src/lib/leads.js`): `first_name` (1..120), `email`,
  `phone` (normalised via the repo's phone handling), `consent` (literal `true`),
  `public_path` (1..120), `tag` (1..80), `lead_source` (1..80), `company` honeypot
  (optional, must be empty).
- **Resolve location:** look up `landing_page_settings` by `public_path` → its
  `location_id`. If none, 400. **The client never sends a raw `location_id`** — this
  prevents targeting an arbitrary location (IDOR), and only locations that have a
  public page can receive leads.
- **Capture (service-role):**
  1. Find-or-create `contacts` by (`location_id`, lower(`email`)). On create: set
     `first_name`, `email`, `phone`, `lead_source`. On match: fill blank
     `first_name`/`phone`/`lead_source` only (don't overwrite existing data).
  2. Upsert `contact_preferences`: `email_marketing` / `sms_marketing` /
     `whatsapp_marketing` = `true`; write a `consent_log` row (source
     `hatch_waitlist_form`, IP, timestamp, the granted scopes).
  3. Apply the tag via the existing `src/lib/contact-tags.js` helper (inserts into
     `contact_tags` + fires `triggerSequencesForTagsAdded` — a no-op until a matching
     sequence exists).
  4. Ensure an open `new_lead` deal for the contact (so it lands in the pipeline),
     following the existing deal-creation pattern.
- **Response:** `{ success: true, already_on_list: boolean }`. Re-submitting the
  same email **updates, never duplicates**.

### 5. Pure lib — `src/lib/leads.js` (+ `leads.test.js`)
Holds the Zod schema and any pure transforms (e.g. `normaliseLeadInput` → trimmed
name / lowercased email / normalised phone; `buildNewContactFields`). Kept pure so
the route stays thin and the logic is unit-tested without a DB.

## Consent (GDPR / Ireland ePrivacy)

One **explicit, unticked** checkbox. Label:

> "I'd like to hear from UN1T about the Hatch Street launch and offers by email, SMS
> and WhatsApp. I can opt out anytime." (+ link to `/privacy`)

Submitting requires it ticked (Zod `consent === true`). It grants the three
`_marketing` flags and writes a `consent_log` row for audit. Single opt-in (no email
double-opt-in) — standard and sufficient here; double-opt-in can be added later.

## The nurture seam (capture-only now, sequence later)

Every lead lands as: Hatch `new_lead` deal + `lead_source=hatch_launch` +
`contact_tags` = `hatch-founding-member`. To attach the nurture later, **no code**:

- Build a sequence with `trigger_type='tag_added'`, `trigger_config.tag='hatch-founding-member'` → auto-enrols every *new* lead, and/or
- Save the cohort as an AudienceBuilder **segment** (tag/lead_source filter) and
  bulk-enrol the *existing* leads via `SequencePicker`.

## Placement

Operator adds the `lead_form` block to the Hatch Street page in
`/settings/landing-page` (under or replacing the current Event block) and points the
hero "Join now" CTA at it. Reusable on Stillorgan / future pages.

## Error handling

- Validation failure → 400 `{ success:false, error, issues }` (standard shape);
  the form shows an inline message.
- Rate-limit trip → 429 via `rateLimitResponse()`.
- Honeypot filled → 200 `{ success:true }`, nothing written.
- Consent/`contact_preferences`/tag/deal steps wrap individual failures so a
  non-critical step (e.g. the tag) can't lose the captured contact — but a failed
  **contact** create returns an error (that's the primary write). The
  `triggerSequencesForTagsAdded` call is best-effort (errors swallowed + logged),
  matching the repo's fire-and-forget side-effect convention.
- Rate-limiter is fail-open (a Supabase blip can't block submissions).

## Testing

- `src/lib/leads.test.js` — Zod schema (valid; rejects missing/blank fields; rejects
  `consent !== true`; honeypot must be empty) + the pure transforms (email
  lowercasing, phone normalisation, name trim).
- Block factory/schema test — the `lead_form` block validates and round-trips through
  the blocks Zod.
- Manual end-to-end: add the block to the Hatch page, submit → confirm a Hatch
  `new_lead` contact with the tag + marketing consent + a `consent_log` row;
  re-submit the same email → no duplicate; honeypot-filled submit → no write;
  blank-consent submit → rejected.

## Files touched

| File | Change |
|---|---|
| `src/lib/landing-page-blocks.js` | add `lead_form` block type + factory + Zod |
| `src/components/landing-page/BlockRenderers.jsx` | add `<LeadFormBlock>`; thread `publicPath` |
| `src/app/welcome/[location]/page.js` | pass `publicPath={params.location}` into `BlockRenderer` |
| `src/components/LandingPageSettingsForm.jsx` | edit panel for the `lead_form` block |
| `src/app/api/public/leads/route.js` | new public capture endpoint |
| `src/lib/leads.js` + `src/lib/leads.test.js` | new — Zod schema + pure transforms + tests |

No migration (reuses existing tables; block lives in the `blocks` JSONB).

## Open questions

None outstanding. Brainstorming locked: waitlist goal, essentials-only fields,
capture-only follow-up, the `lead_form` block approach, single all-channel consent
checkbox, `new_lead` deal creation, honeypot + rate-limit (no captcha), and the
tag-based nurture seam. Two minor implementation details to confirm during the plan
(not blockers): the exact `contact-tags.js` helper signature, and the canonical
`new_lead` deal-creation helper/pattern.
