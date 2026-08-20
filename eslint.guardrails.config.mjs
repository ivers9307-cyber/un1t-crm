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
      '**/*.test.js',
      '**/*.test.jsx',
    ],
  },
  {
    // shared/ is the web/mobile data seam — full of Supabase fetchers, so the
    // same defect classes (1k-row cap, Dublin-time parsing) apply there too.
    files: ['src/**/*.{js,jsx}', 'shared/**/*.js'],
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
    // MEASURED by running THIS RULE over `src/**/*.{js,jsx}` + `shared/**/*.js`
    // (test files excluded), so the baseline and the gate can never drift apart
    // — grep undercounts this class several-fold, because multi-line chains are
    // the house style, so a regex was never going to answer it. Re-measure by
    // pointing an eslint config with only this rule at those globs.
    //
    //                                  origin/main      this branch
    //   bare (nothing bound)                 542              490
    //   destructured without `error`          40               38
    //   TOTAL                                582              528
    //   files                                264              253
    //
    // Of the 528 that remain, both figures reproducible from the same run:
    //    41  write to a log/telemetry table (activities, consent_log,
    //        impersonation_log, glofox_sync_runs, recon_*, audit_log,
    //        webhook_events) — a lost write costs an audit line, not
    //        behaviour. The nearest thing to "genuinely fire-and-forget" the
    //        population has, and it is under 8% of it.
    //   149  sit within 80 lines of a `success: true` in the same file — the
    //        caller reports success on a write it never checked.
    // So the "it's all harmless fire-and-forget" reading does not survive
    // measurement. Fixing all 528 in one PR would be ~528 mechanical edits
    // mixed with the behavioural ones — unreviewable, and the behavioural ones
    // are the point.
    //
    // ARM IN THIS ORDER. The most dangerous subclass is not the most visible
    // one: a large share of the remaining bare writes sit INSIDE a
    // `try { … } catch { … }` whose catch cannot fire for them, because a
    // supabase builder resolves with `{ data, error }` rather than throwing.
    // Those read as handled, which is why whatsapp-consent.js survived two
    // audits. Biggest concentrations today (rule output, 2026-08-20):
    // postmark-webhook-processor.js 21, whatsapp.js 20, agent/auto-reply.js 12,
    // public/events/[slug]/register 10, sequences/scheduler.js 10,
    // sequences/steps.js 9, recon/hunt.js 8,
    // whatsapp/conversations/[id]/add-contact 7, external-export.js 7,
    // person-links.js 7.
    //
    // TO ARM ANOTHER PATH: clean it (run `npm run check:guardrails` with the
    // path added and drive it to zero), then add its line here. Same one-line
    // ratchet as the accent-text list.
    //
    // Armed today = the paths this PR cleaned: the campaign send path and its
    // cron, the event/race comms path, staff creation, the Instagram inbox, and
    // the WhatsApp inbound webhook.
    //
    // NOT ARMED, stated plainly rather than left as an omission:
    //
    //  • `mobile/**` is outside this config entirely (it has its own linters),
    //    so the member auto-link fix in mobile/lib/member/contact-context.jsx is
    //    protected by a source-scanning test, not by this rule.
    //
    //  • `src/lib/whatsapp.js` — 20 sites, measured with the rule itself on
    //    2026-08-20. This is the file BAREWRITE.2 hardened the drip path in, so
    //    leaving it unarmed is a real gap and worth naming: a new bare write in
    //    sendDripChunk would not be caught. It stays unarmed because its
    //    remaining sites are NOT the mechanical log-it kind the webhook route's
    //    were. The blast sender's promote/park writes
    //    (whatsapp_broadcast_recipients around L1250/L1291) need exactly the
    //    claim-vs-duplicate judgement `claimDripRecipient` and
    //    race-confirmations' stamp ordering just went through twice, and that
    //    judgement is a follow-up with its own tests — not 20 edits stapled to a
    //    PR that has already been reviewed three times for over-correcting.
    //    Do it next; the ordering question is the same one, with the same
    //    default: never trade a possible duplicate for a certain silent loss.
    files: [
      'src/lib/campaign-sender.js',
      'src/app/api/cron/run-campaigns/route.js',
      'src/lib/race-confirmations.js',
      'src/lib/event-comms-location.js',
      'src/lib/event-attendee-reminders.js',
      'src/lib/host-events.js',
      // The WhatsApp STOP/START path. Not one of the six — found in the
      // residue sweep, and worse than any of them: six bare writes inside a
      // try/catch that could not fire for a supabase result, so a failed
      // opt-out still answered `applied: true` and told the customer "You've
      // been unsubscribed" while they stayed in every marketing audience.
      'src/lib/whatsapp-consent.js',
      // The inbound WhatsApp webhook — the caller of that consent path, cleaned
      // to zero in BAREWRITE.4 (11 sites). Every one is LOGGED, never surfaced
      // and never failed on: Meta disables a subscription that stops answering
      // 2xx, so nothing in this handler may refuse, and each of these writes
      // loses a record rather than a message. Logging is the whole win here —
      // the consent bug lived in this file's blast radius for months precisely
      // because its writes looked handled and reported nothing.
      'src/app/api/webhooks/whatsapp/route.js',
      'src/app/api/staff/route.js',
      'src/app/api/instagram/**',
      'src/app/api/registrations/**',
    ],
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
]

export default config
