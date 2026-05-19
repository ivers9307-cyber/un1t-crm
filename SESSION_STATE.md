# Session State — May 20, 2026

One-screen "state of the world" so a fresh chat can orient in 30 seconds.
For depth, see [CLAUDE.md](./CLAUDE.md) — Done log entries #193–199, the new "Shipping from the sandbox" section, and the new branch + PR Lesson Learned.

## Today's headline

Two big features landed across the day, plus a flurry of FTE-EXPENSES polish from the morning. **Both shipping PRs are open against main**:

- **PR #43 — `invoices-inbox`**: INVOICES.1 (Dext-style email-in supplier invoices) + INVOICES.2 (sidebar badge) + INVOICES.3 (Claude Vision auto-categorisation). Mig 184 already applied to prod Supabase.
- **PR #44 — `approvals-dashboard`**: APPROVALS.1 — central approvals page aggregating contractor invoices, FTE expenses, time-off, swap requests, and over-budget rosters. Sidebar badge + extensible provider registry.

Both branched off latest main; merge order doesn't matter.

The FTE expenses surface (mobile + web + Claude Vision receipt OCR + auto-fill manual-trigger) shipped earlier in the session as #193–194.

## What's in flight, not yet merged

| PR | Branch | What's in it | Status |
|---|---|---|---|
| **[#43](https://github.com/ivers9307-cyber/un1t-crm/pull/43)** | `invoices-inbox` | INVOICES.1/.2/.3 + mail subdomain switch | Awaiting merge. Mig 184 applied. Postmark inbound MX + webhook config still need post-merge wiring (see "Post-merge ops" below). |
| **[#44](https://github.com/ivers9307-cyber/un1t-crm/pull/44)** | `approvals-dashboard` | APPROVALS.1 central dashboard | Awaiting merge. No migration, no env vars, no DNS. Just merge. |

## Post-merge ops (operator action required after PR #43 lands)

1. **DNS**: confirm `mail.un1tdublin.com` MX → Postmark inbound (priority 10). Done before merge.
2. **Vercel env var**: `POSTMARK_INBOUND_WEBHOOK_TOKEN` set to the value generated this session (64-char hex from `openssl rand -hex 32`). Already in Vercel as of session end.
3. **Postmark inbound stream config**: set the webhook URL to `https://crm.un1tdublin.com/api/webhooks/invoices-inbound/<TOKEN>` and the inbound domain to `mail.un1tdublin.com`. **Webhook URL is the only place the literal token appears** — don't add it to the repo.
4. **Per-location forwarding slugs**: configure in Location Settings → Invoice Forwarding for each location that should accept inbound invoices (e.g. slug `dublin-city` → addr `dublin-city-invoices@mail.un1tdublin.com`).

## Today's shipped (chronological, oldest first)

| # | Feature | Notes |
|---|---|---|
| 193 | **FTE-EXPENSES.1/.2** (already shipped pre-session) | Mig 183. Monthly FTE claims with per-item receipts. Web + mobile (CF Studio 1.1.0). Same Xero email forward as contractor invoices. |
| 194 | **FTE-EXPENSES.3/.4 + FIX series** | Claude Vision receipt OCR. Converted from auto-fire to **manual trigger** ("Auto-fill from receipt" button) per operator feedback on cost protection. Fixed missing `expo-image-picker` dep + viewer_role ordering bug where master-FTE users couldn't add items on mobile. |
| 195 | **MAIL-SUBDOMAIN.1** | Inbound mail moved from apex `un1tdublin.com` to dedicated `mail.un1tdublin.com` subdomain so marketing apex MX is untouched. |
| 196 | **INVOICES.1** | Dext-style email-in inbox at `/invoices`. Mig 184. Postmark webhook with token-in-URL auth (Postmark doesn't allow header auth on inbound). Two-stage manual approval (quality → extract → data review → forward to Xero) so Claude Vision only runs after operator approves the attachment. |
| 197 | **INVOICES.2** | Red sidebar badge + browser tab title prefix for pending invoices. 60s poll + tab-refocus refresh. |
| 198 | **INVOICES.3** | Claude Vision auto-categorisation. 13-value enum tuned for gym operations. Category + account code surfaced in the data-review form and in the Xero forward email body as hints. |
| 199 | **APPROVALS.1** | Central `/approvals` dashboard aggregating contractor invoices, FTE expenses, time-off, swap requests, and over-budget rosters. Sidebar badge. Extensible registry — adding a new approvable surface is one provider file + one line. |

## Operational watches (carried over)

- **TestFlight 0.1.1 (5)** — still in Apple review (was carried over from May-17). Most staff still can't receive pushes until they install the build.
- The May-13 "15 mins?" campaign's 32% delivery ratio — still deferred to a fresh push for analysis.

New watch from this session:

- **Vercel deploys for both open PRs** — preview URLs should be checked before merging. Smoke-test: forward a real PDF to `<slug>-invoices@mail.un1tdublin.com` → confirm it lands in `/invoices` → walk the two stages → confirm it appears as a draft bill in Xero. Then check `/approvals` shows the right items per the logged-in user's role.

## Live state of the world

| Resource | Count |
|---|---|
| Active locations | 4 (Stillorgan / Hatch Street / CCF Autos / Test Studio) |
| Active staff | 13 |
| Open PRs | 2 (#43 invoices-inbox, #44 approvals-dashboard) |
| Last applied migration | 184_inbound_invoices |
| Total tests | 1938 (8 new for APPROVALS.1, 25 for INVOICES.1, plus FTE-EXPENSES) |
| Web permissions | 26 |
| Mobile permissions | 19 |

## Branch state

```
main                              ─── HEAD: a65cede (pre-session)
  ├── invoices-inbox       PR #43 ─── 2ce4f26, e8befcb, ...
  └── approvals-dashboard  PR #44 ─── (commits on branch)
  └── docs-session-2026-05-20      ─── this doc update (in progress)
```

## Where to look next

- **If a feature regression**: PRs #43 + #44 are the new code. The /approvals page wraps existing per-feature pages so issues there could be in the provider's query shape, not the UI.
- **If a webhook doesn't fire**: check the Postmark inbound webhook config matches `POSTMARK_INBOUND_WEBHOOK_TOKEN` exactly (constant-time compared). Wrong token returns 404 (not 403) by design — Postmark will retry.
- **If a row gets stuck mid-pipeline**: `inbound_invoices` has six states. `quality_approved` + `data_approved` are the async intermediate stops — if OCR or Xero forward fails, the row stays in those states and the UI shows a Retry button on the detail panel. Look at `extraction_error` or `xero_error` columns for the failure reason.

## Recent lessons (top 5 — full versions in CLAUDE.md)

1. **Shipping = branch + commit + push + PR**. Stopping at `git push` is not shipping. New canonical loop in "Shipping from the sandbox" section of CLAUDE.md uses curl + GitHub API since the sandbox has no `gh` CLI. Codified this session because the assistant initially stopped at the push for INVOICES.1.
2. **Postmark inbound webhooks don't allow custom headers** — only a URL. Token-in-URL auth (same pattern as the sequence webhook) is the substitute. 404 on wrong token to avoid leaking URL existence.
3. **`supabase-js` builders are thenables, not Promises.** Use `try { await ... } catch {}`, not `.catch(() => {})`. Bit us silently for 4 days in May.
4. **`stampHeartbeat` is UPDATE-only.** Pre-seed the `cron_heartbeats` row in the same migration that adds the cron.
5. **Mobile permissions live on `profile_locations.permissions.mobile`**, not `profiles.permissions.mobile`. Discovered during the May audit.

## Backlog status

**Effectively empty.** Two open PRs are the only in-flight code.

Surviving items worth attention:
- **AUDIT-EXPAND.2** (task #129) — DB triggers for mutation logging on key tables. Deferred when AUDIT-EXPAND.1 shipped because the app-level instrumentation covered the high-value surfaces.
- The May-13 campaign delivery rate analysis (deferred).

Next-shaped concerns once both PRs merge:
- **Invoices observability**: a row that hangs in `quality_approved` because OCR keeps failing should be surfaced somewhere — possibly a Sentinel alert when any row sits in an intermediate state >24h.
- **Approvals notifications on mobile**: APPROVALS.1 is desktop-only by design (drills into desktop-only source pages). Mobile keeps using per-category `notify_*` flags. Worth considering an aggregate "you have N pending approvals" mobile badge if operator demand emerges.
