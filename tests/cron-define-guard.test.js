// CRONWRAP.1 — every new scheduled job uses defineCron (src/lib/define-cron.js),
// which owns the secret check, the error boundary and the heartbeat rule.
//
// LEGACY lists the jobs written before it. The list only shrinks: moving a job
// onto defineCron means deleting its name here, and adding a name is the wrong
// fix for a failure in this file.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { stripComments } from './helpers/js-code.js'

const ROOT = path.resolve(import.meta.dirname, '../src/app/api/cron')
const LEGACY = new Set([
  'ad-insights-backfill', 'ad-insights-sync', 'ad-report-email',
  'agent-followups', 'auto-end-stale-hr-sessions',
  'churn-radar-digest', 'churn-radar-snapshot',
  'class-fees',
  'contact-studios-reconcile', 'contract-reminders', 'credit-attendance',
  'event-reminders',
  'glofox-arrears-reconcile', 'glofox-attendance-history', 'glofox-attendance-refresh',
  'glofox-data-quality', 'glofox-detail-backfill', 'glofox-sync', 'health-check',
  'instagram-feed-sync',
  'membership-snapshot', 'mia-purchase-intents', 'morning-briefing',
  'notify-onboarding-pace', 'notify-streak-at-risk', 'notify-winback', 'person-detect-scan',
  'poll-imap-mailboxes', 'process-class-bookings', 'process-contact-imports',
  'process-invoice-analysis', 'process-postmark-webhooks', 'process-receipt-hunts',
  'process-trial-purchases', 'race-timing-events',
  'repeat-bounce-sweep', 'revolut-reconcile', 'run-campaigns',
  'run-challenge-events', 'run-scheduled-reports', 'run-sequences', 'run-strava-exports',
  'run-whatsapp-broadcasts', 'send-class-booking-reminders', 'send-host-campaigns',
  'send-push-reminders', 'shelly-reconcile', 'stripe-connect-apple-pay-domains',
  'sync-class-occurrences', 'un1t-online-sync',
  'wallet-monthly-reset', 'wallet-overage-draws', 'webhook-replay', 'zoom-contact-sync',
])

const jobs = readdirSync(ROOT, { recursive: true })
  .map(String)
  .filter((f) => path.basename(f) === 'route.js')
  .map((f) => ({ name: path.dirname(f), src: readFileSync(path.join(ROOT, f), 'utf8') }))
const usesWrapper = (src) => src.includes("from '@/lib/define-cron'") && /export const GET = defineCron\(/.test(src)

describe('scheduled jobs use defineCron', () => {
  it('finds the jobs', () => {
    expect(jobs.length).toBeGreaterThan(90)
  })

  it('every job outside the legacy list uses it', () => {
    expect(jobs.filter((j) => !LEGACY.has(j.name) && !usesWrapper(j.src)).map((j) => j.name)).toEqual([])
  })

  it('a wrapped job declares how long it may run', () => {
    const missing = jobs.filter((j) => usesWrapper(j.src) && !/export const maxDuration = \d+/.test(j.src))
    expect(missing.map((j) => j.name)).toEqual([])
  })

  it('a wrapped job leaves the secret and the heartbeat to the wrapper', () => {
    const handRolled = jobs.filter((j) => usesWrapper(j.src) && /CRON_SECRET|stampHeartbeat\(/.test(stripComments(j.src)))
    expect(handRolled.map((j) => j.name)).toEqual([])
  })

  it('the legacy list only names jobs that still need moving', () => {
    const byName = new Map(jobs.map((j) => [j.name, j]))
    expect([...LEGACY].filter((n) => !byName.has(n) || usesWrapper(byName.get(n).src))).toEqual([])
  })
})
