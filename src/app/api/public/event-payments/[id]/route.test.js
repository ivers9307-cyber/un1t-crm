// GET /api/public/event-payments/[id] — EVENT-MOVE.5: the answer carries
// `kind` (the checkout labels a price difference), and the provider refresh
// is handed a row that carries kind + registration_move_id, so a paid
// difference takes markRacePaymentStatus's move_gap branch here too.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({
  createServerClient: vi.fn(() => ({
    from: () => {
      const b = {
        select: (cols) => { globalThis.__selects.push(cols); return b },
        eq: () => b,
        maybeSingle: async () => globalThis.__rows.shift(),
      }
      return b
    },
  })),
}))
vi.mock('@/lib/race-payments', () => ({ refreshRacePaymentFromProvider: vi.fn(async (_db, p) => p) }))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  getClientIp: () => '1.2.3.4',
  rateLimitResponse: () => new Response(null, { status: 429 }),
}))

const { refreshRacePaymentFromProvider } = await import('@/lib/race-payments')
const { GET } = await import('./route.js')

const ROW = { id: 'gp1', status: 'completed', amount_cents: 1000, currency: 'EUR', kind: 'move_gap', registration_move_id: 'mv1',
  payment_provider: 'revolut', payment_provider_ref: 'ord-1', payment_checkout_token: 'tok', payment_checkout_url: null,
  connected_account_id: null, application_fee_cents: null, race_event_id: 'e2', race_registration_id: 'r1',
  race: { id: 'e2', name: 'Hatch Oct 25', slug: 'hatch-oct25-1100' },
  registration: { id: 'r1', status: 'confirmed', team_id: 't1', teams: { name: 'The Crushers', size: 2 } } }
const get = () => GET(new Request('http://localhost/api/public/event-payments/gp1'), { params: Promise.resolve({ id: 'gp1' }) })

beforeEach(() => {
  vi.clearAllMocks()
  globalThis.__selects = []
  globalThis.__rows = []
})

describe('GET /api/public/event-payments/[id] — kind', () => {
  it('answers kind move_gap for a price-difference payment', async () => {
    globalThis.__rows = [{ data: ROW, error: null }]
    const json = await (await get()).json()
    expect(json.data.kind).toBe('move_gap')
    expect(json.data.amount_cents).toBe(1000)
  })
  it('answers kind entry for a row with no kind', async () => {
    globalThis.__rows = [{ data: { ...ROW, kind: undefined }, error: null }]
    expect((await (await get()).json()).data.kind).toBe('entry')
  })
  it('a pending row is refreshed with kind and registration_move_id on it, and both selects name them', async () => {
    globalThis.__rows = [{ data: { ...ROW, status: 'pending' }, error: null }, { data: { ...ROW, status: 'completed' }, error: null }]
    const json = await (await get()).json()
    expect(refreshRacePaymentFromProvider).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: 'move_gap', registration_move_id: 'mv1' }))
    expect(globalThis.__selects).toHaveLength(2)
    for (const cols of globalThis.__selects) {
      expect(cols).toMatch(/\bkind\b/)
      expect(cols).toMatch(/\bregistration_move_id\b/)
    }
    expect(json.data.status).toBe('completed')
  })
})

describe('GET /api/public/event-payments/[id] — expired and settled differences (EVENT-MOVE.5)', () => {
  it.each(['abandoned', 'failed'])('a %s move_gap row is expired, and is not refreshed', async (status) => {
    globalThis.__rows = [{ data: { ...ROW, status, move: { gap_settled_at: null, gap_settled_how: null } }, error: null }]
    const json = await (await get()).json()
    expect(json.data).toEqual(expect.objectContaining({ expired: true, settled: false, settled_how: null }))
    expect(refreshRacePaymentFromProvider).not.toHaveBeenCalled()
  })
  it('a pending move_gap row whose move was settled by hand says settled, with how', async () => {
    globalThis.__rows = [
      { data: { ...ROW, status: 'pending', move: { gap_settled_at: '2026-10-09T10:00:00Z', gap_settled_how: 'waived' } }, error: null },
      { data: { ...ROW, status: 'pending', move: { gap_settled_at: '2026-10-09T10:00:00Z', gap_settled_how: 'waived' } }, error: null },
    ]
    const json = await (await get()).json()
    expect(json.data).toEqual(expect.objectContaining({ settled: true, settled_how: 'waived', expired: false }))
  })
  it('an entry row is never expired or settled, whatever its status', async () => {
    globalThis.__rows = [{ data: { ...ROW, kind: 'entry', status: 'abandoned', move: null }, error: null }]
    const json = await (await get()).json()
    expect(json.data).toEqual(expect.objectContaining({ expired: false, settled: false, settled_how: null }))
  })
  it('both selects read the move\'s settled fields', async () => {
    globalThis.__rows = [{ data: { ...ROW, status: 'pending' }, error: null }, { data: ROW, error: null }]
    await get()
    for (const cols of globalThis.__selects) expect(cols.replace(/\s+/g, ' ')).toContain('move:registration_move_id ( gap_settled_at, gap_settled_how )')
  })
})

// EVENT-MOVE.6 — a customer's own date change is flagged, and nothing more:
// the way back to the entry page travels in the pay link's #back= fragment,
// so this payment-id route never mints or returns an entry token.
describe('GET /api/public/event-payments/[id] — is_date_change', () => {
  const PM = { target_event_id: 'e3', target_wave_id: 'w3', expected_source_event_id: 'e2', actor: { type: 'customer', id: 'k1', name: 'Aoife Byrne' } }
  it('flags a customer date change and echoes neither the pending move nor any token', async () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'svc')
    try {
      globalThis.__rows = [{ data: { ...ROW, registration_move_id: null, metadata: { pending_move: PM } }, error: null }]
      const json = await (await get()).json()
      expect(json.data.is_date_change).toBe(true)
      expect(json.data).not.toHaveProperty('return_path')
      expect(JSON.stringify(json)).not.toMatch(/pending_move|Aoife|metadata|\/event\/entry/)
    } finally {
      vi.unstubAllEnvs()
    }
  })
  it('a staff difference link and an entry payment are not date changes', async () => {
    globalThis.__rows = [{ data: { ...ROW, metadata: null }, error: null }]
    expect((await (await get()).json()).data.is_date_change).toBe(false)
    globalThis.__rows = [{ data: { ...ROW, kind: 'entry', metadata: { pending_move: PM } }, error: null }]
    expect((await (await get()).json()).data.is_date_change).toBe(false)
  })
  it('both selects read metadata', async () => {
    globalThis.__rows = [{ data: { ...ROW, status: 'pending' }, error: null }, { data: ROW, error: null }]
    await get()
    for (const cols of globalThis.__selects) expect(cols).toMatch(/\bmetadata\b/)
  })
})
