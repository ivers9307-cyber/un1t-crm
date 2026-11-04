// @vitest-environment jsdom
//
// VOICENOTE.1 — the voice-note transcription switch, monthly limit and
// minutes-used line on the usage settings form.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import UsageCapsForm from './UsageCapsForm'

const base = { organizationId: 'org-1', canEdit: true, initialAiCapCents: null, initialEmailCapSends: null, initialOpsEmails: null }

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ success: true, data: {} }) })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Voice notes section', () => {
  it('shows the switch, the limit, minutes used and the vendor line', () => {
    render(<UsageCapsForm {...base} initialVoice={{ enabled: true, capMinutes: 30, usedMinutes: 4 }} />)
    expect(screen.getByLabelText('Transcribe WhatsApp voice notes').checked).toBe(true)
    expect(screen.getByLabelText('Monthly limit (minutes)').value).toBe('30')
    expect(screen.getByText('4 minutes used this month')).toBeTruthy()
    expect(screen.getByText('Voice notes are sent to ElevenLabs to be transcribed.')).toBeTruthy()
  })

  it('saves the switch and the limit with the caps; blank limit = no limit', async () => {
    render(<UsageCapsForm {...base} initialVoice={{ enabled: false, capMinutes: null, usedMinutes: 0 }} />)
    fireEvent.click(screen.getByLabelText('Transcribe WhatsApp voice notes'))
    fireEvent.click(screen.getByRole('button', { name: 'Save caps' }))
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    const sent = JSON.parse(fetch.mock.calls[0][1].body)
    expect(sent).toMatchObject({ voice_transcription_enabled: true, voice_transcription_monthly_cap_minutes: null })
  })

  it('refuses a limit that is not a positive whole number', async () => {
    render(<UsageCapsForm {...base} initialVoice={{ enabled: true, capMinutes: null, usedMinutes: 0 }} />)
    fireEvent.change(screen.getByLabelText('Monthly limit (minutes)'), { target: { value: '0' } })
    // The input's own min/step stop a browser submit; this checks the form's guard behind it.
    fireEvent.submit(screen.getByRole('button', { name: 'Save caps' }).closest('form'))
    expect(await screen.findByText(/Voice note limit must be a positive whole number/)).toBeTruthy()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('unreadable usage shows a dash, not zero; read-only view states the setting', () => {
    render(<UsageCapsForm {...base} initialVoice={{ enabled: true, capMinutes: null, usedMinutes: null }} />)
    expect(screen.getByText('— minutes used this month')).toBeTruthy()
    cleanup()
    render(<UsageCapsForm {...base} canEdit={false} initialVoice={{ enabled: true, capMinutes: 30, usedMinutes: 4 }} />)
    expect(screen.getByText(/Voice notes: on, 30 minutes\/mo, 4 used/)).toBeTruthy()
  })
})
