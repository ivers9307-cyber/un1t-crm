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
})
