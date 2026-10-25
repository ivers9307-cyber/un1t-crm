// GLOFOXWRITEJUDGE.1 (a) — Glofox's /2.0/register answers a refusal with HTTP
// 200 + success:false. registerGlofoxMember set ok from HTTP only, so the
// refusal reached findOrCreateGlofoxMember as ok:true with no _id and was filed
// "Register failed: unknown" (5 prod rows, 2 people). The bodies below are the
// recorded shapes from glofox_push_events.glofox_response (June and August
// 2026); they carry no personal data.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/error-events', () => ({ recordErrorEvent: vi.fn(async () => {}) }))

import { registerGlofoxMember, interpretRegisterResult } from './glofox.js'

const JUNE_REFUSAL = {
  success: false,
  message: 'The first name field is required., The last name field is required., The email field is required unless use parent email is in 1.',
  message_code: 'The first name field is required., The last name field is required., The email field is required unless use parent email is in 1.',
  message_data: [],
  errors: ['The first name field is required.', 'The last name field is required.', 'The email field is required unless use parent email is in 1.'],
}
const AUG_EMAIL_IN_USE = {
  success: false,
  message: 'LOGIN_ALREADY_IN_USE,EMAIL_ALREADY_IN_USE',
  message_code: null,
  message_data: [],
  errors: ['LOGIN_ALREADY_IN_USE,EMAIL_ALREADY_IN_USE'],
}
const NEW_ID = 'c'.repeat(24)
const CREATED = { success: true, user: { _id: NEW_ID, first_name: 'Sam' } }

const creds = { branchId: 'br-1', apiKey: 'k', apiToken: 't' }
const payload = { first_name: 'Sam', last_name: 'Lee', email: 'sam@x.com', password: 'Abcd-1234' }
const res = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => body,
  clone() { return { json: async () => body } },
})

beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('fetch', vi.fn()) })
afterEach(() => { vi.unstubAllGlobals() })

describe('interpretRegisterResult', () => {
  it('the live success shape is ok with the member', () => {
    expect(interpretRegisterResult({ httpOk: true, httpStatus: 200, body: CREATED }))
      .toEqual({ ok: true, member: CREATED.user, code: null, error: null })
  })

  it('a 200 success:false is a refusal carrying Glofox\'s words (June content-type bug)', () => {
    const v = interpretRegisterResult({ httpOk: true, httpStatus: 200, body: JUNE_REFUSAL })
    expect(v.ok).toBe(false)
    expect(v.member).toBeNull()
    expect(v.error).toMatch(/^The first name field is required\./)
    expect(v.code).toBe(JUNE_REFUSAL.message_code)
  })

  it('email in use is named, even with message_code null (August)', () => {
    expect(interpretRegisterResult({ httpOk: true, httpStatus: 200, body: AUG_EMAIL_IN_USE }))
      .toMatchObject({ ok: false, code: 'EMAIL_ALREADY_IN_USE', error: 'LOGIN_ALREADY_IN_USE,EMAIL_ALREADY_IN_USE' })
    // …and when only errors[] says so
    expect(interpretRegisterResult({ httpOk: true, httpStatus: 200, body: { success: false, errors: ['EMAIL_ALREADY_IN_USE'] } }).code)
      .toBe('EMAIL_ALREADY_IN_USE')
  })

  it('a 2xx without a member id is not a success', () => {
    expect(interpretRegisterResult({ httpOk: true, httpStatus: 200, body: { success: true } }))
      .toMatchObject({ ok: false, code: 'NO_MEMBER_ID' })
    expect(interpretRegisterResult({ httpOk: true, httpStatus: 200, body: null }))
      .toMatchObject({ ok: false, code: 'NO_MEMBER_ID' })
  })

  it('a 200 success:false with no words says so, not "Glofox HTTP 200"', () => {
    expect(interpretRegisterResult({ httpOk: true, httpStatus: 200, body: { success: false } }))
      .toMatchObject({ ok: false, code: 'REGISTER_REFUSED', error: 'Glofox refused the registration without saying why' })
  })

  it('a non-2xx keeps today\'s wording: Glofox\'s error/message, else "Glofox HTTP <n>"', () => {
    expect(interpretRegisterResult({ httpOk: false, httpStatus: 503, body: {} }))
      .toMatchObject({ ok: false, code: 'HTTP_503', error: 'Glofox HTTP 503' })
    expect(interpretRegisterResult({ httpOk: false, httpStatus: 422, body: { message: 'Bad' } }))
      .toMatchObject({ ok: false, error: 'Bad' })
  })

  it('a member spelled id (not _id) is normalised to _id', () => {
    const v = interpretRegisterResult({ httpOk: true, httpStatus: 200, body: { success: true, user: { id: NEW_ID } } })
    expect(v.ok).toBe(true)
    expect(v.member._id).toBe(NEW_ID)
  })
})

describe('registerGlofoxMember judges the body', () => {
  it('June: 200 success:false → ok:false with Glofox\'s words, no member', async () => {
    fetch.mockResolvedValueOnce(res(200, JUNE_REFUSAL))
    const out = await registerGlofoxMember(creds, payload)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({ ok: false, member: null, glofox_response: JUNE_REFUSAL })
    expect(out.error).toMatch(/first name field is required/)
  })

  it('August: EMAIL_ALREADY_IN_USE on a first send → ok:false, code EMAIL_ALREADY_IN_USE, no search here', async () => {
    fetch.mockResolvedValueOnce(res(200, AUG_EMAIL_IN_USE))
    const out = await registerGlofoxMember(creds, payload)
    expect(fetch).toHaveBeenCalledTimes(1) // the caller searches, not this function
    expect(out).toMatchObject({ ok: false, member: null, code: 'EMAIL_ALREADY_IN_USE' })
  })

  it('the live success shape is unchanged', async () => {
    fetch.mockResolvedValueOnce(res(200, CREATED))
    const out = await registerGlofoxMember(creds, payload)
    expect(out).toMatchObject({ ok: true, member: { _id: NEW_ID }, error: null, glofox_response: CREATED })
  })
})
