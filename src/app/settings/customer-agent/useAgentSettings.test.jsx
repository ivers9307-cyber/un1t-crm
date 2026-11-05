// @vitest-environment jsdom
//
// MIASETTINGS.2a — the Mia settings state in one hook: load, edit, the
// unsaved-change list, Discard, Save and the three holds.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, waitFor, act, cleanup } from '@testing-library/react'
import { initialOverridden } from '@/lib/agent/settings-overrides'
import { buildSavePayload, BOOKING_URL_ERROR } from './save-payload'
import { STILLORGAN_GET, HATCH_GET } from './__fixtures__/agent-settings'
import { useAgentSettings } from './useAgentSettings'

const reply = (status, body) => ({ ok: status < 400, status, json: async () => body })
const isSettingsUrl = (url) => String(url) === '/api/settings/customer-agent'
const puts = () => global.fetch.mock.calls.filter(([url, init]) => isSettingsUrl(url) && init?.method === 'PUT')

function mockFetch(getAnswer) {
  global.fetch = vi.fn(async (url, init) => {
    if (isSettingsUrl(url)) {
      if (init?.method === 'PUT') return reply(200, { success: true })
      if (getAnswer instanceof Error) throw getAnswer
      return getAnswer
    }
    return reply(200, { success: true, templates: [] })
  })
}

// Renders the hook; `h.current` is its latest return value.
async function renderHook(props = { canEdit: true }) {
  const h = { current: null }
  function Probe() { h.current = useAgentSettings(props); return null }
  render(<Probe />)
  await waitFor(() => expect(h.current.loading).toBe(false))
  return h
}

afterEach(() => { cleanup(); delete global.fetch })

describe('useAgentSettings', () => {
  it('loads the studio state, with nothing unsaved', async () => {
    mockFetch(reply(200, STILLORGAN_GET))
    const h = await renderHook()
    expect(h.current.loadFailed).toBe(false)
    expect(h.current.settings).toEqual(STILLORGAN_GET.settings)
    expect(h.current.overridden).toEqual(initialOverridden(STILLORGAN_GET.studio))
    expect(h.current.ctx).toEqual({ membershipSourceKey: 'glofox', bookings: true, brand: STILLORGAN_GET.brand, agentName: 'Mia' })
    expect(h.current.dirtyPaths).toEqual([])
    expect(h.current.dirtySections).toEqual(new Set())
    expect(h.current.holds).toEqual([])
  })

  // MIASETTINGS.2c — the header's tags read what is saved, not unsaved edits.
  it('saved is the loaded settings, untouched by an edit, and moves on a save', async () => {
    mockFetch(reply(200, STILLORGAN_GET))
    const h = await renderHook()
    expect(h.current.saved).toEqual(STILLORGAN_GET.settings)
    act(() => { h.current.setField('enabled', false) })
    expect(h.current.saved.enabled).toBe(true)
    // the re-read after the save fails here, so what was sent is what is saved
    global.fetch.mockImplementation(async (url, init) => (init?.method === 'PUT' ? reply(200, { success: true }) : reply(500, { success: false })))
    await act(async () => { await h.current.save() })
    expect(h.current.saved.enabled).toBe(false)
  })

  it('discard restores the loaded settings and overrides', async () => {
    mockFetch(reply(200, STILLORGAN_GET))
    const h = await renderHook()
    act(() => { h.current.setField('tone', 'Brisk') })
    act(() => { h.current.setField('followups.daily_cap', 33) })
    act(() => { h.current.setField('cancellation_form.reason_labels.price', 'Too dear') })
    act(() => { h.current.revertToInherited(['holding_message']) })
    expect(h.current.dirtyPaths).toEqual([
      'cancellation_form.reason_labels.price', 'followups.daily_cap', 'holding_message', 'tone',
    ])
    expect(h.current.dirtySections).toEqual(new Set(['personality', 'followups', 'cancellation', 'handoffs']))
    expect(h.current.overridden).toEqual(['followups.daily_cap', 'tone'])

    act(() => { h.current.discard() })
    expect(h.current.settings).toEqual(STILLORGAN_GET.settings)
    expect(h.current.overridden).toEqual(initialOverridden(STILLORGAN_GET.studio))
    expect(h.current.dirtyPaths).toEqual([])
    expect(h.current.error).toBe(null)
    expect(h.current.serverFieldErrors).toEqual({})
  })

  it('discard after a failed save clears the error and the field errors', async () => {
    mockFetch(reply(200, HATCH_GET))
    const h = await renderHook()
    global.fetch.mockImplementationOnce(async () => reply(400, { success: false, error: 'Invalid', issues: [{ path: 'booking_url', message: 'x' }] }))
    await act(async () => { await h.current.save() })
    expect(h.current.error).toBe('Invalid')
    expect(h.current.serverFieldErrors).toEqual({ booking_url: BOOKING_URL_ERROR })
    act(() => { h.current.discard() })
    expect(h.current.error).toBe(null)
    expect(h.current.serverFieldErrors).toEqual({})
  })

  it('save PUTs buildSavePayload and resets dirtyPaths to []', async () => {
    mockFetch(reply(200, STILLORGAN_GET))
    const h = await renderHook()
    act(() => { h.current.setField('tone', 'Brisk') })
    expect(h.current.dirtyPaths).toEqual(['tone'])
    const expected = buildSavePayload(h.current.settings, h.current.overridden)
    await act(async () => { await h.current.save() })
    expect(puts()).toHaveLength(1)
    expect(JSON.parse(puts()[0][1].body)).toEqual(expected)
    expect(h.current.savedAt).not.toBe(null)
    expect(h.current.saving).toBe(false)
    expect(h.current.dirtyPaths).toEqual([])
  })

  it('a save whose re-read fails still counts what was saved as saved', async () => {
    mockFetch(reply(200, STILLORGAN_GET))
    const h = await renderHook()
    act(() => { h.current.setField('tone', 'Brisk') })
    global.fetch.mockImplementation(async (url, init) => (init?.method === 'PUT'
      ? reply(200, { success: true })
      : reply(500, { success: false })))
    await act(async () => { await h.current.save() })
    expect(h.current.settings.tone).toBe('Brisk')
    expect(h.current.dirtyPaths).toEqual([])
  })

  it('holds name the section', async () => {
    mockFetch(reply(200, HATCH_GET))
    const h = await renderHook()
    act(() => { h.current.setQuietHours('start', '21:00') })
    expect(h.current.holds).toEqual([{ section: 'overview', message: 'Set both quiet hours times' }])
    act(() => { h.current.setField('booking_url', 'not a link') })
    act(() => { h.current.setField('trial_done.delay_hours', 99) })
    expect(h.current.holds).toEqual([
      { section: 'overview', message: 'Set both quiet hours times' },
      { section: 'bookings', message: BOOKING_URL_ERROR },
      { section: 'followups', message: 'A whole number from 1 to 72.' },
    ])
    act(() => { h.current.setQuietHours('end', '07:00') })
    expect(h.current.holds.map((x) => x.section)).toEqual(['bookings', 'followups'])
  })

  it('no booking or trial hold where those fields do not show (a Glofox studio that books)', async () => {
    mockFetch(reply(200, STILLORGAN_GET))
    const h = await renderHook()
    act(() => { h.current.setField('booking_url', 'not a link') })
    act(() => { h.current.setField('trial_done.delay_hours', 99) })
    expect(h.current.holds).toEqual([])
  })

  it('a failed read leaves loadFailed true and save unavailable', async () => {
    mockFetch(reply(500, { success: false, code: 'settings_unreadable' }))
    const h = await renderHook()
    expect(h.current.loadFailed).toBe(true)
    expect(h.current.settings).toBe(null)
    expect(h.current.dirtyPaths).toEqual([])
    await act(async () => { await h.current.save() })
    expect(puts()).toHaveLength(0)
  })

  it('a network error on the read is the same', async () => {
    mockFetch(new TypeError('Failed to fetch'))
    const h = await renderHook()
    expect(h.current.loadFailed).toBe(true)
    await act(async () => { await h.current.save() })
    expect(puts()).toHaveLength(0)
  })

  it('reload re-reads after a failure', async () => {
    mockFetch(reply(500, { success: false }))
    const h = await renderHook()
    expect(h.current.loadFailed).toBe(true)
    mockFetch(reply(200, HATCH_GET))
    await act(async () => { await h.current.reload() })
    expect(h.current.loadFailed).toBe(false)
    expect(h.current.membershipSourceKey).toBe('un1t_online')
  })

  it('refreshInherited shows the new org value where the studio follows it, and keeps unsaved edits dirty', async () => {
    mockFetch(reply(200, HATCH_GET))
    const h = await renderHook()
    act(() => { h.current.setField('extra_rules', 'My rule') })
    const orgTone = { ...HATCH_GET, org: { tone: 'Org tone', extra_rules: 'Org rule' }, inherited: { ...HATCH_GET.inherited, tone: 'Org tone', extra_rules: 'Org rule' } }
    mockFetch(reply(200, orgTone))
    await act(async () => { await h.current.refreshInherited() })
    expect(h.current.settings.tone).toBe('Org tone')
    expect(h.current.settings.extra_rules).toBe('My rule')
    expect(h.current.dirtyPaths).toEqual(['extra_rules'])
    act(() => { h.current.discard() })
    expect(h.current.settings.tone).toBe('Org tone')
    expect(h.current.settings.extra_rules).toBe('Org rule')
    expect(h.current.dirtyPaths).toEqual([])
  })

  it('trial finisher and cancellation edits take no override; an inheritable field does', async () => {
    mockFetch(reply(200, HATCH_GET))
    const h = await renderHook()
    act(() => { h.current.setField('trial_done.opener_template', 'x_y') })
    act(() => { h.current.setField('cancellation_form.form_intro', 'Bye') })
    const loaded = initialOverridden(HATCH_GET.studio)
    expect(h.current.overridden).toEqual(loaded)
    act(() => { h.current.setField('first_class_checkin.template_name', 'tpl') })
    expect(h.current.overridden).toEqual([...loaded, 'first_class_checkin.template_name'].sort())
  })
})
