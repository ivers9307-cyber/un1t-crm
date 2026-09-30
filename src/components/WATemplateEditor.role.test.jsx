// @vitest-environment jsdom
//
// WATPLROLE.1 — the WhatsApp template editor offers Submit / Update, Delete
// and "Edit & resubmit" only with `canManage` (MANAGER_ROLES at the
// template's location, computed by the page with the routes' rule). Without
// it the rejected template's fields are read-only, a note says who can act,
// and the display group (a membership-level save) is still editable.
// Ids are synthetic.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/communications/templates/whatsapp/t1',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/lib/supabase', () => ({ createBrowserClient: () => ({}) }))

import WATemplateEditor from './WATemplateEditor.jsx'

const REJECTED = {
  id: 'b0000000-0000-4000-8000-000000000001',
  name: 'promo_x',
  status: 'REJECTED',
  rejection_reason: 'INVALID_FORMAT',
  category: 'MARKETING',
  language: 'en',
  display_group: 'Offers',
  components: [{ type: 'BODY', text: 'Hi there' }],
}
const NOTE = /Only a manager, head coach, owner or master at this studio/

beforeEach(() => {
  global.fetch = vi.fn(async () => new Response(JSON.stringify({ success: true, templates: [] }), { status: 200 }))
})
afterEach(() => cleanup())

describe('WATemplateEditor — controls follow canManage (WATPLROLE.1)', () => {
  it('a rejected template without canManage: no Update, Delete or resubmit; fields read-only; the group stays editable', () => {
    render(<WATemplateEditor template={REJECTED} locationId="loc-1" userId="u1" />)
    expect(screen.queryByRole('button', { name: /Update/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Edit & resubmit/ })).toBeNull()
    expect(screen.getByDisplayValue('promo_x').disabled).toBe(true)
    expect(screen.getByDisplayValue('Offers').disabled).toBe(false)
    expect(screen.getByText(NOTE)).toBeTruthy()
  })

  it('a rejected or paused template without canManage still offers the appeal link at Meta (parity with the list)', () => {
    for (const status of ['REJECTED', 'PAUSED']) {
      render(<WATemplateEditor template={{ ...REJECTED, status }} locationId="loc-1" userId="u1" />)
      expect(screen.getByRole('link', { name: /Appeal in WhatsApp Manager/ })).toBeTruthy()
      cleanup()
    }
    render(<WATemplateEditor template={{ ...REJECTED, status: 'APPROVED', rejection_reason: null }} locationId="loc-1" userId="u1" />)
    expect(screen.queryByRole('link', { name: /Appeal in WhatsApp Manager/ })).toBeNull()
  })

  it('a rejected template with canManage: Delete and "Edit & resubmit" offered, fields editable, no note', () => {
    render(<WATemplateEditor template={REJECTED} locationId="loc-1" userId="u1" canManage />)
    expect(screen.getByRole('button', { name: /Delete/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Edit & resubmit/ })).toBeTruthy()
    expect(screen.getByRole('link', { name: /Appeal in WhatsApp Manager/ })).toBeTruthy()
    expect(screen.getByDisplayValue('promo_x').disabled).toBe(false)
    expect(screen.queryByText(NOTE)).toBeNull()
  })

  it('a new template: "Submit to Meta" only with canManage', () => {
    render(<WATemplateEditor template={null} locationId="loc-1" userId="u1" canManage />)
    expect(screen.getByRole('button', { name: /Submit to Meta/ })).toBeTruthy()
    cleanup()
    render(<WATemplateEditor template={null} locationId="loc-1" userId="u1" />)
    expect(screen.queryByRole('button', { name: /Submit to Meta/ })).toBeNull()
  })
})

// WATPLPUT.1 — the editor's "submitted" lock is the PUT route's
// (isTemplateSubmitted): a Meta id counts even if the status still reads
// 'draft', so Update is never offered where the route answers 409.
describe('WATemplateEditor — the lock is the route\'s (WATPLPUT.1)', () => {
  it('a Meta id on a row still reading draft: submitted, so Update is disabled and the fields read-only', () => {
    render(<WATemplateEditor template={{ ...REJECTED, status: 'draft', rejection_reason: null, meta_template_id: 'meta-1' }} locationId="loc-1" userId="u1" canManage />)
    expect(screen.getByRole('button', { name: /Update/ }).disabled).toBe(true)
    expect(screen.getByDisplayValue('promo_x').disabled).toBe(true)
  })

  it('a draft with no Meta id: Update offered and the fields editable', () => {
    render(<WATemplateEditor template={{ ...REJECTED, status: 'draft', rejection_reason: null, meta_template_id: null }} locationId="loc-1" userId="u1" canManage />)
    expect(screen.getByRole('button', { name: /Update/ }).disabled).toBe(false)
    expect(screen.getByDisplayValue('promo_x').disabled).toBe(false)
  })
})
