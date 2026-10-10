// W1.S* — the UN1T literal sweep guard (SaaS Wave 1, Track S).
//
// A second gym's customers and staff must never read "UN1T". Every sweep PR
// appends the files it cleaned to SWEPT below; from then on a reintroduced
// literal in any of them fails here, so the sweep cannot rot one PR at a time.
//
// What counts: a `UN1T` outside comments. Rows the plan's appendix marks
// `keep` (UN1T-specific by design — legal pages, /offers, master-only toggles)
// are allow-listed per file in KEEP, as the exact literal, so a NEW literal
// in a kept file still fails.
//
// Created by W1.S4 (shared/ seam + its src/lib twins). W1.S1a–S3 and S5
// append their own rows; the list is the sweep's ledger.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from './helpers/js-code.js'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')

// Files swept so far. Keep the list sorted by task so a reviewer can see
// which PR owns a row.
const SWEPT = [
  // ── W1.S4: shared/ seam + src/lib twins ──────────────────────────────────
  'shared/challenge-wrapped.js',
  'shared/customer-notifications.js',
  'shared/goals.js',
  'shared/hr-analytics.js',
  'shared/permissions.js',
  'shared/session-history.js',
  'src/lib/customer-notifications.js',
  'src/lib/goals.js',
  'src/lib/hr-analytics.js',
  // ── W1.S3: Mia, WhatsApp merge, assistant, hyrox ─────────────────────────
  'src/lib/agent/core.js',
  'src/lib/agent/default-copy.js',
  'src/lib/agent/welcome-greeting.js',
  'src/lib/agent/prompt.js',
  'src/lib/agent/approval-suggest.js',
  'src/lib/agent/followups.js',
  'src/lib/agent/auto-reply.js',
  'src/lib/churn-winback.js',
  'src/lib/whatsapp.js',
  'src/lib/sequences/steps.js',
  'src/lib/communications/compose.js',
  'src/components/WABroadcastEditor.jsx',
  'src/app/api/settings/customer-agent/route.js',
  'src/app/settings/customer-agent/CustomerAgentClient.jsx',
  'src/lib/assistant-prompt.js',
  'src/lib/hyrox/prompt.js',
  'src/lib/hyrox/expand-runner.js',
  'src/lib/hyrox/generate-block.js',
  'src/app/api/hyrox/blocks/[id]/expand/route.js',
  'src/app/api/hyrox/sessions/[id]/regenerate/route.js',
  // ── W1.S1c: host portal + host emails ────────────────────────────────────
  // The org a host belongs to (event_hosts.organization_id, which is its
  // anchor location's org) speaks in the portal and the host emails; money
  // rails (booking fee, CSV fee column, the shared Postmark stream) are the
  // platform's (PLATFORM_NAME). login/set-password moved their client bodies
  // into HostLoginForm/HostSetPasswordForm so page.js can resolve the brand.
  'src/app/host/(portal)/layout.js',
  'src/app/host/(portal)/page.js',
  'src/app/host/(portal)/events/new/page.js',
  'src/app/host/(portal)/events/[id]/edit/page.js',
  'src/app/host/login/page.js',
  'src/app/host/login/HostLoginForm.jsx',
  'src/app/host/set-password/page.js',
  'src/app/host/set-password/HostSetPasswordForm.jsx',
  'src/app/host-connect/[token]/page.js',
  'src/components/HostConnect.jsx',
  'src/app/api/public/host-connect/[token]/route.js',
  'src/components/host/HostEmailReport.jsx',
  'src/components/host/HostEventActions.jsx',
  'src/components/host/HostEventForm.jsx',
  'src/lib/host-onboarding-email.js',
  'src/lib/host-campaign-launch.js',
  'src/app/api/host/emails/[id]/send-test/route.js',
  'src/app/api/host/emails/[id]/schedule/route.js',
  'src/app/api/host/events/[id]/route.js',
  'src/lib/host-statements.js',
  'src/app/api/hosts/[id]/invite/route.js',
  'src/app/api/hosts/[id]/link-staff/route.js',
  'src/app/api/hosts/[id]/route.js',
  // ── W1.S2: staff chrome + staff emails ───────────────────────────────────
  'src/app/account/contracts/page.js',
  'src/app/account/page.js',
  'src/app/api/account/pending-contracts/route.js',
  'src/app/api/email/conversations/_gone.js',
  'src/app/login/page.js',
  'src/app/reset-password/page.js',
  'src/app/settings/hosts/page.jsx',
  'src/app/settings/scoring/ScoringClient.jsx',
  'src/components/AchievementsAdminTable.jsx',
  'src/components/AddOrganizationButton.jsx',
  'src/components/AppShell.jsx',
  'src/components/BrandingSettings.jsx',
  'src/components/CampaignDetail.jsx',
  'src/components/CampaignEditor.jsx',
  'src/components/ChallengeForm.jsx',
  'src/components/ContractSignForm.jsx',
  'src/components/ContractTemplateForm.jsx',
  'src/components/LocationForm.jsx',
  'src/components/OrgBrandingSettings.jsx',
  'src/components/PendingContractsAlert.jsx',
  'src/components/RaceControlPanel.jsx',
  'src/components/RaceEventForm.jsx',
  'src/components/Sidebar.jsx',
  'src/components/WidgetTokensCard.jsx',
  'src/components/accounting/EventFeesCard.jsx',
  'src/components/settings/HostDetail.jsx',
  'src/components/settings/HostsManager.jsx',
  'src/components/settings/StatusPageSettingsForm.jsx',
  'src/components/settings/integrations/PaymentsIntegrationTab.jsx',
  'src/components/use-location-brand.js',
  'src/lib/contractor-invoice-email.js',
  'src/lib/glofox-notes.js',
  'src/lib/openapi.js',
  'src/lib/roster-email.js',
  'src/lib/settings-tree.js',
  'src/lib/wallet-topup.js',
  'src/lib/xero/bills-email.js',
  'src/lib/xero/contractor-bills.js',
  'src/lib/xero/fte-expense-claims.js',
  'src/lib/zoom/external-contacts.js',
  // ── W1.S5: mobile/ screens (Appendix B, 34 bundled rows + login) ────────
  'mobile/app/(member)/(tabs)/home.jsx',
  'mobile/app/(member)/(tabs)/progress.jsx',
  'mobile/app/(member)/(tabs)/sessions.jsx',
  'mobile/app/(member)/account/connect-apple-health.jsx',
  'mobile/app/(member)/account/goals.jsx',
  'mobile/app/(member)/account/notifications.jsx',
  'mobile/app/(member)/challenges.jsx',
  'mobile/app/(member)/live.jsx',
  'mobile/app/(member)/sessions/[id].jsx',
  'mobile/app/(member)/sessions/[id]/wrapped.jsx',
  'mobile/app/(member)/wrapped/challenge/[id].jsx',
  'mobile/app/(member)/wrapped/month.jsx',
  'mobile/app/(staff)/(auth)/login.jsx',
  'mobile/app/(staff)/assistant/index.jsx',
  'mobile/app/(staff)/contracts/[id].jsx',
  'mobile/app/(staff)/contracts/index.jsx',
  'mobile/app/(staff)/races/scan.jsx',
  'mobile/components/member/BoardsPanel.jsx',
  'mobile/components/member/ProfileSetupWizard.jsx',
  'mobile/lib/member/use-member-brand.js',
  // ── W1.S1a: customer-facing email and message libs ──────────────────
  'src/lib/event-email.js',
  'src/lib/event-attendee-reminders.js',
  'src/lib/event-waitlist.js',
  'src/lib/hr-post-class-email.js',
  'src/lib/race-confirmations.js',
  'src/lib/offer-purchase-emails.js',
  'src/lib/manual-booking-confirm.js',
  'src/lib/class-booking-payments.js',
  'src/lib/contract-pdf.js',
  'src/lib/contracting-entity.js',
  'src/lib/contracts-email.js',
  'src/lib/contracts-notify.js',
  'src/app/api/contracts/[id]/resend/route.js',
  'src/lib/external-export.js',
  'src/lib/strava.js',
  'src/lib/tcx-builder.js',
  'src/app/api/cron/auto-end-stale-hr-sessions/route.js',
  'src/lib/challenge-notifications.js',
  'src/app/api/cron/run-challenge-events/route.js',
  'src/lib/sequence-templates.js',
  'src/lib/postmark.js',
  'src/lib/campaign-sender.js',
  'src/lib/campaign-web-view.js',
  'src/lib/status-page.js',
]

// W1.S5 — the login placeholder is lower-case (`you@un1t.ie`), which the
// UN1T regex above never sees; pin it by name so it cannot come back either.
const LOWERCASE_SWEPT = {
  'mobile/app/(staff)/(auth)/login.jsx': [/un1t\.ie/, /un1tdublin\.com/],
}

// file → exact literals the appendix marks `keep`. None in W1.S4, W1.S3 or
// W1.S1c (src/lib/brands.js:151, the un1t-hosts brand description, is a
// keep row that W1.S1c leaves unswept rather than listing a whole file).
const KEEP = {
  // ── W1.S2: staff chrome + staff emails ───────────────────────────────────
  // wallet-topup.js — the platform IS the seller of a wallet top-up, so the
  // VAT invoice names the platform's own trading entity (Wave 2 moves money
  // rails to the org).
  'src/lib/wallet-topup.js': ['(trading as UN1T Dublin)'],
  // W1.S1a — LEGACY_COUNTERSIGNATURE_ENTITY: the counterparty every contract
  // issued before LEGALENT.1 was issued and signed under. An executed
  // document must keep rendering what it said; rewriting it is tampering,
  // not a sweep (appendix row contracting-entity.js:57, `keep`).
  'src/lib/contracting-entity.js': ['UN1T Dublin Ltd'],
}

describe('UN1T literal sweep (W1.S*)', () => {
  it.each(SWEPT)('%s carries no customer/staff-visible UN1T literal', (file) => {
    const src = stripComments(readFileSync(join(repo, file), 'utf8'), file)
    const allowed = KEEP[file] || []
    const stripped = allowed.reduce((s, lit) => s.split(lit).join(''), src)
    const hits = stripped
      .split('\n')
      .map((line, i) => (/UN1T/.test(line) ? `${file}:${i + 1}: ${line.trim()}` : null))
      .filter(Boolean)
    expect(hits, `reintroduced UN1T literal(s):\n${hits.join('\n')}`).toEqual([])
  })

  it('every KEEP entry names a swept file and a literal that still exists', () => {
    for (const [file, lits] of Object.entries(KEEP)) {
      expect(SWEPT, `${file} is in KEEP but not SWEPT`).toContain(file)
      const src = readFileSync(join(repo, file), 'utf8')
      for (const lit of lits) expect(src, `${file} no longer contains kept literal ${lit}`).toContain(lit)
    }
  })
  it.each(Object.entries(LOWERCASE_SWEPT))('%s carries no lower-case UN1T hostname', (file, patterns) => {
    const src = stripComments(readFileSync(join(repo, file), 'utf8'), file)
    for (const re of patterns) expect(src, `${file} still carries ${re}`).not.toMatch(re)
  })
})
