// Scoped ESLint flat config — the "guardrails" custom rules against the audit's
// recurring defect classes (1k-row cap, supabase-js thenable misuse). Run via
// `npm run check:guardrails`, wired into Web CI as its own step (like
// eslint.mobile-imports.config.mjs). ERROR-level: the point is to block the bug
// at PR time. Kept OUT of the main eslint.config.mjs so the main lint posture is
// unchanged. Design: docs/superpowers/specs/2026-06-25-guardrails-lint-design.md.

import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import nextPlugin from '@next/eslint-plugin-next'
import guardrails from './eslint-rules/index.mjs'

// HUBDOOR.3 removed the GLOBAL test ignore (a flat-config object carrying only
// `ignores` drops the file from EVERY later block, which would have hidden the
// test-only rule from the very files it exists to lint). The exclusion moved to
// a per-block `ignores` instead — which means it is now something each product
// block must OPT INTO, and a block added later that forgets it silently starts
// linting test files at ERROR. That already nearly happened once: BAREWRITE.1's
// `no-unchecked-supabase-write` block arrived from main with no `ignores` of its
// own (it did not need one then) and auto-merged textually clean.
// ANY product block below MUST carry `ignores: NO_TESTS`.
const NO_TESTS = ['**/*.test.js', '**/*.test.jsx']

const config = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'public/**',
      'mobile/**',
      'out/**',
      'dist/**',
      'build/**',
      // NOTE: test files are NOT ignored globally any more (HUBDOOR.3). A
      // flat-config object carrying only `ignores` drops the file from EVERY
      // block, which would have made `no-substring-redirect-assertion` — a
      // rule about test assertions — unrunnable. The product rules keep their
      // old scope via a per-block `ignores` instead; only the last block below
      // sees a test file, and only for that one rule.
    ],
  },
  {
    // shared/ is the web/mobile data seam — full of Supabase fetchers, so the
    // same defect classes (1k-row cap, Dublin-time parsing) apply there too.
    files: ['src/**/*.{js,jsx}', 'shared/**/*.js'],
    ignores: NO_TESTS,
    // react-hooks + @next/next are registered with NO rules enabled, only so the
    // inline `// eslint-disable react-hooks/*` / `@next/next/*` comments in the
    // components don't trip "Definition for rule not found" under this standalone
    // config (same trick as eslint.mobile-imports.config.mjs). We run none of
    // their rules — just the two guardrails rules below.
    plugins: { guardrails, 'react-hooks': reactHooks, '@next/next': nextPlugin },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'guardrails/no-catch-on-supabase-builder': 'error',
      'guardrails/no-uncapped-supabase-limit': 'error',
      'guardrails/no-zulu-template-date': 'error',
      'guardrails/no-utc-today': 'error',
      'guardrails/no-low-contrast-chip': 'error',
      // Repo-wide, unlike its per-path sibling below: a dead token is dead on
      // every surface, light or dark, so there is no area to survey first.
      'guardrails/no-dead-un1t-token': 'error',
      'guardrails/no-unescaped-ilike-pattern': 'error',
      'guardrails/no-untyped-button-in-form': 'error',
      'guardrails/no-discarded-single-error': 'error',
    },
  },
  {
    // COMMSLAYOUT.6 — `guardrails/no-low-contrast-accent-text` is armed
    // PER-PATH, not repo-wide. The rule cannot see what surface a class renders
    // on (see its doc comment), so the only honest scope is "areas whose
    // surfaces have actually been surveyed and cleaned". Repo-wide it would
    // need ~500 sites audited, an unknown share of which are correct
    // dark-surface idiom — and an allowlist of individual violations would rot.
    //
    // This list is the Communications area: its route trees, the components
    // that only ever render inside them, and the ten root-level components its
    // pages import. Every one was scanned to zero at ERROR before this landed,
    // with the two genuine dark islands (the `bg-black` HTML-source textareas
    // in CampaignEditor/TemplateEditor) passing on the rule's same-string
    // escape rather than a disable comment.
    //
    // TO ARM ANOTHER AREA: clean it, then add its path here. One line.
    files: [
      'src/app/communications/**',
      'src/app/email/templates/**',
      'src/app/whatsapp/templates/**',
      'src/components/communications/**',
      'src/components/tickets/**',
      // Root-level components rendered by the Communications pages. Named
      // individually because src/components/ as a whole is the entire app.
      'src/components/CampaignDetail.jsx',
      'src/components/CampaignEditor.jsx',
      'src/components/SMSBroadcastEditor.jsx',
      'src/components/SavedSegmentsList.jsx',
      'src/components/SegmentsGrid.jsx',
      'src/components/TemplateEditor.jsx',
      'src/components/UnifiedInbox.jsx',
      'src/components/WABroadcastEditor.jsx',
      'src/components/WATemplateEditor.jsx',
      'src/components/WhatsappTemplatesList.jsx',
    ],
    ignores: NO_TESTS,
    plugins: { guardrails },
    rules: {
      'guardrails/no-low-contrast-accent-text': 'error',
    },
  },
  {
    // BAREWRITE.1 — `guardrails/no-unchecked-supabase-write` is armed PER-PATH,
    // for the same reason no-low-contrast-accent-text above is: an ERROR-level
    // repo-wide rule only works on a clean baseline, and this one's baseline is
    // not clean.
    //
    // NO CENSUS FIGURE IS PUBLISHED HERE, AND THAT IS DELIBERATE. Four
    // successive revisions of PR #1472 quoted a repo-wide site count; every one
    // of them was a different number, none survived an independent re-run, and
    // one of them reached CLAUDE.md. A count that a reader cannot reproduce is
    // not evidence, it is folklore that hardens into an invariant — this estate
    // already had one saying "BOTH" when there were four allowlists, and that
    // wording is why the defect it described kept coming back. So the only
    // figure this file will ever state is the one your own run prints.
    //
    // TO MEASURE A PATH (and it is the same command the gate runs, so the two
    // can never disagree): add the path to the `files` list below and run
    //
    //     npm run check:guardrails
    //
    // Every remaining site in that path is then printed, with file and line.
    // Grep is not a substitute — multi-line chains are the house style here, so
    // a regex undercounts this class badly; the rule reads the AST.
    //
    // TO ARM A PATH: measure it as above, drive it to zero, and leave its line
    // in the list. Same one-line ratchet as the accent-text list.
    //
    // ARM BY DANGER, NOT BY CONVENIENCE. The most dangerous remaining sites are
    // the least visible ones: a bare write inside a `try { … } catch { … }`
    // whose catch cannot fire for it, because a supabase builder resolves with
    // `{ data, error }` rather than throwing. Those read as handled, which is
    // how whatsapp-consent.js shipped a STOP path that answered `applied: true`
    // and texted "You've been unsubscribed" on a write that had failed, and
    // survived two audits doing it.
    //
    // Armed at BAREWRITE.1 = the campaign send path and its cron, the
    // event/race comms path, staff creation, the Instagram inbox, and the
    // WhatsApp inbound webhook; later entries carry their own comment.
    //
    // NOT ARMED, stated plainly rather than left as an omission:
    //
    //  • `mobile/**` is outside this config entirely (it has its own linters),
    //    so the member auto-link fix in mobile/lib/member/contact-context.jsx is
    //    protected by a source-scanning test, not by this rule.
    //
    //  • `src/lib/whatsapp.js`. This is the file whose drip path this PR
    //    hardened, so leaving it unarmed is a real gap and worth naming: a new
    //    bare write in sendDripChunk would not be caught. It stays unarmed
    //    because its remaining sites are NOT the mechanical log-it kind the
    //    webhook route's were. The blast sender's promote/park writes on
    //    `whatsapp_broadcast_recipients` need exactly the claim-vs-duplicate
    //    judgement `claimDripRecipient` and race-confirmations' stamp ordering
    //    have now been through twice, and that judgement is a follow-up with
    //    its own tests, not a mechanical sweep stapled to a PR already reviewed
    //    four times for over-correcting. Do it next; the ordering question is
    //    the same one, with the same default: never trade a possible duplicate
    //    for a certain silent loss.
    files: [
      'src/lib/campaign-sender.js',
      'src/app/api/cron/run-campaigns/route.js',
      'src/lib/race-confirmations.js',
      'src/lib/event-comms-location.js',
      'src/lib/event-attendee-reminders.js',
      'src/lib/host-events.js',
      // The WhatsApp STOP/START path — found in the residue sweep, and worse
      // than any of the sites this PR set out to fix. Both of its paths wrote
      // the three consent rows (audience flag, wa_status, consent_log) as bare
      // awaits inside a try/catch that CANNOT fire for a supabase result, so a
      // failed opt-out still answered `applied: true` and told the customer
      // "You've been unsubscribed" while they stayed in every marketing
      // audience.
      'src/lib/whatsapp-consent.js',
      // The inbound WhatsApp webhook — the caller of that consent path, cleaned
      // to zero here. Every one of its writes is LOGGED, never surfaced and
      // never failed on: Meta disables a subscription that stops answering
      // 2xx, so nothing in this handler may refuse, and each of these writes
      // loses a record rather than a message. Logging is the whole win here —
      // the consent bug lived in this file's blast radius for months precisely
      // because its writes looked handled and reported nothing.
      'src/app/api/webhooks/whatsapp/route.js',
      'src/app/api/staff/route.js',
      'src/app/api/instagram/**',
      'src/app/api/registrations/**',
      // SONOSAPPLY.4 — apply.js is the single write site for the open stamp,
      // exactly the class this rule exists for: a stamp that silently fails
      // leaves the music playing with no record, and the cron re-opens it
      // (restarting the playlist) every tick until the write lands.
      'src/lib/sonos/**',
      // SHELLY.9 — new area, clean by construction. The reconcile's
      // last_applied stamps and the (PR 2) toggle/connection writes are
      // exactly the kind that would otherwise report success on a failed
      // write. Armed from day one; PR 2 adds 'src/app/api/shelly/**'.
      'src/lib/shelly/**',
      'src/app/api/cron/shelly-reconcile/route.js',
      // SHELLY-UI.3 — the /api/shelly/* surface, armed with its FIRST route
      // rather than at the end of the PR (Task 9 had scheduled it): a
      // write-side rule that lands after the writes it governs can only ever
      // audit them, and the connection route's upsert is precisely the shape
      // it exists for — a failed link that answers `{ success: true }` and a
      // green "Connected" chip over a studio whose cron has no credential.
      'src/app/api/shelly/**',
      // TPLSYNC.1 — the WhatsApp template sync. Its per-row upsert was the
      // textbook shape: two bare writes inside a try/catch that cannot fire for
      // them, so a refresh that persisted NOTHING still returned a clean list of
      // the stale rows it had just failed to replace. That is how the send
      // preview offered a body and a Flow button months out of date while the
      // approved template said otherwise. Driven to zero here, so armed.
      'src/app/api/whatsapp/templates/route.js',
      // MAILFIX-GUARDRAILS.1 — the Mail area. It absorbed 17 write-heavy PRs
      // with nothing under it armed, and its writes are mostly BOOKKEEPING
      // AFTER A CUSTOMER-FACING SEND (reply/compose/forward file the message,
      // stamp the ticket, log the send) — exactly the shape where a bare write
      // leaves the member with the mail and the thread saying needs-reply,
      // with no log line to explain the stuck flag. Every fix here is
      // log-and-continue: the send already happened, so nothing below may
      // refuse, throw or return early for it (CLAUDE.md, BAREWRITE doctrine).
      // Every /api/email route: tickets (reply/compose/forward/merge/read/
      // participants/link-contact), the mail lane (seen/archive/_writeback),
      // attachments, oauth callback, and the conversations 410-Gone shims
      // (EMAIL-CONV-STOP.1 — no writes, armed by the glob, listed so the next
      // reader does not assume the glob was narrowed).
      'src/app/api/email/**',
      // The inbound webhook. Postmark disables a hook that stops answering
      // 2xx, so nothing here may refuse either — a lost write here loses a
      // record (a thread stamp, a participant row), never the message.
      'src/app/api/webhooks/postmark-inbound/**',
      // IMAP poll/writeback, the sent lane, OAuth token refresh: the ingest
      // side files rows and stamps cursors — a silently failed cursor stamp
      // re-ingests the same mail every tick.
      'src/lib/mail/**',
      // Top-level lib modules that WRITE mail-area tables (email_tickets,
      // email_inbox_messages, email_ticket_attachments, email_storage_usage),
      // found by grep: attachment storage/prune accounting, the delivery
      // status writeback, outbound + forwarded attachment rows. Read-only mail
      // helpers (email-tickets, email-recipients, email-inbox, …) have no
      // writes and are not listed; postmark.js and the postmark-webhook
      // processor are the campaign transport, not this area.
      'src/lib/email-attachments-server.js',
      'src/lib/email-delivery-status.js',
      'src/lib/email-outbound-attachments-server.js',
      'src/lib/email-forward-server.js',
      // MAIL-GDPR.1 — contact erasure's mail scrub. Writes all three mail
      // tables + the storage counter; born clean, armed on arrival.
      'src/lib/contact-mail-erasure.js',
    ],
    ignores: NO_TESTS,
    plugins: { guardrails },
    rules: {
      'guardrails/no-unchecked-supabase-write': 'error',
    },
  },
  {
    // Genuinely DARK surfaces — TV boards + the presentation screen render on
    // black; low text ramps are the correct idiom there, so the light-theme
    // chip-contrast rule does not apply. The public event booking flow
    // (register / checkout / confirmation / embed) was reskinned to the dark
    // UN1T brand (EVENTS-RESKIN.1), so it joins the same exemption. The host
    // self-serve portal (HOST-PORTAL.3) is a bg-black host surface too — its
    // layout, login, set-password and event form all render white-on-black.
    files: [
      'src/app/tv/**', 'src/app/present/**', 'src/components/RaceDisplayBoard.jsx',
      'src/app/event/**', 'src/app/event-pay/**', 'src/app/embed/event/**',
      'src/components/RaceSignupWidget.jsx',
      'src/components/RaceConfirmedPage.jsx',
      'src/components/RaceCheckoutPage.jsx',
      'src/app/host/**', 'src/components/host/**',
    ],
    plugins: { guardrails },
    rules: {
      'guardrails/no-low-contrast-chip': 'off',
    },
  },
  {
    // HUBDOOR.3 — the ONE block that lints test files, for the ONE rule that
    // is about a test assertion. `toThrow('NEXT_REDIRECT:/…')` is a substring
    // match against a namespace of prefix-shaped paths, so it goes green
    // against redirects it was never meant to accept — the Operations hub
    // fallback suite passed on '/admin/fleet' for weeks that way. Every
    // product rule above is scoped to exclude tests, so nothing else changes
    // shape by test files becoming visible to this config.
    files: ['**/*.test.js', '**/*.test.jsx'],
    plugins: { guardrails },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'guardrails/no-substring-redirect-assertion': 'error',
    },
  },
]


export default config
