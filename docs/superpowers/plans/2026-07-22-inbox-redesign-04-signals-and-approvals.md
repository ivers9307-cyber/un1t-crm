# Inbox Redesign — Plan 4: Command-Centre Signals + Approval Restyle — Implementation Plan

**Goal:** Surface a **signals strip** (Churn · Arrears · Visits-30d + last-seen + latest note) in the inbox contact panel so staff can triage without leaving the inbox, and restyle the approval card's Mia accent to the brand token. **No migration** — every signal reads an existing column or existing safe helper.

**Spec:** §4.7 (signals strip + notes) + §4.8 (approval-card restyle).

**Grounding (verified 2026-07-22):**
- Route: `src/app/api/contacts/[id]/command-centre/route.js` — GET, `getCurrentUser` + `assertLocationAccess` (404 on miss), `createServerClient`. Base payload `{ success, contact (full `select('*')` row), activities, event_types }`. `?scope=drawer` additionally fetches `notes`.
- **Already in `contact`:** `total_attended_30d` (visits-30d), `last_attended_at` (last-seen), `glofox_membership_status`, attendance cols, `pipeline_stage_slug`, `tags`, `wa_status`.
- **Arrears (SAFE):** `loadContactArrears(db, contactId)` from `src/lib/churn-radar-data.js` → `{ arrearsCents, count }` (reads reconciled `glofox_invoices.status='PAST_DUE'`, retry-netted, **PENDING/awaiting-auth de-counted**). NEVER sum `glofox_invoices` raw.
- **Churn (pure):** `classifyContact(contact, ctx)` + `scoreMember(contact, nowMs)` from `src/lib/churn-radar.js`. The `overdue` branch needs `ctx.pastDueIds` (a Set), so compute arrears first. **Mirror `src/app/contacts/[id]/page.js:125–143` exactly** for the label (`Payment overdue` | `At risk · High` | `At risk · Medium` | `At risk` | null).
- **Notes:** `public.notes` (`content`, `created_at`, `contact_id`), latest = newest.
- Panel: `src/components/CommandCentre.jsx` — header chips L112–147; slot the signals strip after the chip row (after L146) before Tabs (L150); notes card as the last child of the Profile tab (after `ContactMarketingPreferencesCard`, ~L204). `timeAgo()` helper exists (L26–36).
- Approval card: `src/components/ApprovalActionCard.jsx` — status chips already `bg-<c>-500/10 text-<c>-700`. The Mia accent (eyebrow / "Mia suggests" pill) uses default `border-purple-500/40` → move to the brand `mia` token.
- **`mia` is a FLAT token (no `-500`/`-700` scale)** — use `text-mia`, `bg-mia/10`, `border-mia/40` (opacity modifiers work). Keep amber/green/blue/red status chips on the `-500/10 … -700` recipe.

**Invariants:** service-role route already gated (don't loosen); supabase-js builders are thenables (`try/catch`, not `.catch`); Tailwind classes literal; `next build` is the real gate.

---

### Task 1 — Signals in the command-centre route (backend, no migration)
**File:** `src/app/api/contacts/[id]/command-centre/route.js`

- [ ] After the contact is loaded + access-checked, in the BASE payload path (not just drawer), compute and return signals. Mirror `src/app/contacts/[id]/page.js:80–143`:
```js
import { loadContactArrears } from '@/lib/churn-radar-data'
import { classifyContact, scoreMember } from '@/lib/churn-radar'
// ...
const arrears = await loadContactArrears(db, params.id)      // { arrearsCents, count }
const ctx = arrears.count > 0 ? { pastDueIds: new Set([params.id]) } : {}
const churnClass = classifyContact(contact, ctx)
const scored = churnClass === 'active' ? scoreMember(contact, Date.now()) : null
// label mirrors page.js:
let churnLabel = null, churnTier = null
if (churnClass === 'overdue') churnLabel = 'Payment overdue'
else if (scored?.tier === 'high') { churnLabel = 'At risk · High'; churnTier = 'high' }
else if (scored?.tier === 'medium') { churnLabel = 'At risk · Medium'; churnTier = 'medium' }
else if (scored) { churnLabel = 'At risk'; churnTier = 'low' }
```
- [ ] Also fetch the latest note (base payload): `const { data: latestNotes } = await db.from('notes').select('content, created_at').eq('contact_id', params.id).order('created_at', { ascending: false }).limit(1)` (wrap in try/catch — best-effort; a missing table returns `{0,0}`-style, don't fail the whole route).
- [ ] Add to the response: `signals: { churnClass, churnLabel, churnTier, arrearsCents: arrears.arrearsCents, arrearsCount: arrears.count, visits30: contact.total_attended_30d ?? 0, lastAttendedAt: contact.last_attended_at ?? null }, latestNote: latestNotes?.[0] ?? null`.
- [ ] Verify `npm run build && npm run lint && npm run check:route-guards` (route still session-guarded). Commit `INBOX-REDESIGN.4.1 — signals (churn/arrears/visits/last-seen/note) in command-centre payload`.

### Task 2 — Signals strip + notes card in the panel (UI)
**File:** `src/components/CommandCentre.jsx`

- [ ] After the header chip row (~L146), render a 3-tile **signals strip** from `bundle.signals`:
  - **Churn** — label from `signals.churnLabel` (fallback "—" / "Low" when null-but-active); tone: `high`/overdue → `text-red-700`, `medium` → `text-amber-700`, else `text-emerald-700`/muted. Small stat-tile: uppercase mono-ish label "Churn" + the value.
  - **Arrears** — `€{(signals.arrearsCents/100).toFixed(0)}` (or `€0`); tone `text-amber-700` when `arrearsCount>0`, else muted. Label "Arrears".
  - **Visits 30d** — `signals.visits30`; muted. Label "Visits 30d".
  - Tiles: `bg-un1t-surface border border-un1t-border rounded-lg p-2` in a `grid grid-cols-3 gap-2`. Follow the chip-contrast convention for any coloured text.
  - Below the strip, a compact "seen {timeAgo(signals.lastAttendedAt)}" line (reuse `timeAgo`), muted; omit if null.
- [ ] **Notes card** as the last child of the Profile tab (after `ContactMarketingPreferencesCard`): if `bundle.latestNote`, show a small card with `latestNote.content` (line-clamped) + `timeAgo(latestNote.created_at)`; else nothing.
- [ ] Verify `npm run build && npm run lint && npm run check:guardrails`. Commit `INBOX-REDESIGN.4.2 — signals strip + notes card in contact panel`.

### Task 3 — Approval-card Mia accent → brand token (UI)
**File:** `src/components/ApprovalActionCard.jsx`

- [ ] Move the Mia accent to the brand token: the "Mia suggests" pill `border-purple-500/40` → `border-mia/40 text-mia`; if there's a Mia eyebrow/label, give it `text-mia`. Keep the amber/green/blue/red **status** chips exactly as-is (they're correct `-500/10 … -700`). Optionally add a small `Sparkles` + `MIA` eyebrow consistent with the thread's Mia author tag, but do not change any behaviour/handlers.
- [ ] Verify `npm run build && npm run lint && npm run check:guardrails`. Commit `INBOX-REDESIGN.4.3 — approval card Mia accent on brand token`.

---

## Deploy
Full CI mirror → PR → merge on green (no migration, no checkpoint). Post-merge: Vercel visual pass (signals strip + notes render; approval card violet accent).

## Known simplifications (out of scope, safe)
- Person-group merging (grouped-contact attendance swap) and durable churn-dismiss (`churn_radar_actions`) are omitted — fine for the ~99% ungrouped/non-dismissed case; the tile reflects the single contact row.

## Self-review vs spec §4.7/§4.8
- §4.7 signals (churn/arrears/visits/last-seen) + notes → Tasks 1–2, safe sources. ✓
- §4.8 approval-card restyle to `mia` → Task 3 (tokens only, behaviour unchanged). ✓
