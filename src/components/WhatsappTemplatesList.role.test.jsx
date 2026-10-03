// @vitest-environment jsdom
//
// WATPLROLE.1 — the WhatsApp templates list offers Delete and "Edit &
// resubmit" only with `canManage` (MANAGER_ROLES at the location, computed by
// the page with the routes' rule). The inline group box stays for every
// member: a display_group-only save is open to them. Ids are synthetic.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('@/lib/supabase', () => {
  const channel = { on: () => channel, subscribe: () => channel }
  return { createBrowserClient: () => ({ channel: () => channel, removeChannel: () => {} }) }
})

import WhatsappTemplatesList from './WhatsappTemplatesList.jsx'

const TEMPLATES = [
  { id: 'b0000000-0000-4000-8000-000000000001', name: 'promo_x', status: 'REJECTED', category: 'MARKETING', language: 'en', display_group: null },
  { id: 'b0000000-0000-4000-8000-000000000002', name: 'book_first_visit', status: 'APPROVED', category: 'UTILITY', language: 'en', display_group: null },
]

beforeEach(() => {
  global.fetch = vi.fn(async () => new Response(JSON.stringify({ success: true, templates: TEMPLATES }), { status: 200 }))
})
afterEach(() => cleanup())

describe('WhatsappTemplatesList — controls follow canManage (WATPLROLE.1)', () => {
  it('without canManage: no Delete and no "Edit & resubmit"; the group box is still there', async () => {
    render(<WhatsappTemplatesList locationId="loc-1" />)
    expect(await screen.findByText('promo_x')).toBeTruthy()
    expect(screen.queryAllByTitle('Delete template')).toEqual([])
    expect(screen.queryByText(/Edit & resubmit/)).toBeNull()
    expect(screen.getAllByPlaceholderText('Group…')).toHaveLength(2)
  })

  it('with canManage: Delete on every row, "Edit & resubmit" on the rejected one', async () => {
    render(<WhatsappTemplatesList locationId="loc-1" canManage />)
    expect(await screen.findByText('promo_x')).toBeTruthy()
    expect(screen.getAllByTitle('Delete template')).toHaveLength(2)
    expect(screen.getAllByText(/Edit & resubmit/)).toHaveLength(1)
  })
})
