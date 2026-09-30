// SEQCOUNTERS.1 — the "N enrolled" chip read email_sequences.total_enrolled,
// a counter nothing maintained. It now shows enrolled_count, counted by the
// page from sequence_enrollments. A failed list read says so instead of
// "No automations yet". Fictional values only.
import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))

const { default: AutomationsFlowList } = await import('./AutomationsFlowList.jsx')

const seq = (over) => ({ id: 'a0000000-0000-4000-8000-000000000001', name: 'Welcome flow', status: 'active', trigger_type: 'manual', sequence_steps: [{ id: 's1' }], enrolled_count: 0, ...over })

describe('AutomationsFlowList (SEQCOUNTERS.1)', () => {
  it('shows the counted enrolments', () => {
    const html = renderToStaticMarkup(<AutomationsFlowList sequences={[seq({ enrolled_count: 139 })]} />)
    expect(html).toContain('139 enrolled')
  })

  it('ignores a stale total_enrolled', () => {
    const html = renderToStaticMarkup(<AutomationsFlowList sequences={[seq({ enrolled_count: 15, total_enrolled: 0 })]} />)
    expect(html).toContain('15 enrolled')
  })

  it('no chip at zero', () => {
    const html = renderToStaticMarkup(<AutomationsFlowList sequences={[seq({ enrolled_count: 0 })]} />)
    expect(html).not.toMatch(/\d+ enrolled/)
  })

  it('a failed read: a notice, never "No automations yet"', () => {
    const html = renderToStaticMarkup(<AutomationsFlowList sequences={[]} loadFailed />)
    expect(html).toMatch(/Couldn(?:'|&#x27;)t load your automations\. Reload to try again\./)
    expect(html).not.toContain('No automations yet')
  })
})
