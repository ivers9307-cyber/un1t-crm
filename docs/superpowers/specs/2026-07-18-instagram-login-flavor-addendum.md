# Instagram Login flavor addendum — supersedes the API-flavor choice in the go-live spec

**Date:** 2026-07-18 (same day, after Meta-console wiring began)
**Status:** Approved by Richard (chat)

## What changed and why

The go-live spec chose the Messenger-Platform/Facebook-login flavor (page-linked IG,
`graph.facebook.com`, never-expire system-user token) and rejected Instagram Login as "zero
benefit". That rejection was premised on the gym's IG account being linkable to the UN1T
Stillorgan Page inside the business portfolio. **The premise was wrong: UN1T is a
franchise — the gym IG account cannot live in Richard's business portfolio** (portfolio's IG
list contains only an unrelated account). The Facebook-login flavor is therefore unusable,
and Instagram Login (business login; console-added accounts) is the only viable path — and
happens to be the same mechanism a future SaaS onboarding uses.

Richard had already created the Instagram use-case app ("UN1T communications platform-IG",
`26910072478619447`) and added `un1t_stillorgan` (`17841449661114656`) with webhook
subscription ON before this addendum.

## Deltas vs the original spec (everything else stands)

1. **Graph host**: all instagram-platform calls (DM send, IGSID profile fetch, feed sync)
   move to `graph.instagram.com` (`IG_GRAPH_URL`, v25.0). Send is
   `POST /{ig-account-id}/messages` with the token in an Authorization header. The
   FB-login flavor had zero prod connections, so no compatibility shim.
2. **Tokens**: Instagram User tokens, long-lived ~60 days, **no never-expire option**.
   New weekly cron `instagram-token-refresh` (Mon 05:00 UTC) rolls every active
   instagram connection via `GET graph.instagram.com/refresh_access_token`
   (documented unversioned endpoint; refresh works only on unexpired tokens ≥24h old).
   Mig 408: `token_expires_at`, `token_refreshed_at` + heartbeat row. A failed refresh
   never clobbers the stored token (`buildTokenRefreshPatch` returns null).
3. **Webhook signing**: IG webhooks are signed by the **Instagram app's secret**, not the
   parent app's — `INSTAGRAM_APP_SECRET` env is now required (the route already prefers
   it); `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` likewise (the WA one is Vercel-Sensitive and
   unreadable).
4. **Permissions / App Review**: the `instagram_business_*` family
   (`instagram_business_basic`, `instagram_business_manage_messages`) replaces
   `instagram_basic`/`instagram_manage_messages`. Review sequencing unchanged: submit only
   after the WA Tech Provider decision.
5. **Runbook**: rewritten for the console's API-setup page (add account / generate token /
   webhook section); the system-user + derived-Page-token steps are obsolete.

Unchanged: mig 407 per-channel `agent_enabled` gate, staff-only default, ConnectionsSection
toggle, inbox/webhook/persistence behavior, SaaS OAuth card deferred.
