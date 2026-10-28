// UN1TDUN.1 — "Send payment reminder" at a un1t.online studio. The route
// never takes the debt from the client: maybeEnrolUn1tDunning (faked at its
// module boundary, tested in src/lib/un1t-dunning.test.js) re-derives it from
// the un1t.online mirror. Glofox is never read, a member whose contact lives
// at another studio is chased at this one (the debt is this studio's), and
// every outcome maps to the copy the Glofox branch already uses.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => USER) }))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn(() => true) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/radar-cache', () => ({ invalidateRadar: vi.fn(), radarCache: vi.fn() }))
vi.mock('@/lib/contact-crossovers', () => ({ isCrossoverAt: vi.fn(async () => false), crossoverIdsAt: vi.fn(async () => new Set()) }))
vi.mock('@/lib/membership/reads/index', () => ({ radarReadsFor: vi.fn(async () => ({ source: 'un1t_online', reads: {}, providesMemberships: false, pinArrears: true })) }))
vi.mock('@/lib/sequences', () => ({ enrolContacts: vi.fn() }))
vi.mock('@/lib/dunning-payment', () => ({ capturePaymentForRun: vi.fn(), refreshActiveRunPayment: vi.fn() }))
vi.mock('@/lib/un1t-dunning', () => ({ maybeEnrolUn1tDunning: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

import { isCrossoverAt } from '@/lib/contact-crossovers'
import { enrolContacts } from '@/lib/sequences'
import { capturePaymentForRun } from '@/lib/dunning-payment'
import { maybeEnrolUn1tDunning } from '@/lib/un1t-dunning'
import { invalidateRadar } from '@/lib/radar-cache'
import { POST } from './route.js'

const HATCH = 'loc-hatch'
const USER = { id: 'u1', activeLocation: { id: HATCH } }
let CONTACT
let db
let writes
let reads

function makeDb() {
  return {
    from(table) {
      reads.push(table)
      const c = {}
      for (const m of ['select', 'eq', 'in', 'order', 'limit']) c[m] = () => c
      c.maybeSingle = () => Promise.resolve({ data: table === 'contacts' ? CONTACT : null, error: null })
      c.insert = (row) => { writes.push({ table, row }); return Promise.resolve({ data: null, error: null }) }
      c.then = (res, rej) => Promise.resolve({ data: [], error: null }).then(res, rej)
      return c
    },
  }
}
const req = (body) => new Request('http://localhost/api/churn-radar/action', { method: 'POST', body: JSON.stringify(body) })
const remind = (extra = {}) => POST(req({ contact_id: 'c1', action: 'payment_reminder', ...extra }))

beforeEach(() => {
  vi.clearAllMocks()
  writes = []
  reads = []
  CONTACT = { id: 'c1', name: 'Hatch Member', first_name: 'Hatch', location_id: HATCH, wa_phone: '353000000000', phone: null }
  db = makeDb()
})

describe('payment_reminder at a un1t.online studio', () => {
  it('enrols through the un1t path (manual), logs the action, never reads Glofox data', async () => {
    maybeEnrolUn1tDunning.mockResolvedValue({ enrolled: 1, invoice_id: 'in_1', sequence_id: 'seq', sequence_name: 'Hatch reminders' })
    const res = await remind()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { action: 'payment_reminder' } })
    expect(maybeEnrolUn1tDunning).toHaveBeenCalledWith(db, HATCH, 'c1', { manual: true })
    expect(writes).toEqual([{ table: 'churn_radar_actions', row: expect.objectContaining({ contact_id: 'c1', location_id: HATCH, action: 'payment_reminder', note: 'Dunning (overdue) → Hatch reminders' }) }])
    expect(reads).not.toContain('glofox_invoices')
    expect(capturePaymentForRun).not.toHaveBeenCalled()
    expect(enrolContacts).not.toHaveBeenCalled()
    expect(invalidateRadar).toHaveBeenCalledWith('churn', HATCH)
  })

  it('ignores anything the client says about the debt', async () => {
    maybeEnrolUn1tDunning.mockResolvedValue({ enrolled: 1, sequence_name: 'S' })
    await remind({ note: 'invoice in_forged', template_name: 'x' })
    expect(maybeEnrolUn1tDunning).toHaveBeenCalledWith(db, HATCH, 'c1', { manual: true })
  })

  it('a member whose contact lives at another studio is chased here: the debt is this studio\'s un1t.online invoice', async () => {
    CONTACT.location_id = 'loc-still'
    isCrossoverAt.mockResolvedValueOnce(true)
    maybeEnrolUn1tDunning.mockResolvedValue({ enrolled: 1, sequence_name: 'S' })
    const res = await remind()
    expect(res.status).toBe(200)
    expect(maybeEnrolUn1tDunning).toHaveBeenCalledWith(db, HATCH, 'c1', { manual: true })
  })

  it('already being chased about this invoice: 200 already_enrolled, no new audit row', async () => {
    for (const reason of ['already_enrolled', 'active_run_other_invoice', 'not_reenrolled']) {
      writes = []
      maybeEnrolUn1tDunning.mockResolvedValue({ enrolled: 0, reason })
      const res = await remind()
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ success: true, data: { action: 'payment_reminder', already_enrolled: true } })
      expect(writes).toEqual([])
    }
  })

  it('each refusal maps to the Glofox branch\'s copy and writes nothing', async () => {
    const cases = [
      [{ reason: 'not_behind' }, 409, "This member isn't behind on payment, so no reminder was sent."],
      [{ reason: 'member_paused' }, 409, "This member isn't behind on payment, so no reminder was sent."],
      [{ reason: 'no_dunning_sequence' }, 400, 'No dunning sequence is set up yet — pick one in the churn-radar settings first.'],
      [{ reason: 'sequence_unavailable' }, 400, 'The configured dunning sequence is no longer available — re-pick it in settings.'],
      [{ reason: 'sequence_paused', sequence_name: 'Hatch reminders' }, 400, 'Your dunning sequence "Hatch reminders" is paused — activate it before sending reminders.'],
      [{ reason: 'past_due_unreadable' }, 502, "Could not read the member's invoices. Try again shortly."],
      [{ reason: 'enrolment_unreadable' }, 502, "Could not read the member's invoices. Try again shortly."],
      [{ reason: 'threw', error: 'boom' }, 502, 'Could not start the dunning sequence.'],
    ]
    for (const [result, status, error] of cases) {
      writes = []
      maybeEnrolUn1tDunning.mockResolvedValue({ enrolled: 0, ...result })
      const res = await remind()
      expect(res.status, result.reason).toBe(status)
      expect(await res.json()).toEqual({ success: false, error })
      expect(writes).toEqual([])
    }
  })
})
