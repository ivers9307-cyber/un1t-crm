# WhatsApp Template Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consume Meta's three template webhooks (status / quality / category) to keep `whatsapp_templates` fresh in real time with a manager push + Realtime page, record a per-template audit trail, surface quality in the template pickers, and let an operator edit-&-resubmit a rejected template (with an appeal deep-link).

**Architecture:** Extend the existing WA webhook route (`src/app/api/webhooks/whatsapp/route.js`) with three `change.field` branches → a tested lib `src/lib/whatsapp-template-events.js` (pure policy helpers + an idempotent `applyTemplateEvent` IO function) that matches on `meta_template_id`, updates the row, writes a `whatsapp_template_events` audit row, and decides a manager push. A new `editTemplate` in `whatsapp.js` + a `resubmit` route power the outbound edit. UI: a client templates list (Realtime + quality chips), chips in the pickers, and an editor timeline + edit-&-resubmit affordance.

**Tech Stack:** Next.js 16 App Router, React 19, Supabase (service-role + Realtime), Vitest, Zod, Meta WhatsApp Cloud API (v21.0). Spec: `docs/superpowers/specs/2026-06-10-whatsapp-template-events-design.md`.

**Build order (phases interleave by dependency):** schema → pure helpers → engine → webhook wiring → `editTemplate` → resubmit API → detail GET → client list (Realtime + chips) → picker chips → editor (timeline + resubmit UI) → verify+ship. Phase A = Tasks 1–4 + the Realtime half of 8; B = 7 + timeline of 10; C = chips in 8 + 9; D = 5, 6, resubmit UI of 10.

**Verified facts baked in:** next migration = **254**; RLS helper = **`private.auth_is_in_location(uuid)`**; `META_API_URL`/`resolveConfig`/`headersFor` live in `whatsapp.js`/`whatsapp-config.js`; `sendPushToRolesAtLocation(locationId, roles, {title,body,category,data})` + `MANAGER_ROLES` are already imported in the webhook route; the templates list is the **server** component `src/app/communications/templates/page.js` (redirected from `/whatsapp/templates`); `whatsapp_templates` is **not** yet in `supabase_realtime`.

---

## Task 1: Migration 254 — quality column, audit table, Realtime

**Files:**
- Create: `supabase/migrations/254_whatsapp_template_events.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 254_whatsapp_template_events.sql
-- WA-TMPL — real-time template lifecycle: quality column on whatsapp_templates,
-- a status/quality/category audit trail, and Realtime on the templates table.

-- 1. Quality rating (from message_template_quality_update.new_quality_score).
alter table public.whatsapp_templates
  add column if not exists quality_rating text;

-- 2. Per-template audit trail — one row per real transition.
create table if not exists public.whatsapp_template_events (
  id          uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.whatsapp_templates(id) on delete cascade,
  location_id uuid references public.locations(id),   -- denormalised (codebase convention)
  kind        text not null check (kind in ('status','quality','category')),
  from_value  text,                                   -- null for status (webhook gives no prior)
  to_value    text not null,
  reason      text,                                   -- rejection reason for status events
  created_at  timestamptz not null default now()
);

create index if not exists idx_wa_template_events_template
  on public.whatsapp_template_events (template_id, created_at desc);

alter table public.whatsapp_template_events enable row level security;

-- Location-scoped through the parent template (mirrors whatsapp_broadcast_recipients).
-- NOTE: the helper lives in the `private` schema (mig 022 moved it) — public. would fail.
drop policy if exists whatsapp_template_events_via_template on public.whatsapp_template_events;
create policy whatsapp_template_events_via_template on public.whatsapp_template_events
  for all to authenticated
  using (exists (
    select 1 from public.whatsapp_templates t
     where t.id = whatsapp_template_events.template_id
       and private.auth_is_in_location(t.location_id)
  ))
  with check (exists (
    select 1 from public.whatsapp_templates t
     where t.id = whatsapp_template_events.template_id
       and private.auth_is_in_location(t.location_id)
  ));

-- 3. Realtime so the templates page live-updates (idempotent — mig 042 pattern).
do $$ begin
  alter publication supabase_realtime add table public.whatsapp_templates;
exception when duplicate_object then null; end $$;

do $$ begin
  alter publication supabase_realtime add table public.whatsapp_template_events;
exception when duplicate_object then null; end $$;
```

- [ ] **Step 2: Apply via Supabase MCP** (`apply_migration`, project `iyvtbjjxdggiadzwwvdj`, name `254_whatsapp_template_events`).

- [ ] **Step 3: Verify**

```sql
select
  (select count(*) from information_schema.columns where table_schema='public' and table_name='whatsapp_templates' and column_name='quality_rating') as quality_col,
  (select count(*) from information_schema.tables where table_schema='public' and table_name='whatsapp_template_events') as events_table,
  (select count(*) from pg_policies where tablename='whatsapp_template_events') as events_policies,
  (select count(*) from pg_publication_tables where pubname='supabase_realtime' and tablename in ('whatsapp_templates','whatsapp_template_events')) as realtime_tables;
```
Expected: `quality_col=1, events_table=1, events_policies>=1, realtime_tables=2`.

- [ ] **Step 4: Run the security advisor** (`get_advisors`, type=security). Expected: no NEW errors from this migration (RLS enabled + policy present on the new table). Note any pre-existing lints are unrelated.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/254_whatsapp_template_events.sql
git commit -m "WA-TMPL.1 — migration: quality_rating col + template events audit + realtime"
```
(Append `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`, blank line before.)

---

## Task 2: Pure template-event helpers

**Files:**
- Create: `src/lib/whatsapp-template-events.js`
- Test: `src/lib/whatsapp-template-events.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/whatsapp-template-events.test.js
import { describe, it, expect } from 'vitest'
import { templateColumnUpdate, templateNotification, templateEventRow } from './whatsapp-template-events.js'

const status = (event, reason) => ({ field: 'message_template_status_update', value: { event, reason, message_template_id: 1, message_template_name: 'welcome_offer', message_template_language: 'en' } })
const quality = (next, prev) => ({ field: 'message_template_quality_update', value: { new_quality_score: next, previous_quality_score: prev, message_template_id: 1, message_template_name: 'welcome_offer' } })
const category = (next, prev) => ({ field: 'template_category_update', value: { new_category: next, previous_category: prev, message_template_id: 1, message_template_name: 'welcome_offer' } })

describe('templateColumnUpdate', () => {
  it('maps status event → status + rejection_reason (NONE → null)', () => {
    expect(templateColumnUpdate('message_template_status_update', status('REJECTED', 'INVALID_FORMAT').value)).toEqual({ status: 'REJECTED', rejection_reason: 'INVALID_FORMAT' })
    expect(templateColumnUpdate('message_template_status_update', status('APPROVED', 'NONE').value)).toEqual({ status: 'APPROVED', rejection_reason: null })
  })
  it('maps quality → quality_rating', () => {
    expect(templateColumnUpdate('message_template_quality_update', quality('RED', 'YELLOW').value)).toEqual({ quality_rating: 'RED' })
  })
  it('maps category → category', () => {
    expect(templateColumnUpdate('template_category_update', category('UTILITY', 'MARKETING').value)).toEqual({ category: 'UTILITY' })
  })
  it('returns null for an unknown field', () => {
    expect(templateColumnUpdate('messages', {})).toBeNull()
  })
})

describe('templateNotification', () => {
  it('notifies on APPROVED', () => {
    const n = templateNotification('message_template_status_update', status('APPROVED').value, 'welcome_offer')
    expect(n).toMatchObject({ title: 'Template approved' })
    expect(n.body).toContain('approved')
  })
  it('notifies on REJECTED with the reason', () => {
    const n = templateNotification('message_template_status_update', status('REJECTED', 'INVALID_FORMAT').value, 'welcome_offer')
    expect(n.body).toContain('INVALID_FORMAT')
  })
  it('notifies on PAUSED/DISABLED/LIMIT_EXCEEDED', () => {
    expect(templateNotification('message_template_status_update', status('PAUSED').value, 'x')).not.toBeNull()
    expect(templateNotification('message_template_status_update', status('DISABLED').value, 'x')).not.toBeNull()
    expect(templateNotification('message_template_status_update', status('LIMIT_EXCEEDED').value, 'x')).not.toBeNull()
  })
  it('is silent on PENDING / IN_APPEAL / DELETED', () => {
    expect(templateNotification('message_template_status_update', status('PENDING').value, 'x')).toBeNull()
    expect(templateNotification('message_template_status_update', status('IN_APPEAL').value, 'x')).toBeNull()
    expect(templateNotification('message_template_status_update', status('DELETED').value, 'x')).toBeNull()
  })
  it('notifies on quality YELLOW or RED, silent on GREEN/UNKNOWN', () => {
    expect(templateNotification('message_template_quality_update', quality('RED').value, 'x')).not.toBeNull()
    expect(templateNotification('message_template_quality_update', quality('YELLOW').value, 'x')).not.toBeNull()
    expect(templateNotification('message_template_quality_update', quality('GREEN').value, 'x')).toBeNull()
    expect(templateNotification('message_template_quality_update', quality('UNKNOWN').value, 'x')).toBeNull()
  })
  it('notifies on a real category change, silent on no-op', () => {
    expect(templateNotification('template_category_update', category('UTILITY', 'MARKETING').value, 'x').body).toContain('MARKETING → UTILITY')
    expect(templateNotification('template_category_update', category('MARKETING', 'MARKETING').value, 'x')).toBeNull()
  })
})

describe('templateEventRow', () => {
  it('status → kind status, from null, to event, reason (NONE→null)', () => {
    expect(templateEventRow('message_template_status_update', status('REJECTED', 'SCAM').value)).toEqual({ kind: 'status', from_value: null, to_value: 'REJECTED', reason: 'SCAM' })
    expect(templateEventRow('message_template_status_update', status('APPROVED', 'NONE').value)).toEqual({ kind: 'status', from_value: null, to_value: 'APPROVED', reason: null })
  })
  it('quality → from prev, to new', () => {
    expect(templateEventRow('message_template_quality_update', quality('RED', 'YELLOW').value)).toEqual({ kind: 'quality', from_value: 'YELLOW', to_value: 'RED', reason: null })
  })
  it('category → from prev, to new', () => {
    expect(templateEventRow('template_category_update', category('UTILITY', 'MARKETING').value)).toEqual({ kind: 'category', from_value: 'MARKETING', to_value: 'UTILITY', reason: null })
  })
})
```

- [ ] **Step 2: Run, verify FAIL**

Run: `npx vitest run src/lib/whatsapp-template-events.test.js`
Expected: FAIL — module/functions not defined.

- [ ] **Step 3: Implement the helpers**

```js
// src/lib/whatsapp-template-events.js
// WA-TMPL — pure helpers for the WhatsApp template webhooks. No IO (the
// applyTemplateEvent IO wrapper lives below, but these three are pure + unit-tested).
// Events: message_template_status_update / _quality_update / template_category_update.

const NOTIFY_STATUSES = new Set(['APPROVED', 'REJECTED', 'PAUSED', 'DISABLED', 'LIMIT_EXCEEDED'])
const NOTIFY_QUALITY = new Set(['YELLOW', 'RED'])

function cleanReason(reason) {
  return reason && reason !== 'NONE' ? reason : null
}

// Webhook field+value → the whatsapp_templates column patch (or null for an unknown field).
export function templateColumnUpdate(field, value) {
  switch (field) {
    case 'message_template_status_update':
      return { status: value.event, rejection_reason: cleanReason(value.reason) }
    case 'message_template_quality_update':
      return { quality_rating: value.new_quality_score }
    case 'template_category_update':
      return { category: value.new_category }
    default:
      return null
  }
}

// Notification policy → { title, body } to push, or null to stay silent.
export function templateNotification(field, value, templateName) {
  const name = templateName || value.message_template_name || 'a template'
  const lang = value.message_template_language ? ` (${value.message_template_language})` : ''
  switch (field) {
    case 'message_template_status_update': {
      if (!NOTIFY_STATUSES.has(value.event)) return null
      if (value.event === 'APPROVED') return { title: 'Template approved', body: `✅ '${name}'${lang} approved` }
      if (value.event === 'REJECTED') {
        const r = cleanReason(value.reason)
        return { title: 'Template rejected', body: `❌ '${name}' rejected${r ? ` — ${r}` : ''}` }
      }
      return { title: 'Template paused', body: `⏸ '${name}' ${value.event.toLowerCase().replace('_', ' ')} by Meta` }
    }
    case 'message_template_quality_update': {
      if (!NOTIFY_QUALITY.has(value.new_quality_score)) return null
      return { title: 'Template quality dropped', body: `⚠️ '${name}' quality dropped to ${value.new_quality_score} — Meta may pause it` }
    }
    case 'template_category_update': {
      if (value.new_category === value.previous_category) return null
      return { title: 'Template re-categorised', body: `ℹ️ '${name}' re-categorised ${value.previous_category} → ${value.new_category}` }
    }
    default:
      return null
  }
}

// Webhook field+value → the whatsapp_template_events audit row (kind/from/to/reason), or null.
export function templateEventRow(field, value) {
  switch (field) {
    case 'message_template_status_update':
      return { kind: 'status', from_value: null, to_value: value.event, reason: cleanReason(value.reason) }
    case 'message_template_quality_update':
      return { kind: 'quality', from_value: value.previous_quality_score ?? null, to_value: value.new_quality_score, reason: null }
    case 'template_category_update':
      return { kind: 'category', from_value: value.previous_category ?? null, to_value: value.new_category, reason: null }
    default:
      return null
  }
}
```

- [ ] **Step 4: Run, verify PASS**

Run: `npx vitest run src/lib/whatsapp-template-events.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp-template-events.js src/lib/whatsapp-template-events.test.js
git commit -m "WA-TMPL.2 — pure template-event helpers (column map / notify policy / audit row)"
```

---

## Task 3: `applyTemplateEvent` engine

**Files:**
- Modify: `src/lib/whatsapp-template-events.js` (append the IO function + import)

- [ ] **Step 1: Add the import at the top of `src/lib/whatsapp-template-events.js`**

```js
import { createServerClient } from './supabase'
```

- [ ] **Step 2: Append the engine (after the three pure helpers)**

```js
// IO: apply one template webhook event to the DB. Matches by meta_template_id,
// idempotent (skip-when-unchanged → Meta retries are no-ops, no double-notify),
// updates the row, writes the audit row, and returns the notification decision.
// Best-effort caller (the webhook route) swallows errors.
export async function applyTemplateEvent(db, field, value) {
  const update = templateColumnUpdate(field, value)
  if (!update) return { skipped: 'unknown_field' }

  const metaId = String(value.message_template_id)
  const { data: template } = await db.from('whatsapp_templates')
    .select('id, location_id, name, status, quality_rating, category, rejection_reason')
    .eq('meta_template_id', metaId)
    .single()
  if (!template) return { skipped: 'no_match' }

  // Idempotent: if every target column already equals the new value, no-op.
  const changed = Object.entries(update).some(([k, v]) => template[k] !== v)
  if (!changed) return { skipped: 'unchanged', template }

  await db.from('whatsapp_templates').update(update).eq('id', template.id)

  const ev = templateEventRow(field, value)
  if (ev) {
    await db.from('whatsapp_template_events').insert({
      template_id: template.id,
      location_id: template.location_id,
      ...ev,
    })
  }

  return { template, notify: templateNotification(field, value, template.name) }
}
```

- [ ] **Step 3: Verify the module still parses + tests pass**

Run: `npx vitest run src/lib/whatsapp-template-events.test.js && npx eslint src/lib/whatsapp-template-events.js`
Expected: tests PASS (the pure helpers are unaffected); eslint exit 0. The engine itself is verified via the webhook (Task 11) + manual, mirroring how `whatsapp.js sendBroadcast` is integration-tested.

- [ ] **Step 4: Commit**

```bash
git add src/lib/whatsapp-template-events.js
git commit -m "WA-TMPL.3 — applyTemplateEvent (match by meta_template_id, idempotent, audit + notify)"
```

---

## Task 4: Wire the webhook route

**Files:**
- Modify: `src/app/api/webhooks/whatsapp/route.js`

- [ ] **Step 1: Add the import**

After the existing imports (the file already imports `sendPush, sendPushToRolesAtLocation` from `@/lib/push` and `MANAGER_ROLES` from `@/lib/schemas`), add:

```js
import { applyTemplateEvent } from '@/lib/whatsapp-template-events'
```

- [ ] **Step 2: Replace the change-loop skip with a dispatch**

Find this block in `POST` (the inner change loop):

```js
      for (const change of changes) {
        if (change.field !== 'messages') continue

        const value = change.value
        const phoneNumberId = value.metadata?.phone_number_id
```

Replace the first two lines (the `for` + the `if … continue`) with:

```js
      const TEMPLATE_FIELDS = new Set([
        'message_template_status_update',
        'message_template_quality_update',
        'template_category_update',
      ])

      for (const change of changes) {
        if (TEMPLATE_FIELDS.has(change.field)) {
          await handleTemplateEvent(db, change.field, change.value)
          continue
        }
        if (change.field !== 'messages') continue

        const value = change.value
        const phoneNumberId = value.metadata?.phone_number_id
```

(Everything below `const value = change.value` is unchanged.)

- [ ] **Step 3: Add the `handleTemplateEvent` function**

After `handleStatusUpdate` (at the end of the file), append:

```js
// WA-TMPL — apply a template status/quality/category webhook to the row + audit
// trail, and push managers on meaningful transitions. Best-effort; never throws.
async function handleTemplateEvent(db, field, value) {
  try {
    const { template, notify } = await applyTemplateEvent(db, field, value)
    if (template && notify) {
      await sendPushToRolesAtLocation(template.location_id, MANAGER_ROLES, {
        title: notify.title,
        body: notify.body,
        category: 'whatsapp', // rides the existing notify_whatsapp opt-in
        data: { type: 'template_status', template_id: template.id },
      })
    }
  } catch (err) {
    console.error('[wa-webhook] template event failed:', err?.message)
  }
}
```

- [ ] **Step 4: Lint + build**

Run: `npx eslint src/app/api/webhooks/whatsapp/route.js`
Expected: exit 0. (`sendPushToRolesAtLocation` + `MANAGER_ROLES` are already imported.)

- [ ] **Step 5: Commit**

```bash
git add src/app/api/webhooks/whatsapp/route.js
git commit -m "WA-TMPL.4 — webhook route consumes the 3 template events + manager push"
```

---

## Task 5: `editTemplate` (Meta edit endpoint)

**Files:**
- Modify: `src/lib/whatsapp.js` (add `editTemplate` after `deleteTemplate`, ~line 320)
- Test: `src/lib/whatsapp-edit-template.test.js`

- [ ] **Step 1: Write the failing test** (mirrors the existing whatsapp query-shape test style — assert the Meta request URL + method + body)

```js
// src/lib/whatsapp-edit-template.test.js
import { describe, it, expect, vi, afterEach } from 'vitest'
import { editTemplate } from './whatsapp.js'

afterEach(() => { vi.restoreAllMocks() })

describe('editTemplate', () => {
  it('POSTs category+components to the template id endpoint with the bearer token', async () => {
    const calls = []
    vi.stubGlobal('fetch', async (url, opts) => {
      calls.push({ url, opts })
      return { json: async () => ({ success: true }) }
    })
    const config = { token: 'TKN', businessAccountId: 'WABA' }
    await editTemplate('1234567890', { category: 'UTILITY', components: [{ type: 'BODY', text: 'hi' }] }, { config })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://graph.facebook.com/v21.0/1234567890')
    expect(calls[0].opts.method).toBe('POST')
    expect(calls[0].opts.headers.Authorization).toBe('Bearer TKN')
    const body = JSON.parse(calls[0].opts.body)
    expect(body.category).toBe('UTILITY')
    expect(body.components).toEqual([{ type: 'BODY', text: 'hi' }])
    // name/language are immutable on edit — must NOT be sent.
    expect(body.name).toBeUndefined()
    expect(body.language).toBeUndefined()
  })

  it('throws on a Meta error', async () => {
    vi.stubGlobal('fetch', async () => ({ json: async () => ({ error: { message: 'bad components' } }) }))
    await expect(editTemplate('1', { components: [] }, { config: { token: 'T' } })).rejects.toThrow('bad components')
  })
})
```

- [ ] **Step 2: Run, verify FAIL**

Run: `npx vitest run src/lib/whatsapp-edit-template.test.js`
Expected: FAIL — `editTemplate` not exported.

- [ ] **Step 3: Implement `editTemplate` in `src/lib/whatsapp.js`** (after `deleteTemplate`). Uses the module-private `resolveConfig` + `headersFor` already in the file.

```js
/**
 * Edit an existing template and resubmit it for review (WA-TMPL). Meta's edit
 * endpoint is POST /{template_id} with category + components — name and language
 * are immutable on edit. Allowed for REJECTED/PAUSED templates (the caller gates
 * this). On success Meta puts the template back into review (status → PENDING),
 * which arrives via the message_template_status_update webhook.
 */
export async function editTemplate(metaTemplateId, { category, components }, opts = {}) {
  const config = await resolveConfig(opts)

  const response = await fetch(`${META_API_URL}/${metaTemplateId}`, {
    method: 'POST',
    headers: headersFor(config),
    body: JSON.stringify({
      ...(category ? { category } : {}),
      components: components || [],
    }),
  })

  const result = await response.json()
  if (result.error) {
    console.error('Template edit error:', result.error)
    throw new Error(result.error.message || 'Failed to edit template')
  }

  return { success: result.success !== false }
}
```

- [ ] **Step 4: Run, verify PASS**

Run: `npx vitest run src/lib/whatsapp-edit-template.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp.js src/lib/whatsapp-edit-template.test.js
git commit -m "WA-TMPL.5 — editTemplate (Meta POST /{template_id}, category+components)"
```

---

## Task 6: Resubmit API route

**Files:**
- Create: `src/app/api/whatsapp/templates/[id]/resubmit/route.js`

- [ ] **Step 1: Write the route**

```js
// src/app/api/whatsapp/templates/[id]/resubmit/route.js
// POST — edit a REJECTED/PAUSED template's category+components via Meta and put it
// back into review. Manager-gated. The status flip back to APPROVED/REJECTED
// arrives later via the message_template_status_update webhook.
import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { editTemplate } from '@/lib/whatsapp'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { MANAGER_ROLES } from '@/lib/schemas'

const ResubmitSchema = z.object({
  category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']).optional(),
  components: z.array(z.unknown()),
})

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: tmpl } = await db.from('whatsapp_templates')
    .select('id, location_id, status, meta_template_id')
    .eq('id', params.id)
    .single()
  if (!tmpl) return NextResponse.json({ success: false, error: 'Template not found' }, { status: 404 })

  const guard = assertLocationAccess(user, tmpl.location_id)
  if (guard) return guard
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  if (!['REJECTED', 'PAUSED'].includes(tmpl.status)) {
    return NextResponse.json({ success: false, error: `Only REJECTED or PAUSED templates can be resubmitted (this one is ${tmpl.status}).` }, { status: 400 })
  }
  if (!tmpl.meta_template_id) {
    return NextResponse.json({ success: false, error: 'Template has no Meta ID — recreate it instead.' }, { status: 400 })
  }

  const validation = await validateBody(request, ResubmitSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  try {
    await editTemplate(tmpl.meta_template_id, { category: body.category, components: body.components })

    const { data, error } = await db.from('whatsapp_templates')
      .update({
        status: 'PENDING',
        rejection_reason: null,
        components: body.components,
        ...(body.category ? { category: body.category } : {}),
      })
      .eq('id', params.id)
      .select()
      .single()
    if (error) throw new Error(error.message)

    return NextResponse.json({ success: true, template: data })
  } catch (err) {
    return NextResponse.json({ success: false, error: err.message }, { status: 400 })
  }
}
```

- [ ] **Step 2: Lint**

Run: `npx eslint "src/app/api/whatsapp/templates/[id]/resubmit/route.js"`
Expected: exit 0.

- [ ] **Step 3: Commit** (single-quote the bracketed path)

```bash
git add "src/app/api/whatsapp/templates/[id]/resubmit/route.js"
git commit -m "WA-TMPL.6 — resubmit API (manager-gated, REJECTED/PAUSED only, edits via Meta)"
```

---

## Task 7: Include the audit trail in the template detail GET

**Files:**
- Modify: `src/app/api/whatsapp/templates/[id]/route.js` (the `GET` handler)

- [ ] **Step 1: Extend the GET to return recent events**

Find, in the `GET` handler:

```js
  const { data, error } = await db.from('whatsapp_templates')
    .select('*')
    .eq('id', params.id)
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 404 })

  const guard = assertLocationAccess(user, data.location_id)
  if (guard) return guard

  return NextResponse.json({ success: true, template: data })
```

Replace the final `return` with:

```js
  const guard = assertLocationAccess(user, data.location_id)
  if (guard) return guard

  const { data: events } = await db.from('whatsapp_template_events')
    .select('kind, from_value, to_value, reason, created_at')
    .eq('template_id', params.id)
    .order('created_at', { ascending: false })
    .limit(50)

  return NextResponse.json({ success: true, template: data, events: events || [] })
```

- [ ] **Step 2: Lint + build**

Run: `npx eslint "src/app/api/whatsapp/templates/[id]/route.js" && npm run build`
Expected: lint clean; build compiles (the resubmit route from Task 6 + this change appear in the manifest).

- [ ] **Step 3: Commit**

```bash
git add "src/app/api/whatsapp/templates/[id]/route.js"
git commit -m "WA-TMPL.7 — template detail GET returns the recent status-change audit trail"
```

---

## Task 8: Client templates list — Realtime + quality chips + resubmit affordance

**Files:**
- Create: `src/components/WhatsappTemplatesList.jsx`
- Modify: `src/app/communications/templates/page.js` (render the client component for the WA section)

The list page is a **server** component that renders WhatsApp templates inline. Extract the WA list into a `'use client'` component so it can subscribe to Realtime, show quality chips, and offer resubmit/appeal — fetching via `/api/whatsapp/templates` (which returns `*`, so `quality_rating` is included).

- [ ] **Step 1: Create the client component**

```jsx
// src/components/WhatsappTemplatesList.jsx
'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { createBrowserClient } from '@/lib/supabase'

const STATUS_COLOR = {
  APPROVED: 'text-green-600',
  REJECTED: 'text-red-600',
  PAUSED: 'text-amber-600',
  DISABLED: 'text-red-600',
  PENDING: 'text-un1t-muted',
}
const QUALITY_CHIP = {
  GREEN: 'bg-green-500/15 text-green-700',
  YELLOW: 'bg-amber-500/15 text-amber-700',
  RED: 'bg-red-500/15 text-red-700',
}
const MANAGER_URL = 'https://business.facebook.com/wa/manage/message-templates/'

export default function WhatsappTemplatesList({ locationId }) {
  const [templates, setTemplates] = useState([])

  const fetchTemplates = useCallback(async () => {
    if (!locationId) return
    try {
      const res = await fetch(`/api/whatsapp/templates?location_id=${locationId}`)
      const data = await res.json()
      if (data.success) setTemplates(data.templates || [])
    } catch { /* best-effort */ }
  }, [locationId])

  useEffect(() => { fetchTemplates() }, [fetchTemplates])

  // Live-update on any template change at this location (mirrors WAInbox).
  useEffect(() => {
    if (!locationId) return
    const supabase = createBrowserClient()
    const channel = supabase
      .channel(`wa-templates-${locationId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'whatsapp_templates' }, () => fetchTemplates())
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [locationId, fetchTemplates])

  if (templates.length === 0) {
    return <p className="text-sm text-un1t-subtle px-1 py-4">No WhatsApp templates yet.</p>
  }

  return (
    <div className="divide-y divide-un1t-border">
      {templates.map(t => (
        <div key={t.id} className="flex items-center justify-between py-3 px-1">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Link href={`/whatsapp/templates/${t.id}`} className="text-sm font-medium text-un1t-text hover:underline truncate">{t.name}</Link>
              {t.quality_rating && QUALITY_CHIP[t.quality_rating] && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${QUALITY_CHIP[t.quality_rating]}`}>{t.quality_rating}</span>
              )}
            </div>
            <p className="text-xs text-un1t-subtle truncate">
              {t.category} · {t.language} · <span className={STATUS_COLOR[t.status] || 'text-un1t-muted'}>{t.status}</span>
              {t.status === 'REJECTED' && t.rejection_reason ? ` — ${t.rejection_reason}` : ''}
            </p>
          </div>
          {['REJECTED', 'PAUSED'].includes(t.status) && (
            <div className="flex items-center gap-2 shrink-0">
              <Link href={`/whatsapp/templates/${t.id}`} className="text-xs text-blue-600 hover:underline">Edit &amp; resubmit</Link>
              <a href={MANAGER_URL} target="_blank" rel="noopener noreferrer" className="text-xs text-un1t-subtle hover:underline">Appeal ↗</a>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Render it from the templates page for the WhatsApp section**

In `src/app/communications/templates/page.js`, add the import at the top:

```js
import WhatsappTemplatesList from '@/components/WhatsappTemplatesList'
```

Find where the WhatsApp templates are rendered (the block that maps `waRes.data` into rows, including the status badge `<p>` with `t.category · t.language · <span>{t.status}</span>`). Replace that WhatsApp list/map block with the client component (pass the active location), leaving the email section untouched:

```jsx
{(channel === 'all' || channel === 'whatsapp') && canWhatsapp && (
  <section>
    <h2 className="text-sm font-semibold text-un1t-subtle uppercase tracking-wider mb-2 flex items-center gap-1.5">
      <MessageCircle size={14} /> WhatsApp
    </h2>
    <WhatsappTemplatesList locationId={locationId} />
  </section>
)}
```

> If the existing WhatsApp section has surrounding markup (heading, "New" button) you want to keep, preserve it and only swap the inner list/map for `<WhatsappTemplatesList locationId={locationId} />`. The server-side `waRes` fetch can stay or be removed — the client component now owns the WA list; if `waRes` becomes unused, delete its branch from the `Promise.all` to avoid a dead query.

- [ ] **Step 3: Lint + build**

Run: `npx eslint src/components/WhatsappTemplatesList.jsx src/app/communications/templates/page.js && npm run build`
Expected: clean; build compiles (`createBrowserClient` is a real export of `@/lib/supabase`).

- [ ] **Step 4: Commit**

```bash
git add src/components/WhatsappTemplatesList.jsx src/app/communications/templates/page.js
git commit -m "WA-TMPL.8 — client WA templates list: realtime + quality chips + resubmit/appeal"
```

---

## Task 9: Quality chips in the composer + inbox pickers

**Files:**
- Modify: `src/components/WAInbox.jsx` (template picker)
- Modify: `src/components/communications/UnifiedSendComposer.jsx` (WhatsApp template `<select>` is by `<option>` — add a chip in the preview area)

- [ ] **Step 1: WAInbox — show a quality chip on each template in the picker**

In `src/components/WAInbox.jsx`, find the picker button body:

```jsx
              <p className="text-sm font-medium">{t.name}</p>
              <p className="text-xs text-un1t-muted truncate mt-0.5">
                {bodyComp?.text || 'No body text'}
              </p>
```

Replace the name `<p>` with a name + chip row:

```jsx
              <p className="text-sm font-medium flex items-center gap-1.5">
                {t.name}
                {t.quality_rating === 'RED' && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-700">RED</span>}
                {t.quality_rating === 'YELLOW' && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-700">YELLOW</span>}
              </p>
              <p className="text-xs text-un1t-muted truncate mt-0.5">
                {bodyComp?.text || 'No body text'}
              </p>
```

(`fetchTemplates` already requests `*` via `/api/whatsapp/templates?...&status=APPROVED`, so `t.quality_rating` is present — no fetch change needed.)

- [ ] **Step 2: UnifiedSendComposer — show a quality chip in the selected-template preview**

In `src/components/communications/UnifiedSendComposer.jsx`, find the WhatsApp preview block:

```jsx
            {selectedTemplate && (
              <div className="mt-3 rounded-lg border border-un1t-border bg-un1t-bg/40 p-3">
                <p className="text-[11px] uppercase tracking-wider text-un1t-subtle mb-1">Preview</p>
```

Replace that opening with one that adds a chip when the template's quality is degraded:

```jsx
            {selectedTemplate && (
              <div className="mt-3 rounded-lg border border-un1t-border bg-un1t-bg/40 p-3">
                <div className="flex items-center justify-between mb-1">
                  <p className="text-[11px] uppercase tracking-wider text-un1t-subtle">Preview</p>
                  {['YELLOW', 'RED'].includes(selectedTemplate.quality_rating) && (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${selectedTemplate.quality_rating === 'RED' ? 'bg-red-500/15 text-red-700' : 'bg-amber-500/15 text-amber-700'}`}>
                      Quality {selectedTemplate.quality_rating}
                    </span>
                  )}
                </div>
```

> Confirm the composer's `templates` prop carries `quality_rating`. The prop is loaded by the send page (`src/app/communications/send/page.js`). If that page's template query selects explicit columns, add `quality_rating` (or switch to `select('*')`); if it already uses `*`, no change. Check with `grep -n "whatsapp_templates" src/app/communications/send/page.js`.

- [ ] **Step 3: Lint + build**

Run: `npx eslint src/components/WAInbox.jsx src/components/communications/UnifiedSendComposer.jsx && npm run build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/components/WAInbox.jsx src/components/communications/UnifiedSendComposer.jsx src/app/communications/send/page.js
git commit -m "WA-TMPL.9 — quality chips in the inbox + composer template pickers"
```

(If `send/page.js` was unchanged, drop it from the `git add`.)

---

## Task 10: Editor — audit timeline + edit-&-resubmit + appeal deep-link

**Files:**
- Modify: `src/app/whatsapp/templates/[id]/page.js` (pass `events` + a resubmit-capable flag to the editor)
- Modify: `src/components/WATemplateEditor.jsx` (timeline panel; for REJECTED/PAUSED: rejection reason + unlock + resubmit + appeal link)

- [ ] **Step 1: Pass events into the editor from the detail page**

In `src/app/whatsapp/templates/[id]/page.js`, after loading the template, also load its events and pass them through. Find the template load + the `<WATemplateEditor ... />` render and add an events fetch + prop. (The page is a server component using `createServerClient`.) Add before the render:

```js
  const { data: events } = await db.from('whatsapp_template_events')
    .select('kind, from_value, to_value, reason, created_at')
    .eq('template_id', params.id)
    .order('created_at', { ascending: false })
    .limit(50)
```

and add `events={events || []}` to the `<WATemplateEditor ... />` props.

> If this page doesn't currently load `db`/the template (e.g. it passes only an id), match its existing shape — add the events query alongside however it already fetches the template, and thread `events` to the editor.

- [ ] **Step 2: WATemplateEditor — accept `events`, render the timeline, and add resubmit/appeal for REJECTED/PAUSED**

Change the signature:

```jsx
export default function WATemplateEditor({ template, locationId, userId, events = [] }) {
```

Add, near the other derived flags (after `const isSubmitted = ...`):

```js
  const canResubmit = ['REJECTED', 'PAUSED'].includes(template?.status)
  const MANAGER_URL = 'https://business.facebook.com/wa/manage/message-templates/'
```

Add a `resubmitting` state with the other `useState`s:

```js
  const [resubmitting, setResubmitting] = useState(false)
```

Add a resubmit handler (near `handleSave`):

```js
  async function handleResubmit() {
    setResubmitting(true)
    setError(null)
    try {
      const result = await fetch(`/api/whatsapp/templates/${template.id}/resubmit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, components: buildComponents() }),
      }).then(r => r.json())
      if (!result.success) throw new Error(result.error)
      router.push('/communications/templates?channel=whatsapp')
      router.refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setResubmitting(false)
    }
  }
```

Override the form lock so a REJECTED/PAUSED template is editable. Find the `disabled={saving || isSubmitted}` usages and change the lock to `disabled={saving || (isSubmitted && !canResubmit)}` (so fields unlock when `canResubmit`). Then, in the JSX, add a panel above the form (when `template` exists) showing the rejection reason (if any) + a timeline + the resubmit/appeal actions:

```jsx
      {template && (canResubmit || events.length > 0) && (
        <div className="mb-4 rounded-lg border border-un1t-border bg-un1t-surface p-4 space-y-3">
          {canResubmit && (
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm">
                <span className="font-medium text-amber-700">{template.status}</span>
                {template.rejection_reason ? <span className="text-un1t-subtle"> — {template.rejection_reason}</span> : null}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button type="button" onClick={handleResubmit} disabled={resubmitting}
                  className="text-sm bg-green-600 text-white px-3 py-1.5 rounded-md hover:bg-green-700 disabled:opacity-50">
                  {resubmitting ? 'Resubmitting…' : 'Edit & resubmit'}
                </button>
                <a href={MANAGER_URL} target="_blank" rel="noopener noreferrer"
                  className="text-sm text-un1t-subtle hover:text-un1t-text underline">Appeal in WhatsApp Manager ↗</a>
              </div>
            </div>
          )}
          {events.length > 0 && (
            <div>
              <p className="text-[11px] uppercase tracking-wider text-un1t-subtle mb-1">History</p>
              <ul className="space-y-1">
                {events.map((e, i) => (
                  <li key={i} className="text-xs text-un1t-subtle">
                    <span className="text-un1t-text">{e.kind === 'status' ? e.to_value : `${e.kind} ${e.from_value || '?'}→${e.to_value}`}</span>
                    {e.reason ? ` — ${e.reason}` : ''}
                    <span className="text-un1t-muted"> · {new Date(e.created_at).toLocaleString('en-IE', { dateStyle: 'medium', timeStyle: 'short' })}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
```

> `buildComponents()`, `category`, `router`, `setError`, `useState` are all already defined in the editor (per its create/edit flow). The resubmit posts the *currently edited* components, so the operator fixes the rejection then clicks Edit & resubmit.

- [ ] **Step 3: Lint + build**

Run: `npx eslint src/components/WATemplateEditor.jsx "src/app/whatsapp/templates/[id]/page.js" && npm run build`
Expected: clean; build compiles.

- [ ] **Step 4: Commit**

```bash
git add src/components/WATemplateEditor.jsx "src/app/whatsapp/templates/[id]/page.js"
git commit -m "WA-TMPL.10 — editor: status-change timeline + edit-&-resubmit + appeal deep-link"
```

---

## Task 11: Full verification + ship

**Files:** none (verification + PR)

- [ ] **Step 1: Full CI mirror**

Run: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports`
Expected: all green. (No `WEB_PERMISSIONS`/`shared/permissions.js` change — parity has nothing new. The push reuses the `whatsapp` notify category.)

- [ ] **Step 2: Production build**

Run: `npm run build`
Expected: success; `/api/whatsapp/templates/[id]/resubmit` in the manifest.

- [ ] **Step 3: Confirm the migration is applied** (re-run Task 1 Step 3 query). Expected: `quality_col=1, events_table=1, realtime_tables=2`.

- [ ] **Step 4: Manual verification (auth/Meta-gated — cannot be unit-tested)**

These need the deployed preview + Meta:
1. **Prerequisite:** subscribe `message_template_status_update`, `message_template_quality_update`, `template_category_update` in Meta App → WhatsApp → Configuration → Webhook fields.
2. Create/edit a template so Meta reviews it → on the status change, confirm: the templates list status updates **without refresh** (Realtime), a manager **push** fires, and a row lands in `whatsapp_template_events` (`select * from whatsapp_template_events order by created_at desc limit 5;`).
3. On a REJECTED template: open it, fix the body, click **Edit & resubmit** → status → PENDING → the webhook tracks the re-review outcome. Confirm the **Appeal** link opens WhatsApp Manager.
4. Confirm a quality YELLOW/RED chip shows in the list + pickers (set `quality_rating` manually in SQL to test the UI if Meta hasn't sent one: `update whatsapp_templates set quality_rating='RED' where id='…';`).

Record outcomes in the PR. Do not rely on these passing automatically.

- [ ] **Step 5: Push + the PR already exists (#426)**

```bash
git push
```
The branch `wa-template-events` already has PR [#426](https://github.com/ivers9307-cyber/un1t-crm/pull/426) (spec). Update its body to cover the implementation (`gh pr edit 426 --body …`) and report the PR URL.

---

## Self-Review

**1. Spec coverage:**

| Spec part | Task(s) |
|---|---|
| A — webhook consumer (status/quality/category → row) | 2, 3, 4 |
| A — idempotent skip-when-unchanged | 3 |
| A — manager push (whatsapp category) | 4 |
| A — Realtime page | 1 (publication) + 8 (subscription) |
| Data model — quality_rating + events table + RLS + realtime | 1 |
| B — audit trail (events written) | 3 (write) + 1 (table) |
| B — per-template timeline UI | 7 (GET) + 10 (editor render) |
| C — quality chips in pickers | 8 (list) + 9 (composer + inbox) |
| D — editTemplate (Meta) | 5 |
| D — resubmit API (guarded, REJECTED/PAUSED) | 6 |
| D — edit-&-resubmit UI + appeal deep-link | 8 (row link) + 10 (editor) |
| Notification policy | 2 (pure) + 4 (push) |
| Testing (pure helpers + editTemplate) | 2, 5 |
| Meta prerequisite (subscribe fields) | 11 Step 4.1 |

Every spec section maps to a task. No gaps.

**2. Placeholder scan:** Each code step contains complete code or an exact before/after edit. The few `>`-prefixed notes (e.g. "confirm the send page selects quality_rating", "match the page's existing fetch shape") are conditional guards for ambiguity the engineer resolves with a named grep, not deferred work — they tell exactly what to check and what to do either way.

**3. Type/name consistency:**
- `templateColumnUpdate` / `templateNotification` / `templateEventRow` (Task 2) → consumed by `applyTemplateEvent` (Task 3). ✓
- `applyTemplateEvent(db, field, value)` returns `{ template, notify }` (Task 3) → consumed in the route's `handleTemplateEvent` (Task 4). ✓
- `editTemplate(metaTemplateId, { category, components }, opts)` (Task 5) → called by the resubmit route (Task 6). ✓
- Event row shape `{ kind, from_value, to_value, reason }` (Task 2) matches the `whatsapp_template_events` columns (Task 1) + the GET select (Task 7) + the editor render (Task 10). ✓
- `quality_rating` column (Task 1) → read in list (8), pickers (9), engine mapping (2). ✓
- Push call `sendPushToRolesAtLocation(locationId, MANAGER_ROLES, {title,body,category,data})` matches the verified signature. ✓
- `whatsapp` notify category consistent (Task 4) — no new permission key. ✓

No inconsistencies.

---

## Execution notes

- Work in the existing worktree `/Users/richardivers/code/un1t-crm-templates` on branch `wa-template-events` (spec + this plan already there). The user works concurrently in the main checkout — never touch it.
- The webhook consumer (Tasks 1–4) is independently shippable and is the highest-value half; D (Tasks 5,6,10-resubmit) is the largest and can land after.
- Manual verification (Task 11 Step 4) is the only path no test covers — it needs the Meta-side field subscription first.
