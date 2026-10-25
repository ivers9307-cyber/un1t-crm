// @vitest-environment jsdom
//
// SEQPAGEGATE.1 review S1 — SequenceFlowBuilder keys SequenceSettings on the
// sequence's saved fields so a router.refresh() (Pause / Resume / Publish, an
// agent edit) re-seeds the panel. After a secret is saved the refresh brings
// has_webhook_secret true and often a new status, the key changes, and the
// panel remounts. The plaintext the operator has not copied yet must survive
// that remount; it is gone only when they leave or reload the page.
// Fictional values only.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
vi.mock('./FlowEditor', () => ({ default: () => null }))
vi.mock('./AgentPanel', () => ({ default: () => null }))
vi.mock('./DraftBanner', () => ({ default: () => null }))

import SequenceFlowBuilder from './SequenceFlowBuilder.jsx'

const JUST_SET = 'Saved. Copy it now; it is not shown again once you leave or refresh this page.'
const SEQ = {
  id: 'seq-1', location_id: 'loc-1', name: 'Hook', status: 'draft', trigger_type: 'webhook',
  trigger_config: {}, webhook_token: 'c'.repeat(32), has_webhook_secret: false,
}
const GRAPH = { nodes: [], edges: [] }

const secretInput = (container) =>
  Array.from(container.querySelectorAll('input')).find(i => /optional secret|Saved \(hidden\)/.test(i.placeholder))

describe('SequenceFlowBuilder keeps a just-saved secret across a settings remount (SEQPAGEGATE.1)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn((url, init) => {
      if (init?.method === 'PUT') {
        return Promise.resolve({ json: async () => ({ success: true, sequence: { webhook_token: 'c'.repeat(32), has_webhook_secret: true } }) })
      }
      return new Promise(() => {})
    }))
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('a refresh that flips has_webhook_secret and status still shows the secret and the copy-now message', async () => {
    const { container, getByText, rerender } = render(<SequenceFlowBuilder graph={GRAPH} sequence={SEQ} isDraft={false} isPublished={false} />)
    fireEvent.click(getByText('Settings & trigger'))
    fireEvent.click(getByText('Generate new secret'))
    const generated = secretInput(container).value
    expect(generated).toMatch(/^[0-9a-f]{48}$/)
    fireEvent.click(getByText('Save settings'))
    await waitFor(() => expect(container.textContent).toContain(JUST_SET))

    // router.refresh(): the server now says a secret is set, and Publish made it active.
    rerender(<SequenceFlowBuilder graph={GRAPH} sequence={{ ...SEQ, status: 'active', has_webhook_secret: true }} isDraft={false} isPublished />)

    expect(secretInput(container)?.value).toBe(generated)
    expect(container.textContent).toContain(JUST_SET)
    expect(container.textContent).not.toContain('(hidden)')
  })

  it('with nothing just saved, a refresh shows the hidden state as before', () => {
    const { container, getByText, rerender } = render(<SequenceFlowBuilder graph={GRAPH} sequence={{ ...SEQ, has_webhook_secret: true }} isDraft={false} isPublished={false} />)
    rerender(<SequenceFlowBuilder graph={GRAPH} sequence={{ ...SEQ, status: 'paused', has_webhook_secret: true }} isDraft={false} isPublished />)
    fireEvent.click(getByText('Settings & trigger'))
    expect(secretInput(container).value).toBe('')
    expect(container.textContent).toContain('A secret is set (hidden)')
    expect(container.textContent).not.toContain(JUST_SET)
  })
})
