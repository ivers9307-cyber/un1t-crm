// RETIRE-SHIFTS-MIRROR.4 — tests for upsertShiftAssignment (find-or-create
// block + upsert assignment), the writer-side new-model entry point.
import { describe, it, expect } from 'vitest'
import { upsertShiftAssignment, bulkUpsertShiftAssignments, timesDiffer, overrideAgainstBlock, isRosterableProfile } from './roster-write'

// Per-table mock of the supabase builder. `existingBlock` null → the helper
// must create one; captured.blockInsert / captured.assignmentInsert record
// what was written. `template`/`profileLink` null stand in for the
// location-scoped lookups matching nothing (SAAS-1) — the route-level
// harness in assistant/chat/route.test.js is what actually applies the
// filters against a two-location fixture.
function makeDb({ template, existingBlock, newBlockId = 'blk-new', assignment = { id: 'a1' }, profileLink = { profile_id: 'p1' }, publishedRoster = null, publishedRosters = null,
  // AGENTROSTER.1 — the coach's EXISTING row on the block, if any. The
  // helper no longer blind-upserts, so a test can say "they are already on
  // this shift, with an adjusted window" and watch what happens to it.
  existingAssignment = null, assignmentInsertError = null,
  // STAFFDELETE.1 — the profiles row the writer checks before a NEW assignment.
  // Default: an active, living person, so earlier tests keep their meaning.
  profile = { id: 'p1', full_name: 'Coach One', active: true, deleted_at: null }, profileError = null } = {}) {
  const captured = { blockInsert: null, assignmentInsert: null, assignmentUpdate: null }
  const db = {
    captured,
    from(table) {
      // ROSTER-FIX.4 — findPublishedRosterFor's probe. `publishedRoster` is
      // the one-row shorthand; `publishedRosters` hands the probe a real set
      // and RUNS its date filters, ordering and limit(1), which is the only
      // way to test which roster wins when two of them cover the date.
      if (table === 'rosters') {
        if (publishedRosters) {
          let rows = publishedRosters
          const orders = []
          let cap = rows.length
          const chain = {
            select: () => chain,
            eq: () => chain,
            lte: (col, val) => { rows = rows.filter((r) => r[col] <= val); return chain },
            gte: (col, val) => { rows = rows.filter((r) => r[col] >= val); return chain },
            order: (col, opts) => { orders.push([col, opts?.ascending !== false ? 1 : -1]); return chain },
            limit: (n) => { cap = n; return chain },
            maybeSingle: () => {
              const sorted = [...rows].sort((a, b) => {
                for (const [col, dir] of orders) {
                  if (a[col] < b[col]) return -1 * dir
                  if (a[col] > b[col]) return 1 * dir
                }
                return 0
              })
              return Promise.resolve({ data: sorted.slice(0, cap)[0] || null, error: null })
            },
          }
          return chain
        }
        const chain = {
          select: () => chain, eq: () => chain, lte: () => chain, gte: () => chain, order: () => chain, limit: () => chain,
          maybeSingle: () => Promise.resolve({ data: publishedRoster, error: null }),
        }
        return chain
      }
      if (table === 'shift_templates') {
        const chain = { eq: () => chain, maybeSingle: () => Promise.resolve({ data: template, error: null }) }
        return { select: () => chain }
      }
      if (table === 'profile_locations') {
        const chain = { eq: () => chain, maybeSingle: () => Promise.resolve({ data: profileLink, error: null }) }
        return { select: () => chain }
      }
      if (table === 'profiles') {
        const chain = { eq: () => chain, maybeSingle: () => Promise.resolve({ data: profileError ? null : profile, error: profileError }) }
        return { select: (cols) => { captured.profileSelect = cols; return chain } }
      }
      if (table === 'shift_blocks') {
        return {
          select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: existingBlock, error: null }) }) }) }) }),
          insert: (row) => { captured.blockInsert = row; return { select: () => ({ single: () => Promise.resolve({ data: { id: newBlockId }, error: null }) }) } },
        }
      }
      if (table === 'shift_assignments') {
        const readChain = {
          eq: () => readChain,
          maybeSingle: () => Promise.resolve({ data: existingAssignment, error: null }),
        }
        return {
          select: () => readChain,
          insert: (row) => {
            captured.assignmentInsert = row
            return { select: () => ({ single: () => Promise.resolve({ data: assignmentInsertError ? null : assignment, error: assignmentInsertError }) }) }
          },
          update: (patch) => {
            captured.assignmentUpdate = patch
            const chain = {
              eq: () => chain,
              select: () => ({ single: () => Promise.resolve({ data: { ...(existingAssignment || {}), ...patch }, error: null }) }),
            }
            return chain
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  return db
}

const template = { start_time: '09:30:00', end_time: '10:30:00', max_coaches: 12 }
const base = { locationId: 'loc1', profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-06-08', actorId: 'mgr1' }

describe('upsertShiftAssignment', () => {
  it('reuses an existing block and upserts the assignment (no block insert)', async () => {
    const db = makeDb({ template, existingBlock: { id: 'blk-existing' } })
    const res = await upsertShiftAssignment(db, base)
    expect(res.error).toBeNull()
    expect(res.blockId).toBe('blk-existing')
    expect(db.captured.blockInsert).toBeNull()
    expect(db.captured.assignmentInsert).toMatchObject({ block_id: 'blk-existing', profile_id: 'p1', status: 'scheduled' })
    expect(res.created).toBe(true)
  })

  it('creates the block from template defaults when none exists', async () => {
    const db = makeDb({ template, existingBlock: null })
    const res = await upsertShiftAssignment(db, base)
    expect(res.error).toBeNull()
    expect(res.blockId).toBe('blk-new')
    expect(db.captured.blockInsert).toMatchObject({
      location_id: 'loc1', template_id: 't1', block_date: '2026-06-08',
      start_time: '09:30:00', end_time: '10:30:00', max_coaches: 12, created_by: 'mgr1',
    })
    expect(db.captured.assignmentInsert.block_id).toBe('blk-new')
  })

  it('defaults max_coaches to 15 when the template has none', async () => {
    const db = makeDb({ template: { start_time: '09:00:00', end_time: '10:00:00', max_coaches: null }, existingBlock: null })
    await upsertShiftAssignment(db, base)
    expect(db.captured.blockInsert.max_coaches).toBe(15)
  })

  // HORIZONMIN.1 — the single-row path had the same omission as the generator.
  it('writes the template min_coaches on a block it creates, clamped to max', async () => {
    const db = makeDb({ template: { ...template, min_coaches: 2 }, existingBlock: null })
    await upsertShiftAssignment(db, base)
    expect(db.captured.blockInsert).toMatchObject({ min_coaches: 2, max_coaches: 12 })

    const db2 = makeDb({ template: { ...template, min_coaches: 20, max_coaches: 3 }, existingBlock: null })
    await upsertShiftAssignment(db2, base)
    expect(db2.captured.blockInsert).toMatchObject({ min_coaches: 3, max_coaches: 3 })

    const db3 = makeDb({ template: { ...template, min_coaches: undefined }, existingBlock: null })
    await upsertShiftAssignment(db3, base)
    expect(db3.captured.blockInsert.min_coaches).toBe(1)
  })

  it('puts time overrides on the assignment, not the block', async () => {
    const db = makeDb({ template, existingBlock: null })
    await upsertShiftAssignment(db, { ...base, startTimeOverride: '08:00:00', endTimeOverride: '09:00:00' })
    // block keeps template defaults...
    expect(db.captured.blockInsert.start_time).toBe('09:30:00')
    // ...overrides ride on the assignment (mig 100)
    expect(db.captured.assignmentInsert).toMatchObject({ start_time_override: '08:00:00', end_time_override: '09:00:00' })
  })

  // AGENTROSTER.1 — "put this coach on this shift" must not be destructive on
  // a coach who is already on it. create_shift sends no overrides, and the old
  // blind upsert wrote every unset field back to null: the manager-set paid
  // window (mig 099/100) that every hours and cost reader bills was silently
  // cleared, the status reset to 'scheduled', and assigned_by re-stamped.
  describe('an existing assignment keeps what the caller did not name', () => {
    const onShift = {
      id: 'a-existing', block_id: 'blk-existing', profile_id: 'p1', status: 'confirmed',
    }

    it('writes NOTHING when the caller names no fields', async () => {
      const db = makeDb({ template, existingBlock: { id: 'blk-existing' }, existingAssignment: onShift })
      const res = await upsertShiftAssignment(db, base)
      expect(res.error).toBeNull()
      expect(res.created).toBe(false)
      expect(res.blockId).toBe('blk-existing')
      expect(db.captured.assignmentInsert).toBeNull()
      expect(db.captured.assignmentUpdate).toBeNull()
      expect(res.assignment).toEqual(onShift)
    })

    it('patches only the fields it was given', async () => {
      const db = makeDb({ template, existingBlock: { id: 'blk-existing' }, existingAssignment: onShift })
      await upsertShiftAssignment(db, { ...base, notes: 'cover' })
      expect(db.captured.assignmentUpdate).toEqual({ notes: 'cover' })
    })

    it('an explicit null still CLEARS an override', async () => {
      const db = makeDb({ template, existingBlock: { id: 'blk-existing' }, existingAssignment: onShift })
      await upsertShiftAssignment(db, { ...base, startTimeOverride: null, endTimeOverride: null })
      expect(db.captured.assignmentUpdate).toEqual({ start_time_override: null, end_time_override: null })
    })

    it('never re-stamps assigned_by on a row that already exists', async () => {
      const db = makeDb({ template, existingBlock: { id: 'blk-existing' }, existingAssignment: onShift })
      await upsertShiftAssignment(db, { ...base, status: 'completed', actorId: 'someone-else' })
      expect(db.captured.assignmentUpdate).toEqual({ status: 'completed' })
      expect(db.captured.assignmentUpdate).not.toHaveProperty('assigned_by')
    })

    it('a race lost to the unique index completes against the winning row', async () => {
      // Two callers both read "not on the shift"; the index (mig 067) picks a
      // winner and the loser must finish the request, not hand back a 23505.
      const db = makeDb({
        template, existingBlock: { id: 'blk-existing' },
        existingAssignment: null, assignmentInsertError: { code: '23505', message: 'duplicate key' },
      })
      // The post-conflict re-read uses the same mocked chain, so point it at
      // the winner by flipping the fixture the second time round.
      let reads = 0
      const inner = db.from
      db.from = (table) => {
        if (table !== 'shift_assignments') return inner(table)
        const handle = inner(table)
        const readChain = {
          eq: () => readChain,
          maybeSingle: () => Promise.resolve({ data: reads++ === 0 ? null : onShift, error: null }),
        }
        return { ...handle, select: () => readChain }
      }
      const res = await upsertShiftAssignment(db, base)
      expect(res.error).toBeNull()
      expect(res.created).toBe(false)
      expect(res.assignment).toEqual(onShift)
    })

    it('a genuine insert failure is still returned', async () => {
      const db = makeDb({
        template, existingBlock: { id: 'blk-existing' },
        assignmentInsertError: { code: '23503', message: 'fk violation' },
      })
      const res = await upsertShiftAssignment(db, base)
      expect(res.error?.message).toMatch(/fk violation/)
    })
  })

  it('errors on missing required input', async () => {
    const res = await upsertShiftAssignment(makeDb({ template }), { ...base, shiftDate: null })
    expect(res.error?.message).toMatch(/required/)
  })

  it('errors when the template is not found', async () => {
    const res = await upsertShiftAssignment(makeDb({ template: null, existingBlock: null }), base)
    expect(res.error?.message).toMatch(/template not found/)
  })

  it('errors when the profile is not linked to the location, with no writes (SAAS-1)', async () => {
    const db = makeDb({ template, existingBlock: null, profileLink: null })
    const res = await upsertShiftAssignment(db, base)
    expect(res.error?.message).toMatch(/not linked/)
    expect(db.captured.blockInsert).toBeNull()
    expect(db.captured.assignmentInsert).toBeNull()
  })

  // ROSTER-FIX.4 — a block created for a date inside an already-published
  // period must JOIN that roster. Left untagged it reads as unpublished to
  // every reader, so the coach just assigned to it never sees the shift.
  it('stamps roster_id on a block created inside an already-published period', async () => {
    const db = makeDb({ template, existingBlock: null, publishedRoster: { id: 'r-live' } })
    await upsertShiftAssignment(db, base)
    expect(db.captured.blockInsert.roster_id).toBe('r-live')
  })

  it('leaves roster_id null when no published roster covers the date', async () => {
    const db = makeDb({ template, existingBlock: null, publishedRoster: null })
    await upsertShiftAssignment(db, base)
    expect(db.captured.blockInsert.roster_id).toBeNull()
  })

  // ROSTER-FIX.4 — after a week→month superset publish BOTH rosters still
  // cover the date (the publish guard allows a containing period, and the
  // swallowed week's row stays). The month is the one that owns the day's
  // blocks, so a block created afterwards must join the MONTH — and must do
  // so every time, not per whatever order the rows come back in.
  it('joins the MONTH, not the swallowed week, after a superset publish', async () => {
    const rosters = [
      { id: 'r-week', period_start: '2026-06-01', period_end: '2026-06-07', created_at: '2026-05-20T09:00:00Z' },
      { id: 'r-month', period_start: '2026-06-01', period_end: '2026-06-30', created_at: '2026-05-28T09:00:00Z' },
    ]
    const db = makeDb({ template, existingBlock: null, publishedRosters: rosters })
    await upsertShiftAssignment(db, base)
    expect(db.captured.blockInsert.roster_id).toBe('r-month')

    const flipped = makeDb({ template, existingBlock: null, publishedRosters: [...rosters].reverse() })
    await upsertShiftAssignment(flipped, base)
    expect(flipped.captured.blockInsert.roster_id).toBe('r-month')
  })

  it('returns the validated template row so callers can reuse its name', async () => {
    const db = makeDb({ template: { ...template, name: 'AM Shift' }, existingBlock: { id: 'blk-existing' } })
    const res = await upsertShiftAssignment(db, base)
    expect(res.error).toBeNull()
    expect(res.template?.name).toBe('AM Shift')
  })
})

// Per-table mock for the batch writer. shift_blocks is queried twice —
// a select-chain (existing-block lookup) and an insert-chain (create) —
// so the builder supports both.
// STAFFDELETE.1 — `members` (profile ids linked to the location) and
// `profiles` (id/active/deleted_at rows) feed the writer's "still works here"
// filter. null = permissive: everyone asked about is a linked, active, living
// profile, so tests written before the filter keep their meaning.
function makeBulkDb({ templates = [], existingBlocks = [], createdBlocks = null, publishedRosters = [], rosterError = null, insertedAssignments = null, assignmentError = null, members = null, profiles = null, membershipError = null } = {}) {
  const captured = { blockInsert: null, blockInsertBatches: [], blockPages: [], assignmentUpsert: null, assignmentUpsertBatches: [], rosterQueries: [] }
  const db = {
    captured,
    from(table) {
      // ROSTER-FIX.4 — ONE range query for the whole span, not a probe per
      // date. The mock RUNS its overlap filters and ordering against
      // `publishedRosters` so the per-date match is really being tested, and
      // records each query so "one, not one per date" is assertable.
      if (table === 'rosters') {
        const q = { filters: [], orders: [] }
        captured.rosterQueries.push(q)
        let rows = publishedRosters
        const chain = {
          select: () => chain,
          eq: (col, val) => { q.filters.push(['eq', col, val]); return chain },
          lte: (col, val) => { q.filters.push(['lte', col, val]); rows = rows.filter((r) => r[col] <= val); return chain },
          gte: (col, val) => { q.filters.push(['gte', col, val]); rows = rows.filter((r) => r[col] >= val); return chain },
          order: (col, opts) => { q.orders.push([col, opts]); return chain },
          then: (onF, onR) => {
            if (rosterError) return Promise.resolve({ data: null, error: rosterError }).then(onF, onR)
            const sorted = [...rows].sort((a, b) => {
              for (const [col] of q.orders) {
                // Every order on this query is descending; a null sorts last.
                const av = a[col] ?? ''
                const bv = b[col] ?? ''
                if (av < bv) return 1
                if (av > bv) return -1
              }
              return 0
            })
            return Promise.resolve({ data: sorted, error: null }).then(onF, onR)
          },
        }
        return chain
      }
      if (table === 'profile_locations') {
        let scope = null
        const chain = {
          select: () => chain,
          eq: (col, val) => { scope = { col, val }; return chain },
          in: (col, ids) => {
            captured.membershipQuery = { scope, col, ids }
            if (membershipError) return Promise.resolve({ data: null, error: membershipError })
            return Promise.resolve({ data: ids.filter((id) => !members || members.includes(id)).map((id) => ({ profile_id: id })), error: null })
          },
        }
        return chain
      }
      if (table === 'profiles') {
        return { select: () => ({ in: (col, ids) => Promise.resolve({
          data: ids.map((id) => (profiles || []).find((x) => x.id === id) || { id, active: true, deleted_at: null }), error: null,
        }) }) }
      }
      if (table === 'shift_templates') {
        // ROSTER-FIX.4 — the bulk path scopes templates to the location too.
        return { select: () => ({ in: () => ({ eq: (col, val) => { captured.templateScope = { col, val }; return Promise.resolve({ data: templates, error: null }) } }) }) }
      }
      if (table === 'shift_blocks') {
        // COPYMODES.1 — the existing-block lookup pages (.order().range())
        // past the 1,000-row cap, and inserts are chunked; the mock pages
        // `existingBlocks` and records every insert batch.
        const chain = {
          eq: () => chain, in: () => chain, gte: () => chain, lte: () => chain, order: () => chain,
          range: (from, to) => {
            captured.blockPages.push([from, to])
            return Promise.resolve({ data: existingBlocks.slice(from, to + 1), error: null })
          },
        }
        return {
          select: () => chain,
          insert: (rows) => {
            captured.blockInsertBatches.push(rows)
            captured.blockInsert = captured.blockInsertBatches.flat()
            // Default: echo the inserted rows back with ids, as PostgREST does.
            const echo = createdBlocks ?? rows.map((r, i) => ({ id: `blk-new-${captured.blockInsertBatches.length}-${i}`, ...r }))
            return { select: () => Promise.resolve({ data: echo, error: null }) }
          },
        }
      }
      if (table === 'shift_assignments') {
        // COPYFIX.1 — the writer now chains `.select('id')` off the upsert
        // and derives `count` from the rows that call reports, not from the
        // payload it sent (ON CONFLICT DO NOTHING can insert fewer rows than
        // were offered). `insertedAssignments` lets a test say "the upsert
        // only actually inserted THESE"; the default mirrors every row back
        // so existing tests (written before ignoreDuplicates) keep their
        // count == payload-length behaviour.
        return {
          upsert: (rows, opts) => {
            captured.assignmentUpsertBatches.push(rows)
            captured.assignmentUpsert = { rows: captured.assignmentUpsertBatches.flat(), opts }
            return {
              select: () => Promise.resolve(
                assignmentError
                  ? { data: null, error: assignmentError }
                  : { data: insertedAssignments ?? rows.map((_, i) => ({ id: `ins-${i}` })), error: null },
              ),
            }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  return db
}

const tpl1 = { id: 't1', start_time: '09:00:00', end_time: '10:00:00', max_coaches: 12 }

describe('bulkUpsertShiftAssignments', () => {
  it('returns 0 with no error for an empty row set', async () => {
    const res = await bulkUpsertShiftAssignments(makeBulkDb(), { locationId: 'loc1', rows: [] })
    expect(res).toEqual({ count: 0, skippedRemoved: 0, error: null })
  })

  it('reuses existing blocks (no insert) and upserts assignments', async () => {
    const db = makeBulkDb({ templates: [tpl1], existingBlocks: [{ id: 'blk-x', template_id: 't1', block_date: '2026-06-08' }] })
    const res = await bulkUpsertShiftAssignments(db, {
      locationId: 'loc1', actorId: 'mgr1',
      rows: [{ profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-06-08', startTimeOverride: '08:00:00', endTimeOverride: null, notes: 'n' }],
    })
    expect(res).toEqual({ count: 1, skippedRemoved: 0, skippedNotAtStudio: 0, error: null })
    expect(db.captured.blockInsert).toBeNull()
    // ROSTER-FIX.4 (SAAS-1) — templates are read at the caller's location only
    expect(db.captured.templateScope).toEqual({ col: 'location_id', val: 'loc1' })
    expect(db.captured.assignmentUpsert.rows[0]).toMatchObject({
      block_id: 'blk-x', profile_id: 'p1', status: 'scheduled',
      start_time_override: '08:00:00', end_time_override: null, notes: 'n', assigned_by: 'mgr1',
    })
    expect(db.captured.assignmentUpsert.opts).toEqual({ onConflict: 'block_id,profile_id', ignoreDuplicates: true })
  })

  it('creates missing blocks from template defaults then references them', async () => {
    const db = makeBulkDb({
      templates: [tpl1], existingBlocks: [],
      createdBlocks: [{ id: 'blk-new', template_id: 't1', block_date: '2026-06-08' }],
    })
    const res = await bulkUpsertShiftAssignments(db, {
      locationId: 'loc1', actorId: 'mgr1',
      rows: [{ profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-06-08' }],
    })
    expect(res.count).toBe(1)
    expect(db.captured.blockInsert).toHaveLength(1)
    expect(db.captured.blockInsert[0]).toMatchObject({
      location_id: 'loc1', template_id: 't1', block_date: '2026-06-08',
      start_time: '09:00:00', end_time: '10:00:00', max_coaches: 12, created_by: 'mgr1',
    })
    expect(db.captured.assignmentUpsert.rows[0].block_id).toBe('blk-new')
  })

  it('dedups two rows that map to the same (block, profile)', async () => {
    const db = makeBulkDb({ templates: [tpl1], existingBlocks: [{ id: 'blk-x', template_id: 't1', block_date: '2026-06-08' }] })
    const res = await bulkUpsertShiftAssignments(db, {
      locationId: 'loc1',
      rows: [
        { profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-06-08', notes: 'first' },
        { profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-06-08', notes: 'second' },
      ],
    })
    expect(res.count).toBe(1)
    expect(db.captured.assignmentUpsert.rows).toHaveLength(1)
    expect(db.captured.assignmentUpsert.rows[0].notes).toBe('second') // last wins
  })

  it('defaults max_coaches to 15 when the template has none', async () => {
    const db = makeBulkDb({
      templates: [{ id: 't1', start_time: '09:00:00', end_time: '10:00:00', max_coaches: null }],
      existingBlocks: [], createdBlocks: [{ id: 'blk-new', template_id: 't1', block_date: '2026-06-08' }],
    })
    await bulkUpsertShiftAssignments(db, { locationId: 'loc1', rows: [{ profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-06-08' }] })
    expect(db.captured.blockInsert[0].max_coaches).toBe(15)
  })

  // ROSTER-FIX.4 — same rule for the copy-week / copy-month batch writer, but
  // resolved for the whole span in ONE query. It used to probe once per
  // distinct date, which is up to 31 round trips for a copy-month.
  it('stamps roster_id per date from a single range query', async () => {
    const db = makeBulkDb({
      templates: [tpl1], existingBlocks: [],
      createdBlocks: [
        { id: 'blk-a', template_id: 't1', block_date: '2026-06-08' },
        { id: 'blk-b', template_id: 't1', block_date: '2026-06-15' },
      ],
      publishedRosters: [
        { id: 'r-live', period_start: '2026-06-01', period_end: '2026-06-10', published_at: '2026-05-30T09:00:00Z', created_at: '2026-05-30T09:00:00Z' },
      ],
    })
    await bulkUpsertShiftAssignments(db, {
      locationId: 'loc1',
      rows: [
        { profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-06-08' },
        { profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-06-15' },
      ],
    })
    const byDate = Object.fromEntries(db.captured.blockInsert.map((b) => [b.block_date, b.roster_id]))
    expect(byDate['2026-06-08']).toBe('r-live')
    // Outside the published period — the query returned the row, the per-date
    // match is what rules it out.
    expect(byDate['2026-06-15']).toBeNull()
    // ONE query for two dates.
    expect(db.captured.rosterQueries).toHaveLength(1)
    const q = db.captured.rosterQueries[0]
    expect(q.filters).toContainEqual(['eq', 'location_id', 'loc1'])
    expect(q.filters).toContainEqual(['eq', 'status', 'published'])
    // Overlap against the SPAN, not one date: starts on or before the last
    // date, ends on or after the first.
    expect(q.filters).toContainEqual(['lte', 'period_start', '2026-06-15'])
    expect(q.filters).toContainEqual(['gte', 'period_end', '2026-06-08'])
    expect(q.orders).toEqual([
      ['published_at', { ascending: false, nullsFirst: false }],
      ['created_at', { ascending: false }],
    ])
  })

  // The publish guard allows a period that CONTAINS a published one, and the
  // swallowed week's row stays behind — so two rosters can cover one date.
  // The one published most recently owns the day's blocks.
  it('joins the most recently published roster when two cover the date', async () => {
    const rosters = [
      { id: 'r-week', period_start: '2026-06-01', period_end: '2026-06-07', published_at: '2026-05-20T09:00:00Z', created_at: '2026-05-20T09:00:00Z' },
      { id: 'r-month', period_start: '2026-06-01', period_end: '2026-06-30', published_at: '2026-05-28T09:00:00Z', created_at: '2026-05-28T09:00:00Z' },
    ]
    for (const set of [rosters, [...rosters].reverse()]) {
      const db = makeBulkDb({
        templates: [tpl1], existingBlocks: [],
        createdBlocks: [{ id: 'blk-a', template_id: 't1', block_date: '2026-06-03' }],
        publishedRosters: set,
      })
      await bulkUpsertShiftAssignments(db, {
        locationId: 'loc1', rows: [{ profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-06-03' }],
      })
      expect(db.captured.blockInsert[0].roster_id).toBe('r-month')
    }
  })

  it('a never-published row (published_at null) loses to one that has been', async () => {
    const db = makeBulkDb({
      templates: [tpl1], existingBlocks: [],
      createdBlocks: [{ id: 'blk-a', template_id: 't1', block_date: '2026-06-03' }],
      publishedRosters: [
        { id: 'r-old', period_start: '2026-06-01', period_end: '2026-06-30', published_at: null, created_at: '2026-05-29T09:00:00Z' },
        { id: 'r-new', period_start: '2026-06-01', period_end: '2026-06-07', published_at: '2026-05-20T09:00:00Z', created_at: '2026-05-20T09:00:00Z' },
      ],
    })
    await bulkUpsertShiftAssignments(db, {
      locationId: 'loc1', rows: [{ profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-06-03' }],
    })
    expect(db.captured.blockInsert[0].roster_id).toBe('r-new')
  })

  it('a failed roster lookup leaves the blocks unattached rather than losing the copy', async () => {
    const db = makeBulkDb({
      templates: [tpl1], existingBlocks: [],
      createdBlocks: [{ id: 'blk-a', template_id: 't1', block_date: '2026-06-08' }],
      rosterError: { message: 'statement timeout' },
    })
    const res = await bulkUpsertShiftAssignments(db, {
      locationId: 'loc1', rows: [{ profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-06-08' }],
    })
    // Fails soft, exactly as findPublishedRosterFor does: the operator's
    // copy-week survives, the blocks just aren't on a roster yet.
    expect(res).toEqual({ count: 1, skippedRemoved: 0, skippedNotAtStudio: 0, error: null })
    expect(db.captured.blockInsert[0].roster_id).toBeNull()
  })

  it('does not query for a roster when every block already exists', async () => {
    const db = makeBulkDb({ templates: [tpl1], existingBlocks: [{ id: 'blk-x', template_id: 't1', block_date: '2026-06-08' }] })
    await bulkUpsertShiftAssignments(db, { locationId: 'loc1', rows: [{ profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-06-08' }] })
    expect(db.captured.rosterQueries).toHaveLength(0)
  })

  it('errors when a referenced template is missing', async () => {
    const db = makeBulkDb({ templates: [] })
    const res = await bulkUpsertShiftAssignments(db, { locationId: 'loc1', rows: [{ profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-06-08' }] })
    expect(res.error?.message).toMatch(/shift_template not found/)
    expect(res.count).toBe(0)
  })

  // COPYFIX.1 — ON CONFLICT DO NOTHING can insert fewer rows than the
  // payload offered (an existing target row is skipped, not overwritten).
  // `count` must reflect what the upsert actually inserted.
  it('counts the rows the upsert actually inserted, not the payload length', async () => {
    const db = makeBulkDb({
      templates: [tpl1],
      existingBlocks: [{ id: 'blk-x', template_id: 't1', block_date: '2026-06-08' }],
      // Two rows offered, only one comes back — the other hit an existing
      // (block, profile) row and was skipped by ignoreDuplicates.
      insertedAssignments: [{ id: 'ins-1' }],
    })
    const res = await bulkUpsertShiftAssignments(db, {
      locationId: 'loc1',
      rows: [
        { profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-06-08' },
        { profileId: 'p2', shiftTemplateId: 't1', shiftDate: '2026-06-08' },
      ],
    })
    expect(res).toEqual({ count: 1, skippedRemoved: 0, skippedNotAtStudio: 0, error: null })
    expect(db.captured.assignmentUpsert.rows).toHaveLength(2)
    expect(db.captured.assignmentUpsert.opts).toEqual({ onConflict: 'block_id,profile_id', ignoreDuplicates: true })
  })

  it('returns { count: 0, error } when the assignment upsert errors', async () => {
    const db = makeBulkDb({
      templates: [tpl1],
      existingBlocks: [{ id: 'blk-x', template_id: 't1', block_date: '2026-06-08' }],
      assignmentError: { message: 'upsert boom' },
    })
    const res = await bulkUpsertShiftAssignments(db, {
      locationId: 'loc1',
      rows: [{ profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-06-08' }],
    })
    expect(res).toEqual({ count: 0, skippedRemoved: 0, skippedNotAtStudio: 0, error: { message: 'upsert boom' } })
  })
})

// COPYMODES.1 — exact vs template copies share this writer.
describe('bulkUpsertShiftAssignments — COPYMODES.1', () => {
  const tplMin = { id: 't1', start_time: '09:00:00', end_time: '10:00:00', min_coaches: 2, max_coaches: 12 }

  it('writes the template min_coaches on a block it creates (it used to fall to the DB default)', async () => {
    const db = makeBulkDb({ templates: [tplMin] })
    await bulkUpsertShiftAssignments(db, { locationId: 'loc1', rows: [{ profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-06-08' }] })
    expect(db.captured.blockInsert[0]).toMatchObject({ min_coaches: 2, max_coaches: 12, start_time: '09:00:00', end_time: '10:00:00' })
  })

  it('defaults min_coaches to 1 and clamps it to max_coaches (mig 177 CHECK)', async () => {
    const db = makeBulkDb({ templates: [{ ...tplMin, min_coaches: null, max_coaches: null }] })
    await bulkUpsertShiftAssignments(db, {
      locationId: 'loc1',
      rows: [{ profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-06-08' }],
      blocks: [{ shiftTemplateId: 't1', shiftDate: '2026-06-09', minCoaches: 9, maxCoaches: 4 }],
    })
    const byDate = Object.fromEntries(db.captured.blockInsert.map((b) => [b.block_date, b]))
    expect(byDate['2026-06-08']).toMatchObject({ min_coaches: 1, max_coaches: 15 })
    expect(byDate['2026-06-09']).toMatchObject({ min_coaches: 4, max_coaches: 4 })
  })

  it('ensures a listed block with nobody on it, seeded from the spec not the template', async () => {
    const db = makeBulkDb({ templates: [tplMin] })
    const res = await bulkUpsertShiftAssignments(db, {
      locationId: 'loc1', actorId: 'mgr1', rows: [],
      blocks: [{ shiftTemplateId: 't1', shiftDate: '2026-06-08', startTime: '06:30:00', endTime: '08:00:00', minCoaches: 1, maxCoaches: 3 }],
    })
    expect(res).toEqual({ count: 0, skippedRemoved: 0, skippedNotAtStudio: 0, error: null })
    expect(db.captured.blockInsert).toEqual([expect.objectContaining({
      template_id: 't1', block_date: '2026-06-08', start_time: '06:30:00', end_time: '08:00:00', min_coaches: 1, max_coaches: 3, created_by: 'mgr1',
    })])
    expect(db.captured.assignmentUpsert).toBeNull()
  })

  it('never touches a block that already exists, even when a spec lists different times', async () => {
    const db = makeBulkDb({ templates: [tplMin], existingBlocks: [{ id: 'blk-x', template_id: 't1', block_date: '2026-06-08', start_time: '09:00:00', end_time: '10:00:00' }] })
    await bulkUpsertShiftAssignments(db, {
      locationId: 'loc1', rows: [],
      blocks: [{ shiftTemplateId: 't1', shiftDate: '2026-06-08', startTime: '06:30:00', endTime: '08:00:00' }],
    })
    expect(db.captured.blockInsert).toBeNull()
  })

  it('exact: absolute times on a block created at the source times carry NO redundant override', async () => {
    const db = makeBulkDb({ templates: [tplMin] })
    await bulkUpsertShiftAssignments(db, {
      locationId: 'loc1',
      blocks: [{ shiftTemplateId: 't1', shiftDate: '2026-06-08', startTime: '09:30:00', endTime: '10:00:00' }],
      rows: [
        { profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-06-08', startTime: '09:30:00', endTime: '10:00:00' },
        { profileId: 'p2', shiftTemplateId: 't1', shiftDate: '2026-06-08', startTime: '09:30:00', endTime: '09:45:00', partialReason: 'dentist', notes: 'n' },
      ],
    })
    expect(db.captured.blockInsert[0]).toMatchObject({ start_time: '09:30:00', end_time: '10:00:00' })
    expect(db.captured.assignmentUpsert.rows).toEqual([
      expect.objectContaining({ profile_id: 'p1', start_time_override: null, end_time_override: null, partial_reason: null }),
      expect.objectContaining({ profile_id: 'p2', start_time_override: null, end_time_override: '09:45:00', partial_reason: 'dentist', notes: 'n' }),
    ])
  })

  it('exact: on a pre-existing block at template times the override carries the difference', async () => {
    const db = makeBulkDb({ templates: [tplMin], existingBlocks: [{ id: 'blk-x', template_id: 't1', block_date: '2026-06-08', start_time: '09:00:00', end_time: '10:00:00' }] })
    await bulkUpsertShiftAssignments(db, {
      locationId: 'loc1',
      blocks: [{ shiftTemplateId: 't1', shiftDate: '2026-06-08', startTime: '09:30:00', endTime: '10:00:00' }],
      rows: [{ profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-06-08', startTime: '09:30:00', endTime: '10:00:00' }],
    })
    expect(db.captured.blockInsert).toBeNull()
    expect(db.captured.assignmentUpsert.rows[0]).toMatchObject({ block_id: 'blk-x', start_time_override: '09:30:00', end_time_override: null })
  })

  // Review fix — template mode sends the TEMPLATE's times as absolute times,
  // so a coach copied onto a hand-edited target block still works the template
  // slot's defined hours; on an unedited block no override is written.
  it('template: onto a hand-edited target block the coach lands at the template times via an override', async () => {
    const db = makeBulkDb({ templates: [tplMin], existingBlocks: [{ id: 'blk-x', template_id: 't1', block_date: '2026-06-08', start_time: '11:00:00', end_time: '12:00:00' }] })
    await bulkUpsertShiftAssignments(db, {
      locationId: 'loc1',
      rows: [{ profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-06-08', startTime: '09:00:00', endTime: '10:00:00', partialReason: null, notes: null }],
    })
    expect(db.captured.blockInsert).toBeNull()
    expect(db.captured.assignmentUpsert.rows[0]).toMatchObject({ block_id: 'blk-x', start_time_override: '09:00:00', end_time_override: '10:00:00', partial_reason: null, notes: null })
  })

  it('template: onto a block at the template times (or one it creates) no override is written', async () => {
    const db = makeBulkDb({ templates: [tplMin], existingBlocks: [{ id: 'blk-x', template_id: 't1', block_date: '2026-06-08', start_time: '09:00:00', end_time: '10:00:00' }] })
    await bulkUpsertShiftAssignments(db, {
      locationId: 'loc1',
      rows: [
        { profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-06-08', startTime: '09:00:00', endTime: '10:00:00' },
        { profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-06-09', startTime: '09:00:00', endTime: '10:00:00' },
      ],
    })
    expect(db.captured.blockInsert).toEqual([expect.objectContaining({ block_date: '2026-06-09', start_time: '09:00:00', end_time: '10:00:00' })])
    for (const r of db.captured.assignmentUpsert.rows) {
      expect(r).toMatchObject({ start_time_override: null, end_time_override: null })
    }
  })

  it('pages the existing-block lookup and chunks the writes under the 1,000-row cap', async () => {
    // 1,200 existing blocks: one per day index, so the lookup needs two pages.
    const existing = Array.from({ length: 1200 }, (_, i) => ({ id: `blk-${i}`, template_id: 't1', block_date: `d${String(i).padStart(4, '0')}`, start_time: '09:00:00', end_time: '10:00:00' }))
    const db = makeBulkDb({ templates: [tplMin], existingBlocks: existing })
    const rows = existing.map((b) => ({ profileId: 'p1', shiftTemplateId: 't1', shiftDate: b.block_date }))
    const res = await bulkUpsertShiftAssignments(db, { locationId: 'loc1', rows })
    expect(db.captured.blockPages).toEqual([[0, 999], [1000, 1999]])
    expect(db.captured.blockInsert).toBeNull() // every block was found, none re-inserted
    expect(db.captured.assignmentUpsertBatches.map((b) => b.length)).toEqual([500, 500, 200])
    expect(res).toEqual({ count: 1200, skippedRemoved: 0, skippedNotAtStudio: 0, error: null })
  })
})

describe('timesDiffer / overrideAgainstBlock', () => {
  it('treats HH:MM and HH:MM:SS as the same time', () => {
    expect(timesDiffer('09:30', '09:30:00')).toBe(false)
    expect(timesDiffer('09:30:00', '09:45:00')).toBe(true)
  })
  it('only returns an override when the time differs from the block', () => {
    expect(overrideAgainstBlock('09:30:00', '09:30:00')).toBeNull()
    expect(overrideAgainstBlock('09:15:00', '09:30:00')).toBe('09:15:00')
    expect(overrideAgainstBlock(null, '09:30:00')).toBeNull()
  })
})

// SLOTREMOVAL.1 — a slot a manager deleted is not re-created by a copy.
describe('bulkUpsertShiftAssignments — removed slots', () => {
  const REMOVED = new Set(['t1|2026-06-09'])

  it('neither creates a removed slot nor places its coaches, and counts them as skippedRemoved', async () => {
    const db = makeBulkDb({ templates: [tpl1] })
    const res = await bulkUpsertShiftAssignments(db, {
      locationId: 'loc1',
      removedSlots: REMOVED,
      rows: [
        { profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-06-08' },
        { profileId: 'p2', shiftTemplateId: 't1', shiftDate: '2026-06-09' },
        { profileId: 'p3', shiftTemplateId: 't1', shiftDate: '2026-06-09' },
      ],
      blocks: [{ shiftTemplateId: 't1', shiftDate: '2026-06-09' }, { shiftTemplateId: 't1', shiftDate: '2026-06-10' }],
    })
    expect(res).toEqual({ count: 1, skippedRemoved: 2, skippedNotAtStudio: 0, error: null })
    expect(db.captured.blockInsert.map((b) => b.block_date).sort()).toEqual(['2026-06-08', '2026-06-10'])
    expect(db.captured.assignmentUpsert.rows.map((r) => r.profile_id)).toEqual(['p1'])
  })

  it('writes to a removed slot whose block exists again (restored by hand) as normal', async () => {
    const db = makeBulkDb({
      templates: [tpl1],
      existingBlocks: [{ id: 'blk-back', template_id: 't1', block_date: '2026-06-09', start_time: '09:00:00', end_time: '10:00:00' }],
    })
    const res = await bulkUpsertShiftAssignments(db, {
      locationId: 'loc1',
      removedSlots: REMOVED,
      rows: [{ profileId: 'p2', shiftTemplateId: 't1', shiftDate: '2026-06-09' }],
    })
    expect(res).toEqual({ count: 1, skippedRemoved: 0, skippedNotAtStudio: 0, error: null })
    expect(db.captured.assignmentUpsert.rows[0].block_id).toBe('blk-back')
  })

  it('writes nothing when every slot was removed', async () => {
    const db = makeBulkDb({ templates: [tpl1] })
    const res = await bulkUpsertShiftAssignments(db, {
      locationId: 'loc1',
      removedSlots: REMOVED,
      rows: [{ profileId: 'p2', shiftTemplateId: 't1', shiftDate: '2026-06-09' }],
      blocks: [{ shiftTemplateId: 't1', shiftDate: '2026-06-09' }],
    })
    expect(res).toEqual({ count: 0, skippedRemoved: 1, skippedNotAtStudio: 0, error: null })
    expect(db.captured.blockInsertBatches).toHaveLength(0)
    expect(db.captured.assignmentUpsert).toBeNull()
  })
})

// STAFFDELETE.1 — a permanent delete KEEPS past shifts (that is the point), so
// the source period of the next Copy Last Week / Month still names the deleted
// person. The single-assign path checks profile_locations; this batch writer —
// the one point both copy routes pass through — did not, so a copy would have
// put a tombstone straight back on upcoming shifts.
describe('bulkUpsertShiftAssignments — only people who still work at the TARGET studio', () => {
  const rows = [
    { profileId: 'p-here', shiftTemplateId: 't1', shiftDate: '2026-06-08' },
    { profileId: 'p-gone', shiftTemplateId: 't1', shiftDate: '2026-06-08' },
    { profileId: 'p-gone', shiftTemplateId: 't1', shiftDate: '2026-06-09' },
  ]

  it('drops rows for a profile with no profile_locations row at the location, and counts them', async () => {
    const db = makeBulkDb({ templates: [tpl1], members: ['p-here'] })
    const res = await bulkUpsertShiftAssignments(db, { locationId: 'loc1', rows })
    expect(res).toEqual({ count: 1, skippedRemoved: 0, skippedNotAtStudio: 2, error: null })
    expect(db.captured.assignmentUpsert.rows.map((r) => r.profile_id)).toEqual(['p-here'])
    // Membership is asked about the TARGET location, for exactly the people on the rows.
    expect(db.captured.membershipQuery).toEqual({ scope: { col: 'location_id', val: 'loc1' }, col: 'profile_id', ids: ['p-here', 'p-gone'] })
  })

  it('drops a DEACTIVATED member and a TOMBSTONE even if a membership row lingers; active NULL is a legacy active row', async () => {
    const db = makeBulkDb({
      templates: [tpl1],
      profiles: [
        { id: 'p-off', active: false, deleted_at: null },
        { id: 'p-tomb', active: false, deleted_at: '2026-09-19T10:00:00Z' },
        { id: 'p-legacy', active: null, deleted_at: null },
      ],
    })
    const res = await bulkUpsertShiftAssignments(db, {
      locationId: 'loc1',
      rows: ['p-off', 'p-tomb', 'p-legacy'].map((profileId) => ({ profileId, shiftTemplateId: 't1', shiftDate: '2026-06-08' })),
    })
    expect(res).toEqual({ count: 1, skippedRemoved: 0, skippedNotAtStudio: 2, error: null })
    expect(db.captured.assignmentUpsert.rows.map((r) => r.profile_id)).toEqual(['p-legacy'])
  })

  it('a profile the profiles read does not return at all is dropped (fail closed per person)', async () => {
    const db = makeBulkDb({ templates: [tpl1] })
    const realFrom = db.from.bind(db)
    db.from = (t) => (t === 'profiles' ? { select: () => ({ in: () => Promise.resolve({ data: [{ id: 'p-here', active: true, deleted_at: null }], error: null }) }) } : realFrom(t))
    const res = await bulkUpsertShiftAssignments(db, { locationId: 'loc1', rows })
    expect(res).toMatchObject({ count: 1, skippedNotAtStudio: 2 })
  })

  it('an unreadable membership list stops the copy BEFORE anything is written', async () => {
    const db = makeBulkDb({ templates: [tpl1], membershipError: { message: 'down' } })
    const res = await bulkUpsertShiftAssignments(db, { locationId: 'loc1', rows })
    expect(res.error).toEqual({ message: 'down' })
    expect(res.count).toBe(0)
    expect(db.captured.blockInsertBatches).toHaveLength(0)
    expect(db.captured.assignmentUpsert).toBeNull()
  })

  it('a row on a manager-deleted slot is counted once, as skippedRemoved', async () => {
    const db = makeBulkDb({ templates: [tpl1], members: ['p-here'] })
    const res = await bulkUpsertShiftAssignments(db, { locationId: 'loc1', rows, removedSlots: new Set(['t1|2026-06-09']) })
    expect(res).toEqual({ count: 1, skippedRemoved: 1, skippedNotAtStudio: 1, error: null })
  })
})

// STAFFDELETE.1 review A — the two write paths must agree. The copy path
// dropped a deactivated coach while the single-assign path (which checked only
// profile_locations) would still roster them by hand. ONE predicate, the
// STRICTER rule: a deactivated or permanently deleted profile cannot be put on
// a shift by any path.
describe('isRosterableProfile — the one predicate both write paths use', () => {
  it('active (or legacy NULL) and not a tombstone', () => {
    expect(isRosterableProfile({ id: 'p', active: true, deleted_at: null })).toBe(true)
    expect(isRosterableProfile({ id: 'p', active: null, deleted_at: null })).toBe(true)
    expect(isRosterableProfile({ id: 'p', active: false, deleted_at: null })).toBe(false)
    expect(isRosterableProfile({ id: 'p', active: false, deleted_at: '2026-09-19T10:00:00Z' })).toBe(false)
    expect(isRosterableProfile(null)).toBe(false)
    expect(isRosterableProfile(undefined)).toBe(false)
  })
})

describe('upsertShiftAssignment — a deactivated or deleted coach cannot be rostered by hand', () => {
  const template = { name: 'AM Shift', start_time: '09:00:00', end_time: '10:00:00', min_coaches: 1, max_coaches: 12 }
  const input = { locationId: 'loc1', profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-06-08' }

  it('deactivated but still linked → a clear, actionable error; no block, no assignment', async () => {
    const db = makeDb({ template, existingBlock: null, profile: { id: 'p1', full_name: 'Former Coach', active: false, deleted_at: null } })
    const res = await upsertShiftAssignment(db, input)
    expect(res.error).toEqual({ message: 'Former Coach is deactivated and cannot be rostered. Reactivate them in Settings > Staff first.', code: 'profile_not_rosterable' })
    expect(db.captured.blockInsert).toBeNull()
    expect(db.captured.assignmentInsert).toBeNull()
  })

  it('a tombstone → refused, and NOT told to reactivate (it cannot be)', async () => {
    const db = makeDb({ template, existingBlock: { id: 'blk-1' }, profile: { id: 'p1', full_name: 'Former Coach', active: false, deleted_at: '2026-09-19T10:00:00Z' } })
    const res = await upsertShiftAssignment(db, input)
    expect(res.error).toEqual({ message: 'Former Coach was permanently deleted and cannot be rostered.', code: 'profile_not_rosterable' })
    expect(db.captured.assignmentInsert).toBeNull()
  })

  it('a missing or unreadable profile fails closed', async () => {
    let db = makeDb({ template, existingBlock: { id: 'blk-1' }, profile: null })
    expect((await upsertShiftAssignment(db, input)).error?.message).toMatch(/profile not found/)
    db = makeDb({ template, existingBlock: { id: 'blk-1' }, profileError: { message: 'down' } })
    expect((await upsertShiftAssignment(db, input)).error).toEqual({ message: 'down' })
    expect(db.captured.assignmentInsert).toBeNull()
  })

  it('EDITING a shift they are already on still works — cancelling a leaver\'s shift, or correcting past hours, is not rostering', async () => {
    const db = makeDb({
      template, existingBlock: { id: 'blk-1' }, existingAssignment: { id: 'a-old', block_id: 'blk-1', profile_id: 'p1', status: 'scheduled' },
      profile: { id: 'p1', full_name: 'Former Coach', active: false, deleted_at: null },
    })
    const res = await upsertShiftAssignment(db, { ...input, status: 'cancelled' })
    expect(res.error).toBeNull()
    expect(res.created).toBe(false)
    expect(db.captured.assignmentUpdate).toMatchObject({ status: 'cancelled' })
  })

  it('control: an active coach is assigned as before, and only named columns are read', async () => {
    const db = makeDb({ template, existingBlock: { id: 'blk-1' } })
    const res = await upsertShiftAssignment(db, input)
    expect(res).toMatchObject({ created: true, error: null })
    expect(db.captured.profileSelect).toBe('id, full_name, active, deleted_at')
  })
})
