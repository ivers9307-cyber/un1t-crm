// @vitest-environment jsdom
//
// VOICENOTE.1 — the transcript (or a short note) under a WhatsApp voice note.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import WAMediaContent from './WAMediaContent'

const voice = (o) => ({ id: 'm1', message_type: 'audio', media_mime_type: 'audio/ogg', created_at: new Date().toISOString(), ...o })

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: true, url: 'https://x.test/a.ogg' }) })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('voice note caption', () => {
  it('shows an ok transcript under the player', async () => {
    const { container } = render(<WAMediaContent message={voice({ transcript_status: 'ok', transcript: 'Can I book 7am?', transcript_language: 'en' })} />)
    expect(await screen.findByText('Can I book 7am?')).toBeTruthy()
    expect(container.querySelector('audio')).toBeTruthy()
    expect(screen.queryByText(/Transcribed from/)).toBeNull()
  })
  it('names a language that is not English', async () => {
    render(<WAMediaContent message={voice({ transcript_status: 'ok', transcript: 'Olá', transcript_language: 'por' })} />)
    expect(await screen.findByText('Transcribed from Portuguese')).toBeTruthy()
  })
  it('unclear shows the note and the text', async () => {
    render(<WAMediaContent message={voice({ transcript_status: 'unclear', transcript: 'mumble' })} />)
    expect(await screen.findByText("Couldn't make it out clearly:")).toBeTruthy()
    expect(screen.getByText('mumble')).toBeTruthy()
  })
  it('too_long shows its note; disabled shows nothing', async () => {
    render(<WAMediaContent message={voice({ transcript_status: 'too_long' })} />)
    expect(await screen.findByText('Over 3 minutes, not transcribed')).toBeTruthy()
    cleanup()
    const { container } = render(<WAMediaContent message={voice({ transcript_status: 'disabled' })} />)
    await waitFor(() => expect(container.querySelector('audio')).toBeTruthy())
    expect(container.querySelector('[data-voice-caption]')).toBeNull()
  })
  it('the caption shows even when the audio itself is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })))
    render(<WAMediaContent message={voice({ transcript_status: 'ok', transcript: 'Can I book 7am?' })} />)
    expect(await screen.findByText('[audio unavailable]')).toBeTruthy()
    expect(screen.getByText('Can I book 7am?')).toBeTruthy()
  })
})
