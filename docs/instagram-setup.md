# Instagram DM setup — operator runbook

For the design rationale, alternatives considered, and the code-side change (per-channel `agent_enabled` gate), see `docs/superpowers/specs/2026-07-18-instagram-dm-golive-design.md`.

## Meta wiring (operator runbook — done in Richard's browser)

**Prereqs to confirm first:**
1. The gym's IG account is a **Professional (business)** account and is **linked to the UN1T Stillorgan Facebook Page** (`110221594760397`). Business Suite → Settings → Linked accounts.
2. In the Instagram app on the phone: Settings → Messages and story replies → Message controls → **"Connected tools" → Allow access to messages = ON**. Without this, webhooks silently never deliver (classic silent killer; exact menu path varies by app version).

**App configuration** (Meta app "UN1T communications platform", `1650634536237918`):
3. Webhooks product → object **`instagram`** → subscribe field **`messages`** → callback `https://crm.un1tdublin.com/api/webhooks/instagram`, verify token = existing `WHATSAPP_WEBHOOK_VERIFY_TOKEN` (the route falls back to it; same for the app secret — same Meta app, so no new env vars strictly required).
4. Instagram messaging uses the same app secret already set in Vercel (`WHATSAPP_APP_SECRET`); optionally set `INSTAGRAM_APP_SECRET`/`INSTAGRAM_WEBHOOK_VERIFY_TOKEN` explicitly for clarity.

**Token + assets** (Business settings, portfolio `2048578058564800`):
5. System user: assign the UN1T Stillorgan Page + Instagram asset with full control.
6. Generate a system-user token, **expiry = Never** (Meta defaults to 60 days — always pick Never), scopes: `instagram_basic`, `instagram_manage_messages`, `pages_messaging`, `pages_manage_metadata`.
7. **Derive the Page access token** from the system-user token: `GET /{page-id}?fields=access_token` (or `GET /me/accounts`). The send path calls `/me/messages`, which requires a *Page* token — the raw system-user token will not work there. A Page token derived from a never-expiring system-user token does not expire.
8. Subscribe the Page to the app: `POST /{page-id}/subscribed_apps` (verify the exact `subscribed_fields` value for IG messaging routing against current Meta docs at execution time).
9. Fetch the IG business account id: `GET /{page-id}?fields=instagram_business_account`.

**Connect in the CRM:**
10. ConnectionsSection → add connection: platform `instagram`, `external_account_id` = IG business account id, `page_id` = `110221594760397`, `access_token` = the **derived Page token** (step 7), label/display name = the IG handle. Leave the new agent toggle OFF.

## Verification (E2E, standard access)

Standard access delivers messages only from accounts with a role on the app — that IS the soft launch. Steps:

1. From an app-role Instagram account, DM the gym's IG.
2. Confirm: thread appears in `/communications/inbox` with the IG channel chip; needs-action badge increments; staff push arrives.
3. Reply from the inbox → confirm delivery on the phone; needs-reply chip clears.
4. Confirm Mia stayed silent — no agent message in the thread (the gate skips silently; the thread itself is the signal).
5. Trigger `/api/cron/instagram-feed-sync` manually (CRON_SECRET) → confirm `instagram_feed_posts` populates and the public events page strip renders (closes the EVENTS-IG.1 prereq).
6. Mobile: confirm the IG thread renders in the mobile inbox (parity shipped but never device-verified with real IG data).

When done, flip Mia on for IG (if desired) via the "Mia auto-replies on Instagram" toggle in Customer Agent settings → Connections — it is OFF by default.

## After the WA Tech Provider review decision

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
