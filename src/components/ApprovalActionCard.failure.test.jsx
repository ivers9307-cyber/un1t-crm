// C117 APPROVALCODEWEB.1 — the inbox approval card printed the raw failure
// code under a failed card ("(TRIAL_GRANT_FAILED)"). It now prints the
// operator sentence from failureExplanation (shared/agent-request-failure.js,
// re-exported by @/lib/approvals/agent-request-why), under the same rule the
// phone's failedCardExplanation uses: a FAILED card with a recorded result.
// Fictional ids only.
import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { failureExplanation } from '@/lib/approvals/agent-request-why'

vi.mock('@/components/SequencePicker', () => ({ default: () => null }))

const { default: ApprovalActionCard } = await import('./ApprovalActionCard.jsx')

const card = (over) => ({
  id: 'a0000000-0000-4000-8000-000000000001',
  kind: 'book_class',
  status: 'failed',
  details: { result: { message_code: 'TRIAL_GRANT_FAILED' } },
  decision_note: null,
  ...over,
})
const render = (request) => renderToStaticMarkup(<ApprovalActionCard request={request} />)
// renderToStaticMarkup escapes apostrophes; compare on the escaped form.
const escaped = (s) => s.replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;')

describe('ApprovalActionCard failure line (C117)', () => {
  it('a failed card explains the code and never prints it raw', () => {
    const request = card()
    const html = render(request)
    expect(html).not.toContain('TRIAL_GRANT_FAILED')
    expect(html).toContain(escaped(failureExplanation(request)))
  })

  it('the no-answer variant of a trial failure reads its own sentence', () => {
    const request = card({ details: { result: { message_code: 'TRIAL_GRANT_FAILED', outcome_unknown: true } } })
    const html = render(request)
    expect(html).toContain(escaped(failureExplanation(request)))
    expect(html).toContain('Glofox did not answer clearly')
  })

  it('a code keyed on reason is explained too', () => {
    const request = card({ details: { result: { reason: 'NOT_EXECUTABLE' } } })
    const html = render(request)
    expect(html).not.toContain('(NOT_EXECUTABLE)')
    expect(html).toContain('no linked Glofox account')
  })

  it('a failed card with no recorded result says nothing extra (as on the phone)', () => {
    const html = render(card({ details: {} }))
    expect(html).not.toContain('The execution failed')
  })

  it('a card that did not fail shows no failure line', () => {
    const html = render(card({ status: 'approved' }))
    expect(html).not.toContain('Glofox would not add the trial credit')
    expect(html).not.toContain('TRIAL_GRANT_FAILED')
  })
})
