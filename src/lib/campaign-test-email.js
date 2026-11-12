// MCPEMAIL.1 — the test email `send_email_for_approval` sends to the person who
// asked for it, and the parser for the time a campaign is to go out.
//
// The body goes through the same four steps the real send runs, in the same
// order (src/lib/campaign-sender.js: applyMergeTags → appendUnsubscribeFooter
// → prependViewInBrowserLink → injectPreheader), so what is tested is what is
// sent. Its unsubscribe, preferences and view-in-browser links are
// placeholders that act on no contact. A staff banner above it carries the
// approve link, which appears nowhere but in this email.

import { applyMergeTags, appendUnsubscribeFooter } from '@/lib/postmark'
import { prependViewInBrowserLink } from '@/lib/campaign-web-view'
import { injectPreheader } from '@/lib/email-content'
import { escapeHtml } from '@/lib/html-escape'
import { zoneOfLocation, zonedWallClockToInstant, instantToZonedParts } from '@/lib/location-time'

export const SEND_AT_MAX_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000
const SEND_AT_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/
const pad2 = (n) => String(n).padStart(2, '0')

/**
 * A studio wall-clock time 'YYYY-MM-DDTHH:mm' → the instant it names.
 * Refused: a malformed value, a time the zone skips (the spring-forward
 * hour), a time not in the future, and one more than 90 days out.
 */
export function parseSendAt(value, zone, nowMs) {
  const m = SEND_AT_RE.exec(String(value ?? ''))
  if (!m) return { ok: false, message: 'send_at must be a studio date and time as YYYY-MM-DDTHH:mm.' }
  const ms = zonedWallClockToInstant(m[1], m[2], zone)
  if (ms == null) return { ok: false, message: 'send_at is not a real date and time.' }
  const back = instantToZonedParts(ms, zone)
  if (`${back.dateKey}T${pad2(back.h)}:${pad2(back.mi)}` !== value) {
    return { ok: false, message: `${value} does not exist in ${zone} (the clocks change then). Pick another time.` }
  }
  if (ms <= nowMs) return { ok: false, message: 'send_at must be in the future.' }
  if (ms > nowMs + SEND_AT_MAX_DAYS * DAY_MS) {
    return { ok: false, message: `send_at can be at most ${SEND_AT_MAX_DAYS} days from now.` }
  }
  return { ok: true, at: new Date(ms) }
}

function personAsContact({ name, email }) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean)
  return {
    id: null,
    name: parts.join(' '),
    first_name: parts[0] || '',
    last_name: parts.slice(1).join(' '),
    email: email || '',
    phone: null,
    pipeline_stage_slug: null,
  }
}

function banner({ studio, campaign, audienceEligible, sendsAs, sendAtLabel, approveUrl }) {
  const n = Number(audienceEligible) || 0
  const people = `${n.toLocaleString('en-IE')} ${n === 1 ? 'person' : 'people'}`
  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif"
  const row = (label, value) => `<tr><td style="font-family:${font};font-size:14px;color:#111111;padding:2px 0;">`
    + `<strong>${label}:</strong> ${escapeHtml(value ?? '')}</td></tr>`
  return `<table data-campaign-test-banner="1" role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" `
    + `style="border-collapse:collapse;background:#fff7e0;border-bottom:2px solid #e0b000;"><tr><td align="center" style="padding:16px;">`
    + `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;max-width:600px;width:100%;">`
    + `<tr><td style="font-family:${font};font-size:16px;font-weight:bold;color:#111111;padding-bottom:6px;">`
    + `Test email: this campaign has not been sent</td></tr>`
    + row('Campaign', campaign?.name)
    + row('Studio', studio?.name)
    + `<tr><td style="font-family:${font};font-size:14px;color:#111111;padding:2px 0;"><strong>This will go to ${escapeHtml(people)}</strong></td></tr>`
    + row('Sends as', sendsAs)
    + row('When', sendAtLabel)
    + `<tr><td style="padding-top:12px;"><a href="${escapeHtml(approveUrl)}" `
    + `style="display:inline-block;background:#111111;color:#ffffff;font-family:${font};font-size:15px;font-weight:bold;text-decoration:none;padding:10px 18px;border-radius:4px;">`
    + `Review and approve in the CRM</a></td></tr>`
    + `<tr><td style="font-family:${font};font-size:12px;color:#555555;padding-top:8px;">`
    + `The link opens the CRM, where you sign in and press the button to send. It works once and expires in 24 hours. `
    + `Links in the email below are test links.</td></tr>`
    + `</table></td></tr></table>`
}

function prependInsideBody(html, chunk) {
  const open = html.match(/<body\b[^>]*>/i)
  if (!open) return chunk + html
  const at = open.index + open[0].length
  return html.slice(0, at) + chunk + html.slice(at)
}

/**
 * The test email for one campaign. `emailCopy` is the studio's
 * company_settings email copy (the view-in-browser label); omitted means the
 * defaults, as for the real send.
 *
 * @returns {{ subject: string, html: string }}
 */
export function buildCampaignTestEmail({
  campaign, studio, person, branding, approveUrl, audienceEligible, sendsAs, sendAtLabel, appUrl, emailCopy = null,
}) {
  const contact = personAsContact(person ?? {})
  const unsubscribeUrl = `${appUrl}/unsubscribe/test-token`
  const preferenceUrl = `${appUrl}/preferences/test-token`
  // Not a signed token, so the hosted-copy route resolves nothing for it.
  const viewUrl = `${appUrl}/view-email/test-token`
  const extras = {
    location_name: studio?.name || '',
    company_name: branding?.companyName || '',
    unsubscribe_url: unsubscribeUrl,
    preference_url: preferenceUrl,
    zone: zoneOfLocation(studio),
  }

  const merged = applyMergeTags(campaign.html_content, contact, extras)
  const withFooter = appendUnsubscribeFooter(merged, unsubscribeUrl)
  const withWebView = prependViewInBrowserLink(withFooter, viewUrl, emailCopy)
  const previewText = campaign.preview_text
    ? applyMergeTags(campaign.preview_text, contact, {
      location_name: extras.location_name, company_name: extras.company_name, zone: extras.zone,
    })
    : null
  const body = previewText ? injectPreheader(withWebView, previewText) : withWebView

  const html = prependInsideBody(body, banner({ studio, campaign, audienceEligible, sendsAs, sendAtLabel, approveUrl }))
  const subject = '[TEST] ' + applyMergeTags(campaign.subject || '', contact, extras)
  return { subject, html }
}
