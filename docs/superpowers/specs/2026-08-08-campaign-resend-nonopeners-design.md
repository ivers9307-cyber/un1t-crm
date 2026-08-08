# Campaign resend to non-openers — design

**Date:** 2026-08-08 · **Status:** approved by Richard (trigger model, cap bypass, guardrails chosen via Q&A)

## Problem

Marketing email platforms let an operator resend a campaign to recipients who did not open it, optionally with a new subject. The CRM has no resend or clone capability at all: `POST /api/campaigns/[id]/send` rejects anything not `draft|scheduled`, and no UI action exists on sent campaigns.

## Decisions (locked)

- **Trigger:** auto-schedule at compose time — a "Resend to non-openers" option in the unified send composer (marketing email only). No manual button in v1.
- **Frequency cap:** resends bypass the marketing frequency cap (a resend is a deliberate operator action to people who already received this content). Consent, suppression, and bounce gates apply in full. The resend still stamps `last_marketing_touch_at` so later campaigns count it.
- **Guardrails:** warn (don't block) when the configured wait is under 24h; exactly one resend per campaign, enforced by a partial unique index — no resend-of-resend chains.
- **Scope:** `postmark_stream='broadcast'` only. Utility sends have open tracking off by design (GDPR call, 2026-08-07), so the option never appears for them.

## Architecture

A resend is a **child `campaigns` row** spawned by cron after the parent finishes sending and the wait elapses. Rationale: the recipient-populate step only runs when `campaign_recipients` for a campaign is empty, `(campaign_id, contact_id)` is unique, and a child row keeps stats clean per send. The child rides the entire existing send state machine (fair-pick, claim-before-send, retries, cancellation, stats) unmodified.

### Schema (one forward migration)

On `campaigns`:

| column | type | meaning |
|---|---|---|
| `parent_campaign_id` | uuid FK → campaigns(id) | non-null ⇒ this row is a resend of that campaign |
| `resend_enabled` | boolean default false | operator opted in at compose |
| `resend_wait_hours` | integer | hours after `sent_at` before spawning |
| `resend_subject` | text nullable | null ⇒ reuse the parent's (winner) subject |

Partial unique index `ON campaigns(parent_campaign_id) WHERE parent_campaign_id IS NOT NULL` — one resend per campaign, DB-enforced. CHECK: `resend_wait_hours IS NULL OR resend_wait_hours >= 1`. RLS: table already covered; no new policies needed (same-table columns).

### Compose (UnifiedSendComposer → email-draft route)

Marketing-email path only: toggle **Resend to non-openers**, wait presets 24/48/72h (default 48, free entry ≥1h) with an inline warning below 24h ("opens are still arriving — resending this early reaches people who just haven't got to it yet"), and an optional **New subject** field with helper text that a fresh subject typically lifts second-send opens, plus one line noting open tracking undercounts (privacy proxies auto-open images). The draft/send/schedule actions persist `resend_enabled/resend_wait_hours/resend_subject` onto the campaign row. Validation server-side: marketing stream only, wait ≥1.

### Spawn (inside `/api/cron/run-campaigns`, every 2 min)

Before ticking sends: select campaigns where `resend_enabled = true`, `status = 'sent'`, `parent_campaign_id IS NULL`, `sent_at + resend_wait_hours × interval '1 hour' <= now()`, and no child row exists (insert relies on the partial unique index as the race guard — on conflict, skip). For each:

1. Resolve the parent's non-opener count cheaply (`campaign_recipients` where `opened_at IS NULL AND status IN ('sent','delivered')`). Zero ⇒ set `resend_enabled = false` (nothing to do), log, no child.
2. Otherwise insert the child: clone `html_content`, `design_json`, `from_name/from_email/reply_to`, `preview_text`, `location_id`, `postmark_stream`, `template_id`; `subject = resend_subject ?? parent effective subject` (A/B parent ⇒ `ab_winner` variant subject); `name = "<parent name> (resend)"`; `parent_campaign_id = parent.id`; `status = 'queued'`; `created_by = parent.created_by`. A/B columns are NOT cloned — a resend is a single-subject send.
3. Set parent `resend_enabled = false` (consumed; also makes cancel-after-fire a no-op naturally).

Parent cancelled/failed mid-send never reaches `status='sent'`, so no resend spawns.

### Populate (new branch in `campaign-sender.js` `tickCampaignSend`)

When the campaign being populated has `parent_campaign_id`: instead of `buildAudienceQueryAsync` over the filter DSL, page through the parent's `campaign_recipients` (`opened_at IS NULL`, `status IN ('sent','delivered')`, ordered by id, 1000/page), and for each page re-intersect the contact ids against `contact_location_audience` with the standard marketing gates (`audience_location_id`, `loc_email_marketing = true`, `email_status NOT IN ('bounced','complained')`, `email_suppressed_at IS NULL`). Survivors become `campaign_recipients` rows for the child, `status='queued'`. The set therefore resolves at the last possible moment: late opens, unsubscribes, bounces, and suppressions between original send and spawn are all respected. **Never inner-join around the view** (per-location comms invariant) — query the view itself.

Frequency cap: in the post-claim gate, skip the `frequency-cap` check when `parent_campaign_id` is set; `stampMarketingTouch` still runs on successful send. All other gates (org email cap, wallet, consent re-check post-claim) unchanged.

### Visibility & cancellation

- **CampaignDetail (parent, pending):** banner "Resend to non-openers scheduled ~\<sent_at + wait\> · Cancel". Cancel = `PATCH` clearing `resend_enabled` (child doesn't exist yet, so cancellation is trivial). Copy is UI chrome, not customer-facing.
- **After fire:** parent links to child; child header shows "Resend of \<parent name\>" linking back, and its own stats stand alone (`recalculate_campaign_stats` is per-campaign already).
- **/communications/sent list:** child rows get a "Resend" affordance/badge; parent rows with a pending resend show a small "resend scheduled" hint.

## Error handling

- Spawn insert conflict on the partial unique index ⇒ another invocation won; skip silently.
- Spawn failures leave `resend_enabled = true` and retry next tick (flag flips only after successful child insert / zero-path).
- Child send path inherits existing retry/lease/attempt semantics untouched.

## Testing

Unit (vitest, mocked supabase per repo pattern):
- Spawn eligibility: not-yet-elapsed, non-sent status, already-has-child, disabled, zero-non-openers path flips the flag without a child.
- Subject resolution: explicit `resend_subject`, fallback to parent subject, A/B winner fallback.
- Populate: opened/bounced/complained excluded; consent-revoked, suppressed, and bounced-in-the-gap contacts excluded by the view re-check; pagination over >1000.
- Freq-cap bypass only when `parent_campaign_id` set; `stampMarketingTouch` still called.
- Composer/API validation: utility stream rejected, wait ≥1 enforced, fields persisted on draft→send.

Post-migration: `get_advisors` (security + performance) must be clean.

## Out of scope (v1)

Manual resend button on already-sent campaigns; resend for SMS/WhatsApp broadcasts; resend chains; per-location default wait setting.
