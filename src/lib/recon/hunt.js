// src/lib/recon/hunt.js
//
// RCOV.P1 — huntLine: the per-line hunt orchestrator. Takes ONE
// recon_bank_lines row (as claimed by claim_recon_hunt_batch) and
// hunts every active operator mailbox for the invoice/receipt that
// explains it, via IMAP search + Claude Vision scoring.
//
// Sequence (see hunt.test.js's file-header comment for the full
// numbered contract this mirrors):
//   1. weekly LLM-spend budget guard — never touch email over budget.
//   2. load active recon_mailboxes — none active is also a hard stop.
//   3. compute the exclusion set from prior hunts whose find was
//      submitted to the queue and then REJECTED by a human — never
//      re-surface the same document.
//   4. open a recon_hunts audit row for this attempt.
//   5. collect candidates across mailboxes (search + fetch metadata
//      only — no downloads here), drop excluded/duplicate messages,
//      rank PDF-bearing candidates by date proximity, keep the global
//      top MAX_CANDIDATES_SCORED that carry a document part.
//   6. score ranked candidates in order (download + Claude verdict),
//      stopping at the first match; spend accumulates across EVERY
//      scoring call, match or not.
//   7. MATCH → hash + upload + enqueue + flip the line to submitted +
//      finish the hunt row 'found'.
//   8. NO MATCH → flip the line to not_found + finish the hunt row
//      'not_found'.
//   9. Any failure anywhere (including inside 7/8's own writes)
//      routes through errorFinish, which never throws itself — a
//      bookkeeping failure must never mask the original error. When
//      the failure predates the hunt row (budget / no mailboxes) it
//      INSERTS a terminal row so the attempt stays auditable.
//
// Download-batching choice: step 6 re-opens each ranked candidate's
// OWN mailbox via withMailbox at score time (one downloadPart call),
// exactly as the behavior contract describes it. Step 5's per-mailbox
// withMailbox session is used only for search + fetchCandidate
// (metadata only, never downloads). This keeps collection and scoring
// as two clean, independently testable phases; the cost is a second
// IMAP login per scored candidate, which is fine at this volume (a
// handful of hunts/week, MAX_CANDIDATES_SCORED capped at 4).
import { createHash } from 'crypto'
import { withMailbox, searchRaw, fetchCandidate, downloadPart } from './imap-client'
import { buildHuntQueries } from './hunt-queries'
import { scoreHuntCandidate, isHuntMatch } from './hunt-scoring'
import { enqueueFromHuntFind } from '@/lib/invoices-queue/enqueue'

export const MAX_CANDIDATES_SCORED = 4
export const PER_MAILBOX_UID_CAP = 8
export const HUNT_WEEKLY_BUDGET_USD = 15

const HUNTED_INVOICES_BUCKET = 'hunted-invoices'
const AUTH_ERROR_RE = /auth|login|credentials/i
const PAGE = 1000 // supabase-js hard select cap — paginate everything (house rule)

function nowIso() {
  return new Date().toISOString()
}

function safeFilename(name) {
  return String(name || 'invoice').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80)
}

function bestPart(parts) {
  return parts.find((p) => p.contentType === 'application/pdf') || parts[0]
}

// Dequeue the line (clear the hunt-claim + bump attempts) WITHOUT
// touching its status — an errored hunt must never fake a not_found.
async function dequeueLine(db, line) {
  await db
    .from('recon_bank_lines')
    .update({
      hunt_queued_at: null,
      hunt_claimed_at: null,
      last_hunted_at: nowIso(),
      hunt_attempts: (line.hunt_attempts || 0) + 1,
      updated_at: nowIso(),
    })
    .eq('id', line.id)
}

// Finish as an error. When a hunt row exists it's UPDATEd; when the
// failure predates the row (budget guard / no active mailboxes —
// NORMAL recurring states at a $15/wk budget, not exotic crashes) a
// terminal row is INSERTed instead, so every attempt stays visible in
// the audit table rather than surviving only as a hunt_attempts bump.
// Wrapped so a bookkeeping failure here never masks the original
// error — the caller has already decided what to return; this is
// best-effort audit.
async function errorFinish(db, line, { huntId, error, queries, examinedIds, spendTotal }) {
  try {
    if (huntId) {
      await db
        .from('recon_hunts')
        .update({
          finished_at: nowIso(),
          outcome: 'error',
          error,
          // queries/examined are only undefined on the pre-collection
          // early errors; every path with a hunt row created
          // post-collection has them assigned.
          ...(queries !== undefined ? { queries } : {}),
          ...(examinedIds !== undefined ? { examined_message_ids: examinedIds } : {}),
          llm_spend_usd: spendTotal || 0,
        })
        .eq('id', huntId)
    } else {
      // started_at and llm_spend_usd take their column defaults
      // (now() / 0) — see mig 370.
      await db
        .from('recon_hunts')
        .insert({
          bank_line_id: line.id,
          finished_at: nowIso(),
          outcome: 'error',
          error,
        })
    }
    await dequeueLine(db, line)
  } catch (e) {
    console.error(`[huntLine ${line.id}] error-finish bookkeeping failed: ${e?.message || e}`)
  }
}

async function weeklySpendSoFar(db) {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  // .range()-paginated per the house 1k-cap rule (same loop as
  // selectExistingInWindow in ./coverage.js). Weekly hunt volume is
  // far below one page, so this loop virtually always makes exactly
  // ONE round trip — the pagination exists so a pathological backlog
  // can never silently under-count spend and blow past the budget.
  let sum = 0
  for (let start = 0; ; start += PAGE) {
    const { data, error } = await db
      .from('recon_hunts')
      .select('llm_spend_usd')
      .gte('started_at', since)
      .order('id')
      .range(start, start + PAGE - 1)
    if (error) throw new Error(`weekly spend lookup failed: ${error.message}`)
    for (const r of data || []) sum += Number(r.llm_spend_usd) || 0
    if (!data || data.length < PAGE) break
  }
  return sum
}

// Mailboxes are scoped PER LOCATION (mig 374) — a line is only ever
// searched against its own location's inboxes. Passing the line's
// location_id here is load-bearing for cross-entity isolation, not
// just tidiness.
async function activeMailboxes(db, locationId) {
  const { data, error } = await db
    .from('recon_mailboxes')
    .select('id, label, email, imap_password')
    .match({ active: true, location_id: locationId })
  if (error) throw new Error(`mailbox lookup failed: ${error.message}`)
  return data || []
}

// Message-ids from prior hunts on this line that were submitted to the
// queue and then REJECTED by a human — never re-surface the same doc.
// Only ONE .not() filter is pushed to PostgREST (found_message_id);
// the submitted_queue_id not-null check is done in JS below — chaining
// two calls to the same terminal method on this file's mock style
// would require the mock to special-case "resolve only on the LAST
// call", which the shared chainable() helper doesn't support, and a
// single filter is simpler regardless.
async function exclusionSet(db, lineId) {
  const { data: priorHuntsRaw, error: hErr } = await db
    .from('recon_hunts')
    .select('found_message_id, submitted_queue_id')
    .eq('bank_line_id', lineId)
    .not('found_message_id', 'is', null)
  if (hErr) throw new Error(`prior-hunt lookup failed: ${hErr.message}`)
  const priorHunts = (priorHuntsRaw || []).filter((h) => h.submitted_queue_id != null)
  if (priorHunts.length === 0) return new Set()

  const queueIds = priorHunts.map((h) => h.submitted_queue_id)
  const { data: queueRows, error: qErr } = await db
    .from('invoices_queue')
    .select('id, status')
    .in('id', queueIds)
  if (qErr) throw new Error(`queue-status lookup failed: ${qErr.message}`)

  const rejectedQueueIds = new Set((queueRows || []).filter((r) => r.status === 'rejected').map((r) => r.id))
  const excluded = new Set()
  for (const h of priorHunts) {
    if (rejectedQueueIds.has(h.submitted_queue_id)) excluded.add(h.found_message_id)
  }
  return excluded
}

async function openHuntRow(db, lineId) {
  const { data, error } = await db
    .from('recon_hunts')
    .insert({ bank_line_id: lineId })
    .select('id')
    .single()
  if (error) throw new Error(`hunt row open failed: ${error.message}`)
  return data.id
}

function dateDiffMs(candidateDate, lineDate) {
  if (!candidateDate) return null
  const c = new Date(candidateDate).getTime()
  const l = new Date(lineDate).getTime()
  if (Number.isNaN(c) || Number.isNaN(l)) return null
  return Math.abs(c - l)
}

// Collect candidates across every active mailbox. Returns
// { ranked, examined, mailboxErrors } where `ranked` is the capped,
// ordered list of candidates worth scoring (each carrying >=1 document
// part) and `examined` is EVERY messageId actually looked at (incl.
// part-less ones), for the audit trail — excluded messages are in
// neither.
async function collectCandidates(db, mailboxes, line, excluded) {
  const queries = buildHuntQueries(line)
  const examined = new Set()
  const seenMessageIds = new Set() // cross-mailbox same-message dedupe
  const allCandidates = []
  const mailboxErrors = []

  for (const mailbox of mailboxes) {
    try {
      await withMailbox({ email: mailbox.email, password: mailbox.imap_password }, async (client) => {
        const uidSet = new Set()
        for (const q of queries) {
          const uids = await searchRaw(client, q, PER_MAILBOX_UID_CAP)
          for (const u of uids) uidSet.add(u)
        }
        const maxFetches = 2 * MAX_CANDIDATES_SCORED
        const uidsToFetch = Array.from(uidSet).slice(0, maxFetches)
        for (const uid of uidsToFetch) {
          const candidate = await fetchCandidate(client, uid)
          if (!candidate) continue
          if (excluded.has(candidate.messageId)) continue
          if (seenMessageIds.has(candidate.messageId)) continue
          seenMessageIds.add(candidate.messageId)
          examined.add(candidate.messageId)
          allCandidates.push({ ...candidate, mailboxId: mailbox.id })
        }
      })
    } catch (e) {
      const message = String(e?.message || e)
      mailboxErrors.push({ mailbox: mailbox.email, error: message })
      if (AUTH_ERROR_RE.test(message)) {
        await db.from('recon_mailboxes').update({ last_error: message }).eq('id', mailbox.id)
      }
    }
  }

  if (mailboxErrors.length === mailboxes.length) {
    return {
      ranked: [], examined: Array.from(examined), mailboxErrors, queries,
      allMailboxesFailed: true,
    }
  }

  // Rank: PDF-bearing candidates first, then by date proximity
  // ascending (null dates last); part-less candidates never get scored
  // but stay in `examined` above.
  const withParts = allCandidates.filter((c) => c.parts.length > 0)
  const ranked = withParts
    .map((c) => ({ c, diff: dateDiffMs(c.date, line.line_date) }))
    .sort((a, b) => {
      const aHasPdf = a.c.parts.some((p) => p.contentType === 'application/pdf')
      const bHasPdf = b.c.parts.some((p) => p.contentType === 'application/pdf')
      if (aHasPdf !== bHasPdf) return aHasPdf ? -1 : 1
      if (a.diff === null && b.diff === null) return 0
      if (a.diff === null) return 1
      if (b.diff === null) return -1
      return a.diff - b.diff
    })
    .map((x) => x.c)
    .slice(0, MAX_CANDIDATES_SCORED)

  return { ranked, examined: Array.from(examined), mailboxErrors, queries, allMailboxesFailed: false }
}

// Score ranked candidates in order, stopping at the first match.
// Returns { match, spendTotal } where match is
// { candidate, part, bytes, verdict } or null.
async function scoreCandidates(mailboxesById, ranked, line) {
  let spendTotal = 0
  for (const candidate of ranked) {
    const mailbox = mailboxesById.get(candidate.mailboxId)
    const part = bestPart(candidate.parts)
    let downloaded = null
    await withMailbox({ email: mailbox.email, password: mailbox.imap_password }, async (client) => {
      downloaded = await downloadPart(client, candidate.uid, part.part)
    })
    if (!downloaded) continue

    const scored = await scoreHuntCandidate({ bytes: downloaded.bytes, mime: part.contentType, line })
    spendTotal += scored.spendUsd || 0
    if (scored.ok && isHuntMatch(scored.verdict, line)) {
      return { match: { candidate, part, bytes: downloaded.bytes, verdict: scored.verdict }, spendTotal }
    }
  }
  return { match: null, spendTotal }
}

export async function huntLine(db, line) {
  let huntId = null
  let queries
  let examinedIds
  let spendTotal = 0

  try {
    // 1. Budget guard — never touch email if the week's already spent.
    // TOCTOU accepted: claims serialize per-line not per-budget; worst
    // overshoot = one overlapping tick (~cents at this scale). Revisit
    // with pg_advisory_xact_lock if the budget or parallelism grows.
    const spentSoFar = await weeklySpendSoFar(db)
    if (spentSoFar >= HUNT_WEEKLY_BUDGET_USD) {
      await errorFinish(db, line, { huntId: null, error: 'weekly LLM budget exhausted' })
      return { outcome: 'error', reason: 'budget' }
    }

    // 2. Mailboxes — this location's inboxes only (per-location scope).
    const mailboxes = await activeMailboxes(db, line.location_id)
    if (mailboxes.length === 0) {
      await errorFinish(db, line, { huntId: null, error: 'no active mailboxes' })
      return { outcome: 'error', reason: 'no_mailboxes' }
    }

    // 3. Exclusions.
    const excluded = await exclusionSet(db, line.id)

    // 4. Open the hunt audit row.
    huntId = await openHuntRow(db, line.id)

    // 5. Collect candidates.
    const collected = await collectCandidates(db, mailboxes, line, excluded)
    queries = collected.queries
    examinedIds = collected.examined
    if (collected.allMailboxesFailed) {
      const summary = collected.mailboxErrors.map((e) => `${e.mailbox}: ${e.error}`).join('; ')
      await errorFinish(db, line, { huntId, error: `all mailboxes failed: ${summary}`, queries, examinedIds, spendTotal })
      return { outcome: 'error', reason: 'imap' }
    }

    // 6. Score.
    const mailboxesById = new Map(mailboxes.map((m) => [m.id, m]))
    const { match, spendTotal: scoredSpend } = await scoreCandidates(mailboxesById, collected.ranked, line)
    spendTotal = scoredSpend

    if (match) {
      // 7. MATCH path.
      const { candidate, part, bytes, verdict } = match
      const contentHash = createHash('sha256').update(bytes).digest('hex')
      const filename = safeFilename(part.filename)
      const bucketPath = `${line.location_id}/${line.id}/${Date.now()}-${filename}`

      // NOTE: a deduped find leaves this uploaded object orphaned —
      // acceptable (private bucket, small files, rare); backlog:
      // sweeper or lifecycle rule.
      const { error: uploadError } = await db.storage
        .from(HUNTED_INVOICES_BUCKET)
        .upload(bucketPath, bytes, { contentType: part.contentType, upsert: true })
      if (uploadError) {
        await errorFinish(db, line, {
          huntId, error: `attachment upload failed: ${uploadError.message}`, queries, examinedIds, spendTotal,
        })
        return { outcome: 'error' }
      }

      const enqueued = await enqueueFromHuntFind({
        locationId: line.location_id,
        huntId,
        bucketPath,
        filename,
        sizeBytes: bytes.length,
        mimeType: part.contentType,
        senderEmail: candidate.from,
        subject: `Hunted: ${candidate.subject || '(no subject)'}`.slice(0, 200),
        contentHash,
      })
      if (!enqueued.ok) {
        await errorFinish(db, line, {
          huntId, error: `enqueue failed: ${enqueued.error}`, queries, examinedIds, spendTotal,
        })
        return { outcome: 'error' }
      }

      const queueId = enqueued.queueIds[0]
      const timestamp = nowIso()
      await db
        .from('recon_bank_lines')
        .update({
          status: 'submitted',
          invoices_queue_id: queueId,
          hunt_queued_at: null,
          hunt_claimed_at: null,
          last_hunted_at: timestamp,
          hunt_attempts: (line.hunt_attempts || 0) + 1,
          updated_at: timestamp,
        })
        .eq('id', line.id)

      await db
        .from('recon_hunts')
        .update({
          finished_at: timestamp,
          outcome: 'found',
          queries,
          examined_message_ids: examinedIds,
          found_message_id: candidate.messageId,
          found_mailbox_id: candidate.mailboxId,
          submitted_queue_id: queueId,
          evidence: { verdict, deduped: enqueued.deduped },
          llm_spend_usd: spendTotal,
        })
        .eq('id', huntId)

      return { outcome: 'found', deduped: enqueued.deduped, queueId }
    }

    // 8. NO-MATCH path.
    const timestamp = nowIso()
    await db
      .from('recon_bank_lines')
      .update({
        status: 'not_found',
        hunt_queued_at: null,
        hunt_claimed_at: null,
        last_hunted_at: timestamp,
        hunt_attempts: (line.hunt_attempts || 0) + 1,
        updated_at: timestamp,
      })
      .eq('id', line.id)

    await db
      .from('recon_hunts')
      .update({
        finished_at: timestamp,
        outcome: 'not_found',
        queries,
        examined_message_ids: examinedIds,
        llm_spend_usd: spendTotal,
        ...(collected.mailboxErrors.length > 0 ? { evidence: { mailboxErrors: collected.mailboxErrors } } : {}),
      })
      .eq('id', huntId)

    return { outcome: 'not_found', examined: examinedIds.length }
  } catch (e) {
    // 9. Whole function must never throw.
    await errorFinish(db, line, {
      huntId, error: String(e?.message || e), queries, examinedIds, spendTotal,
    })
    return { outcome: 'error' }
  }
}
