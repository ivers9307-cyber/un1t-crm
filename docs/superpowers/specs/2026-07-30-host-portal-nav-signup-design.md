# Host portal nav + signup-page surfacing & customisation — design

**Date:** 2026-07-30 · **Approved by:** Richard (chat) · **Ships as:** 2 PRs (A: nav + card, B: customisation + audience)

## Problem

1. The per-host public mailing-list signup page (`/h/[slug]`, HOST-EMAIL.2) exists end-to-end — subscribe API, `host_contacts` (`source='mailing_list'`), consent stamping, emailability in the host composer — but **nothing in the host portal ever shows the host their link**. Hosts cannot discover, share, or promote their own signup page.
2. The portal's only navigation to Contacts / Emails / Create event is three `text-xs` pills beside the "Your events" heading, **on the dashboard only**. They are visually tiny and unreachable from every other portal page.
3. The signup page copy is hard-coded; hosts cannot customise it. Richard's requirements: host leads stay **separate from UN1T marketing**, the page is **customisable by the host**, and form signups are **countable in the composer's audience dropdown** (the "everyone" option).

## Separation guarantee (verified, no new build)

Host form signups are already structurally isolated from UN1T marketing:

- The subscribe route creates contacts at the host's **anchor location** (`locations.is_host_anchor=true`, one synthetic location per host — `ensureAnchorLocation`).
- Every UN1T campaign/broadcast audience is hard-scoped `.eq('location_id', <real location>)` (`buildAudienceQuery` / `buildAudienceQueryAsync`).
- `is_host_anchor` locations are excluded from `/api/locations` and every staff location picker (20+ call sites).
- Consent stamped at signup is the basis for the **host's** list only; per-host unsubscribe (`host_email_suppressions`) never touches UN1T consent, and vice versa the host page never enrols anyone in a UN1T campaign.

**New work here:** one regression test asserting a contact at a host anchor location can never match a UN1T `buildAudienceQuery` for a real location. Nothing else.

## PR A — header nav + signup card (no schema change)

### A1. Persistent header nav

`src/app/host/(portal)/layout.js` header gains a client `HostNav` component (`src/components/host/HostNav.jsx`, uses `usePathname` for active state):

- Left: brand (`UN1T · Hosts`) then nav links **Dashboard** (`/host`), **Contacts** (`/host/contacts`), **Emails** (`/host/emails`) — `text-sm`, `text-white/60`, active = white text on `bg-white/10` rounded pill.
- Right: **"+ Create event"** as a prominent white button (`bg-white text-black text-sm font-semibold px-4 py-2 rounded-lg`), then host name + sign out (impersonation safeguard unchanged).
- Mobile (`sm:` down): nav links wrap to a second row inside the header; Create event stays visible (icon `+` with label if space allows). No hamburger — three links don't warrant one.
- Active-state matching: exact for `/host`, prefix for the others (so `/host/events/new` highlights nothing / Dashboard stays exact — Create event is a button, not a nav item).

Dashboard cleanup: remove the three small pills from the "Your events" row (`src/app/host/(portal)/page.js`); keep the empty-state line, adding a "Create your first event" link when the list is empty.

### A2. "Your signup page" card

New dashboard section between the Stripe/needs-attention banner and Revenue, heading `Grow your list`:

- Card shows the full public URL (`${getAppUrl()}/h/${slug}` — host slug, un1t-hosts brand domain aware), a **Copy link** button, an **Open** link (new tab), a **QR code** button (client-side render via the existing `qrcode` dependency → downloadable PNG, for print/socials), and the **mailing-list signup count** (`host_contacts` where `source='mailing_list'` for this host).
- The **Customise** button is NOT part of PR A — PR B adds it to this card. PR A ships the card with link/copy/QR/count only, so it is complete and shippable on its own.
- **Slug provisioning:** the dashboard (server component) ensures `event_hosts.slug` exists on load using the same lazy pattern as `ensureAnchorLocation` (derive from name, uniquify, persist). The card never renders a dead link. Failure to provision → card renders a quiet "unavailable right now" line, never a 500.

## PR B — host customisation + audience option (next free migration number — 460 at time of writing; re-check `supabase/migrations/` at apply time)

### B1. Schema

Forward-only migration on `event_hosts` (apply via Supabase MCP, then `get_advisors`):

```sql
alter table event_hosts
  add column if not exists list_headline text,
  add column if not exists list_blurb text,
  add column if not exists list_button_label text,
  add column if not exists list_success_message text;
```

All nullable; null → current default copy (operator-editable-copy invariant: settings field + default fallback — the host is the operator here).

### B2. Editor

- "Customise" on the dashboard card opens an inline edit panel/modal: four fields with length caps (headline ≤120, blurb ≤500, button ≤40, success ≤500), live character counts, Save/Cancel, and a "Preview" link opening `/h/[slug]`.
- New route `PATCH /api/host/list-page` — host session (`getCurrentHost`), Zod body (trimmed strings, caps above, empty string → null), updates only the four columns for `session.host.id`. Standard `{ success, data }` shape; register in `openapi.js`.
- **No em-dashes / gush in default copy** (customer-facing copy rule); host-entered copy is theirs.

### B3. Public page rendering

`/h/[slug]` selects the four new columns; `HostListSignup` receives them as props and falls back per-field to today's wording. Success state uses `list_success_message` fallback likewise. No sanitisation concerns — plain text rendered as React text nodes (no HTML).

### B4. Composer audience option

- `GET /api/host/emails/audiences` adds `mailing_list_count` (count of `host_contacts` where `host_id` + `source='mailing_list'`).
- Composer dropdown (`HostEmails.jsx`) gains **"Mailing list signups (N)"** between "All contacts (N)" and the per-event options. ("All contacts" already includes form signups — requirement satisfied; this option adds visibility + targeting.)
- Send-time resolver (`send/route.js` audience resolution) gains a `mailing_list` branch: recipients = `host_contacts` rows with `source='mailing_list'`, then the existing per-contact consent/suppression gates apply unchanged. Zero-recipient send still 409s.

## Error handling

- Copy-link/QR are client-side; failures surface inline on the card, never block the dashboard.
- Slug provisioning and signup-count queries wrap in try/catch → degraded card, dashboard always renders.
- `PATCH /api/host/list-page` returns Zod `issues` on cap violations; UI shows field errors.

## Testing

- Unit: HostNav active-state logic; slug-ensure helper (derive/uniquify/persist, race-safe re-select); audiences route `mailing_list_count`; send-resolver `mailing_list` branch (consent gates still apply); Zod caps on the PATCH route; `HostListSignup` fallback rendering per field.
- Regression: host-anchor contact never matches a UN1T `buildAudienceQuery` for a real location.
- Full CI mirror (`npm test && lint && check:mobile-parity && check:mobile-imports && check:route-guards && check:guardrails`) + `npm run build` locally before push (new routes/imports).
- Route guards: `PATCH /api/host/list-page` uses `getCurrentHost` (session-gated — satisfies `check:route-guards`).

## Out of scope

- Hero image / accent colour on the signup page (Richard chose copy-only).
- Embedding the form on public event pages.
- Any change to UN1T marketing/consent infrastructure (verified already-separate).
- Mobile (CRM app) parity — host portal is web-only; no `WEB_PERMISSIONS` change (host auth, not staff perms).
