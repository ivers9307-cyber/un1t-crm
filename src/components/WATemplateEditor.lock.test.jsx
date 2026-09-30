// @vitest-environment jsdom
//
// WATPLPUT.1 — the editor reads the PUT route's lock (isTemplateSubmitted,
// isHeaderMediaEditable from src/lib/whatsapp-template-fields.js):
// - a row carrying a Meta id is submitted even if its status still reads
//   'draft', so Update is not offered where the route answers 409;
// - an APPROVED template's header image can be replaced by a manager: the
//   send attaches it as a link, so Meta does not re-review it. The new file
//   self-saves (header fields only) through the PUT, since Update stays off.
// Ids are synthetic.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/communications/templates/whatsapp/t1',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/lib/supabase', () => ({
  createBrowserClient: () => ({
    storage: { from: () => ({ uploadToSignedUrl: async () => ({ error: null }) }) },
  }),
}))

import WATemplateEditor from './WATemplateEditor.jsx'

const ID = 'b0000000-0000-4000-8000-000000000001'
const LOC = 'b0000000-0000-4000-8000-00000000000b'
const APPROVED_IMAGE = {
  id: ID,
  name: 'promo_x',
  status: 'APPROVED',
  meta_template_id: 'meta-1',
  category: 'MARKETING',
  language: 'en',
  display_group: null,
  location_id: LOC,
  header_media_handle: 'h:old',
  header_media_url: 'https://example.test/old.jpg',
  header_media_path: `${LOC}/old.jpg`,
  components: [
    { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['h:old'] } },
    { type: 'BODY', text: 'Hi there' },
  ],
}
const NEW_MEDIA = { handle: 'h:new', url: 'https://example.test/new.jpg', path: `${LOC}/new.jpg`, file_name: 'new.jpg', file_size: 10, meta_error: null }

let calls
beforeEach(() => {
  calls = []
  global.fetch = vi.fn(async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined })
    const u = String(url)
    if (u.endsWith('/upload-media/sign')) return new Response(JSON.stringify({ success: true, path: NEW_MEDIA.path, token: 'tok' }))
    if (u.endsWith('/upload-media')) return new Response(JSON.stringify({ success: true, ...NEW_MEDIA }))
    if (init.method === 'PUT') return new Response(JSON.stringify({ success: true, template: {} }))
    return new Response(JSON.stringify({ success: true, templates: [] }))
  })
})
afterEach(() => cleanup())

const REPLACE = { name: /Replace the header image/ }
const puts = () => calls.filter((c) => c.method === 'PUT')

async function uploadNewImage(container) {
  const input = container.querySelector('input[type="file"]')
  expect(input.disabled).toBe(false)
  const file = new File(['x'.repeat(10)], 'new.jpg', { type: 'image/jpeg' })
  fireEvent.change(input, { target: { files: [file] } })
}

describe('WATemplateEditor — the lock is the route\'s (WATPLPUT.1)', () => {
  it('a Meta id on a row still reading draft: submitted, so Update is disabled', () => {
    render(<WATemplateEditor template={{ ...APPROVED_IMAGE, status: 'draft' }} locationId={LOC} userId="u1" canManage />)
    expect(screen.getByRole('button', { name: /Update/ }).disabled).toBe(true)
  })

  it('an APPROVED template, a manager: the header image can be replaced, and the new file saves the header fields only', async () => {
    const { container } = render(<WATemplateEditor template={APPROVED_IMAGE} locationId={LOC} userId="u1" canManage />)
    expect(screen.getByRole('button', { name: /Update/ }).disabled).toBe(true)
    expect(screen.getByDisplayValue('promo_x').disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', REPLACE))
    await uploadNewImage(container)
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]).toEqual({
      url: `/api/whatsapp/templates/${ID}`,
      method: 'PUT',
      body: { header_media_handle: 'h:new', header_media_url: NEW_MEDIA.url, header_media_path: NEW_MEDIA.path },
    })
    expect(await screen.findByText(/Header image saved/)).toBeTruthy()
    // Signed and finalised at the template's studio.
    expect(calls.find((c) => c.url.endsWith('/sign')).body.location_id).toBe(LOC)
  })

  it('an APPROVED template, a manager: a refused save puts the old image back and says why', async () => {
    global.fetch.mockImplementation(async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined })
      const u = String(url)
      if (u.endsWith('/upload-media/sign')) return new Response(JSON.stringify({ success: true, path: NEW_MEDIA.path, token: 'tok' }))
      if (u.endsWith('/upload-media')) return new Response(JSON.stringify({ success: true, ...NEW_MEDIA }))
      if (init.method === 'PUT') return new Response(JSON.stringify({ success: false, error: 'Forbidden' }), { status: 403 })
      return new Response(JSON.stringify({ success: true, templates: [] }))
    })
    const { container } = render(<WATemplateEditor template={APPROVED_IMAGE} locationId={LOC} userId="u1" canManage />)
    fireEvent.click(screen.getByRole('button', REPLACE))
    await uploadNewImage(container)
    expect(await screen.findByText(/Forbidden/)).toBeTruthy()
    expect(container.querySelector('img').getAttribute('src')).toBe(APPROVED_IMAGE.header_media_url)
  })

  it.each([
    ['an APPROVED template without canManage', APPROVED_IMAGE, false],
    ['a PENDING template with canManage (in review)', { ...APPROVED_IMAGE, status: 'PENDING' }, true],
  ])('%s: the header image cannot be replaced', (_label, template, canManage) => {
    const { container } = render(<WATemplateEditor template={template} locationId={LOC} userId="u1" canManage={canManage} />)
    expect(screen.queryByRole('button', REPLACE)).toBeNull()
    expect(container.querySelector('img').getAttribute('src')).toBe(APPROVED_IMAGE.header_media_url)
  })

  it('a REJECTED template with canManage: the new file rides Edit & resubmit, no PUT', async () => {
    const { container } = render(<WATemplateEditor template={{ ...APPROVED_IMAGE, status: 'REJECTED' }} locationId={LOC} userId="u1" canManage />)
    fireEvent.click(screen.getByTitle('Remove and re-upload'))
    await uploadNewImage(container)
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/upload-media'))).toBe(true))
    await new Promise((r) => setTimeout(r, 0))
    expect(puts()).toEqual([])
  })
})
