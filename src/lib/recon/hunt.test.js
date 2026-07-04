// RCOV.P1 — huntLine orchestrator test coverage.
//
// huntLine(db, line) hunts ONE recon_bank_lines row across all active
// operator mailboxes for the invoice/receipt that explains it. Order
// of operations:
//   1. weekly LLM-spend budget guard (recon_hunts.llm_spend_usd sum,
//      last 7d) — over budget short-circuits before ANY email touch.
//   2. load active recon_mailboxes — none active short-circuits too.
//   3. compute the exclusion set: message-ids from prior hunts on this
//      line whose submitted queue row was rejected (a human said "not
//      it" — never re-surface the same document).
//   4. open a recon_hunts audit row for this attempt.
//   5. collect candidates across mailboxes via buildHuntQueries +
//      searchRaw + fetchCandidate, dropping excluded/duplicate
//      messages, ranking PDF-bearing candidates first then by date
//      proximity, keeping the top MAX_CANDIDATES_SCORED (4) that have
//      a document part.
//   6. score ranked candidates in order via downloadPart +
//      scoreHuntCandidate + isHuntMatch, stopping at the first match
//      and summing spend across every scoring call (even non-matches).
//   7. MATCH: hash + upload to hunted-invoices + enqueueFromHuntFind +
//      flip the line to submitted + finish the hunt row 'found'.
//   8. NO MATCH: flip the line to not_found + finish the hunt row
//      'not_found'.
//   9. Any failure anywhere routes to an error-finish helper that
//      updates the hunt row — or INSERTS a terminal one when the
//      failure predates the row (budget exhaustion / no mailboxes are
//      NORMAL recurring states that must stay visible in the audit
//      table) — + dequeues the line WITHOUT touching its status, and
//      never throws itself.
//
// Download-batching choice (stated per the task's own "your call"):
// step 6 is implemented literally as written — each ranked candidate
// re-opens ITS OWN mailbox via withMailbox at score time and downloads
// just its best part. This keeps step 5 (collection) purely about
// metadata (fetchCandidate never downloads) and step 6 simple and
// data-driven off the ranked list; step 5's per-mailbox withMailbox
// session is used ONLY for search+fetchCandidate. Consequence visible
// in the mocks below: a single-mailbox found-path test opens that
// mailbox via withMailbox 3 times total — once to collect (step 5),
// once to score the first (no-match) candidate, once to score the
// second (match) candidate (step 6) — asserted explicitly in test 1.
//
// buildHuntQueries is mocked (not exercised for real) — it's pure and
// already unit-tested in hunt-queries.test.js; mocking it here makes
// this file's assertions about WHICH queries got searched crisp and
// decoupled from its token-extraction internals.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const withMailbox = vi.fn()
const searchRaw = vi.fn()
const fetchCandidate = vi.fn()
const downloadPart = vi.fn()
vi.mock('./imap-client', () => ({
  withMailbox: (...args) => withMailbox(...args),
  searchRaw: (...args) => searchRaw(...args),
  fetchCandidate: (...args) => fetchCandidate(...args),
  downloadPart: (...args) => downloadPart(...args),
}))

const buildHuntQueries = vi.fn()
vi.mock('./hunt-queries', () => ({
  buildHuntQueries: (...args) => buildHuntQueries(...args),
}))

const scoreHuntCandidate = vi.fn()
const isHuntMatch = vi.fn()
vi.mock('./hunt-scoring', () => ({
  scoreHuntCandidate: (...args) => scoreHuntCandidate(...args),
  isHuntMatch: (...args) => isHuntMatch(...args),
}))

const enqueueFromHuntFind = vi.fn()
vi.mock('@/lib/invoices-queue/enqueue', () => ({
  enqueueFromHuntFind: (...args) => enqueueFromHuntFind(...args),
}))

// hunt.js never imports @/lib/supabase directly (db is a parameter,
// house style per pull.js) — no mock needed. Kept out deliberately;
// if a future change imports it transitively this file's mocks above
// still fully isolate the module graph the same way pull.test.js's
// comment documents.

let hunt

// Chain whose FINAL method resolves; intermediate steps return this
// (house pattern — cf. coverage.test.js / pull.test.js).
function chainable(finalValue, terminal) {
  const chain = {}
  for (const m of [
    'select', 'eq', 'in', 'not', 'gte', 'lte', 'order', 'update', 'insert',
    'upsert', 'range', 'limit', 'maybeSingle', 'single',
  ]) {
    chain[m] = vi.fn().mockReturnThis()
  }
  chain[terminal] = vi.fn().mockResolvedValue(finalValue)
  return chain
}

const LINE = Object.freeze({
  id: 'line-1',
  location_id: 'loc-1',
  line_date: '2026-06-03',
  amount: -84.5,
  description: 'MUSCLEFOOD LTD CARD 1234',
  reference: 'CARD 1234',
  status: 'uncovered',
  hunt_attempts: 0,
})

const MAILBOX = { id: 'mbx-1', label: 'Ops', email: 'ops@x.com', imap_password: 'app-pw', active: true }

function mockDbFrom(...chains) {
  const from = vi.fn()
  for (const c of chains) from.mockReturnValueOnce(c)
  return { from }
}

beforeEach(() => {
  vi.resetModules()
  withMailbox.mockReset()
  searchRaw.mockReset()
  fetchCandidate.mockReset()
  downloadPart.mockReset()
  buildHuntQueries.mockReset()
  scoreHuntCandidate.mockReset()
  isHuntMatch.mockReset()
  enqueueFromHuntFind.mockReset()
  buildHuntQueries.mockReturnValue(['q1', 'q2'])
})

beforeEach(async () => {
  hunt = await import('./hunt')
})

// A withMailbox mock that just invokes the callback with a stub client
// object (the client itself is opaque here — searchRaw/fetchCandidate/
// downloadPart are the mocked seams that consume it).
function stubWithMailbox() {
  withMailbox.mockImplementation(async ({ email, password }, fn) => {
    void email
    void password
    return fn({ stubClient: true })
  })
}

describe('huntLine', () => {
  it('found-path: scores 2 candidates (no-match then match), uploads, enqueues, marks the line submitted, and sums spend across both scoring calls', async () => {
    const budgetSelect = chainable({ data: [{ llm_spend_usd: 2 }, { llm_spend_usd: 1 }], error: null }, 'limit')
    const mailboxSelect = chainable({ data: [MAILBOX], error: null }, 'eq')
    const priorHunts = chainable({ data: [], error: null }, 'not')
    const huntInsert = chainable({ data: { id: 'hunt-1' }, error: null }, 'single')
    const lineUpdate = chainable({ data: null, error: null }, 'eq')
    const huntFinish = chainable({ data: null, error: null }, 'eq')
    const db = mockDbFrom(budgetSelect, mailboxSelect, priorHunts, huntInsert, lineUpdate, huntFinish)
    db.storage = { from: vi.fn(() => ({ upload: vi.fn().mockResolvedValue({ data: { path: 'x' }, error: null }) })) }

    stubWithMailbox()
    searchRaw.mockResolvedValue([101, 102])
    fetchCandidate
      // Both carry a PDF part, so ranking falls to date-proximity to
      // line.line_date (2026-06-03) ascending — uid 101 is dated EXACT
      // (0-day diff) so it legitimately ranks and scores first; uid 102
      // is 3 days off so it ranks second. This makes "no-match scored
      // first, match scored second" a genuine consequence of the
      // ranking rule rather than an assumption about fetch order.
      .mockResolvedValueOnce({
        uid: 101, messageId: 'msg-no-match', subject: 'Delivery note', from: 'a@supplier.com',
        date: '2026-06-03', parts: [{ part: '2', contentType: 'application/pdf', filename: 'note.pdf' }],
      })
      .mockResolvedValueOnce({
        uid: 102, messageId: 'msg-match', subject: 'Invoice 123', from: 'b@supplier.com',
        date: '2026-06-06', parts: [{ part: '2', contentType: 'application/pdf', filename: 'invoice.pdf' }],
      })

    downloadPart
      .mockResolvedValueOnce({ bytes: Buffer.from('no-match-bytes'), contentType: 'application/pdf', filename: 'note.pdf' })
      .mockResolvedValueOnce({ bytes: Buffer.from('match-bytes'), contentType: 'application/pdf', filename: 'invoice.pdf' })

    scoreHuntCandidate
      .mockResolvedValueOnce({ ok: true, verdict: { is_match: false, confidence: 0.3 }, spendUsd: 0.01 })
      .mockResolvedValueOnce({ ok: true, verdict: { is_match: true, confidence: 0.95, total: 84.5 }, spendUsd: 0.02 })
    isHuntMatch
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)

    enqueueFromHuntFind.mockResolvedValue({ ok: true, queueIds: ['queue-1'], deduped: false })

    const result = await hunt.huntLine(db, LINE)

    expect(result).toEqual({ outcome: 'found', deduped: false, queueId: 'queue-1' })

    // Uploaded to the hunted-invoices bucket at the documented path shape.
    expect(db.storage.from).toHaveBeenCalledWith('hunted-invoices')
    const uploadFn = db.storage.from.mock.results[0].value.upload
    const [uploadPath, uploadBytes, uploadOpts] = uploadFn.mock.calls[0]
    expect(uploadPath).toMatch(/^loc-1\/line-1\/\d+-invoice\.pdf$/)
    expect(uploadBytes).toEqual(Buffer.from('match-bytes'))
    expect(uploadOpts).toEqual({ contentType: 'application/pdf', upsert: true })

    // enqueue called with contentHash + huntId + the matched candidate's evidence.
    expect(enqueueFromHuntFind).toHaveBeenCalledTimes(1)
    const enqueueArg = enqueueFromHuntFind.mock.calls[0][0]
    expect(enqueueArg.locationId).toBe('loc-1')
    expect(enqueueArg.huntId).toBe('hunt-1')
    expect(enqueueArg.filename).toBe('invoice.pdf')
    expect(enqueueArg.sizeBytes).toBe(Buffer.from('match-bytes').length)
    expect(enqueueArg.mimeType).toBe('application/pdf')
    expect(enqueueArg.senderEmail).toBe('b@supplier.com')
    expect(enqueueArg.subject).toBe('Hunted: Invoice 123')
    expect(enqueueArg.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(enqueueArg.bucketPath).toBe(uploadPath)

    // Line flipped to submitted with the queue id + attempt bump.
    expect(lineUpdate.update).toHaveBeenCalledTimes(1)
    const linePatch = lineUpdate.update.mock.calls[0][0]
    expect(linePatch).toMatchObject({
      status: 'submitted',
      invoices_queue_id: 'queue-1',
      hunt_queued_at: null,
      hunt_claimed_at: null,
      hunt_attempts: 1,
    })
    expect(linePatch.last_hunted_at).toBeTruthy()
    expect(linePatch.updated_at).toBeTruthy()
    expect(lineUpdate.eq).toHaveBeenCalledWith('id', 'line-1')

    // Hunt row finished 'found' with spend SUMMED across BOTH scoring
    // calls (0.01 no-match + 0.02 match), not just the winning one.
    expect(huntFinish.update).toHaveBeenCalledTimes(1)
    const huntPatch = huntFinish.update.mock.calls[0][0]
    expect(huntPatch).toMatchObject({
      outcome: 'found',
      found_message_id: 'msg-match',
      found_mailbox_id: 'mbx-1',
      submitted_queue_id: 'queue-1',
      llm_spend_usd: 0.03,
    })
    expect(huntPatch.finished_at).toBeTruthy()
    expect(huntPatch.evidence).toMatchObject({ deduped: false })
    expect(huntFinish.eq).toHaveBeenCalledWith('id', 'hunt-1')

    // Both scoring calls happened (spend summed even on the non-match).
    expect(scoreHuntCandidate).toHaveBeenCalledTimes(2)
    // Download-batching choice: each ranked candidate re-opens its own
    // mailbox at score time (step 6, literal) — so withMailbox opens
    // 3 times total: 1 collection (step 5) + 2 scoring (step 6, one per
    // candidate, loop stops after the match so both still ran here
    // since match is the SECOND candidate).
    expect(withMailbox).toHaveBeenCalledTimes(3)
  })

  it('dedupe variant: enqueue returns an existing queue id — line links to it and evidence.deduped is true', async () => {
    const budgetSelect = chainable({ data: [], error: null }, 'limit')
    const mailboxSelect = chainable({ data: [MAILBOX], error: null }, 'eq')
    const priorHunts = chainable({ data: [], error: null }, 'not')
    const huntInsert = chainable({ data: { id: 'hunt-1' }, error: null }, 'single')
    const lineUpdate = chainable({ data: null, error: null }, 'eq')
    const huntFinish = chainable({ data: null, error: null }, 'eq')
    const db = mockDbFrom(budgetSelect, mailboxSelect, priorHunts, huntInsert, lineUpdate, huntFinish)
    db.storage = { from: vi.fn(() => ({ upload: vi.fn().mockResolvedValue({ data: { path: 'x' }, error: null }) })) }

    stubWithMailbox()
    searchRaw.mockResolvedValue([201])
    fetchCandidate.mockResolvedValueOnce({
      uid: 201, messageId: 'msg-dup', subject: 'Invoice 456', from: 'c@supplier.com',
      date: '2026-06-03', parts: [{ part: '2', contentType: 'application/pdf', filename: 'inv.pdf' }],
    })
    downloadPart.mockResolvedValueOnce({ bytes: Buffer.from('dup-bytes'), contentType: 'application/pdf', filename: 'inv.pdf' })
    scoreHuntCandidate.mockResolvedValueOnce({ ok: true, verdict: { is_match: true, confidence: 0.9, total: 84.5 }, spendUsd: 0.01 })
    isHuntMatch.mockReturnValueOnce(true)
    enqueueFromHuntFind.mockResolvedValue({ ok: true, queueIds: ['existing-queue-id'], deduped: true })

    const result = await hunt.huntLine(db, LINE)

    expect(result).toEqual({ outcome: 'found', deduped: true, queueId: 'existing-queue-id' })
    expect(lineUpdate.update.mock.calls[0][0]).toMatchObject({
      status: 'submitted',
      invoices_queue_id: 'existing-queue-id',
    })
    expect(huntFinish.update.mock.calls[0][0]).toMatchObject({
      submitted_queue_id: 'existing-queue-id',
    })
    expect(huntFinish.update.mock.calls[0][0].evidence).toMatchObject({ deduped: true })
  })

  it('exclusion: a message from a prior rejected find is never re-scored and never reappears in examined_message_ids', async () => {
    const budgetSelect = chainable({ data: [], error: null }, 'limit')
    const mailboxSelect = chainable({ data: [MAILBOX], error: null }, 'eq')
    // Prior hunts for this line with a found_message_id + submitted queue id.
    const priorHunts = chainable(
      { data: [{ found_message_id: 'msg-rejected', submitted_queue_id: 'queue-old' }], error: null },
      'not'
    )
    const queueStatusLookup = chainable({ data: [{ id: 'queue-old', status: 'rejected' }], error: null }, 'in')
    const huntInsert = chainable({ data: { id: 'hunt-2' }, error: null }, 'single')
    const lineUpdate = chainable({ data: null, error: null }, 'eq')
    const huntFinish = chainable({ data: null, error: null }, 'eq')
    const db = mockDbFrom(budgetSelect, mailboxSelect, priorHunts, queueStatusLookup, huntInsert, lineUpdate, huntFinish)

    stubWithMailbox()
    // Two UIDs come back from search: the excluded message's uid, and a
    // fresh one with no document parts (so the hunt ends not_found —
    // keeps this test focused purely on the exclusion mechanic).
    searchRaw.mockResolvedValue([301, 302])
    fetchCandidate
      .mockResolvedValueOnce({
        uid: 301, messageId: 'msg-rejected', subject: 'Old rejected doc', from: 'z@supplier.com',
        date: '2026-06-01', parts: [{ part: '2', contentType: 'application/pdf', filename: 'old.pdf' }],
      })
      .mockResolvedValueOnce({
        uid: 302, messageId: 'msg-fresh-no-parts', subject: 'Newsletter', from: 'y@supplier.com',
        date: '2026-06-02', parts: [],
      })

    const result = await hunt.huntLine(db, LINE)

    expect(result.outcome).toBe('not_found')
    // The excluded message was never handed to the scorer.
    expect(scoreHuntCandidate).not.toHaveBeenCalled()
    expect(downloadPart).not.toHaveBeenCalled()
    // And it must not resurface in the finish row's examined ids either.
    const huntPatch = huntFinish.update.mock.calls[0][0]
    expect(huntPatch.examined_message_ids).not.toContain('msg-rejected')
    expect(huntPatch.examined_message_ids).toContain('msg-fresh-no-parts')
  })

  it('budget guard: prior 7d spend >= $15 short-circuits before any mailbox is opened, leaves a terminal audit row, dequeues the line, and leaves status unchanged', async () => {
    const budgetSelect = chainable({ data: [{ llm_spend_usd: 10 }, { llm_spend_usd: 5.01 }], error: null }, 'limit')
    const huntErrorInsert = chainable({ data: null, error: null }, 'insert')
    const lineUpdate = chainable({ data: null, error: null }, 'eq')
    const db = mockDbFrom(budgetSelect, huntErrorInsert, lineUpdate)

    const result = await hunt.huntLine(db, LINE)

    expect(result).toEqual({ outcome: 'error', reason: 'budget' })
    expect(withMailbox).not.toHaveBeenCalled()
    expect(searchRaw).not.toHaveBeenCalled()
    // Budget exhaustion is a NORMAL recurring state at $15/wk — it must
    // be visible in the recon_hunts audit table, not just as a silent
    // hunt_attempts bump. No hunt row was opened before the guard
    // tripped, so the error-finish INSERTS a terminal row (started_at
    // and llm_spend_usd take their column defaults).
    expect(huntErrorInsert.insert).toHaveBeenCalledTimes(1)
    const auditRow = huntErrorInsert.insert.mock.calls[0][0]
    expect(auditRow).toMatchObject({
      bank_line_id: 'line-1',
      outcome: 'error',
      error: 'weekly LLM budget exhausted',
    })
    expect(auditRow.finished_at).toBeTruthy()
    expect(lineUpdate.update).toHaveBeenCalledTimes(1)
    const patch = lineUpdate.update.mock.calls[0][0]
    expect(patch).not.toHaveProperty('status')
    expect(patch).toMatchObject({ hunt_queued_at: null, hunt_claimed_at: null, hunt_attempts: 1 })
    expect(lineUpdate.eq).toHaveBeenCalledWith('id', 'line-1')
  })

  it('no active mailboxes short-circuits with reason no_mailboxes, leaves a terminal audit row, and dequeues the line', async () => {
    const budgetSelect = chainable({ data: [], error: null }, 'limit')
    const mailboxSelect = chainable({ data: [], error: null }, 'eq')
    const huntErrorInsert = chainable({ data: null, error: null }, 'insert')
    const lineUpdate = chainable({ data: null, error: null }, 'eq')
    const db = mockDbFrom(budgetSelect, mailboxSelect, huntErrorInsert, lineUpdate)

    const result = await hunt.huntLine(db, LINE)

    expect(result).toEqual({ outcome: 'error', reason: 'no_mailboxes' })
    expect(withMailbox).not.toHaveBeenCalled()
    // Same audit contract as the budget guard: pre-hunt-row errors
    // still leave a terminal recon_hunts row behind.
    expect(huntErrorInsert.insert).toHaveBeenCalledTimes(1)
    expect(huntErrorInsert.insert.mock.calls[0][0]).toMatchObject({
      bank_line_id: 'line-1',
      outcome: 'error',
      error: 'no active mailboxes',
    })
    expect(lineUpdate.update.mock.calls[0][0]).not.toHaveProperty('status')
  })

  it('all mailboxes IMAP-fail (auth error) — error-finish, last_error updated on the mailbox row, reason imap', async () => {
    const budgetSelect = chainable({ data: [], error: null }, 'limit')
    const mailboxSelect = chainable({ data: [MAILBOX], error: null }, 'eq')
    const priorHunts = chainable({ data: [], error: null }, 'not')
    const huntInsert = chainable({ data: { id: 'hunt-3' }, error: null }, 'single')
    const mailboxUpdate = chainable({ data: null, error: null }, 'eq')
    const huntFinish = chainable({ data: null, error: null }, 'eq')
    const lineUpdate = chainable({ data: null, error: null }, 'eq')
    const db = mockDbFrom(budgetSelect, mailboxSelect, priorHunts, huntInsert, mailboxUpdate, huntFinish, lineUpdate)

    withMailbox.mockRejectedValue(new Error('Invalid login credentials'))

    const result = await hunt.huntLine(db, LINE)

    expect(result).toEqual({ outcome: 'error', reason: 'imap' })
    expect(mailboxUpdate.update).toHaveBeenCalledTimes(1)
    expect(mailboxUpdate.update.mock.calls[0][0]).toMatchObject({ last_error: expect.stringContaining('Invalid login credentials') })
    expect(mailboxUpdate.eq).toHaveBeenCalledWith('id', 'mbx-1')

    const huntPatch = huntFinish.update.mock.calls[0][0]
    expect(huntPatch.outcome).toBe('error')
    expect(huntPatch.error).toMatch(/all mailboxes failed/i)

    const linePatch = lineUpdate.update.mock.calls[0][0]
    expect(linePatch).not.toHaveProperty('status')
  })

  it('partial IMAP failure: first mailbox auth-fails (last_error recorded), second yields a no-match candidate — hunt still finishes not_found with the failure in evidence.mailboxErrors', async () => {
    const MAILBOX_2 = { id: 'mbx-2', label: 'Ops 2', email: 'ops2@x.com', imap_password: 'app-pw-2', active: true }
    const budgetSelect = chainable({ data: [], error: null }, 'limit')
    const mailboxSelect = chainable({ data: [MAILBOX, MAILBOX_2], error: null }, 'eq')
    const priorHunts = chainable({ data: [], error: null }, 'not')
    const huntInsert = chainable({ data: { id: 'hunt-6' }, error: null }, 'single')
    const mailboxUpdate = chainable({ data: null, error: null }, 'eq')
    const lineUpdate = chainable({ data: null, error: null }, 'eq')
    const huntFinish = chainable({ data: null, error: null }, 'eq')
    const db = mockDbFrom(budgetSelect, mailboxSelect, priorHunts, huntInsert, mailboxUpdate, lineUpdate, huntFinish)

    stubWithMailbox()
    // The once-queue takes precedence over the base stub: the FIRST
    // withMailbox open (mailbox 1's collection pass) rejects with an
    // auth-flavoured error; mailbox 2's collection and the later
    // scoring open fall through to the base stub and proceed.
    withMailbox.mockRejectedValueOnce(new Error('IMAP LOGIN failed: invalid credentials'))

    searchRaw.mockResolvedValue([601])
    fetchCandidate.mockResolvedValueOnce({
      uid: 601, messageId: 'msg-second-box', subject: 'Maybe invoice', from: 'm@supplier.com',
      date: '2026-06-04', parts: [{ part: '2', contentType: 'application/pdf', filename: 'maybe.pdf' }],
    })
    downloadPart.mockResolvedValueOnce({ bytes: Buffer.from('maybe-bytes'), contentType: 'application/pdf', filename: 'maybe.pdf' })
    scoreHuntCandidate.mockResolvedValueOnce({ ok: true, verdict: { is_match: false, confidence: 0.1 }, spendUsd: 0.004 })
    isHuntMatch.mockReturnValueOnce(false)

    const result = await hunt.huntLine(db, LINE)

    // One healthy mailbox is enough — the hunt is NOT an error.
    expect(result).toEqual({ outcome: 'not_found', examined: 1 })
    // The failed mailbox's auth error was recorded on ITS row.
    expect(mailboxUpdate.update).toHaveBeenCalledTimes(1)
    expect(mailboxUpdate.update.mock.calls[0][0]).toMatchObject({ last_error: expect.stringContaining('credentials') })
    expect(mailboxUpdate.eq).toHaveBeenCalledWith('id', 'mbx-1')
    // The surviving mailbox's candidate was scored normally.
    expect(scoreHuntCandidate).toHaveBeenCalledTimes(1)
    expect(lineUpdate.update.mock.calls[0][0]).toMatchObject({ status: 'not_found' })
    // The finish row carries the examined id AND the partial-failure
    // evidence so a flaky inbox is diagnosable from the audit alone.
    const huntPatch = huntFinish.update.mock.calls[0][0]
    expect(huntPatch).toMatchObject({ outcome: 'not_found', llm_spend_usd: 0.004 })
    expect(huntPatch.examined_message_ids).toEqual(['msg-second-box'])
    expect(huntPatch.evidence).toEqual({
      mailboxErrors: [{ mailbox: 'ops@x.com', error: expect.stringContaining('credentials') }],
    })
    expect(huntFinish.eq).toHaveBeenCalledWith('id', 'hunt-6')
  })

  it('no-match: candidates score below threshold — line flips to not_found and the hunt row records examined ids + spend', async () => {
    const budgetSelect = chainable({ data: [], error: null }, 'limit')
    const mailboxSelect = chainable({ data: [MAILBOX], error: null }, 'eq')
    const priorHunts = chainable({ data: [], error: null }, 'not')
    const huntInsert = chainable({ data: { id: 'hunt-4' }, error: null }, 'single')
    const lineUpdate = chainable({ data: null, error: null }, 'eq')
    const huntFinish = chainable({ data: null, error: null }, 'eq')
    const db = mockDbFrom(budgetSelect, mailboxSelect, priorHunts, huntInsert, lineUpdate, huntFinish)

    stubWithMailbox()
    searchRaw.mockResolvedValue([401])
    fetchCandidate.mockResolvedValueOnce({
      uid: 401, messageId: 'msg-weak', subject: 'Quote', from: 'q@supplier.com',
      date: '2026-06-05', parts: [{ part: '2', contentType: 'application/pdf', filename: 'quote.pdf' }],
    })
    downloadPart.mockResolvedValueOnce({ bytes: Buffer.from('weak-bytes'), contentType: 'application/pdf', filename: 'quote.pdf' })
    scoreHuntCandidate.mockResolvedValueOnce({ ok: true, verdict: { is_match: false, confidence: 0.2 }, spendUsd: 0.005 })
    isHuntMatch.mockReturnValueOnce(false)

    const result = await hunt.huntLine(db, LINE)

    expect(result).toEqual({ outcome: 'not_found', examined: 1 })
    expect(lineUpdate.update.mock.calls[0][0]).toMatchObject({ status: 'not_found', hunt_attempts: 1 })
    const huntPatch = huntFinish.update.mock.calls[0][0]
    expect(huntPatch).toMatchObject({ outcome: 'not_found', llm_spend_usd: 0.005 })
    expect(huntPatch.examined_message_ids).toEqual(['msg-weak'])
  })

  it('cap: 6 candidates all carrying document parts are scored at most MAX_CANDIDATES_SCORED (4) times', async () => {
    const budgetSelect = chainable({ data: [], error: null }, 'limit')
    const mailboxSelect = chainable({ data: [MAILBOX], error: null }, 'eq')
    const priorHunts = chainable({ data: [], error: null }, 'not')
    const huntInsert = chainable({ data: { id: 'hunt-5' }, error: null }, 'single')
    const lineUpdate = chainable({ data: null, error: null }, 'eq')
    const huntFinish = chainable({ data: null, error: null }, 'eq')
    const db = mockDbFrom(budgetSelect, mailboxSelect, priorHunts, huntInsert, lineUpdate, huntFinish)

    stubWithMailbox()
    const uids = [501, 502, 503, 504, 505, 506]
    searchRaw.mockResolvedValue(uids)
    for (const uid of uids) {
      fetchCandidate.mockResolvedValueOnce({
        uid, messageId: `msg-${uid}`, subject: `Doc ${uid}`, from: 'x@supplier.com',
        // Spread dates so ranking is deterministic; all have a PDF part.
        date: `2026-06-0${uid - 500}`,
        parts: [{ part: '2', contentType: 'application/pdf', filename: `${uid}.pdf` }],
      })
    }
    downloadPart.mockResolvedValue({ bytes: Buffer.from('bytes'), contentType: 'application/pdf', filename: 'x.pdf' })
    scoreHuntCandidate.mockResolvedValue({ ok: true, verdict: { is_match: false, confidence: 0.1 }, spendUsd: 0.001 })
    isHuntMatch.mockReturnValue(false)

    const result = await hunt.huntLine(db, LINE)

    expect(result.outcome).toBe('not_found')
    expect(scoreHuntCandidate).toHaveBeenCalledTimes(4)
  })
})
