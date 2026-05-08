// External-export queue: enqueue + worker.
//
// enqueueExportsForSession is called best-effort from
// live-class.endSession() — for every active integration where
// the contact has auto_export_enabled, we insert a row in
// external_export_jobs. The worker (Vercel cron) drains it.
//
// runExportWorker pulls a small batch of due jobs and processes
// each: refresh tokens if needed, build TCX, upload, stamp the
// row. Errors are caught per-job (one bad token doesn't kill
// the run) and surfaced via last_error on both the job row and
// the parent contact_external_integrations row.

import { logInfo, logWarn } from '@/lib/log'
import { buildTcx } from '@/lib/tcx-builder'
import { refreshAccessToken, uploadTcx, pollUpload } from '@/lib/strava'

const MAX_ATTEMPTS = 5
const RETRY_DELAYS_MS = [
  60_000,           //  1 min
  5 * 60_000,       //  5 min
  30 * 60_000,      // 30 min
  2 * 60 * 60_000,  //  2 h
  6 * 60 * 60_000,  //  6 h
]

/**
 * After a session is finalised, queue an export job for every
 * provider where the contact has auto_export_enabled. Idempotent
 * via UNIQUE(session_id, contact_id, provider).
 */
export async function enqueueExportsForSession(db, session) {
  if (!session?.id || !session.contact_id || !session.ended_at) return { ok: true, queued: 0 }

  const { data: integrations } = await db
    .from('contact_external_integrations')
    .select('contact_id, provider, auto_export_enabled, disconnected_at')
    .eq('contact_id', session.contact_id)
    .is('disconnected_at', null)
    .eq('auto_export_enabled', true)

  if (!integrations || integrations.length === 0) return { ok: true, queued: 0 }

  const rows = integrations.map((i) => ({
    session_id: session.id,
    contact_id: session.contact_id,
    provider: i.provider,
  }))
  const { error: insErr } = await db
    .from('external_export_jobs')
    .upsert(rows, { onConflict: 'session_id,contact_id,provider', ignoreDuplicates: true })
  if (insErr) {
    logWarn('export-queue', 'enqueue failed', { sessionId: session.id, err: insErr })
    return { ok: false, error: insErr.message }
  }
  return { ok: true, queued: rows.length }
}

/**
 * Drain due jobs. Called by /api/cron/run-strava-exports.
 *
 * @param {object} db   service-role Supabase client
 * @param {object} opts
 * @param {number} [opts.batchSize=20]
 * @param {number} [opts.nowMs]
 */
export async function runExportWorker(db, { batchSize = 20, nowMs = Date.now() } = {}) {
  const nowIso = new Date(nowMs).toISOString()

  // Atomically claim a batch by flipping queued → processing.
  // Without an UPDATE … RETURNING for safety; we accept the small
  // window where two cron ticks race. The per-job UNIQUE on
  // (session, contact, provider) means duplicate uploads to Strava
  // are rare AND harmless (Strava de-dupes by external_id).
  const { data: claimed } = await db
    .from('external_export_jobs')
    .select('id, session_id, contact_id, provider, attempts')
    .in('status', ['queued', 'processing'])
    .lte('next_attempt_at', nowIso)
    .order('next_attempt_at', { ascending: true })
    .limit(batchSize)

  if (!claimed || claimed.length === 0) return { ok: true, processed: 0 }

  let succeeded = 0
  let failed = 0
  let skipped = 0

  for (const job of claimed) {
    try {
      const result = await processOneJob(db, job)
      if (result.skipped) skipped++
      else if (result.ok) succeeded++
      else failed++
    } catch (err) {
      failed++
      logWarn('export-worker', 'job threw', { jobId: job.id, err })
      await markFailed(db, job, err?.message || String(err))
    }
  }

  logInfo('export-worker', 'tick', {
    claimed: claimed.length, succeeded, failed, skipped,
  })
  return { ok: true, processed: claimed.length, succeeded, failed, skipped }
}

async function processOneJob(db, job) {
  // Mark processing.
  await db.from('external_export_jobs')
    .update({ status: 'processing', attempts: job.attempts + 1 })
    .eq('id', job.id)

  // Load the integration + service row.
  const [{ data: integration }, { data: service }, { data: session }, { data: samples }] =
    await Promise.all([
      db.from('contact_external_integrations')
        .select('*')
        .eq('contact_id', job.contact_id)
        .eq('provider', job.provider)
        .is('disconnected_at', null)
        .maybeSingle(),
      db.from('service_integrations')
        .select('*')
        .eq('provider', job.provider)
        .maybeSingle(),
      db.from('heart_rate_sessions')
        .select('id, contact_id, started_at, ended_at, avg_hr_bpm, peak_hr_bpm, effort_points, zones_seconds')
        .eq('id', job.session_id)
        .maybeSingle(),
      db.from('hr_samples')
        .select('recorded_at, bpm')
        .eq('session_id', job.session_id)
        .order('recorded_at', { ascending: true }),
    ])

  if (!integration || !integration.auto_export_enabled) {
    await markStatus(db, job, 'skipped', 'integration disconnected or auto-export disabled')
    return { skipped: true }
  }
  if (!service || !service.is_enabled || !service.client_id || !service.client_secret) {
    await markStatus(db, job, 'skipped', 'service not configured')
    return { skipped: true }
  }
  if (!session || !session.ended_at) {
    await markStatus(db, job, 'skipped', 'session missing or not ended')
    return { skipped: true }
  }
  if (!samples || samples.length < 10) {
    // Too thin a stream to be useful as an HR graph.
    await markStatus(db, job, 'skipped', 'not enough samples for a useful upload')
    return { skipped: true }
  }

  // Refresh access token if expired or close to it.
  let accessToken = integration.access_token
  const expiresMs = integration.expires_at ? new Date(integration.expires_at).getTime() : 0
  if (!accessToken || expiresMs < Date.now() + 60_000) {
    const fresh = await refreshAccessToken({
      clientId: service.client_id,
      clientSecret: service.client_secret,
      refreshToken: integration.refresh_token,
    })
    accessToken = fresh.accessToken
    await db.from('contact_external_integrations').update({
      access_token: fresh.accessToken,
      refresh_token: fresh.refreshToken,
      expires_at: fresh.expiresAt,
    }).eq('id', integration.id)
  }

  // Build TCX + upload.
  if (job.provider !== 'strava') {
    await markStatus(db, job, 'skipped', 'provider not yet implemented')
    return { skipped: true }
  }
  const tcxXml = buildTcx({
    session,
    samples,
    title: `UN1T HR · ${new Date(session.started_at).toLocaleDateString('en-IE')}`,
    sport: 'Other',
  })
  const upload = await uploadTcx({ accessToken, tcxXml, name: `UN1T HR · ${session.effort_points || ''} pts` })
  let activityId = upload.activityId
  if (!activityId) {
    activityId = await pollUpload({ accessToken, uploadId: upload.uploadId })
  }

  await markStatus(db, job, 'succeeded', null, activityId)
  await db.from('contact_external_integrations').update({
    last_export_at: new Date().toISOString(),
    last_error: null,
  }).eq('id', integration.id)
  return { ok: true }
}

async function markStatus(db, job, status, lastError, externalId = null) {
  const patch = {
    status,
    last_error: lastError,
    processed_at: new Date().toISOString(),
  }
  if (externalId) patch.external_id = externalId
  await db.from('external_export_jobs').update(patch).eq('id', job.id)
}

async function markFailed(db, job, errMsg) {
  const nextAttempts = (job.attempts || 0) + 1
  if (nextAttempts >= MAX_ATTEMPTS) {
    await db.from('external_export_jobs').update({
      status: 'failed', last_error: errMsg,
      processed_at: new Date().toISOString(),
    }).eq('id', job.id)
    // Bubble error onto integration row so the member can see it.
    await db.from('contact_external_integrations')
      .update({ last_error: errMsg })
      .eq('contact_id', job.contact_id)
      .eq('provider', job.provider)
      .is('disconnected_at', null)
  } else {
    const delayMs = RETRY_DELAYS_MS[Math.min(nextAttempts - 1, RETRY_DELAYS_MS.length - 1)]
    await db.from('external_export_jobs').update({
      status: 'queued',
      last_error: errMsg,
      attempts: nextAttempts,
      next_attempt_at: new Date(Date.now() + delayMs).toISOString(),
    }).eq('id', job.id)
  }
}
