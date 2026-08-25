// ZOOMSYNC.1 — the diff and the deletion guard.

import { zoomConfigured } from './client'
import { listOwnedContacts } from './external-contacts'
import { buildDesiredContacts } from './desired-contacts'
import {
  publishQueuePush, ensureQueue,
  ZOOM_CONTACTS_WORKER_PATH, ZOOM_CONTACTS_QUEUE_NAME, ZOOM_CONTACTS_QUEUE_PARALLELISM,
} from '@/lib/qstash'
import { startRun, finishRun, pruneRuns } from './sync-runs'
import { loadParkedNumbers } from './failures'

export const GUARD_FLOOR = 20
export const GUARD_FRACTION = 0.05

/**
 * Comparison-only equality, NOT what gets sent to Zoom. Desired names are
 * recomputed fresh from the CRM every run; if either side round-trips
 * through something that re-encodes whitespace or composes accented
 * characters differently (Zoom's own storage, a legacy import, a copy-paste
 * source using NFD), a byte-literal compare never converges — the same
 * entry reads as "changed" on every single run, forever, generating
 * pointless writes indefinitely. Trim + Unicode-normalise before comparing
 * so only an actual content difference triggers an update; the raw
 * want.name (not this normalised form) is still what gets written.
 */
function namesEqual(a, b) {
  const norm = (s) => (typeof s === 'string' ? s.normalize('NFC').trim() : '')
  return norm(a) === norm(b)
}

/**
 * Pure. desired: Map<e164, {name, contactId}>; existing: Map<e164, {name, zoomId}>.
 * `existing` must ALREADY be filtered to CRM-owned entries — listOwnedContacts
 * does that, and it is what keeps hand-added contacts out of `deletes`.
 *
 * ZOOMSYNC.4 — `protectedKeys` is the fix for the trap that any "just filter
 * the bad numbers out" change walks into. Dropping a key from desired is not
 * neutral: this function reads "in Zoom, not in desired" as a DELETE, so
 * filtering would quietly remove live directory entries for numbers Zoom
 * happened to accept before we started checking (~2-3 of them today, and the
 * deletion guard would not catch it — its threshold is max(20, 5%) ≈ 317).
 *
 * So a protected key is withheld from `deletes` and reported separately. Two
 * cases, both deliberate:
 *   (a) never created in Zoom (the common case — Zoom 400'd the create): the
 *       key is in neither map, nothing happens, no job is enqueued. Fixed.
 *   (b) already present in Zoom: the entry is LEFT ALONE. It is a wrong number
 *       under a real member's name, but deletion is the only irreversible
 *       direction here and this residue is repairable at source — the operator
 *       is being shown the contact to fix. The moment they fix it the old key
 *       stops being produced by the CRM at all, so it leaves `protectedKeys`
 *       too, and the NEXT run deletes the stale entry through the normal path
 *       with the guard watching. The withholding self-clears; it does not
 *       strand the entry forever.
 *
 * Creates and updates for protected keys are dropped as well — a parked number
 * is one Zoom has already refused, and re-enqueueing it nightly is the bug.
 *
 * @param {Set<string>} [protectedKeys] — E.164s that must not be written or
 *   deleted this run. Defaults to none: callers own the truth, and the pure
 *   diff has no way to infer it.
 */
export function diffContacts(desired, existing, protectedKeys = new Set()) {
  const creates = []
  const updates = []
  const deletes = []
  const withheld = { creates: 0, updates: 0, deletes: [] }

  for (const [e164, want] of desired) {
    const have = existing.get(e164)
    if (!have) {
      if (protectedKeys.has(e164)) { withheld.creates++; continue }
      creates.push({ e164, name: want.name, contactId: want.contactId })
    } else if (!namesEqual(have.name, want.name)) {
      if (protectedKeys.has(e164)) { withheld.updates++; continue }
      updates.push({ e164, name: want.name, contactId: want.contactId, zoomId: have.zoomId })
    }
  }

  for (const [e164, have] of existing) {
    if (desired.has(e164)) continue
    if (protectedKeys.has(e164)) { withheld.deletes.push(e164); continue }
    deletes.push({ e164, zoomId: have.zoomId })
  }

  return { creates, updates, deletes, withheld }
}

/**
 * A broken desired-state query (renamed column, dropped lead_source, a Supabase
 * blip returning zero rows) yields an empty desired set, which the diff reads as
 * "delete everything". Deletes are the only irreversible direction, so an
 * oversized batch suppresses ALL of them and fails the run loudly. Creates and
 * updates still apply — they are safe.
 */
export function applyDeletionGuard(deletes, ownedExistingCount) {
  const threshold = Math.max(GUARD_FLOOR, Math.ceil(ownedExistingCount * GUARD_FRACTION))
  if (deletes.length > threshold) {
    return {
      tripped: true,
      deletes: [],
      threshold,
      attempted: deletes.length,
      sample: deletes.slice(0, 10).map((d) => d.e164),
    }
  }
  return { tripped: false, deletes, threshold, attempted: deletes.length }
}

/**
 * QStash 400s on colons in Upstash-Deduplication-Id (undocumented; bit us
 * 2026-07-17). Dashes and digits only.
 */
function dedupId(op, e164) {
  return `zoom-contact-${op}-${e164.replace(/\D/g, '')}`
}

// Publishing is a network round trip each, and a cold start is ~6,330 of them.
// Sequentially that is 5-15 minutes and blows the cron's 300s budget on the one
// run that matters most. Bounded concurrency fixes it safely: the queue's own
// parallelism (2) throttles DELIVERY to Zoom, so publishing faster does not
// increase pressure on the Zoom API — it only fills the queue quicker.
export const PUBLISH_CONCURRENCY = 25

/**
 * Builds the diff and enqueues one QStash job per write. Performs no Zoom
 * writes itself — the worker route does those, one per delivery.
 *
 * Wraps runZoomContactSyncBody() with run-history recording: startRun()
 * before the work, finishRun() after, so every trigger is recorded exactly
 * once regardless of who invoked it (see sync-runs.js).
 *
 * @param {object} opts
 * @param {object} [opts.db] — Supabase server client
 * @param {boolean} [opts.dry] — compute and return the diff, enqueue nothing
 * @param {number} [opts.limit] — enqueue at most N jobs (creates first)
 * @param {boolean} [opts.force] — bypass the deletion guard for this run
 * @param {string} [opts.trigger] — 'cron' or 'manual', recorded on the run row
 * @param {string} [opts.triggeredBy] — operator profile id, when manual
 */
export async function runZoomContactSync({
  db, dry = false, limit = null, force = false,
  trigger = 'cron', triggeredBy = null,
} = {}) {
  // Deliberately before startRun: an unconfigured tenant did not run, so
  // recording a row would put a permanent stream of no-ops in the history of
  // every tenant that never connects Zoom.
  if (!zoomConfigured()) return { skipped: 'unconfigured' }

  const runId = await startRun(db, {
    organizationId: process.env.ZOOM_SYNC_ORGANIZATION_ID || null,
    trigger, triggeredBy, dry, forced: force, limit,
  })

  const out = await runZoomContactSyncBody({ db, dry, limit, force })

  await finishRun(db, runId, out)
  // A dry run changed nothing; leave pruning to runs that actually did work.
  if (!dry) await pruneRuns(db)
  return out
}

async function runZoomContactSyncBody({ db, dry, limit, force }) {
  const desiredRes = await buildDesiredContacts(db)
  if (!desiredRes.ok) return { ok: false, error: desiredRes.error }

  const existingRes = await listOwnedContacts()
  if (!existingRes.ok) return { ok: false, error: existingRes.error }

  // ZOOMSYNC.4 — the two families of key this run must not touch: numbers the
  // CRM produced that Zoom will refuse (never enqueue them), and numbers Zoom
  // HAS refused and that are parked awaiting a human fix (never enqueue them
  // again). Both are also withheld from the delete pass — see diffContacts.
  const parked = await loadParkedNumbers(db)
  const protectedKeys = new Set([...(desiredRes.invalid || []), ...parked])

  const diff = diffContacts(desiredRes.desired, existingRes.contacts, protectedKeys)
  const rawGuard = applyDeletionGuard(diff.deletes, existingRes.contacts.size)
  // force is the operator's deliberate override: without it a legitimately
  // large cleanup can never drain, because suppressing the deletes keeps the
  // directory big, so the same batch trips the same threshold every night.
  const guard = force ? { tripped: false, deletes: diff.deletes, threshold: rawGuard.threshold, attempted: rawGuard.attempted } : rawGuard

  const counts = {
    creates: diff.creates.length,
    updates: diff.updates.length,
    deletes: guard.deletes.length,
  }

  // Reported on every run, dry or not: this is the residue an operator is meant
  // to act on, and a silent suppression is the failure mode this whole change
  // exists to end. COUNTS ONLY, though — the guard's own sample already had to
  // be redacted for callers without integrations_zoom_manage (POST
  // /api/integrations/zoom-contacts/run) because it carries real member
  // numbers; adding a second list of numbers to this envelope would reopen
  // exactly that leak. Which contacts these are is answered per-row on
  // /settings/integrations/zoom-contacts, from buildDesiredContacts' own
  // rejects report.
  const withheld = {
    invalid: (desiredRes.invalid || new Set()).size,
    parked: parked.size,
    creates: diff.withheld.creates,
    updates: diff.withheld.updates,
    deletes: diff.withheld.deletes.length,
  }
  // Recorded inside the existing `stats` jsonb rather than as new columns on
  // zoom_sync_runs — no migration, and the run history renders it already.
  const stats = { ...(desiredRes.stats || {}), parked: parked.size, withheldDeletes: withheld.deletes }

  if (dry) {
    return {
      ok: !guard.tripped, dry: true, counts,
      guardTripped: guard.tripped, guard, stats, withheld,
      ownedInZoom: existingRes.contacts.size,
      ...(force ? { forced: true } : {}),
    }
  }

  // Creates first: on a cold start they are the whole job, and a limit should
  // spend itself on getting names onto handsets rather than on tidying.
  const jobs = [
    ...diff.creates.map((c) => ({ op: 'create', ...c })),
    ...diff.updates.map((u) => ({ op: 'update', ...u })),
    ...guard.deletes.map((d) => ({ op: 'delete', ...d })),
  ]
  const capped = Number.isFinite(limit) && limit > 0 ? jobs.slice(0, limit) : jobs

  if (capped.length > 0) {
    await ensureQueue(ZOOM_CONTACTS_QUEUE_NAME, ZOOM_CONTACTS_QUEUE_PARALLELISM)
  }

  let enqueued = 0
  const failures = []
  for (let i = 0; i < capped.length; i += PUBLISH_CONCURRENCY) {
    const batch = capped.slice(i, i + PUBLISH_CONCURRENCY)
    // publishQueuePush's real implementation never rejects — the whole body
    // is try/caught and every branch resolves {ok:false, error}. This inner
    // try/catch is a second belt anyway: a bare Promise.all rejects the
    // WHOLE batch on a single thrown error (from a future qstash.js change,
    // or a test mock), which would discard every sibling's already-in-flight
    // result. One job's failure must stay one job's failure.
    const results = await Promise.all(batch.map(async (job) => {
      try {
        const res = await publishQueuePush({
          path: ZOOM_CONTACTS_WORKER_PATH,
          body: job,
          deduplicationId: dedupId(job.op, job.e164),
          queueName: ZOOM_CONTACTS_QUEUE_NAME,
          queueParallelism: ZOOM_CONTACTS_QUEUE_PARALLELISM,
        })
        return { job, res }
      } catch (err) {
        return { job, res: { ok: false, error: err?.message || 'publish_failed' } }
      }
    }))
    for (const { job, res } of results) {
      if (res.ok) enqueued++
      else failures.push(`${job.op} ${job.e164}: ${res.error ?? 'skipped'}`)
    }
  }

  return {
    ok: !guard.tripped && failures.length === 0,
    counts,
    enqueued,
    limited: capped.length < jobs.length,
    guardTripped: guard.tripped,
    ...(force ? { forced: true } : {}),
    ...(guard.tripped ? { guard } : {}),
    ...(failures.length ? { failures: failures.slice(0, 10) } : {}),
    stats,
    withheld,
    ownedInZoom: existingRes.contacts.size,
  }
}
