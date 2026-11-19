// EDITORRESEND.1 — the resend rules the editor's saves share with the quick composer.
import { describe, it, expect } from 'vitest'
import { resendRefusal, CampaignContentSchema } from './campaign-session-schemas.js'

describe('resendRefusal', () => {
  it('allows a marketing resend with a wait', () => {
    expect(resendRefusal({ resend_enabled: true, resend_wait_hours: 48 })).toEqual({ patch: {} })
  })
  it('refuses a resend on a utility email', () => {
    expect(resendRefusal({ resend_enabled: true, resend_wait_hours: 48, postmark_stream: 'outbound' }).error).toMatch(/marketing/)
    expect(resendRefusal({ resend_enabled: true, resend_wait_hours: 48 }, { postmark_stream: 'outbound' }).error).toMatch(/marketing/)
  })
  it('refuses a resend with no wait, from the body or the stored row', () => {
    expect(resendRefusal({ resend_enabled: true }).error).toMatch(/how long to wait/)
    expect(resendRefusal({ resend_enabled: true }, { resend_wait_hours: 24 })).toEqual({ patch: {} })
  })
  it('switches a stored resend off when a save moves the campaign to the utility stream', () => {
    expect(resendRefusal({ postmark_stream: 'outbound' }, { resend_enabled: true, resend_wait_hours: 48 })).toEqual({ patch: { resend_enabled: false } })
  })
  it('leaves a save that does not touch resend alone', () => {
    expect(resendRefusal({ subject: 'Hi' }, { postmark_stream: 'broadcast' })).toEqual({ patch: {} })
  })
  it('the schema bounds the wait to 1-168 hours and the subject to 500', () => {
    expect(CampaignContentSchema.safeParse({ resend_wait_hours: 169 }).success).toBe(false)
    expect(CampaignContentSchema.safeParse({ resend_wait_hours: 0 }).success).toBe(false)
    expect(CampaignContentSchema.safeParse({ resend_wait_hours: 72, resend_subject: 'x'.repeat(501) }).success).toBe(false)
    expect(CampaignContentSchema.safeParse({ resend_enabled: true, resend_wait_hours: 72, resend_subject: 'Did you see this?' }).success).toBe(true)
  })
})
