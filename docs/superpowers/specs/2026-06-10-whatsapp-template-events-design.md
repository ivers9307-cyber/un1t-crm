# WhatsApp Template Lifecycle — Design Spec

**Date:** 2026-06-10
**Status:** Approved design (brainstorming) → spec review → implementation plan
**Owner:** Richard Ivers
**Ticket prefix:** `WA-TMPL`

---

## Goal

Make the CRM **react to Meta's template decisions in real time** and **act on them without leaving the app**:

- **A. Consume the template webhooks** (`message_template_status_update`, `message_template_quality_update`, `template_category_update`) → keep `status` / `rejection_reason` / `quality_rating` / `category` fresh, notify managers, live-update the templates page.
- **B. Status-change audit trail** — a per-template history of every transition (who/what/when, including the rejection reason).
- **C. Quality rating in the template pickers** — surface GREEN/YELLOW/RED where operators choose a template.
- **D. Edit & resubmit a rejected template** from the CRM (Meta API), plus an **appeal deep-link** to WhatsApp Manager (appeals are UI-only — see below).

A is the core (it's the original ask and unlocks the rest). B/C ride on A's events + column. D is the "act" half. The implementation plan sequences them **A → B → C → D**; each is independently shippable.

## Why — the problem

Today a template's fate only reaches the CRM on a **poll**: `GET /api/whatsapp/templates` pulls Meta's list and upserts `status` on `meta_template_id`, so a PENDING→APPROVED/REJECTED flip lands only when someone opens the templates page. And the WA webhook route (`src/app/api/webhooks/whatsapp/route.js`) already **receives** template events but drops them — its change loop hard-skips everything except `change.field === 'messages'` (`if (change.field !== 'messages') continue`). When a template is rejected, the operator has to go to Meta's WhatsApp Manager to do anything about it.

This sharpens the WA-DRIP work too: `sendDripChunk` auto-pauses any drip whose template isn't `APPROVED` at the next tick, so a real-time REJECTED/PAUSED update makes that timely instead of poll-lagged.

## Prerequisite (Meta-side, one-time — not code)

In the Meta App dashboard → **WhatsApp → Configuration → Webhook fields**, subscribe **`message_template_status_update`**, **`message_template_quality_update`**, **`template_category_update`** (same callback URL + verify token already in use). **No events arrive until these are ticked.** HMAC verification + `runtime='nodejs'` already in the route cover these events (same signed envelope as messages).

## Verified webhook payloads

All three arrive under `entry[].changes[]` with `change.field` = the event name and `change.value` carrying `message_template_id` (number), `message_template_name`, `message_template_language`. Verified against Meta's webhook reference (2026-06):

| Event (`change.field`) | Key `value` fields | Enum values |
|---|---|---|
| `message_template_status_update` | **`event`**, `reason` | `event`: APPROVED, REJECTED, PENDING, PAUSED, DISABLED, IN_APPEAL, PENDING_DELETION, DELETED, LIMIT_EXCEEDED · `reason`: ABUSIVE_CONTENT, INVALID_FORMAT, PROMOTIONAL, TAG_CONTENT_MISMATCH, SCAM, NONE |
| `message_template_quality_update` | `previous_quality_score`, `new_quality_score` | GREEN, YELLOW, RED, UNKNOWN |
| `template_category_update` | `previous_category`, `new_category` | MARKETING, UTILITY, AUTHENTICATION |

⚠️ The status field is **`event`**, not `status`. Match key everywhere: `meta_template_id = String(value.message_template_id)`.

## Meta API capabilities for edit / appeal (Part D)

Verified (2026-06): **editing a rejected or paused template is API-supported** — `POST /{whatsapp_message_template_id}` with updated `components` (and optionally `category`) resubmits it for review (status → IN_REVIEW/PENDING). **Approved templates cannot be edited** (that's a new version, out of scope). A **pure appeal** (dispute a rejection without changing content) is **UI-only — there is no programmatic appeal API** (done in WhatsApp Manager → Business Support → Request Review). So Part D = an in-CRM **edit & resubmit** action (real API call) plus an **"Appeal in WhatsApp Manager" deep-link** for the dispute path. The exact edit-endpoint body is pinned against Meta's current docs during implementation (the codebase's "read vendor docs for the version you've pinned" rule).

## Architecture

**Webhook push (chosen).** Extend the WA webhook route with three `change.field` branches → a tested lib helper matching on `meta_template_id`, updating the row + writing a history row + deciding notification; manager push via existing infra; Realtime page update. The existing `GET`-poll stays as a reconciliation backstop.

**Rejected alternative — cron poll:** periodically `getTemplates` + upsert. No Meta-side subscription, but not real-time, burns API calls, misses transient events. The webhook is the right primitive; the poll already exists as the backstop.

## Data model (one migration)

Add to **`whatsapp_templates`**: `quality_rating text` (GREEN/YELLOW/RED/UNKNOWN, from `new_quality_score`). `status`, `rejection_reason`, `category` already exist and are reused.

New table **`whatsapp_template_events`** (Part B audit trail):

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `template_id` | uuid → `whatsapp_templates(id)` | indexed |
| `location_id` | uuid | denormalised for RLS scoping (mirrors the codebase convention) |
| `kind` | text | `status` \| `quality` \| `category` |
| `from_value` | text (nullable) | previous (quality/category give it; status webhook doesn't, so null) |
| `to_value` | text | new event/score/category |
| `reason` | text (nullable) | rejection reason for status events |
| `created_at` | timestamptz default now() | |

RLS: location-scoped like the other child tables (read for staff at the location; service-role writes). Also `alter publication supabase_realtime add table public.whatsapp_templates` so the page can subscribe.

## Part A — webhook consumer

**Route** (`src/app/api/webhooks/whatsapp/route.js`): replace the `field !== 'messages'` skip with a dispatch — `messages` → existing path; the three template fields → `await handleTemplateEvent(db, change.field, change.value)`. Best-effort; route still returns 200.

**Lib** `src/lib/whatsapp-template-events.js` — `applyTemplateEvent(db, field, value)`:
1. Match by `meta_template_id`; **no match → no-op**.
2. Column update by field: status → `{ status: value.event, rejection_reason: value.reason && value.reason !== 'NONE' ? value.reason : null }` (PAUSED/DISABLED/DELETED stored verbatim, row kept for history — only `APPROVED` is sendable so it's harmless); quality → `{ quality_rating: value.new_quality_score }`; category → `{ category: value.new_category }`.
3. **Idempotent + retry-safe:** read the row first; if the target value is unchanged, skip the update, the history row, AND the notification (Meta retries are no-ops).
4. On a real change: update the row, insert a `whatsapp_template_events` row (Part B), and return `{ template, notify }` for the route to push.

Notification *policy* lives in **pure, unit-tested** helpers (no IO): `statusNotification`, `qualityNotification`, `categoryNotification` → `{ notify, title, body } | null`.

## Part B — status-change audit trail

`applyTemplateEvent` writes one `whatsapp_template_events` row per real change (step 4). Surfaced on the template detail/editor as a compact timeline ("Approved · 2026-06-10 14:02", "Rejected — INVALID_FORMAT · …", "Quality YELLOW→RED · …"). Read via the existing templates API (extend the `[id]` GET to include recent events) — no new public route needed beyond that.

## Part C — quality rating in the pickers

Surface `quality_rating` as a small colour chip (GREEN/YELLOW/RED) wherever an operator picks a template: the unified composer's WhatsApp template `<select>`/preview (`UnifiedSendComposer.jsx`), `WABroadcastEditor.jsx`, and the `WAInbox.jsx` template picker. Pure read of the new column (the templates API already returns the row). A RED chip warns before they build a broadcast on a soon-to-be-paused template.

## Part D — edit & resubmit + appeal deep-link

- **Lib** `editTemplate({ metaTemplateId, components, category }, opts)` in `src/lib/whatsapp.js` — `POST {META_API_URL}/{metaTemplateId}` (mirrors the existing `createTemplate` request/auth shape; exact body verified against Meta docs at build time). Returns Meta's result; caller flips the local row to `status='PENDING'` + clears `rejection_reason`.
- **API** `POST /api/whatsapp/templates/[id]/resubmit` — guarded (manager+), only allowed when `status ∈ {REJECTED, PAUSED}` (approved can't be edited); validates the edited components via the existing template schema; calls `editTemplate`; updates the row.
- **UI** — on a REJECTED/PAUSED template the editor shows the rejection reason + an **Edit & resubmit** action (reuses `WATemplateEditor` in edit mode → the resubmit route) and an **"Appeal in WhatsApp Manager"** external link (`https://business.facebook.com/wa/manage/message-templates/` — the dispute path, since appeals are UI-only). The webhook (Part A) then tracks the re-review outcome automatically.

## Notification policy (Part A)

Push to `MANAGER_ROLES` at the template's `location_id` via the existing `sendPushToRolesAtLocation`, **reusing the `whatsapp` push category** (rides the existing `notify_whatsapp` opt-in — no new permission key, no mobile-parity change).

| Condition | Notify? | Example |
|---|---|---|
| status = APPROVED | ✅ | "✅ Template 'welcome_offer' (en) approved" |
| status = REJECTED | ✅ +reason | "❌ 'welcome_offer' rejected — INVALID_FORMAT" |
| status = PAUSED / DISABLED / LIMIT_EXCEEDED | ✅ | "⏸ 'welcome_offer' paused by Meta" |
| status = PENDING / IN_APPEAL / PENDING_DELETION / DELETED | silent | row updated, no push |
| `new_quality_score` ∈ { YELLOW, RED } | ✅ | "⚠️ 'welcome_offer' quality dropped to RED — Meta may pause it" |
| `new_quality_score` ∈ { GREEN, UNKNOWN } | silent | row updated, no push |
| category changed | ✅ | "ℹ️ 'welcome_offer' re-categorised MARKETING → UTILITY" |

The skip-when-unchanged gate means a Meta retry never double-notifies.

## Realtime page update (Part A)

The templates list view (`/whatsapp/templates`) subscribes to `whatsapp_templates` changes filtered by location and refreshes the affected row — mirroring `WAInbox.jsx`'s subscription to conversations/messages. Exact list component + wiring pinned in the plan.

## What we reuse (explicit)

WA webhook route + HMAC verify, `meta_template_id` (stored on create), `rejection_reason` + `category` columns, `createTemplate`'s Meta request/auth shape (for `editTemplate`), `WATemplateEditor` (edit mode), `sendPushToRolesAtLocation` + `MANAGER_ROLES` + `notify_whatsapp`, the Realtime pattern from `WAInbox`, the templates API, and the `GET`-poll as a backstop.

## Testing

- **Pure (no DB):** the three notification-policy helpers (every transition → notify/silent + text; `reason==='NONE'`→null); column mapping (`event`→`status`, `new_quality_score`→`quality_rating`, `new_category`→`category`); the resubmit-allowed guard (only REJECTED/PAUSED).
- **Route-level:** the `resubmit` route (auth + status guard + validation) mirroring the existing template route tests.
- **Manual (auth/Meta-gated):** real template status change → row + page update + manager push; edit & resubmit a rejected template → PENDING → webhook tracks the outcome.

## Out of scope (true v2)

- Editing/versioning an **APPROVED** template (Meta requires a new template; different flow).
- Bulk resubmit / bulk template ops.
- A standalone template-health **dashboard** (the chips + per-template timeline cover the need for now).
- Acting on a category change automatically (e.g. auto-pausing a drip whose template silently became UTILITY) — surfaced + notified, not auto-actioned.

## Resolved during brainstorming

1. Notify on quality **YELLOW + RED** (early warning), silent on GREEN. ✅
2. Reuse the **`whatsapp`** push category (no new permission key / parity churn). ✅
3. **Don't delete** the row on a DELETED event — store `status='DELETED'`, keep history. ✅
4. **Appeal is UI-only** (no Meta API) → Part D ships **edit-&-resubmit (API)** + an **appeal deep-link**, not a programmatic appeal. ✅
