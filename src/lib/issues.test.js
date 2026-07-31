// REPORT-ISSUE.1 + .2 — unit tests for the pure helpers + the
// insert/list helpers + the handler-side state transitions via a
// mocked Supabase chainable.

import { describe, it, expect, vi } from 'vitest'
import {
  ISSUE_STATUS,
  ISSUE_INBOX_OPEN_STATUSES,
  MAX_PHOTOS_PER_ISSUE,
  MAX_PHOTO_BYTES,
  slugifyFilename,
  buildAttachmentPath,
  validateSubmission,
  insertIssueWithAttachments,
  listMyIssues,
  getMyIssue,
  listInboxIssues,
  countInboxIssues,
  getInboxIssue,
  claimIssue,
  resolveIssue,
  closeIssue,
} from './issues.js'

// ----------------------------------------------------------------
// slugifyFilename
// ----------------------------------------------------------------

describe('slugifyFilename', () => {
  it('lowercases + replaces spaces with hyphens + preserves extension', () => {
    expect(slugifyFilename('Broken Kit.JPEG')).toBe('broken-kit.jpeg')
  })

  it('strips diacritics + punctuation', () => {
    expect(slugifyFilename('Bröken kit!.png')).toBe('broken-kit.png')
  })

  it('handles iOS-style duplicate names with parens', () => {
    expect(slugifyFilename('IMG_0001 (1).JPEG')).toBe('img_0001-1.jpeg')
  })

  it('falls back to "photo" for an empty / null input', () => {
    expect(slugifyFilename('')).toBe('photo')
    expect(slugifyFilename(null)).toBe('photo')
  })

  it('caps the base slug at 60 chars to keep paths short', () => {
    const long = 'a'.repeat(200) + '.jpg'
    const out = slugifyFilename(long)
    // 60 a's + .jpg = 64 chars
    expect(out.length).toBeLessThanOrEqual(64)
    expect(out.endsWith('.jpg')).toBe(true)
  })

  it('strips dotless tails — never produces a stray "." at the end', () => {
    expect(slugifyFilename('weird.')).toBe('weird')
  })
})

// ----------------------------------------------------------------
// buildAttachmentPath
// ----------------------------------------------------------------

describe('buildAttachmentPath', () => {
  it('lays out {location}/{issue}/{attachment}-{slug}', () => {
    const p = buildAttachmentPath({
      locationId: 'loc-1', issueId: 'iss-2', attachmentId: 'att-3',
      filename: 'Broken Treadmill.JPG',
    })
    expect(p).toBe('loc-1/iss-2/att-3-broken-treadmill.jpg')
  })

  it('throws when required ids are missing', () => {
    expect(() => buildAttachmentPath({ locationId: 'a', issueId: 'b' }))
      .toThrow(/attachmentId/i)
  })

  it("handles a filename with no extension cleanly", () => {
    const p = buildAttachmentPath({
      locationId: 'L', issueId: 'I', attachmentId: 'A', filename: 'screenshot',
    })
    expect(p).toBe('L/I/A-screenshot')
  })
})

// ----------------------------------------------------------------
// validateSubmission
// ----------------------------------------------------------------

const goodPhoto = { filename: 'a.jpg', size: 1024, type: 'image/jpeg' }

describe('validateSubmission', () => {
  it('rejects an empty / whitespace description', () => {
    const out = validateSubmission({ description: '   ', photos: [] })
    expect(out.ok).toBe(false)
    expect(out.code).toBe('description_required')
  })

  it('rejects an enormous description', () => {
    const out = validateSubmission({ description: 'x'.repeat(5000) })
    expect(out.ok).toBe(false)
    expect(out.code).toBe('description_too_long')
  })

  it('accepts a description with no photos', () => {
    const out = validateSubmission({ description: 'Broken thing.' })
    expect(out.ok).toBe(true)
    expect(out.normalised.description).toBe('Broken thing.')
    expect(out.normalised.photos).toEqual([])
  })

  it(`rejects more than ${MAX_PHOTOS_PER_ISSUE} photos`, () => {
    const photos = Array(MAX_PHOTOS_PER_ISSUE + 1).fill(goodPhoto)
    const out = validateSubmission({ description: 'd', photos })
    expect(out.code).toBe('too_many_photos')
  })

  it('rejects a photo over the size cap', () => {
    const out = validateSubmission({
      description: 'd',
      photos: [{ ...goodPhoto, size: MAX_PHOTO_BYTES + 1 }],
    })
    expect(out.code).toBe('photo_too_large')
  })

  it('rejects an unsupported mime type', () => {
    const out = validateSubmission({
      description: 'd',
      photos: [{ ...goodPhoto, type: 'application/pdf' }],
    })
    expect(out.code).toBe('photo_bad_type')
  })

  it('accepts HEIC + WebP — common iOS / Android camera defaults', () => {
    const heic = { filename: 'a.heic', size: 1024, type: 'image/heic' }
    const webp = { filename: 'a.webp', size: 1024, type: 'image/webp' }
    expect(validateSubmission({ description: 'd', photos: [heic, webp] }).ok).toBe(true)
  })

  it('trims the description', () => {
    const out = validateSubmission({ description: '   leading + trailing  ' })
    expect(out.normalised.description).toBe('leading + trailing')
  })
})

// ----------------------------------------------------------------
// insertIssueWithAttachments — mocked supabase chainable
// ----------------------------------------------------------------

function makeDb({
  issueInsertResult = { data: { id: 'iss-1', location_id: 'loc-1', submitter_id: 'p-1', description: 'd', status: 'open', created_at: 't' }, error: null },
  attachInsertResult = { data: [], error: null },
  deleteResult = { error: null },
  selectListResult = { data: [], error: null },
  selectSingleResult = { data: null, error: null },
} = {}) {
  const trackers = { tables: [], inserts: [], deletes: [] }
  const db = {}
  db.from = vi.fn((t) => {
    trackers.tables.push(t)
    const chain = {}
    chain.insert = vi.fn((rows) => {
      trackers.inserts.push({ table: t, rows })
      // returns { select: () => { single() / await } }
      const result = t === 'issues' ? issueInsertResult : attachInsertResult
      const sel = {
        select: vi.fn(() => ({
          single: vi.fn(() => Promise.resolve(result)),
          // for attachments .select() then await
          then: (resolve) => resolve(result),
        })),
        then: (resolve) => resolve(result),
      }
      return sel
    })
    chain.delete = vi.fn(() => {
      trackers.deletes.push(t)
      return { eq: vi.fn(() => Promise.resolve(deleteResult)) }
    })
    chain.select = vi.fn(() => chain)
    chain.eq = vi.fn(() => chain)
    chain.order = vi.fn(() => chain)
    chain.limit = vi.fn(() => Promise.resolve(selectListResult))
    chain.maybeSingle = vi.fn(() => Promise.resolve(selectSingleResult))
    return chain
  })
  return { db, trackers }
}

describe('insertIssueWithAttachments', () => {
  it('inserts the issue + attachments with positional indexes', async () => {
    const { db, trackers } = makeDb({
      issueInsertResult: { data: { id: 'iss-9', location_id: 'loc-1', submitter_id: 'p-1', description: 'd', status: 'open', created_at: 't' }, error: null },
      attachInsertResult: { data: [{ id: 'a1', position: 0 }, { id: 'a2', position: 1 }], error: null },
    })
    const out = await insertIssueWithAttachments(db, {
      locationId: 'loc-1', submitterId: 'p-1', description: 'd',
      attachments: [
        { storage_path: 'p1', size_bytes: 100, mime_type: 'image/jpeg' },
        { storage_path: 'p2', size_bytes: 200, mime_type: 'image/png' },
      ],
    })
    expect(out.ok).toBe(true)
    expect(out.issue.id).toBe('iss-9')

    // 1st insert is the issue, 2nd is the attachments batch.
    expect(trackers.inserts[0].table).toBe('issues')
    expect(trackers.inserts[0].rows.status).toBe(ISSUE_STATUS.OPEN)
    expect(trackers.inserts[1].table).toBe('issue_attachments')
    expect(trackers.inserts[1].rows).toHaveLength(2)
    expect(trackers.inserts[1].rows[0].position).toBe(0)
    expect(trackers.inserts[1].rows[1].position).toBe(1)
    expect(trackers.inserts[1].rows[0].uploaded_by).toBe('p-1')
  })

  it('rolls back the issue when attachment insert fails', async () => {
    const { db, trackers } = makeDb({
      issueInsertResult: { data: { id: 'iss-9', location_id: 'loc-1', submitter_id: 'p-1', description: 'd', status: 'open', created_at: 't' }, error: null },
      attachInsertResult: { data: null, error: { message: 'storage gremlin' } },
    })
    const out = await insertIssueWithAttachments(db, {
      locationId: 'loc-1', submitterId: 'p-1', description: 'd',
      attachments: [{ storage_path: 'p1', size_bytes: 1, mime_type: 'image/jpeg' }],
    })
    expect(out.ok).toBe(false)
    expect(out.code).toBe('attachment_insert_failed')
    // Issue should have been deleted to avoid an orphan row.
    expect(trackers.deletes).toContain('issues')
  })

  it('skips the attachments branch entirely when none are passed', async () => {
    const { db, trackers } = makeDb()
    const out = await insertIssueWithAttachments(db, {
      locationId: 'loc-1', submitterId: 'p-1', description: 'just text',
      attachments: [],
    })
    expect(out.ok).toBe(true)
    expect(trackers.tables).toEqual(['issues'])
  })

  it('surfaces a clean error when the issue insert itself fails', async () => {
    const { db } = makeDb({
      issueInsertResult: { data: null, error: { message: 'FK violation' } },
    })
    const out = await insertIssueWithAttachments(db, {
      locationId: 'loc-1', submitterId: 'p-1', description: 'd', attachments: [],
    })
    expect(out.ok).toBe(false)
    expect(out.code).toBe('issue_insert_failed')
    expect(out.error).toBe('FK violation')
  })

  it('sets equipment_id when the issue came from a failed inspection', async () => {
    const { db, trackers } = makeDb()
    await insertIssueWithAttachments(db, {
      locationId: 'loc-1', submitterId: 'prof-1', description: 'Treadmill 3 failed inspection',
      equipmentId: 'eq-1',
    })
    expect(trackers.inserts[0].rows).toEqual(expect.objectContaining({ equipment_id: 'eq-1' }))
  })

  it('omits equipment_id entirely for an ordinary staff-reported issue', async () => {
    const { db, trackers } = makeDb()
    await insertIssueWithAttachments(db, {
      locationId: 'loc-1', submitterId: 'prof-1', description: 'Bathroom light out',
    })
    expect(trackers.inserts[0].rows).not.toHaveProperty('equipment_id')
  })
})

// ----------------------------------------------------------------
// listMyIssues / getMyIssue — happy paths through the mock
// ----------------------------------------------------------------

describe('listMyIssues', () => {
  it('returns [] when no submitterId is passed', async () => {
    const { db } = makeDb()
    expect(await listMyIssues(db, null)).toEqual([])
  })

  it('returns rows from the chainable', async () => {
    const rows = [{ id: 'a', status: 'open' }]
    const { db } = makeDb({ selectListResult: { data: rows, error: null } })
    expect(await listMyIssues(db, 'p-1')).toEqual(rows)
  })

  it('returns [] on a query error rather than throwing', async () => {
    const { db } = makeDb({ selectListResult: { data: null, error: { message: 'boom' } } })
    expect(await listMyIssues(db, 'p-1')).toEqual([])
  })
})

describe('getMyIssue', () => {
  it('returns null when ids are missing', async () => {
    const { db } = makeDb()
    expect(await getMyIssue(db, { issueId: null, profileId: 'p' })).toBeNull()
    expect(await getMyIssue(db, { issueId: 'a', profileId: null })).toBeNull()
  })

  it('returns the row when present', async () => {
    const row = { id: 'iss', submitter_id: 'p-1' }
    const { db } = makeDb({ selectSingleResult: { data: row, error: null } })
    expect(await getMyIssue(db, { issueId: 'iss', profileId: 'p-1' })).toEqual(row)
  })

  it('returns null when no row matches', async () => {
    const { db } = makeDb({ selectSingleResult: { data: null, error: null } })
    expect(await getMyIssue(db, { issueId: 'iss', profileId: 'p-1' })).toBeNull()
  })
})

// ----------------------------------------------------------------
// REPORT-ISSUE.2 — handler-side helpers
// ----------------------------------------------------------------

// Slightly richer chainable for the handler suite: separate
// single-result vs single-error paths for the .update().eq().eq().select().single()
// chain that claim/resolve/close use.
function makeHandlerDb({
  selectListResult = { data: [], error: null },
  selectSingleResult = { data: null, error: null },
  countResult = { count: 0, error: null },
  updateSingleResult = { data: null, error: null },
} = {}) {
  const trackers = { updates: [], inSets: [], eqs: [] }
  const db = {}
  db.from = vi.fn(() => {
    const chain = {}
    chain.select = vi.fn(() => chain)
    chain.eq = vi.fn((col, val) => { trackers.eqs.push([col, val]); return chain })
    chain.in = vi.fn((col, vals) => { trackers.inSets.push([col, vals]); return chain })
    chain.order = vi.fn(() => chain)
    chain.limit = vi.fn(() => Promise.resolve(selectListResult))
    chain.maybeSingle = vi.fn(() => Promise.resolve(selectSingleResult))
    // Count chain — head: true short-circuits via .select() returning a
    // thenable that resolves to { count }.
    chain.update = vi.fn((row) => {
      trackers.updates.push(row)
      const upd = {
        eq: vi.fn((col, val) => {
          trackers.eqs.push([col, val])
          return {
            eq: vi.fn((c2, v2) => {
              trackers.eqs.push([c2, v2])
              return {
                select: vi.fn(() => ({
                  single: vi.fn(() => Promise.resolve(updateSingleResult)),
                })),
              }
            }),
            in: vi.fn((c2, v2) => {
              trackers.inSets.push([c2, v2])
              return {
                select: vi.fn(() => ({
                  single: vi.fn(() => Promise.resolve(updateSingleResult)),
                })),
              }
            }),
            select: vi.fn(() => ({
              single: vi.fn(() => Promise.resolve(updateSingleResult)),
            })),
          }
        }),
      }
      return upd
    })
    // .select('id', { count, head }).eq().in() terminal resolves to count.
    chain.headCountThen = (resolve) => resolve(countResult)
    return chain
  })
  return { db, trackers }
}

describe('ISSUE_INBOX_OPEN_STATUSES', () => {
  it("includes 'open' + 'in_progress' but not the terminal ones", () => {
    expect(ISSUE_INBOX_OPEN_STATUSES).toEqual(['open', 'in_progress'])
  })
})

describe('listInboxIssues', () => {
  it('returns [] when no locationId is given', async () => {
    const { db } = makeHandlerDb()
    expect(await listInboxIssues(db, null)).toEqual([])
  })

  it('returns rows from the chainable', async () => {
    const rows = [{ id: 'i1' }, { id: 'i2' }]
    const { db } = makeHandlerDb({ selectListResult: { data: rows, error: null } })
    expect(await listInboxIssues(db, 'loc-1')).toEqual(rows)
  })

  it('defaults to the open-work status set', async () => {
    const { db, trackers } = makeHandlerDb()
    await listInboxIssues(db, 'loc-1')
    expect(trackers.inSets).toContainEqual(['status', ISSUE_INBOX_OPEN_STATUSES])
  })

  it('respects a caller-supplied statuses array', async () => {
    const { db, trackers } = makeHandlerDb()
    await listInboxIssues(db, 'loc-1', { statuses: ['resolved'] })
    expect(trackers.inSets).toContainEqual(['status', ['resolved']])
  })
})

describe('countInboxIssues', () => {
  it('returns 0 when no locationId', async () => {
    const { db } = makeHandlerDb()
    expect(await countInboxIssues(db, null)).toBe(0)
  })
})

describe('getInboxIssue', () => {
  it('returns null on missing id', async () => {
    const { db } = makeHandlerDb()
    expect(await getInboxIssue(db, null)).toBeNull()
  })
  it('returns the row when present', async () => {
    const row = { id: 'iss' }
    const { db } = makeHandlerDb({ selectSingleResult: { data: row, error: null } })
    expect(await getInboxIssue(db, 'iss')).toEqual(row)
  })
})

describe('claimIssue', () => {
  it('rejects when ids are missing', async () => {
    const { db } = makeHandlerDb()
    expect((await claimIssue(db, { issueId: '', profileId: 'p' })).code).toBe('bad_args')
  })

  it('flips status to in_progress + stamps claimed_by/at when row was open', async () => {
    const { db, trackers } = makeHandlerDb({
      updateSingleResult: { data: { id: 'i1', status: 'in_progress', claimed_by: 'p-1', claimed_at: 't' }, error: null },
    })
    const out = await claimIssue(db, { issueId: 'i1', profileId: 'p-1' })
    expect(out.ok).toBe(true)
    expect(trackers.updates[0].status).toBe(ISSUE_STATUS.IN_PROGRESS)
    expect(trackers.updates[0].claimed_by).toBe('p-1')
    // Concurrency-safe predicate.
    expect(trackers.eqs).toContainEqual(['status', ISSUE_STATUS.OPEN])
  })

  it("returns 409 not_open when the row wasn't pending (PGRST116 = 0 rows)", async () => {
    const { db } = makeHandlerDb({
      updateSingleResult: { data: null, error: { code: 'PGRST116', message: 'no rows' } },
    })
    const out = await claimIssue(db, { issueId: 'i1', profileId: 'p-1' })
    expect(out.ok).toBe(false)
    expect(out.status).toBe(409)
    expect(out.code).toBe('not_open')
  })
})

describe('resolveIssue', () => {
  it('rejects empty notes', async () => {
    const { db } = makeHandlerDb()
    const out = await resolveIssue(db, { issueId: 'i', profileId: 'p', notes: '   ' })
    expect(out.code).toBe('notes_required')
  })

  it('rejects notes over 2000 chars', async () => {
    const { db } = makeHandlerDb()
    const out = await resolveIssue(db, { issueId: 'i', profileId: 'p', notes: 'x'.repeat(2001) })
    expect(out.code).toBe('notes_too_long')
  })

  it('writes resolution_notes + resolved_by/at + status=resolved', async () => {
    const { db, trackers } = makeHandlerDb({
      updateSingleResult: { data: { id: 'i', status: 'resolved' }, error: null },
    })
    await resolveIssue(db, { issueId: 'i', profileId: 'p', notes: 'fixed the door handle' })
    expect(trackers.updates[0].status).toBe(ISSUE_STATUS.RESOLVED)
    expect(trackers.updates[0].resolved_by).toBe('p')
    expect(trackers.updates[0].resolution_notes).toBe('fixed the door handle')
  })

  it("returns 409 already_terminal when row isn't open/in_progress", async () => {
    const { db } = makeHandlerDb({
      updateSingleResult: { data: null, error: { code: 'PGRST116', message: 'no rows' } },
    })
    const out = await resolveIssue(db, { issueId: 'i', profileId: 'p', notes: 'note' })
    expect(out.status).toBe(409)
    expect(out.code).toBe('already_terminal')
  })

  it('allows resolution from open WITHOUT a prior claim', async () => {
    // We just verify the IN-clause includes both open and in_progress
    // so the route layer doesn't force a Claim step.
    const { db, trackers } = makeHandlerDb({
      updateSingleResult: { data: { id: 'i', status: 'resolved' }, error: null },
    })
    await resolveIssue(db, { issueId: 'i', profileId: 'p', notes: 'done' })
    expect(trackers.inSets).toContainEqual(['status', ['open', 'in_progress']])
  })
})

describe('closeIssue', () => {
  it('rejects on missing id', async () => {
    const { db } = makeHandlerDb()
    expect((await closeIssue(db, { issueId: '' })).code).toBe('bad_args')
  })

  it('only flips a resolved row → closed', async () => {
    const { db, trackers } = makeHandlerDb({
      updateSingleResult: { data: { id: 'i', status: 'closed' }, error: null },
    })
    await closeIssue(db, { issueId: 'i' })
    expect(trackers.updates[0].status).toBe(ISSUE_STATUS.CLOSED)
    expect(trackers.eqs).toContainEqual(['status', ISSUE_STATUS.RESOLVED])
  })

  it("returns 409 not_resolved when row wasn't in resolved state", async () => {
    const { db } = makeHandlerDb({
      updateSingleResult: { data: null, error: { code: 'PGRST116', message: 'no rows' } },
    })
    const out = await closeIssue(db, { issueId: 'i' })
    expect(out.status).toBe(409)
    expect(out.code).toBe('not_resolved')
  })
})
