// @vitest-environment jsdom
//
// SEQ-URLBUTTON.1 — the builder must raise the dynamic-URL-button problem
// INLINE, on the step card, rather than letting the operator press Publish and
// collect a 422.
//
// The rule needs the template (the graph stores only an id), and FlowEditor
// already holds the location's approved templates in state for the step
// editor's picker — it just wasn't handing them to validateGraph. So the client
// said the flow was fine and the server refused it, which reads as a broken
// Publish button rather than as a step that needs a value.
//
// jsdom cannot see layout (repo lesson), so this asserts the error TEXT is in
// the tree and that Publish is refused — never that anything is visible.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))

import FlowEditor from './FlowEditor.jsx'

const LOC = 'c0000000-0000-0000-0000-000000000003'
const SEQUENCE = { id: 'seq-1', location_id: LOC, name: 'Overdue chase', status: 'draft' }

const DYNAMIC = {
  id: 'wt-dyn',
  name: 'Overdue pay link',
  language: 'en',
  components: [
    { type: 'BODY', text: 'Hi {{1}}' },
    { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Pay now', url: 'https://pay.repset.ie/{{1}}', example: ['x'] }] },
  ],
}

const graphWith = (variables) => ({
  version: 1,
  trigger: { type: 'manual', config: {} },
  nodes: [{ id: 'n1', type: 'whatsapp', config: { template_id: 'wt-dyn', variables } }],
  edges: [{ from: 'trigger', to: 'n1' }],
})

// The templates fetch FlowEditor fires on mount; every other fetch is a no-op.
function stubFetch(templates) {
  const fetchMock = vi.fn((url) => {
    if (String(url).includes('/api/whatsapp/templates')) {
      return Promise.resolve({ json: () => Promise.resolve({ success: true, templates }) })
    }
    return new Promise(() => {})
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
beforeEach(() => vi.clearAllMocks())

describe('FlowEditor — inline URL-button red flag', () => {
  it('flags the step once the templates have loaded', async () => {
    stubFetch([DYNAMIC])
    const { container } = render(<FlowEditor initialGraph={graphWith({ 1: 'first_name' })} sequence={SEQUENCE} />)

    await waitFor(() => {
      expect(container.textContent).toContain('Pay now')
    })
    expect(container.textContent).toContain('on this step before publishing')
  })

  it('says nothing once the value is mapped', async () => {
    stubFetch([DYNAMIC])
    const { container } = render(<FlowEditor initialGraph={graphWith({ url_button: 'pay_link_suffix' })} sequence={SEQUENCE} />)

    // Let the templates land, then confirm the flag never appears.
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    await Promise.resolve()
    expect(container.textContent).not.toContain('on this step before publishing')
  })

  it('says nothing while the templates are still loading — it must not accuse every step on first render', () => {
    stubFetch([DYNAMIC])
    const { container } = render(<FlowEditor initialGraph={graphWith({})} sequence={SEQUENCE} />)
    // Synchronous first paint: the fetch has not resolved.
    expect(container.textContent).not.toContain('on this step before publishing')
  })

  // The gate is the disabled button, not a message after the click: FlowEditor
  // disables Publish on !validation.ok, so a step missing its link value can no
  // longer reach the endpoint at all.
  it('disables Publish while the value is missing, and re-enables it once mapped', async () => {
    const fetchMock = stubFetch([DYNAMIC])
    const { container, getByText } = render(<FlowEditor initialGraph={graphWith({})} sequence={SEQUENCE} />)
    const publishBtn = getByText('Publish').closest('button')

    await waitFor(() => expect(container.textContent).toContain('on this step before publishing'))
    expect(publishBtn.disabled).toBe(true)
    fireEvent.click(publishBtn)
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/publish'))).toBe(false)

    cleanup()
    const mapped = render(<FlowEditor initialGraph={graphWith({ url_button: 'pay_link_suffix' })} sequence={SEQUENCE} />)
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(mapped.getByText('Publish').closest('button').disabled).toBe(false)
  })
})
