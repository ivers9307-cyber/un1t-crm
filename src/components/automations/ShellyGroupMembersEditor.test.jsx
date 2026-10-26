// @vitest-environment jsdom
//
// SHELLYGROUPS.6 — choosing a group's devices. The one promise this editor
// must make out loud: joining a group CLEARS the device's own schedule and
// manual switch (the PUT route's rule 2), so the operator is told before Save.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import ShellyGroupMembersEditor, { JOIN_WARNING } from './ShellyGroupMembersEditor.jsx'

const group = { id: 'g1', name: 'Studio lights', device_ids: ['d1'] }
const devices = [
  { id: 'd1', name: 'Front light', group_id: 'g1', device_id: 'aa01', model: 'RGBW PM' },
  { id: 'd2', name: 'Back light', group_id: null, device_id: 'aa02', model: 'RGBW PM' },
  { id: 'd3', name: 'Fan', group_id: 'g2', device_id: 'aa03', model: 'Plug S' },
]
const groups = [group, { id: 'g2', name: 'Fans', device_ids: ['d3'] }]

const originalFetch = global.fetch
beforeEach(() => { global.fetch = vi.fn() })
afterEach(() => { cleanup(); global.fetch = originalFetch })

const answer = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json })

describe('ShellyGroupMembersEditor', () => {
  it('ticks the current members and names another group a device would leave', () => {
    render(<ShellyGroupMembersEditor group={group} devices={devices} groups={groups} onSaved={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByLabelText(/Front light/).checked).toBe(true)
    expect(screen.getByLabelText(/Back light/).checked).toBe(false)
    expect(screen.getByText('In Fans')).toBeTruthy()
  })

  it('warns "These plugs will follow this group\'s schedule" before saving a joiner', async () => {
    global.fetch.mockResolvedValue(answer(200, { success: true, device_ids: ['d1', 'd2'] }))
    const onSaved = vi.fn()
    render(<ShellyGroupMembersEditor group={group} devices={devices} groups={groups} onSaved={onSaved} onCancel={vi.fn()} />)
    expect(screen.queryByText(/These plugs will follow this group's schedule/)).toBeNull()
    fireEvent.click(screen.getByLabelText(/Back light/))
    // Shown BEFORE anything is sent.
    expect(screen.getByText(/These plugs will follow this group's schedule/)).toBeTruthy()
    expect(JOIN_WARNING).toMatch(/^These plugs will follow this group's schedule/)
    expect(global.fetch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save devices' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    const [url, init] = global.fetch.mock.calls[0]
    expect(url).toBe('/api/shelly/groups/g1/devices')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body)).toEqual({ device_ids: ['d1', 'd2'] })
  })

  it('says nothing about joining when a device only leaves', async () => {
    global.fetch.mockResolvedValue(answer(200, { success: true, device_ids: [] }))
    render(<ShellyGroupMembersEditor group={group} devices={devices} groups={groups} onSaved={vi.fn()} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByLabelText(/Front light/))
    expect(screen.queryByText(/These plugs will follow/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save devices' }))
    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({ device_ids: [] })
  })

  it('Save is dead until the membership changes', () => {
    render(<ShellyGroupMembersEditor group={group} devices={devices} groups={groups} onSaved={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Save devices' }).disabled).toBe(true)
  })

  it('shows the route\'s sentence on a refusal and stays open', async () => {
    global.fetch.mockResolvedValue(answer(500, { success: false, error: 'Added the new devices, but could not remove the others — reload and try again' }))
    const onSaved = vi.fn()
    render(<ShellyGroupMembersEditor group={group} devices={devices} groups={groups} onSaved={onSaved} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByLabelText(/Back light/))
    fireEvent.click(screen.getByRole('button', { name: 'Save devices' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('could not remove the others'))
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('Cancel sends nothing', () => {
    const onCancel = vi.fn()
    render(<ShellyGroupMembersEditor group={group} devices={devices} groups={groups} onSaved={vi.fn()} onCancel={onCancel} />)
    fireEvent.click(screen.getByLabelText(/Back light/))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
