// @vitest-environment jsdom
//
// TZ follow-up — the template editor's live preview renders {{today}} in the
// zone the server chose for it (a studio of the template's org), not always
// Dublin. Omitted, it stays Dublin. Only Date is faked.
process.env.TZ = 'America/Los_Angeles' // host zone is neither zone under test

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

import ContractTemplateForm from './ContractTemplateForm'

const initial = { name: 'T', employment_type: 'both', active: true, body_markdown: 'Dated {{today}}.', variables_schema: [] }
const previewText = () => screen.getAllByText(/^Dated \d{4}-\d{2}-\d{2}\.$/).map((el) => el.textContent)

afterEach(() => { cleanup(); vi.useRealTimers() })

describe('ContractTemplateForm previews {{today}} in the server-chosen zone', () => {
  it('Europe/Dublin just after local midnight in summer, and the omitted zone, are Dublin\'s day', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-07-15T23:30:00Z') }) // 00:30 IST on 16 Jul
    render(<ContractTemplateForm initial={initial} isEdit previewZone="Europe/Dublin" />)
    expect(previewText()).toContain('Dated 2026-07-16.')
    cleanup()
    render(<ContractTemplateForm initial={initial} isEdit />)
    expect(previewText()).toContain('Dated 2026-07-16.')
  })

  it('America/New_York shows New York\'s day, either side of the 2026 spring-forward', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-07-15T23:30:00Z') }) // 19:30 EDT on 15 Jul
    render(<ContractTemplateForm initial={initial} isEdit previewZone="America/New_York" />)
    expect(previewText()).toContain('Dated 2026-07-15.')
    cleanup()
    vi.setSystemTime(Date.parse('2026-03-08T04:30:00Z')) // 23:30 EST on 7 Mar
    render(<ContractTemplateForm initial={initial} isEdit previewZone="America/New_York" />)
    expect(previewText()).toContain('Dated 2026-03-07.')
    cleanup()
    vi.setSystemTime(Date.parse('2026-03-09T04:30:00Z')) // 00:30 EDT on 9 Mar
    render(<ContractTemplateForm initial={initial} isEdit previewZone="America/New_York" />)
    expect(previewText()).toContain('Dated 2026-03-09.')
  })
})
