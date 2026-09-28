// C16 PUSHREADERR.1 — notifyUsers (push + registry-gated email fallback). Its
// push half now reports a failed read (read_failed); its own three fallback
// reads (device_tokens, profiles, permissions) used to discard their errors,
// so an app-less coach's reminder claim was KEPT on a blip (email_failed 0)
// and lost. There was no notify test before this file.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  tokens: { data: [], error: null },
  profiles: { data: [], error: null },
}))

vi.mock('./supabase.js', () => ({
  createServerClient: () => ({
    from(table) {
      const b = {}
      for (const m of ['select', 'not', 'in', 'eq']) b[m] = () => b
      b.then = (res, rej) => Promise.resolve(table === 'device_tokens' ? h.tokens : h.profiles).then(res, rej)
      return b
    },
  }),
}))
vi.mock('./push.js', () => ({ sendPush: vi.fn(), readPushAllowedIds: vi.fn() }))
vi.mock('./postmark.js', () => ({ sendEmail: vi.fn() }))
vi.mock('./notifications-registry.js', () => ({ getNotificationCategory: vi.fn() }))
vi.mock('./log.js', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

const { sendPush, readPushAllowedIds } = await import('./push.js')
const { sendEmail } = await import('./postmark.js')
const { getNotificationCategory } = await import('./notifications-registry.js')
const { logError } = await import('./log.js')
const { notifyUsers } = await import('./notify.js')

const READ_ERR = { message: 'fetch failed' }
const PAYLOAD = { title: 'Shift tomorrow', body: '09:00', category: 'shift_reminder', data: { type: 'shift_reminder' } }
const COACH = { id: 'coach-1', full_name: 'Coach', email: 'coach-1@example.test' }

beforeEach(() => {
  vi.clearAllMocks()
  h.tokens = { data: [], error: null } // nobody has the app
  h.profiles = { data: [COACH], error: null }
  getNotificationCategory.mockReturnValue({ fallbackEmail: true, emailSubject: 'Shift reminder', label: 'Shift reminders' })
  sendPush.mockResolvedValue({ sent: 0, skipped: 0, invalidated: 0, failed: 0 })
  readPushAllowedIds.mockResolvedValue({ allowed: new Set(['coach-1']), error: null, templatesError: null })
  sendEmail.mockResolvedValue({ ErrorCode: 0, MessageID: 'm-1' })
})

describe('notifyUsers — clean path (control)', () => {
  it('an app-less coach is emailed; plain totals, no read_failed', async () => {
    const t = await notifyUsers(['coach-1'], PAYLOAD)
    expect(t).toEqual({ sent: 0, skipped: 0, invalidated: 0, failed: 0, emailed: 1, email_failed: 0 })
    expect(readPushAllowedIds).toHaveBeenCalledWith(expect.anything(), ['coach-1'], 'shift_reminder')
    expect(logError).not.toHaveBeenCalled()
  })
})

describe('notifyUsers — failed reads (C16 PUSHREADERR.1, D7)', () => {
  it('passes on sendPush\'s read_failed (no fallback category)', async () => {
    getNotificationCategory.mockReturnValue({ fallbackEmail: false })
    sendPush.mockResolvedValue({ sent: 0, skipped: 0, invalidated: 0, failed: 1, read_failed: 1 })
    const t = await notifyUsers(['coach-1'], PAYLOAD)
    expect(t).toEqual({ sent: 0, skipped: 0, invalidated: 0, failed: 1, emailed: 0, email_failed: 0, read_failed: 1 })
  })

  it('a failed device_tokens read keeps main\'s reading (everyone token-less, emailed) and says so', async () => {
    h.tokens = { data: null, error: READ_ERR }
    const t = await notifyUsers(['coach-1'], PAYLOAD)
    expect(sendEmail).toHaveBeenCalledTimes(1)
    expect(t).toMatchObject({ emailed: 1, read_failed: 1 })
    expect(logError).toHaveBeenCalledWith('notify', 'device-token read failed; emailing every allowed recipient as the fallback',
      expect.objectContaining({ category: 'shift_reminder', recipients: 1, err: READ_ERR }))
  })

  it('a failed profiles read sends no fallback email and counts it as email_failed, so a claim caller retries', async () => {
    h.profiles = { data: null, error: READ_ERR }
    const t = await notifyUsers(['coach-1'], PAYLOAD)
    expect(sendEmail).not.toHaveBeenCalled()
    expect(t).toEqual({ sent: 0, skipped: 0, invalidated: 0, failed: 0, emailed: 0, email_failed: 1, read_failed: 1 })
    expect(logError).toHaveBeenCalledWith('notify', 'fallback recipients read failed; no fallback email sent',
      expect.objectContaining({ category: 'shift_reminder', recipients: 1, err: READ_ERR }))
    // shift-reminders.js:590-592 — releases (and retries) on exactly this:
    const delivered = (t.sent || 0) > 0 || (t.emailed || 0) > 0
    const somethingFailed = (t.failed || 0) > 0 || (t.email_failed || 0) > 0
    expect(!delivered && somethingFailed).toBe(true)
  })

  it('a failed permissions read is treated the same way', async () => {
    readPushAllowedIds.mockResolvedValue({ allowed: new Set(), error: READ_ERR, templatesError: null })
    const t = await notifyUsers(['coach-1'], PAYLOAD)
    expect(sendEmail).not.toHaveBeenCalled()
    expect(t).toMatchObject({ emailed: 0, email_failed: 1, read_failed: 1 })
  })

  it('unreadable templates: the allowed are still emailed, the refused count as email_failed', async () => {
    h.profiles = { data: [COACH, { id: 'coach-2', full_name: 'Two', email: 'coach-2@example.test' }], error: null }
    readPushAllowedIds.mockResolvedValue({ allowed: new Set(['coach-1']), error: null, templatesError: READ_ERR })
    const t = await notifyUsers(['coach-1', 'coach-2'], PAYLOAD)
    expect(sendEmail).toHaveBeenCalledTimes(1)
    expect(t).toMatchObject({ emailed: 1, email_failed: 1, read_failed: 1 })
  })

  // Review: when only the fallback's own template read fails (sendPush's was
  // fine), nothing else logs it — readPushAllowedIds is silent by contract.
  it('unreadable fallback templates are logged once, structurally', async () => {
    h.profiles = { data: [COACH, { id: 'coach-2', full_name: 'Two', email: 'coach-2@example.test' }], error: null }
    readPushAllowedIds.mockResolvedValue({ allowed: new Set(['coach-1']), error: null, templatesError: READ_ERR })
    await notifyUsers(['coach-1', 'coach-2'], PAYLOAD)
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith('notify', 'fallback role templates read failed; judged on code defaults',
      expect.objectContaining({ category: 'shift_reminder', recipients: 2, unjudged: 1, err: READ_ERR }))
  })
})
