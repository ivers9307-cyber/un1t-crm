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
//
// MAILFIX-SIGTRUTH.1 adds the truth pass:
//   - the preview renders the EFFECTIVE signature (studio context applied
//     over the typed values — the send's own resolver), with a per-studio
//     switch across the studios the caller can SEND from (has_mailbox)
//   - until the context has settled the preview is a PLACEHOLDER; settled
//     but unresolved (failed GET, no studio offered) it is ONE LINE — never
//     a frame of the un-resolved draft
//   - the NOTE input is GONE (the studio line always wins at send); a
//     stored note is STRIPPED from the save and never renders
//   - the Title placeholder is role-only ("Head Coach") — the studio name
//     follows the sending account, so it must not be baked into the title
//   - the false "mobile app edits this" claim is deleted
//   - a successful save marks localStorage so open composers refetch

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import EmailSignatureForm from '@/components/EmailSignatureForm'
import { MAX_SIGNATURE_LINKS, renderRichSignature } from '@/lib/email-signature'
import { SIGNATURE_UPDATED_KEY } from '@/components/tickets/SignatureHint'

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

const STILLORGAN_CTX = {
  location_id: 'loc-still',
  location_name: 'UN1T Stillorgan',
  studio_signature: { phone: '01 555 0001', links: [{ label: 'Book Stillorgan', url: 'https://un1t.ie/stillorgan' }] },
  has_mailbox: true,
}
const HATCH_CTX = { location_id: 'loc-hatch', location_name: 'UN1T Hatch Street', studio_signature: null, has_mailbox: true }
// Permitted at Hatch, but Hatch runs no mailbox — not a studio to offer.
const HATCH_NO_BOX = { ...HATCH_CTX, has_mailbox: false }
// The context-less DEFAULT studio: a name, no card — so the pre-existing
// preview tests still see a frame (a settled-but-empty context now shows a
// one-line "unavailable" instead of a frame).
const DEFAULT_CTX = { location_id: 'loc-default', location_name: 'UN1T Stillorgan', studio_signature: null, has_mailbox: true }

const isPatch = (url, init) => url.includes('/api/me/preferences') && init.method === 'PATCH'
const isPhotoPost = (url, init) => url.includes('/api/me/signature-photo') && init.method === 'POST'
const isPrefsGet = (url, init = {}) =>
  url.includes('/api/me/preferences') && (!init.method || init.method === 'GET')

// The editor GETs /api/me/preferences on mount for its signature context
// (MAILFIX-SIGTRUTH.1). Unless a test supplies its own contexts, one named
// default studio answers, so the preview resolves.
const prefsGetRoute = (contexts, active) => ({
  match: isPrefsGet,
  reply: jsonReply({
    success: true,
    data: {
      landing_preference: 'auto',
      email_signature: '',
      email_signature_rich: null,
      active_location_id: active,
      signature_contexts: contexts,
    },
  }),
})

function mockFetchRoutes(routes, { contexts = [DEFAULT_CTX], active = 'loc-default' } = {}) {
  const all = [...routes, prefsGetRoute(contexts, active)]
  global.fetch = vi.fn(async (url, init = {}) => {
    for (const r of all) {
      if (r.match(String(url), init)) return typeof r.reply === 'function' ? r.reply(url, init) : r.reply
    }
    throw new Error(`unexpected fetch ${init.method || 'GET'} ${url}`)
  })
}

// The mount GET is expected traffic now, so "nothing fired" assertions filter
// for the mutating calls they actually mean.
const callsMatching = (matcher) =>
  (global.fetch?.mock.calls || []).filter(([url, init = {}]) => matcher(String(url), init))

// The preview renders only once the context GET has SETTLED, so every
// assertion on the iframe waits for it to appear.
async function findIframe(container) {
  return waitFor(() => {
    const f = container.querySelector('iframe')
    expect(f).toBeTruthy()
    return f
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
})
afterEach(() => {
  cleanup()
  delete global.fetch
  window.localStorage.clear()
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
    // …and the cross-tab signal goes out, so an open composer refetches.
    await waitFor(() => expect(window.localStorage.getItem(SIGNATURE_UPDATED_KEY)).toMatch(/^\d+$/))
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
  it('pins the exact shape the strict zod schema accepts — note rides as "" now the input is gone', async () => {
    const bodies = []
    mockFetchRoutes([
      { match: isPatch, reply: (u, init) => { bodies.push(JSON.parse(init.body)); return jsonReply({ success: true, data: {} }) } },
    ])
    render(<EmailSignatureForm initialSignature="" initialRich={null} />)
    enableToggle()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  Sarah Doyle ' } })
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Head Coach' } })
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '01 234 5678' } })
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
        note: '',
        photo_url: null,
        links: [{ label: 'IG', url: 'https://instagram.com/un1t' }],
      },
    })
    await screen.findByText('Saved')
    // The cross-tab signal goes out on the rich save too.
    expect(window.localStorage.getItem(SIGNATURE_UPDATED_KEY)).toMatch(/^\d+$/)
  })

  it('a STORED note is STRIPPED on save — it never reaches the wire, and it is not a spurious unsaved change', async () => {
    const bodies = []
    mockFetchRoutes([
      { match: isPatch, reply: (u, init) => { bodies.push(JSON.parse(init.body)); return jsonReply({ success: true, data: {} }) } },
    ])
    render(
      <EmailSignatureForm
        initialSignature=""
        initialRich={{ enabled: true, name: 'Sarah', note: 'Legacy note', links: [] }}
      />
    )
    // No Note input anywhere, and nothing to save yet — a legacy note alone
    // must not light the Save button.
    expect(screen.queryByLabelText('Note')).toBeNull()
    expect(screen.getByRole('button', { name: /save rich signature/i }).disabled).toBe(true)
    // Editing another field and saving sends note:'' — the one value no
    // surface can show or edit must not survive to a blipped send.
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '01 234 5678' } })
    fireEvent.click(screen.getByRole('button', { name: /save rich signature/i }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0].email_signature_rich.note).toBe('')
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
    mockFetchRoutes([]) // any fetch beyond the mount GET would throw
    render(<EmailSignatureForm initialSignature="" initialRich={null} />)
    enableToggle()
    const file = new File(['x'], 'me.gif', { type: 'image/gif' })
    fireEvent.change(screen.getByLabelText('Signature photo file'), { target: { files: [file] } })
    // The static hint also mentions the formats — assert the ALERT, so this
    // can't pass vacuously.
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Photo must be JPEG, PNG or WebP')
    // Nothing but the mount GET fired — the original assertion, minus the
    // one call MAILFIX-SIGTRUTH.1 introduced.
    expect(callsMatching((u, i) => !isPrefsGet(u, i))).toHaveLength(0)
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

  it('a non-http(s) url shows an inline error and blocks the save (no PATCH fires)', async () => {
    mockFetchRoutes([]) // a PATCH here would throw
    render(<EmailSignatureForm initialSignature="" initialRich={null} />)
    enableToggle()
    fireEvent.click(screen.getByRole('button', { name: /add link/i }))
    fireEvent.change(screen.getByLabelText('Link 1 URL'), { target: { value: 'ftp://x.com' } })
    await screen.findByText(/http:\/\/ or https:\/\//)
    const save = screen.getByRole('button', { name: /save rich signature/i })
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    // Nothing but the mount GET fired.
    expect(callsMatching((u, i) => !isPrefsGet(u, i))).toHaveLength(0)
  })
})

describe('preview', () => {
  it('renders the SHARED renderer html inside a sandboxed iframe — never into the page DOM', async () => {
    mockFetchRoutes([])
    const { container } = render(
      <EmailSignatureForm
        initialSignature=""
        initialRich={{ enabled: true, name: 'Sarah <Doyle>', links: [{ label: 'IG', url: 'https://x.com' }] }}
      />
    )
    const iframe = await findIframe(container)
    // sandbox="" — no scripts, no same-origin. The empty value is the point.
    expect(iframe.getAttribute('sandbox')).toBe('')

    // The EFFECTIVE payload — the default studio's name on the detail line.
    const expected = renderRichSignature({
      enabled: true, name: 'Sarah <Doyle>', title: '', phone: '', note: 'UN1T Stillorgan',
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

  it('shows a hint instead of an empty frame when there is nothing to render', async () => {
    mockFetchRoutes([])
    render(<EmailSignatureForm initialSignature="" initialRich={null} />)
    enableToggle()
    await screen.findByText(/fill in a field/i)
    expect(document.querySelector('iframe')).toBeNull()
  })
})

// ── MAILFIX-SIGTRUTH.1 — the preview is the EFFECTIVE signature ────────────
describe('effective preview', () => {
  const RICH = { enabled: true, name: 'Alex Example', title: 'Head Coach', phone: '087 111 2222', note: 'Legacy note', links: [] }
  const UNAVAILABLE = /couldn.t resolve your studio — the preview is unavailable\. your saved signature still sends with the studio.s details\./i

  it('applies the studio context over the typed values — a stored note NEVER renders, the studio line does', async () => {
    mockFetchRoutes([], { contexts: [STILLORGAN_CTX], active: 'loc-still' })
    const { container } = render(<EmailSignatureForm initialSignature="" initialRich={RICH} />)

    // The caption is the signal the context landed.
    await screen.findByText(/follow the account you send from/i)
    const srcDoc = (await findIframe(container)).getAttribute('srcdoc')
    // Studio-resolved: the studio name on the detail line, the studio's
    // phone and link over the person's own.
    expect(srcDoc).toContain('UN1T Stillorgan')
    expect(srcDoc).toContain('01 555 0001')
    expect(srcDoc).not.toContain('Legacy note')
    expect(srcDoc).not.toContain('087 111 2222')
    // Same truth in the plain-text half.
    const plain = screen.getByText((t) => t.includes('Book Stillorgan: https://un1t.ie/stillorgan'))
    expect(plain).toBeTruthy()
    expect(screen.queryByText((t) => t.includes('Legacy note'))).toBeNull()
    // And the caption names the studio it resolves to.
    expect(screen.getByText('UN1T Stillorgan', { selector: 'span' })).toBeTruthy()
    // One studio = no choice to make: the switch is absent, not a lone chip.
    expect(screen.queryByRole('group', { name: 'Preview sending studio' })).toBeNull()
  })

  it('before the context settles the preview is a PLACEHOLDER — never the draft, never the stored note', async () => {
    // A GET that never answers: the placeholder must hold, not the typed values.
    global.fetch = vi.fn(() => new Promise(() => {}))
    const { container } = render(<EmailSignatureForm initialSignature="" initialRich={RICH} />)
    expect(screen.getByText(/resolving your studio/i)).toBeTruthy()
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.textContent).not.toContain('Legacy note')
    expect(container.textContent).not.toContain('Alex Example')
  })

  it('a FAILED context GET renders NO frame and NO plain-text pane — one line, and neither the note nor the person’s phone', async () => {
    global.fetch = vi.fn(async () => { throw new Error('offline') })
    const { container } = render(<EmailSignatureForm initialSignature="" initialRich={RICH} />)
    await screen.findByText(UNAVAILABLE)
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.querySelector('pre')).toBeNull()
    expect(container.textContent).not.toContain('Legacy note')
    expect(container.textContent).not.toContain('087 111 2222')
    expect(screen.queryByText(/fill in a field/i)).toBeNull()
    // The fields themselves are still editable — only the PREVIEW is gone.
    expect(screen.getByLabelText('Name').value).toBe('Alex Example')
  })

  it('a settled GET that offers NO studio is the same one line — never a frame of the un-resolved draft', async () => {
    mockFetchRoutes([], { contexts: [], active: null })
    const { container } = render(<EmailSignatureForm initialSignature="" initialRich={RICH} />)
    await screen.findByText(UNAVAILABLE)
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.querySelector('pre')).toBeNull()
    expect(container.textContent).not.toContain('Legacy note')
    expect(container.textContent).not.toContain('087 111 2222')
  })

  it('LIVE typing still updates the effective preview', async () => {
    mockFetchRoutes([], { contexts: [STILLORGAN_CTX], active: 'loc-still' })
    const { container } = render(<EmailSignatureForm initialSignature="" initialRich={RICH} />)
    await screen.findByText(/follow the account you send from/i)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Someone Else' } })
    const srcDoc = (await findIframe(container)).getAttribute('srcdoc')
    expect(srcDoc).toContain('Someone Else')
    expect(srcDoc).toContain('UN1T Stillorgan') // still resolved
  })

  it('with two sendable studios, the switch previews each (defaulting to the ACTIVE location)', async () => {
    mockFetchRoutes([], { contexts: [STILLORGAN_CTX, HATCH_CTX], active: 'loc-hatch' })
    const { container } = render(<EmailSignatureForm initialSignature="" initialRich={RICH} />)

    // Defaults to the active location — Hatch, whose card defines nothing,
    // so the person's own phone stands under Hatch's name.
    const hatchChip = await screen.findByRole('button', { name: 'UN1T Hatch Street' })
    expect(hatchChip.getAttribute('aria-pressed')).toBe('true')
    let srcDoc = (await findIframe(container)).getAttribute('srcdoc')
    expect(srcDoc).toContain('UN1T Hatch Street')
    expect(srcDoc).toContain('087 111 2222')
    expect(srcDoc).not.toContain('01 555 0001')

    // Switch to Stillorgan — its card takes over.
    fireEvent.click(screen.getByRole('button', { name: 'UN1T Stillorgan' }))
    srcDoc = container.querySelector('iframe').getAttribute('srcdoc')
    expect(srcDoc).toContain('UN1T Stillorgan')
    expect(srcDoc).toContain('01 555 0001')
    expect(srcDoc).not.toContain('087 111 2222')

    // The two-studio caption names both and says which one decides.
    expect(
      screen.getByText((_, el) =>
        el?.tagName === 'P'
        && el.textContent.includes('follow the account you send from')
        && el.textContent.includes('Shown for the studios you can send from: UN1T Stillorgan or UN1T Hatch Street, whichever you send from.')
      )
    ).toBeTruthy()
  })

  it('a permitted studio WITHOUT a mailbox gets no chip — and is not the default, even when it is the active location', async () => {
    mockFetchRoutes([], { contexts: [STILLORGAN_CTX, HATCH_NO_BOX], active: 'loc-hatch' })
    const { container } = render(<EmailSignatureForm initialSignature="" initialRich={RICH} />)
    await screen.findByText(/follow the account you send from/i)
    // Only Stillorgan is sendable → no switch at all.
    expect(screen.queryByRole('group', { name: 'Preview sending studio' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'UN1T Hatch Street' })).toBeNull()
    // …and the preview resolves for Stillorgan, not for the active-but-mailbox-less Hatch.
    const srcDoc = (await findIframe(container)).getAttribute('srcdoc')
    expect(srcDoc).toContain('UN1T Stillorgan')
    expect(srcDoc).toContain('01 555 0001')
    expect(srcDoc).not.toContain('UN1T Hatch Street')
    // The caption names only the offered studio.
    expect(screen.getByText('UN1T Stillorgan', { selector: 'span' })).toBeTruthy()
    expect(screen.queryByText((t) => t.includes('UN1T Hatch Street'))).toBeNull()
  })

  it('when NO permitted studio has a mailbox, every permitted studio is offered — the preview still resolves for a real one', async () => {
    mockFetchRoutes([], { contexts: [{ ...STILLORGAN_CTX, has_mailbox: false }, HATCH_NO_BOX], active: 'loc-hatch' })
    const { container } = render(<EmailSignatureForm initialSignature="" initialRich={RICH} />)
    const hatchChip = await screen.findByRole('button', { name: 'UN1T Hatch Street' })
    expect(hatchChip.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'UN1T Stillorgan' })).toBeTruthy()
    const srcDoc = (await findIframe(container)).getAttribute('srcdoc')
    expect(srcDoc).toContain('UN1T Hatch Street')
  })

  it('an active location OUTSIDE the offered list falls back to the first offered studio', async () => {
    // Session pointed at a studio with no queue (or none at all) — the
    // preview must still resolve for a real sending studio, not for nothing.
    mockFetchRoutes([], { contexts: [STILLORGAN_CTX, HATCH_CTX], active: 'loc-elsewhere' })
    const { container } = render(<EmailSignatureForm initialSignature="" initialRich={RICH} />)
    const stillChip = await screen.findByRole('button', { name: 'UN1T Stillorgan' })
    expect(stillChip.getAttribute('aria-pressed')).toBe('true')
    const srcDoc = (await findIframe(container)).getAttribute('srcdoc')
    expect(srcDoc).toContain('01 555 0001') // list[0]'s (Stillorgan's) phone
    expect(srcDoc).not.toContain('087 111 2222')
  })

  it('an EMPTY enabled draft previews nothing — the send would fall back to the plain column, so no studio-only block', async () => {
    mockFetchRoutes([], { contexts: [STILLORGAN_CTX], active: 'loc-still' })
    render(<EmailSignatureForm initialSignature="" initialRich={null} />)
    enableToggle()
    await screen.findByText(/follow the account you send from/i)
    await screen.findByText(/fill in a field/i)
    expect(document.querySelector('iframe')).toBeNull()
  })
})

// ── MAILFIX-SIGTRUTH.1 — copy and fields tell the truth ───────────────────
describe('editor truth fixes', () => {
  it('has no Note input and a role-only Title placeholder', () => {
    mockFetchRoutes([])
    render(<EmailSignatureForm initialSignature="" initialRich={null} />)
    enableToggle()
    expect(screen.queryByLabelText('Note')).toBeNull()
    expect(screen.getByLabelText('Title').getAttribute('placeholder')).toBe('Head Coach')
  })

  it('nowhere claims the mobile app edits the signature', async () => {
    mockFetchRoutes([])
    const { container } = render(<EmailSignatureForm initialSignature="" initialRich={null} />)
    enableToggle()
    await act(async () => {})
    expect(container.textContent).not.toMatch(/mobile app/i)
    // The truthful replacement points at this page instead.
    expect(container.textContent).toMatch(/crm\.repset\.ie\/account/)
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
    // No signal on a FAILED save — nothing changed for the other tabs.
    expect(window.localStorage.getItem(SIGNATURE_UPDATED_KEY)).toBeNull()
  })
})
