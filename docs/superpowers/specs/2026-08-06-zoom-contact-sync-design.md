# Zoom Phone contact sync — design

**Date:** 2026-08-06
**Status:** Spec, awaiting approval
**Ticket:** ZOOMSYNC.1

## Problem

Zoom manages the phone lines. When a member rings the studio, the handset shows a raw number. Zoom resolves external caller names through a third-party CNAM service, which is effectively useless for Irish mobiles — so in practice every inbound member call is anonymous. Staff answer without knowing whether it is a live member, a lead mid-signup, or somebody chasing an arrears letter.

The CRM already holds the answer: **8,558 contacts, 8,339 of them with a phone number**. None of it reaches Zoom.

Zoom Phone has the right receptacle — **External Contacts**, an account-wide shared directory. When an inbound call matches a number in that directory, the Zoom Workplace app shows the contact's name instead of the carrier caller ID. Nothing populates it today.

## Goals

- Every distinct member/lead phone number in the CRM is present in Zoom's external contacts directory, named.
- The directory stays correct as the CRM changes — new numbers appear, renamed contacts get corrected, numbers that leave the CRM leave Zoom.
- Reproducible from an empty Zoom directory with no manual steps.

## Non-goals

- **No outbound dialling, click-to-call, or screen-pop into the CRM.** This is caller identification only.
- **No Zoom Contact Center.** Zoom Phone external contacts only.
- **No new customer-facing surface.** Nothing in the CRM UI changes.
- **No sync of staff, suppliers, or contractors.** Those are hand-managed in Zoom and must stay that way.

## The API constraints that shape everything

Three findings from the Zoom Phone API drove the design, and each closed off an option:

1. **There is no batch endpoint.** Zoom staff have confirmed on the developer forum that external contacts are created one request at a time. The CSV import in the admin portal has no API equivalent.
2. **There is no search.** You cannot look up an external contact by phone number, nor by your own supplied id. The only way to find anything is to page the full list. This is what makes list-and-diff the *only* viable reconcile strategy, not merely the tidiest.
3. **Updates and deletes require Zoom's generated `external_contact_id`**, not the customer-supplied `id`.

Point 2 has a happy consequence for point 3: because we must list everything on every run anyway, the authoritative id mapping arrives in that same response. **No local mapping table is needed, and therefore no migration.** State lives in Zoom and is re-derived each run, so there is nothing to drift.

## Ownership marking

The sync deletes. That makes it critical it can never touch an external contact a human added by hand — a coach's mobile, the plumber, the linen supplier.

Every entry the sync creates carries:

- `id` = `crm:<e164>` — the ownership marker. Stable for the life of the number, and unique by construction, which matters because Zoom rejects duplicate ids.
- `description` = `UN1T CRM sync · <contact_uuid>` — provenance for debugging. Deliberately *not* the marker, because the winning contact can change and `description` is freely updatable.

The reconcile filters the Zoom list down to entries whose `id` starts with `crm:`. Everything else is invisible to it — not skipped, not compared, simply not in the data set.

## Desired state

From `contacts`:

```
WHERE phone IS NOT NULL AND trim(phone) <> ''
  AND coalesce(lower(lead_source), '') <> 'classpass'
```

then normalise to E.164, drop what fails, group by number, and pick a winner.

**Winner rule:** lowest `created_at`, with `contacts.id` as a deterministic tiebreak so two rows created in the same transaction cannot flip the name between runs. `created_at` is populated on every row in the table, so the rule never falls through.

**Name:** `first_name` and `last_name` joined and trimmed. No row in the table currently lacks both; if one ever does, the entry is skipped and logged rather than pushed as an empty name.

### ClassPass exclusion

`lead_source = 'classpass'`, 1,613 rows. Excluding them costs nothing real: **all 1,613 share the single placeholder number `+10000000000`**. They would have collapsed to one junk entry anyway. The exclusion is explicit regardless, so the intent survives any future change to how ClassPass rows are imported.

### Expected output today

| | |
|---|---|
| Contacts with a phone number | 8,339 |
| Less ClassPass | −1,613 |
| Rows considered | 6,726 |
| Rows normalising to valid E.164 | 6,691 |
| Rows rejected as unsalvageable | 35 |
| Collapsed onto a shared number by oldest-wins | 361 |
| **Zoom entries created** | **6,330** |

Split: Ireland 6,394, UK 186, other international 111 across roughly 44 country prefixes.

## Normalisation

The sync gets its own normaliser rather than calling `toMobileE164()` from `src/lib/phone-validate.js`, for two reasons:

- That helper deliberately **rejects anything that is not a mobile**, because it gates public forms on WhatsApp reachability. A landline that rings the studio still deserves a name.
- It mishandles a real defect in the stored data. **106 non-ClassPass rows are double-prefixed** — country code `353` followed by the national trunk `0`, e.g. `+3530871234567`. Those digits fail the helper's `^3538\d{8}$` Irish-mobile test, fall through to its permissive generic-international branch, and are returned *verbatim as valid*. Feeding that to Zoom would publish 106 wrong numbers under real members' names.

Rules, in order. Row counts are across all 8,339 phone-bearing contacts, before the ClassPass exclusion, since the normaliser is shape-driven and does not know about lead source:

| Input shape | Rule | Rows |
|---|---|---|
| `+…` / `00…` | Strip prefix, keep country code | 5,612 |
| `353` + `0` + national | Drop the trunk zero → `+353…` | 106 (non-ClassPass) |
| `353…` | Prefix `+` | 1,786 |
| `0…` national | `+353` + strip trunk zero | 113 |
| Bare national digits | `+353` + digits | remainder |
| Fails `^\+[1-9]\d{7,14}$`, or all-same-digit | Reject, log, skip | 35 (non-ClassPass) |

The double-prefix bug is also fixed in the shared `toMobileE164()` helper as part of this work, since it is live on the public forms today. The sync does not depend on that fix.

## Reconcile

```
desired  = Map<e164, {name, contactId}>     from Supabase
existing = Map<e164, {name, zoomId}>        from Zoom, filtered to id LIKE 'crm:%'

creates = desired keys not in existing
updates = keys in both where name differs
deletes = existing keys not in desired
```

`diffContacts(desired, existing)` is a pure function over two Maps. It is the heart of the feature and is unit-tested directly, with no network or database involved.

### Deletion guard

A bug in the desired-state query — a renamed column, a migration that drops `lead_source`, a Supabase blip returning zero rows — produces an empty desired set and would otherwise wipe all 6,330 entries.

If `deletes.length > max(20, 5% of owned existing entries)`:

- **All deletes are skipped.** Creates and updates still apply; they are not the dangerous direction.
- The run returns `success: false` with `guardTripped: true`, so cron monitoring surfaces it.
- The count and a sample of intended deletions are logged for inspection.

Clearing a genuinely large batch is then a deliberate act, not something that happens overnight unattended.

## Execution

Zoom has no bulk endpoint, so the cold start is 6,330 individual writes. That does not fit a serverless request, so writes are queued rather than applied inline.

**Cron** — `/api/cron/zoom-contact-sync`, nightly at 04:30, `CRON_SECRET`-guarded, `maxDuration = 300`. It builds desired state, pages the Zoom list (~64 GETs at 100/page), diffs, applies the guard, and enqueues one QStash job per write. It performs no writes itself.

The route accepts two optional query parameters, both for operator use rather than the scheduled run:

- `?limit=N` — enqueue at most N writes this run, creates first. This is what makes the pilot in step 3 of the rollout possible; the nightly cron passes no limit.
- `?dry=1` — compute and return the diff without enqueuing anything. Safe to run at any time and the first thing to reach for when the guard trips.

**Worker** — `/api/webhooks/qstash/zoom-contacts`, QStash-signature verified, applies exactly one create, update, or delete.

Queue `zoom-contacts` at parallelism 2, following the established `publishQueuePush` / `ensureQueue` pattern in `src/lib/qstash.js`. Two concurrent writes sit far below Zoom's rate ceiling (30/sec on Pro, 80/sec on Business+), so the limiter is deliberate pacing rather than a constraint. The cold start drains in roughly an hour, unattended. Steady state is a handful of jobs a night.

### Idempotency

Two runs can overlap if a drain is slow. Three things make that safe:

- QStash `deduplicationId` of `zoom-contact:<op>:<e164>` collapses a re-enqueued identical job.
- A Zoom **409 "already exists" is treated as success**, not an error.
- The diff is recomputed from live Zoom state each run, so a partially-drained queue simply produces a smaller diff next time.

There is no run lock, and none is needed.

## Modules

| Module | Responsibility | Depends on |
|---|---|---|
| `src/lib/zoom/client.js` | Server-to-Server OAuth token cached to expiry; `zoomFetch()` with 429/`Retry-After` handling | env only |
| `src/lib/zoom/external-contacts.js` | list / create / update / delete | client |
| `src/lib/zoom/desired-contacts.js` | CRM → desired Map. Owns exclusion, normalisation, oldest-wins | db |
| `src/lib/zoom/normalise-phone.js` | Raw string → E.164 or null | nothing |
| `src/lib/zoom/reconcile.js` | Pure diff + guard + enqueue orchestration | the above |
| `src/app/api/cron/zoom-contact-sync/route.js` | `CRON_SECRET` wrapper, heartbeat | reconcile |
| `src/app/api/webhooks/qstash/zoom-contacts/route.js` | Applies one write | external-contacts |

Each is small enough to hold in context whole. `normalise-phone` and `reconcile` are pure and carry the bulk of the risk, which is where the tests concentrate.

## Auth and configuration

A Zoom **Server-to-Server OAuth** app, three secrets in Vercel:

- `ZOOM_ACCOUNT_ID`
- `ZOOM_CLIENT_ID`
- `ZOOM_CLIENT_SECRET`

Exact granular scope strings are pinned during implementation against the live account — Zoom's phone scopes have been reorganised more than once and vary by account tier. The app needs read and write on Zoom Phone external contacts.

**Ships dark.** With any of the three unset the cron returns `{ skipped: 'unconfigured' }` and does nothing, matching the Homey and fleet-health pattern. Go-live is setting the secrets.

## Testing

- `normalise-phone.test.js` — table-driven over every shape in the rules table above, with the `3530…` double-prefix and the `+10000000000` placeholder as named cases.
- `desired-contacts.test.js` — ClassPass excluded; oldest-wins picks the earlier `created_at`; `contacts.id` breaks a `created_at` tie deterministically; a row with no name is skipped, not pushed blank.
- `reconcile.test.js` — creates/updates/deletes computed correctly; entries without the `crm:` marker never appear in any bucket; guard trips at the threshold and suppresses only deletes; guard does not trip at threshold minus one.
- `external-contacts.test.js` — 409 treated as success; 429 honours `Retry-After`; token refreshed when expired.
- Route tests per house pattern — 401 without `CRON_SECRET`, `skipped` when unconfigured, QStash signature rejection on the worker.

## Rollout

1. Merge dark. Nothing happens.
2. Create the Zoom Server-to-Server OAuth app, set the three secrets.
3. **Pilot.** Run once with a `limit` parameter capping the diff at ~200 entries. Confirm on a real handset that an inbound call from a known member shows their name.
4. Remove the cap, let the cold start drain overnight.
5. Verify the directory count in the Zoom admin portal lands near 6,330, and that hand-added entries are still present.

## Risks and what this does not fix

- **Data protection.** This publishes ~6,330 members' names and numbers into Zoom's cloud directory, visible to every Zoom Phone user on the account. Zoom becomes a processor for that data. Needs a line in the privacy notice and the ROPA before go-live. Flagged, not resolved by this spec.
- **Name quality is inherited.** Where the CRM holds a sloppy name, Zoom will show a sloppy name. The sync does not clean names.
- **The 35 rejected rows stay invisible.** They are logged each run but not repaired. Fixing them is data entry, not code.
- **Desk phones may differ.** Name resolution is confirmed behaviour in the Zoom Workplace app. Zoom Phone Appliances and Yealink handsets surface the shared directory differently, and step 3 of the rollout is where that gets checked on the actual hardware.
- **Zoom's directory has no published size cap.** 6,330 is well within reported real-world use (16k+ in one documented case), but it has not been confirmed against a written limit.
