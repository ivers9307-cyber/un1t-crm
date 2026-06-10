# WhatsApp Template Status Webhook — Design Spec

**Date:** 2026-06-10
**Status:** Approved design (brainstorming) → spec review → implementation plan
**Owner:** Richard Ivers
**Ticket prefix:** `WA-TMPL`

---

## Goal

Keep `whatsapp_templates` **status, quality rating, and category fresh in real time** by consuming Meta's template webhooks (`message_template_status_update`, `message_template_quality_update`, `template_category_update`), notify managers when a template is approved/rejected/degraded, and live-update the templates page — instead of only learning a template's fate the next time someone opens the templates list.

## Why — the problem

Today a template's status only refreshes on a **poll**: `GET /api/whatsapp/templates` pulls Meta's template list and upserts `status` on `meta_template_id`. So a PENDING→APPROVED (or →REJECTED) flip lands in the CRM only when an operator happens to open the templates page. Worse, the WhatsApp webhook route (`src/app/api/webhooks/whatsapp/route.js`) already **receives** template events from Meta but drops them on the floor — its change loop hard-skips everything except `change.field === 'messages'` (`if (change.field !== 'messages') continue`).

Wiring the three template webhooks gives:
- **Real-time status** — operators waiting on a template approval get pinged the moment Meta decides, with the rejection reason if rejected.
- **Quality + category awareness** — a drop to RED (Meta auto-pauses such templates) or a MARKETING↔UTILITY re-categorisation surfaces immediately.
- **A sharper drip** — `sendDripChunk` (WA-DRIP) already auto-pauses any drip whose template isn't `APPROVED` at the next tick; a real-time REJECTED/PAUSED/DISABLED update makes that timely instead of poll-lagged.

## Prerequisite (Meta-side, one-time — not code)

In the Meta App dashboard → **WhatsApp → Configuration → Webhook fields**, subscribe **`message_template_status_update`**, **`message_template_quality_update`**, and **`template_category_update`** (same callback URL + `WHATSAPP_WEBHOOK_VERIFY_TOKEN` already in use). **No events arrive until these fields are ticked.** The HMAC verification + `runtime = 'nodejs'` already in the route cover these events (same signed envelope as messages).

## Verified webhook payloads

All three arrive under `entry[].changes[]` with `change.field` = the event name and `change.value` carrying `message_template_id` (number), `message_template_name`, `message_template_language`. Field names verified against Meta's webhook reference + corroborating BSP docs (2026-06):

| Event (`change.field`) | Key value fields | Enum values |
|---|---|---|
| `message_template_status_update` | **`event`**, `reason` | `event`: APPROVED, REJECTED, PENDING, PAUSED, DISABLED, IN_APPEAL, PENDING_DELETION, DELETED, LIMIT_EXCEEDED · `reason`: ABUSIVE_CONTENT, INVALID_FORMAT, PROMOTIONAL, TAG_CONTENT_MISMATCH, SCAM, NONE |
| `message_template_quality_update` | `previous_quality_score`, `new_quality_score` | GREEN, YELLOW, RED, UNKNOWN |
| `template_category_update` | `previous_category`, `new_category` | MARKETING, UTILITY, AUTHENTICATION |

⚠️ The status field is **`event`**, not `status`. The match key everywhere is `meta_template_id = String(value.message_template_id)`.

## Architecture

**Approach A — webhook push (chosen).** Extend the existing WA webhook route with three `change.field` branches → a tested lib helper that matches on `meta_template_id`, updates the row, and decides notification; manager push via existing infra; Realtime page update. The existing `GET`-poll stays as a natural reconciliation backstop (catches anything missed if the webhook is ever down).

**Rejected alternative — Approach B (cron poll):** a scheduled job periodically calls `getTemplates` and upserts. No Meta-side subscription, but not real-time, burns API calls, and misses transient events (a brief PAUSED). The webhook is the right primitive for "tell me the moment it changes"; the poll already exists as the backstop.

## Data model (one migration)

Add to **`whatsapp_templates`**:

| Column | Type | Notes |
|---|---|---|
| `quality_rating` | `text` (nullable) | GREEN / YELLOW / RED / UNKNOWN, from `new_quality_score`. |

`status`, `rejection_reason`, and `category` already exist and are reused. Also add `whatsapp_templates` to the `supabase_realtime` publication (`alter publication supabase_realtime add table public.whatsapp_templates`) so the templates page can subscribe. RLS is unchanged — the page already reads templates location-scoped; the migration adds no policy.

## Webhook handler — `src/app/api/webhooks/whatsapp/route.js`

Replace the `if (change.field !== 'messages') continue` skip with a dispatch:
- `change.field === 'messages'` → existing message/status handling (unchanged).
- `change.field ∈ { message_template_status_update, message_template_quality_update, template_category_update }` → `await handleTemplateEvent(db, change.field, change.value)` (best-effort; the route already swallows handler errors and always returns 200).

No change to signature verification, dedup-for-messages, or the GET verification handshake.

## Engine — `src/lib/whatsapp-template-events.js` (new, testable)

`applyTemplateEvent(db, field, value)`:
1. Match the row: `select * from whatsapp_templates where meta_template_id = String(value.message_template_id)` (single). **No match → no-op** (template created outside the CRM / different WABA).
2. Compute the column update by field:
   - `message_template_status_update` → `{ status: value.event, rejection_reason: value.reason && value.reason !== 'NONE' ? value.reason : null }`. (Statuses like PAUSED/DISABLED/DELETED are stored verbatim, not deleted — the row stays for history and is correctly excluded from sends since only `APPROVED` is sendable.)
   - `message_template_quality_update` → `{ quality_rating: value.new_quality_score }`.
   - `template_category_update` → `{ category: value.new_category }`.
3. **Idempotent + retry-safe:** if the row's current value already equals the new value, skip the update *and* the notification (Meta retries land as no-ops). Otherwise update the row.
4. Decide the notification via the pure policy helpers below; return `{ template, notify }` for the route to fire the push (best-effort, never blocks the 200).

**Pure, unit-tested policy helpers** (no IO):
- `statusNotification(event, reason, name, language)` → `{ notify, title, body } | null`
- `qualityNotification(prevScore, newScore, name, language)` → `{ notify, ... } | null`
- `categoryNotification(prevCategory, newCategory, name, language)` → `{ notify, ... } | null`

## Notification policy

Push to `MANAGER_ROLES` at the template's `location_id` via the existing `sendPushToRolesAtLocation`, **reusing the `whatsapp` push category** (rides the existing `notify_whatsapp` per-user opt-in — no new permission key, no mobile-parity change). Per-user gating is handled inside `sendPush`.

| Event → condition | Notify? | Example body |
|---|---|---|
| status = APPROVED | ✅ | "✅ Template 'welcome_offer' (en) approved" |
| status = REJECTED | ✅ (+reason) | "❌ 'welcome_offer' rejected — INVALID_FORMAT" |
| status = PAUSED / DISABLED / LIMIT_EXCEEDED | ✅ | "⏸ 'welcome_offer' paused by Meta" |
| status = PENDING / IN_APPEAL / PENDING_DELETION / DELETED | silent | (row updated, no push) |
| `new_quality_score` ∈ { YELLOW, RED } | ✅ | "⚠️ 'welcome_offer' quality dropped to RED — Meta may pause it" |
| `new_quality_score` ∈ { GREEN, UNKNOWN } | silent | (row updated, no push) |
| category changed | ✅ | "ℹ️ 'welcome_offer' re-categorised MARKETING → UTILITY" |

The "skip when unchanged" gate in step 3 means a Meta retry never double-notifies.

## Realtime page update

The templates list view (`/whatsapp/templates`) subscribes to `whatsapp_templates` changes filtered by the active location and refreshes the affected row on the event — mirroring how `WAInbox.jsx` subscribes to `whatsapp_conversations` / `whatsapp_messages`. An open page reflects an approval/rejection without a manual refresh. The exact list component + subscription wiring is pinned in the implementation plan.

## What we reuse (explicit)

The WA webhook route + HMAC verification, `meta_template_id` (already stored on create), `rejection_reason` + `category` columns, `sendPushToRolesAtLocation` + `MANAGER_ROLES` + the `notify_whatsapp` opt-in, the Supabase Realtime pattern from `WAInbox`, and the existing `GET`-poll as a reconciliation backstop.

## Testing

- **Pure (no DB):** the three notification-policy helpers — every `event`/score/category transition → notify-or-silent + message text; `reason === 'NONE'` → `rejection_reason` null; column mapping (`event`→`status`, `new_quality_score`→`quality_rating`, `new_category`→`category`).
- **Route wiring + push + Realtime:** verified manually (auth/Meta-gated), mirroring how the WA webhook is tested today. Manual check: send a real template for review (or edit one), confirm the row + page update on Meta's status change and a manager push fires.

## Out of scope (v2)

- Appeal / resubmit a rejected template from the CRM (today: operator does it in Meta Business Manager).
- Per-template status-change **history / audit trail** (this writes current state only).
- Surfacing `quality_rating` in the composer's template picker UI (the column lands now; displaying it is a small follow-up).
- Acting on category changes beyond storing them (e.g. auto-pausing a drip whose template silently became UTILITY) — flagged, not built.

## Open questions — resolved during brainstorming

1. **Notify on quality YELLOW too, or RED only?** → **YELLOW + RED** (early warning before Meta pauses).
2. **Dedicated `template` push category or reuse `whatsapp`?** → **reuse `whatsapp`** (avoids a new permission key + the mobile-parity reconciliation).
3. **Delete the row on a DELETED event?** → **No** — store `status = 'DELETED'`, preserve the row for history; only `APPROVED` is sendable so it's harmless.
