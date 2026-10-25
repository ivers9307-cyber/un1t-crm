# WASTUDIOPICK.1 — which studio a new WhatsApp sender belongs to: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For an unknown WhatsApp sender's first message on a number whose studio has the picker switched on, decide their studio (ad → reply context → classifier → tap-button picker), move the thread there, record how, and keep Mia quiet until it is settled.

**Architecture:** A small module `src/lib/wa-studio-pick/` (config reader, three signal functions, a classifier, one orchestrator) called once from the inbound webhook after the message is stored and before Mia. State lives in one new column, `whatsapp_conversations.studio_resolution` (mig 725). Moves go through Phase 1's `move_whatsapp_conversation`. Settings are a `wa_studio_picker` key in `locations.settings`, edited on a new card in the WhatsApp settings tab.

**Tech Stack:** Next.js 16 App Router, Supabase (service-role), vitest, PGlite, Anthropic Messages API via the repo's `anthropicMessages` helper (raw fetch, metered).

**Spec:** `docs/superpowers/specs/2026-10-15-wa-new-sender-studio-design.md`

**Worktree:** `/Users/richardivers/code/un1t-crm-wa-new-sender`, branch `feat/wa-new-sender-studio` (off origin/main 8dbaaa5b). Never `git checkout`/`pull`/bare `git stash`. Run `npm ci` here first if `node_modules` is missing (a symlink to another worktree breaks `next build`).

## Global Constraints

- Everything is OFF by default: `enabled` and `listed` default false; with them false, behaviour is exactly today's.
- Only unknown senders (no matched contact), only on a thread at the receiving number's studio, only within one organisation.
- A thread is resolved at most once; `asked` is the only non-final status; nobody is asked twice.
- Mia (`maybeAutoReply`) and the welcome greeting are not called while a thread is `asked` or on the message that sent the picker.
- Picker button id format: `studio:<location_id>`; button title ≤ 20 chars; > 3 studios → list message.
- Default question (exact): `Thanks for getting in touch. Which studio is this about?` — no em-dashes; operator text passes `stripEmDashes` at send.
- Label ≤ 20 chars; question ≤ 1024 chars; keywords: ≤ 10, each ≤ 40 chars.
- Classifier: `AGENT_MODEL`, `thinking: { type: 'adaptive' }`, `output_config: { effort: 'low', format: { type: 'json_schema', schema } }`, 8 s timeout, metered with `source: 'wa_studio_pick'` at the receiving studio; failure / timeout / refusal / cap reached / non-confident / unknown id = unsure.
- Settings edited by master or owner AT the studio (`guardMasterOrOwner`, as the card-sets route on the same tab; the spec's `canEditMiaSettings` is the same rule, and the tab's other cards use `guardMasterOrOwner`), written via `mergeLocationSettings` (SETTINGSWIPE.1).
- Webhook never throws / never non-2xx; resolver failures are logged and the message carries on as today.
- `tests/whatsapp-config-callers.test.js` is EXACT: the new `sendInteractiveOptions` caller needs a row.
- Fictional ids only in tests. Supabase builders are thenables: destructure and check `error`.
- Migration 725 is applied BEFORE merge (inert).

## Review Focus

1. **A tap on a picker button for a studio that has since been unlisted, or from another organisation** → ignored (treated as no answer), never moves the thread. Test in Task 4.
2. **The picker is sent but the customer ignores it and messages again a day later** (24 h window may have closed for us, but their message reopens it) → that message runs the classifier once and then the thread is final; no second picker. Test in Task 4.
3. **An unknown sender's thread that staff already moved (Phase 1 F1 sticky lookup)** → its `studio_resolution` is `decided/staff`, so the resolver skips it. Tests in Task 4 (skip on a final resolution) and Task 5 (the webhook passes it through).
4. **The classifier answers with an id that is not a listed studio (hallucinated) or `'none'` with `confident: true`** → unsure. Test in Task 3.
5. **`request_welcome` from an unknown sender with the picker on** → picker instead of greeting, and Mia is not invoked; with the picker off → greeting as today. Tests in Task 4 and Task 5.

---

## File structure

| File | Responsibility |
|---|---|
| `supabase/migrations/725_wa_conversation_studio_resolution.sql` (create) | the column |
| `tests/migration-725-studio-resolution.test.js` (create) | PGlite check |
| `src/lib/wa-studio-pick/config.js` (create) | constants, defaults, `readPickerConfig` |
| `src/lib/wa-studio-pick/signals.js` (create) | `adSignal`, `replySignal`, `tapSignal` |
| `src/lib/wa-studio-pick/classify.js` (create) | `classifyStudio` |
| `src/lib/wa-studio-pick/resolve.js` (create) | `resolveNewSenderStudio` orchestrator (+ picker send + record + move) |
| `src/lib/wa-studio-pick/*.test.js` (create) | unit tests |
| `src/lib/whatsapp.js` (modify `buildInteractivePayload`) | accept `{ id, title }` options |
| `src/app/api/webhooks/whatsapp/route.js` (modify) | call the resolver, gate Mia + greeting |
| `src/app/api/webhooks/whatsapp/route.studio-pick.test.js` (create) | webhook integration tests |
| `src/app/api/whatsapp/studio-picker/route.js` (+ test) (create) | GET/PUT settings |
| `src/components/settings/integrations/WhatsAppIntegrationTab.jsx` (modify) | "Studio picker" card |
| `src/app/api/whatsapp/conversations/[id]/move/route.js` (modify) | record `by: 'staff'` |
| `src/components/WAInbox.jsx` (modify) | "Filed by" / "Asked which studio" note |
| `src/lib/openapi.js`, `tests/whatsapp-config-callers.test.js` (modify) | registration, caller row |

---

### Task 1: Migration 725 — `studio_resolution` column

**Files:**
- Create: `supabase/migrations/725_wa_conversation_studio_resolution.sql`
- Test: `tests/migration-725-studio-resolution.test.js`

**Interfaces:**
- Produces: `whatsapp_conversations.studio_resolution jsonb NULL` — shape `{ status: 'asked'|'decided'|'unresolved', by?: 'ad'|'reply'|'ai'|'picker'|'staff', location_id?: uuid, reason?: string, at: ISO string }`.

- [ ] **Step 1: Failing test**

```js
// WASTUDIOPICK.1 — migration 725 adds whatsapp_conversations.studio_resolution.
// Fictional ids only.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/725_wa_conversation_studio_resolution.sql'), 'utf8')
const SCHEMA = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE TABLE public.whatsapp_conversations (id uuid PRIMARY KEY, location_id uuid NOT NULL, wa_phone text);
  GRANT SELECT ON public.whatsapp_conversations TO authenticated;
  INSERT INTO public.whatsapp_conversations VALUES ('c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', '15555550100');
`
async function boot() { const db = new PGlite(); await db.exec(SCHEMA); return db }

describe('725', () => {
  it('adds a nullable jsonb column, existing rows NULL; a second run passes', async () => {
    const db = await boot()
    await db.exec(MIG)
    await db.exec(MIG)
    const col = (await db.query(`SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name='whatsapp_conversations' AND column_name='studio_resolution'`)).rows[0]
    expect(col).toEqual({ data_type: 'jsonb', is_nullable: 'YES' })
    expect((await db.query(`SELECT studio_resolution FROM whatsapp_conversations`)).rows[0].studio_resolution).toBeNull()
  })
  it('authenticated can read it (table-level SELECT unchanged) and write nothing', async () => {
    const db = await boot()
    await db.exec(MIG)
    const priv = (await db.query(`SELECT string_agg(privilege_type, ',' ORDER BY privilege_type) p FROM information_schema.table_privileges WHERE table_name='whatsapp_conversations' AND grantee='authenticated'`)).rows[0].p
    expect(priv).toBe('SELECT')
  })
})
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run tests/migration-725-studio-resolution.test.js` → ENOENT.

- [ ] **Step 3: Migration**

```sql
-- 725_wa_conversation_studio_resolution.sql
-- WASTUDIOPICK.1 — how an unknown WhatsApp sender's studio was decided
-- (docs/superpowers/specs/2026-10-15-wa-new-sender-studio-design.md, R6).
-- { status: 'asked'|'decided'|'unresolved', by?: 'ad'|'reply'|'ai'|'picker'|'staff',
--   location_id?, reason?, at }. NULL = never considered. 'asked' is the only
-- non-final status. Written only by service-role code (the webhook's
-- resolver and the Move to studio route).
-- column-grant: whatsapp_conversations carries table-level SELECT for
-- authenticated (mig 661), so the inbox realtime reads this column like the
-- rest of the row; no write privilege changes.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.whatsapp_conversations ADD COLUMN IF NOT EXISTS studio_resolution jsonb;
COMMENT ON COLUMN public.whatsapp_conversations.studio_resolution IS
  'WASTUDIOPICK.1 (mig 725): how an unknown sender''s studio was decided; NULL = never considered.';
COMMIT;
```

- [ ] **Step 4: Run** the test + `npx vitest run tests/` filtered to the WhatsApp-conversation guards (`tests/whatsapp-conversations-broadcasts-client-writes-guard.test.js`) + `npm run check:select-columns`. Expected PASS.

- [ ] **Step 5: Commit** `WASTUDIOPICK.1 — mig 725: whatsapp_conversations.studio_resolution`

---

### Task 2: Config reader + interactive option ids

**Files:**
- Create: `src/lib/wa-studio-pick/config.js`, `src/lib/wa-studio-pick/config.test.js`
- Modify: `src/lib/whatsapp.js` (`buildInteractivePayload`, ~l.119) + its existing test file (find with `grep -rln buildInteractivePayload src`)

**Interfaces:**
- Produces:
  - `DEFAULT_PICKER_QUESTION`, `PICKER_ID_PREFIX = 'studio:'`, `LABEL_MAX = 20`, `QUESTION_MAX = 1024`, `KEYWORDS_MAX = 10`, `KEYWORD_LEN_MAX = 40`
  - `pickerLabel(location) → string` (label trimmed, else name; cut to 20)
  - `readPickerConfig(db, receivingLocationId) → Promise<{ enabled: boolean, question: string, studios: Array<{ id, name, label, keywords: string[] }> } | null>` — `null` on a failed read (logged `logWarn('wa-studio-pick', …)`). `studios` = every location in the receiving studio's organisation with `settings.wa_studio_picker.listed === true`, ordered by name. `enabled`/`question` come from the receiving studio's `settings.wa_studio_picker`.
  - `buildInteractivePayload(to, text, options)` now accepts each option as a string (unchanged: id `opt_<i>`) or `{ id, title }` (its own id).

- [ ] **Step 1: Failing tests**

`config.test.js`:
```js
// WASTUDIOPICK.1 — picker settings. Fictional ids only.
import { describe, it, expect, vi } from 'vitest'
vi.mock('../log', () => ({ logWarn: vi.fn() }))
import { readPickerConfig, pickerLabel, DEFAULT_PICKER_QUESTION } from './config.js'
import { logWarn } from '../log'

const ORG = 'd0000000-0000-4000-8000-000000000001'
const STILL = { id: 'a1', name: 'UN1T Stillorgan', organization_id: ORG, settings: { wa_studio_picker: { enabled: true, listed: true, label: 'Stillorgan', keywords: ['stillorgan'] } } }
const HATCH = { id: 'a2', name: 'UN1T Hatch Street', organization_id: ORG, settings: { wa_studio_picker: { listed: true } } }
const TEST = { id: 'a3', name: 'Test Studio', organization_id: ORG, settings: {} }
const OTHER = { id: 'a9', name: 'Elsewhere', organization_id: 'd0000000-0000-4000-8000-000000000009', settings: { wa_studio_picker: { listed: true } } }

function makeDb(rows, fault) {
  return {
    from: () => {
      const filters = []
      const run = () => (fault ? { data: null, error: fault } : { data: rows.filter((r) => filters.every((f) => f(r))), error: null })
      const b = {
        select: () => b, order: () => b,
        eq: (c, v) => { filters.push((r) => r[c] === v); return b },
        maybeSingle: async () => { const o = run(); return o.error ? o : { data: o.data[0] ?? null, error: null } },
        then: (res, rej) => Promise.resolve(run()).then(res, rej),
      }
      return b
    },
  }
}

describe('readPickerConfig', () => {
  it('lists opted-in studios of the receiving studio’s organisation, with defaults', async () => {
    const cfg = await readPickerConfig(makeDb([STILL, HATCH, TEST, OTHER]), 'a1')
    expect(cfg.enabled).toBe(true)
    expect(cfg.question).toBe(DEFAULT_PICKER_QUESTION)
    expect(cfg.studios.map((s) => s.id).sort()).toEqual(['a1', 'a2'])
    expect(cfg.studios.find((s) => s.id === 'a2')).toMatchObject({ label: 'UN1T Hatch Street', keywords: [] })
  })
  it('disabled by default; a failed read is null and logged', async () => {
    expect((await readPickerConfig(makeDb([HATCH, TEST]), 'a2')).enabled).toBe(false)
    expect(await readPickerConfig(makeDb([], { message: 'boom' }), 'a1')).toBeNull()
    expect(logWarn).toHaveBeenCalled()
  })
})

describe('pickerLabel', () => {
  it('label, else name, cut to 20', () => {
    expect(pickerLabel({ name: 'UN1T Hatch Street Dublin 2', settings: {} })).toBe('UN1T Hatch Street Du')
    expect(pickerLabel({ name: 'x', settings: { wa_studio_picker: { label: '  Hatch Street ' } } })).toBe('Hatch Street')
  })
})
```

In the `buildInteractivePayload` test file add:
```js
it('WASTUDIOPICK.1 — an option may carry its own id', () => {
  const p = buildInteractivePayload('353000000000', 'Which?', [{ id: 'studio:a1', title: 'Stillorgan' }, { id: 'studio:a2', title: 'Hatch Street' }])
  expect(p.interactive.action.buttons.map((b) => b.reply)).toEqual([{ id: 'studio:a1', title: 'Stillorgan' }, { id: 'studio:a2', title: 'Hatch Street' }])
  const list = buildInteractivePayload('353000000000', 'Which?', [1, 2, 3, 4].map((i) => ({ id: `studio:a${i}`, title: `S${i}` })))
  expect(list.interactive.action.sections[0].rows[3]).toEqual({ id: 'studio:a4', title: 'S4' })
})
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

`config.js`:
```js
// WASTUDIOPICK.1 — settings for the WhatsApp studio picker
// (locations.settings.wa_studio_picker; spec R8). Every studio may be
// `listed` (with a `label` and classifier `keywords`); the studio that owns the
// number carries `enabled` and the `question`. Defaults keep it all OFF.
import { logWarn } from '../log'

export const DEFAULT_PICKER_QUESTION = 'Thanks for getting in touch. Which studio is this about?'
export const PICKER_ID_PREFIX = 'studio:'
export const LABEL_MAX = 20
export const QUESTION_MAX = 1024
export const KEYWORDS_MAX = 10
export const KEYWORD_LEN_MAX = 40

const pickerOf = (loc) => (loc?.settings && typeof loc.settings === 'object' ? loc.settings.wa_studio_picker : null) || {}

export function pickerLabel(loc) {
  const label = String(pickerOf(loc).label || '').trim()
  return (label || String(loc?.name || '').trim()).slice(0, LABEL_MAX)
}

export async function readPickerConfig(db, receivingLocationId) {
  try {
    const { data: home, error: homeErr } = await db.from('locations')
      .select('id, name, organization_id, settings').eq('id', receivingLocationId).maybeSingle()
    if (homeErr) throw homeErr
    if (!home?.organization_id) return null
    const { data: rows, error } = await db.from('locations')
      .select('id, name, organization_id, settings').eq('organization_id', home.organization_id).order('name')
    if (error) throw error
    const own = pickerOf(home)
    const studios = (rows || [])
      .filter((l) => pickerOf(l).listed === true)
      .map((l) => ({
        id: l.id,
        name: l.name,
        label: pickerLabel(l),
        keywords: (Array.isArray(pickerOf(l).keywords) ? pickerOf(l).keywords : [])
          .map((k) => String(k).trim()).filter(Boolean).slice(0, KEYWORDS_MAX),
      }))
    const question = String(own.question || '').trim() || DEFAULT_PICKER_QUESTION
    return { enabled: own.enabled === true, question, studios }
  } catch (e) {
    logWarn('wa-studio-pick', 'picker settings unreadable; picker skipped', { receivingLocationId, err: e?.message || String(e) })
    return null
  }
}
```

`whatsapp.js` `buildInteractivePayload`: replace the two `opts.map` bodies so an option is normalised first:
```js
  const norm = (o, i) => (o && typeof o === 'object' ? { id: String(o.id), title: String(o.title) } : { id: `opt_${i}`, title: String(o) })
  // buttons:
  buttons: opts.map((o, i) => { const n = norm(o, i); return { type: 'reply', reply: { id: n.id, title: n.title.slice(0, 20) } } }),
  // list rows:
  rows: opts.map((o, i) => { const n = norm(o, i); return { id: n.id, title: n.title.slice(0, 24) } }),
```
Update the AGENT-UX.1 comment: "an option is a string (id `opt_<i>`) or `{ id, title }` (WASTUDIOPICK.1)".

- [ ] **Step 4: Run** `npx vitest run src/lib/wa-studio-pick src/lib/whatsapp*.test.js && npm run check:select-columns` → PASS.
- [ ] **Step 5: Commit** `WASTUDIOPICK.1 — picker settings reader; interactive options may carry their own id`

---

### Task 3: Signals + classifier

**Files:**
- Create: `src/lib/wa-studio-pick/signals.js`, `src/lib/wa-studio-pick/classify.js`, tests `signals.test.js`, `classify.test.js`

**Interfaces:**
- Consumes: `PICKER_ID_PREFIX` (Task 2).
- Produces:
  - `adSignal(db, referral, studioIds: string[]) → Promise<string|null>` — `referral.source_type === 'ad'` and `referral.source_id`; `ad_entities` `.eq('level','ad').eq('external_id', source_id).in('location_id', studioIds)`; exactly one distinct `location_id` → it; else null. A failed read → null (logged).
  - `replySignal(db, contextId, studioIds) → Promise<string|null>` — `whatsapp_messages` `.eq('wa_message_id', contextId).in('location_id', studioIds).limit(1)` → its `location_id`; else null; failed read → null (logged).
  - `tapSignal(message, studioIds) → string|null` — `message.type === 'interactive'`, id from `interactive.button_reply.id` or `interactive.list_reply.id`, starts with `studio:`, the rest is in `studioIds` → it; else null.
  - `classifyStudio({ text, studios, locationId }) → Promise<{ studioId: string|null, reason: string }>` — reasons: `'decided' | 'empty' | 'capped' | 'call_failed' | 'refused' | 'unsure' | 'unparseable'`.

- [ ] **Step 1: Failing tests**

`signals.test.js` — fake db with `ad_entities` and `whatsapp_messages` arrays (same chainable pattern as Task 2's `makeDb`, plus `in` and `limit`):
```js
it('adSignal: one studio → it; two studios or none → null; non-ad referral → null', async () => {
  const db = makeDb({ ad_entities: [{ level: 'ad', external_id: 'AD1', location_id: 'a2' }, { level: 'ad', external_id: 'AD2', location_id: 'a1' }, { level: 'ad', external_id: 'AD2', location_id: 'a2' }] })
  expect(await adSignal(db, { source_type: 'ad', source_id: 'AD1' }, ['a1', 'a2'])).toBe('a2')
  expect(await adSignal(db, { source_type: 'ad', source_id: 'AD2' }, ['a1', 'a2'])).toBeNull()
  expect(await adSignal(db, { source_type: 'ad', source_id: 'AD9' }, ['a1', 'a2'])).toBeNull()
  expect(await adSignal(db, { source_type: 'post', source_id: 'AD1' }, ['a1', 'a2'])).toBeNull()
  expect(await adSignal(db, null, ['a1', 'a2'])).toBeNull()
})
it('replySignal: the replied-to message’s studio when listed', async () => {
  const db = makeDb({ whatsapp_messages: [{ wa_message_id: 'wamid.X', location_id: 'a2' }] })
  expect(await replySignal(db, 'wamid.X', ['a1', 'a2'])).toBe('a2')
  expect(await replySignal(db, 'wamid.X', ['a1'])).toBeNull()
  expect(await replySignal(db, null, ['a1', 'a2'])).toBeNull()
})
it('tapSignal: only studio:<listed id> (Review Focus 1)', () => {
  const tap = (id) => ({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: 'x' } } })
  expect(tapSignal(tap('studio:a2'), ['a1', 'a2'])).toBe('a2')
  expect(tapSignal(tap('studio:a9'), ['a1', 'a2'])).toBeNull()
  expect(tapSignal(tap('opt_0'), ['a1', 'a2'])).toBeNull()
  expect(tapSignal({ type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'studio:a1' } } }, ['a1', 'a2'])).toBe('a1')
  expect(tapSignal({ type: 'text', text: { body: 'studio:a1' } }, ['a1', 'a2'])).toBeNull()
})
it('a failed read is null, logged', async () => { /* fault on ad_entities → null; logWarn called */ })
```

`classify.test.js` — mock `@/lib/anthropic` (`anthropicMessages: vi.fn()`) and `@/lib/usage-caps` (`getAiCapStatus: vi.fn(async () => ({ capped: false }))`):
```js
const STUDIOS = [{ id: 'a1', name: 'UN1T Stillorgan', label: 'Stillorgan', keywords: ['stillorgan'] }, { id: 'a2', name: 'UN1T Hatch Street', label: 'Hatch Street', keywords: ['hatch'] }]
const reply = (obj, extra = {}) => ({ res: { ok: true }, data: { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }], ...extra } })

it('a confident listed studio decides', async () => {
  anthropicMessages.mockResolvedValue(reply({ studio: 'a2', confident: true }))
  expect(await classifyStudio({ text: 'is the Hatch St one open Sunday?', studios: STUDIOS, locationId: 'a1' })).toEqual({ studioId: 'a2', reason: 'decided' })
  const [body, meta] = anthropicMessages.mock.calls[0]
  expect(body.output_config.format.type).toBe('json_schema')
  expect(body.output_config.format.schema.properties.studio.enum).toEqual(['a1', 'a2', 'none'])
  expect(body.output_config.effort).toBe('low')
  expect(meta).toMatchObject({ locationId: 'a1', source: 'wa_studio_pick' })
  expect(meta.signal).toBeDefined()
})
it.each([
  ['not confident', reply({ studio: 'a2', confident: false }), 'unsure'],
  ['none', reply({ studio: 'none', confident: true }), 'unsure'],
  ['hallucinated id (Review Focus 4)', reply({ studio: 'a7', confident: true }), 'unsure'],
  ['bad JSON', { res: { ok: true }, data: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hatch' }] } }, 'unparseable'],
  ['refusal', reply({ studio: 'a2', confident: true }, { stop_reason: 'refusal' }), 'refused'],
  ['HTTP error', { res: { ok: false, status: 529 }, data: null }, 'call_failed'],
])('%s → unsure', async (_n, r, reason) => {
  anthropicMessages.mockResolvedValue(r)
  expect(await classifyStudio({ text: 'hi', studios: STUDIOS, locationId: 'a1' })).toEqual({ studioId: null, reason })
})
it('a thrown/aborted call → call_failed; empty text → empty without a call; cap reached → capped without a call', async () => {
  anthropicMessages.mockRejectedValue(new Error('aborted'))
  expect((await classifyStudio({ text: 'hi', studios: STUDIOS, locationId: 'a1' })).reason).toBe('call_failed')
  anthropicMessages.mockClear()
  expect((await classifyStudio({ text: '  ', studios: STUDIOS, locationId: 'a1' })).reason).toBe('empty')
  getAiCapStatus.mockResolvedValueOnce({ capped: true })
  expect((await classifyStudio({ text: 'hi', studios: STUDIOS, locationId: 'a1' })).reason).toBe('capped')
  expect(anthropicMessages).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

`signals.js`:
```js
// WASTUDIOPICK.1 — the structured signals for an unknown sender's studio
// (spec R2.1, R2.2, R5). Each returns one listed studio id or null; a failed
// read is null, logged (the next signal or the picker takes over).
import { logWarn } from '../log'
import { PICKER_ID_PREFIX } from './config'

export async function adSignal(db, referral, studioIds) {
  if (!referral || referral.source_type !== 'ad' || !referral.source_id || !studioIds?.length) return null
  try {
    const { data, error } = await db.from('ad_entities').select('location_id')
      .eq('level', 'ad').eq('external_id', String(referral.source_id)).in('location_id', studioIds)
    if (error) throw error
    const ids = [...new Set((data || []).map((r) => r.location_id))]
    return ids.length === 1 ? ids[0] : null
  } catch (e) {
    logWarn('wa-studio-pick', 'ad lookup failed', { err: e?.message || String(e) })
    return null
  }
}

export async function replySignal(db, contextId, studioIds) {
  if (!contextId || !studioIds?.length) return null
  try {
    const { data, error } = await db.from('whatsapp_messages').select('location_id')
      .eq('wa_message_id', String(contextId)).in('location_id', studioIds).limit(1)
    if (error) throw error
    return data?.[0]?.location_id || null
  } catch (e) {
    logWarn('wa-studio-pick', 'reply-context lookup failed', { err: e?.message || String(e) })
    return null
  }
}

export function tapSignal(message, studioIds) {
  if (message?.type !== 'interactive') return null
  const id = message.interactive?.button_reply?.id || message.interactive?.list_reply?.id || ''
  if (!id.startsWith(PICKER_ID_PREFIX)) return null
  const studioId = id.slice(PICKER_ID_PREFIX.length)
  return studioIds?.includes(studioId) ? studioId : null
}
```

`classify.js`:
```js
// WASTUDIOPICK.1 (spec R2.3) — one model call reading ONE message to say
// which listed studio it is about. Runs outside Mia (whether she is on or
// off), metered to the receiving studio. Anything but a confident listed id
// is "unsure": the picker asks instead.
import { anthropicMessages } from '@/lib/anthropic'
import { getAiCapStatus } from '@/lib/usage-caps'
import { AGENT_MODEL } from '@/lib/agent/auto-reply'
import { logWarn } from '../log'

const TIMEOUT_MS = 8000

function systemPrompt(studios) {
  const lines = studios.map((s) => `- id ${s.id}: ${s.name}${s.label && s.label !== s.name ? ` (also "${s.label}")` : ''}${s.keywords.length ? `; also known as: ${s.keywords.join(', ')}` : ''}`)
  return [
    'You route a WhatsApp message from a new customer of a gym group to the studio it is about.',
    'Studios:',
    ...lines,
    'Answer with the id of the studio the message is clearly about, and confident true, only when the message names or unmistakably points to that studio (its name, nickname, street or area).',
    'If it names none, names more than one, or you are guessing, answer studio "none" and confident false.',
  ].join('\n')
}

export async function classifyStudio({ text, studios, locationId }) {
  const msg = String(text || '').trim()
  if (!msg) return { studioId: null, reason: 'empty' }
  const cap = await getAiCapStatus({ locationId })
  if (cap?.capped) return { studioId: null, reason: 'capped' }
  const ids = studios.map((s) => s.id)
  const body = {
    model: AGENT_MODEL,
    max_tokens: 1024,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'low',
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: { studio: { type: 'string', enum: [...ids, 'none'] }, confident: { type: 'boolean' } },
          required: ['studio', 'confident'],
          additionalProperties: false,
        },
      },
    },
    system: systemPrompt(studios),
    messages: [{ role: 'user', content: msg.slice(0, 2000) }],
  }
  let out
  try {
    out = await anthropicMessages(body, { locationId, source: 'wa_studio_pick', signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (e) {
    logWarn('wa-studio-pick', 'classifier call failed', { locationId, err: e?.message || String(e) })
    return { studioId: null, reason: 'call_failed' }
  }
  if (!out?.res?.ok || !out.data) return { studioId: null, reason: 'call_failed' }
  if (out.data.stop_reason === 'refusal') return { studioId: null, reason: 'refused' }
  const textBlock = (out.data.content || []).find((b) => b.type === 'text')
  let parsed
  try { parsed = JSON.parse(textBlock?.text || '') } catch { return { studioId: null, reason: 'unparseable' } }
  if (parsed?.confident === true && ids.includes(parsed.studio)) return { studioId: parsed.studio, reason: 'decided' }
  return { studioId: null, reason: 'unsure' }
}
```
(If importing `AGENT_MODEL` from `auto-reply.js` pulls a heavy module graph into tests, mock `@/lib/agent/auto-reply` in the test with `{ AGENT_MODEL: 'claude-sonnet-5' }`; do not duplicate the model string.)

- [ ] **Step 4: Run** `npx vitest run src/lib/wa-studio-pick && npm run check:select-columns && npm run check:guardrails` → PASS.
- [ ] **Step 5: Commit** `WASTUDIOPICK.1 — ad, reply and tap signals; one-message studio classifier`

---

### Task 4: The resolver (orchestrator, picker send, record, move)

**Files:**
- Create: `src/lib/wa-studio-pick/resolve.js`, `src/lib/wa-studio-pick/resolve.test.js`
- Modify: `tests/whatsapp-config-callers.test.js` (new row)

**Interfaces:**
- Consumes: Task 2 `readPickerConfig`, `PICKER_ID_PREFIX`; Task 3 `adSignal`, `replySignal`, `tapSignal`, `classifyStudio`; `sendInteractiveOptions` (`@/lib/whatsapp`); `AGENT_MESSAGE_SOURCE`, `stripEmDashes` (`@/lib/agent/core`); RPC `move_whatsapp_conversation(p_conversation_id, p_target_location_id)`.
- Produces: `resolveNewSenderStudio(db, ctx) → Promise<{ action: 'skip'|'decided'|'asked'|'unresolved', locationId: string, conversationId: string }>` with `ctx = { conversationId, threadLocationId, receivingLocationId, contactId, resolution, message, messageType, body, senderPhone }`. Never throws.

- [ ] **Step 1: Failing tests** (`resolve.test.js`; mock `./config` `readPickerConfig`, `./signals`, `./classify`, `@/lib/whatsapp` `sendInteractiveOptions`; a recording fake db with `rpc` and `from('whatsapp_conversations').update(...).eq('id', …)` and `from('whatsapp_messages').insert(...)`):

```js
const CFG = { enabled: true, question: 'Which studio?', studios: [{ id: 'a1', label: 'Stillorgan' }, { id: 'a2', label: 'Hatch Street' }] }
const base = { conversationId: 'c1', threadLocationId: 'a1', receivingLocationId: 'a1', contactId: null, resolution: null, messageType: 'text', body: 'hi', senderPhone: '353000000000', message: { type: 'text', text: { body: 'hi' } } }

it('skips a known contact, a thread at another studio, a final resolution, picker off, one listed studio', async () => {
  for (const ctx of [{ contactId: 'k1' }, { threadLocationId: 'a2' }, { resolution: { status: 'decided' } }, { resolution: { status: 'unresolved' } }]) {
    expect((await resolveNewSenderStudio(db, { ...base, ...ctx })).action).toBe('skip')
  }
  readPickerConfig.mockResolvedValueOnce({ ...CFG, enabled: false })
  expect((await resolveNewSenderStudio(db, base)).action).toBe('skip')
  readPickerConfig.mockResolvedValueOnce({ ...CFG, studios: [CFG.studios[0]] })
  expect((await resolveNewSenderStudio(db, base)).action).toBe('skip')
  readPickerConfig.mockResolvedValueOnce(null)
  expect((await resolveNewSenderStudio(db, base)).action).toBe('skip')
  expect(sendInteractiveOptions).not.toHaveBeenCalled()
})

it('ad decides first: moves to Hatch and records by:ad, no classifier, no picker', async () => {
  adSignal.mockResolvedValueOnce('a2')
  db.rpc.mockResolvedValueOnce({ data: { conversation_id: 'c1', merged: false }, error: null })
  const r = await resolveNewSenderStudio(db, { ...base, message: { ...base.message, referral: { source_type: 'ad', source_id: 'AD1' } } })
  expect(r).toEqual({ action: 'decided', locationId: 'a2', conversationId: 'c1' })
  expect(db.rpc).toHaveBeenCalledWith('move_whatsapp_conversation', { p_conversation_id: 'c1', p_target_location_id: 'a2' })
  expect(recorded()).toMatchObject({ status: 'decided', by: 'ad', location_id: 'a2' })
  expect(classifyStudio).not.toHaveBeenCalled()
})

it('a decision for the thread’s own studio records but does not move', async () => {
  classifyStudio.mockResolvedValueOnce({ studioId: 'a1', reason: 'decided' })
  const r = await resolveNewSenderStudio(db, base)
  expect(r).toEqual({ action: 'decided', locationId: 'a1', conversationId: 'c1' })
  expect(db.rpc).not.toHaveBeenCalled()
  expect(recorded()).toMatchObject({ status: 'decided', by: 'ai', location_id: 'a1' })
})

it('nothing decides → picker sent through the thread, logged, recorded asked', async () => {
  classifyStudio.mockResolvedValueOnce({ studioId: null, reason: 'unsure' })
  sendInteractiveOptions.mockResolvedValueOnce({ messageId: 'wamid.P' })
  const r = await resolveNewSenderStudio(db, base)
  expect(r.action).toBe('asked')
  expect(sendInteractiveOptions).toHaveBeenCalledWith('353000000000', 'Which studio?',
    [{ id: 'studio:a1', title: 'Stillorgan' }, { id: 'studio:a2', title: 'Hatch Street' }],
    { locationId: 'a1', replyInConversation: 'c1' })
  expect(messageInsert()).toMatchObject({ conversation_id: 'c1', direction: 'outbound', message_type: 'interactive', body: 'Which studio?', wa_message_id: 'wamid.P', source: 'agent' })
  expect(recorded()).toMatchObject({ status: 'asked' })
})

it('picker send fails → unresolved ask_failed, carries on at the thread’s studio', async () => {
  classifyStudio.mockResolvedValueOnce({ studioId: null, reason: 'unsure' })
  sendInteractiveOptions.mockRejectedValueOnce(new Error('window closed'))
  expect((await resolveNewSenderStudio(db, base)).action).toBe('unresolved')
  expect(recorded()).toMatchObject({ status: 'unresolved', reason: 'ask_failed' })
})

it('asked + tap on a listed studio → by:picker; tap on an unknown id → treated as no answer (Review Focus 1)', async () => {
  const asked = { ...base, resolution: { status: 'asked' }, messageType: 'interactive', body: 'Hatch Street', message: { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'studio:a2' } } } }
  tapSignal.mockReturnValueOnce('a2')
  db.rpc.mockResolvedValueOnce({ data: { conversation_id: 'c1', merged: false }, error: null })
  expect((await resolveNewSenderStudio(db, asked)).action).toBe('decided')
  expect(recorded()).toMatchObject({ by: 'picker', location_id: 'a2' })
  tapSignal.mockReturnValueOnce(null)
  classifyStudio.mockResolvedValueOnce({ studioId: null, reason: 'unsure' })
  expect((await resolveNewSenderStudio(db, asked)).action).toBe('unresolved')
  expect(recorded()).toMatchObject({ status: 'unresolved', reason: 'no_answer' })
  expect(sendInteractiveOptions).not.toHaveBeenCalled()
})

it('asked + a typed reply a day later → classifier once, then final; never a second picker (Review Focus 2)', async () => {
  classifyStudio.mockResolvedValueOnce({ studioId: 'a2', reason: 'decided' })
  db.rpc.mockResolvedValueOnce({ data: { conversation_id: 'c1', merged: false }, error: null })
  const r = await resolveNewSenderStudio(db, { ...base, resolution: { status: 'asked' }, body: 'the hatch one' })
  expect(r.action).toBe('decided')
  expect(recorded()).toMatchObject({ by: 'ai' })
  expect(sendInteractiveOptions).not.toHaveBeenCalled()
})

it('a merge returns the target conversation id; a failed move records unresolved move_failed at the original studio', async () => {
  adSignal.mockResolvedValueOnce('a2')
  db.rpc.mockResolvedValueOnce({ data: { conversation_id: 'c9', merged: true }, error: null })
  expect(await resolveNewSenderStudio(db, base)).toEqual({ action: 'decided', locationId: 'a2', conversationId: 'c9' })
  adSignal.mockResolvedValueOnce('a2')
  db.rpc.mockResolvedValueOnce({ data: null, error: { code: '23505', message: 'dup' } })
  expect(await resolveNewSenderStudio(db, base)).toEqual({ action: 'unresolved', locationId: 'a1', conversationId: 'c1' })
  expect(recorded()).toMatchObject({ status: 'unresolved', reason: 'move_failed' })
})

it('request_welcome: no text → no classifier; ad or picker as usual', async () => {
  sendInteractiveOptions.mockResolvedValueOnce({ messageId: 'wamid.P' })
  const r = await resolveNewSenderStudio(db, { ...base, messageType: 'request_welcome', body: '[Opened the chat]', message: { type: 'request_welcome' } })
  expect(r.action).toBe('asked')
  expect(classifyStudio).not.toHaveBeenCalled()
})

it('never throws: an internal error → skip, logged', async () => {
  readPickerConfig.mockRejectedValueOnce(new Error('boom'))
  expect((await resolveNewSenderStudio(db, base)).action).toBe('skip')
})
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement** `resolve.js`:

```js
// WASTUDIOPICK.1 — decide an unknown WhatsApp sender's studio (spec R1-R7).
// Called once per inbound message by the webhook, after the message is stored
// and before Mia. Never throws: any failure is logged and the message carries
// on at the thread's studio, exactly as before this existed.
import { sendInteractiveOptions } from '@/lib/whatsapp'
import { AGENT_MESSAGE_SOURCE, stripEmDashes } from '@/lib/agent/core'
import { logWarn, logError } from '../log'
import { readPickerConfig, PICKER_ID_PREFIX } from './config'
import { adSignal, replySignal, tapSignal } from './signals'
import { classifyStudio } from './classify'

const FINAL = new Set(['decided', 'unresolved'])
const TEXT_TYPES = new Set(['text', 'interactive', 'image', 'video', 'document'])

async function record(db, conversationId, resolution) {
  const { error } = await db.from('whatsapp_conversations')
    .update({ studio_resolution: { ...resolution, at: new Date().toISOString() } }).eq('id', conversationId)
  if (error) logError('wa-studio-pick', 'studio_resolution write failed', { conversationId, err: error.message })
}

async function decide(db, ctx, studioId, by) {
  let { conversationId } = ctx
  let locationId = ctx.threadLocationId
  if (studioId !== ctx.threadLocationId) {
    const { data, error } = await db.rpc('move_whatsapp_conversation', { p_conversation_id: conversationId, p_target_location_id: studioId })
    if (error) {
      logError('wa-studio-pick', 'move failed; thread stays', { conversationId, studioId, err: error.message })
      await record(db, conversationId, { status: 'unresolved', reason: 'move_failed', by, location_id: studioId })
      return { action: 'unresolved', locationId, conversationId }
    }
    conversationId = data?.conversation_id || conversationId
    locationId = studioId
  }
  await record(db, conversationId, { status: 'decided', by, location_id: studioId })
  return { action: 'decided', locationId, conversationId }
}

async function ask(db, ctx, cfg) {
  const question = stripEmDashes(cfg.question)
  const options = cfg.studios.map((s) => ({ id: `${PICKER_ID_PREFIX}${s.id}`, title: s.label }))
  try {
    const sent = await sendInteractiveOptions(ctx.senderPhone, question, options,
      { locationId: ctx.threadLocationId, replyInConversation: ctx.conversationId })
    const { error } = await db.from('whatsapp_messages').insert({
      conversation_id: ctx.conversationId, contact_id: null, location_id: ctx.threadLocationId,
      wa_message_id: sent?.messageId || null, direction: 'outbound', message_type: 'interactive',
      body: question, status: 'sent', source: AGENT_MESSAGE_SOURCE, sent_at: new Date().toISOString(),
    })
    if (error) logError('wa-studio-pick', 'picker sent but not logged', { conversationId: ctx.conversationId, err: error.message })
    await record(db, ctx.conversationId, { status: 'asked' })
    return { action: 'asked', locationId: ctx.threadLocationId, conversationId: ctx.conversationId }
  } catch (e) {
    logWarn('wa-studio-pick', 'picker send failed; carrying on', { conversationId: ctx.conversationId, err: e?.message || String(e) })
    await record(db, ctx.conversationId, { status: 'unresolved', reason: 'ask_failed' })
    return { action: 'unresolved', locationId: ctx.threadLocationId, conversationId: ctx.conversationId }
  }
}

export async function resolveNewSenderStudio(db, ctx) {
  const skip = { action: 'skip', locationId: ctx.threadLocationId, conversationId: ctx.conversationId }
  try {
    if (ctx.contactId || ctx.threadLocationId !== ctx.receivingLocationId) return skip
    const status = ctx.resolution?.status || null
    if (status && FINAL.has(status)) return skip
    const cfg = await readPickerConfig(db, ctx.receivingLocationId)
    if (!cfg?.enabled || cfg.studios.length < 2) return skip
    const ids = cfg.studios.map((s) => s.id)
    const hasText = TEXT_TYPES.has(ctx.messageType) && String(ctx.body || '').trim() && !String(ctx.body).startsWith('[')

    if (status === 'asked') {
      const tapped = tapSignal(ctx.message, ids)
      if (tapped) return decide(db, ctx, tapped, 'picker')
      if (hasText) {
        const c = await classifyStudio({ text: ctx.body, studios: cfg.studios, locationId: ctx.receivingLocationId })
        if (c.studioId) return decide(db, ctx, c.studioId, 'ai')
      }
      await record(db, ctx.conversationId, { status: 'unresolved', reason: 'no_answer' })
      return { action: 'unresolved', locationId: ctx.threadLocationId, conversationId: ctx.conversationId }
    }

    const fromAd = await adSignal(db, ctx.message?.referral, ids)
    if (fromAd) return decide(db, ctx, fromAd, 'ad')
    const fromReply = await replySignal(db, ctx.message?.context?.id, ids)
    if (fromReply) return decide(db, ctx, fromReply, 'reply')
    if (hasText) {
      const c = await classifyStudio({ text: ctx.body, studios: cfg.studios, locationId: ctx.receivingLocationId })
      if (c.studioId) return decide(db, ctx, c.studioId, 'ai')
    }
    return ask(db, ctx, cfg)
  } catch (e) {
    logError('wa-studio-pick', 'resolver failed; carrying on', { conversationId: ctx.conversationId, err: e?.message || String(e) })
    return skip
  }
}
```

- [ ] **Step 4: Callers table** — add a row:
```js
  'src/lib/wa-studio-pick/resolve.js': {
    calls: { sendInteractiveOptions: 1 },
    decision: 'refuse-quiet',
    why: 'WASTUDIOPICK.1 studio picker, sent through the thread (replyInConversation); a refusal or send failure is caught, recorded unresolved (ask_failed) and the message carries on at the thread’s studio. resolve.test.js.',
  },
```

- [ ] **Step 5: Run** `npx vitest run src/lib/wa-studio-pick tests/whatsapp-config-callers.test.js && npm run check:rpc-names && npm run check:guardrails && npm run check:select-columns` → PASS.
- [ ] **Step 6: Commit** `WASTUDIOPICK.1 — resolver: signals in order, picker once, record, move`

---

### Task 5: Webhook integration

**Files:**
- Modify: `src/app/api/webhooks/whatsapp/route.js` (thread lookup select ~l.355; after the inbound message insert and before the consent block ~l.600; Mia call ~l.643; welcome ~l.710)
- Create: `src/app/api/webhooks/whatsapp/route.studio-pick.test.js` (copy the harness — mocks, `makeDb`, `reqFor`, `envelope` — from `route.reply-number.test.js`, and add `vi.mock('@/lib/wa-studio-pick/resolve', () => ({ resolveNewSenderStudio: vi.fn(async (db, ctx) => ({ action: 'skip', locationId: ctx.threadLocationId, conversationId: ctx.conversationId })) }))`)

**Interfaces:**
- Consumes: `resolveNewSenderStudio` (Task 4).

- [ ] **Step 1: Failing tests**

```js
it('an unknown sender’s message calls the resolver with the thread, the receiving studio and the raw message', async () => {
  resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
  await POST(reqFor(inboundText(REGISTERED_PNI)))
  expect(resolveNewSenderStudio).toHaveBeenCalledWith(db, expect.objectContaining({
    conversationId: 'conv-1', threadLocationId: 'loc-still', receivingLocationId: 'loc-still', contactId: null,
    resolution: null, messageType: 'text', body: 'hi', senderPhone: '353871234567',
    message: expect.objectContaining({ id: 'wamid.test1' }),
  }))
})

it('asked → Mia is NOT called, the push still goes', async () => {
  resolveNewSenderStudio.mockResolvedValueOnce({ action: 'asked', locationId: 'loc-still', conversationId: 'conv-1' })
  resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
  await POST(reqFor(inboundText(REGISTERED_PNI)))
  expect(maybeAutoReply).not.toHaveBeenCalled()
})

it('decided → Mia runs at the NEW studio and conversation', async () => {
  resolveNewSenderStudio.mockResolvedValueOnce({ action: 'decided', locationId: 'loc-hatch', conversationId: 'conv-9' })
  resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
  await POST(reqFor(inboundText(REGISTERED_PNI)))
  expect(maybeAutoReply).toHaveBeenCalledWith(db, expect.objectContaining({ locationId: 'loc-hatch', conversationId: 'conv-9' }))
})

it('an existing thread’s studio_resolution is passed through (Review Focus 3: a staff-moved thread carries decided/staff)', async () => {
  // whatsapp_conversations single() returns { id: 'conv-old', contact_id: null, ctwa_clid: null, studio_resolution: { status: 'decided', by: 'staff' } }
  // assert resolveNewSenderStudio called with resolution: { status: 'decided', by: 'staff' }
})

it('request_welcome + asked → no greeting; + skip → greeting as today (Review Focus 5)', async () => {
  // envelope with messages: [{ id: 'wamid.w', from: '353871234567', type: 'request_welcome' }]
  // resolver → asked: maybeSendWelcomeGreeting not called; resolver → skip: called once
})

it('a resolver that throws is logged and the message carries on (200, Mia runs)', async () => {
  resolveNewSenderStudio.mockRejectedValueOnce(new Error('boom'))
  resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
  const res = await POST(reqFor(inboundText(REGISTERED_PNI)))
  expect(res.status).toBe(200)
  expect(maybeAutoReply).toHaveBeenCalled()
})
```
(Write the two sketched tests fully, in the same style, using the harness's `makeDb` handler for `whatsapp_conversations` and an envelope built with `envelope({...})`.)

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement** in `route.js`:
1. Import: `import { resolveNewSenderStudio } from '@/lib/wa-studio-pick/resolve'`.
2. The thread lookup `.select('id, contact_id, ctwa_clid')` → `.select('id, contact_id, ctwa_clid, studio_resolution')`; also add `studio_resolution` to the select inside `findMovedNumberlessThread` if it selects named columns (check; keep its other columns).
3. Right after the inbound `whatsapp_messages` insert block (before the consent-keyword block), add:
```js
  // WASTUDIOPICK.1 — an unknown sender on a studio-picker number: decide their
  // studio (ad → reply → classifier → tap picker) and move the thread before
  // anything else acts on it. While the picker waits for an answer, Mia and the
  // greeting stay quiet (spec R7). Never throws; a failure carries on as before.
  let studioPick = { action: 'skip' }
  if (!inboundInsertError) {
    try {
      studioPick = await resolveNewSenderStudio(db, {
        conversationId,
        threadLocationId: locationId,
        receivingLocationId: defaultLocationId,
        contactId: contact?.id || null,
        resolution: existingConv?.studio_resolution ?? null,
        message,
        messageType,
        body,
        senderPhone,
      })
    } catch (e) {
      console.error('[wa-webhook] studio picker failed (carrying on):', e?.message || String(e))
    }
    if (studioPick?.locationId) locationId = studioPick.locationId
    if (studioPick?.conversationId) conversationId = studioPick.conversationId
  }
  const awaitingStudio = studioPick?.action === 'asked'
```
   (`locationId` is already `let` from Phase 1; make `conversationId` assignable if it is `const`. `existingConv` must be in scope here; if it is block-scoped, hoist the `studio_resolution` value into a `let threadResolution` next to `conversationId`.)
4. Mia: `if (messageType !== 'request_welcome' && !inboundInsertError && !awaitingStudio) {`
5. Welcome: `if (messageType === 'request_welcome' && !awaitingStudio) {`

- [ ] **Step 4: Run** `npx vitest run src/app/api/webhooks/whatsapp tests/whatsapp-config-callers.test.js && npm run check:guardrails && npm run check:select-columns` → PASS.
- [ ] **Step 5: Commit** `WASTUDIOPICK.1 — webhook: resolve a new sender's studio before Mia; Mia waits while asked`

---

### Task 6: Settings route + "Studio picker" card

**Files:**
- Create: `src/app/api/whatsapp/studio-picker/route.js`, `src/app/api/whatsapp/studio-picker/route.test.js`
- Modify: `src/components/settings/integrations/WhatsAppIntegrationTab.jsx` (new `StudioPickerCard`, rendered after `ChatOpenersCard`), `src/lib/openapi.js`

**Interfaces:**
- Consumes: Task 2 constants (`LABEL_MAX`, `QUESTION_MAX`, `KEYWORDS_MAX`, `KEYWORD_LEN_MAX`, `DEFAULT_PICKER_QUESTION`).
- Produces: `GET /api/whatsapp/studio-picker?location_id=` → `{ success, data: { listed, label, keywords, enabled, question, has_number, default_question } }` (membership 404); `PUT` body `{ location_id, listed, label, keywords, enabled?, question? }` → `{ success, data }` (master/owner at the studio via `guardMasterOrOwner`, else 403; `enabled`/`question` accepted only when the studio has an active `whatsapp_numbers` row, else 400 `'This studio has no WhatsApp number, so it cannot ask the question.'`).

- [ ] **Step 1: Failing route tests** (mock `@/lib/auth` `getCurrentUser`, `assertLocationAccessOr404`, `guardMasterOrOwner`; `@/lib/supabase`; `@/lib/location-settings` `mergeLocationSettings`):
```js
it('GET returns the studio’s picker settings with defaults and has_number', async () => { /* settings {} + an active number → { listed:false, label:'', keywords:[], enabled:false, question:'', has_number:true, default_question: DEFAULT_PICKER_QUESTION } */ })
it('PUT saves listed/label/keywords through mergeLocationSettings under wa_studio_picker', async () => {
  // assert the mutate fn turns { other: 1 } into { other: 1, wa_studio_picker: { listed: true, label: 'Hatch Street', keywords: ['hatch'], enabled: false, question: '' } }
})
it('PUT validation: label > 20, question > 1024, 11 keywords, a keyword > 40 → 400', async () => {})
it('PUT enabled at a studio with no number → 400; not owner/master → 403 from guardMasterOrOwner; not a member → 404', async () => {})
it('a failed settings save → settingsSaveFailure response', async () => {})
```
(Write each body fully in the harness style of `src/app/api/whatsapp/card-sets/route.test.js` if it exists — find it with `ls src/app/api/whatsapp/card-sets`.)

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement the route**
```js
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404, guardMasterOrOwner } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { mergeLocationSettings, settingsSaveFailure } from '@/lib/location-settings'
import { LABEL_MAX, QUESTION_MAX, KEYWORDS_MAX, KEYWORD_LEN_MAX, DEFAULT_PICKER_QUESTION } from '@/lib/wa-studio-pick/config'

// WASTUDIOPICK.1 — the WhatsApp studio picker settings for one studio
// (locations.settings.wa_studio_picker; spec R8). GET: membership. PUT: master
// or owner AT the studio (WAROLE.1, as the card sets on the same tab).
// Registered in src/lib/openapi.js.
const PutSchema = z.object({
  location_id: uuidLike,
  listed: z.boolean(),
  label: z.string().trim().max(LABEL_MAX).default(''),
  keywords: z.array(z.string().trim().min(1).max(KEYWORD_LEN_MAX)).max(KEYWORDS_MAX).default([]),
  enabled: z.boolean().optional(),
  question: z.string().trim().max(QUESTION_MAX).optional(),
})

async function hasNumber(db, locationId) {
  const { data, error } = await db.from('whatsapp_numbers').select('id').eq('location_id', locationId).eq('is_active', true).limit(1)
  if (error) throw error
  return (data || []).length > 0
}

const view = (p, has) => ({
  listed: p.listed === true, label: p.label || '', keywords: Array.isArray(p.keywords) ? p.keywords : [],
  enabled: p.enabled === true, question: p.question || '', has_number: has, default_question: DEFAULT_PICKER_QUESTION,
})

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const locationId = new URL(request.url).searchParams.get('location_id')
  if (!locationId) return NextResponse.json({ success: false, error: 'location_id is required' }, { status: 400 })
  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return guard
  const db = createServerClient()
  const { data: loc, error } = await db.from('locations').select('settings').eq('id', locationId).maybeSingle()
  if (error) return NextResponse.json({ success: false, error: 'Could not load the settings.' }, { status: 500 })
  if (!loc) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  let has
  try { has = await hasNumber(db, locationId) } catch { return NextResponse.json({ success: false, error: 'Could not load the settings.' }, { status: 500 }) }
  return NextResponse.json({ success: true, data: view(loc.settings?.wa_studio_picker || {}, has) })
}

export async function PUT(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const v = await validateBody(request, PutSchema)
  if (!v.ok) return v.response
  const { location_id: locationId, listed, label, keywords, enabled, question } = v.data
  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return guard
  const roleGuard = guardMasterOrOwner(user, locationId)
  if (roleGuard) return roleGuard
  const db = createServerClient()
  let has
  try { has = await hasNumber(db, locationId) } catch { return NextResponse.json({ success: false, error: 'Could not save the settings.' }, { status: 500 }) }
  if ((enabled === true || (question && question.length)) && !has) {
    return NextResponse.json({ success: false, error: 'This studio has no WhatsApp number, so it cannot ask the question.' }, { status: 400 })
  }
  const next = { listed, label, keywords, enabled: has ? enabled === true : false, question: has ? (question || '') : '' }
  const saved = await mergeLocationSettings(db, locationId, (s) => ({ ...s, wa_studio_picker: next }), { scope: 'wa-studio-picker' })
  if (!saved.ok) return settingsSaveFailure(saved)
  return NextResponse.json({ success: true, data: view(next, has) })
}
```
Register both methods in `src/lib/openapi.js` next to the card-sets registration (tags `['WhatsApp']`, `CookieAuth`, responses 200/400/403/404/500 as above).

- [ ] **Step 4: Card** — in `WhatsAppIntegrationTab.jsx` add `StudioPickerCard({ location, canEdit })` following `ChatOpenersCard`'s structure and classes exactly: on mount `GET /api/whatsapp/studio-picker?location_id=…`; fields: checkbox "Show this studio in the WhatsApp studio picker" (`listed`), input "Button label (20 characters)" (`maxLength={20}`, placeholder = `location.name`), input "Keywords that point to this studio (comma separated, optional)"; when `has_number`: checkbox "Ask new senders which studio they mean" (`enabled`) and textarea "Question" (`maxLength={1024}`, placeholder = `default_question`). Explanatory `<p className="text-xs text-un1t-subtle">`: "When someone we don't know messages this number, we work out which studio they mean from the ad they came from or their message. If it isn't clear, they get one question with a button for each studio shown here." Save button `type="button"` → `PUT`. Render `<StudioPickerCard location={location} canEdit={canEdit} />` after `<ChatOpenersCard … />`. Add a test to `WhatsAppIntegrationTab.test.jsx`: the card loads, hides the question when `has_number` is false, and saves the PUT body (fake clock rules from CLAUDE.md apply; prefer no fake timers).

- [ ] **Step 5: Run** `npx vitest run src/app/api/whatsapp/studio-picker src/components/settings && npm run check:route-guards && npm run check:location-scoping && npm run check:guardrails && npm run lint` → PASS.
- [ ] **Step 6: Commit** `WASTUDIOPICK.1 — studio picker settings route and card`

---

### Task 7: Move route records `by: staff` + inbox note

**Files:**
- Modify: `src/app/api/whatsapp/conversations/[id]/move/route.js` (after a successful RPC), its `route.test.js`
- Modify: `src/components/WAInbox.jsx` (thread header, near the ⋯ menu), `src/components/WAInbox.move.test.jsx` or a new `WAInbox.studio-note.test.jsx`

**Interfaces:**
- Consumes: `studio_resolution` (Task 1).

- [ ] **Step 1: Failing tests**
- Move route: after a 200 move, `whatsapp_conversations.update({ studio_resolution: { status: 'decided', by: 'staff', location_id: <target>, at: <ISO> } }).eq('id', <returned conversation_id>)` is called; a failed write is logged and the response is still 200.
- Inbox: a selected conversation with `studio_resolution: { status: 'decided', by: 'ai' }` renders the text `Filed by: AI`; `{ by: 'picker' }` → `Filed by: picker`; `{ by: 'ad' }` → `Filed by: ad`; `{ by: 'reply' }` → `Filed by: reply`; `{ by: 'staff' }` → `Filed by: staff`; `{ status: 'asked' }` → `Asked which studio`; `null` or `unresolved` → nothing.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**
Move route, after the RPC success branch and before the response:
```js
  // WASTUDIOPICK.1 — a staff move settles the studio for good (spec R6).
  const movedId = data?.conversation_id || conversation.id
  const { error: recErr } = await db.from('whatsapp_conversations')
    .update({ studio_resolution: { status: 'decided', by: 'staff', location_id: target, at: new Date().toISOString() } })
    .eq('id', movedId)
  if (recErr) logError('wa-move', 'studio_resolution write failed', { conversationId: movedId, err: recErr.message })
```
Inbox (pure helper at module scope + a small span in the header):
```js
// WASTUDIOPICK.1 — how this thread's studio was decided (spec R9).
const FILED_BY_LABEL = { ad: 'ad', reply: 'reply', ai: 'AI', picker: 'picker', staff: 'staff' }
export function studioNote(resolution) {
  if (resolution?.status === 'asked') return 'Asked which studio'
  if (resolution?.status === 'decided' && FILED_BY_LABEL[resolution.by]) return `Filed by: ${FILED_BY_LABEL[resolution.by]}`
  return null
}
```
Render `{studioNote(conversation?.studio_resolution) && <span className="text-[11px] text-un1t-subtle">{studioNote(conversation.studio_resolution)}</span>}` beside the contact name in the thread header. (The conversations list API already selects `*`, so the column arrives.)

- [ ] **Step 4: Run** `npx vitest run 'src/app/api/whatsapp/conversations/[id]/move' src/components && npm run lint && npm run check:guardrails` → PASS.
- [ ] **Step 5: Commit** `WASTUDIOPICK.1 — staff moves record the decision; inbox shows how a thread was filed`

---

### Task 8: CI mirror, build, PR

- [ ] **Step 1:** Run each CI-mirror command separately (the thirteen in CLAUDE.md) and `npm run build`. Fix only what this branch caused; report anything pre-existing.
- [ ] **Step 2 (controller, after the final review):** push, `gh pr create` (title `WASTUDIOPICK.1 — which studio a new WhatsApp sender belongs to`, body: what/how, rollout = mig 725 before merge, everything off until settings are set, known limits from spec §4, and the note that the spawned quick-reply-tap task also edits `src/app/api/webhooks/whatsapp/route.js` — merge order may need a rebase), then `docs/changelog/entries/<PR>.md`.

### Task 9: Rollout (Richard's go-ahead before step 1 and before merge)

- [ ] Apply mig 725 via MCP; `get_advisors` security.
- [ ] Richard merges; wait for the production deploy READY.
- [ ] Verify: `select count(*) from whatsapp_conversations where studio_resolution is not null` = 0 (nothing switched on); settings card renders for Stillorgan (with the question) and Hatch (without).
- [ ] When Richard switches it on: one test from a phone that is not a contact (e.g. a staff member's personal number not in contacts) → picker arrives from +353 1 578 9401; tapping Hatch Street moves the thread to the Hatch inbox with "Filed by: picker".
