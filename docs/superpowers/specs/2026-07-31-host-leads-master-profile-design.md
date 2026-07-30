# Host leads on the master profile — design

**Date:** 2026-07-31 · **Approved by:** Richard (chat, incl. two AskUserQuestion decisions + one amendment) · **Follows:** 2026-07-30-host-portal-nav-signup-design.md

## Problem

Host mailing-list signups and host-event attendees currently live at the host's hidden anchor location — invisible to UN1T and unreachable by any UN1T send. Richard's new direction (2026-07-31): **Stillorgan is the master profile.** Host leads should:

1. Live on the Stillorgan master contact (reachable from UN1T broadcasts/campaigns),
2. **Not be auto-enrolled in automations/sequences** — but a staff member manually triggering/enrolling one MUST include them (Richard's amendment),
3. Be tagged to their host and to every event they attend,
4. Have attended events mapped onto their CRM contact profile.

Decisions taken in chat: **migrate existing anchor-location leads now**; on email match with an existing Stillorgan contact, **tag only — do not touch consent, pipeline, or exemption** (a real member keeps behaving like a member).

## 1. Placement — master location

- Migration adds `organizations.master_location_id uuid NULL REFERENCES locations(id)`; data-set it to Stillorgan (`a0000000-0000-0000-0000-000000000001`) for UN1T Group. No hardcoded uuid in code.
- New helper `resolveMasterLocationId(db, host)` (in `src/lib/host-events.js` or sibling): host → organization → `master_location_id`; **fallback = the host's anchor location** (behaviour-preserving for orgs without a master set — fail-open to the old model, never to a wrong location).
- Write paths changed to place/match contacts at the master location:
  - `POST /api/public/host-list/[slug]/subscribe` — `findOrCreateRaceContact({ locationId: master, restrictToLocation: true })`. The restrict flag now scopes matching to the master location: an existing member/lead with that email links; otherwise create-new at master. (Same consent-resurrection posture as the event register route, which already matches globally.)
  - Host-event registration contact creation (the `findOrCreateRaceContact` call in the public race register path) — for events whose `host_id` is a third-party host, contacts land at the master location too. UN1T-internal events (host_id null) are UNCHANGED.
- The anchor location remains for `race_events.location_id` and host scoping — it just stops receiving contacts.

## 2. No AUTO-enrolment — `automations_exempt`

- Migration adds `contacts.automations_exempt boolean NOT NULL DEFAULT false` + partial index where true. COMMENT explains semantics: blocks AUTOMATIC sequence/automation enrolment only; manual enrolment ignores it.
- Set `automations_exempt: true` ONLY when a host signup/attendee **creates a new** contact (both write paths above + the migration script for moved contacts). Matched existing contacts are never flipped (chat decision).
- **The gate** lives in `enrolContacts` (`src/lib/sequences/enrol.js`) — the single choke point for every enrolment (webhook triggers, cron triggers, segment sync, dunning, manual):
  - If `sourceType === 'manual'` → no filtering (Richard's amendment: manual triggers include them).
  - Any other sourceType (`trigger:*`, dunning, segment, cron) → load the candidates' `automations_exempt` and drop exempt contacts before insert; count them in `skipped`.
  - Audit every `enrolContacts` caller to confirm sourceType values; any operator-initiated path that doesn't pass `'manual'` gets it (only if genuinely operator-initiated).
- Contact profile: an "No auto-enrol" badge next to the contact name when exempt, with a Manager+ toggle (PATCH via the existing contact update route — add the field to its schema, staff-gated) so it's visible and reversible.
- **New regression test** (replaces the "host leads can never reach UN1T" framing): `enrolContacts` with a non-manual sourceType never inserts an exempt contact; with `'manual'` it does. The existing location-pinning audience tests STAY (they still guarantee cross-location isolation generally).

## 3. Tags — host + per-event

- Signup keeps `host:<slug>` (existing, both tag systems via `writeContactTag`).
- New: `eventTagFor(raceEvent)` → `event:<race_events.slug>`. When a registration flips to confirmed for a **host** event, each attendee contact gets the event tag + the host tag — hook into `addEventAttendeesToHostList` (already called fire-and-forget on confirm from all three confirm paths), extended to also write tags. Idempotent (writeContactTag already is; contacts.tags append-if-missing).
- The tag-added automation trigger cannot auto-enrol exempt contacts (gate above); tags remain fully usable in the UN1T audience builder (`tag` audience field already exists).
- Scope: host events only for now (UN1T-internal event attendees are not newly tagged — avoids churning every existing internal event; extend later if wanted).

## 4. Events on the CRM contact profile

- Contact profile (`src/app/contacts/[id]/page.js`) gains an "Events" card: the contact's race-event registrations — event name, date, host name (when third-party), registration status, link to the event admin page. Resolved live: `team_members` rows for the contact → `race_registrations` (+ `race_events` embed). No new schema. Renders nothing when empty. Covers host AND internal race events (it's a read; no reason to hide internal ones).
- Existing `PastEventsCard` (consultation bookings) unchanged.

## 5. One-off migration of existing anchor-location contacts

Admin-triggered script (master/owner-gated route, dry-run mode first), idempotent:

1. For every contact at a `is_host_anchor` location: match by lowercased email against contacts at that org's master location.
2. **Matched** → re-point references (`host_contacts.contact_id`, `team_members.contact_id`, `contact_preferences`, `contact_tags`, any others found by FK audit at build time) to the master contact via the estate's existing merge conventions; copy tags (host/event) onto the master contact; DO NOT touch its consent/pipeline/exemption; delete or park the anchor duplicate per the existing contact-merge pattern (reuse `ContactMergeModal`'s server logic if a lib exists — audit at plan time).
3. **Unmatched** → `UPDATE contacts SET location_id = master, automations_exempt = true`; tags already on the row travel with it.
4. Emit a summary `{ matched, moved, skipped, errors }`; log every merge pair.
5. After migration + deploy, spot-check: host portal Contacts list unchanged (host_contacts survives), signup count unchanged, one merged member shows tags + Events card.

## Non-goals / unchanged

- Host portal surfaces (counts, composer audiences, per-host unsubscribe) — all key on `host_contacts`, unaffected.
- No change to Glofox, Mia, broadcasts, or campaign sending.
- No per-host choice of master location (org-level only).
- UN1T-internal event attendee tagging (later if wanted).

## Consent note (recorded, no build)

The broadened consent line (PR #1166) covers signups from 2026-07-30 onward. Contacts migrated or signed up under the older host-only wording are broadcast-*reachable* once at Stillorgan; whether to actually include pre-broadening signups in UN1T promos is an operator/GDPR judgement — the audience builder's tag + date filters make either choice expressible. Flag this to Richard at first UN1T send to this population.

## Testing

- Unit: `resolveMasterLocationId` fallback; enrolContacts exemption gate (manual vs trigger sourceTypes); `eventTagFor`; attendee-sync tag writes; subscribe/register placement (mocked db asserting locationId used).
- Migration script: dry-run unit tests over fabricated rows (match/move/idempotency).
- Full CI mirror + build; migration applied via Supabase MCP + advisors.
