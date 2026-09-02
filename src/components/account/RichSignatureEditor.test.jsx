// @vitest-environment jsdom
//
// MAIL-SIG.1 — the /account rich-signature editor, mounted through
// EmailSignatureForm (what the page renders) so the composition is pinned
// too. The load-bearing behaviours:
//
//   - toggle off = the plain path is UNTOUCHED: the textarea still saves
//     PATCH { email_signature } exactly as EMAIL-TICKET.5 shipped it, and
//     no rich field renders
//   - the rich save payload shape is pinned deep-equal
//   - photo_url is set ONLY from the upload route's response url
//   - link rows cap at MAX_SIGNATURE_LINKS; an invalid url blocks save
//     with an inline message and no request
//   - the preview is the SHARED renderer inside a sandboxed iframe
//     (sandbox="" + srcDoc) — the html never enters the page DOM
//   - a failed save keeps the draft and shows the server's words

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import EmailSignatureForm from '@/components/EmailSignatureForm'
import { MAX_SIGNATURE_LINKS, renderRichSignature } from '@/lib/email-signature'

// jsdom cannot decode images (no createImageBitmap, and its <img> never fires
// onload/onerror), so the real compressor's decode step never settles. Pass
// the file through untouched — the pre-check → POST → response-url flow is
// what these tests pin. parseUploadResponse stays REAL (it is browser-free).
vi.mock('@/lib/landing-media-upload', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, compressImageForUpload: async (f) => f }
})

const PHOTO_URL =
  'https://iyvtbjjxdggiadzwwvdj.supabase.co/storage/v1/object/public/branding/signatures/u1/photo.png?t=123'

const jsonReply = (body, status = 200) => ({
  ok: status < 400,
  status,
  headers: { get: () => 'application/json' },
  json: async () => body,
})

function mockFetchRoutes(routes) {
  global.fetch = vi.fn(async (url, init = {}) => {
    for (const r of routes) {
      if (r.match(String(url), init)) return typeof r.reply === 'function' ? r.reply(url, init) : r.reply
    }
    throw new Error(`unexpected fetch ${init.method || 'GET'} ${url}`)
  })
}

const isPatch = (url, init) => url.includes('/api/me/preferences') && init.method === 'PATCH'
const isPhotoPost = (url, init) => url.includes('/api/me/signature-photo') && init.method === 'POST'

beforeEach(() => vi.clearAllMocks())
afterEach(() => {
  cleanup()
  delete global.fetch
})

function enableToggle() {
  fireEvent.click(screen.getByRole('checkbox', { name: /use the rich signature/i }))
}

describe('toggle off — the plain path is untouched', () => {
  it('renders the plain textarea, saves PATCH { email_signature } only, and shows no rich fields', async () => {
    const bodies = []
    mockFetchRoutes([
      { match: isPatch, reply: (u, init) => { bodies.push(JSON.parse(init.body)); return jsonReply({ success: true, data: {} }) } },
    ])
    render(<EmailSignatureForm initialSignature="" initialRich={null} />)

    // No rich inputs while the toggle is off.
    expect(screen.queryByLabelText('Name')).toBeNull()
    expect(document.querySelector('iframe')).toBeNull()

    const textarea = screen.getByLabelText('Email signature')
    fireEvent.change(textarea, { target: { value: 'Sarah Doyle\n01 234 5678' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(bodies).toHaveLength(1))
    // Exactly the EMAIL-TICKET.5 shape — no email_signature_rich key rides along.
    expect(bodies[0]).toEqual({ email_signature: 'Sarah Doyle\n01 234 5678' })
  })

  it('flipping the toggle on and saving sends { email_signature_rich } with enabled:true', async () => {
    const bodies = []
    mockFetchRoutes([
      { match: isPatch, reply: (u, init) => { bodies.push(JSON.parse(init.body)); return jsonReply({ success: true, data: {} }) } },
    ])
    render(<EmailSignatureForm initialSignature="" initialRich={null} />)
    enableToggle()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Sarah' } })
    fireEvent.click(screen.getByRole('button', { name: /save rich signature/i }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(Object.keys(bodies[0])).toEqual(['email_signature_rich'])
    expect(bodies[0].email_signature_rich.enabled).toBe(true)
  })
})

describe('rich save payload', () => {
  it('pins the exact shape the strict zod schema accepts', async () => {
    const bodies = []
    mockFetchRoutes([
      { match: isPatch, reply: (u, init) => { bodies.push(JSON.parse(init.body)); return jsonReply({ success: true, data: {} }) } },
    ])
    render(<EmailSignatureForm initialSignature="" initialRich={null} />)
    enableToggle()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  Sarah Doyle ' } })
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Head Coach' } })
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '01 234 5678' } })
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Book a class' } })
    fireEvent.click(screen.getByRole('button', { name: /add link/i }))
    fireEvent.change(screen.getByLabelText('Link 1 label'), { target: { value: 'IG' } })
    fireEvent.change(screen.getByLabelText('Link 1 URL'), { target: { value: 'https://instagram.com/un1t' } })
    fireEvent.click(screen.getByRole('button', { name: /save rich signature/i }))

    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({
      email_signature_rich: {
        enabled: true,
        name: 'Sarah Doyle', // trimmed
        title: 'Head Coach',
        phone: '01 234 5678',
        note: 'Book a class',
        photo_url: null,
        links: [{ label: 'IG', url: 'https://instagram.com/un1t' }],
      },
    })
    await screen.findByText('Saved')
  })
})

describe('photo upload', () => {
  it('POSTs the file, shows the photo, and photo_url in the save comes from the response url ONLY', async () => {
    const bodies = []
    let postedFile = null
    mockFetchRoutes([
      {
        match: isPhotoPost,
        reply: (u, init) => {
          postedFile = init.body.get('file')
          return jsonReply({ success: true, url: PHOTO_URL })
        },
      },
      { match: isPatch, reply: (u, init) => { bodies.push(JSON.parse(init.body)); return jsonReply({ success: true, data: {} }) } },
    ])
    render(<EmailSignatureForm initialSignature="" initialRich={null} />)
    enableToggle()

    const file = new File(['x'], 'me.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText('Signature photo file'), { target: { files: [file] } })

    const img = await screen.findByAltText('Signature photo')
    expect(postedFile).toBeTruthy()
    expect(img.getAttribute('src')).toBe(PHOTO_URL)

    fireEvent.click(screen.getByRole('button', { name: /save rich signature/i }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0].email_signature_rich.photo_url).toBe(PHOTO_URL)
  })

  it('Remove photo nulls photo_url in the next save', async () => {
    const bodies = []
    mockFetchRoutes([
      { match: isPatch, reply: (u, init) => { bodies.push(JSON.parse(init.body)); return jsonReply({ success: true, data: {} }) } },
    ])
    render(
      <EmailSignatureForm
        initialSignature=""
        initialRich={{ enabled: true, name: 'Sarah', photo_url: PHOTO_URL, links: [] }}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /remove photo/i }))
    expect(screen.queryByAltText('Signature photo')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /save rich signature/i }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0].email_signature_rich.photo_url).toBe(null)
  })

  it('a rejected type never uploads and never sets a photo', async () => {
    mockFetchRoutes([]) // any fetch would throw the unexpected-fetch error
    render(<EmailSignatureForm initialSignature="" initialRich={null} />)
    enableToggle()
    const file = new File(['x'], 'me.gif', { type: 'image/gif' })
    fireEvent.change(screen.getByLabelText('Signature photo file'), { target: { files: [file] } })
    // The static hint also mentions the formats — assert the ALERT, so this
    // can't pass vacuously.
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Photo must be JPEG, PNG or WebP')
    expect(global.fetch).not.toHaveBeenCalled()
    expect(screen.queryByAltText('Signature photo')).toBeNull()
  })
})

describe('links editor', () => {
  it(`caps at ${MAX_SIGNATURE_LINKS} rows`, () => {
    mockFetchRoutes([])
    render(<EmailSignatureForm initialSignature="" initialRich={null} />)
    enableToggle()
    for (let i = 0; i < MAX_SIGNATURE_LINKS; i++) {
      fireEvent.click(screen.getByRole('button', { name: /add link/i }))
    }
    expect(screen.getAllByLabelText(/^Link \d URL$/)).toHaveLength(MAX_SIGNATURE_LINKS)
    expect(screen.queryByRole('button', { name: /add link/i })).toBeNull()
    // Removing one brings the button back.
    fireEvent.click(screen.getByRole('button', { name: /remove link 1/i }))
    expect(screen.getByRole('button', { name: /add link/i })).toBeTruthy()
  })

  it('a non-http(s) url shows an inline error and blocks the save (no request fires)', async () => {
    mockFetchRoutes([]) // a PATCH here would throw
    render(<EmailSignatureForm initialSignature="" initialRich={null} />)
    enableToggle()
    fireEvent.click(screen.getByRole('button', { name: /add link/i }))
    fireEvent.change(screen.getByLabelText('Link 1 URL'), { target: { value: 'ftp://x.com' } })
    await screen.findByText(/http:\/\/ or https:\/\//)
    const save = screen.getByRole('button', { name: /save rich signature/i })
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    expect(global.fetch).not.toHaveBeenCalled()
  })
})

describe('preview', () => {
  it('renders the SHARED renderer html inside a sandboxed iframe — never into the page DOM', () => {
    mockFetchRoutes([])
    const { container } = render(
      <EmailSignatureForm
        initialSignature=""
        initialRich={{ enabled: true, name: 'Sarah <Doyle>', links: [{ label: 'IG', url: 'https://x.com' }] }}
      />
    )
    const iframe = container.querySelector('iframe')
    expect(iframe).toBeTruthy()
    // sandbox="" — no scripts, no same-origin. The empty value is the point.
    expect(iframe.getAttribute('sandbox')).toBe('')

    const expected = renderRichSignature({
      enabled: true, name: 'Sarah <Doyle>', title: '', phone: '', note: '',
      photo_url: null, links: [{ label: 'IG', url: 'https://x.com' }],
    })
    const srcDoc = iframe.getAttribute('srcdoc')
    expect(srcDoc).toContain(expected.html)
    expect(srcDoc).toContain('Sarah &lt;Doyle&gt;') // renderer-escaped, not raw

    // The signature table exists ONLY as the srcDoc attribute — nothing was
    // injected into the document itself.
    expect(container.querySelector('table')).toBeNull()

    // Plain-text part shown beneath, from the same renderer.
    expect(screen.getByText((t) => t.includes('IG: https://x.com'))).toBeTruthy()
  })

  it('shows a hint instead of an empty frame when there is nothing to render', () => {
    mockFetchRoutes([])
    render(<EmailSignatureForm initialSignature="" initialRich={null} />)
    enableToggle()
    expect(document.querySelector('iframe')).toBeNull()
    expect(screen.getByText(/fill in a field/i)).toBeTruthy()
  })
})

describe('failed save', () => {
  it('keeps the draft on screen and shows the server words (issues included)', async () => {
    mockFetchRoutes([
      {
        match: isPatch,
        reply: jsonReply(
          { success: false, error: 'Invalid request body', issues: [{ path: 'email_signature_rich.links.0.url', message: 'http(s) links only' }] },
          400
        ),
      },
    ])
    render(<EmailSignatureForm initialSignature="" initialRich={null} />)
    enableToggle()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Sarah' } })
    fireEvent.click(screen.getByRole('button', { name: /save rich signature/i }))

    const alert = await screen.findByText(/Invalid request body — http\(s\) links only/)
    expect(alert).toBeTruthy()
    // Draft survives the failure.
    expect(screen.getByLabelText('Name').value).toBe('Sarah')
  })
})
