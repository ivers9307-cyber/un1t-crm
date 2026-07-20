import { describe, it, expect } from 'vitest'
import { parseMembershipPause, applyMembershipPauseWindow } from './glofox-membership.js'

// Real shapes captured from the live Glofox webhook (capital Payload).
const PAUSED = {
  Type: 'MEMBERSHIP_UPDATED',
  Payload: {
    id: 'm1', user_id: 'u1', status: 'PAUSED',
    cycle: { start_date: '2026-08-02T23:00:00Z', end_date: '2026-09-03T21:08:37Z', next_payment_date: '2026-09-03T21:08:37Z' },
    membership_definition: { type: 'TIME' },
    modified: '2026-07-20T21:11:04.324Z', created: '2026-07-20T20:39:34Z',
  },
  Metadata: { location_id: 'loc', trace_id: 't1' },
}
const ACTIVE = {
  Type: 'MEMBERSHIP_UPDATED',
  Payload: { id: 'm2', status: 'ACTIVE', cycle: { start_date: '', next_payment_date: '' }, modified: '2026-07-20T21:08:12Z' },
  Metadata: {},
}

describe('parseMembershipPause', () => {
  it('returns null for non-object input', () => {
    expect(parseMembershipPause(null)).toBeNull()
    expect(parseMembershipPause('x')).toBeNull()
  })

  it('extracts the resume date from a PAUSED membership (cycle.start_date)', () => {
    const out = parseMembershipPause(PAUSED)
    expect(out).toMatchObject({
      status: 'PAUSED',
      paused: true,
      resume_at: '2026-08-02T23:00:00.000Z',
      paused_at: '2026-07-20T21:11:04.324Z',
    })
  })

  it('reports not-paused with null window for an ACTIVE membership', () => {
    const out = parseMembershipPause(ACTIVE)
    expect(out.paused).toBe(false)
    expect(out.resume_at).toBeNull()
    expect(out.paused_at).toBeNull()
  })

  it('falls back to next_payment_date when cycle.start_date is empty', () => {
    const ev = { Payload: { status: 'PAUSED', cycle: { start_date: '', next_payment_date: '2026-09-01T00:00:00Z' }, modified: '2026-07-20T10:00:00Z' } }
    expect(parseMembershipPause(ev).resume_at).toBe('2026-09-01T00:00:00.000Z')
  })

  it('handles a lowercase payload envelope', () => {
    const ev = { payload: { status: 'PAUSED', cycle: { start_date: '2026-08-02T23:00:00Z' }, modified: '2026-07-20T10:00:00Z' } }
    expect(parseMembershipPause(ev).resume_at).toBe('2026-08-02T23:00:00.000Z')
  })

  it('uppercases status (defends against lowercase)', () => {
    const ev = { Payload: { status: 'paused', cycle: { start_date: '2026-08-02T23:00:00Z' } } }
    expect(parseMembershipPause(ev).paused).toBe(true)
  })
})

function fakeDb({ currentState = null, updateOk = true } = {}) {
  const updates = []
  return {
    updates,
    from(t) {
      if (t === 'contacts') {
        return {
          update(v) {
            updates.push(v)
            return { eq: () => Promise.resolve({ error: updateOk ? null : { message: 'fail' } }) }
          },
          select: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: { glofox_membership_state: currentState }, error: null }) }),
          }),
        }
      }
      return {}
    },
  }
}

describe('applyMembershipPauseWindow', () => {
  it('sets the window from a PAUSED event', async () => {
    const db = fakeDb()
    const out = await applyMembershipPauseWindow(db, 'c1', PAUSED)
    expect(out).toMatchObject({ ok: true, paused: true, resume_at: '2026-08-02T23:00:00.000Z' })
    expect(db.updates[0]).toEqual({
      glofox_membership_paused_at: '2026-07-20T21:11:04.324Z',
      glofox_membership_resume_at: '2026-08-02T23:00:00.000Z',
    })
  })

  it('clears the window on a non-paused event when the member is not paused overall', async () => {
    const db = fakeDb({ currentState: 'active' })
    const out = await applyMembershipPauseWindow(db, 'c1', ACTIVE)
    expect(out).toMatchObject({ ok: true, paused: false, cleared: true })
    expect(db.updates[0]).toEqual({ glofox_membership_paused_at: null, glofox_membership_resume_at: null })
  })

  it('does NOT clear the window on a non-paused event when the member is still paused overall (multi-membership guard)', async () => {
    const db = fakeDb({ currentState: 'paused' })
    const out = await applyMembershipPauseWindow(db, 'c1', ACTIVE)
    expect(out).toMatchObject({ ok: true, paused: false, cleared: false })
    expect(db.updates).toHaveLength(0) // no write — another membership's pause is preserved
  })

  it('returns not-ok on update failure (best-effort)', async () => {
    const db = fakeDb({ updateOk: false })
    const out = await applyMembershipPauseWindow(db, 'c1', PAUSED)
    expect(out.ok).toBe(false)
  })

  it('no-ops without a contact id', async () => {
    expect(await applyMembershipPauseWindow(fakeDb(), null, PAUSED)).toMatchObject({ ok: false })
  })
})
