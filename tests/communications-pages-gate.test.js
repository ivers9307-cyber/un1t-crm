// C116 GATES-2 — with the /communications layout now the COARSE gate (the
// area at SOME studio), every page under it carries its own decision:
//   • pages about the ACTIVE studio (the hub, Segments, the two "new
//     template" pages) keep what the layout used to decide there, so nobody
//     reaches them who could not before;
//   • the two template EDITORS judge the TEMPLATE's studio: email at it for
//     the email editor (the rule /api/templates/[id] now applies), the area
//     at it for the WhatsApp editor.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, LOC_A, LOC_B } from './helpers/role-sweep-callers.js'
import { pageDb, navigationMock } from './helpers/page-db-mock.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('next/navigation', () => navigationMock())
vi.mock('@/components/TemplateEditor', () => ({ default: () => null }))
vi.mock('@/components/WATemplateEditor', () => ({ default: () => null }))

import HubPage from '@/app/communications/(hub)/page.js'
import SegmentsPage from '@/app/communications/(marketing-era)/segments/page.js'
import NewEmailTemplatePage from '@/app/communications/(editors)/templates/email/new/page.js'
import NewWaTemplatePage from '@/app/communications/(editors)/templates/whatsapp/new/page.js'
import EditEmailTemplatePage from '@/app/communications/(editors)/templates/email/[id]/page.js'
import EditWaTemplatePage from '@/app/communications/(editors)/templates/whatsapp/[id]/page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const off = { email: false, whatsapp: false, email_inbox: false }
const on = { email: true, whatsapp: true, email_inbox: true }
// A (active) and B permissions; owner at both, so role floors are met.
const who = (a, b) => person({ [LOC_A]: { role: 'owner', permissions: { ...off, ...a } }, [LOC_B]: { role: 'owner', permissions: { ...off, ...b } } }, LOC_A)
const onlyAtB = who({}, on)
const onlyAtA = who(on, {})

const props = { params: Promise.resolve({ id: 'tpl-1' }) }
beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(pageDb({
    email_templates: { id: 'tpl-1', location_id: LOC_B },
    whatsapp_templates: { id: 'tpl-1', location_id: LOC_B },
    whatsapp_template_events: [],
  }))
})

describe('pages about the active studio keep the old layout rule', () => {
  it.each([
    ['the hub', () => HubPage(), '/'],
    ['Segments', () => SegmentsPage(), '/'],
    ['new WhatsApp template', () => NewWaTemplatePage(), '/'],
  ])('%s: the area held only at another studio is still redirected', async (_label, render, to) => {
    getCurrentUser.mockResolvedValue(onlyAtB)
    await expect(render()).rejects.toThrow(new RegExp(`^NEXT_REDIRECT:${to}$`))
  })
  it('new email template: needs email at the active studio, where POST /api/templates creates (main: opened on whatsapp alone)', async () => {
    getCurrentUser.mockResolvedValue(who({ whatsapp: true }, on))
    await expect(NewEmailTemplatePage()).rejects.toThrow(/^NEXT_REDIRECT:\/communications\/templates$/)
    getCurrentUser.mockResolvedValue(who({ email: true }, {}))
    await expect(NewEmailTemplatePage()).resolves.toBeTruthy()
  })
})

describe('the email template editor judges email at the TEMPLATE\'s studio', () => {
  it('opens with email at the template\'s studio only (main: the layout redirected)', async () => {
    getCurrentUser.mockResolvedValue(onlyAtB)
    await expect(EditEmailTemplatePage(props)).resolves.toBeTruthy()
  })
  it('refuses email held only at the active studio (main: opened; every save 403s now)', async () => {
    getCurrentUser.mockResolvedValue(onlyAtA)
    await expect(EditEmailTemplatePage(props)).rejects.toThrow(/^NEXT_REDIRECT:\/communications\/templates$/)
  })
})

describe('the WhatsApp template editor judges the area at the TEMPLATE\'s studio', () => {
  it('opens with whatsapp at the template\'s studio only (main: the layout redirected)', async () => {
    getCurrentUser.mockResolvedValue(who({}, { whatsapp: true }))
    await expect(EditWaTemplatePage(props)).resolves.toBeTruthy()
  })
  it('refuses the area held only at the active studio (main: opened)', async () => {
    getCurrentUser.mockResolvedValue(onlyAtA)
    await expect(EditWaTemplatePage(props)).rejects.toThrow(/^NEXT_REDIRECT:\/communications\/templates$/)
  })
})
