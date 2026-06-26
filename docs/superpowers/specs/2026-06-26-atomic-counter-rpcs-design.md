# P1-4 — Atomic counter RPCs (kill non-atomic read-modify-write)

**Date:** 2026-06-26 · **Status:** approved design, pre-implementation
**Source:** 2026-06-25 estate audit, cross-cutting theme #5 + roadmap row P1-4
**Scope decision:** **B — everything** (close the theme; no read-modify-write counter left).

## Problem

Several counters use `read value → +1 in JS → write back`, which loses increments
under concurrent writers. The real-harm case is the **WhatsApp broadcast delivery
counters**: per Meta status callback, `webhooks/whatsapp/route.js` reads
`whatsapp_broadcasts.total_delivered/read/failed`, adds 1, writes back — and a
broadcast's many recipients generate concurrent callbacks, so deliveries undercount.
The SMS pipeline already solved this with atomic `increment_sms_broadcast_*` RPCs;
this extends that established pattern to every remaining read-modify-write counter.

## Approach

Extend the existing `increment_*` RPC family (e.g. `increment_sms_broadcast_delivered`
in `migrations/065`, `increment_sequence_completed`, `increment_step_sent`). One new
migration **`supabase/migrations/314_atomic_counter_rpcs.sql`** defines the functions;
each read-modify-write JS site is swapped to `db.rpc(...)`. Style mirrors the family:
`language sql`/`plpgsql`, `returns void` (except the presentation one), `p_*` params,
plain atomic `UPDATE … SET col = col + delta`, SECURITY INVOKER (called with the
service-role client; RLS not in play). Dedup stays in the callers (the WA webhook
already guards on status transitions — the function is a minimal atomic bump, exactly
as `migrations/065` documents for SMS).

**Ordering:** apply the migration to the live DB (via Supabase MCP) **before** the code
ships, so prod never calls a missing function (the functions are additive and harmless
if unused).

## The 8 RPCs

```sql
-- 1. WhatsApp broadcast metrics (CASE-whitelisted; unknown metric → raise).
create or replace function increment_whatsapp_broadcast_metric(p_broadcast_id uuid, p_metric text, p_delta int default 1)
returns void language plpgsql as $$
begin
  if p_metric not in ('total_sent','total_delivered','total_read','total_failed') then
    raise exception 'increment_whatsapp_broadcast_metric: unknown metric %', p_metric;
  end if;
  update whatsapp_broadcasts set
    total_sent      = total_sent      + (case when p_metric='total_sent'      then p_delta else 0 end),
    total_delivered = total_delivered + (case when p_metric='total_delivered' then p_delta else 0 end),
    total_read      = total_read      + (case when p_metric='total_read'      then p_delta else 0 end),
    total_failed    = total_failed    + (case when p_metric='total_failed'    then p_delta else 0 end)
  where id = p_broadcast_id;
end $$;

-- 2. WhatsApp template send counter (only total_sent has a RMW site today).
create or replace function increment_whatsapp_template_sent(p_template_id uuid, p_delta int default 1)
returns void language sql as $$
  update whatsapp_templates set total_sent = coalesce(total_sent,0) + p_delta where id = p_template_id;
$$;

-- 3 + 4. Conversation unread counters (two tables → two trivial functions).
create or replace function increment_whatsapp_conversation_unread(p_conversation_id uuid)
returns void language sql as $$
  update whatsapp_conversations set unread_count = coalesce(unread_count,0) + 1 where id = p_conversation_id;
$$;
create or replace function increment_instagram_conversation_unread(p_conversation_id uuid)
returns void language sql as $$
  update instagram_conversations set unread_count = coalesce(unread_count,0) + 1 where id = p_conversation_id;
$$;

-- 5. BCA engagement events — count + first_*_at (COALESCE) + last_*_at, one fn for all 4 events.
--    p_at lets the Postmark handler pass body.ReceivedAt instead of now().
create or replace function record_bca_event(p_submission_id uuid, p_event text, p_at timestamptz default now())
returns void language plpgsql as $$
begin
  if p_event not in ('view','open','click','download_merged') then
    raise exception 'record_bca_event: unknown event %', p_event;
  end if;
  update car_bca_submissions set
    view_count               = view_count + (case when p_event='view' then 1 else 0 end),
    first_viewed_at          = coalesce(first_viewed_at, case when p_event='view' then p_at end),
    last_viewed_at           = case when p_event='view' then p_at else last_viewed_at end,
    open_count               = open_count + (case when p_event='open' then 1 else 0 end),
    first_opened_at          = coalesce(first_opened_at, case when p_event='open' then p_at end),
    last_opened_at           = case when p_event='open' then p_at else last_opened_at end,
    click_count              = click_count + (case when p_event='click' then 1 else 0 end),
    first_clicked_at         = coalesce(first_clicked_at, case when p_event='click' then p_at end),
    last_clicked_at          = case when p_event='click' then p_at else last_clicked_at end,
    merged_download_count    = merged_download_count + (case when p_event='download_merged' then 1 else 0 end),
    first_merged_download_at = coalesce(first_merged_download_at, case when p_event='download_merged' then p_at end),
    last_merged_download_at  = case when p_event='download_merged' then p_at else last_merged_download_at end
  where id = p_submission_id;
end $$;

-- 6. Supplier default — atomic upsert; on conflict bump use_count in SQL.
--    Column types confirmed: location_id uuid, xero_contact_id/account fields text, use_count int NOT NULL.
create or replace function upsert_supplier_default(
  p_location_id uuid, p_xero_contact_id text, p_supplier_name text,
  p_account_code text, p_xero_account_id text, p_category text
) returns void language sql as $$
  insert into xero_supplier_defaults
    (location_id, xero_contact_id, supplier_name, default_account_code, default_xero_account_id, default_category, use_count, last_used_at)
  values
    (p_location_id, p_xero_contact_id, p_supplier_name, p_account_code, p_xero_account_id, p_category, 1, now())
  on conflict (location_id, xero_contact_id) do update set
    use_count               = xero_supplier_defaults.use_count + 1,
    last_used_at            = now(),
    supplier_name           = coalesce(excluded.supplier_name, xero_supplier_defaults.supplier_name),
    default_account_code    = coalesce(excluded.default_account_code, xero_supplier_defaults.default_account_code),
    default_xero_account_id = excluded.default_xero_account_id,
    default_category        = coalesce(excluded.default_category, xero_supplier_defaults.default_category);
$$;

-- 7. Car Xero-invoice issue counter.
create or replace function increment_car_xero_issue_count(p_car_id uuid)
returns void language sql as $$
  update cars set xero_invoice_issue_count = coalesce(xero_invoice_issue_count,0) + 1 where id = p_car_id;
$$;

-- 8. Presentation version bump (sync token). Optional p_current_index serves `advance`;
--    omit it for slide edits. Returns the new state for the route's response.
create or replace function bump_presentation_version(p_presentation_id uuid, p_current_index int default null)
returns table(current_index int, version int) language sql as $$
  update presentations set
    version       = version + 1,
    current_index = coalesce(p_current_index, current_index),
    updated_at    = now()
  where id = p_presentation_id
  returning current_index, version;
$$;
```

## JS site swaps

| RPC | Site(s) | Swap |
|---|---|---|
| 1 | `webhooks/whatsapp/route.js:449-457` | delete the select-then-update; `try { await db.rpc('increment_whatsapp_broadcast_metric', { p_broadcast_id: msg.broadcast_id, p_metric: metricField }) } catch {}` |
| 2 | `whatsapp.js:623` | replace the `whatsapp_templates` update with `try { await db.rpc('increment_whatsapp_template_sent', { p_template_id: template.id, p_delta: sentCount }) } catch {}` |
| 3 | `webhooks/whatsapp/route.js:311` | **drop `unread_count` from the big `.update({...})`** (keep last_message_at/preview/etc.); after it, `try { await db.rpc('increment_whatsapp_conversation_unread', { p_conversation_id: <conv id> }) } catch {}` |
| 4 | `agent/instagram.js:189-194` | same split: drop `unread_count` from the update; add `increment_instagram_conversation_unread` |
| 5 | `bca-events.js` `recordBcaPageView` (view), `recordBcaDownload` (merged), `recordBcaPostmarkEvent` (open/click) | replace each select-then-patch counter/timestamp block with `await db.rpc('record_bca_event', { p_submission_id, p_event, p_at })` (`p_at` = `body.ReceivedAt` for open/click, else default). Keep any non-counter patch fields (e.g. status) in the existing update. |
| 6 | `invoices-queue/supplier-defaults.js:85-95` | replace the `.upsert({...})` with `await db.rpc('upsert_supplier_default', { p_location_id, p_xero_contact_id, p_supplier_name, p_account_code, p_xero_account_id, p_category })` |
| 7 | `issue-xero-invoice/route.js:68`, `void-xero-invoice/route.js:104` | drop `xero_invoice_issue_count` from the `cars` update; after it succeeds, `try { await db.rpc('increment_car_xero_issue_count', { p_car_id: car.id }) } catch {}` |
| 8 | `presentations/[id]/advance`, `…/slides`, `…/slides/reorder`, `…/slides/[slideId]` | replace `.update({ version: deck.version+1, … })` with `const { data } = await db.rpc('bump_presentation_version', { p_presentation_id: id, p_current_index: <next \| null> }).single()`; use `data.version`/`data.current_index` in the response. Stop reading `version` for the bump (keep the `location_id` select for the access check). |

### Error-handling idiom
- **Webhook / inbound paths** (RPCs 1, 3, 4, 5): best-effort `try { await db.rpc(...) } catch {}` — a counter write must never break the webhook (matches the existing `increment_step_sent`/`increment_contact_opens` idiom).
- **Operator paths** (RPCs 6, 7, 8): keep the original error handling. Supplier upsert and the xero count are awaited; presentation `bump_presentation_version` is awaited and its return drives the response, so check `error` like the route does today. (RPC 7's count bump is secondary to an already-succeeded invoice op → wrap in `try/catch` so a count failure doesn't fail the operation.)

## Migration, testing, delivery

- **Migration:** `supabase/migrations/314_atomic_counter_rpcs.sql` (the 8 functions above + a header comment). Applied to the un1t-crm project via Supabase MCP `apply_migration` (name `314_atomic_counter_rpcs`) **and** committed to the repo. Run `get_advisors` after — expect no new advisories (functions only; no RLS/table changes).
- **RPC verification (post-apply):** for each function, an `execute_sql` script wrapped in `begin … rollback` against a scratch/known row — assert the target column moved (and for `record_bca_event`, that `first_*_at` is set once and `last_*_at` advances; for `bump_presentation_version`, that the returned version = old+1). `rollback` so nothing persists.
- **JS tests:** existing route/lib tests must stay green. Where a swapped site has a unit test (e.g. `bca-events`, the whatsapp blast, presentation routes), update/add a case asserting it now calls `db.rpc('<fn>', {…})` with the right args (mock `db.rpc`) instead of the read-modify-write. The thenable invariant holds — RPC calls are `await`ed inside `try/catch`, never `.catch`-chained.
- **CI:** full 6-check mirror (`npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails`) + `npm run build`.
- **Delivery:** one un1t-crm PR on `p1-4-atomic-counter-rpcs` (off fresh `origin/main`).

## Out of scope
- Counters that are NOT read-modify-write: `whatsapp_broadcasts.total_sent`/`total_failed` written once by the send loop (single writer) stay as-is; the `unread_count = 0` resets (absolute writes) stay as-is.
- `whatsapp_templates.total_delivered`/`total_read` have no increment site today — nothing to convert.
- BST/date, branding, and pagination concerns are other roadmap items.

## Success criteria
- Every read-modify-write counter site now calls an atomic `increment_*`/`record_*`/`upsert_*`/`bump_*` RPC; `grep` finds no `(x?.<col> || 0) + 1` counter writes among the listed sites.
- Concurrent WA status callbacks for one broadcast no longer lose `total_delivered`/`read`/`failed` increments (the headline fix).
- Migration `314` applied + committed; `get_advisors` clean; full CI + build green; all existing tests pass.
