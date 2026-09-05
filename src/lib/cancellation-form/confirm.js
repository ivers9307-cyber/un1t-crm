// CANCEL-FORM.5 — the customer confirmation after staff decide a pause or
// membership cancellation. Before this, an approved cancellation sent the
// member NOTHING (only declines spoke); the plan's rule is that approve and
// saved both confirm, on the channel the request arrived by.
//
// Channel resolution, in order:
//   row.channel === 'email'   → transactional email (form delivered by email)
//   row.conversation_id       → in-thread (WhatsApp / Instagram) via
//                               sendAgentThreadMessage; a closed WhatsApp
//                               window falls back to the operator's
//                               confirmation template when one is configured
//   otherwise                 → { sent:false, reason:'no_channel' }
// Never throws: the decision is already recorded; losing the message must
// surface on the card, not 500 the approval.

import { renderCopy } from './copy'
import { sendTransactionalEmail } from '@/lib/postmark'
import { sendAgentThreadMessage, DEFAULT_APPROVAL_DECLINE_TEXT } from '@/lib/agent/notify'
import { sendTemplateMessage } from '@/lib/whatsapp'

const BLOCKED_EMAIL_STATUSES = ['bounced', 'complained']

/** '2026-10-05' → '5 October 2026' (en-IE, UTC-anchored so no TZ drift). */
export function formatEndDate(iso) {
  if (!iso || typeof iso !== 'string') return ''
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return iso
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString('en-IE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
}

function firstNameOf(contact) {
  return (contact?.first_name || '').trim() || String(contact?.name || '').trim().split(/\s+/)[0] || ''
}

/**
 * The text for a decision, or null when this (kind, status) says nothing to
 * the member (failed, expired, booking kinds — those have their own paths).
 */
export function outcomeMessageText({ kind, finalStatus, copy, vars, declineTemplate = null }) {
  if (kind !== 'cancellation' && kind !== 'pause') return null
  if (finalStatus === 'declined') {
    return renderCopy(String(declineTemplate || '').trim() || DEFAULT_APPROVAL_DECLINE_TEXT, vars)
  }
  if (finalStatus === 'saved') return renderCopy(copy.saved_confirmation_text, vars)
  if (finalStatus !== 'approved' && finalStatus !== 'actioned') return null
  if (kind === 'pause') return renderCopy(copy.pause_confirmation_text, vars)
  let template = copy.cancel_confirmation_text
  if (!vars.end_date) {
    // No date to promise: "will end on {end_date}" → "will end as requested"
    // rather than a dangling "on .".
    template = template.replace(/\s+on\s+\{end_date\}/g, ' as requested').replace(/\s*\{end_date\}/g, '')
  }
  return renderCopy(template, vars)
}

async function loadTemplate(db, locationId, name) {
  if (!name) return null
  const { data: rows } = await db.from('whatsapp_templates')
    .select('name, language, category, status, components')
    .eq('location_id', locationId)
    .eq('name', name)
    .order('created_at', { ascending: false })
    .limit(1)
  const t = rows?.[0] || null
  if (!t || String(t.status || '').toUpperCase() !== 'APPROVED') return null
  return t
}

function templateKeyFor(kind, finalStatus) {
  if (finalStatus === 'saved') return 'confirmation_template_saved'
  if (kind === 'pause') return 'confirmation_template_pause'
  return 'confirmation_template_cancel'
}

/**
 * @returns {Promise<{sent:boolean, channel:(string|null), reason?:string, via?:string}>}
 */
export async function sendMembershipOutcomeMessage(db, { row, finalStatus, endDate = null, startDate = null, contact, copy, locationName = '', declineTemplate = null }) {
  const details = row?.details || {}
  const endIso = endDate || details.requested_end_date || details.end_date || null
  const startIso = startDate || details.start_date || null
  const vars = {
    first_name: firstNameOf(contact),
    plan: contact?.glofox_membership_plan || 'current',
    location: locationName || '',
    end_date: formatEndDate(endIso),
    start_date: formatEndDate(startIso),
  }
  const text = outcomeMessageText({ kind: row?.kind, finalStatus, copy, vars, declineTemplate })
  if (!text) return { sent: false, channel: null, reason: 'no_message' }

  try {
    if (row.channel === 'email') {
      if (!contact?.email) return { sent: false, channel: 'email', reason: 'no_email' }
      if (BLOCKED_EMAIL_STATUSES.includes(contact.email_status || '')) return { sent: false, channel: 'email', reason: 'email_blocked' }
      const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '<br>')
      await sendTransactionalEmail({
        to: contact.email,
        subject: renderCopy(copy.email_subject, vars) || 'Your membership',
        htmlBody: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111"><p style="margin:0">${safe}</p></div>`,
        contactId: contact.id,
        locationId: row.location_id,
        tag: 'cancellation_confirmation',
      })
      return { sent: true, channel: 'email', via: 'email' }
    }

    if (row.conversation_id) {
      const channel = row.channel || 'whatsapp'
      const r = await sendAgentThreadMessage(db, { channel, conversationId: row.conversation_id, text })
      if (r?.sent) return { sent: true, channel, via: 'thread' }
      if (channel === 'whatsapp' && r?.reason === 'window_closed') {
        const tpl = await loadTemplate(db, row.location_id, copy[templateKeyFor(row.kind, finalStatus)])
        if (tpl) {
          const { data: conv } = await db.from('whatsapp_conversations')
            .select('wa_phone, contacts!contact_id ( wa_phone )')
            .eq('id', row.conversation_id)
            .maybeSingle()
          const phone = conv?.contacts?.wa_phone || conv?.wa_phone || null
          if (phone) {
            const params = [{ type: 'text', text: vars.first_name || 'there' }, { type: 'text', text: vars.end_date || ' ' }]
            await sendTemplateMessage(phone, tpl.name, tpl.language || 'en', [{ type: 'body', parameters: params }], { locationId: row.location_id })
            return { sent: true, channel, via: 'template' }
          }
        }
      }
      return { sent: false, channel, reason: r?.reason || 'send_failed' }
    }

    return { sent: false, channel: null, reason: 'no_channel' }
  } catch (e) {
    console.warn(`[cancel-form] outcome message failed for ${row?.id}: ${e?.message || e}`)
    return { sent: false, channel: row?.channel || null, reason: 'send_error' }
  }
}
