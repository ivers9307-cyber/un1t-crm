// @vitest-environment jsdom
//
// TPLCLONE.1 — the "copy templates from another studio" dialog. It previews
// with a dry run of the real route, copies only what stays ticked, copies the
// weekdays only when asked, and hands the route's answer back to the template
// manager.

import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react'

import CopyTemplatesModal from './CopyTemplatesModal'

const TARGET = { id: 'studio-b', name: 'Studio B' }
const ONE_SOURCE = [{ id: 'studio-a', name: 'Studio A' }]
const WEEKDAYS_BOX = /Also copy the weekdays these shifts repeat on/
const PREVIEW = {
  dry_run: true,
  created: [
    { source_id: 'src-1', name: 'Early', start_time: '06:00:00', end_time: '09:00:00', days_of_week: [], source_days_of_week: ['mon', 'wed'] },
    { source_id: 'src-2', name: 'Late', start_time: '18:00:00', end_time: '21:00:00', days_of_week: [], source_days_of_week: [] },
  ],
  skipped: [{ source_id: 'src-3', name: 'Open gym', reason: 'name_exists' }],
  generated_blocks: 0,
}
const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body })

function mockRoute(handler) {
  global.fetch = vi.fn(async (url, opts) => handler(JSON.parse(opts.body), String(url)))
}
const bodies = () => global.fetch.mock.calls.map(([, o]) => JSON.parse(o.body))

async function open(props = {}) {
  const onDone = vi.fn()
  const onClose = vi.fn()
  await act(async () => {
    render(<CopyTemplatesModal sources={ONE_SOURCE} target={TARGET} onDone={onDone} onClose={onClose} {...props} />)
  })
  return { onDone, onClose }
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('CopyTemplatesModal (TPLCLONE.1)', () => {
  it('previews the only sibling studio with a dry run, and lists what would be created and skipped', async () => {
    mockRoute(() => reply({ success: true, data: PREVIEW }))
    await open()
    await screen.findByText('Early')
    expect(global.fetch.mock.calls[0][0]).toBe('/api/schedule/templates/clone')
    expect(bodies()[0]).toEqual({ from_location_id: 'studio-a', to_location_id: 'studio-b', dry_run: true })
    expect(screen.getByText('Late')).toBeTruthy()
    expect(screen.getByText('Open gym')).toBeTruthy()
    expect(screen.getByText(/a template with this name is already here/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy 2 templates' })).toBeTruthy()
  })

  it('copies only the ticked templates, without weekdays by default, and hands the answer back', async () => {
    mockRoute((b) => (b.dry_run
      ? reply({ success: true, data: PREVIEW })
      : reply({ success: true, data: { dry_run: false, created: [{ id: 'new-1', ...PREVIEW.created[0] }], skipped: [], generated_blocks: 0 } }, 201)))
    const { onDone } = await open()
    await screen.findByText('Early')
    expect(screen.getByRole('checkbox', { name: WEEKDAYS_BOX }).checked).toBe(false)
    fireEvent.click(screen.getByRole('checkbox', { name: /Late/ }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy 1 template' })) })
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(bodies()[1]).toEqual({ from_location_id: 'studio-a', to_location_id: 'studio-b', template_ids: ['src-1'], copy_weekdays: false })
    expect(onDone.mock.calls[0][0]).toMatchObject({
      created: [{ name: 'Early' }], generated_blocks: 0, fromName: 'Studio A', warning: null,
    })
  })

  it('by default shows the copies as one-offs, and explains what copying the weekdays would do', async () => {
    mockRoute(() => reply({ success: true, data: PREVIEW }))
    await open()
    await screen.findByText('Early')
    expect(screen.getByText(/One-off \(Mon, Wed at Studio A\)/)).toBeTruthy()
    expect(screen.getByText(/fills the next eight weeks at Studio B with shifts to staff/)).toBeTruthy()
    // Nothing is going on the calendar, so no calendar warning.
    expect(screen.queryByText(/on set weekdays/)).toBeNull()
  })

  it('ticking "copy the weekdays" sends copy_weekdays: true and warns about the calendar', async () => {
    mockRoute((b) => (b.dry_run
      ? reply({ success: true, data: PREVIEW })
      : reply({ success: true, data: { dry_run: false, created: [], skipped: [], generated_blocks: 16 } }, 201)))
    const { onDone } = await open()
    await screen.findByText('Early')
    fireEvent.click(screen.getByRole('checkbox', { name: WEEKDAYS_BOX }))
    expect(screen.getByText(/Mon, Wed/)).toBeTruthy()
    expect(screen.queryByText(/One-off \(/)).toBeNull()
    expect(screen.getByText(/1 of these runs on set weekdays/)).toBeTruthy()
    expect(screen.getByText(/roster alerts/)).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy 2 templates' })) })
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(bodies()[1]).toMatchObject({ template_ids: ['src-1', 'src-2'], copy_weekdays: true })
  })

  it('with weekdays ticked, the calendar warning follows the templates still ticked', async () => {
    mockRoute(() => reply({ success: true, data: PREVIEW }))
    await open()
    await screen.findByText('Early')
    fireEvent.click(screen.getByRole('checkbox', { name: WEEKDAYS_BOX }))
    expect(screen.getByText(/next 8 weeks/)).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: /Early/ }))
    expect(screen.queryByText(/on set weekdays/)).toBeNull()
  })

  it('offers no weekdays choice when nothing being copied repeats on weekdays', async () => {
    mockRoute(() => reply({ success: true, data: { ...PREVIEW, created: [PREVIEW.created[1]] } }))
    await open()
    await screen.findByText('Late')
    expect(screen.queryByRole('checkbox', { name: WEEKDAYS_BOX })).toBeNull()
  })

  it('shows the route\'s refusal and offers no copy', async () => {
    mockRoute(() => reply({ success: false, error: 'Templates can only be copied between studios in the same organisation.' }, 403))
    await open()
    expect(await screen.findByText('Templates can only be copied between studios in the same organisation.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy templates' }).disabled).toBe(true)
  })

  it('says so when there is nothing to copy', async () => {
    mockRoute(() => reply({ success: true, data: { dry_run: true, created: [], skipped: PREVIEW.skipped, generated_blocks: 0 } }))
    await open()
    expect(await screen.findByText(/Nothing to copy/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy templates' }).disabled).toBe(true)
  })

  it('says the source has no active templates, rather than blaming names, when there is nothing at all', async () => {
    mockRoute(() => reply({ success: true, data: { dry_run: true, created: [], skipped: [], generated_blocks: 0 } }))
    await open()
    expect(await screen.findByText('No active templates at Studio A.')).toBeTruthy()
    expect(screen.queryByText(/already has a template of the same name/)).toBeNull()
  })

  it('titles a failed preview as a read, not a copy', async () => {
    mockRoute(() => reply({ success: false, error: 'Could not read the templates; nothing was copied.' }, 500))
    await open()
    await screen.findByText('Could not read the templates; nothing was copied.')
    expect(screen.getByText('Could not read templates')).toBeTruthy()
    expect(screen.queryByText('Could not copy templates')).toBeNull()
  })

  it('hides the weekdays choice once every template with weekdays is unticked', async () => {
    mockRoute(() => reply({ success: true, data: PREVIEW }))
    await open()
    await screen.findByText('Early')
    expect(screen.getByRole('checkbox', { name: WEEKDAYS_BOX })).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: /Early/ }))
    expect(screen.queryByRole('checkbox', { name: WEEKDAYS_BOX })).toBeNull()
  })

  it('locks the studio choice while a copy is in flight', async () => {
    mockRoute((b) => (b.dry_run ? reply({ success: true, data: PREVIEW }) : new Promise(() => {})))
    await open({ sources: [{ id: 'studio-a', name: 'Studio A' }, { id: 'studio-c', name: 'Studio C' }] })
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Copy from'), { target: { value: 'studio-c' } })
    })
    await screen.findByText('Early')
    expect(screen.getByLabelText('Copy from').disabled).toBe(false)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy 2 templates' })) })
    expect(screen.getByRole('button', { name: 'Copying…' })).toBeTruthy()
    expect(screen.getByLabelText('Copy from').disabled).toBe(true)
  })

  it('with two possible studios, asks first and previews the one chosen', async () => {
    mockRoute(() => reply({ success: true, data: PREVIEW }))
    await open({ sources: [{ id: 'studio-a', name: 'Studio A' }, { id: 'studio-c', name: 'Studio C' }] })
    expect(global.fetch).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Copy from'), { target: { value: 'studio-c' } })
    })
    await screen.findByText('Early')
    expect(bodies()[0]).toMatchObject({ from_location_id: 'studio-c', dry_run: true })
  })
})
