// MEMBERWRITESWEEP.1f — the staff phone's TV screen acts through the session
// routes (/api/admin/tv-displays*, /api/admin/tv-templates*) via api(), never
// supabase.from('tv_*'). Until 1f mobile/lib/tv-api.js read and wrote
// tv_displays, tv_content and tv_templates straight from the phone's session
// under nothing but the membership policy; mig 685 (1g) closes them.
//
// Every function keeps its old return shape ({ success, data | id | error }),
// so the three screens (tv/index.jsx, tv/template-edit.jsx, TvPushModal.jsx)
// do not change. MEMBERWRITESWEEP.1g — the old-server fallback 1f kept
// (mobile/lib/tv-api-legacy.js, the direct path on an HTML 404) is deleted:
// after mig 685 a direct read or write can only fail, so an HTML 404 is now an
// error like any other and nothing ever falls back to supabase.from.

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: { apiBaseUrl: 'https://crm.test' } } } }))
vi.mock('./api', () => ({ api: vi.fn(), authHeaders: vi.fn(), API_BASE: 'https://crm.test' }))

const getPublicUrl = vi.fn((p) => ({ data: { publicUrl: `https://cdn.test/${p}` } }))
const fromTable = vi.fn()
vi.mock('./supabase', () => ({ supabase: { from: (...a) => fromTable(...a), storage: { from: vi.fn(() => ({ getPublicUrl })) } } }))

import { api } from './api'
import { supabase } from './supabase'
import {
  listTvDisplays, clearTvContent, registerTvDisplay, deleteTvDisplay, setTvRotation, listTvTemplates,
  pushTvContent, getTvTemplate, saveTvTemplate, deleteTvTemplate, tvImageUrl,
} from './tv-api'
import * as tvApi from './tv-api'

const LOC = '0a000000-0000-4000-8000-000000000001'
const TV = 'e0000000-0000-4000-8000-0000000000e1'
const TPL = 'f1000000-0000-4000-8000-0000000000f1'
const NOT_DEPLOYED = { success: false, transport: true, status: 404, error: 'Non-JSON response (404)' }

beforeEach(() => {
  vi.clearAllMocks()
  api.mockResolvedValue({ success: true, data: null })
})

describe('each function calls its session route through api()', () => {
  it('listTvDisplays: GET the studio\'s TVs, with the studio as the active-location header', async () => {
    const rows = [{ id: TV, label: 'Lobby TV', content: null }]
    api.mockResolvedValue({ success: true, data: rows })
    expect(await listTvDisplays(LOC)).toEqual({ success: true, data: rows })
    expect(api).toHaveBeenCalledWith(`/api/admin/tv-displays?location_id=${LOC}`, { locationId: LOC })
  })

  it('listTvDisplays with no studio: empty, no call', async () => {
    expect(await listTvDisplays(null)).toEqual({ success: true, data: [] })
    expect(api).not.toHaveBeenCalled()
  })

  it('clearTvContent: DELETE …/[id]/content', async () => {
    expect(await clearTvContent(TV)).toEqual({ success: true })
    expect(api).toHaveBeenCalledWith(`/api/admin/tv-displays/${TV}/content`, { method: 'DELETE' })
  })

  it('registerTvDisplay: POST { location_id, label } trimmed', async () => {
    expect(await registerTvDisplay(LOC, '  Gym floor ')).toEqual({ success: true })
    expect(api).toHaveBeenCalledWith('/api/admin/tv-displays', { method: 'POST', body: { location_id: LOC, label: 'Gym floor' }, locationId: LOC })
  })

  it('registerTvDisplay with no label: refused before any call', async () => {
    expect((await registerTvDisplay(LOC, '  ')).success).toBe(false)
    expect(api).not.toHaveBeenCalled()
  })

  it('deleteTvDisplay: DELETE …/[id]', async () => {
    expect(await deleteTvDisplay(TV)).toEqual({ success: true })
    expect(api).toHaveBeenCalledWith(`/api/admin/tv-displays/${TV}`, { method: 'DELETE' })
  })

  it('setTvRotation: PATCH …/[id] { rotation }', async () => {
    expect(await setTvRotation(TV, 90)).toEqual({ success: true })
    expect(api).toHaveBeenCalledWith(`/api/admin/tv-displays/${TV}`, { method: 'PATCH', body: { rotation: 90 } })
  })

  it('listTvTemplates: GET the studio\'s templates', async () => {
    api.mockResolvedValue({ success: true, data: [{ id: TPL, name: 'Board' }] })
    expect(await listTvTemplates(LOC)).toEqual({ success: true, data: [{ id: TPL, name: 'Board' }] })
    expect(api).toHaveBeenCalledWith(`/api/admin/tv-templates?location_id=${LOC}`, { locationId: LOC })
  })

  it('pushTvContent: PUT …/[id]/content; pushedBy is ignored (the server stamps who pushed)', async () => {
    const values = { z1: { text: 'Hi' } }
    expect(await pushTvContent(TV, { source_type: 'template', source_ref: TPL, label: 'Board', template_values: values }, 'someone')).toEqual({ success: true })
    expect(api).toHaveBeenCalledWith(`/api/admin/tv-displays/${TV}/content`, {
      method: 'PUT', body: { source_type: 'template', source_ref: TPL, label: 'Board', template_values: values },
    })
  })

  it('pushTvContent of a URL sends no template_values and a null label when blank', async () => {
    await pushTvContent(TV, { source_type: 'url', source_ref: 'https://example.invalid/a.png', label: '' }, 'someone')
    expect(api.mock.calls[0][1].body).toEqual({ source_type: 'url', source_ref: 'https://example.invalid/a.png', label: null })
  })

  it('getTvTemplate: GET …/tv-templates/[id], with its studio', async () => {
    api.mockResolvedValue({ success: true, data: { id: TPL, name: 'Board', location_id: LOC } })
    expect(await getTvTemplate(TPL)).toEqual({ success: true, data: { id: TPL, name: 'Board', location_id: LOC } })
    expect(api).toHaveBeenCalledWith(`/api/admin/tv-templates/${TPL}`, {})
  })

  it('saveTvTemplate with an id: PUT { name, base_image_path, zones }; createdBy is ignored', async () => {
    const r = await saveTvTemplate({ id: TPL, locationId: LOC, name: ' Board ', base_image_path: `${LOC}/templates/a.png`, zones: [{ id: 'z1' }], createdBy: 'x' })
    expect(r).toEqual({ success: true, id: TPL })
    expect(api).toHaveBeenCalledWith(`/api/admin/tv-templates/${TPL}`, {
      method: 'PUT', body: { name: 'Board', base_image_path: `${LOC}/templates/a.png`, zones: [{ id: 'z1' }] },
    })
  })

  it('saveTvTemplate without an id: POST at the studio, answers the new id', async () => {
    api.mockResolvedValue({ success: true, data: { id: TPL } })
    const r = await saveTvTemplate({ locationId: LOC, name: 'Board', base_image_path: `${LOC}/templates/a.png`, createdBy: 'x' })
    expect(r).toEqual({ success: true, id: TPL })
    expect(api).toHaveBeenCalledWith('/api/admin/tv-templates', {
      method: 'POST', body: { location_id: LOC, name: 'Board', base_image_path: `${LOC}/templates/a.png`, zones: [] }, locationId: LOC,
    })
  })

  it('saveTvTemplate keeps its checks before any call', async () => {
    expect((await saveTvTemplate({ locationId: LOC, name: '', base_image_path: 'x' })).error).toBe('A template name is required.')
    expect((await saveTvTemplate({ locationId: LOC, name: 'B', base_image_path: null })).error).toBe('A base image is required.')
    expect(api).not.toHaveBeenCalled()
  })

  it('deleteTvTemplate: DELETE …/tv-templates/[id]', async () => {
    expect(await deleteTvTemplate(TPL)).toEqual({ success: true })
    expect(api).toHaveBeenCalledWith(`/api/admin/tv-templates/${TPL}`, { method: 'DELETE' })
  })

  it('none of them touches a tv_* table directly', async () => {
    await listTvDisplays(LOC); await clearTvContent(TV); await registerTvDisplay(LOC, 'x'); await deleteTvDisplay(TV)
    await setTvRotation(TV, 0); await listTvTemplates(LOC); await pushTvContent(TV, { source_type: 'url', source_ref: 'https://e.invalid' })
    await getTvTemplate(TPL); await saveTvTemplate({ id: TPL, name: 'B', base_image_path: 'p' }); await deleteTvTemplate(TPL)
    expect(fromTable).not.toHaveBeenCalled()
  })
})

describe('refusals keep the old { success: false, error } shape', () => {
  it('the route\'s words come through', async () => {
    api.mockResolvedValue({ success: false, status: 403, error: 'Not authorised for TV displays' })
    expect(await listTvDisplays(LOC)).toEqual({ success: false, error: 'Not authorised for TV displays' })
    expect(await pushTvContent(TV, { source_type: 'url', source_ref: 'javascript:x' })).toEqual({ success: false, error: 'Not authorised for TV displays' })
  })

  it('a dropped connection is an error, never a fallback', async () => {
    api.mockResolvedValue({ success: false, transport: true, error: 'Network error: offline' })
    expect(await setTvRotation(TV, 90)).toEqual({ success: false, error: 'Network error: offline' })
    expect(fromTable).not.toHaveBeenCalled()
  })

  it('a delete of a TV or template already gone (a JSON 404) is done, as the direct delete was', async () => {
    api.mockResolvedValue({ success: false, status: 404, error: 'TV not found' })
    expect(await deleteTvDisplay(TV)).toEqual({ success: true })
    expect(await deleteTvTemplate(TPL)).toEqual({ success: true })
    expect(fromTable).not.toHaveBeenCalled()
  })

  it('a JSON 404 on anything else is an error, not a fallback', async () => {
    api.mockResolvedValue({ success: false, status: 404, error: 'Not found' })
    expect(await getTvTemplate(TPL)).toEqual({ success: false, error: 'Not found' })
    expect(fromTable).not.toHaveBeenCalled()
  })
})

describe('1g: no old-server fallback (mobile/lib/tv-api-legacy.js is deleted; mig 685 closes the tables)', () => {
  it('an HTML 404 (api()\'s transport envelope) is an error with the route\'s words, never a direct read or write', async () => {
    api.mockResolvedValue(NOT_DEPLOYED)
    const results = [
      await listTvDisplays(LOC), await clearTvContent(TV), await registerTvDisplay(LOC, 'x'), await deleteTvDisplay(TV),
      await setTvRotation(TV, 90), await listTvTemplates(LOC), await pushTvContent(TV, { source_type: 'url', source_ref: 'https://e.invalid' }, 'u1'),
      await getTvTemplate(TPL), await saveTvTemplate({ id: TPL, name: 'B', base_image_path: 'p' }),
      await saveTvTemplate({ locationId: LOC, name: 'B', base_image_path: 'p', createdBy: 'u1' }), await deleteTvTemplate(TPL),
    ]
    for (const r of results) expect(r).toEqual({ success: false, error: 'Non-JSON response (404)' })
    expect(fromTable).not.toHaveBeenCalled()
  })

  it('the fallback probe is gone from the module', () => {
    expect(tvApi.routeNotDeployed).toBeUndefined()
  })
})

describe('unchanged', () => {
  it('tvImageUrl still reads the public bucket URL', () => {
    expect(tvImageUrl('a/b.png')).toBe('https://cdn.test/a/b.png')
    expect(supabase.storage.from).toHaveBeenCalledWith('tv-content')
    expect(tvImageUrl('')).toBe('')
  })
})
