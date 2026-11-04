// MIASETTINGS.1a — test harness for the Mia settings page: mounts the editor
// over a mocked fetch, saves, reads the PUT, and edits a field by its label.
import { vi, expect } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import CustomerAgentClient from '../CustomerAgentClient.jsx'
import { SECTION_LABELS } from './agent-settings'

const reply = (status, body) => ({ ok: status < 400, status, json: async () => body })
const isSettingsUrl = (url) => String(url).startsWith('/api/settings/customer-agent')
const putCalls = () => global.fetch.mock.calls.filter(([url, init]) => isSettingsUrl(url) && init?.method === 'PUT')

export async function renderEditor(getBody, props = {}) {
  global.fetch = vi.fn(async (url, init) => {
    if (isSettingsUrl(url)) return init?.method === 'PUT' ? reply(200, { success: true }) : reply(200, getBody)
    if (String(url).startsWith('/api/agent/knowledge')) return reply(200, { success: true, entries: [] })
    return reply(200, { success: true, templates: [] })
  })
  const out = render(<CustomerAgentClient canEdit {...props} />)
  await waitFor(() => expect(screen.getAllByRole('button', { name: /^Save( settings)?$/ }).length).toBeGreaterThan(0))
  return out
}

export function lastPutBody() {
  const calls = putCalls()
  return calls.length ? JSON.parse(calls[calls.length - 1][1].body) : undefined
}

export async function saveNow() {
  const before = putCalls().length
  fireEvent.click(screen.getAllByRole('button', { name: /^Save( settings)?$/ })[0])
  await waitFor(() => expect(putCalls().length).toBe(before + 1))
}

// Type into the field under `label`. Once the page has a section menu, its item
// for the field's section is clicked first; until then it edits in place.
export async function editByLabel(label, value, { section } = {}) {
  const menuName = section && SECTION_LABELS[section]
  if (menuName) {
    const items = ['tab', 'menuitem', 'link', 'button']
      .flatMap((role) => screen.queryAllByRole(role, { name: menuName }))
    if (items.length) fireEvent.click(items[0])
  }
  const labelEl = (await screen.findAllByText(label, { selector: 'label' }))[0]
  let node = labelEl.parentElement
  let field = null
  while (node && !field) {
    field = node.querySelector('input:not([type="checkbox"]), textarea, select')
    node = node.parentElement
  }
  if (!field) throw new Error(`no field found under label "${label}"`)
  fireEvent.change(field, { target: { value } })
}
