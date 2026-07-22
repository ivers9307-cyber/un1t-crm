# Glofox Class Booking Funnel — landing-page block

**Date:** 2026-07-22
**Status:** Design approved (brainstorming), pending spec review
**Branch / worktree:** `glofox-class-funnel-block` @ `~/code/un1t-crm-glofox`

## Problem

The multi-step class-booking funnel that runs the Meta paid-ads landing page
(the details → pick-a-class → booked flow, with a free-consult upsell) lives
**only** as a hardcoded component (`src/components/StartFunnel.jsx`) mounted on
two code-defined pages (`/start`, `/free-class`). Operators can't drop it onto
any of the operator-editable landing pages (`landing_page_settings` blocks,
rendered on `/welcome/[location]`).

We want it available as an **insertable block** so it can be placed on any
editable landing page, and named per-platform (**Glofox Class Booking Funnel**)
so that future platforms get their own sibling blocks.

## Goals

- A new `class_funnel` block, addable from the landing-page editor palette on
  **any** location's page (unrestricted).
- The block is **location-aware**: it inherits the `location_id` / `public_path`
  of the page it sits on and pulls that location's Glofox classes + the
  operator-chosen consult event. No per-block location config.
- **Single source of truth**: the funnel logic lives in one prop-driven
  component. `/start` is rewired onto it so it can't drift.
- Key copy is operator-editable (heading, subhead, consent label, success
  messages), per the "customer-facing copy must be operator-editable" invariant.

## Non-goals

- Making Glofox classes appear on non-Glofox locations. Only Stillorgan is
  Glofox-connected; elsewhere the picker shows the existing graceful empty
  state. The block is reusable; the **data** behind it is Stillorgan-only until
  another gym connects Glofox.
- Building sibling blocks for other platforms (Mindbody, etc.). This design just
  establishes the seam ("resolve classes for this location") that a future
  platform block would swap out.
- Restricting the palette to Glofox-connected locations (explicitly declined —
  unrestricted, empty state is graceful).
- Changing the consult booking flow itself (already slug-based and reusable).

## Known ceiling (accepted)

Only Stillorgan has live Glofox classes (`glofox_invoices`/branch invariant).
Dropping this block on a Hatch/other page renders the funnel but the class
picker returns `[]` → existing copy: *"No classes are bookable online right now
— message us and we'll get you booked in."* This is by design and requires no
new handling.

## Architecture

### The one design decision: location resolution via `public_path`

Two public endpoints are currently hardcoded to `public_path='stillorgan'`:

- `GET /api/public/classes` — resolves `landing_page_settings` where
  `public_path='stillorgan'` → `location_id` → `listPublicClasses(db, locId, n)`.
- `POST /api/public/class-booking` — same lookup to validate/resolve the class.

**Decision:** the block passes the page's **`publicPath`**; the routes resolve
`location_id` from the `landing_page_settings` row for that path.

Rejected alternative — passing a raw `location_id` from the client — because a
public endpoint accepting an arbitrary `location_id` is an enumeration/IDOR
surface; it would have to be validated against a real landing page anyway. The
`public_path` **is** the already-validated, non-enumerable handle: a caller can
only ever reach locations that have a published landing page, and the routes
only ever return display-safe class data (no capacity — "never surface
capacity" invariant holds).

**Backwards compatibility:** when the `path` param/body field is absent, both
routes **default to `stillorgan`**, so anything currently calling these
endpoints (today's `/start`, `/free-class`) keeps working unchanged.

### Components / units

**1. `src/components/ClassFunnel.jsx`** (renamed + generalised from
`StartFunnel.jsx`). Prop-driven; every Stillorgan-hardcoded value becomes a prop
with a Stillorgan default:

| Prop | Replaces (today's hardcode) | Default |
|---|---|---|
| `publicPath` | `'stillorgan'` in class fetch + `funnel-event` `location_path` | `'stillorgan'` |
| `consultSlug` | `CONSULT_SLUG = 'free-un1t-consultation'` (empty ⇒ hide upsell) | `'free-un1t-consultation'` |
| `locationName` | `"UN1T Stillorgan"` in success copy | `'UN1T Stillorgan'` |
| `heading` | `"Your first 3 classes are free"` | same |
| `subhead` | `"Book your first class now — pop in your details to start."` | same |
| `consentLabel` | consent `<span>` text | same |
| `classDoneTitle` / `classDoneBody` | class success copy | same |
| `consultDoneBody` | consult success copy | same |

Behaviour is otherwise unchanged: attribution capture, funnel-event telemetry,
step machine (details → classpick → classdone → optional consult calendar →
done), phone validation, error states.

**2. `src/app/start/page.js`** — rewired to render `<ClassFunnel />` with
Stillorgan's exact current values. Must behave **identically** to today (this is
the live paid-ads funnel) — verified by manual parity pass.

**3. `src/components/landing-page/BlockRenderers.jsx`** — add
`case 'class_funnel': return <ClassFunnelBlock block={block} locationId={locationId} publicPath={publicPath} onEdit={localOnEdit} />`.
`ClassFunnelBlock` maps block config → `ClassFunnel` props (passing `publicPath`
for the location seam and `block.consult_slug` for the upsell). `BlockRenderer`
already threads `locationId` + `publicPath` down — no plumbing change needed.

**4. `src/lib/landing-page-blocks.js`** —
- `CLASS_FUNNEL_DEFAULT` factory (default heading/subhead/consent/success copy;
  `consult_slug: ''`).
- `BLOCK_TYPES` entry: `{ type: 'class_funnel', label: 'Glofox Class Booking Funnel', description: 'Capture details, pick a live class, book. Optional consult upsell.', factory: CLASS_FUNNEL_DEFAULT }`.
- Add `'class_funnel'` to the block-type Zod `z.enum(...)`.
- Decide CTA-derivation behaviour (the `deriveCta` helper currently keys off
  `lead_form`/`booking`/`event`) — a `class_funnel` block does not need to
  contribute a hero CTA; leave `deriveCta` unchanged.

**5. `src/components/LandingPageSettingsForm.jsx`** —
- `ClassFunnelEdit({ block, onUpdate, availableBookingTypes })`: fields for
  heading, subhead, consent label, success copy, and a **consult booking-type
  dropdown** that reuses the existing `availableBookingTypes` prop and the same
  `<select value={block.consult_slug}>` pattern as `BookingEdit` (empty option
  = no upsell).
- Register in the `blockEditor` switch: `case 'class_funnel': return <ClassFunnelEdit {...props} availableBookingTypes={availableBookingTypes} />`.
- Add label/summary helpers (block title = heading or `'Glofox Class Funnel'`;
  summary = consult slug or `'no consult upsell'`).

**6. Routes made location-aware** (default `stillorgan` when param absent):
- `src/app/api/public/classes/route.js` — read `?path=` (fall back to
  `'stillorgan'`), look up `landing_page_settings.location_id` by that
  `public_path`, then `listPublicClasses`. Keep existing rate-limit.
- `src/app/api/public/class-booking/route.js` — read `path` from the JSON body
  (fall back to `'stillorgan'`), same lookup, before resolving the class by
  `event_id`.
- `src/app/api/public/funnel-event` — already accepts `location_path`; the
  component passes `publicPath` instead of the literal `'stillorgan'`.
- Consult routes (`/api/public/bookings/[slug]`, `/availability`, `/slots`,
  `/api/public/book`) — already slug-based; unchanged, they receive
  `block.consult_slug`.

## Data flow

```
Editable page (/welcome/[location])
  → BlockRenderer(locationId, publicPath)
    → ClassFunnelBlock(block config)
      → ClassFunnel(publicPath, consultSlug, copy…)
          details step  ── POST /api/public/funnel-event {location_path: publicPath}
          classpick     ── GET  /api/public/classes?path=publicPath      → location's classes
          book class    ── POST /api/public/class-booking {path, event_id…}
          consult upsell── GET  /api/public/bookings/{consultSlug}/…      (slug-based)
                           POST /api/public/book {event_type_id…}
```

## Error handling

Unchanged from today. Empty class list / empty consult availability render the
existing inline copy. Network failures set the existing `error` state. Telemetry
(`funnel-event`, pixel) is best-effort and never blocks the funnel.

## Security / invariants checklist

- Public endpoints resolve location **only** via `public_path` on a real
  `landing_page_settings` row → no arbitrary-location enumeration (IDOR).
- Class data is display-safe; **no capacity/counts** exposed.
- Consent stays pre-ticked + required (operator's accepted GDPR posture,
  unchanged); confirmation sends remain transactional/utility.
- Every non-submit `<button>` inside the funnel form keeps `type="button"`.
- New route imports + new block/page imports ⇒ run `npm run build` (Turbopack
  catches what mocked vitest cannot).

## Testing

- **Unit** (`vitest`): location resolution in `classes` + `class-booking` —
  valid `path` → that location; absent `path` → `stillorgan` default; unknown
  `path` → empty/`{ success:true, classes:[] }` (no throw).
- **Component**: `ClassFunnel` default props render the same DOM/labels as the
  old `StartFunnel` (parity guard) — where feasible without a DB.
- **Manual**: `/start` end-to-end parity (details → class → booked, + consult
  upsell) before/after. Add the block to a Stillorgan editable page in the
  editor, confirm it books. Add it to a non-Glofox page, confirm graceful empty
  state.
- **CI mirror** (all six) + `npm run build`.

## Rollout

Additive. No migration. New block type is opt-in per page; `/start` rewire is
behaviour-preserving. No feature flag needed.

## Open questions

None. (Palette naming = "Glofox Class Booking Funnel"; availability =
unrestricted; consult = operator-picked booking type; `/start` = rewired — all
confirmed in brainstorming.)
