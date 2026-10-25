# HOST-EVENTS-PAGE.1 — a host's public page lists their upcoming events

**Ask (Richard, 7 Oct 2026):** "do we have an events page that shows all of Colm's upcoming events for PTC, that can be accessed by the public so they can buy?" No. `/welcome/<studio>/events` excludes host events (and they sit on a hidden anchor location); `/h/pride-training-club` is only a mailing-list form; the host portal is behind login. Decisions: PTC branding, sold-out events shown and marked.

## Design (approved 7 Oct)
- **`/h/[slug]` becomes the host's public page:** hero (image + accent), "Upcoming events" headline + blurb, a grid of the host's published, active, upcoming events whose registration window is open (same filters as the studio listing), each card = kind, date, time, venue, price, `Sold out` / `Opens <date>` badge, linking to the existing `/event/<slug>` page to buy. The mailing-list signup stays underneath. Already allowlisted as a public path (proxy, AppShell, hosts brand).
- **Branding is host-level, operator-editable (mig 707 on `event_hosts`):** `hero_image_url`, `accent_hex` (`#rrggbb` CHECK), `events_headline`, `events_blurb`. NULL = default. **Hero fallback:** when the host has no hero, the page uses the hero of the nearest upcoming event that has one — PTC is branded on day one with no data entry (all nine of Colm's events share one hero).
- Edited where the signup-page copy already is: the host portal's "Your signup page" card (renamed "Your public page") → `HostListPageEditor` + `PATCH /api/host/list-page` (strict schema; hero as a pasted URL, like the event form's URL field; accent as `#rrggbb`). OpenAPI updated.
- **Never render capacity or counts** (invariant): the embed of waves/registrations exists only to compute the sold-out boolean, as on the studio listing.
- Cards reuse `toBrowseCard` (`src/lib/public-events.js`), extended with `timeLabel` (earliest wave `HH:MM`) and `venue` (`venue_name`); additive, the studio listing ignores them.

## Out of scope
A host hero upload route (paste a URL for now; the event hero fallback covers PTC), filtering by venue, past events, a per-host custom domain.
