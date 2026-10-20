// ORGCONTACTS.2 — loadContactStudios: the contact page's Studios card data,
// through studiosOfContact (every row, any status), never throwing.
import { describe, it, expect, vi } from 'vitest'

vi.mock('./contact-studios.js', () => ({ studiosOfContact: vi.fn() }))
import { studiosOfContact } from './contact-studios.js'
import { loadContactStudios } from './contact-studios-display.js'

describe('loadContactStudios', () => {
  it('returns every relationship row with its location, primary studio first', async () => {
    studiosOfContact.mockResolvedValue({ ok: true, rows: [
      { location_id: 'hatch', status: 'ended', location: { name: 'Hatch' } },
      { location_id: 'still', status: 'active', location: { name: 'Stillorgan' } },
    ] })
    const r = await loadContactStudios({}, 'c-1', { primaryLocationId: 'still' })
    expect(studiosOfContact).toHaveBeenCalledWith({}, 'c-1')
    expect(r.rows.map((x) => x.location_id)).toEqual(['still', 'hatch'])
    expect(r.error).toBeNull()
  })
  it('a failed read is { rows: [], error }, never a throw; no contact reads nothing', async () => {
    studiosOfContact.mockResolvedValue({ ok: false, error: 'boom' })
    expect(await loadContactStudios({}, 'c-1', {})).toEqual({ rows: [], error: 'boom' })
    studiosOfContact.mockClear()
    expect(await loadContactStudios({}, null, {})).toEqual({ rows: [], error: null })
    expect(studiosOfContact).not.toHaveBeenCalled()
  })
})
