# EVENT-SLUG.1 — event URLs read as place, date and time

**Ask (Richard, 7 Oct 2026):** "For events we need to update the slug and the URL for each upcoming event. It should show location, date & time. Something like `/stillorganNov22_1100`." Fix the upcoming events now and change the template going forward. **Amended same day:** a host campaign sent on 7 Sep to 164 people carried `/event/pride-training-club-4`, and the two 18 Oct events hold 24 and 27 sign-ups, so renamed events keep their old slugs as redirecting aliases (Richard's pick over leaving those two alone).

## What already existed
- `race_events.slug` is derived ONCE from the event name at creation: staff path `toSlug(body.name)` in `POST /api/events`, host path `deriveSlug(input.name)` in `POST /api/host/events`. Neither `PUT` accepts a slug and neither form shows one. It is globally unique (mig 451) and exact-match, case-sensitive, in every public resolver (`/event/[slug]`, `/api/public/events/[slug]/*`, `/book/[slug]`, `/embed/event/[slug]`).
- The time lives on `race_waves.start_time` (first wave), never on `race_events.start_time` (null everywhere). The place lives on `venue_name` for host events and on the studio (`locations.name`) for staff events.
- Result today: 9 of the 10 upcoming events are Pride Training Club host events with slugs like `pride-training-club-5`.

## Design (approved 7 Oct)

### Slug rule — one pure helper, `eventSlug({ place, date, time })` in `src/lib/event-slug.js`
- **place**: the venue name with "UN1T" and any bracketed text removed, first word, lowercase ASCII. Leading "the" is skipped. `"UN1T Hatch Street (Harcourt Luas stop)"` → `hatch`, `"UN1T STILLORGAN"` → `stillorgan`, `"SAINT Studios"` → `saint`. Empty → `event`.
- **date**: lowercase 3-letter month + day of month, no zero pad: `nov22`, `dec5`. From `race_date` (`YYYY-MM-DD`, parsed as a plain date, no timezone).
- **time**: earliest wave `start_time` as `HHMM`: `1100`. Accepts `HH:MM` or `HH:MM:SS`.
- Joined with hyphens: `hatch-oct18-1100`. Fits the existing `^[a-z0-9]+(-[a-z0-9]+)*$` rule, so no validation or lookup change.
- A clash with another event gets `-2`, `-3`… (existing host-portal loop, now shared by both create paths).
- **No date or no wave** (lead-gen forms): fall back to the name-based slug exactly as today.

### Where it applies
1. **`POST /api/events`** (staff): when `body.slug` is absent, derive from the studio's `locations.name` + `body.race_date` + the earliest `body.waves[].start_time`. An explicit `body.slug` still wins. Clash → 409 as today (the explicit-slug case) or `-n` suffix (the derived case).
2. **`POST /api/host/events`**: derive from `input.venue_name` + `input.race_date` + `input.session_start_time`.
3. **`PUT /api/host/events/[id]`**: while `current.status !== 'published'`, re-derive the slug from the new venue/date/time and update it (clash-suffixed, ignoring the event's own row). Once published the slug is frozen. Staff events are published on creation, so the staff `PUT` is untouched.

### Old slugs keep working — `race_event_slug_aliases` (mig 706)
- One row per retired slug → `race_event_id`. Service-role only (no client grant, RLS on, no policy).
- `/event/[slug]` page: if the slug is not live, look it up as an alias and `redirect()` to `/event/<live slug>`. Live always wins; a failed lookup renders as before. Only the `/event/` path redirects (the emailed links are all that shape); `/book/`, `/embed/event/` and the public API do not.
- `uniqueEventSlug` also treats an aliased slug as taken, so a new event can never shadow a redirect.
- The data fix inserts an alias for every old slug it retires, in the same transaction as the rename.

### Data fix (direct SQL after the code deploys; slugs are not editable in the app)

| Event | Today | New |
|---|---|---|
| Hyrox Sim October, Stillorgan 17 Oct 10:30 | hyrox-sim-october | stillorgan-oct17-1030 |
| PTC, Hatch 18 Oct 11:00 | pride-training-club-5 | hatch-oct18-1100 |
| PTC, Hatch 18 Oct 12:30 | pride-training-club-4 | hatch-oct18-1230 |
| PTC 11.00AM, Hatch 25 Oct | pride-training-club-10-30am | hatch-oct25-1100 |
| PTC Beginner, Hatch 25 Oct 12:30 | pride-training-club-beginner-workout | hatch-oct25-1230 |
| PTC x SAINT, 20 Nov 18:35 | ptc-at-x-saint-studio | saint-nov20-1835 |
| PTC, Stillorgan 22 Nov 12:30 | pride-training-club-6 | stillorgan-nov22-1230 |
| PTC, Stillorgan 22 Nov 13:45 | pride-training-club-7 | stillorgan-nov22-1345 |
| PTC Christmas, Hatch 5 Dec 10:30 | pride-training-club-christmas-edition-10-30 | hatch-dec5-1030 |
| PTC, Stillorgan 20 Dec 12:30 | pride-training-club-12-30pm | stillorgan-dec20-1230 |

- The 25 Oct "11.00AM" event's only wave is stored as **23:00**; set it to 11:00 (what the name says) in the same pass.
- The Hatch Street lead-gen form (`un1t-hatch-street`, no date) keeps its slug.
- Checked 7 Oct: the old slugs appear in one unsent CRM campaign (a test draft), one unsent host campaign draft (`pride-training-club-5`) and one SENT host campaign (`pride-training-club-4`, 164 recipients). The two drafts get their links rewritten in the same pass; the sent one is covered by the alias redirect.
- After renaming, GET each new `/event/<slug>` and confirm 200.

### Testing
`src/lib/event-slug.test.js`: each venue shape above, "the" skipping, single-digit day, `HH:MM:SS` input, no-date and no-time fallbacks, the clash-suffix helper, and the publish freeze decision (`shouldRederiveSlug(status)`).

## Out of scope
An editable slug field in either form, changing the `/event/` path, case-insensitive lookups, alias redirects on `/book/`, `/embed/event/` or the public API.
