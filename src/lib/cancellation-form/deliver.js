// CANCEL-FORM.4 — the pure halves of link delivery. The route owns I/O.

import { renderCopy } from './copy'
import { dynamicUrlButtonIndex } from '@/lib/whatsapp-template-buttons'

export function firstNameOf(contact) {
  return (contact?.first_name || '').trim() || String(contact?.name || '').trim().split(/\s+/)[0] || ''
}

/** The placeholder values for a link send. */
export function linkVars({ contact, locationName, url }) {
  return {
    first_name: firstNameOf(contact),
    plan: contact?.glofox_membership_plan || 'current',
    location: locationName || '',
    link: url,
  }
}

/**
 * Subject / email body / WhatsApp text / button label for a link send.
 * `message` is an optional one-off operator override of the body: it is
 * rendered with the same placeholders, and if it forgot {link} the URL is
 * appended to the email (WhatsApp carries the URL on its button instead).
 */
export function renderLinkTexts(copy, vars, { message } = {}) {
  const override = typeof message === 'string' && message.trim() ? message.trim() : null
  let emailBody
  let whatsappText
  if (override) {
    const hasLink = /\{link\}/.test(override)
    emailBody = renderCopy(hasLink ? override : `${override}\n\n{link}`, vars)
    whatsappText = renderCopy(override.replace(/\s*\{link\}\s*/g, ' ').trim(), vars)
  } else {
    emailBody = renderCopy(copy.email_body, vars)
    whatsappText = renderCopy(copy.whatsapp_text, vars)
  }
  return {
    emailSubject: renderCopy(copy.email_subject, vars),
    emailBody,
    whatsappText,
    whatsappButtonText: (renderCopy(copy.whatsapp_button_text, vars) || 'Open form').slice(0, 20),
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Minimal transactional HTML: escaped text with <br>s, the link rendered as a
 * button AND left as a plain visible line (some clients strip styled
 * anchors; the outbound sanitiser strips <style>, so everything is inline).
 */
export function buildLinkEmailHtml(text, url, { buttonText = 'Open the form' } = {}) {
  const safeUrl = escapeHtml(url)
  const body = escapeHtml(text).replace(/\r?\n/g, '<br>')
  return [
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111">',
    `<p style="margin:0 0 16px">${body}</p>`,
    `<p style="margin:0 0 16px"><a href="${safeUrl}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:600">${escapeHtml(buttonText)}</a></p>`,
    `<p style="margin:0;font-size:12px;color:#666">If the button does not work, copy this link into your browser:<br><a href="${safeUrl}" style="color:#666">${safeUrl}</a></p>`,
    '</div>',
  ].join('')
}

/**
 * A dynamic-URL template may only be used when its button link is rooted on
 * the host we build form links on: `${base}/cancel/{{1}}`. Otherwise the
 * token would be handed to some other origin.
 */
export function templateUrlPrefixOk(template, baseUrl) {
  const comps = template?.components || []
  const idx = dynamicUrlButtonIndex(comps)
  if (idx < 0) return false
  const buttons = (comps.find((c) => String(c?.type || '').toUpperCase() === 'BUTTONS')?.buttons) || []
  const url = String(buttons[idx]?.url || '').trim()
  const base = String(baseUrl || '').replace(/\/+$/, '')
  if (!base) return false
  return url === `${base}/cancel/{{1}}`
}
