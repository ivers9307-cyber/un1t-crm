// @vitest-environment jsdom
//
// MEDIALIB.1 — the "Choose existing" picker: it reads the media library for
// its kind when opened, shows each item with the page it came from and its
// date, hands the chosen item to onPick (then closes), and reports an
// unreadable library or an empty one in words. The hero toolbar applies a
// pick through the same setter an upload uses (second describe).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

vi.mock('@/lib/landing-media-upload', () => ({ uploadLandingMedia: vi.fn() }))

import MediaPicker, { formatMediaSize } from './MediaPicker.jsx'
import HeroMediaTools from './HeroMediaTools.jsx'

const ITEMS = [
  { url: 'https://cdn/pages/p1/coach.mp4', path: 'pages/p1/coach.mp4', name: 'coach.mp4', kind: 'video', size: 12 * 1024 * 1024, created_at: '2026-10-25T10:00:00Z', page_id: 'p1', page_title: 'The 50+ Club', location_id: null, poster_url: 'https://cdn/pages/p1/poster.jpg' },
  { url: 'https://cdn/legacy/still/hero.mp4', path: 'landing-page/still/hero.mp4', name: 'hero.mp4', kind: 'video', size: 4096, created_at: '2026-09-01T10:00:00Z', page_id: 'ps', page_title: 'UN1T Stillorgan', location_id: 'still', poster_url: null },
]

let fetchMock
beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { items: ITEMS } }) }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('MediaPicker', () => {
  it('fetches its kind when opened, lists each item with its page and date, and hands the pick back then closes', async () => {
    const onPick = vi.fn()
    const onClose = vi.fn()
    render(<MediaPicker open kind="video" onPick={onPick} onClose={onClose} />)
    await waitFor(() => expect(screen.getByText('coach.mp4')).toBeTruthy())
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/landing-pages/media?kind=video')
    expect(screen.getByText('The 50+ Club')).toBeTruthy()
    expect(screen.getByText('UN1T Stillorgan')).toBeTruthy()
    expect(screen.getByText('25 Oct 2026 · 12 MB')).toBeTruthy()

    fireEvent.click(screen.getByTitle('coach.mp4'))
    expect(onPick).toHaveBeenCalledWith(ITEMS[0])
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not fetch while closed; says so when the library is unreadable or empty', async () => {
    const { rerender } = render(<MediaPicker open={false} kind="image" onPick={() => {}} onClose={() => {}} />)
    expect(fetchMock).not.toHaveBeenCalled()

    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ success: false, error: 'unavailable' }) })
    rerender(<MediaPicker open kind="image" onPick={() => {}} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('The media library could not be read. Try again.')).toBeTruthy())
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/landing-pages/media?kind=image')

    cleanup()
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, data: { items: [] } }) })
    render(<MediaPicker open kind="image" onPick={() => {}} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/No images uploaded yet/)).toBeTruthy())
  })

  it('formats sizes for people', () => {
    expect(formatMediaSize(0)).toBe('')
    expect(formatMediaSize(4096)).toBe('4 KB')
    expect(formatMediaSize(1.5 * 1024 * 1024)).toBe('1.5 MB')
    expect(formatMediaSize(48 * 1024 * 1024)).toBe('48 MB')
  })
})

describe('HeroMediaTools: Choose existing', () => {
  it('applies a chosen video through onChangeVideo and a chosen image through onChangeImage, exactly as an upload would', async () => {
    const onChangeVideo = vi.fn()
    const onChangeImage = vi.fn()
    render(<HeroMediaTools pageId="p-1" onChangeImage={onChangeImage} onChangeVideo={onChangeVideo} />)
    const [chooseImage, chooseVideo] = screen.getAllByRole('button', { name: 'Choose existing' })
    expect(chooseImage.title).toMatch(/image/)
    expect(chooseVideo.title).toMatch(/video/)

    fireEvent.click(chooseVideo)
    await waitFor(() => expect(screen.getByText('coach.mp4')).toBeTruthy())
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/landing-pages/media?kind=video')
    fireEvent.click(screen.getByTitle('hero.mp4'))
    expect(onChangeVideo).toHaveBeenCalledWith('https://cdn/legacy/still/hero.mp4')
    expect(onChangeImage).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByText('coach.mp4')).toBeNull())

    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, data: { items: [{ ...ITEMS[0], url: 'https://cdn/pages/p1/still.jpg', name: 'still.jpg', kind: 'image', poster_url: null }] } }) })
    fireEvent.click(chooseImage)
    await waitFor(() => expect(screen.getByText('still.jpg')).toBeTruthy())
    expect(String(fetchMock.mock.calls[1][0])).toBe('/api/landing-pages/media?kind=image')
    fireEvent.click(screen.getByTitle('still.jpg'))
    expect(onChangeImage).toHaveBeenCalledWith('https://cdn/pages/p1/still.jpg')
  })

  it('offers no Choose existing without a page or studio to list for', () => {
    render(<HeroMediaTools onChangeImage={() => {}} onChangeVideo={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Choose existing' })).toBeNull()
  })
})
