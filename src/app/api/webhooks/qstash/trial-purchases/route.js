// PAIDTRIAL.1 — QStash push-delivery worker for trial_purchases. Same
// contract as the class-bookings worker: verify the Upstash signature,
// re-fetch the row, run it through the claim CAS shared with the
// process-trial-purchases cron. 200 for every terminal decision or a lost
// race; 401/503 for a bad delivery or our own missing keys; 500 when the
// processor threw (the row was re-queued under the cap, so QStash's
// redelivery re-runs it).
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifyQStashSignature, TRIAL_PURCHASES_WORKER_PATH } from '@/lib/qstash'
import { claimAndProcessTrialPurchase } from '@/lib/trial-purchase-queue'
import { getAppUrl } from '@/lib/app-url'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(request) {
  const rawBody = await request.text()
  let expectedUrl = null
  try { expectedUrl = `${getAppUrl()}${TRIAL_PURCHASES_WORKER_PATH}` } catch {
    console.error('[qstash trial-purchases worker] NEXT_PUBLIC_APP_URL unset; skipping sub-claim check')
  }
  const verdict = verifyQStashSignature({ signature: request.headers.get('upstash-signature'), rawBody, url: expectedUrl || undefined })
  if (!verdict.ok) {
    console.warn(`[qstash trial-purchases worker] delivery rejected: ${verdict.reason}`)
    return NextResponse.json({ success: false, error: verdict.reason }, { status: verdict.reason === 'missing_keys' ? 503 : 401 })
  }
  let id
  try { id = JSON.parse(rawBody)?.id } catch {
    return NextResponse.json({ success: false, error: 'invalid_json' }, { status: 400 })
  }
  if (!id || typeof id !== 'string') return NextResponse.json({ success: false, error: 'missing_id' }, { status: 400 })

  const db = createServerClient()
  const { data: row, error } = await db.from('trial_purchases').select('*').eq('id', id).maybeSingle()
  if (error) return NextResponse.json({ success: false, error: 'row_unreadable' }, { status: 500 })
  if (!row) return NextResponse.json({ success: true, skipped: true, reason: 'not_found' })
  if (row.status !== 'queued') return NextResponse.json({ success: true, skipped: true, reason: `status_${row.status}` })

  const outcome = await claimAndProcessTrialPurchase(db, row)
  if (outcome.status === 'processed') return NextResponse.json({ success: true, processed: true, outcome: outcome.outcome })
  if (outcome.status === 'skipped') return NextResponse.json({ success: true, skipped: true })
  return NextResponse.json({ success: false, error: outcome.error || 'processing_failed' }, { status: 500 })
}
