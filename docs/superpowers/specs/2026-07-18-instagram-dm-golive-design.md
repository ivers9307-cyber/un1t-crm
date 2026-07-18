# Instagram DM go-live — design

**Date:** 2026-07-18
**Status:** Approved by Richard (chat, 2026-07-18)
**Scope decision:** Go live for UN1T's own Instagram account only. No OAuth connect flow, no comments/story-mention handling, no new inbox surfaces.
**Product decision:** Staff-only first — Mia does NOT auto-reply on Instagram until explicitly enabled per-channel. WhatsApp behaviour unchanged.

## Context

The Instagram DM software layer already exists and is live in prod code (shipped with the unified inbox, 2026-06-11):

- Webhook `POST /api/webhooks/instagram` — Meta-signature-checked, per-message idempotent, persists to `instagram_conversations` / `instagram_messages`, resolves the owning location via `resolveLocationByExternalAccount('instagram', <ig business account id>)`, then triggers the shared agent brain (`runChannelAgent` + `instagramAdapter`).
- Send path `sendInstagramMessage()` — Graph API `POST {META_GRAPH_URL}/me/messages` with the connection's `access_token` (Messenger Platform flavour, `graph.facebook.com/v21.0`).
- Unified inbox at `/communications/inbox` merges WA+IG queues; mobile parity shipped; needs-action badges count IG.
- Admin UI: ConnectionsSection (customer-agent settings) does CRUD on `channel_connections` via `/api/locations/[id]/channels` (secrets masked).
- Events-page IG strip (`/api/cron/instagram-feed-sync`, PR #840) reads the same `channel_connections` row.

**The blocker:** prod `channel_connections` is empty — no Instagram account has ever been connected. The entire IG layer is dormant. "Integration" is therefore Meta-side wiring plus one small code change.

## Approach (alternatives rejected)

- **Keep the Messenger Platform flavour** (`graph.facebook.com`, page-linked IG professional account, page/system-user token). Rejected alternative: the newer "Instagram API with Instagram Login" (`graph.instagram.com`, no Page needed) — would require rewriting send + webhook resolution for zero benefit; the UN1T Stillorgan Page (`110221594760397`) exists and is the anchor.
- **Token = system-user token set to Never expire** from business portfolio `2048578058564800`, pasted manually into ConnectionsSection. Rejected: short-lived/long-lived user-token exchange (60-day trap — same trap as WhatsApp, see wa-tech-provider memory); OAuth connect card (out of scope, future SaaS work).
- **App Review sequencing: do NOT touch the in-flight WA Tech Provider submission** (submitted 2026-07-16, in review). Wire + E2E now under standard access (works for accounts with a role on the app); submit `instagram_manage_messages` for advanced access only after Meta's WA decision lands.

## 1. Code change — per-channel agent gate

The only code change in this round.

**Migration (forward-only, via Supabase MCP, `get_advisors` after DDL):**

```sql
alter table channel_connections
  add column agent_enabled boolean not null default false;
comment on column channel_connections.agent_enabled is
  'When false the customer agent (Mia) never auto-replies on this channel; staff inbox flows are unaffected.';
```

Default `false` = safe: the moment the IG row is created, staff-only mode is automatic.

**Gate point:** `handleInstagramInbound()` in `src/lib/agent/instagram.js` — skip the `runChannelAgent` call when `connection.agent_enabled` is falsy. Everything before it (message persistence, conversation upsert, unread bump, needs-action semantics, staff push fan-out) runs unchanged, so the staff inbox works fully. `resolveLocationByExternalAccount` does `select('*')`, so the new column flows through with no plumbing.

**Why gate at the trigger, not inside `shouldAgentReply`:** the agent settings blob (`enabled`/`test_mode`) is shared across channels per location and is LIVE for Stillorgan WhatsApp. A channel-level gate on the connection row keeps WA untouched and gives a one-toggle flip later. Note `test_mode`'s allowlist is phone-based and IG senders have IGSIDs, not phones — so test mode can never allowlist an IG sender; the per-connection gate is the correct mechanism.

**Downstream agent surfaces:** with `runChannelAgent` never invoked for IG, no follow-ups get scheduled and no agent handoffs occur, so `followups.js` / `handoff-sla.js` have nothing IG-shaped to act on. Implementation must verify this assumption (grep for IG-table scans in those modules).

**API:** add `agent_enabled` to the channels route's zod schema + `buildConnectionPatch` fields list so the UI can set it (it is not a secret field).

**UI:** ConnectionsSection gains a "Mia auto-replies on this channel" toggle (default off), rendered per connection row.

**Tests:** unit tests for the gate (on/off × inbound → agent invoked or not), patch/mask shape tests for the new field, and a regression test that staff-side persistence still happens when the gate is off.

## 2. Meta wiring (operator runbook — done in Richard's browser)

Prereqs to confirm first:
1. The gym's IG account is a **Professional (business)** account and is **linked to the UN1T Stillorgan Facebook Page** (`110221594760397`). Business Suite → Settings → Linked accounts.
2. In the Instagram app on the phone: Settings → Messages and story replies → Message controls → **"Connected tools" → Allow access to messages = ON**. Without this, webhooks silently never deliver (classic silent killer; exact menu path varies by app version).

App configuration (Meta app "UN1T communications platform", `1650634536237918`):
3. Webhooks product → object **`instagram`** → subscribe field **`messages`** → callback `https://crm.un1tdublin.com/api/webhooks/instagram`, verify token = existing `WHATSAPP_WEBHOOK_VERIFY_TOKEN` (the route falls back to it; same for the app secret — same Meta app, so no new env vars strictly required).
4. Instagram messaging uses the same app secret already set in Vercel (`WHATSAPP_APP_SECRET`); optionally set `INSTAGRAM_APP_SECRET`/`INSTAGRAM_WEBHOOK_VERIFY_TOKEN` explicitly for clarity.

Token + assets (Business settings, portfolio `2048578058564800`):
5. System user: assign the UN1T Stillorgan Page + Instagram asset with full control.
6. Generate a system-user token, **expiry = Never** (Meta defaults to 60 days — always pick Never), scopes: `instagram_basic`, `instagram_manage_messages`, `pages_messaging`, `pages_manage_metadata`.
7. **Derive the Page access token** from the system-user token: `GET /{page-id}?fields=access_token` (or `GET /me/accounts`). The send path calls `/me/messages`, which requires a *Page* token — the raw system-user token will not work there. A Page token derived from a never-expiring system-user token does not expire.
8. Subscribe the Page to the app: `POST /{page-id}/subscribed_apps` (verify the exact `subscribed_fields` value for IG messaging routing against current Meta docs at execution time).
9. Fetch the IG business account id: `GET /{page-id}?fields=instagram_business_account`.

Connect in the CRM:
10. ConnectionsSection → add connection: platform `instagram`, `external_account_id` = IG business account id, `page_id` = `110221594760397`, `access_token` = the **derived Page token** (step 7), label/display name = the IG handle. Leave the new agent toggle OFF.

## 3. Verification (E2E, standard access)

Standard access delivers messages only from accounts with a role on the app — that IS the soft launch. Steps:

1. From an app-role Instagram account, DM the gym's IG.
2. Confirm: thread appears in `/communications/inbox` with the IG channel chip; needs-action badge increments; staff push arrives.
3. Reply from the inbox → confirm delivery on the phone; needs-reply chip clears.
4. Confirm Mia stayed silent (no agent message in the thread; webhook logs show the gate skip).
5. Trigger `/api/cron/instagram-feed-sync` manually (CRON_SECRET) → confirm `instagram_feed_posts` populates and the public events page strip renders (closes the EVENTS-IG.1 prereq).
6. Mobile: confirm the IG thread renders in the mobile inbox (parity shipped but never device-verified with real IG data).

## 4. After the WA Tech Provider review decision

1. Submit App Review for `instagram_manage_messages` advanced access (+ `instagram_basic` if flagged): screencast of DM → inbox → reply, usage justification (reuse the tight style from the WA submission), data-handling answers already backed by the public authority-requests policy.
2. On approval: general-public DMs flow. Announce internally; watch the first week's volume.
3. Optional later flip: `agent_enabled = true` on the IG connection → Mia goes live on IG.

## Known limitations (accepted)

- Replies only work inside Instagram's **24-hour messaging window**; outside it Meta rejects the send and the inbox surfaces the error. The `HUMAN_AGENT` tag (7-day window) is a separately-reviewed permission — future work if the window bites.
- No comment handling, story mentions, or IG ads lead capture in this round.
- No OAuth connect card — future SaaS clients need it, own-account go-live does not.

## Rollback

- Kill switch: deactivate the connection row (`is_active=false`) in ConnectionsSection — webhook drops events for unknown/inactive accounts; feed strip stops at next cron prune.
- The migration is additive with a safe default; no rollback needed.
