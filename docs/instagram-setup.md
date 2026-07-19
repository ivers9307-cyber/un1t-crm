# Instagram DM setup — operator runbook (Instagram Login API)

Design rationale: `docs/superpowers/specs/2026-07-18-instagram-dm-golive-design.md` + the
`2026-07-18-instagram-login-flavor-addendum.md` beside it. **This runbook is for the
Instagram API with Instagram Login** — chosen because UN1T is a franchise: the gym's IG
account cannot live in the business portfolio, which rules out the Facebook-login/page-token
flavor entirely. All CRM Graph calls go to `graph.instagram.com` with an Instagram User
token; tokens are ~60-day and the weekly `instagram-token-refresh` cron rolls them.

## Meta wiring

Console: developers.facebook.com → app **UN1T communications platform** → Instagram use case
→ **API setup with Instagram login**. The Instagram app inside it is
**"UN1T communications platform-IG", app ID `26910072478619447`**.

1. **Add the account** (already done for `un1t_stillorgan`, ID `17841449661114656`): under
   "2. Generate access tokens" → Add account → log in as the gym's IG account. Requires the
   IG account to be Professional; no Facebook Page or Business-portfolio ownership needed.
2. **Webhook Subscription toggle ON** for the account row (already on).
3. **Phone step — allow message access**: IG app → Settings → Messages and story replies →
   Message controls → **Connected tools → Allow access to messages: ON**. Without this,
   webhooks silently never deliver.
4. **Configure webhooks** (section "3. Configure webhooks" on the same page): callback URL
   `https://crm.un1tdublin.com/api/webhooks/instagram`, verify token = the value of
   **`INSTAGRAM_WEBHOOK_VERIFY_TOKEN`** (set it in Vercel first — any random string, e.g.
   `openssl rand -hex 16`; don't mark it Sensitive so it stays readable). Subscribe the
   **`messages`** field.
5. **Env vars in Vercel (Production) + redeploy**:
   - `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` — from step 4.
   - `INSTAGRAM_APP_SECRET` — the **Instagram app secret** shown on the API-setup page
     (Show → copy). This signs IG webhook payloads; the WhatsApp app secret does NOT —
     without this env var every IG webhook is rejected with an invalid signature.
6. **Generate the token**: "Generate token" next to the account row → log in as the IG
   account → copy the Instagram User token (long-lived, ~60 days). No never-expire option
   exists on this flavor — the weekly cron keeps it rolled from here on.

## Connect in the CRM

7. crm.un1tdublin.com → Settings → Locations → your location → **Integrations → Instagram** tab: handle
   `@un1t_stillorgan`, Instagram professional account ID `17841449661114656`, Instagram app
   ID `26910072478619447`, access token from step 6 (leave Page ID blank — not used by this
   flavor). **Leave "Mia auto-replies on Instagram" OFF.** Save → badge shows Connected.

## Verification (E2E)

Until App Review grants advanced access, only Instagram accounts with a role on the app can
message in — that IS the soft launch.

1. From an app-role Instagram account, DM the gym's IG.
2. Confirm: thread appears in `/communications/inbox` with the IG channel chip; needs-action
   badge increments; staff push arrives.
3. Reply from the inbox → confirm delivery on the phone; needs-reply chip clears.
4. Confirm Mia stayed silent — no agent message in the thread (the gate skips silently; the
   thread itself is the signal).
5. Trigger `/api/cron/instagram-feed-sync` manually (CRON_SECRET) → confirm
   `instagram_feed_posts` populates and the public events page strip renders (closes the
   EVENTS-IG.1 prereq). Note: feed reads need the account's media permission granted during
   business login.
6. Mobile: confirm the IG thread renders in the mobile inbox (parity shipped but never
   device-verified with real IG data).
7. **Token roll check** (any time ≥24h after pasting the token): run the
   `instagram-token-refresh` cron manually with CRON_SECRET → expect
   `{"success":true,"refreshed":1,"failed":0}` and `token_expires_at` ~60 days out.

When done, flip Mia on for IG (if desired) via the "Mia auto-replies on Instagram" toggle on
the same Integrations → Instagram tab — it is OFF by default.

## After the WA Tech Provider review decision

**HOLD (2026-07-19): nothing below happens until Meta rules on the WhatsApp Tech Provider
submission** — App Review is per parent app and the WA request is in flight on the same app.

Console prep already parked (Business login settings saved 2026-07-19, endpoints NOT yet
implemented):
- OAuth redirect: `https://crm.un1tdublin.com/api/instagram/business-login/callback`
- Deauthorize: `https://crm.un1tdublin.com/api/instagram/business-login/deauthorize`
- Data deletion: `https://crm.un1tdublin.com/api/instagram/business-login/data-deletion`

1. **Build the business-login flow FIRST — it is an App Review prerequisite, not a
   post-review item** (the console's step-5 flow expects reviewers to exercise a working
   business login, and they probe the data-deletion URL). One PR: OAuth start route +
   the three parked endpoints above (signed-request verification via `INSTAGRAM_APP_SECRET`;
   deauthorize flips the connection `is_active=false`; data deletion answers Meta's
   confirmation-code protocol, backed by the public `/privacy` pages). This is the same
   code the franchise/SaaS onboarding needs — nothing wasted.
2. Submit App Review for **`instagram_business_manage_messages`** (+
   `instagram_business_basic` if flagged) advanced access: screencast of business login →
   DM → inbox → reply, usage justification (reuse the tight style from the WA submission),
   data-handling answers already backed by the public authority-requests policy.
3. On approval: general-public DMs flow. Announce internally; watch the first week's volume.
4. Optional later flip: the Mia toggle → she goes live on IG.

## Known limitations (accepted)

- Replies only work inside Instagram's **24-hour messaging window**; outside it Meta rejects
  the send and the inbox surfaces the error. The `HUMAN_AGENT` tag (7-day window) is a
  separately-reviewed permission — future work if the window bites.
- No comment handling, story mentions, or IG ads lead capture in this round.
- Tokens are ~60-day: if the refresh cron heartbeat goes stale for more than a couple of
  weeks, treat it as urgent — an expired token cannot be refreshed, only re-generated in the
  console (step 6).

## Rollback

- Kill switch: deactivate the connection row (`is_active=false`) in Connections — the
  webhook drops events for unknown/inactive accounts; feed strip stops at next cron prune.
- Migrations 407/408 are additive with safe defaults; no rollback needed.
