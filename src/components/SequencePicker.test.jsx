// @vitest-environment jsdom
//
// SEQPAGEGATE.1 review N3 — POST /api/sequences/[id]/enrol now answers
// another studio's sequence and a missing one with the same 404
// { success:false, error:'Not found' }. Surfaced raw, the picker would tell
// an operator whose automation was just deleted only "Not found". It says
// what happened instead. Fictional ids only.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'
import SequencePicker, { SEQUENCE_GONE_MESSAGE } from './SequencePicker.jsx'

const SEQ = { id: 'a0000000-0000-0000-0000-00000000000a', name: 'Welcome flow', status: 'active', trigger_type: 'manual' }
const CONTACT = 'b0000000-0000-0000-0000-00000000000b'
const LOC = 'c0000000-0000-0000-0000-00000000000c'

const jsonRes = (status, body) => ({ status, ok: status < 400, json: async () => body })

function stubFetch({ preview, enrol }) {
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (String(url).startsWith('/api/sequences?')) return jsonRes(200, { success: true, sequences: [SEQ] })
    const body = JSON.parse(init.body)
    return body.dry_run ? preview() : enrol()
  }))
}

describe('SequencePicker: an automation that is gone (SEQPAGEGATE.1)', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('a 404 on the preview says the automation no longer exists', async () => {
    stubFetch({ preview: () => jsonRes(404, { success: false, error: 'Not found' }), enrol: () => { throw new Error('no enrol') } })
    const { findByText, container } = render(<SequencePicker contactIds={[CONTACT]} locationId={LOC} />)
    fireEvent.click(await findByText('Welcome flow'))
    await waitFor(() => expect(container.textContent).toContain(SEQUENCE_GONE_MESSAGE))
    expect(container.textContent).not.toContain('Not found')
  })

  it('a 404 on the confirm says the same', async () => {
    stubFetch({
      preview: () => jsonRes(200, { success: true, would_enrol: 1, already_active: 0, ignored_invalid: 0, sample: [], total_requested: 1 }),
      enrol: () => jsonRes(404, { success: false, error: 'Not found' }),
    })
    const { findByText, container } = render(<SequencePicker contactIds={[CONTACT]} locationId={LOC} />)
    fireEvent.click(await findByText('Welcome flow'))
    fireEvent.click(await findByText('Enrol 1 contact'))
    await waitFor(() => expect(container.textContent).toContain(SEQUENCE_GONE_MESSAGE))
  })

  it('a 404 whose body is not JSON still says so', async () => {
    stubFetch({ preview: () => ({ status: 404, ok: false, json: async () => { throw new SyntaxError('Unexpected token <') } }), enrol: () => { throw new Error('no enrol') } })
    const { findByText, container } = render(<SequencePicker contactIds={[CONTACT]} locationId={LOC} />)
    fireEvent.click(await findByText('Welcome flow'))
    await waitFor(() => expect(container.textContent).toContain(SEQUENCE_GONE_MESSAGE))
  })

  it('other errors still show the server message', async () => {
    stubFetch({ preview: () => jsonRes(400, { success: false, error: 'contact_ids required' }), enrol: () => { throw new Error('no enrol') } })
    const { findByText, container } = render(<SequencePicker contactIds={[CONTACT]} locationId={LOC} />)
    fireEvent.click(await findByText('Welcome flow'))
    await waitFor(() => expect(container.textContent).toContain('contact_ids required'))
  })

  it('the message is plain words with no em-dash', () => {
    expect(SEQUENCE_GONE_MESSAGE).toBe('This automation no longer exists.')
    expect(SEQUENCE_GONE_MESSAGE).not.toContain('—')
  })
})
