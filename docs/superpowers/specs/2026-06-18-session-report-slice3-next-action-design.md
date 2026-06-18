# Session Report — Slice 3: next_action (book-next-class / become-a-member CTA) — design spec

- **Date:** 2026-06-18
- **Status:** Draft for review
- **Ticket:** SESSION-REPORT.3
- **Slice:** Slice 3 of the post-class Session Report. Fills the reserved `next_action` null slot with a **context-aware, operator-editable** call-to-action: active members get "Book your next class"; everyone else gets "Become a member". Rendered on the champ-app session view + the post-class email; exposed by the report API for the future native app.
- **Repos:** `un1t-crm` (canonical builder + email + settings field/UI) and `champ-app` (byte-identical builder + loader + session view). **No migration** (config rides existing `locations.settings` JSONB).

## Goal

Give a member something to do right after the report: the right next step for *where they are in the funnel*. Active members → book their next class; trials / leads / lapsed / ClassPass / unknown → become a member. Both the **URLs and the button copy are operator-editable after deployment** (per the standing rule that customer-facing communication must be controllable without a code release) — defaults act only as placeholder fallbacks so a blank never renders an empty button.

## Why this shape (grounded in current state)

- The `next_action` slot is `null` in `buildSessionReport` (`src/lib/hr-session-report.js`, byte-identical in both repos). The pure builder receives no contact/location/membership data today — the loaders must supply a small CTA bundle.
- **`membership_signup_url` already exists** per location at `locations.settings.customer_agent.membership_signup_url` (operator-set on **Settings → Customer agent**, `z.string().url().max(512).nullable()`, used by the customer agent's join hand-off). The "become a member" branch reuses it verbatim.
- **No "book a class" URL exists** anywhere — net-new. It rides the same `locations.settings.customer_agent` JSONB (sibling field), so **no migration**.
- **The funnel stage is cheap to read** — `contacts.pipeline_stage_slug` is denormalised on `contacts` (mig 155) and is the canonical funnel field. The member/prospect split keys on it.
- The builder is pure → CTA resolution (DB reads) happens in the loaders, which pass a `cta` bundle into `ctx`; same architecture as Slices 1–2.

## Architecture

### Config (no migration) — operator-editable URLs + labels

`locations.settings.customer_agent` (existing JSONB) gains three sibling fields next to `membership_signup_url`:

| field | default (fallback only) | purpose |
|---|---|---|
| `booking_url` | `null` | where active members go to book their next class |
| `booking_cta_label` | `"Book your next class"` | the member CTA button text |
| `membership_cta_label` | `"Become a member"` | the prospect CTA button text |

(`membership_signup_url` already exists and is reused unchanged.)

**Settings → Customer agent** page gets three inputs (mirroring the existing `membership_signup_url` input): a **Class booking link** URL field, and two **CTA wording** text fields. The label inputs show the default as the HTML `placeholder`; saving them blank stores `null` and the builder falls back to the default — so the displayed copy is always operator-controllable (type to change, no deploy) yet never empty. Same `PUT /api/settings/customer-agent` route + Zod schema, extended:
- `booking_url: z.string().url().max(512).nullable()`
- `booking_cta_label: z.string().max(60).nullable()`
- `membership_cta_label: z.string().max(60).nullable()`

### The decision logic (pure)

A pure helper in the byte-identical report lib (`hr-session-report.js`), with the default copy as the only hard-coded strings (fallbacks):

```js
export const DEFAULT_BOOK_CTA = 'Book your next class'
export const DEFAULT_JOIN_CTA = 'Become a member'
const MEMBER_STAGES = ['active_member', 'at_risk_member']

export function buildNextAction(cta) {
  if (!cta) return null
  const isMember = MEMBER_STAGES.includes(cta.stage)
  if (isMember) {
    if (!cta.bookingUrl) return null
    return { type: 'book_class', label: cta.bookingLabel || DEFAULT_BOOK_CTA, url: cta.bookingUrl }
  }
  if (!cta.membershipSignupUrl) return null
  return { type: 'join', label: cta.membershipLabel || DEFAULT_JOIN_CTA, url: cta.membershipSignupUrl }
}
```

`buildSessionReport` sets `next_action: buildNextAction(ctx.cta)`. Payload:

```jsonc
"next_action": { "type": "book_class", "label": "Book your next class", "url": "https://…" }  // | {type:'join',…} | null
```

- **Member stages** (`active_member`, `at_risk_member`) → `book_class` (uses `booking_url`).
- **Everyone else** (trials, leads, hot_conversion, lapsed, dormant, classpass_active, dormant_classpass, **null/unknown stage**) → `join` (uses `membership_signup_url`).
- **`null`** when the chosen branch's URL is unset — graceful, no broken/empty CTA.

### Data flow (builder stays pure)

Loaders resolve `ctx.cta = { stage, bookingUrl, bookingLabel, membershipSignupUrl, membershipLabel }`:

- **un1t-crm email** (`hr-post-class-email.js` `loadContextForSession`, service-role): add `pipeline_stage_slug` to the `contacts` embed; read the session location's `settings.customer_agent` and pull the four fields. Pass `cta`.
- **champ-app** (`load-session-report.js`): read the member's own `pipeline_stage_slug` (customer-self RLS — their own contact row); read the location's `settings.customer_agent` URLs+labels via the **service client** (`createServiceClient` already exists in champ-app; the customer RLS client can't read `locations`, and these are public marketing links + labels — extract only the four CTA fields, never the wider settings blob). Pass `cta`.
- The pure `buildSessionReport` calls `buildNextAction(ctx.cta)`. Byte-identical in both repos; the shared `session-report.fixture.json` covers the branches.

### Surfaces

- **champ-app session view** (`src/app/sessions/[id]/page.jsx`): a CTA section after the zone breakdown, rendered only when `next_action` is non-null — one primary button (`next_action.label` → `next_action.url`, `target="_blank" rel="noreferrer"`), themed with the app's accent.
- **post-class email** (`hr-post-class-email.js` `composeEmail`): a button before the unsubscribe footer, mirroring the existing "View the full session" button markup, when `next_action` is non-null.
- **report API** (champ-app `GET /api/sessions/[id]/report`): no change — the slot just becomes non-null.

## In scope

- Three operator-editable fields on `locations.settings.customer_agent` (`booking_url`, `booking_cta_label`, `membership_cta_label`) + their inputs on Settings → Customer agent + the PUT schema.
- `buildNextAction` pure helper + `next_action` wired in `buildSessionReport` (both repos, byte-identical) + shared fixture + tests.
- Both loaders resolve + pass the `cta` bundle (champ-app reads the URLs via the service client).
- Render the CTA on the champ-app session view + the post-class email.

## Out of scope (deliberate)

- **Per-class-type deep links** ("book another RIDE") — a generic per-location booking link for v1.
- **A migration / new column** — config rides existing `locations.settings` JSONB.
- **Changing `membership_signup_url`** or the customer agent's existing behaviour — purely additive.
- **Slice 4** (native push + shareable card) — separate; needs the native app to exist.
- **Version bump** — filling the reserved slot changes no existing field; `SESSION_REPORT_VERSION` stays **1**.

## Data flow (diagram)

```
operator → Settings → Customer agent → PUT /api/settings/customer-agent
   → locations.settings.customer_agent { membership_signup_url, booking_url, booking_cta_label, membership_cta_label }

member opens report (champ-app) OR session-end email fires (un1t-crm)
   → loader: read contact.pipeline_stage_slug + the location's 4 CTA fields
            (champ-app: stage via customer RLS client; URLs/labels via service client)
   → ctx.cta = { stage, bookingUrl, bookingLabel, membershipSignupUrl, membershipLabel }
   → buildSessionReport → buildNextAction(cta) → next_action | null
   → rendered as a button on the session view + the email; returned by the report API
```

## Edge cases

- **Chosen URL unset** → `next_action: null` (no CTA). E.g. a member at a location with no `booking_url`, or a prospect with no `membership_signup_url`.
- **Blank label** → the default copy renders (never an empty button); the operator can override anytime.
- **Null / unknown `pipeline_stage_slug`** → `join` branch (treat as prospect — the safer nudge).
- **Null-contact (walk-in) sessions** → don't get customer reports; not applicable.
- **champ-app can't read `locations`** → resolved via the service client reading only the four CTA fields; if that read fails, `cta` URLs are null → `next_action: null` (graceful).

## Testing

- **Pure `buildNextAction`:** member→book (with + without custom label), prospect→join, null-url→null (each branch), null/unknown stage→join, blank-label→default. Via unit cases + the shared fixture (extended with a `cta` block).
- **Settings PUT:** the three new fields validate (URL format, label max length, nullable) + persist into `settings.customer_agent`.
- **Loaders:** `cta` bundle assembled correctly (stage + 4 fields); champ-app uses the service client for the URL read.
- **Renderers:** thin — covered by the builder tests + a render smoke check (view button + email button), including the null (no-CTA) path.

## Rollout

- **No migration.** Two PRs (un1t-crm: settings field/UI + email loader/render + builder + fixture; champ-app: byte-identical builder + loader + view). Both auto-deploy on merge.
- `next_action` stays `null` until the operator sets `booking_url` (and/or has `membership_signup_url`) on Settings → Customer agent — graceful, like the other slices awaiting config. Copy is editable from day one (defaults shown as placeholders).

## Open questions

1. **Member stage mapping** — `active_member` + `at_risk_member` → book; everything else → join. Confirm, or adjust (e.g. include `classpass_active` in book, or treat `lapsed`/`dormant` specially). *Default: the two above → book.*
2. **Booking-link home** — `booking_url` assumed to live alongside `membership_signup_url` under `settings.customer_agent`. Alternative: a "studio"/HR settings block. *Default: customer_agent (operator already manages the sibling URL there).*
3. **Default copy** — "Book your next class" / "Become a member" as the placeholder fallbacks. Confirm wording. *Default: those two.*
