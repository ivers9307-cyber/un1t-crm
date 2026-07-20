import { describe, it, expect } from 'vitest'
import {
  parseServicePayload,
  applyPauseToContact,
  applyServiceWebhook,
} from './glofox-services.js'

// Sample SERVICE_UPDATED payload. NOTE lowercase metadata/payload —
// ServiceEvent capitalises differently from Invoice/Membership events.
const PAUSED_EVENT = {
  type: 'SERVICE_UPDATED',
  metadata: { trace_id: 'svc-t-1', location_id: 'loc_glofox_1', version: '1' },
  timestamp: '2026-07-20T10:00:00Z',
  payload: {
    id: 'svc_001',
    membership_id: 'mem_001',
    member_ids: ['usr_glofox_001'],
    status: 'active',
    next_payment_date: '2026-09-01T00:00:00Z',
    pause: {
      start_date: '2026-07-15T00:00:00Z',
      duration_unit: 'week',
      duration_amount: 4,
      resume_date: '2026-08-15T00:00:00Z',
    },
    created: '2026-01-01T00:00:00Z',
    modified: '2026-07-20T10:00:00Z',
  },
}

const RESUMED_EVENT = {
  ...PAUSED_EVENT,
  payload: { ...PAUSED_EVENT.payload, pause: null },
}

describe('parseServicePayload', () => {
  it('returns null for null / non-object input', () => {
    expect(parseServicePayload(null)).toBeNull()
    expect(parseServicePayload('str')).toBeNull()
  })

  it('returns null when service id is missing', () => {
    expect(parseServicePayload({ payload: { member_ids: ['x'] } })).toBeNull()
  })

  it('extracts the pause window from a paused service', () => {
    const out = parseServicePayload(PAUSED_EVENT)
    expect(out).toMatchObject({
      id: 'svc_001',
      glofox_user_id: 'usr_glofox_001',
      membership_id: 'mem_001',
      status: 'active',
      paused: true,
      pause_start_at: '2026-07-15T00:00:00.000Z',
      pause_resume_at: '2026-08-15T00:00:00.000Z',
      pause_duration_unit: 'WEEK', // uppercased
      pause_duration_amount: 4,
      next_payment_at: '2026-09-01T00:00:00.000Z',
    })
  })

  it('reports not-paused with null pause fields when pause is nil', () => {
    const out = parseServicePayload(RESUMED_EVENT)
    expect(out.paused).toBe(false)
    expect(out.pause_start_at).toBeNull()
    expect(out.pause_resume_at).toBeNull()
    expect(out.pause_duration_unit).toBeNull()
    expect(out.pause_duration_amount).toBeNull()
  })

  it('accepts the inner payload directly (caller pre-unwrapped)', () => {
    expect(parseServicePayload(PAUSED_EVENT.payload).id).toBe('svc_001')
  })

  it('tolerates a capitalised Payload (defensive)', () => {
    const capital = { Payload: { id: 'svc_002', member_ids: [42], pause: null } }
    const out = parseServicePayload(capital)
    expect(out.id).toBe('svc_002')
    expect(out.glofox_user_id).toBe('42') // coerced to string
  })

  it('takes the first member id as the owning member', () => {
    const shared = { payload: { id: 's', member_ids: ['m1', 'm2'] } }
    expect(parseServicePayload(shared).glofox_user_id).toBe('m1')
  })
})

// applyPauseToContact + applyServiceWebhook use Supabase chains we mock.
function fakeDb({ currentState = null, updateOk = true, upsertOk = true } = {}) {
  const updates = []
  const upserts = []
  return {
    updates,
    upserts,
    from(table) {
      if (table === 'contacts') {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: { glofox_membership_state: currentState }, error: null }),
            }),
          }),
          update(values) {
            updates.push(values)
            return { eq: () => Promise.resolve({ error: updateOk ? null : { message: 'fail' } }) }
          },
        }
      }
      if (table === 'glofox_services') {
        return {
          upsert(row) {
            upserts.push(row)
            return {
              select: () => ({
                single: () => Promise.resolve({
                  data: upsertOk ? row : null,
                  error: upsertOk ? null : { message: 'fail' },
                }),
              }),
            }
          },
        }
      }
      return {}
    },
  }
}

describe('applyPauseToContact', () => {
  it('sets paused state + window on pause, reporting the flip', async () => {
    const db = fakeDb({ currentState: 'active' })
    const parsed = parseServicePayload(PAUSED_EVENT)
    const out = await applyPauseToContact(db, 'c1', parsed)
    expect(db.updates[0]).toMatchObject({
      glofox_membership_state: 'paused',
      glofox_membership_paused_at: '2026-07-15T00:00:00.000Z',
      glofox_membership_resume_at: '2026-08-15T00:00:00.000Z',
    })
    expect(out.stateChange).toEqual({ from: 'active', to: 'paused' })
  })

  it('no state change when already paused', async () => {
    const db = fakeDb({ currentState: 'paused' })
    const out = await applyPauseToContact(db, 'c1', parseServicePayload(PAUSED_EVENT))
    expect(out.stateChange).toBeNull()
  })

  it('clears the window and flips paused→active on resume', async () => {
    const db = fakeDb({ currentState: 'paused' })
    const out = await applyPauseToContact(db, 'c1', parseServicePayload(RESUMED_EVENT))
    expect(db.updates[0]).toMatchObject({
      glofox_membership_paused_at: null,
      glofox_membership_resume_at: null,
      glofox_membership_state: 'active',
    })
    expect(out.stateChange).toEqual({ from: 'paused', to: 'active' })
  })

  it('never stomps a non-paused lifecycle state on resume', async () => {
    const db = fakeDb({ currentState: 'cancelled' })
    const out = await applyPauseToContact(db, 'c1', parseServicePayload(RESUMED_EVENT))
    // clears the window but leaves state = cancelled
    expect(db.updates[0].glofox_membership_paused_at).toBeNull()
    expect(db.updates[0]).not.toHaveProperty('glofox_membership_state')
    expect(out.stateChange).toBeNull()
  })

  it('returns null stateChange on update failure (best-effort)', async () => {
    const db = fakeDb({ currentState: 'active', updateOk: false })
    const out = await applyPauseToContact(db, 'c1', parseServicePayload(PAUSED_EVENT))
    expect(out.stateChange).toBeNull()
    expect(out.error).toBe('fail')
  })
})

describe('applyServiceWebhook', () => {
  it('returns unparseable for a bad payload', async () => {
    expect(await applyServiceWebhook(fakeDb(), 'loc', 'c1', { payload: {} })).toEqual({
      ok: false, reason: 'unparseable_service',
    })
  })

  it('returns no_contact when contactId missing', async () => {
    const out = await applyServiceWebhook(fakeDb(), 'loc', null, PAUSED_EVENT)
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('no_contact')
  })

  it('happy path: upserts the service and applies the pause', async () => {
    const db = fakeDb({ currentState: 'active' })
    const out = await applyServiceWebhook(db, 'loc', 'c1', PAUSED_EVENT)
    expect(out).toMatchObject({
      ok: true,
      service_id: 'svc_001',
      paused: true,
      resume_at: '2026-08-15T00:00:00.000Z',
      state_change: { from: 'active', to: 'paused' },
    })
    expect(db.upserts[0]).toMatchObject({ id: 'svc_001', paused: true, contact_id: 'c1', location_id: 'loc' })
  })

  it('surfaces a service write failure', async () => {
    const db = fakeDb({ currentState: 'active', upsertOk: false })
    const out = await applyServiceWebhook(db, 'loc', 'c1', PAUSED_EVENT)
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('service_write_failed')
  })
})
