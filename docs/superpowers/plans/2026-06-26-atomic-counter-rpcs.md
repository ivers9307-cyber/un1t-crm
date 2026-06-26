# Atomic Counter RPCs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every non-atomic read-modify-write counter (`read → +1 in JS → write`) with an atomic `increment_*`/`record_*`/`upsert_*`/`bump_*` Postgres RPC, so concurrent webhooks stop losing increments.

**Architecture:** One migration (`314_atomic_counter_rpcs.sql`) adds 8 functions extending the existing `increment_*` family; each read-modify-write JS site is swapped to `db.rpc(...)`. Webhook/inbound counter writes use best-effort `try/catch` (a counter must never break a webhook); operator paths check the result.

**Tech Stack:** Next.js 16 App Router, supabase-js, Postgres (Supabase), Vitest.

**Spec:** `docs/superpowers/specs/2026-06-26-atomic-counter-rpcs-design.md`

**Conventions:** branch `p1-4-atomic-counter-rpcs` (already created off fresh `origin/main`). End every commit message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Run a single test file with `npx vitest run <path>`.

**Migration ordering (important):** Task 1 applies the migration to the live DB via Supabase MCP **before** the code swaps ship, so prod never calls a missing function (the functions are additive and harmless if unused). Task 1 is **controller-executed** (the human's agent applies migrations via Supabase MCP) — do not delegate the `apply_migration` call to a sub-implementer.

**Thenable invariant:** every `db.rpc(...)` is `await`ed (inside `try/catch` on best-effort paths) — never `.catch`-chained. Stays clean against `check:guardrails`.

---

### Task 1: Migration 314 — the 8 atomic counter RPCs

**Files:**
- Create: `supabase/migrations/314_atomic_counter_rpcs.sql`

- [ ] **Step 1: Write the migration file**

Create `supabase/migrations/314_atomic_counter_rpcs.sql`:

```sql
-- 314 — Atomic counter RPCs (P1-4, estate-audit theme #5).
--
-- Replaces non-atomic read-modify-write counter updates (read col → +1 in JS
-- → write back), which lose increments under concurrent writers. Extends the
-- existing increment_* family (see 065_sms_delivery_tracking.sql). Each
-- function is a minimal atomic UPDATE; dedup/idempotency stays in the callers
-- (e.g. the WhatsApp status webhook already guards on status transitions).
-- SECURITY INVOKER (default): all callers use the service-role client.

-- 1. WhatsApp broadcast metrics. CASE-whitelisted; unknown metric raises.
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

-- 2. WhatsApp template send counter.
create or replace function increment_whatsapp_template_sent(p_template_id uuid, p_delta int default 1)
returns void language sql as $$
  update whatsapp_templates set total_sent = coalesce(total_sent,0) + p_delta where id = p_template_id;
$$;

-- 3 + 4. Conversation unread counters.
create or replace function increment_whatsapp_conversation_unread(p_conversation_id uuid)
returns void language sql as $$
  update whatsapp_conversations set unread_count = coalesce(unread_count,0) + 1 where id = p_conversation_id;
$$;
create or replace function increment_instagram_conversation_unread(p_conversation_id uuid)
returns void language sql as $$
  update instagram_conversations set unread_count = coalesce(unread_count,0) + 1 where id = p_conversation_id;
$$;

-- 5. BCA engagement events: count + first_*_at (COALESCE) + last_*_at, one fn for all 4.
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

-- 6. Supplier default: atomic upsert; on conflict bump use_count in SQL.
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

-- 8. Presentation version bump (sync token). p_current_index serves `advance`.
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

- [ ] **Step 2: Apply the migration to the un1t-crm project (controller, via Supabase MCP)**

Use Supabase MCP `apply_migration` with `name: "314_atomic_counter_rpcs"` and the SQL above, against the **un1t-crm** project (`iyvtbjjxdggiadzwwvdj` — NOT the sentinel project). Confirm success.

- [ ] **Step 3: Confirm all 8 functions exist**

Run via Supabase MCP `execute_sql`:
```sql
select proname, pronargs from pg_proc
where proname in ('increment_whatsapp_broadcast_metric','increment_whatsapp_template_sent',
  'increment_whatsapp_conversation_unread','increment_instagram_conversation_unread',
  'record_bca_event','upsert_supplier_default','increment_car_xero_issue_count','bump_presentation_version')
order by proname;
```
Expected: 8 rows.

- [ ] **Step 4: Behavioral spot-check (transactional, rolled back)**

Run via `execute_sql` — proves the atomic pattern on a real row without persisting:
```sql
begin;
  with c as (select id from cars limit 1)
  select 'before' as phase, xero_invoice_issue_count from cars where id = (select id from c)
  union all
  select 'rpc', (select increment_car_xero_issue_count((select id from c)))::text::int
  union all
  select 'after', xero_invoice_issue_count from cars where id = (select id from c);
rollback;
```
Expected: `after` = `before` + 1. (The pattern is uniform across the 8 functions; this plus the code review covers them.)

- [ ] **Step 5: Run `get_advisors`**

Run Supabase MCP `get_advisors` (type `security`, then `performance`). Expected: no NEW advisories attributable to these functions (they are plain SECURITY INVOKER functions, no RLS/table changes).

- [ ] **Step 6: Commit**
```bash
git add supabase/migrations/314_atomic_counter_rpcs.sql
git commit -m "feat(db): add atomic counter RPCs (migration 314)"
```

---

### Task 2: BCA events → `record_bca_event`

**Files:**
- Modify: `src/lib/bca-events.js` (`recordBcaPageView`, `recordBcaDownload`, `recordBcaPostmarkEvent`)
- Create: `src/lib/bca-events.test.js`

- [ ] **Step 1: Write the failing test**

Create `src/lib/bca-events.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { recordBcaPageView, recordBcaDownload, recordBcaPostmarkEvent } from './bca-events.js'

// Mock db: records rpc() calls; from() supports insert / select-eq-single / update-eq.
function mockDb() {
  const rpcCalls = []
  const db = {
    rpc(name, args) { rpcCalls.push({ name, args }); return Promise.resolve({ data: null, error: null }) },
    from() {
      const chain = {
        insert() { return Promise.resolve({ error: null }) },
        select() { return chain },
        eq() { return chain },
        single() { return Promise.resolve({ data: {} }) },
        update() { return { eq() { return Promise.resolve({ error: null }) } } },
      }
      return chain
    },
  }
  return { db, rpcCalls }
}

describe('bca-events → record_bca_event', () => {
  it('page view records a view event', async () => {
    const { db, rpcCalls } = mockDb()
    await recordBcaPageView(db, 'sub1', {})
    expect(rpcCalls).toContainEqual({ name: 'record_bca_event', args: { p_submission_id: 'sub1', p_event: 'view' } })
  })

  it('merged download records a download_merged event', async () => {
    const { db, rpcCalls } = mockDb()
    await recordBcaDownload(db, 'sub1', { type: 'merged' })
    expect(rpcCalls).toContainEqual({ name: 'record_bca_event', args: { p_submission_id: 'sub1', p_event: 'download_merged' } })
  })

  it('non-merged download does NOT roll up to the submission', async () => {
    const { db, rpcCalls } = mockDb()
    await recordBcaDownload(db, 'sub1', { type: 'file', slug: 'x' })
    expect(rpcCalls).toHaveLength(0)
  })

  it('postmark Open records an open event at ReceivedAt', async () => {
    const { db, rpcCalls } = mockDb()
    await recordBcaPostmarkEvent(db, 'sub1', { RecordType: 'Open', ReceivedAt: '2026-06-26T10:00:00Z' })
    expect(rpcCalls).toContainEqual({ name: 'record_bca_event', args: { p_submission_id: 'sub1', p_event: 'open', p_at: '2026-06-26T10:00:00Z' } })
  })

  it('postmark Click records a click event', async () => {
    const { db, rpcCalls } = mockDb()
    await recordBcaPostmarkEvent(db, 'sub1', { RecordType: 'Click', ReceivedAt: '2026-06-26T10:00:00Z' })
    expect(rpcCalls).toContainEqual({ name: 'record_bca_event', args: { p_submission_id: 'sub1', p_event: 'click', p_at: '2026-06-26T10:00:00Z' } })
  })

  it('postmark Delivery does NOT call record_bca_event', async () => {
    const { db, rpcCalls } = mockDb()
    await recordBcaPostmarkEvent(db, 'sub1', { RecordType: 'Delivery', DeliveredAt: '2026-06-26T10:00:00Z' })
    expect(rpcCalls).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run the test → FAILS**

Run: `npx vitest run src/lib/bca-events.test.js`
Expected: FAIL (sites still do read-modify-write; no `record_bca_event` calls).

- [ ] **Step 3: Swap `recordBcaPageView`**

In `src/lib/bca-events.js`, the page-view function currently does `select('first_viewed_at, view_count')` then `update({ first_viewed_at, last_viewed_at, view_count })`. Replace that select+update with the RPC, keeping the events-table insert:

```js
  await db.from('car_bca_submissions') // <-- DELETE this whole select+update block ...
```
Replace the `const { data: row } = await db.from('car_bca_submissions').select('first_viewed_at, view_count').eq('id', submissionId).single()` and the following `await db.from('car_bca_submissions').update({ first_viewed_at: ..., last_viewed_at: now, view_count: ... }).eq('id', submissionId)` with:
```js
  await db.rpc('record_bca_event', { p_submission_id: submissionId, p_event: 'view' })
```
(Remove the now-unused `now` variable only if nothing else in the function uses it.)

- [ ] **Step 4: Swap `recordBcaDownload` (merged branch)**

Replace the merged branch's `select('first_merged_download_at, merged_download_count')` + `update({...})` with:
```js
    await db.rpc('record_bca_event', { p_submission_id: submissionId, p_event: 'download_merged' })
```
Leave the non-merged (per-file) branch unchanged (it deliberately does not roll up).

- [ ] **Step 5: Swap `recordBcaPostmarkEvent` (Open + Click branches)**

In the `Open` branch: delete the `select('first_opened_at, open_count')` read and the two patch lines `patch.first_opened_at = ...` and `patch.open_count = ...` and `patch.last_opened_at = ...`. In the `Click` branch: delete the `select('first_clicked_at, click_count')` read and `patch.first_clicked_at`/`patch.click_count`/`patch.last_clicked_at`. After the `switch` block applies `patch` (the existing `await db.from('car_bca_submissions').update(patch).eq('id', submissionId)`), add — only for Open/Click:
```js
  if (recordType === 'Open' || recordType === 'Click') {
    const p_event = recordType === 'Open' ? 'open' : 'click'
    await db.rpc('record_bca_event', { p_submission_id: submissionId, p_event, p_at: body.ReceivedAt || now })
  }
```
Keep `patch.last_postmark_event_at` and the Delivery/Bounce/SpamComplaint branches exactly as they are.

- [ ] **Step 6: Run the test → PASSES**

Run: `npx vitest run src/lib/bca-events.test.js`
Expected: PASS (6 passing).

- [ ] **Step 7: Commit**
```bash
git add src/lib/bca-events.js src/lib/bca-events.test.js
git commit -m "feat(bca): atomic engagement counters via record_bca_event"
```

---

### Task 3: Supplier default → `upsert_supplier_default`

**Files:**
- Modify: `src/lib/invoices-queue/supplier-defaults.js` (the `select(existing)` + `.upsert(...)`)
- Modify: `src/lib/invoices-queue/supplier-defaults.test.js`

- [ ] **Step 1: Update the test to expect the RPC (write it first)**

Read `src/lib/invoices-queue/supplier-defaults.test.js`. Find the case asserting the `.upsert(...)` payload and replace its assertion so it expects an `db.rpc('upsert_supplier_default', {...})` call. The mock `db` must expose `rpc(name, args)` capturing calls. The new assertion:
```js
  expect(rpcCalls).toContainEqual({
    name: 'upsert_supplier_default',
    args: {
      p_location_id: 'loc1',
      p_xero_contact_id: 'xc1',
      p_supplier_name: 'Acme',
      p_account_code: '200',
      p_xero_account_id: 'acc1',
      p_category: 'parts',
    },
  })
```
Adjust the input values to match whatever the test already passes into the function under test; keep the `p_*` key names exactly.

- [ ] **Step 2: Run the test → FAILS**

Run: `npx vitest run src/lib/invoices-queue/supplier-defaults.test.js`
Expected: FAIL (still calls `.upsert`, not `.rpc`).

- [ ] **Step 3: Swap the implementation**

In `src/lib/invoices-queue/supplier-defaults.js`, replace the `const { data: existing } = await db.from('xero_supplier_defaults').select('use_count')...maybeSingle()` read AND the `await db.from('xero_supplier_defaults').upsert({...}, { onConflict: 'location_id,xero_contact_id' })` with:
```js
  await db.rpc('upsert_supplier_default', {
    p_location_id: locationId,
    p_xero_contact_id: xeroContactId,
    p_supplier_name: supplierName || null,
    p_account_code: accountCode || null,
    p_xero_account_id: xeroAccountId,
    p_category: category || null,
  })
```
(The `existing` fetch is removed — it only fed the non-atomic `use_count` increment.)

- [ ] **Step 4: Run the test → PASSES**

Run: `npx vitest run src/lib/invoices-queue/supplier-defaults.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/lib/invoices-queue/supplier-defaults.js src/lib/invoices-queue/supplier-defaults.test.js
git commit -m "feat(invoices): atomic supplier-default upsert (use_count)"
```

---

### Task 4: WhatsApp webhook counters (broadcast metric + WA unread)

**Files:**
- Modify: `src/app/api/webhooks/whatsapp/route.js` (broadcast metric ~449-457; conversation unread ~307-316)

No unit test (deep webhook handler) — verified by the full suite staying green + the migration spot-check. Mechanical swap.

- [ ] **Step 1: Swap the broadcast metric read-modify-write**

Replace:
```js
      const { data: broadcast } = await db.from('whatsapp_broadcasts')
        .select(metricField)
        .eq('id', msg.broadcast_id)
        .single()

      if (broadcast) {
        await db.from('whatsapp_broadcasts')
          .update({ [metricField]: (broadcast[metricField] || 0) + 1 })
          .eq('id', msg.broadcast_id)
      }
```
with:
```js
      // Atomic; best-effort — a counter must never break the status webhook.
      try {
        await db.rpc('increment_whatsapp_broadcast_metric', { p_broadcast_id: msg.broadcast_id, p_metric: metricField })
      } catch {}
```
(Keep the surrounding `if (['delivered','read','failed'].includes(statusValue)) { const metricField = ... }`.)

- [ ] **Step 2: Swap the conversation unread read-modify-write**

In the inbound-message `db.from('whatsapp_conversations').update({...}).eq('id', conversationId)` call, delete the line:
```js
    unread_count: (currentConv?.unread_count || 0) + 1,
```
and immediately AFTER that `.eq('id', conversationId)` statement, add:
```js
  // Atomic unread bump (best-effort) — replaces the read-modify-write above.
  try { await db.rpc('increment_whatsapp_conversation_unread', { p_conversation_id: conversationId }) } catch {}
```

- [ ] **Step 3: Remove the orphaned pre-fetch if unused**

Run: `grep -n "currentConv" src/app/api/webhooks/whatsapp/route.js`
If `currentConv` now has no remaining uses, delete its `const { data: currentConv } = await db.from('whatsapp_conversations').select(...)...` fetch. If it is still used elsewhere, leave it.

- [ ] **Step 4: Verify**

Run: `npx vitest run src/app/api/webhooks/whatsapp` (or the nearest existing webhook test) and `npm run lint`.
Expected: pass; no unused-variable lint error.

- [ ] **Step 5: Commit**
```bash
git add src/app/api/webhooks/whatsapp/route.js
git commit -m "feat(whatsapp): atomic broadcast metrics + conversation unread"
```

---

### Task 5: IG unread + WhatsApp template total_sent

**Files:**
- Modify: `src/lib/agent/instagram.js` (~187-195)
- Modify: `src/lib/agent/instagram.test.js` (assert the rpc call if the harness allows; else keep green)
- Modify: `src/lib/whatsapp.js` (~622-624)

- [ ] **Step 1: Swap IG unread**

In `src/lib/agent/instagram.js`, replace:
```js
  const { data: convNow } = await db.from('instagram_conversations')
    .select('unread_count').eq('id', conversationId).single()
  await db.from('instagram_conversations').update({
    last_message_at: ts,
    last_message_direction: 'inbound',
    resolved_at: null,
    last_message_preview: body.substring(0, 100),
    unread_count: (convNow?.unread_count || 0) + 1,
  }).eq('id', conversationId)
```
with:
```js
  await db.from('instagram_conversations').update({
    last_message_at: ts,
    last_message_direction: 'inbound',
    resolved_at: null,
    last_message_preview: body.substring(0, 100),
  }).eq('id', conversationId)
  // Atomic unread bump (best-effort) — replaces the read-modify-write above.
  try { await db.rpc('increment_instagram_conversation_unread', { p_conversation_id: conversationId }) } catch {}
```

- [ ] **Step 2: Swap WhatsApp template total_sent**

In `src/lib/whatsapp.js`, replace:
```js
  // Update template send count
  await db.from('whatsapp_templates').update({
    total_sent: template.total_sent + sentCount,
  }).eq('id', template.id)
```
with:
```js
  // Update template send count (atomic; best-effort).
  try { await db.rpc('increment_whatsapp_template_sent', { p_template_id: template.id, p_delta: sentCount }) } catch {}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/lib/agent/instagram.test.js src/lib/whatsapp-template-components.test.js`
Expected: PASS. If `instagram.test.js` asserted the old `.update({ unread_count })` payload, update that assertion to expect the slimmer update + an `db.rpc('increment_instagram_conversation_unread', { p_conversation_id: <id> })` call (mock `db.rpc`).

- [ ] **Step 4: Commit**
```bash
git add src/lib/agent/instagram.js src/lib/agent/instagram.test.js src/lib/whatsapp.js
git commit -m "feat(messaging): atomic IG unread + WA template total_sent"
```

---

### Task 6: Car Xero-invoice issue counter

**Files:**
- Modify: `src/app/api/cars/[id]/issue-xero-invoice/route.js` (~68)
- Modify: `src/app/api/cars/[id]/void-xero-invoice/route.js` (~104)

Mechanical swap; verified by suite + build.

- [ ] **Step 1: Swap `issue-xero-invoice`**

Delete the line inside the `cars` update:
```js
      xero_invoice_issue_count: (car.xero_invoice_issue_count || 0) + 1,
```
Then, AFTER the `if (upErr) { ... }` error-return block that follows that update (i.e. once the update has succeeded), add:
```js
    // Atomic issue-count bump (best-effort) — secondary to the invoice op.
    try { await db.rpc('increment_car_xero_issue_count', { p_car_id: car.id }) } catch {}
```

- [ ] **Step 2: Swap `void-xero-invoice`**

Identical change in `void-xero-invoice/route.js`: delete the `xero_invoice_issue_count: (car.xero_invoice_issue_count || 0) + 1,` line from its `cars` update, and after that update's `if (upErr) {...}` block add:
```js
    try { await db.rpc('increment_car_xero_issue_count', { p_car_id: car.id }) } catch {}
```

- [ ] **Step 3: Verify**

Run: `npm run lint` and `npx vitest run` (full). Expected: green; no unused-variable warnings (the `car` row is still used for other fields).

- [ ] **Step 4: Commit**
```bash
git add "src/app/api/cars/[id]/issue-xero-invoice/route.js" "src/app/api/cars/[id]/void-xero-invoice/route.js"
git commit -m "feat(cars): atomic xero_invoice_issue_count"
```

---

### Task 7: Presentation version bump → `bump_presentation_version`

**Files:**
- Modify: `src/app/api/presentations/[id]/advance/route.js` (~31-35)
- Modify: `src/app/api/presentations/[id]/slides/route.js` (~61)
- Modify: `src/app/api/presentations/[id]/slides/reorder/route.js` (~33)
- Modify: `src/app/api/presentations/[id]/slides/[slideId]/route.js` (~27)

- [ ] **Step 1: Swap `advance` (uses the returned state)**

Replace:
```js
  const { data, error } = await db.from('presentations')
    .update({ current_index: next, version: deck.version + 1, updated_at: new Date().toISOString() })
    .eq('id', id).select('current_index, version').single()
```
with:
```js
  const { data, error } = await db
    .rpc('bump_presentation_version', { p_presentation_id: id, p_current_index: next })
    .single()
```
(The following `if (error) ...` and `return ... current_index: data.current_index, version: data.version` lines stay unchanged.)

- [ ] **Step 2: Swap the three slide-edit routes (return not needed)**

In each of `slides/route.js`, `slides/reorder/route.js`, and `slides/[slideId]/route.js`, replace the line:
```js
  await db.from('presentations').update({ version: deck.version + 1, updated_at: new Date().toISOString() }).eq('id', id)
```
with:
```js
  await db.rpc('bump_presentation_version', { p_presentation_id: id })
```

- [ ] **Step 3: Verify**

Run: `npm run lint` and `npx vitest run` (full). Expected: green. (`deck.version` is no longer read for the bump; `deck` is still used for the `location_id` access check, so no orphan.)

- [ ] **Step 4: Commit**
```bash
git add "src/app/api/presentations/[id]/advance/route.js" "src/app/api/presentations/[id]/slides/route.js" "src/app/api/presentations/[id]/slides/reorder/route.js" "src/app/api/presentations/[id]/slides/[slideId]/route.js"
git commit -m "feat(present): atomic presentation version bump"
```

---

### Task 8: Full verification + push + PR

- [ ] **Step 1: Confirm no read-modify-write counters remain among the swapped sites**

Run:
```bash
grep -rnE "unread_count: \(|view_count: \(|open_count: \(|click_count: \(|merged_download_count: \(|use_count: \(|xero_invoice_issue_count: \(|total_sent: template|\[metricField\]: \(" src --include='*.js' | grep -v '\.test\.'
```
Expected: no matches (all converted).

- [ ] **Step 2: Full CI mirror + build**

Run:
```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails && npm run build
```
Expected: all pass.

- [ ] **Step 3: Push + open the PR**
```bash
git push -u origin p1-4-atomic-counter-rpcs
```
Open the un1t-crm PR. Body lists the 8 RPCs + the converted sites; reference the spec; note migration 314 is already applied to the live DB.

---

## Self-Review

**Spec coverage:**
- 8 RPCs (migration 314) → Task 1. ✓
- WA broadcast metric → Task 4; WA template sent → Task 5; WA unread → Task 4; IG unread → Task 5; BCA events → Task 2; supplier upsert → Task 3; car xero-issue → Task 6; presentation version → Task 7. ✓ (All 8 spec RPCs have a consuming task.)
- Error idiom (best-effort try/catch on webhook paths; checked on operator paths) → applied per task (Tasks 4/5 BCA/IG/WA try-catch; Task 3 supplier awaited; Task 7 presentation checks `error`). ✓
- Migration-before-code ordering → stated in header + Task 1. ✓
- Testing (SQL spot-check + JS rpc-call assertions + suite green) → Task 1 Step 4, Tasks 2/3 tests, Task 8. ✓

**Placeholder scan:** every step has concrete code/commands. The "remove orphaned pre-fetch if unused" steps (Task 4 Step 3) are explicit grep-guarded instructions, not placeholders. ✓

**Type/name consistency:** RPC names and `p_*` params identical between the migration (Task 1) and every call site (`increment_whatsapp_broadcast_metric`/`p_broadcast_id`/`p_metric`; `record_bca_event`/`p_submission_id`/`p_event`/`p_at`; `upsert_supplier_default`/`p_location_id`…; `bump_presentation_version`/`p_presentation_id`/`p_current_index`). ✓
