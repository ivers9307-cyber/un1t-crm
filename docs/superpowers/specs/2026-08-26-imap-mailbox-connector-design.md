# IMAP/SMTP mailbox connector — design + implementation plan

**Status:** phases 1–7 MERGED 2026-08-26 (#1540, migs 572/573, live). Phase 8 built on
branch `mailbox-sent-lane` (mig 574).
See §12 for the corrections the build forced on this document.
**Date:** 2026-08-26
**Prompted by:** `hatchstreet@un1t.com` — a franchise address on a domain we do not own
**Scope decision (Richard, 2026-08-26):** build it as a **SaaS capability**, not a
one-off. Any operator connects any email account from
Settings → Locations → *studio* → Email by supplying its login.

---

## 1. The problem

The ticketing inbox has exactly one ingress: the Postmark inbound webhook
(`/api/webhooks/postmark-inbound/[token]`). That requires pointing a domain's MX
at Postmark, which requires owning the domain.

`un1t.com` is the franchisor's. Verified 2026-08-26:

```
MX   aspmx.l.google.com, alt1/alt2.aspmx.l.google.com, aspmx2/3.googlemail.com
SPF  v=spf1 include:_spf.google.com include:_spf.mlsend.com include:sendgrid.net ~all
```

Google Workspace, no Microsoft tenant (no `autodiscover` / `enterpriseregistration`
CNAMEs). We will never control its MX, so no Postmark-shaped path exists.

Two live consequences today:

- `hatchstreet@un1t.com` is invisible to the platform.
- `stillorgan@un1t.com` sits in `email_mailboxes` as `active=true, is_default=true`,
  so every campaign stamps a Reply-To the CRM cannot receive. That mail is not
  lost — it is in the franchisor's Google mailbox — but the platform claims to
  handle it and does not.

**Owning the domain was never the requirement. Holding the mailbox login is.** The
estate already proves this: `recon_mailboxes` has held a working Gmail app
password for `stillorgan@un1t.com` since 2026-07-04, driving the receipt-hunt
engine through `src/lib/recon/imap-client.js`. Two halves that have never met —
the same shape as the `issues` + `email_conversations` insight that produced the
ticketing system itself.

## 2. Rejected alternatives

**Auto-forwarding into a Postmark-backed address.** Zero code, works today. Rejected
(Richard): it depends on a Google setting the *franchisor's admin* can disable
silently and org-wide as a DLP control. An app password is a credential we hold. For
a franchise relationship, and for a SaaS feature sold to operators whose domains we
will never control, that robustness difference decides it.

**OAuth instead of password auth.** Deferred rather than rejected, and the seam for it
is built now — see §2.1 for the reasoning and the cost.

**Sending from `@un1t.com` via Postmark.** `un1t.com` publishes `~all` and
`p=none`, so unaligned mail would mostly deliver. It is still spoofing the
franchisor's domain. Not doing it.

**Extracting `processInboundEmail` into a shared core.** See §3.

### 2.1 OAuth — deferred, but the seam is built now

Asking a customer to paste a mailbox password into our app is a real objection, and
Google has been steadily narrowing password-based access. So OAuth is where this ends
up. It is not, however, a thing we can simply choose to do this month:

- Gmail over IMAP with XOAUTH2 needs the `https://mail.google.com/` scope. That is a
  **restricted** scope, as are `gmail.readonly` / `gmail.modify` — there is no
  unrestricted way to read a Gmail mailbox.
- Restricted scopes in production, for users outside our own Workspace, require Google
  OAuth app verification **plus an annual third-party CASA Tier 2 security
  assessment**. That is real money and weeks-to-months of calendar time.
- Leaving the app in Testing status is not a workaround: refresh tokens expire after
  7 days.
- Domain-wide delegation sidesteps verification but needs each customer's super admin
  to register our client ID, and is impossible for anyone on consumer Gmail.

**Counterintuitively, Microsoft is the cheap one.** Graph (or Outlook IMAP via
`IMAP.AccessAsUser.All`) needs a multi-tenant app registration and ordinary user or
admin consent — no CASA, no verification gauntlet. If OAuth is built, Microsoft-first
costs less than Google-first, which inverts the usual order.

**Decision: ship password auth, build the seam, defer the provider work.** Concretely,
now:

- `email_mailbox_credentials.auth_type` — `password` | `oauth` — with token columns
  nullable from day one. One column now instead of a migration plus a credential
  backfill later.
- The credential resolver returns an **auth strategy**, never a raw password, and that
  verdict stays transport-neutral. imapflow reads `auth: { user, accessToken }` verbatim
  (verified against `imap-flow.js`); nodemailer does NOT — it keys XOAUTH2 off
  `auth.type === 'OAuth2'` and otherwise drops the token into a LOGIN attempt (verified
  by construction against 9.0.5, §12). The SMTP transport therefore adapts the shape at
  its own edge rather than the resolver learning about transports. Either way the later
  additions are a token-refresh step and a consent screen, not surgery on the poller.
- Provider config is per-mailbox (host/port/TLS) rather than Gmail-hardcoded.

That is a few hours of design discipline against a painful retrofit. Google
verification + CASA is pure calendar time and can start in parallel whenever the
business wants it, independent of any code here.

## 3. Architecture — the poller is a *producer*, not a second pipeline

```
Gmail / any IMAP host
  └─ IMAP, read-only, INBOX only
      └─ cron poller  */5                          ← the only new moving part
          ├─ cursor: UIDVALIDITY + last UID
          ├─ envelope + bodyStructure + headers     (imapflow — already a dep)
          ├─ attachments → Storage                  (reuse email-attachment-staging)
          └─ POST Postmark-shaped payload → /api/webhooks/postmark-inbound/<token>
                └─ the entire existing pipeline, byte-for-byte unchanged
```

**Why not refactor.** `processInboundEmail` is ~500 lines inside the route file, it
returns `NextResponse`, and it encodes Postmark's retry semantics. It is also the
single most safety-critical function in the estate — the whole silent-mail-loss
history is written into it (dedupe claim/release, crash-window classification,
`finishDedupedDelivery`, poison-text defusing, eight dead-letter doors). Extracting
it is the highest-risk refactor available here, and a parallel pipeline would re-learn
every one of those lessons the hard way.

The estate already solved this. `postmark-inbound-shim` is a bytes-mover that
reshapes a payload, forwards it to the same Vercel route, and returns the response
verbatim. **The poller is the second instance of that pattern.** Everything downstream
is inherited, not rebuilt.

### 3.1 Routing needs no route change

The poller sets `OriginalRecipient` to the connected address.
`recipientEmails()` (`src/lib/email-inbox.js:150`) already collects it and
`resolveMailboxByRecipient` already matches it. Add the mailbox row and mail files
itself.

⚠️ `OriginalRecipient` is **last** in the precedence order (ToFull → CcFull → To →
OriginalRecipient). A message addressed *To* a different mailbox of ours but delivered
to this one resolves to the other one. Rare, but it needs a test that pins the
behaviour rather than discovering it in production.

### 3.2 Dedupe is free

`MessageID` is supplied as a namespaced synthetic:
`imap-<8 hex of mailbox_id>-<40 hex of sha256(mailbox_id:rfc-message-id)>`.

- Deterministic, so a re-poll of the same message produces the same id.
- Globally unique — the digest covers the full mailbox id and Message-ID, so uniqueness
  does not rest on the truncated readable prefix.
- Cannot collide with a real Postmark id (those are lowercase-hex UUIDs, which never
  begin `imap-`), so a Postmark delivery webhook can never correlate against an IMAP row.
- The existing unique partial index on `email_inbox_messages.postmark_message_id`
  becomes the completion marker, exactly as it is for the webhook path.

⚠️ **The format is constrained, not cosmetic.** This value also becomes the staged
attachment object path prefix, and `stagedAttachmentPath()` /`stagedPathMatches()`
(`src/lib/email-attachment-staging.js:81`) accept only `^[A-Za-z0-9_-]{1,64}$`. The
obvious readable form — `imap:<uuid>:<rfc-id>` — fails on the colons, the `@` and the
dots, which would degrade **every** IMAP attachment to `rehost_failed` and leave the
uploaded bytes orphaned in a metered bucket. Do not "improve" it back to a readable
colon form.

No new dedupe machinery, no migration for it.

### 3.3 Cursor discipline

Advance the watermark **only** on a 2xx from the route. A 5xx leaves it and the next
tick retries — which is precisely Postmark's own behaviour, so the route sees the
retry pattern it was hardened against. A UIDVALIDITY change re-anchors to the current
highest UID rather than re-ingesting the mailbox.

### 3.4 Read-only, INBOX only

Never write flags. The customer's mailbox stays visually untouched, and the CRM's own
unread model remains the single source of truth. INBOX rather than `[Gmail]/All Mail`
means SMTP sends — which Gmail files to Sent — cannot loop back in. Combined with the
existing `loadOwnAddresses(db)` exclusion, that closes the loop question.

### 3.5 Cold start

First successful connect anchors the watermark at the current highest UID and ingests
nothing. Matches the agreed "new mail only" — no backfill, ever.

## 4. Sending as the connected address

Postmark cannot DKIM-sign a domain we do not control, so replies go out over the same
account's SMTP. Google signs them, they align with the domain's DMARC, and they are
indistinguishable from mail sent in Gmail.

- New dependency: `nodemailer` (the repo has a dependency-audit gate —
  `scripts/check-dependency-audit.mjs` — so this needs a reasoned accept).
- Transport selection lands in `src/lib/email-inbox-send.js` **before** the Postmark
  resolution, returning the same verdict envelope so the routes are untouched.
- 🔴 `plannedFroms`'s unverified-From fallback must **not** apply to SMTP. Google
  always sends as the authenticated account; there is no "unverified sender" concept,
  and a silent fallback would change the address the customer sees.
- Knock-on: no Postmark delivery/bounce events for these sends. mig 498's state model
  already treats NULL as "sent, and we have heard nothing", which is honest — but the
  UI must say *why* for this mailbox rather than looking like a pending event.

## 5. Coexisting with the mail client

A connected mailbox is a **real mailbox that people still open**. Head office reads
`hatchstreet@un1t.com` in Gmail; a coach might answer from their phone. The design
must survive that, and read-only polling of INBOX alone does not.

Three divergences, and they are not equally serious:

| In the mail client | CRM, with INBOX-only polling | Severity |
|---|---|---|
| Mail is opened | ticket stays unread | cosmetic |
| Mail is archived or deleted | ticket unaffected | cosmetic — arguably correct |
| **Mail is replied to** | **reply never seen; ticket sits "needs reply" forever** | **customer-facing** |

The third is the one that matters. A reply sent from Gmail goes to Sent, never to
INBOX, so the poller never sees it, the ticket stays open and unanswered, and someone
answers a second time. Double-replying to a member is a worse failure than any of the
plumbing faults this design is otherwise careful about.

**Fix: poll the Sent folder too, and file those as outbound messages.**

- Threading is already solved — a client-sent reply carries `In-Reply-To` /
  `References` matching the inbound message, which is exactly what the existing
  threading resolves on.
- Dedupe against our own SMTP sends (§4), which land in the same folder, on RFC
  Message-ID. We record ours at send time, so this is an exact match, not a heuristic.
- ⚠️ This cannot reuse the inbound webhook. `processInboundEmail` writes
  `direction: 'inbound'` throughout; an outbound row needs its own writer. It is the
  one place in this design where the producer pattern does not carry us, and it is
  the reason coexistence is its own phase rather than a flag on the poller.
- A ticket bumped by a client-sent reply must clear "needs reply" and must **not**
  fire the inbound push — nobody needs telling that their colleague answered.

**Read-state (`\Seen`) is deliberately NOT synced.** `email_tickets.unread_count` is a
counter that cannot be recomputed from rows, and the CRM's unread is per-user where
IMAP's `\Seen` is one shared flag for the whole mailbox. Mapping one onto the other
produces a badge that is wrong in both directions. Accepting a cosmetic divergence is
better than a load-bearing one built on a bad mapping. Revisit only if operators ask.

**Deletion and archiving are not mirrored either**, in both directions: the CRM is a
record of correspondence, and a ticket that vanishes because someone tidied their
inbox is a worse outcome than one that lingers.

⚠️ A receive-only first release (Phases 1–6) ships with the reply divergence live. It
must be stated on the connect screen — "replies sent from your mail client will not
appear here yet" — not discovered.

## 6. Security posture

The estate's precedent for secrets is plaintext in a service-role-only table:
`xero_connections` (mig 029, carrying an explicit `TODO: layer pgcrypto-based
encryption later`) and `recon_mailboxes`, which copied it.

**That precedent does not transfer.** Those hold our own tokens for our own accounts.
This feature holds *customers'* mailbox passwords, and an IMAP app password is total
mailbox authority: read everything, send as them. A DB-level leak that costs us a Xero
re-auth would cost a customer their entire correspondence.

So: AES-256-GCM envelope encryption, key in a Vercel env var, following the existing
`src/lib/whatsapp-flow/crypto.js` idiom. Ciphertext carries a version prefix so the
key can be rotated. Not Supabase Vault — the key must not live in the database it
protects.

Other invariants:
- The secret column is **never** selected by any GET. Write-only from the operator's
  side; the UI shows connection *state*, never the value.
- Gate is `guardMailboxAdmin` (master or owner-at-location), the same gate as mailbox
  grants — whoever may grant access to a mailbox is exactly whoever may connect one.
- Every connect / disconnect / credential change writes an audit event.
- Mixed traffic is contained by the existing two-level access model, not a new
  concept. With zero `email_mailbox_access` grants a mailbox defaults to
  owner/master-only, which is the right posture for one carrying head-office mail.
- 🔴 GDPR contact erasure deliberately skips the email tables, so anything ingested
  here is permanent. That is a knowing trade, and it must be stated on the connect
  screen.

## 7. Explicitly not building (YAGNI)

OAuth / Graph / "Sign in with Google" · `[Gmail]/All Mail` sync · flag write-back or
read-state sync · folder or label mapping · historical backfill · IMAP IDLE (cron
polling is enough at */5) · a separate mail-client UI. Tickets remain the only surface.

---

## 8. Implementation plan

Twelve phases, 44 tasks. Each task is independently reviewable; each phase is
independently shippable.

Three natural releases:

| Release | Phases | What the operator gets |
|---|---|---|
| **R1 — receive** | 0–6, 9 | Connect any Gmail/IMAP account in location settings; its mail arrives as tickets. Replies still leave from the Postmark address, and replies sent from the mail client are not seen |
| **R2 — two-way** | 7–8 | Replies go out as the connected address, and replies sent from the mail client appear in the CRM |
| **R3 — platform** | 10–11 | Cutover, limits, tenant-isolation proof |

Phase 9 (health) rides with R1 deliberately: a connector that cannot say whether it is
working is the exact failure this codebase already has on record.

### Phase 0 — Feasibility gate *(Richard, no code)*

| | Task | Done when |
|---|---|---|
| 0.1 | Generate a Google app password on `hatchstreet@un1t.com` | A 16-character app password exists. Needs 2SV on the account and the Workspace admin not to have blocked app passwords |
| 0.2 | Confirm `stillorgan@un1t.com`'s stored credential still authenticates | `last_ok_at` has not moved since 2026-07-04; it is unproven, not known-good |

**0.1 blocks everything.** If app passwords are blocked org-wide, the whole approach
fails and we fall back to forwarding or a domain-wide-delegation ask.

### Phase 1 — Secrets at rest

| | Task | Notes |
|---|---|---|
| 1.1 | `src/lib/mail/secret-box.js` — AES-256-GCM `seal()` / `open()`, key from `MAILBOX_SECRET_KEY`, versioned ciphertext prefix | Pure, no DB, no clock. Unit-tested incl. tampered-ciphertext and wrong-key paths |
| 1.2 | Key generation + provisioning; rotation procedure in `INTEGRATIONS.md` | Missing key must fail **closed and loudly**, never fall back to plaintext |
| 1.3 | `src/lib/mail/auth-strategy.js` — resolve a credential row to `{ user, pass }` **or** `{ user, accessToken }` | The OAuth seam (§2.1). Call sites never see a raw password, so adding a provider later is a resolver change, not a surgery |

### Phase 2 — Schema

| | Task | Notes |
|---|---|---|
| 2.1 | Migration: `email_mailbox_credentials` — `mailbox_id` PK/FK, provider, `auth_type` (`password`\|`oauth`), imap host/port/secure, smtp host/port/secure, username, `secret_ciphertext`, nullable `oauth_*` token columns, `created_by`, timestamps. Service-role-only RLS | FK column must **lead** an index (the mig 496/497 lesson). `auth_type` + nullable token columns are the §2.1 seam — one column now beats a migration plus a credential backfill later |
| 2.2 | Migration: `email_mailbox_ingress` — cursor per mailbox: `uidvalidity`, `last_uid`, `last_ok_at`, `last_error`, `last_run_at`, `consecutive_failures` | Separate table from credentials: different write frequency, different sensitivity |
| 2.3 | Migration: `email_mailboxes.ingress` (`postmark`\|`imap`) and `.egress` (`postmark`\|`smtp`), both defaulting to `postmark` | Two columns, not one — receive-via-IMAP without send-as-SMTP is a valid state |
| 2.4 | Apply via Supabase MCP, then run **both** `get_advisors` types | Forward-only. Confirm the next free number against live `schema_migrations` first |

### Phase 3 — IMAP client

| | Task | Notes |
|---|---|---|
| 3.1 | `src/lib/mail/imap-connection.js` — configurable host/port/TLS, opens INBOX read-only | Deliberately **separate** from `recon/imap-client.js`. That file serves a live feature and hardcodes `[Gmail]/All Mail`; coupling ticketing to it risks the receipt hunt for no gain |
| 3.2 | `fetchNewMessages(client, { sinceUid, cap })` — UID-range search returning envelope + bodyStructure + selected headers | Fetch `references`, `in-reply-to`, `message-id` explicitly; imapflow's envelope omits References |
| 3.3 | 🔴 `imapMessageToInboundPayload()` — **pure**, IMAP message → Postmark-shaped payload | The heart of the feature. Test: display-form From, multi To/Cc, threading headers, missing Date, missing Message-ID, charset decoding, HTML-vs-text part selection, and the poison-text class `db-safe-text.js` exists for |

### Phase 4 — Attachments

| | Task | Notes |
|---|---|---|
| 4.1 | Stage IMAP parts to Storage via the existing `email-attachment-staging.js` marker contract | Share the contract, never re-derive it — the shim has a test that reads the file off disk for exactly this reason |
| 4.2 | Size caps and skip semantics matching the existing `skipped_reason` CHECK; meter via `add_email_storage_bytes` | Reserve-then-check, idempotent on `attachment_index` |

### Phase 5 — The poller

| | Task | Notes |
|---|---|---|
| 5.1 | `src/lib/mail/imap-poll.js` — poll one mailbox end to end; advance the watermark only on 2xx | Per-message isolation: one unparseable message must not stall the mailbox |
| 5.2 | Cron route `/api/cron/poll-imap-mailboxes` + `vercel.json` `*/5` | `CRON_SECRET` bearer, heartbeat, JSON summary — matches `run-sequences` |
| 5.3 | Multi-tenant loop: concurrency cap, per-mailbox try/catch, fair ordering by `last_run_at` | 🔴 One customer's broken mailbox must never delay another's |
| 5.4 | Cold-start anchoring — first run sets the watermark, ingests nothing | |
| 5.5 | Backoff: `consecutive_failures` → exponential skip → auto-pause with a loud surface | Auth failure after a password revoke is the #1 real-world failure mode |

### Phase 6 — Settings UI *(the SaaS surface)*

| | Task | Notes |
|---|---|---|
| 6.1 | `…/email/mailboxes/[mailboxId]/connection` route — POST / PUT / DELETE, `guardMailboxAdmin` | Live IMAP+SMTP verify **before** persist, mirroring `verifyMailboxLogin`. Secret never returned by any GET |
| 6.2 | `EmailMailboxesCard.jsx` — per-mailbox Connection section: provider preset, host/port, username, password, **Test connection**, state chip, Disconnect | Card is already 614 lines; extract the section into its own component rather than growing it |
| 6.3 | Provider presets — Gmail / Microsoft / Custom IMAP — with inline app-password instructions | This is the #1 support burden of every mailbox connector. Worth real copy |
| 6.4 | `logAuditEvent` on every connect / disconnect / credential change | |
| 6.5 | Connect-screen disclosure: mail ingested here is permanent and not erased by GDPR contact deletion | §5 |

### Phase 7 — Send as the connected address

| | Task | Notes |
|---|---|---|
| 7.1 | Add `nodemailer`; reasoned accept in the dependency audit | |
| 7.2 | `src/lib/mail/smtp-send.js` — same verdict envelope as the Postmark path, never throws | Mirrors `tenant-email.js`'s fail-safe shape |
| 7.3 | Transport branch in `email-inbox-send.js`, ahead of Postmark resolution | 🔴 Unverified-From fallback must not apply to SMTP |
| 7.4 | Delivery-status honesty: mark SMTP sends untracked; UI explains why no status will arrive | |
| 7.5 | Verify Gmail auto-files SMTP sends to Sent; IMAP APPEND only if it does not | Verify before building — a needless APPEND breaks the read-only posture |

### Phase 8 — Mail-client coexistence *(§5)*

The phase that stops the CRM lying about whether a member was answered.

| | Task | Notes |
|---|---|---|
| 8.1 | Poll the Sent folder alongside INBOX, on its own cursor | Gmail `[Gmail]/Sent Mail`; folder name is provider-specific, so it belongs in the provider preset |
| 8.2 | 🔴 `fileClientSentReply()` — write a client-sent reply as an **outbound** message on the threaded ticket | Cannot reuse the webhook: `processInboundEmail` writes `direction: 'inbound'` throughout. The one place the producer pattern does not carry us |
| 8.3 | Dedupe against our own SMTP sends on RFC Message-ID | We record ours at send time — exact match, not a heuristic |
| 8.4 | Bump the ticket, clear "needs reply", and **suppress** the inbound push | Nobody needs telling their colleague answered |
| 8.5 | Orphan handling: a client-sent reply whose thread we never ingested | Most likely on a mailbox connected mid-conversation. Log, do not conjure a ticket |
| 8.6 | Tests: reply-in-Gmail threads correctly · our own send is not double-filed · closed ticket reopens · no push fired | |

### Phase 9 — Health and monitoring

| | Task | Notes |
|---|---|---|
| 9.1 | Feed the poller's `last_ok_at` / `last_error` into the existing per-mailbox *Email (inbound)* health row | Derived from filed rows, never a self-reported stamp |
| 9.2 | 🔴 Retire the "mailbox asserts receiving works" lie — the card shows real state | Closes the standing audit finding; Stillorgan is the live reproduction |
| 9.3 | Alert on auth failure distinctly from transport failure | A revoked password is an operator action, not an outage |

### Phase 10 — Cutover

| | Task |
|---|---|
| 10.1 | Connect `hatchstreet@un1t.com`; verify end to end with a real send and a real reply |
| 10.2 | Connect `stillorgan@un1t.com`; retire its dead `is_default` Reply-To |
| 10.3 | `INTEGRATIONS.md` entry + operator runbook (connect, rotate, disconnect, diagnose) |

### Phase 11 — SaaS hardening

| | Task | Notes |
|---|---|---|
| 11.1 | Per-tenant limits: max connected mailboxes per location; poll fairness under load | |
| 11.2 | 🔴 Tenant-isolation test: two connected mailboxes at different locations, one failing auth, assert the other still ingests | The test that proves it is a platform and not a one-off |
| 11.3 | Credential lifecycle: disconnect on mailbox deactivate; what happens to stored mail on disconnect | Deactivation is already the removal path — no DELETE |

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| 🔴 App passwords blocked by the customer's Workspace admin | Phase 0 gate. Fallback is forwarding, or a domain-wide-delegation ask |
| Google deprecates app passwords for Workspace | Watch. `secret-box` + provider abstraction make an OAuth provider an addition, not a rewrite |
| `OriginalRecipient` precedence mis-routes a cross-addressed mail | Test pins it (§3.1) |
| Poller re-ingests after a UIDVALIDITY change | Re-anchor, never re-ingest; RFC Message-ID dedupe is the backstop |
| A large message exhausts function memory | bodyStructure-first, selective part download, size cap — the `MAX_PART_BYTES` pattern |
| Credential leak | §6 |
| ~~Staff reply in Gmail; CRM shows the ticket unanswered~~ | **CLOSED by Phase 8.** The Sent lane files it as an outbound message and clears needs-reply |

## 10. Decisions taken

- **OAuth: deferred, seam built now** (§2.1). Gmail's restricted scopes make it a
  verification-and-CASA project, not a sprint. Tasks 1.3 and 2.1 carry the seam.
- **Microsoft: unsupported at launch**, stated plainly in the UI. Exchange Online has
  no basic-auth IMAP, so it needs the OAuth work above. Microsoft-first is the cheaper
  OAuth if the business ever wants it.
- **Read-state and deletion are not synced** (§5). Only replies are.

## 11. Open questions

1. **Pricing/packaging** — is a connected mailbox a tier feature? Touches
   `sourceit-location-feature-gate`.
2. **Does the Sent poll cost double the IMAP round trips at */5?** Likely fine at this
   scale; measure before assuming, and consider polling Sent at a lower cadence.

---

## 12. What actually shipped — corrections found during the build

Phases 1–7 are built on branch `imap-mailbox-connector`. Recorded here because each
item below is a place the design above was **wrong**, and the wrongness was only
visible from inside the code.

**Three defects in the design's own pinned contracts.**

1. 🔴 **`syntheticMessageId` was not path-safe.** `imap:<uuid>:<rfc-id>` fails
   `PATH_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/` (`email-attachment-staging.js:81`) on the
   colons, the `@` and the dots — and that value becomes the staged-attachment object
   key. **Every** IMAP attachment would have degraded to `rehost_failed` with the bytes
   orphaned in a metered bucket. Now a hashed, path-safe form; §3.2 is corrected.
2. **`created_by` had no `ON DELETE` action**, so `NO ACTION` would have made a
   `profiles` delete raise — offboarding blocked by a foreign key to a provenance stamp.
   Now `ON DELETE SET NULL`, matching mig 485's `granted_by`. (`recon_mailboxes.created_by`,
   the row this was copied from, still carries the same latent bug.)
3. **nodemailer does NOT accept `{ user, accessToken }`.** It keys XOAUTH2 off
   `auth.type === 'OAuth2'` and otherwise drops the token into a LOGIN attempt. Verified
   by construction against 9.0.5. The SMTP transport adapts the shape at its own edge so
   `resolveAuth` stays transport-neutral. §2.1 is corrected.

**Two integration gaps — the feature would have shipped inert, then broken.**

4. **Nothing set `egress = 'smtp'`.** Phase 6 deliberately left the column alone, with
   correct reasoning that went stale the moment Phase 7 landed the transport. `egress`
   now follows the outgoing-server field: that optional field IS the opt-in, and a
   separate toggle could disagree with verified credentials sitting next to it.
5. 🔴 **SMTP replies would not have threaded.** The inbound webhook resolves a thread by
   matching against BOTH `rfc_message_id` and `postmark_message_id`. A Postmark send is
   covered by the second (Postmark embeds its API MessageID in the RFC id it mints); an
   SMTP send has no Postmark id by design, so it matched **neither**. Every customer
   reply would have forked a new ticket while the original sat unanswered. The three
   send routes now write `rfc_message_id`, as do their `sent_not_filed` dead-letter
   payloads, which are re-fileable records.

**Two traps found in the libraries, both silent.**

6. **imapflow types `uidValidity` as a BigInt**; PostgREST returns the column as a
   Number. `12345n !== 12345` would have re-anchored every tick and ingested nothing
   while every row and log said the poll succeeded — and `JSON.stringify` throws on a
   BigInt, so writing one back would have failed the cursor update.
7. **`downloadMany()` decodes transfer-encoding but not charset**; `download()` does
   both and unwraps RFC 3676 `format=flowed`. Gmail plain text is routinely
   format=flowed, and an iso-8859-1 body read as UTF-8 mojibakes every accented name.

**One deliberate exception to a rule stated absolutely above.**

8. §3.3 says the watermark advances only on a 2xx. **HTTP 400 is the exception.** The
   route 400s for exactly two byte-reproducible inputs (non-JSON body, missing
   `MessageID`), so a retry is guaranteed to fail identically and would park the mailbox
   behind one message forever, losing every email after it. 400 logs at error level,
   counts as skipped, and steps over. Every other non-2xx halts without advancing.

**One instruction in the plan that was wrong and was correctly overridden.** Task 4.2
said to meter bytes via `add_email_storage_bytes`. `storeOne()`
(`email-attachments-server.js:377`) already reserves for a staged attachment, so doing
it again would have billed every IMAP attachment twice and silently halved the mailbox's
5 GB quota. The Edge shim does not meter, for the same reason.

---

## 13. What Phase 8 corrected

**§5's "a reply reopens a closed ticket" does not apply to the Sent lane.** That rule
is about a MEMBER reply. A staff reply read out of the Sent folder files, bumps and
clears needs-reply, but leaves `status` alone — closing is internal bookkeeping, and
a colleague answering does not reopen what someone deliberately closed. §8.6's test
list said "closed ticket reopens" and was wrong.

**The needs-reply clear had to become STATE-GUARDED.** The plan said "clear needs
reply" flatly. The poller runs up to five minutes behind, so a member can genuinely
write again between a colleague's Gmail reply and our reading it — and an
unconditional `last_message_direction: 'outbound'` would then clear needs-reply on a
ticket where the member IS waiting. That is this phase's own failure, inverted. The
bump now applies only when the message is genuinely the ticket's newest, reusing the
inbound webhook's skew constant. The 23505 path re-runs the same guarded bump, or a
transient failure would strand a ticket saying "needs reply" with the answer inside it.

**There is no `needs_reply` column.** It is the derived predicate
`status = 'open' AND last_message_direction = 'inbound'`. Setting the direction IS
the clear, which is why leaving `status` alone still empties the queue and the badge.

🔴 **The delivery "quiet" branch was never rendered, and rendered a falsehood.** Both
platforms gated on `tone === 'quiet'` and then printed the hard-coded word
**"Delivered"** — so from the moment MAILBOX-CONNECT.7 merged, every SMTP-sent reply
would have claimed a confirmed delivery that by construction can never exist, while
the `detail` explaining why was dead text rendered nowhere. Nobody saw it: no mailbox
was connected, so no SMTP send had happened. **The class is the lesson** — a new
return shape was added to `deliveryMeta` and tested at the FUNCTION, while its only
consumer had assumed `quiet` could only ever mean `delivered`. 70+ passing tests all
asserted the object; none asserted what the thread printed.

**A client-sent reply's attachments are NOT recorded, deliberately.** `pollOpenFolder`
stages attachments into the METERED bucket before delivering, which is right for the
inbox lane (the webhook consumes the markers) and orphaning for the Sent lane, which
writes no attachment rows and has no discard path. The Sent lane therefore stages
nothing and logs a warning naming the count, so the gap is visible rather than
silent. `fileOutboundAttachments` plus the `messageId` on the `filed` verdict is the
shape for a later phase.

**Idempotency is `(ticket_id, rfc_message_id)`, never global.** A global unique index
on `rfc_message_id` is the obvious idea and would re-create the cross-tenant misfiling
the audit fixed: the connector deliberately files one copy per connected mailbox when
two are on the same thread, so one RFC id legitimately lands on two tickets. The
per-ticket index also dedupes our OWN SMTP sends for free — the send path already
wrote that id on that ticket, so the Sent copy hits 23505 and is skipped. One
mechanism, two jobs, no "is this ours?" comparison anywhere.

**`OriginalRecipient` is meaningless on the Sent lane.** `toInboundPayload` sets it to
the mailbox address, which reads as "the address that received this" for a message the
mailbox sent. Inert today — the Sent writer takes the mailbox directly and never reads
it — but do not trust that field on this lane.
