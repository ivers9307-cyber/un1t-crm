// @vitest-environment jsdom
// HOSTPAGE.2 — the page editor's extras: About, testimonials, photos (upload
// through the host photos route) and the two toggles, saved with the copy.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('@/lib/landing-media-upload', async (orig) => ({ ...(await orig()), compressImageForUpload: vi.fn(async (f) => f) }))
const { default: HostListPageEditor } = await import('./HostListPageEditor.jsx')

const jsonRes = (body, status = 200) => ({ ok: status < 400, status, headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) }, json: async () => body })
const INITIAL = {
  list_headline: '', list_blurb: '', list_button_label: '', list_success_message: '', events_headline: '', events_blurb: '', hero_image_url: '', accent_hex: '',
  about_text: 'Who we are.', photos: [{ url: 'https://cdn.test/host-photos/h1/a.jpg', caption: 'Warm up' }],
  testimonials: [{ quote: 'Brilliant', author: 'Aoife' }], show_past_events: true, show_ratings: true,
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('HostListPageEditor — page extras', () => {
  it('renders the extras from initial and saves a new testimonial and a toggle with the copy', async () => {
    const fetchMock = vi.fn(async (url, init) => jsonRes({ success: true, data: JSON.parse(init.body) }))
    vi.stubGlobal('fetch', fetchMock)
    const onSaved = vi.fn()
    render(<HostListPageEditor initial={INITIAL} previewUrl="https://x/h/acme" onClose={() => {}} onSaved={onSaved} />)
    expect(screen.getByLabelText(/About/).value).toBe('Who we are.')
    expect(screen.getByDisplayValue('Brilliant')).toBeTruthy()
    expect(screen.getByAltText('Warm up')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Add testimonial/ }))
    const quotes = screen.getAllByLabelText(/Quote/)
    fireEvent.change(quotes[1], { target: { value: 'Loved it' } })
    fireEvent.change(screen.getAllByLabelText(/Author/)[1], { target: { value: 'Dan' } })
    fireEvent.click(screen.getByLabelText(/Show ratings/))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    const body = JSON.parse(fetchMock.mock.calls.find(([u]) => u === '/api/host/list-page')[1].body)
    expect(body.testimonials).toEqual([{ quote: 'Brilliant', author: 'Aoife' }, { quote: 'Loved it', author: 'Dan' }])
    expect(body.show_ratings).toBe(false)
    expect(body.show_past_events).toBe(true)
    expect(body.about_text).toBe('Who we are.')
    expect(body.photos).toEqual(INITIAL.photos)
  })
  it('uploads a photo through the host photos route and shows it', async () => {
    const url = 'https://cdn.test/host-photos/h1/new.jpg'
    const fetchMock = vi.fn(async (u) => (String(u).endsWith('/photos') ? jsonRes({ success: true, url, data: { photos: [...INITIAL.photos, { url, caption: null }] } }) : jsonRes({ success: true })))
    vi.stubGlobal('fetch', fetchMock)
    render(<HostListPageEditor initial={INITIAL} previewUrl="https://x/h/acme" onClose={() => {}} onSaved={() => {}} />)
    const input = screen.getByLabelText(/Add photo/)
    fireEvent.change(input, { target: { files: [new File([new Uint8Array(10)], 'new.jpg', { type: 'image/jpeg' })] } })
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === '/api/host/list-page/photos')).toBe(true))
    expect(fetchMock.mock.calls.find(([u]) => u === '/api/host/list-page/photos')[1].method).toBe('POST')
    await waitFor(() => expect(screen.getAllByRole('img').length).toBe(2))
  })
  it('removing a photo calls DELETE with its url', async () => {
    const fetchMock = vi.fn(async () => jsonRes({ success: true, data: { photos: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    render(<HostListPageEditor initial={INITIAL} previewUrl="https://x/h/acme" onClose={() => {}} onSaved={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /Remove photo/ }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [u, init] = fetchMock.mock.calls[0]
    expect(init.method).toBe('DELETE')
    expect(String(u)).toBe(`/api/host/list-page/photos?url=${encodeURIComponent(INITIAL.photos[0].url)}`)
    await waitFor(() => expect(screen.queryByAltText('Warm up')).toBeNull())
  })
})

describe('HostListPageEditor — sections layout', () => {
  const headings = () => screen.getAllByRole('heading').map((h) => h.textContent)
  const FILLED = { ...INITIAL, list_headline: 'Join us', list_button_label: 'Sign me up' }

  it('renders the seven headings in visitor order', () => {
    render(<HostListPageEditor layout="sections" initial={INITIAL} previewUrl="https://x/h/acme" onSaved={() => {}} />)
    expect(headings()).toEqual(['Top of page', 'About you', 'Upcoming events', 'Photos', 'What people say', 'Past events', 'Join the list'])
  })
  it('groups the fields under the right headings', () => {
    render(<HostListPageEditor layout="sections" initial={INITIAL} previewUrl="https://x/h/acme" onSaved={() => {}} />)
    const within = (name) => screen.getByRole('heading', { name }).closest('section')
    const has = (name, el) => expect(within(name).contains(el)).toBe(true)
    has('Top of page', screen.getByLabelText(/^Headline/))
    has('Top of page', screen.getByLabelText(/Intro text/))
    has('Top of page', screen.getByLabelText(/Hero image URL/))
    has('Top of page', screen.getByLabelText(/Accent colour/))
    has('About you', screen.getByLabelText(/About/))
    has('Upcoming events', screen.getByLabelText(/Events headline/))
    has('Upcoming events', screen.getByLabelText(/Events intro/))
    has('Photos', screen.getByLabelText(/Add photo/))
    has('What people say', screen.getByRole('button', { name: /Add testimonial/ }))
    has('What people say', screen.getByLabelText(/Show ratings/))
    has('Past events', screen.getByLabelText(/Show past events/))
    has('Join the list', screen.getByLabelText(/Button label/))
    has('Join the list', screen.getByLabelText(/Success message/))
  })
  it('sends the same PATCH body as the drawer layout for the same edits', async () => {
    const bodies = {}
    for (const layout of ['drawer', 'sections']) {
      const fetchMock = vi.fn(async (url, init) => jsonRes({ success: true, data: JSON.parse(init.body) }))
      vi.stubGlobal('fetch', fetchMock)
      const onSaved = vi.fn()
      render(<HostListPageEditor layout={layout} initial={FILLED} previewUrl="https://x/h/acme" onClose={() => {}} onSaved={onSaved} />)
      fireEvent.change(screen.getByLabelText(/^Headline/), { target: { value: 'New headline' } })
      fireEvent.change(screen.getByLabelText(/About/), { target: { value: 'Changed.' } })
      fireEvent.click(screen.getByLabelText(/Show past events/))
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(onSaved).toHaveBeenCalled())
      bodies[layout] = JSON.parse(fetchMock.mock.calls.find(([u]) => u === '/api/host/list-page')[1].body)
      expect(fetchMock.mock.calls.find(([u]) => u === '/api/host/list-page')[1].method).toBe('PATCH')
      cleanup()
    }
    expect(bodies.sections).toEqual(bodies.drawer)
    expect(bodies.sections.list_headline).toBe('New headline')
    expect(bodies.sections.show_past_events).toBe(false)
  })
  it('has no Cancel button, keeps Save and the Preview link', () => {
    render(<HostListPageEditor layout="sections" initial={INITIAL} previewUrl="https://x/h/acme" onSaved={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
    const preview = screen.getByRole('link', { name: /Preview/ })
    expect(preview.getAttribute('href')).toBe('https://x/h/acme')
    expect(preview.getAttribute('target')).toBe('_blank')
  })
  it('shows "Saved." after a successful save, takes the server values, and clears it on the next edit', async () => {
    const fetchMock = vi.fn(async (url, init) => jsonRes({ success: true, data: { ...JSON.parse(init.body), list_headline: 'Trimmed headline' } }))
    vi.stubGlobal('fetch', fetchMock)
    render(<HostListPageEditor layout="sections" initial={FILLED} previewUrl="https://x/h/acme" onSaved={() => {}} />)
    expect(screen.queryByText('Saved.')).toBeNull()
    fireEvent.change(screen.getByLabelText(/^Headline/), { target: { value: '  Trimmed headline  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByText('Saved.')).toBeTruthy())
    expect(screen.getByLabelText(/^Headline/).value).toBe('Trimmed headline')
    fireEvent.change(screen.getByLabelText(/About/), { target: { value: 'More.' } })
    expect(screen.queryByText('Saved.')).toBeNull()
  })
  it('a failed save shows the error and no "Saved."', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ success: false, error: 'Nope.' }, 400)))
    render(<HostListPageEditor layout="sections" initial={FILLED} previewUrl="https://x/h/acme" onSaved={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByText('Nope.')).toBeTruthy())
    expect(screen.queryByText('Saved.')).toBeNull()
  })
  it('the drawer layout never shows "Saved."', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, init) => jsonRes({ success: true, data: JSON.parse(init.body) })))
    const onSaved = vi.fn()
    render(<HostListPageEditor initial={FILLED} previewUrl="https://x/h/acme" onClose={() => {}} onSaved={onSaved} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(screen.queryByText('Saved.')).toBeNull()
  })
  it('the default drawer layout still has Cancel and no section headings', () => {
    render(<HostListPageEditor initial={INITIAL} previewUrl="https://x/h/acme" onClose={() => {}} onSaved={() => {}} />)
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Top of page' })).toBeNull()
  })
})

