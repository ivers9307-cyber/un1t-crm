# WhatsApp Drip Broadcast — Design Spec

**Date:** 2026-06-10
**Status:** Approved design (brainstorming) → spec review → implementation plan
**Owner:** Richard Ivers
**Ticket prefix:** `WA-DRIP`

---

## Goal

Let an operator send a WhatsApp broadcast to a **filtered set of leads** that delivers up to a **configurable number of messages per rolling 24 hours (default 500)**, only during a **daytime window (default 09:00–20:00 Europe/Dublin)**, automatically **resuming day after day until every eligible contact has been messaged once**.

## Why — the problem and the hard constraints

Today's WhatsApp broadcast (`src/lib/whatsapp.js` → `sendBroadcast(broadcastId)`) loops the **entire** filtered audience in one synchronous pass (≈50 msgs/sec). There is no daily cap and no cron-driven resume. That's fine for a handful of recipients and dangerous for a large lead list, because WhatsApp imposes:

- **Messaging tier limits.** Every business number can message only N *unique* users per rolling 24h (250 → 1K → 10K → 100K → unlimited). A **newly connected number starts at the bottom (~1K/24h)** and only ramps as quality + volume prove out. Overflow is **rejected by Meta**, and over-sending tanks the **quality rating** → the number gets throttled/downgraded. A ≤500/day drip stays comfortably under a new number's tier-1 ceiling.
- **Opt-in is mandatory.** WhatsApp marketing to people who never opted in is a Meta policy violation and the fastest route to a banned number. The audience is therefore gated to `contact_preferences.whatsapp_marketing = true` (already enforced by `buildWhatsAppAudience`). **Cold leads who never opted into WhatsApp are not eligible** — capturing opt-in is a separate upstream job.
- **Templates required outside the 24h window.** Broadcasting to leads who haven't messaged us first requires an **APPROVED MARKETING template** (already how broadcasts work).

A paced, daily-capped, daytime-only drip is the correct shape for working through a large lead list without burning the number.

## Locked decisions (from brainstorming, 2026-06-10)

1. **Daily cap is per-broadcast**, set by the operator at creation time, **default 500**. Not auto-tier-aware in v1 (operator raises it as their tier grows).
2. **Daytime-only send window**, configurable, **default 09:00–20:00 Europe/Dublin**. The drip pauses overnight and resumes in the morning.
3. **24h accounting is a rolling window** (matches Meta's tier semantics), not a calendar-day reset.
4. **Reuse the proven SMS chunked-resumable engine pattern**; add a new WhatsApp cron. ~80% of this is reuse.

## Architecture

**Extend `whatsapp_broadcasts` + add a `run-whatsapp-broadcasts` cron** — a near-exact port of `src/lib/sms.js → sendBroadcast({maxRecipients})` + the `run-sms-broadcasts` cron, plus a daily cap and a send-window gate.

**Rejected alternatives:**
- *Model as a sequence* — `sequences.js` runs per-contact state machines with no cohort-level "N/day across the whole list" cap. Wrong primitive.
- *Generic cross-channel throttled scheduler* — YAGNI. WhatsApp is the need; the columns/engine below are shaped so SMS/email or tier-aware pacing can be generalised later without rework.

## Data model (one migration)

Add to **`whatsapp_broadcasts`**:

| Column | Type | Default | Notes |
|---|---|---|---|
| `delivery_mode` | `text` | `'blast'` | `'blast'` = today's all-at-once \| `'drip'` = new paced mode. CHECK in (`blast`,`drip`). |
| `daily_cap` | `int` | `500` | Max sends per rolling 24h. Only meaningful for `drip`. CHECK > 0. |
| `send_window_start` | `time` | `'09:00'` | Local time-of-day the drip may start sending. |
| `send_window_end` | `time` | `'20:00'` | Local time-of-day the drip stops. |
| `send_window_tz` | `text` | `'Europe/Dublin'` | IANA tz for the window. |
| `paused_at` | `timestamptz` | `null` | Set when auto-paused (consecutive failures) or operator-paused. |

`whatsapp_broadcast_recipients` is **unchanged** — it already has `sent_at` (the rolling-24h count source) + a unique `(broadcast_id, contact_id)` constraint (the dedup/resume key). Confirm that unique constraint exists; add it in the migration if missing.

Status enum is reused: a drip broadcast sits in `'sending'` while in flight and flips to `'sent'` when the audience is exhausted.

## Engine — `src/lib/whatsapp.js`

New `sendDripChunk(db, broadcastId)` (or extend `sendBroadcast` with a `{ drip: true }` path), mirroring the SMS resume engine:

1. Load broadcast + template; bail unless template is `APPROVED`.
2. **Rolling-24h headroom:** `sent_last_24h = count(whatsapp_broadcast_recipients WHERE broadcast_id = :id AND status='sent' AND sent_at > now() - interval '24 hours')`. `headroom = max(0, daily_cap - sent_last_24h)`. If `headroom == 0` → return (no capacity this tick).
3. **Select the next eligible contacts**, capped at `min(headroom, PER_TICK_MAX)` (PER_TICK_MAX ≈ 100, a tunable constant so the daily allowance drains over a few ticks each morning rather than one 500-burst):
   - Eligible = `buildWhatsAppAudience(filter, locationId)` (consent + opt-out + has wa_phone) **minus contacts already in `whatsapp_broadcast_recipients` for this broadcast**.
   - ⚠️ **Use a server-side anti-join (an RPC: `whatsapp_drip_next_recipients(broadcast_id, limit)` doing `NOT EXISTS` against the recipients table)** — NOT a client-side `.not('id','in',(...))`. Once thousands are already-sent, a client-side NOT-IN blows past Cloudflare's URI limit (414) — the exact failure mode from the crossover-414 lesson. Order deterministically (e.g. `contacts.created_at, contacts.id`).
4. For each selected contact: `sendTemplateMessage(...)` → insert `whatsapp_broadcast_recipients` (`status='sent'`/`'failed'`) + `whatsapp_messages` row, exactly as the current `sendBroadcast` loop does. Keep the existing ~50/sec rate-limit delay. Idempotent at the recipient level (unique constraint) so cron retries never double-send.
5. **Exhaustion:** if the eligible-minus-sent set is empty → update broadcast `status='sent'`, `sent_at=now()`. Otherwise leave `'sending'`.
6. Recompute `total_recipients` (eligible count) + `total_sent`/`total_failed` from the recipients table.

`blast` mode keeps the existing all-at-once `sendBroadcast` behaviour untouched.

## Cron — `src/app/api/cron/run-whatsapp-broadcasts/route.js`

- Auth via `Authorization: Bearer ${CRON_SECRET}` (standard).
- Every **~15 min** (add to `vercel.json` `crons`). `export const maxDuration = 300`.
- Pull `whatsapp_broadcasts WHERE delivery_mode='drip' AND status='sending' AND paused_at IS NULL`.
- For each: **skip the tick if `now` is outside the send window** (`isWithinSendWindow(now, {start,end,tz})`) → the drip naturally sleeps overnight, resumes next morning. Otherwise call `sendDripChunk`.
- `stampHeartbeat('run-whatsapp-broadcasts')` on the success path; add the matching `cron_heartbeats` row in the migration (name, expected_interval_seconds=900, grace) so the health-check + sentinel pick it up automatically.

## Send-window helper — pure + unit-tested

`isWithinSendWindow(now: Date, { start: 'HH:MM', end: 'HH:MM', tz: string }): boolean` in `src/lib/whatsapp-drip.js` (or a `whatsapp` helper module). Converts `now` to `tz`, returns whether the local time-of-day is within `[start, end)`. **DST-safe** — follow the codebase's date lessons (don't mix local parse with UTC ISO). Unit-test across DST boundaries + tz.

## UI — extend the unified send surface

`/communications/send` (`UnifiedSendComposer.jsx`) already: pick audience (`AudienceBuilder`) → WhatsApp channel → pick template. **Add a "Pacing" section** for the WhatsApp channel:
- Radio: **Send now (blast)** | **Drip**.
- Drip reveals: **Daily limit** (number, default 500) + **Send window** (start/end time, default 09:00–20:00) + tz (default Europe/Dublin, likely fixed for now).
- On submit: create the `whatsapp_broadcasts` row with `delivery_mode='drip'`, `daily_cap`, window columns, `status='sending'`. The cron does the rest. (Blast path unchanged.)

**Broadcast detail page** (`/whatsapp/broadcasts/[id]` or the unified history detail): show `sent / total`, a simple **ETA** ("≈ ⌈remaining / daily_cap⌉ days left"), the live status, and **Pause / Resume** (sets/clears `paused_at`).

## Guardrails

- **Auto-pause** after K consecutive send failures within a tick (the SMS engine already does this) → set `paused_at`, surface on the detail page. Prevents a quality-collapse or token issue from draining the list into failures.
- **Consent + opt-out** enforced by `buildWhatsAppAudience` (`whatsapp_marketing=true`, `wa_status` not blocked/opted_out, has `wa_phone`).
- **MARKETING template required + APPROVED** (existing broadcast guard).
- Per-location WhatsApp config resolved once per tick (`getWhatsAppConfig`), as today.

## What we reuse (explicit)

`buildWhatsAppAudience`, `whatsapp_broadcasts` + `whatsapp_broadcast_recipients`, `sendTemplateMessage` + `buildTemplateComponents`, `getOrCreateConversation`, `UnifiedSendComposer` + `AudienceBuilder`, the cron + heartbeat + health-check infrastructure, and the SMS engine's resume/idempotency/auto-pause patterns.

## Out of scope (candidate v2)

- **Tier-aware auto-pacing** — read the number's live messaging tier + quality rating from Meta and auto-set the cap. The columns + engine are shaped so this slots in later (swap the fixed `daily_cap` read for a computed cap).
- **Smoothing across the whole window** (e.g. evenly spread 500 over 9am–8pm) rather than draining the daily allowance over the first few morning ticks.
- **Drip for SMS/email** — generalise the engine across channels.
- **Per-recipient personalisation beyond the existing template variable mapping.**

## Testing

- Pure helpers (no DB): `isWithinSendWindow` (in/out of range, DST boundary, multiple tz); rolling-headroom calc (`daily_cap − sent_24h`, clamped at 0); ETA calc.
- Engine: recipient-dedup idempotency (re-running a tick never double-sends), daily-cap respected across multiple ticks (sum of a day's sends ≤ daily_cap), exhaustion flips to `'sent'`.
- Mirror the existing `sms.js` broadcast tests for structure.

## Open questions (resolve during planning)

1. **PER_TICK_MAX** value (≈100?) and **cron interval** (15 min?) — tune so a 500/day cap drains over a sensible number of ticks each morning.
2. **Template disabled/paused mid-drip** (Meta can disable a template): auto-pause + surface, or skip-and-continue? (Lean: auto-pause — it's usually a quality signal.)
3. **Multiple concurrent drips on one number** sharing the same 24h tier budget — v1 likely treats each broadcast's `daily_cap` independently; note the risk that two concurrent drips could together exceed the number's tier. (Flag; probably acceptable for a single-number operator, revisit if it bites.)
