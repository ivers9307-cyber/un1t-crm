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
  // ── W1.S1a: customer-facing email, ICS and message libs ──────────────────
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

// file → exact literals the appendix marks `keep`. None in W1.S4 or W1.S3.
// Every entry carries its reason in the comment above it.
const KEEP = {
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
})
