// CONTRACTS-REMIND.1 — Vercel cron, daily. Nudges contracts stuck at
// 'issued'/'viewed' with no signature: a reminder email + push at 3 days
// (1st) and 7 days (2nd, final) since issued_at, capped at 2 total. Mirrors
// the issue-time notification in POST /api/contracts (same email shell via
// contracts-email.js, same push shape via src/lib/push.js).
//
// Registration: mirrors the newest existing cron (expand-hyrox-weeks, mig
// 441 / HYROX-TC.3) — a plain vercel.json schedule entry with a Bearer
// CRON_SECRET guard, no QStash involved. QStash in this repo is reserved
// for queue-drain push acceleration (a queue TABLE gets a row, QStash
// pushes a worker to drain it immediately, with the cron as the delivery
// fallback — see src/lib/qstash.js); this cron has no backing queue table,
// it just polls `contracts` on a schedule like the majority of crons
// (glofox-arrears-reconcile, churn-radar-snapshot, notify-winback, etc.).
//
// The exact "is this due" predicate lives in reminderDue() (src/lib/
// contracts.js) so it's independently unit-tested. The SQL filters below
// are a coarse pre-filter only (status + not-yet-capped) — reminderDue()
// is still applied per-row as the authoritative client-side guard.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { reminderDue } from '@/lib/contracts'
import { sendContractReminderEmail } from '@/lib/contracts-email'
import { sendPush } from '@/lib/push'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const PAGE = 1000
const MAX_REMINDERS = 2

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()
  const now = new Date()

  // Candidate contracts — status in ('issued','viewed') and not yet at the
  // reminder cap. Paginated with an explicit .order() (1k-row cap
  // invariant): a busy org could plausibly exceed 1000 open contracts.
  const candidates = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('contracts')
      .select(`
        id, status, issued_at, reminder_count, location_id, profile_id,
        profile:profiles!profile_id (id, full_name, email),
        template:contract_templates!template_id (name)
      `)
      .in('status', ['issued', 'viewed'])
      .lt('reminder_count', MAX_REMINDERS)
      .order('issued_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) {
      console.error('[cron-contract-reminders] candidate query failed', error)
      break
    }
    candidates.push(...(data || []))
    if (!data || data.length < PAGE) break
  }

  let sent = 0
  let emailFailed = 0
  let rowErrors = 0

  for (const contract of candidates) {
    if (!reminderDue(contract, now)) continue

    try {
      const recipient = contract.profile
      const templateName = contract.template?.name

      const emailResult = await sendContractReminderEmail({
        contract,
        recipient: { full_name: recipient?.full_name, email: recipient?.email },
        templateName,
      })
      if (!emailResult.ok) emailFailed++

      // Push notification (best effort, never blocks) — mirrors the
      // issue-route's push block: category 'contract_issued', deep link
      // /contracts/<id>.
      try {
        if (recipient?.id) {
          await sendPush([recipient.id], {
            title: 'Contract awaiting signature',
            body: templateName
              ? `Reminder: "${templateName}" is still awaiting your signature. Tap to review and sign.`
              : 'Reminder: a contract is still awaiting your signature. Tap to review and sign.',
            category: 'contract_issued',
            data: {
              type: 'contract_issued',
              contract_id: contract.id,
              path: `/contracts/${contract.id}`,
            },
          })
        }
      } catch {
        // Push is non-blocking; intentionally swallow (mirrors the issue route).
      }

      const { error: updErr } = await db
        .from('contracts')
        .update({
          last_reminded_at: now.toISOString(),
          reminder_count: (contract.reminder_count || 0) + 1,
        })
        .eq('id', contract.id)
      if (updErr) {
        console.error('[cron-contract-reminders] failed to record reminder', contract.id, updErr)
        rowErrors++
        continue
      }

      sent++
    } catch (err) {
      // Row-level failure — log and move on, never abort the batch.
      console.error('[cron-contract-reminders] row failed', contract.id, err)
      rowErrors++
    }
  }

  await stampHeartbeat('contract-reminders', { checked: candidates.length, sent, emailFailed, rowErrors }).catch((err) =>
    logWarn('cron-contract-reminders', 'heartbeat failed', { err }))

  return NextResponse.json({ success: true, checked: candidates.length, sent, emailFailed, rowErrors })
}
