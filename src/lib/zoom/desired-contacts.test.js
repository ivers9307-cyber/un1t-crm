import { describe, it, expect } from 'vitest'
import { buildDesiredContacts, pickWinner } from './desired-contacts'

/**
 * Minimal stub of the supabase-js builder chain used by buildDesiredContacts.
 * Serves `rows` in 1000-row pages so the .range() paging path is exercised.
 */
function stubDb(rows) {
  return {
    from: () => ({
      select: () => ({
        order: () => ({
          range: (from, to) => Promise.resolve({ data: rows.slice(from, to + 1), error: null }),
        }),
      }),
    }),
  }
}

const row = (over = {}) => ({
  id: 'c1', first_name: 'Aoife', last_name: 'Ryan', phone: '+353871111111',
  lead_source: 'walk-in', created_at: '2025-01-01T00:00:00Z', ...over,
})

describe('pickWinner', () => {
  it('prefers the earliest created_at', () => {
    const a = row({ id: 'a', created_at: '2025-06-01T00:00:00Z', first_name: 'New' })
    const b = row({ id: 'b', created_at: '2024-01-01T00:00:00Z', first_name: 'Old' })
    expect(pickWinner(a, b).first_name).toBe('Old')
    expect(pickWinner(b, a).first_name).toBe('Old')
  })

  it('breaks a created_at tie on id, deterministically either way round', () => {
    const a = row({ id: 'aaa', created_at: '2025-01-01T00:00:00Z' })
    const b = row({ id: 'bbb', created_at: '2025-01-01T00:00:00Z' })
    expect(pickWinner(a, b).id).toBe('aaa')
    expect(pickWinner(b, a).id).toBe('aaa')
  })

  // Date.parse('1970-01-01T00:00:00Z') === 0, and 0 is falsy in JS. A naive
  // `Date.parse(x) || FALLBACK` guard would treat a genuinely-valid,
  // legitimately-oldest-possible timestamp the same as an unparseable one —
  // exactly backwards under "oldest wins". `contacts.created_at` is a
  // nullable timestamptz; a bad backfill or import could plausibly leave a
  // row sitting at the epoch, and that row must still win as oldest.
  it('treats the Unix epoch as a real date, not a parse failure', () => {
    const epoch = row({ id: 'epoch', created_at: '1970-01-01T00:00:00Z', first_name: 'Epoch' })
    const recent = row({ id: 'recent', created_at: '2025-06-01T00:00:00Z', first_name: 'Recent' })
    expect(pickWinner(epoch, recent).id).toBe('epoch')
    expect(pickWinner(recent, epoch).id).toBe('epoch')
  })

  // The counterpart case: a genuinely unparseable/missing created_at must
  // NOT win "oldest" against a real date — there is no evidence it is old,
  // so it falls to the back rather than defaulting to the front.
  it('does not let an unparseable or missing created_at win as oldest', () => {
    const bad = row({ id: 'bad', created_at: 'not-a-date' })
    const missing = row({ id: 'missing', created_at: null })
    const real = row({ id: 'real', created_at: '2025-06-01T00:00:00Z' })
    expect(pickWinner(bad, real).id).toBe('real')
    expect(pickWinner(real, bad).id).toBe('real')
    expect(pickWinner(missing, real).id).toBe('real')
    expect(pickWinner(real, missing).id).toBe('real')
  })
})

describe('buildDesiredContacts', () => {
  it('excludes ClassPass rows', async () => {
    const res = await buildDesiredContacts(stubDb([
      row({ id: 'a', phone: '+353871111111' }),
      row({ id: 'b', phone: '+353872222222', lead_source: 'classpass' }),
      row({ id: 'c', phone: '+353873333333', lead_source: 'ClassPass' }),
    ]))
    expect(res.ok).toBe(true)
    expect([...res.desired.keys()]).toEqual(['+353871111111'])
    expect(res.stats.excludedClassPass).toBe(2)
  })

  it('collapses a shared number to the oldest profile name', async () => {
    const res = await buildDesiredContacts(stubDb([
      row({ id: 'new', first_name: 'Sarah', last_name: 'Doyle', phone: '0871234567', created_at: '2026-01-01T00:00:00Z' }),
      row({ id: 'old', first_name: 'Sarah', last_name: 'Kelly',  phone: '+353871234567', created_at: '2023-01-01T00:00:00Z' }),
    ]))
    expect(res.desired.size).toBe(1)
    expect(res.desired.get('+353871234567')).toEqual({ name: 'Sarah Kelly', contactId: 'old' })
    expect(res.stats.collapsed).toBe(1)
  })

  it('drops unnormalisable numbers and counts them', async () => {
    const res = await buildDesiredContacts(stubDb([
      row({ id: 'a', phone: '+353871111111' }),
      row({ id: 'b', phone: '12345' }),
    ]))
    expect(res.desired.size).toBe(1)
    expect(res.stats.rejected).toBe(1)
  })

  it('skips a row with no usable name rather than pushing a blank', async () => {
    const res = await buildDesiredContacts(stubDb([
      row({ id: 'a', first_name: '  ', last_name: null, phone: '+353871111111' }),
    ]))
    expect(res.desired.size).toBe(0)
    expect(res.stats.noName).toBe(1)
  })

  it('trims a single-name contact cleanly', async () => {
    const res = await buildDesiredContacts(stubDb([
      row({ id: 'a', first_name: 'Cher', last_name: null, phone: '+353871111111' }),
    ]))
    expect(res.desired.get('+353871111111').name).toBe('Cher')
  })

  it('pages past the 1000-row select cap', async () => {
    const many = Array.from({ length: 2300 }, (_, i) =>
      row({ id: `c${i}`, phone: `+35387${String(i).padStart(7, '0')}` }))
    const res = await buildDesiredContacts(stubDb(many))
    expect(res.desired.size).toBe(2300)
  })

  // The exact-multiple-of-PAGE_SIZE boundary: a naive off-by-one in the
  // paging loop (e.g. breaking on page.length <= PAGE_SIZE, or never issuing
  // the trailing empty-page request) either drops the last page or spins.
  // 2000 = 2 * PAGE_SIZE exactly.
  it('terminates cleanly when the row count is an exact multiple of the page size', async () => {
    const exact = Array.from({ length: 2000 }, (_, i) =>
      row({ id: `c${i}`, phone: `+35387${String(i).padStart(7, '0')}` }))
    const res = await buildDesiredContacts(stubDb(exact))
    expect(res.desired.size).toBe(2000)
    expect(res.stats.scanned).toBe(2000)
  })
})
