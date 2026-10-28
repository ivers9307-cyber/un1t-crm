// FEES.3 — the member notice and the appeal, each on its own switch.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('./postmark.js', () => ({ sendTransactionalEmail: vi.fn(async () => ({ messageId: 'm1' })) }))
vi.mock('./tenant-host.js', () => ({ resolveCustomerBaseUrl: vi.fn(async () => 'https://hatch.example.test') }))
vi.mock('./location-branding.js', () => ({ getLocationBranding: vi.fn(async () => ({ companyName: 'UN1T Hatch Street', logoUrl: null })) }))
vi.mock('./location-time.js', async (orig) => ({ ...(await orig()), getLocationZone: vi.fn(async () => 'Europe/Dublin') }))

import { sendTransactionalEmail } from './postmark.js'
import { makeDb } from './class-fees.test-helpers.js'
import { classFeeSettingsFrom } from './class-fees.js'
import {
  sendMemberNotices, issueAppealLink, loadAppeal, submitAppeal, chargeAppealedFee, hashAppealToken, noticeHtml,
} from './class-fees-member.js'

const LOC = 'loc-1'
const NOW = Date.parse('2026-10-29T23:05:00Z')
const DUE = '2026-10-30T17:00:00.000Z'
const ZONE = 'Europe/Dublin'

const fees = (over = {}) => ({ enabled: true, late_cancel_fee_cents: 1000, no_show_fee_cents: 2000, ...over })
const tables = ({ feeSettings = {}, feeRows, contacts } = {}) => ({
  locations: [{ id: LOC, name: 'UN1T Hatch Street', settings: { un1t_online: { fees: fees(feeSettings) } } }],
  class_fees: feeRows ?? [
    { id: 'f1', location_id: LOC, contact_id: 'c1', kind: 'no_show', class_title: 'Strength', starts_at: '2026-10-29T18:30:00.000Z', amount_cents: 2000, charge_due_at: DUE, status: 'pending', penalty: 'fee', notice_sent_at: null },
    { id: 'f2', location_id: LOC, contact_id: 'c2', kind: 'late_cancel', class_title: 'Mobility', starts_at: '2026-10-29T07:00:00.000Z', amount_cents: 1000, charge_due_at: DUE, status: 'pending', penalty: 'fee', notice_sent_at: null },
  ],
  contacts: contacts ?? [
    { id: 'c1', email: 'ann@example.test', first_name: 'Ann', email_status: 'active', contact_preferences: [] },
    { id: 'c2', email: 'bob@example.test', first_name: 'Bob', email_status: 'bounced', contact_preferences: [] },
  ],
})
const settingsIn = (db) => classFeeSettingsFrom(db.store.locations[0].settings)
const notices = (db) => sendMemberNotices(db, { locationId: LOC, location: { name: 'UN1T Hatch Street' }, settings: settingsIn(db), zone: ZONE, nowMs: NOW })
const tokenFromLastMail = () => sendTransactionalEmail.mock.calls.at(-1)[0].htmlBody.match(/fee-appeal\/([A-Za-z0-9_-]+)/)?.[1]

beforeEach(() => vi.clearAllMocks())

describe('sendMemberNotices', () => {
  it('nothing goes out with the notice off, or while charging is paused', async () => {
    expect(await notices(makeDb(tables()))).toEqual({ sent: 0, skipped: 0, failed: 0 })
    expect(await notices(makeDb(tables({ feeSettings: { notice_enabled: true, charging_paused: true } })))).toEqual({ sent: 0, skipped: 0, failed: 0 })
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
  })

  it('notice on, appeals off: the email has no appeal link and no token is stored', async () => {
    const db = makeDb(tables({ feeSettings: { notice_enabled: true } }))
    expect(await notices(db)).toEqual({ sent: 1, skipped: 1, failed: 0 })
    const mail = sendTransactionalEmail.mock.calls[0][0]
    expect(mail).toMatchObject({ to: 'ann@example.test', contactId: 'c1', locationId: LOC, tag: 'class-fee-notice', subject: 'No-show fee for Strength' })
    expect(mail.htmlBody).toContain('Hi Ann,')
    expect(mail.htmlBody).not.toContain('fee-appeal')
    expect(db.store.class_fees[0].appeal_token_hash).toBeUndefined()
    expect(db.store.class_fees[0].notice_sent_at).toBeTruthy()
    // The bounced address is never emailed.
    expect(db.store.class_fees[1].notice_sent_at).toBeNull()
    // A second night sends nothing again.
    expect((await notices(db)).sent).toBe(0)
  })

  it('notice and appeals on: the email carries a working link, and only its hash is stored', async () => {
    const db = makeDb(tables({ feeSettings: { notice_enabled: true, appeals_enabled: true } }))
    await notices(db)
    const token = tokenFromLastMail()
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(sendTransactionalEmail.mock.calls[0][0].htmlBody).toContain(`<a href="https://hatch.example.test/fee-appeal/${token}">`)
    expect(db.store.class_fees[0].appeal_token_hash).toBe(hashAppealToken(token))
    expect(JSON.stringify(db.store.class_fees)).not.toContain(token)
  })

  it('a fee already past its charge time is not noticed', async () => {
    const db = makeDb(tables({ feeSettings: { notice_enabled: true } }))
    for (const f of db.store.class_fees) f.charge_due_at = '2026-10-29T17:00:00.000Z'
    expect((await notices(db)).sent).toBe(0)
  })
})

describe('appeals', () => {
  async function withToken(feeSettings = { appeals_enabled: true }) {
    const db = makeDb(tables({ feeSettings }))
    const r = await issueAppealLink(db, { locationId: LOC, feeId: 'f1' })
    return { db, r, token: r.url ? r.url.split('/fee-appeal/')[1] : null }
  }

  it('staff can mint a link with the notice off; not with appeals off', async () => {
    const { r } = await withToken({ appeals_enabled: true, notice_enabled: false })
    expect(r).toMatchObject({ ok: true })
    expect(r.url).toMatch(/^https:\/\/hatch\.example\.test\/fee-appeal\/[A-Za-z0-9_-]{32}$/)
    const off = await withToken({ appeals_enabled: false })
    expect(off.r).toEqual({ ok: false, reason: 'appeals_off' })
  })

  it('the page view shows the fee, never the member; an unknown token shows nothing', async () => {
    const { db, token } = await withToken()
    const view = await loadAppeal(db, token)
    expect(view).toMatchObject({ state: 'open', fee: { what: 'No-show', classTitle: 'Strength', amount: '€20', classTime: 'Thu 29 Oct, 18:30', chargeTime: 'Fri 30 Oct, 17:00' } })
    expect(JSON.stringify(view)).not.toMatch(/ann|Ann|c1/)
    expect(await loadAppeal(db, 'x'.repeat(32))).toEqual({ state: 'not_found' })
    expect(await loadAppeal(db, 'bad token')).toEqual({ state: 'not_found' })
  })

  it('an appeal holds the fee, so the 17:00 run never picks it up; appealing twice is fine', async () => {
    const { db, token } = await withToken()
    expect(await submitAppeal(db, { token, reason: 'illness', text: ' Flu ', nowMs: NOW })).toEqual({ ok: true })
    expect(db.store.class_fees[0]).toMatchObject({ status: 'appealed', appeal_reason: 'illness', appeal_text: 'Flu' })
    expect(await submitAppeal(db, { token, reason: 'illness' })).toEqual({ ok: true, already: true })
    expect((await loadAppeal(db, token)).state).toBe('appealed')
  })

  it('a bad reason, a closed fee or appeals switched off is refused', async () => {
    const { db, token } = await withToken()
    expect(await submitAppeal(db, { token, reason: 'bored' })).toEqual({ ok: false, reason: 'bad_reason' })
    db.store.class_fees[0].status = 'charged'
    expect(await submitAppeal(db, { token, reason: 'injury' })).toEqual({ ok: false, reason: 'closed' })
    expect((await loadAppeal(db, token)).state).toBe('closed')
    db.store.class_fees[0].status = 'pending'
    db.store.locations[0].settings.un1t_online.fees.appeals_enabled = false
    expect(await submitAppeal(db, { token, reason: 'injury' })).toEqual({ ok: false, reason: 'appeals_off' })
    expect((await loadAppeal(db, token)).state).toBe('off')
  })

  it('charge anyway sends an appealed fee back to pending, due now', async () => {
    const { db, token } = await withToken()
    await submitAppeal(db, { token, reason: 'other' })
    expect(await chargeAppealedFee(db, { locationId: LOC, feeId: 'f1', nowMs: NOW })).toEqual({ ok: true })
    expect(db.store.class_fees[0]).toMatchObject({ status: 'pending', charge_due_at: new Date(NOW).toISOString() })
    expect(await chargeAppealedFee(db, { locationId: LOC, feeId: 'f1' })).toEqual({ ok: false, reason: 'not_appealed' })
    expect(await chargeAppealedFee(db, { locationId: 'other', feeId: 'f1' })).toEqual({ ok: false, reason: 'not_found' })
  })
})

describe('noticeHtml', () => {
  it('escapes the text and links only the appeal URL', () => {
    const html = noticeHtml('Hi <b>Ann</b>,\n\nGo: https://x.test/fee-appeal/t', 'https://x.test/fee-appeal/t')
    expect(html).toBe('<p>Hi &lt;b&gt;Ann&lt;/b&gt;,</p>\n<p>Go: <a href="https://x.test/fee-appeal/t">https://x.test/fee-appeal/t</a></p>')
  })
})
