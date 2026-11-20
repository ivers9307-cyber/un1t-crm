// RCOV — POST /api/accounting/coverage/import-statement through the real
// withAuth wrapper: accounting_hub at the active studio, lines filed there.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ tag: 'db' })) }))
vi.mock('@/lib/recon/statement-csv', async (importOriginal) => ({
  ...(await importOriginal()),
  parseStatementCsv: vi.fn(() => ({ rows: [], warnings: [] })),
}))
vi.mock('@/lib/recon/import-statement', () => ({ importStatementLines: vi.fn(async () => ({ inserted: 0 })) }))

const { getCurrentUser } = await import('@/lib/auth')
const { parseStatementCsv } = await import('@/lib/recon/statement-csv')
const { importStatementLines } = await import('@/lib/recon/import-statement')
const { POST } = await import('./route.js')

const good = { bankAccountId: 'acct-12345678', bankAccountName: 'Current', csvText: 'Date,Amount\n' }
const post = (b = good) => POST(new Request('http://localhost/api/accounting/coverage/import-statement', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }))
const caller = (on) => person({ [LOC_A]: { role: 'staff', permissions: { accounting_hub: on } }, [LOC_B]: { role: 'staff', permissions: { accounting_hub: true } } }, LOC_A)

beforeEach(() => { vi.clearAllMocks() })

describe('POST /api/accounting/coverage/import-statement', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await post()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(importStatementLines).not.toHaveBeenCalled()
  })

  it("403 'Forbidden' without accounting_hub at the active studio, even with it elsewhere", async () => {
    getCurrentUser.mockResolvedValue(caller(false))
    const res = await post()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
    expect(importStatementLines).not.toHaveBeenCalled()
  })

  it('a bad export shape is a 422 with the parser’s words', async () => {
    getCurrentUser.mockResolvedValue(caller(true))
    parseStatementCsv.mockImplementationOnce(() => { throw new Error('No Date column found') })
    const res = await post()
    expect(res.status).toBe(422)
    expect((await res.json()).error).toBe('No Date column found')
  })

  it('imports at the active studio', async () => {
    getCurrentUser.mockResolvedValue(caller(true))
    const res = await post()
    expect(res.status).toBe(200)
    expect(importStatementLines).toHaveBeenCalledWith({ tag: 'db' }, expect.objectContaining({ locationId: LOC_A, bankAccountId: 'acct-12345678' }))
  })
})
