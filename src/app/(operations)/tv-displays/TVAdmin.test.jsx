// @vitest-environment jsdom
//
// MEMBERWRITESWEEP.1f — the web TV admin acts through the session routes
// (/api/admin/tv-displays*, /api/admin/tv-templates*), never the browser
// Supabase client. Until this PR every action here (list, register, delete,
// rotate, push, clear, template delete/save) was a direct tv_* read or write
// under nothing but the membership policy; mig 685 (PR 1g) closes the tables.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('@/lib/supabase', () => ({
  createBrowserClient: vi.fn(() => { throw new Error('TVAdmin must not create a browser Supabase client') }),
}))
// next/font/local only runs under the Next compiler.
vi.mock('@/components/tv-font', () => ({ tvFont: { style: { fontFamily: 'sans-serif' } }, tvFontFamily: 'sans-serif' }))

import TVAdmin from './TVAdmin.jsx'
import TemplateEditor from './TemplateEditor.jsx'

const LOC = 'a0000000-0000-4000-8000-00000000000a'
const OTHER = 'b0000000-0000-4000-8000-00000000000b'
const TV = { id: 'tv-1', label: 'Lobby TV', token: 'tok-1', active: true, rotation: 0, location_id: LOC, created_at: '2026-09-01T09:00:00Z', tv_content: null }
const TPL = { id: 'tpl-1', name: 'Welcome board', base_image_path: `${LOC}/templates/a.png`, zones: [], location_id: LOC }

let answers
const ok = (data) => ({ ok: true, status: 200, json: async () => ({ success: true, ...(data === undefined ? {} : { data }) }) })
const fail = (status, error) => ({ ok: false, status, json: async () => ({ success: false, error }) })
const callsTo = (method, url) => fetch.mock.calls.filter(([u, init]) => u === url && (init?.method || 'GET') === method)

beforeEach(() => {
  answers = {}
  vi.stubGlobal('confirm', () => true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const key = `${init?.method || 'GET'} ${url}`
    if (answers[key]) return answers[key]
    if (key.startsWith('GET /api/admin/tv-displays?')) return ok([{ ...TV, content: null }])
    if (key.startsWith('GET /api/admin/tv-templates?')) return ok([TPL])
    return ok(null)
  }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const renderAdmin = (displays = [TV], templates = [TPL]) =>
  render(<TVAdmin initialDisplays={displays} initialTemplates={templates} locationId={LOC} currentUserId="u-1" />)

describe('TVAdmin — every action goes through a session route', () => {
  it('register: POST /api/admin/tv-displays with the studio and label, then reloads the list from the route', async () => {
    renderAdmin([])
    fireEvent.click(screen.getByText('Register TV'))
    fireEvent.change(screen.getByPlaceholderText('e.g. Lobby TV'), { target: { value: 'Gym floor' } })
    fireEvent.click(screen.getByText('Register'))
    await waitFor(() => expect(callsTo('POST', '/api/admin/tv-displays')).toHaveLength(1))
    expect(JSON.parse(callsTo('POST', '/api/admin/tv-displays')[0][1].body)).toEqual({ location_id: LOC, label: 'Gym floor' })
    await waitFor(() => expect(callsTo('GET', `/api/admin/tv-displays?location_id=${LOC}`)).toHaveLength(1))
    expect(await screen.findByText('Lobby TV')).toBeTruthy()
  })

  it('a refused register shows the route\'s words', async () => {
    answers['POST /api/admin/tv-displays'] = fail(409, 'A TV called "Lobby TV" is already registered here.')
    renderAdmin([])
    fireEvent.click(screen.getByText('Register TV'))
    fireEvent.change(screen.getByPlaceholderText('e.g. Lobby TV'), { target: { value: 'Lobby TV' } })
    fireEvent.click(screen.getByText('Register'))
    expect(await screen.findByText('A TV called "Lobby TV" is already registered here.')).toBeTruthy()
  })

  it('delete TV: DELETE /api/admin/tv-displays/[id]', async () => {
    renderAdmin()
    fireEvent.click(screen.getByTitle('Delete TV'))
    await waitFor(() => expect(callsTo('DELETE', '/api/admin/tv-displays/tv-1')).toHaveLength(1))
  })

  it('clear: DELETE /api/admin/tv-displays/[id]/content', async () => {
    renderAdmin([{ ...TV, tv_content: { tv_display_id: 'tv-1', source_type: 'url', source_ref: 'https://example.invalid/a.png', label: 'Promo', pushed_at: '2026-09-30T10:00:00Z' } }])
    fireEvent.click(screen.getByTitle('Revert to idle screen'))
    await waitFor(() => expect(callsTo('DELETE', '/api/admin/tv-displays/tv-1/content')).toHaveLength(1))
  })

  it('rotation: PATCH /api/admin/tv-displays/[id] { rotation }', async () => {
    renderAdmin()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '90' } })
    await waitFor(() => expect(callsTo('PATCH', '/api/admin/tv-displays/tv-1')).toHaveLength(1))
    expect(JSON.parse(callsTo('PATCH', '/api/admin/tv-displays/tv-1')[0][1].body)).toEqual({ rotation: 90 })
  })

  it('push a URL: PUT /api/admin/tv-displays/[id]/content with no pushed_by (the server stamps it)', async () => {
    renderAdmin()
    fireEvent.click(screen.getByText('Push image'))
    fireEvent.click(screen.getByText('URL'))
    fireEvent.change(screen.getByPlaceholderText('https://…image.jpg'), { target: { value: 'https://example.invalid/a.png' } })
    fireEvent.click(screen.getByRole('button', { name: 'Push to TV' }))
    await waitFor(() => expect(callsTo('PUT', '/api/admin/tv-displays/tv-1/content')).toHaveLength(1))
    const body = JSON.parse(callsTo('PUT', '/api/admin/tv-displays/tv-1/content')[0][1].body)
    expect(body).toEqual({ source_type: 'url', source_ref: 'https://example.invalid/a.png', label: null })
  })

  it('a refused push stays in the push window with the route\'s words', async () => {
    answers['PUT /api/admin/tv-displays/tv-1/content'] = fail(400, 'The URL must start with http:// or https://.')
    renderAdmin()
    fireEvent.click(screen.getByText('Push image'))
    fireEvent.click(screen.getByText('URL'))
    fireEvent.change(screen.getByPlaceholderText('https://…image.jpg'), { target: { value: 'javascript:alert(1)' } })
    fireEvent.click(screen.getByRole('button', { name: 'Push to TV' }))
    expect(await screen.findByText('The URL must start with http:// or https://.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Push to TV' })).toBeTruthy()
  })

  it('delete template: DELETE /api/admin/tv-templates/[id], then the template list reloads from the route', async () => {
    renderAdmin()
    fireEvent.click(screen.getByTitle('Delete template'))
    await waitFor(() => expect(callsTo('DELETE', '/api/admin/tv-templates/tpl-1')).toHaveLength(1))
    await waitFor(() => expect(callsTo('GET', `/api/admin/tv-templates?location_id=${LOC}`)).toHaveLength(1))
  })

  it('a list that cannot be read shows why and keeps the TVs on screen', async () => {
    answers[`GET /api/admin/tv-displays?location_id=${LOC}`] = fail(500, 'Could not load the TVs')
    renderAdmin()
    fireEvent.click(screen.getByTitle('Delete TV'))
    expect(await screen.findByText('Could not load the TVs')).toBeTruthy()
    expect(screen.getByText('Lobby TV')).toBeTruthy()
  })
})

describe('TemplateEditor — saves through the template routes', () => {
  const editor = (template) => {
    const onSaved = vi.fn(async () => {})
    const onClose = vi.fn()
    render(<TemplateEditor template={template} locationId={LOC} currentUserId="u-1" onClose={onClose} onSaved={onSaved} />)
    return { onSaved, onClose }
  }

  it('an edit is PUT /api/admin/tv-templates/[id] with name, base image and zones (no created_by)', async () => {
    const { onSaved, onClose } = editor(TPL)
    fireEvent.click(screen.getByText('Save changes'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    const [[, init]] = callsTo('PUT', '/api/admin/tv-templates/tpl-1').map((c) => c)
    expect(JSON.parse(init.body)).toEqual({ name: 'Welcome board', base_image_path: TPL.base_image_path, zones: [] })
    expect(onSaved).toHaveBeenCalled()
  })

  it('a refused save stays open with the route\'s words', async () => {
    answers['PUT /api/admin/tv-templates/tpl-1'] = fail(409, 'A template called "Welcome board" already exists here.')
    const { onClose } = editor(TPL)
    fireEvent.click(screen.getByText('Save changes'))
    expect(await screen.findByText('A template called "Welcome board" already exists here.')).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('a replacement base image for another studio\'s template is uploaded at THAT studio', async () => {
    answers['POST /api/admin/tv-displays/upload'] = ok()
    editor({ ...TPL, location_id: OTHER, base_image_path: `${OTHER}/templates/a.png` })
    const input = document.querySelector('input[type="file"]')
    fireEvent.change(input, { target: { files: [new File([new Uint8Array([1])], 'b.png', { type: 'image/png' })] } })
    await waitFor(() => expect(callsTo('POST', '/api/admin/tv-displays/upload')).toHaveLength(1))
    const fd = callsTo('POST', '/api/admin/tv-displays/upload')[0][1].body
    expect(fd.get('location_id')).toBe(OTHER)
    expect(fd.get('kind')).toBe('template')
  })
})
