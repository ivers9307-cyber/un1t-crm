import { describe, it, expect, vi } from 'vitest'
import { parseOpsAlertEmails, sendOpsAlert } from './ops-alerts.js'

describe('parseOpsAlertEmails (SAAS4-O2)', () => {
  it('splits, trims, lowercases and dedupes a comma-separated list', () => {
    expect(parseOpsAlertEmails(' Ops@FitCo.ie, owner@fitco.ie ,ops@fitco.ie ')).toEqual([
      'ops@fitco.ie',
      'owner@fitco.ie',
    ])
  })

  it('accepts an array input (the stored TEXT[] shape)', () => {
    expect(parseOpsAlertEmails(['a@b.ie', 'A@B.ie'])).toEqual(['a@b.ie'])
  })

  it('drops invalid addresses and returns [] for empty/absent input', () => {
    expect(parseOpsAlertEmails('not-an-email, x@y.ie')).toEqual(['x@y.ie'])
    expect(parseOpsAlertEmails('')).toEqual([])
    expect(parseOpsAlertEmails(null)).toEqual([])
  })
})

describe('sendOpsAlert (SAAS4-O2)', () => {
  function stubDb(emails) {
    return {
      from: vi.fn(() => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: { ops_alert_emails: emails } }) }),
        }),
      })),
    }
  }

  it('emails every configured recipient and reports the routed channel', async () => {
    const sent = []
    const result = await sendOpsAlert(
      { organizationId: 'org-1', locationId: 'loc-1', subject: 'Sync stale', htmlBody: '<p>x</p>' },
      {
        db: stubDb(['ops@fitco.ie', 'owner@fitco.ie']),
        sendEmail: async (args) => {
          sent.push(args)
          return { success: true }
        },
        sendPush: vi.fn(),
      }
    )
    expect(result).toMatchObject({ channel: 'email', recipients: 2 })
    expect(sent.map((s) => s.to)).toEqual(['ops@fitco.ie', 'owner@fitco.ie'])
    expect(sent[0]).toMatchObject({ subject: 'Sync stale', locationId: 'loc-1' })
  })

  it('falls back to the master push when no recipients are configured', async () => {
    const sendPush = vi.fn(async () => {})
    const result = await sendOpsAlert(
      { organizationId: 'org-1', locationId: 'loc-1', subject: 'S', htmlBody: 'b' },
      { db: stubDb(null), sendEmail: vi.fn(), sendPush }
    )
    expect(result).toMatchObject({ channel: 'push_fallback' })
    expect(sendPush).toHaveBeenCalledTimes(1)
  })

  it('never throws — an infra failure reports channel none', async () => {
    const db = {
      from: () => {
        throw new Error('db down')
      },
    }
    const result = await sendOpsAlert(
      { organizationId: 'org-1', subject: 'S', htmlBody: 'b' },
      { db, sendEmail: vi.fn(), sendPush: vi.fn() }
    )
    expect(result).toMatchObject({ channel: 'none' })
  })
})
