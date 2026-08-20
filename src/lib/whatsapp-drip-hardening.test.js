import { describe, it, expect, vi } from 'vitest'
import {
  isFrequencyCapError, fetchDripDoneContactIds, CAPPED_RETRY_HOURS, claimDripRecipient,
  STUCK_CLAIM_MINUTES, OWED_RETRY_STATUSES,
  broadcastQualityBlockError, classifyBlastFailure, blastAbortPatch, blastAbortNotification,
} from './whatsapp.js'
import { applyMetaUserPreference } from './whatsapp-consent.js'

describe('isFrequencyCapError', () => {
  it('matches code 131049 and the healthy-ecosystem message', () => {
    expect(isFrequencyCapError({ code: 131049 })).toBe(true)
    expect(isFrequencyCapError({ message: 'This message was not delivered to maintain healthy ecosystem engagement.' })).toBe(true)
  })
  it('does not match undeliverable or generic failures', () => {
    expect(isFrequencyCapError({ code: 131026, message: 'Message undeliverable' })).toBe(false)
    expect(isFrequencyCapError({ message: 'Template paused' })).toBe(false)
    expect(isFrequencyCapError({})).toBe(false)
  })
})

function pagedDb(rows) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => ({
            range: (start, end) => Promise.resolve({ data: rows.slice(start, end + 1), error: null }),
          }),
        }),
      }),
    }),
  }
}

describe('fetchDripDoneContactIds — capped retry window', () => {
  const OLD = new Date(Date.now() - (CAPPED_RETRY_HOURS + 2) * 3600 * 1000).toISOString()
  const FRESH = new Date(Date.now() - 1 * 3600 * 1000).toISOString()

  it('sent/failed rows are done; expired capped rows re-open; fresh capped stay done', async () => {
    const db = pagedDb([
      { contact_id: 'a', status: 'sent', failed_at: null },
      { contact_id: 'b', status: 'failed', failed_at: OLD },
      { contact_id: 'c', status: 'capped', failed_at: OLD },   // expired park → retryable
      { contact_id: 'd', status: 'capped', failed_at: FRESH }, // still parked → done
    ])
    const done = await fetchDripDoneContactIds(db, 'bc1')
    expect(done.sort()).toEqual(['a', 'b', 'd'])
  })
})

// ── BAREWRITE.3 — the drip claim is a MUTEX, not just a dedupe ──────────────
// The drip claimed with an upsert while the blast path it says it mirrors uses
// an insert. Upsert succeeds on conflict, so two overlapping cron ticks (Vercel
// does not skip an overlapping run) both claimed the same contact and both sent
// the same marketing template. Insert alone would have broken the OTHER
// property: a 'capped' (Meta 131049) row is deliberately re-selected after
// CAPPED_RETRY_HOURS, and by then a row exists. Both are pinned here.
//
// A `whatsapp_broadcast_recipients` that actually enforces
// UNIQUE(broadcast_id, contact_id) (mig 331).
function recipientsTable(seed = []) {
  const rows = seed.map(r => ({ ...r }))
  const key = (b, c) => `${b}|${c}`
  const db = {
    rows,
    from(table) {
      if (table !== 'whatsapp_broadcast_recipients') throw new Error(`unexpected table ${table}`)
      return {
        insert(row) {
          const clash = rows.find(r => key(r.broadcast_id, r.contact_id) === key(row.broadcast_id, row.contact_id))
          if (clash) {
            return Promise.resolve({ error: { code: '23505', message: 'duplicate key value violates unique constraint "whatsapp_broadcast_recipients_broadcast_id_contact_id_key"' } })
          }
          rows.push({ ...row })
          return Promise.resolve({ error: null })
        },
        update(patch) {
          const preds = []
          const b = {
            eq(col, val) { preds.push(r => r[col] === val); return b },
            // The claim lease's CAS predicate. Modelled as a real string
            // comparison, which is what PostgREST does on a timestamptz sent as
            // an ISO string.
            lt(col, val) { preds.push(r => r[col] != null && String(r[col]) < String(val)); return b },
            select: async () => {
              const matched = rows.filter(r => preds.every(p => p(r)))
              for (const r of matched) Object.assign(r, patch)
              return { data: matched.map(r => ({ id: `${r.broadcast_id}:${r.contact_id}` })), error: null }
            },
          }
          return b
        },
      }
    },
  }
  return db
}

describe('claimDripRecipient — the per-recipient mutex', () => {
  it('claims a fresh contact by INSERT, and a second concurrent tick loses', async () => {
    const db = recipientsTable()

    const first = await claimDripRecipient(db, 'bc1', 'c1')
    const second = await claimDripRecipient(db, 'bc1', 'c1')

    expect(first).toEqual({ claimed: true })
    // The whole point: the upsert version returned claimed:true here and the
    // template went out twice.
    expect(second).toEqual({ claimed: false, reason: 'already_claimed' })
    expect(db.rows).toHaveLength(1)
    expect(db.rows[0]).toMatchObject({ status: 'pending' })
  })

  it('re-claims a parked capped row (the retry the upsert existed for) — once', async () => {
    const db = recipientsTable([
      { broadcast_id: 'bc1', contact_id: 'c1', status: 'capped', error_message: 'ecosystem', failed_at: '2026-08-01T00:00:00.000Z' },
    ])

    const first = await claimDripRecipient(db, 'bc1', 'c1')
    const second = await claimDripRecipient(db, 'bc1', 'c1')

    expect(first).toEqual({ claimed: true, retry: true })
    expect(second).toEqual({ claimed: false, reason: 'already_claimed' })
    // The park is cleared so the row reads as a live claim, not a stale failure.
    expect(db.rows[0]).toMatchObject({ status: 'pending', error_message: null, failed_at: null })
  })

  it('never re-claims a row that already sent, or one another tick is mid-send on', async () => {
    for (const status of ['sent', 'pending', 'failed', 'delivered']) {
      const db = recipientsTable([{ broadcast_id: 'bc1', contact_id: 'c1', status }])
      expect(await claimDripRecipient(db, 'bc1', 'c1')).toEqual({ claimed: false, reason: 'already_claimed' })
      expect(db.rows[0].status).toBe(status)
    }
  })

  it('reports a real DB failure as itself, so the caller skips rather than sending unrecorded', async () => {
    const db = {
      from: () => ({ insert: async () => ({ error: { code: '08006', message: 'connection reset' } }) }),
    }
    expect(await claimDripRecipient(db, 'bc1', 'c1')).toEqual({ claimed: false, reason: 'connection reset' })
  })
})

// ── BAREWRITE.5 — THE CLAIM IS A LEASE, NOT A TOMBSTONE ────────────────────
//
// Claiming before the send closed the duplicate hole and opened a worse one: a
// process kill between the claim and sendTemplateMessage (Vercel timeout, OOM,
// deploy mid-request) leaves a row at 'pending' with nothing sent. Nothing
// re-opened 'pending' and no surface showed it — whatsapp-broadcast-stats' only
// figure that counts it (`unaccounted`) is rendered by WABroadcastEditor solely
// when the broadcast ALSO has capped rows, and even then it is labelled "have
// not been attempted yet". So that contact silently never received their drip
// step, permanently, which is strictly worse than main (main re-sent).
//
// The lease is the fix: an abandoned claim re-opens after STUCK_CLAIM_MINUTES.
// The residual risk becomes a DUPLICATE in the narrow case where the send did
// reach Meta but the promote write did not — visible to the customer, and the
// direction this codebase has agreed to fail in.
describe('the drip claim lease — an abandoned claim is recoverable, not permanent', () => {
  const STALE = new Date(Date.now() - (STUCK_CLAIM_MINUTES + 5) * 60_000).toISOString()
  const FRESH_CLAIM = new Date(Date.now() - 1 * 60_000).toISOString()

  it('fetchDripDoneContactIds re-opens an abandoned pending claim, and only that one', async () => {
    const db = pagedDb([
      { contact_id: 'a', status: 'sent', failed_at: null, created_at: STALE },
      // The killed-mid-send claim. Before the lease this was 'done' forever.
      { contact_id: 'b', status: 'pending', failed_at: null, created_at: STALE },
      // A tick that is genuinely in flight right now — must NOT be re-opened.
      { contact_id: 'c', status: 'pending', failed_at: null, created_at: FRESH_CLAIM },
      // Unknown age. Never re-send on a guess.
      { contact_id: 'd', status: 'pending', failed_at: null, created_at: null },
    ])
    const done = await fetchDripDoneContactIds(db, 'bc1')
    expect(done.sort()).toEqual(['a', 'c', 'd'])
  })

  it('claimDripRecipient re-claims an abandoned pending row — once', async () => {
    const db = recipientsTable([
      { broadcast_id: 'bc1', contact_id: 'c1', status: 'pending', created_at: STALE },
    ])

    const first = await claimDripRecipient(db, 'bc1', 'c1')
    // A second tick arriving after the first re-claimed finds a FRESH lease.
    const second = await claimDripRecipient(db, 'bc1', 'c1')

    expect(first).toEqual({ claimed: true, reclaimed: true })
    expect(second).toEqual({ claimed: false, reason: 'already_claimed' })
    expect(db.rows).toHaveLength(1)
  })

  it('never re-claims a pending row still inside its lease', async () => {
    const db = recipientsTable([
      { broadcast_id: 'bc1', contact_id: 'c1', status: 'pending', created_at: FRESH_CLAIM },
    ])
    expect(await claimDripRecipient(db, 'bc1', 'c1')).toEqual({ claimed: false, reason: 'already_claimed' })
    expect(db.rows[0].created_at).toBe(FRESH_CLAIM)
  })

  it('a fresh INSERT claim stamps created_at, so the lease is measured from the claim', async () => {
    const db = recipientsTable()
    const now = Date.parse('2026-08-20T10:00:00.000Z')
    expect(await claimDripRecipient(db, 'bc1', 'c1', now)).toEqual({ claimed: true })
    expect(db.rows[0].created_at).toBe('2026-08-20T10:00:00.000Z')
  })

  it('a capped RETRY claim restamps created_at, so the retry is not instantly stale', async () => {
    // Without the restamp the re-claimed row inherits a created_at older than
    // CAPPED_RETRY_HOURS, i.e. older than any lease — so the very next tick
    // would treat a live claim as abandoned and send a second time.
    const db = recipientsTable([
      { broadcast_id: 'bc1', contact_id: 'c1', status: 'capped', failed_at: STALE, created_at: STALE },
    ])
    const now = Date.parse('2026-08-20T10:00:00.000Z')
    expect(await claimDripRecipient(db, 'bc1', 'c1', now)).toEqual({ claimed: true, retry: true })
    expect(db.rows[0].created_at).toBe('2026-08-20T10:00:00.000Z')
  })
})

// WA-QUALITY.2 — blast preflight quality gate.
describe('broadcastQualityBlockError', () => {
  it('refuses RED / FLAGGED with an operator-facing message', () => {
    const red = broadcastQualityBlockError('RED')
    expect(red).toMatch(/quality is RED/)
    expect(red).toMatch(/paused to protect the number/i)
    expect(broadcastQualityBlockError('FLAGGED')).toMatch(/quality is FLAGGED/)
  })
  it('GREEN / YELLOW / unknown ratings pass', () => {
    expect(broadcastQualityBlockError('GREEN')).toBeNull()
    expect(broadcastQualityBlockError('YELLOW')).toBeNull()
    expect(broadcastQualityBlockError(null)).toBeNull()
    expect(broadcastQualityBlockError(undefined)).toBeNull()
  })
})

// WA-QUALITY.4 — 131049 in the blast catch block: capped is recorded distinctly
// and never trips the circuit breaker (or the undeliverable flagger).
describe('classifyBlastFailure', () => {
  it('frequency cap (131049 / healthy-ecosystem) → capped, outside the breaker', () => {
    expect(classifyBlastFailure({ code: 131049 })).toEqual({ recipientStatus: 'capped', countsTowardBreaker: false })
    expect(classifyBlastFailure({ message: 'not delivered to maintain healthy ecosystem engagement' }))
      .toEqual({ recipientStatus: 'capped', countsTowardBreaker: false })
  })
  it('undeliverable and generic failures → failed, count toward the breaker', () => {
    expect(classifyBlastFailure({ code: 131026, message: 'Message undeliverable' }))
      .toEqual({ recipientStatus: 'failed', countsTowardBreaker: true })
    expect(classifyBlastFailure({ message: 'Invalid OAuth access token' }))
      .toEqual({ recipientStatus: 'failed', countsTowardBreaker: true })
    expect(classifyBlastFailure({})).toEqual({ recipientStatus: 'failed', countsTowardBreaker: true })
  })
})

// WA-QUALITY.3 — blast circuit breaker outcome. The aborted broadcast flips
// BACK to 'draft' (the send route's draft→sending CAS is the only blast entry,
// so 'draft' is the one state an operator can re-send from without DB surgery;
// the resume pass skips already-recorded recipients via fetchDripDoneContactIds).
describe('blastAbortPatch', () => {
  const NOW = '2026-07-10T10:00:00.000Z'
  it('returns a recoverable draft with paused_at + the abort recorded in delivery_summary', () => {
    const patch = blastAbortPatch({
      deliverySummary: { matched: 100, reachable: 90 },
      consecutiveFailures: 5,
      lastError: 'Invalid OAuth access token',
    }, NOW)
    expect(patch.status).toBe('draft')
    expect(patch.paused_at).toBe(NOW)
    // Existing summary keys survive; the abort is additive.
    expect(patch.delivery_summary.matched).toBe(100)
    expect(patch.delivery_summary.reachable).toBe(90)
    expect(patch.delivery_summary.aborted).toEqual({
      reason: 'consecutive_send_failures',
      consecutive_failures: 5,
      last_error: 'Invalid OAuth access token',
      at: NOW,
    })
  })
  it('tolerates a missing summary (reachability count failed earlier)', () => {
    const patch = blastAbortPatch({ deliverySummary: null, consecutiveFailures: 5, lastError: null }, NOW)
    expect(patch.delivery_summary.aborted.last_error).toBeNull()
  })
})

describe('blastAbortNotification', () => {
  it('names the broadcast, the failure run, and how to recover', () => {
    const n = blastAbortNotification({ name: 'July promo' }, 5, 'Invalid OAuth access token')
    expect(n.title).toMatch(/broadcast/i)
    expect(n.body).toContain('July promo')
    expect(n.body).toContain('5 consecutive')
    expect(n.body).toContain('Invalid OAuth access token')
    expect(n.body).toMatch(/send/i)
  })
  it('degrades without a name or last error', () => {
    const n = blastAbortNotification({}, 5, null)
    expect(n.body).toMatch(/5 consecutive/)
  })
})

function consentDb({ contact, writes }) {
  return {
    from: (table) => ({
      select: () => ({ or: () => ({ limit: () => Promise.resolve({ data: contact ? [contact] : [] }) }) }),
      upsert: (row) => { writes.push([table, row]); return Promise.resolve({ error: null }) },
      update: (patch) => { writes.push([table, patch]); return { eq: () => Promise.resolve({ error: null }) } },
      insert: (row) => { writes.push([table, row]); return Promise.resolve({ error: null }) },
    }),
  }
}

describe('applyMetaUserPreference', () => {
  it('stop → marketing off + wa_status opted_out + consent_log audit', async () => {
    const writes = []
    const db = consentDb({ contact: { id: 'c1' }, writes })
    const r = await applyMetaUserPreference(db, { wa_id: '353871234567', category: 'marketing_messages', value: 'stop' })
    expect(r).toMatchObject({ applied: true, action: 'opt_out' })
    expect(writes).toEqual([
      // Upserted by contact_id so a contact with no preferences row still opts out.
      ['contact_preferences', expect.objectContaining({ contact_id: 'c1', whatsapp_marketing: false })],
      ['contacts', { wa_status: 'opted_out' }],
      ['consent_log', expect.objectContaining({ action: 'opt_out', source: 'meta_user_preferences' })],
    ])
  })
  it('resume → re-opted in', async () => {
    const writes = []
    const db = consentDb({ contact: { id: 'c1' }, writes })
    const r = await applyMetaUserPreference(db, { wa_id: '353871234567', value: 'resume' })
    expect(r.action).toBe('opt_in')
    expect(writes[0]).toEqual(['contact_preferences', expect.objectContaining({ contact_id: 'c1', whatsapp_marketing: true })])
  })
  it('unknown contact / bad value → not applied, no writes', async () => {
    const writes = []
    expect((await applyMetaUserPreference(consentDb({ contact: null, writes }), { wa_id: '1', value: 'stop' })).applied).toBe(false)
    expect((await applyMetaUserPreference(consentDb({ contact: { id: 'c1' }, writes }), { wa_id: '1', value: 'nonsense' })).applied).toBe(false)
    expect(writes).toEqual([])
  })
})

// DRIP-LEASE.2 — finalisation must not go terminal over an outstanding lease.
//
// The lease added in BAREWRITE.4 re-claims a 'pending' row after
// STUCK_CLAIM_MINUTES, but a lease only helps if a LATER TICK RUNS. Both
// finalisation branches in sendDripChunk counted only 'capped' when deciding
// whether to hold the broadcast open, so a drip could flip to terminal 'sent'
// with an in-lease 'pending' claim outstanding: no further tick, no re-claim,
// that contact's message lost for good — a loss main did not have.
//
// The rule now lives in ONE constant because the bug was two copies of it: the
// 'capped' guard sat two lines from the exhausted check and was simply not
// extended when leases arrived.
describe('OWED_RETRY_STATUSES — a drip may not finalise over an owed tick', () => {
  it('counts an outstanding lease as owed, not just a frequency-capped park', () => {
    expect(OWED_RETRY_STATUSES).toContain('capped')  // frequency cap (131049), re-opens when the park expires
    expect(OWED_RETRY_STATUSES).toContain('pending') // claimed, outcome unknown — the lease still owes it a tick
  })

  it('terminal statuses are NOT owed a tick (finalising over them is correct)', () => {
    for (const terminal of ['sent', 'delivered', 'read', 'failed']) {
      expect(OWED_RETRY_STATUSES).not.toContain(terminal)
    }
  })

  it('both finalisation branches share the constant, so they cannot drift apart again', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(fileURLToPath(new URL('./whatsapp.js', import.meta.url)), 'utf8')

    // Every head-count of the recipients table that decides finalisation must go
    // through the shared constant. A bare .eq('status', 'capped') here is the
    // regression: it re-strands in-lease rows.
    const finalisationCounts = src.match(/whatsapp_broadcast_recipients'\)\s*\n?\s*\.select\('id', \{ count: 'exact', head: true \}\)[^\n]*/g) || []
    const owedChecks = finalisationCounts.filter((line) => /'capped'|OWED_RETRY_STATUSES/.test(line))

    expect(owedChecks.length).toBeGreaterThanOrEqual(2) // the two finalisation branches
    for (const line of owedChecks) {
      expect(line).toContain('OWED_RETRY_STATUSES')
      expect(line).not.toMatch(/\.eq\('status', 'capped'\)/)
    }
  })
})
