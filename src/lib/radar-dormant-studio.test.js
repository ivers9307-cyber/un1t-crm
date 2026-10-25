// ORGCONTACTS.4 (decision 3) — the radars' dormant mark on the person's
// contact_studios row AT the radar's studio. Fictional ids only.
import { describe, it, expect, vi } from 'vitest'

vi.mock('./log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('./contact-studios', () => ({ contactsAtStudio: vi.fn(), upsertContactStudio: vi.fn() }))

import { contactsAtStudio, upsertContactStudio } from './contact-studios'
import { markDormantAtStudio } from './radar-dormant-studio.js'

const L = 'a0000000-0000-4000-8000-000000000001'
const row = (over) => ({ contact_id: 'c', location_id: L, kind: 'lead', status: 'active', source: 'deal', ended_at: null, ...over })

describe('markDormantAtStudio', () => {
  it('marks every ACTIVE row dormant with its kind, source and status kept', async () => {
    contactsAtStudio.mockResolvedValue({ ok: true, rows: [row({ contact_id: 'c1' }), row({ contact_id: 'c2', kind: 'client', source: 'glofox' })] })
    upsertContactStudio.mockResolvedValue({ ok: true, row: {} })
    expect(await markDormantAtStudio({}, { locationId: L, contactIds: ['c1', 'c2', 'c3'] })).toEqual({ marked: 2, skipped: 1, failed: 0 })
    expect(upsertContactStudio).toHaveBeenCalledWith({}, { contactId: 'c2', locationId: L, kind: 'client', status: 'active', source: 'glofox', stageSlug: 'dormant' })
  })

  // M5 (final review): re-upserting an ENDED row with status 'ended' stamps
  // ended_at = now again, moving the end date the row already carried. An
  // ended relationship has no stage to mark: it is skipped, never rewritten.
  it('an ended row is skipped, not rewritten (its ended_at stays what it was)', async () => {
    vi.clearAllMocks()
    contactsAtStudio.mockResolvedValue({ ok: true, rows: [row({ contact_id: 'c1', status: 'ended', ended_at: '2026-01-01T00:00:00Z' }), row({ contact_id: 'c2' })] })
    upsertContactStudio.mockResolvedValue({ ok: true, row: {} })
    expect(await markDormantAtStudio({}, { locationId: L, contactIds: ['c1', 'c2'] })).toEqual({ marked: 1, skipped: 1, failed: 0 })
    expect(upsertContactStudio).toHaveBeenCalledTimes(1)
    expect(upsertContactStudio.mock.calls[0][1].contactId).toBe('c2')
  })

  it('an unreadable studio read marks nothing and skips every id; a failed write is counted', async () => {
    vi.clearAllMocks()
    contactsAtStudio.mockResolvedValue({ ok: false, error: 'boom' })
    expect(await markDormantAtStudio({}, { locationId: L, contactIds: ['c1'] })).toEqual({ marked: 0, skipped: 1, failed: 0 })
    contactsAtStudio.mockResolvedValue({ ok: true, rows: [row({ contact_id: 'c1' })] })
    upsertContactStudio.mockResolvedValue({ ok: false, error: 'boom' })
    expect(await markDormantAtStudio({}, { locationId: L, contactIds: ['c1'] })).toEqual({ marked: 0, skipped: 0, failed: 1 })
  })
})
