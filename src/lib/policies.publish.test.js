// POLICYATOMIC.1 (October audit A10) — publishVersion is one database call
// (public.publish_policy_version, mig 841), never a clear-then-insert pair.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
const { createServerClient } = await import('@/lib/supabase')
const { publishVersion, isCalendarDate } = await import('./policies.js')

let rpc, from
beforeEach(() => {
  rpc = vi.fn()
  from = vi.fn(() => { throw new Error('publishVersion must not write tables directly') })
  createServerClient.mockReturnValue({ rpc, from })
})

const ARGS = { policyId: 'p1', bodyMarkdown: '# v2', changeSummary: '', effectiveDate: '2026-11-15', publishedBy: 'u1' }

describe('publishVersion', () => {
  it('publishes through the one atomic function', async () => {
    rpc.mockResolvedValue({ data: [{ id: 'v2', version_number: 2 }], error: null })
    expect(await publishVersion(ARGS)).toEqual({ id: 'v2', version_number: 2 })
    expect(rpc).toHaveBeenCalledWith('publish_policy_version', {
      p_policy_id: 'p1', p_body_markdown: '# v2', p_change_summary: null, p_effective_date: '2026-11-15', p_published_by: 'u1',
    })
    expect(from).not.toHaveBeenCalled()
  })

  it('throws on a refusal, and on an empty answer', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } })
    await expect(publishVersion(ARGS)).rejects.toMatchObject({ message: 'boom' })
    rpc.mockResolvedValue({ data: [], error: null })
    await expect(publishVersion(ARGS)).rejects.toThrow(/no version/)
  })
})

describe('isCalendarDate', () => {
  it('accepts real days and refuses impossible ones', () => {
    expect(isCalendarDate('2026-11-15')).toBe(true)
    expect(isCalendarDate('2028-02-29')).toBe(true)
    for (const bad of ['2026-02-30', '2027-02-29', '2026-13-01', '2026-00-10', '2026-04-31']) {
      expect(isCalendarDate(bad)).toBe(false)
    }
  })
})
