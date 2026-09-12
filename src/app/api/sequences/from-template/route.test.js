// PAYLINK.8 — POST /api/sequences/from-template, template
// 'overdue_payment_dunning'.
//
// Coverage:
//   (a) the target location has no APPROVED outstanding_payment_link_ row
//       → 409 naming that template, and NOTHING written (no email_sequences
//       insert at all — the refusal happens before the first write).
//   (b) it IS approved → the sequence + its steps are inserted, and both
//       WhatsApp step rows carry that row's id plus the full
//       whatsapp_variables mapping (including url_button).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccess: vi.fn(() => null),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const LOC = 'a0000000-0000-0000-0000-000000000001'
const USER = { id: 'user-1', activeLocation: { id: LOC } }

function req(body) {
  return new Request('http://localhost/api/sequences/from-template', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

function mockDb({ waRows, seq = { id: 'seq-new', name: 'Overdue membership payment → card update reminders' } }) {
  const inserts = { email_sequences: [], sequence_steps: [] }
  const db = {
    inserts,
    from(table) {
      if (table === 'whatsapp_templates') {
        return { select: () => ({ eq: () => Promise.resolve({ data: waRows, error: null }) }) }
      }
      if (table === 'email_sequences') {
        return {
          insert: (row) => {
            inserts.email_sequences.push(row)
            return { select: () => ({ single: () => Promise.resolve({ data: seq, error: null }) }) }
          },
          delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
        }
      }
      if (table === 'sequence_steps') {
        return {
          insert: (rows) => {
            inserts.sequence_steps.push(...rows)
            return Promise.resolve({ error: null })
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  return db
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(USER)
})

describe('POST /api/sequences/from-template — overdue_payment_dunning refuses without the approved pay-link template', () => {
  it('(a) 409 naming outstanding_payment_link_, and no email_sequences row is ever inserted', async () => {
    const db = mockDb({
      waRows: [{ id: 'w-1', name: 'outstanding_payment_link_', status: 'PENDING' }],
    })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({ template_id: 'overdue_payment_dunning', location_id: LOC }))
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.success).toBe(false)
    expect(json.error).toContain('outstanding_payment_link_')
    expect(db.inserts.email_sequences).toHaveLength(0)
    expect(db.inserts.sequence_steps).toHaveLength(0)
  })

  it('(b) approved: inserts the sequence + steps, both WhatsApp rows carry the resolved id and full whatsapp_variables', async () => {
    const db = mockDb({
      waRows: [{ id: 'w-9', name: 'outstanding_payment_link_', status: 'APPROVED' }],
    })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({ template_id: 'overdue_payment_dunning', location_id: LOC }))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(db.inserts.email_sequences).toHaveLength(1)

    const waStepRows = db.inserts.sequence_steps.filter((s) => s.step_type === 'whatsapp')
    expect(waStepRows).toHaveLength(2)
    for (const row of waStepRows) {
      expect(row.whatsapp_template_id).toBe('w-9')
      expect(row.whatsapp_variables).toEqual({ '1': 'first_name', '2': 'pay_amount', url_button: 'pay_link_suffix' })
    }
  })
})
