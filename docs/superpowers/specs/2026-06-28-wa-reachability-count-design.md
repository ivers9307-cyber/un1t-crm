# WhatsApp reachability — truthful pre-send count + exclusion reasons

**Date:** 2026-06-28
**Branch:** `feat/wa-reachability-count`
**Status:** Approved design → implementation

## Problem

A WhatsApp broadcast can report **"Sent · 0"** with no explanation, even though the
operator picked a contact and the composer told them the audience had recipients.

Root cause (confirmed against prod, broadcast `790f8b1c-2d66-4ec1-8130-0efa23aafb70`):

1. **The pre-send count and the actual send use different audiences.**
   `/api/communications/audience-count` is deliberately channel-agnostic — it counts
   `contacts` matching the `audience_filter` at the location, ignoring WhatsApp
   consent + reachability (`src/app/api/communications/audience-count/route.js`). The
   composer shows that raw count ("N contacts match this filter").
   `sendBroadcast` then applies the real gate via `whatsAppAudienceBase`
   (`src/lib/whatsapp.js`): `whatsapp_marketing = true` (embedded
   `contact_preferences`) **AND** `wa_phone IS NOT NULL` **AND** `wa_status NOT IN
   ('blocked','opted_out')`. The resolved audience can be far smaller — or empty.

2. **When the audience resolves to empty, the send is silent.** `sendBroadcast`
   stamps `status='sent', total_recipients=0` and returns `{ sent: 0 }` with no
   reason. The composer result screen renders "0 sent of 0"; the Sent list renders
   "Sent · 0". Nothing tells the operator *why* nobody was reached.

The operator hit this by targeting a duplicate contact with `wa_phone = null` and
`whatsapp_marketing = false`. But the *class* of bug is general: any audience whose
members lack a WhatsApp number or marketing opt-in silently shrinks at send time.

Note: `contact_preferences.{whatsapp,email,sms}_marketing` all **default TRUE**, so in
the general population the dominant reachability blocker is a **null `wa_phone`**, not
consent. The breakdown must distinguish these.

## Goal

- **Before send:** the composer shows the WhatsApp-*reachable* count and, when some
  contacts are excluded, *why* (no WhatsApp number / no marketing opt-in / opted out).
- **After send:** the send result, the broadcast record, and the Sent list explain
  exclusions. When zero are reachable, say so explicitly rather than a green "Sent".
- **Count == send by construction:** the pre-send count and the send path apply the
  *same* reachability predicate.

## Non-goals (separate issues, explicitly out of scope)

- Merging the duplicate "Richard Ivers" contacts (contact-identity-linking work).
- Backfilling `wa_phone` for contacts that have a valid `phone` but null `wa_phone`.
- Changing SMS / email count behaviour (this change adds a WhatsApp branch only).
- A new operator-facing audience field for `whatsapp_marketing` (it's a reachability
  gate, not a filter operators set).

## Approach (approved)

Denormalize `whatsapp_marketing` onto `contacts` (mirroring the existing
`email_marketing` denormalization), so WhatsApp reachability is a **single-table**
predicate. That makes the pre-send count a cheap `head:true` count with no PostgREST
embedded-resource count trap, and lets the count and the send path share one predicate.

### 1. Migration `325_denormalise_whatsapp_marketing.sql` (forward-only)

Mirrors `155_denormalise_audience_columns.sql` / `064_sms_marketing_preference.sql`.

```sql
-- Denormalized read-copy of contact_preferences.whatsapp_marketing onto contacts,
-- so WhatsApp broadcast reachability is a single-table predicate (no embedded
-- contact_preferences join → no head:true count trap). Source of truth stays
-- contact_preferences.whatsapp_marketing; this column is trigger-maintained.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS whatsapp_marketing boolean NOT NULL DEFAULT true;

UPDATE contacts c
  SET whatsapp_marketing = cp.whatsapp_marketing
  FROM contact_preferences cp
  WHERE cp.contact_id = c.id
    AND c.whatsapp_marketing IS DISTINCT FROM cp.whatsapp_marketing;

CREATE OR REPLACE FUNCTION sync_contacts_whatsapp_marketing()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE contacts
    SET whatsapp_marketing = NEW.whatsapp_marketing
    WHERE id = NEW.contact_id
      AND whatsapp_marketing IS DISTINCT FROM NEW.whatsapp_marketing;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS sync_contacts_whatsapp_marketing_trigger ON contact_preferences;
CREATE TRIGGER sync_contacts_whatsapp_marketing_trigger
  AFTER INSERT OR UPDATE OF whatsapp_marketing ON contact_preferences
  FOR EACH ROW EXECUTE FUNCTION sync_contacts_whatsapp_marketing();

COMMENT ON COLUMN contacts.whatsapp_marketing IS
  'Denormalized read-copy of contact_preferences.whatsapp_marketing (mig 325). '
  'Trigger-maintained; operators never write it. Lets WhatsApp broadcast audiences '
  'gate reachability single-table. Source of truth = contact_preferences.';

-- Persist the per-send reachability summary so the record explains itself.
ALTER TABLE whatsapp_broadcasts
  ADD COLUMN IF NOT EXISTS delivery_summary jsonb;

COMMENT ON COLUMN whatsapp_broadcasts.delivery_summary IS
  'Reachability breakdown stamped at send: { matched, reachable, '
  'excluded: { no_number, no_consent, opted_out } }. matched = raw audience_filter '
  'count; reachable = total_recipients. Reason counts may overlap.';
```

- Apply via Supabase MCP `apply_migration` against the **un1t-crm** project
  (`iyvtbjjxdggiadzwwvdj`), then `get_advisors(type=security)`. The SECURITY DEFINER
  trigger function matches the accepted `sync_contacts_email_marketing` precedent.
- Apply the migration **before** the dependent code deploys.

### 2. Shared reachability predicate — `src/lib/whatsapp.js`

One source of truth used by both the send path and the count endpoint:

```js
// All single-table on contacts (post mig 325). The WhatsApp broadcast reachability
// gate: opted into WA marketing, has a normalized WA number, not blocked/opted-out.
export function applyWhatsAppReachability(query) {
  return query
    .eq('whatsapp_marketing', true)
    .not('wa_phone', 'is', null)
    .neq('wa_status', 'blocked')
    .neq('wa_status', 'opted_out')
}
```

`whatsAppAudienceBase` switches from `.select('*, contact_preferences!inner(*)')` +
`.eq('contact_preferences.whatsapp_marketing', true)` to a plain `contacts` select
gated by `applyWhatsAppReachability`. The send path is now single-table.

**Reachability reason predicates** (also exported, for the count breakdown):
`whatsapp_marketing = false` → `no_consent`; `wa_phone IS NULL` → `no_number`;
`wa_status IN ('blocked','opted_out')` → `opted_out`. Reason counts may overlap (a
contact can have neither number nor consent); they are presented as honest hints
("N have no WhatsApp number"), not a partition.

### 3. Count endpoint — `src/app/api/communications/audience-count/route.js`

- Add optional `channel` to the request schema. Absent / `sms` / `email` → unchanged
  (raw match count). `channel === 'whatsapp'` → return:

  ```json
  { "success": true, "count": <raw match>, "reachable": <int>,
    "excluded": { "no_number": <int>, "no_consent": <int>, "opted_out": <int> } }
  ```

- All counts are single-table `head:true` counts on `contacts` with the resolved
  `audience_filter` applied (via `applyAudienceFilterAsync`) — the filter clause is
  reused across the 1 + 4 count queries (rebuild the builder per query; builders are
  single-use). `reachable` = match + `applyWhatsAppReachability`.
- **The true excluded total is `count - reachable`** (call it `K`). The three
  `excluded.*` reason counts are *independent, overlapping* hints (a contact with no
  number AND no consent is counted in both), so they may sum to more than `K`. Callers
  derive `K = count - reachable`; the reason object only explains the dominant causes.

### 4. Composer — `src/components/communications/UnifiedSendComposer.jsx`

- The count fetch passes `channel`. State holds `{ count, reachable, excluded }` for
  WhatsApp.
- The "Who" count line, for WhatsApp:
  - `**N** match · **M** reachable on WhatsApp`
  - when `K = N - M > 0`, a muted second line:
    `K excluded — a no WhatsApp number, b no marketing opt-in, c opted out`
    (only non-zero reasons listed; the reason figures are overlapping hints and need
    not sum to K).
- SMS / email count line unchanged.

### 5. After-send truth

- `sendBroadcast` and the drip tick (`sendBroadcastTick`) in `src/lib/whatsapp.js`:
  compute the raw-match count once (single `head:true` count on the filter), derive
  `excluded` reason counts, and persist `delivery_summary` on the
  `whatsapp_broadcasts` row alongside the existing metrics. `total_recipients` stays =
  reachable count (unchanged semantics). The send API result includes `delivery_summary`.
- Composer result screen (`UnifiedSendComposer.jsx`): for WhatsApp, render
  `Sent to M of N — K excluded (no opt-in / no number)`. When `M === 0`, the headline
  becomes explicit — **"Nobody was reachable"** with the reasons — instead of the green
  "Sent" check.
- Sent list (`src/app/communications/sent/page.js`): for WhatsApp rows where
  `delivery_summary` shows exclusions, append a hint in the Sent column
  (e.g. `0 · 2 excluded`). Pull `delivery_summary` into the row `SELECT`.
- WhatsApp broadcast detail page (`src/app/whatsapp/broadcasts/[id]`): show the
  breakdown.

## Data flow

```
Composer (channel=whatsapp)
  → POST /api/communications/audience-count { location_id, audience_filter, channel:'whatsapp' }
      → applyAudienceFilterAsync(contacts, filter) → 1 match count
        + applyWhatsAppReachability → reachable count
        + 3 reason counts
      ← { count, reachable, excluded }
  → "N match · M reachable · K excluded (…)"

Send
  → sendBroadcast(id)
      → matched = count(filter)
      → contacts = fetchAllWhatsAppAudience(filter)   // = filter + applyWhatsAppReachability
      → send loop → total_sent / total_failed
      → persist total_recipients=reachable, delivery_summary={matched,reachable,excluded}
  → result screen: "Sent to M of N — K excluded (…)" | "Nobody was reachable (…)"
```

## Testing

Pure-lib unit tests (vitest, mocked db — no DB):

- `applyWhatsAppReachability` adds exactly the four expected clauses.
- `whatsAppAudienceBase` is single-table (no `contact_preferences` embed) and applies
  the reachability clauses — **update `src/lib/whatsapp-audience.test.js`**, whose
  current contract asserts `eq('contact_preferences.whatsapp_marketing', true)`.
- Count endpoint: `channel:'whatsapp'` returns `{ count, reachable, excluded }`;
  absent/other channels return `{ count }` only (shape test via mocked db).
- `sendBroadcast`: persists `delivery_summary` with matched/reachable/excluded; the
  empty-audience branch records the breakdown rather than a bare `{ sent: 0 }`.

Migration validation (post-apply, via MCP):

- Backfill parity: `SELECT count(*) FROM contacts c JOIN contact_preferences cp
  ON cp.contact_id=c.id WHERE c.whatsapp_marketing IS DISTINCT FROM cp.whatsapp_marketing;`
  → expect 0.
- Trigger: toggle a test contact's `contact_preferences.whatsapp_marketing` and confirm
  `contacts.whatsapp_marketing` follows.
- Reachable count for the repro audience equals the send's resolved recipients.

CI mirror before push: `npm test && npm run lint && npm run check:mobile-parity &&
npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails`,
plus `npm run build` (new column reads / route shape change → Turbopack gate).

## Risks

- Switching the send path onto the denormalized column trusts the trigger + backfill
  for parity. Mitigated by the backfill, the `IS DISTINCT FROM` guard, and the
  parity-check query. Email already trusts this exact pattern.
- One extra `head:true` count per send for `matched` — negligible.
- `delivery_summary` is nullable; all readers must treat a null summary as "no
  breakdown available" (older rows) and fall back to existing `total_*` columns.
