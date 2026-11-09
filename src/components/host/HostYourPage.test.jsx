// @vitest-environment jsdom
// HOSTPORTAL.1 — /host/page client component: both links with their own QR
// hrefs, copy-link feedback, and the editor wired in the sections layout.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor, within } from '@testing-library/react'

vi.mock('@/lib/landing-media-upload', async (orig) => ({ ...(await orig()), compressImageForUpload: vi.fn(async (f) => f) }))
const { default: HostYourPage } = await import('./HostYourPage.jsx')

const COPY = {
  list_headline: 'Join us', list_blurb: '', list_button_label: '', list_success_message: '', events_headline: '', events_blurb: '',
  hero_image_url: '', accent_hex: '', about_text: '', photos: [], testimonials: [], show_past_events: true, show_ratings: true,
}
const URL_ = 'https://crm.test/h/acme'
const JOIN = 'https://crm.test/h/acme/join'
const props = { url: URL_, joinUrl: JOIN, signupCount: 3, copyValues: COPY }

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('HostYourPage', () => {
  it('shows both links with their own Open and QR hrefs', () => {
    render(<HostYourPage {...props} />)
    const main = screen.getByTestId('your-page-link')
    expect(within(main).getByText(URL_)).toBeTruthy()
    expect(within(main).getByRole('link', { name: 'Open' }).getAttribute('href')).toBe(URL_)
    expect(within(main).getByRole('link', { name: 'QR code' }).getAttribute('href')).toBe('/api/host/signup-qr')
    const form = screen.getByTestId('signup-form-link')
    expect(within(form).getByText('Signup form only')).toBeTruthy()
    expect(within(form).getByText(JOIN)).toBeTruthy()
    expect(within(form).getByRole('link', { name: 'Open' }).getAttribute('href')).toBe(JOIN)
    expect(within(form).getByRole('link', { name: 'QR code' }).getAttribute('href')).toBe('/api/host/signup-qr?page=join')
    expect(screen.getByText('Just the form, for bios and stories.')).toBeTruthy()
  })
  it('shows the signup count with singular and plural', () => {
    const { unmount } = render(<HostYourPage {...props} signupCount={3} />)
    expect(screen.getByText(/3 list signups/)).toBeTruthy()
    unmount()
    render(<HostYourPage {...props} signupCount={1} />)
    expect(screen.getByText(/1 list signup(?!s)/)).toBeTruthy()
  })
  it('Copy link writes that link to the clipboard and says Copied', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    render(<HostYourPage {...props} />)
    const form = screen.getByTestId('signup-form-link')
    fireEvent.click(within(form).getByRole('button', { name: 'Copy link' }))
    await waitFor(() => expect(within(form).getByRole('button', { name: 'Copied' })).toBeTruthy())
    expect(writeText).toHaveBeenCalledWith(JOIN)
    expect(within(screen.getByTestId('your-page-link')).getByRole('button', { name: 'Copy link' })).toBeTruthy()
  })
  it('renders the editor in sections layout (no Cancel) and a save updates its copy state', async () => {
    const fetchMock = vi.fn(async (url, init) => ({ ok: true, status: 200, json: async () => ({ success: true, data: JSON.parse(init.body) }) }))
    vi.stubGlobal('fetch', fetchMock)
    render(<HostYourPage {...props} />)
    expect(screen.getByRole('heading', { name: 'Top of page' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    expect(screen.getByRole('link', { name: /Preview/ }).getAttribute('href')).toBe(URL_)
    fireEvent.change(screen.getByLabelText(/^Headline/), { target: { value: 'Changed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    // editor stays mounted after a save (no drawer to close) and keeps the saved value
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy())
    expect(screen.getByLabelText(/^Headline/).value).toBe('Changed')
  })

  describe('preview', () => {
    const PATH_URL = 'https://tenant.test/h/demo-host'
    const mockMedia = (matches) => {
      const listeners = new Set()
      const mql = {
        matches,
        addEventListener: (_t, fn) => listeners.add(fn),
        removeEventListener: (_t, fn) => listeners.delete(fn),
      }
      vi.stubGlobal('matchMedia', vi.fn(() => mql))
      return { mql, change: (m) => { mql.matches = m; listeners.forEach((fn) => fn({ matches: m })) } }
    }
    const withUrl = (url) => ({ ...props, url })

    it('renders an iframe of the page\'s own path with a title', () => {
      mockMedia(true)
      render(<HostYourPage {...withUrl(PATH_URL)} />)
      const frame = screen.getByTitle('Preview of your public page')
      expect(frame.tagName).toBe('IFRAME')
      expect(frame.getAttribute('src')).toBe('/h/demo-host')
      expect(frame.getAttribute('loading')).toBe('lazy')
      expect(screen.getByText('This shows your saved page. Save to update it.')).toBeTruthy()
      expect(document.querySelectorAll('iframe').length).toBe(1)
    })
    it('reloads the preview after a successful save', async () => {
      mockMedia(true)
      vi.stubGlobal('fetch', vi.fn(async (_u, init) => ({ ok: true, status: 200, json: async () => ({ success: true, data: JSON.parse(init.body) }) })))
      render(<HostYourPage {...withUrl(PATH_URL)} />)
      const before = screen.getByTitle('Preview of your public page')
      fireEvent.change(screen.getByLabelText(/^Headline/), { target: { value: 'Changed' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(screen.getByTitle('Preview of your public page')).not.toBe(before))
      expect(before.isConnected).toBe(false)
      expect(document.querySelectorAll('iframe').length).toBe(1)
    })
    it('renders no preview when the url is not a /h/ page', () => {
      mockMedia(true)
      for (const bad of ['https://tenant.test/', 'https://tenant.test/h/', 'https://tenant.test/h/a/join', 'not a url', '']) {
        const { unmount } = render(<HostYourPage {...withUrl(bad)} />)
        expect(document.querySelector('iframe')).toBeNull()
        expect(screen.queryByRole('button', { name: /preview/i })).toBeNull()
        unmount()
      }
    })
    it('keeps the preview closed behind Show preview until asked, then toggles', () => {
      mockMedia(false)
      render(<HostYourPage {...withUrl(PATH_URL)} />)
      const toggle = screen.getByRole('button', { name: 'Show preview' })
      expect(toggle.getAttribute('type')).toBe('button')
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      expect(toggle.className).toContain('lg:hidden')
      expect(document.getElementById(toggle.getAttribute('aria-controls'))).toBeTruthy()
      expect(document.querySelector('iframe')).toBeNull()
      fireEvent.click(toggle)
      const open = screen.getByRole('button', { name: 'Hide preview' })
      expect(open.getAttribute('aria-expanded')).toBe('true')
      expect(document.querySelectorAll('iframe').length).toBe(1)
      expect(screen.getByTitle('Preview of your public page').getAttribute('src')).toBe('/h/demo-host')
      fireEvent.click(open)
      expect(document.querySelector('iframe')).toBeNull()
      expect(screen.getByRole('button', { name: 'Show preview' }).getAttribute('aria-expanded')).toBe('false')
    })
    it('shows the preview without the toggle opened on a wide screen, and follows media changes', async () => {
      const media = mockMedia(true)
      render(<HostYourPage {...withUrl(PATH_URL)} />)
      expect(document.querySelectorAll('iframe').length).toBe(1)
      const { act } = await import('@testing-library/react')
      act(() => media.change(false))
      expect(document.querySelector('iframe')).toBeNull()
      act(() => media.change(true))
      expect(document.querySelectorAll('iframe').length).toBe(1)
    })
    it('does not crash and starts closed when matchMedia is unavailable', () => {
      vi.stubGlobal('matchMedia', undefined)
      render(<HostYourPage {...withUrl(PATH_URL)} />)
      expect(document.querySelector('iframe')).toBeNull()
      expect(screen.getByRole('button', { name: 'Show preview' })).toBeTruthy()
    })
  })
})
