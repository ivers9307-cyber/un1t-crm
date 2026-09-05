// /api/contacts/[id]/cancellation-form — staff sends a member the link to
// the membership cancellation form (CANCEL-FORM.4).
//
// GET  → what the send modal needs: the latest issued link (sent / opened /
//        submitted state), which channels can carry it right now, and a
//        rendered preview of the operator's copy.
// POST { channel: 'email' | 'whatsapp', message? }
//      → mints a single-use link (lib/cancellation-form/links), delivers it,
//        logs the send, returns { linkId, channel, expiresAt }.
//
// Authorization: session + the CHANNEL permission the existing 1:1 send
// routes use (web `email`/`whatsapp` or the mobile toggles) + the contact's
// location (assertLocationAccessOr404, the IDOR guard).
//
// Deliberately NOT gated on marketing consent. /api/contacts/[id]/email
// refuses anyone off the location's marketing list, which is right for an
// ad-hoc note; a cancellation form is a SERVICE message the member asked for
// (Meta's and Postmark's transactional posture), so this route checks only
// hard reputation (bounced / complained) and the presence of an address.
//
// WhatsApp: inside the 24h window the link goes as a cta_url button (no
// template needed). Outside it, an approved UTILITY template with a dynamic
// URL button is required (settings cancellation_form.whatsapp_template_name)
// — and its URL must be rooted on OUR form host, or the token would be
// handed to another origin. Without a usable template the route answers 409
// { window_expired, needs_template } so the modal can offer email instead.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermission, hasMobilePermission } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { getAppUrl } from '@/lib/app-url'
import { sendTransactionalEmail } from '@/lib/postmark'
import { sendCtaUrlMessage, sendTemplateMessage, isWindowOpen, buildTemplateComponents, renderTemplateBody } from '@/lib/whatsapp'
import { URL_BUTTON_MAPPING_KEY } from '@/lib/whatsapp-template-buttons'
import { getOrCreateContactConversation } from '@/lib/whatsapp-conversations'
import { manualTakeoverPatch } from '@/lib/agent/core'
import { issueLink, revokeLink, latestLinkForContact } from '@/lib/cancellation-form/links'
import { resolveCancellationFormCopy } from '@/lib/cancellation-form/copy'
import { linkVars, renderLinkTexts, buildLinkEmailHtml, templateUrlPrefixOk } from '@/lib/cancellation-form/deliver'

export const runtime = 'nodejs'

const SendSchema = z.object({
  channel: z.enum(['email', 'whatsapp']),
  message: z.string().max(2000).optional(),
})

const BLOCKED_EMAIL_STATUSES = ['bounced', 'complained']
const CONTACT_COLUMNS = 'id, name, first_name, email, email_status, phone, wa_phone, location_id, glofox_membership_plan'

function channelPermitted(user, channel) {
  return hasPermission(user, channel) || hasMobilePermission(user, channel)
}

async function loadContext(db, contactId) {
  const { data: contact, error } = await db.from('contacts').select(CONTACT_COLUMNS).eq('id', contactId).single()
  if (error || !contact) return { contact: null }
  const { data: loc } = await db.from('locations').select('name, settings').eq('id', contact.location_id).maybeSingle()
  const copy = resolveCancellationFormCopy(loc?.settings?.customer_agent?.cancellation_form)
  const baseUrl = copy.public_base_url || getAppUrl()
  return { contact, locationName: loc?.name || '', copy, baseUrl }
}

async function loadTemplate(db, locationId, name) {
  if (!name) return null
  const { data: rows } = await db.from('whatsapp_templates')
    .select('name, language, category, status, components, header_media_url')
    .eq('location_id', locationId)
    .eq('name', name)
    .order('created_at', { ascending: false })
    .limit(1)
  return rows?.[0] || null
}

function templateUsable(template, baseUrl) {
  if (!template) return false
  if (String(template.status || '').toUpperCase() !== 'APPROVED') return false
  if (String(template.category || '').toUpperCase() !== 'UTILITY') return false
  return templateUrlPrefixOk(template, baseUrl)
}

export async function GET(request, props) {
  const { id: contactId } = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!channelPermitted(user, 'email') && !channelPermitted(user, 'whatsapp')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const db = createServerClient()
  const ctx = await loadContext(db, contactId)
  if (!ctx.contact) return NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, ctx.contact.location_id)
  if (guard) return guard
  const { contact, locationName, copy, baseUrl } = ctx

  const [latest, template] = await Promise.all([
    latestLinkForContact(db, contact.id),
    loadTemplate(db, contact.location_id, copy.whatsapp_template_name),
  ])
  // Window state without creating a conversation: read the newest thread.
  const { data: convs } = await db.from('whatsapp_conversations')
    .select('id, window_expires_at')
    .eq('contact_id', contact.id)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(1)
  const conversation = convs?.[0] || null

  const emailOk = !!contact.email && !BLOCKED_EMAIL_STATUSES.includes(contact.email_status || '')
  const hasPhone = !!(contact.wa_phone || contact.phone)
  const windowOpen = !!conversation && isWindowOpen(conversation)
  const templateReady = templateUsable(template, baseUrl)
  const texts = renderLinkTexts(copy, linkVars({ contact, locationName, url: '{link}' }))

  return NextResponse.json({
    success: true,
    data: {
      latest,
      can: {
        email: emailOk && channelPermitted(user, 'email'),
        whatsapp: hasPhone && channelPermitted(user, 'whatsapp') && (windowOpen || templateReady),
        whatsapp_window_open: windowOpen,
        whatsapp_template_ready: templateReady,
        has_phone: hasPhone,
        has_email: !!contact.email,
        email_blocked: !!contact.email && !emailOk,
      },
      preview: {
        email_subject: texts.emailSubject,
        email_body: texts.emailBody,
        whatsapp_text: texts.whatsappText,
        whatsapp_button_text: texts.whatsappButtonText,
      },
    },
  })
}

export async function POST(request, props) {
  const { id: contactId } = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const v = await validateBody(request, SendSchema)
  if (!v.ok) return v.response
  const { channel, message } = v.data

  const db = createServerClient()
  const ctx = await loadContext(db, contactId)
  if (!ctx.contact) return NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, ctx.contact.location_id)
  if (guard) return guard
  if (!channelPermitted(user, channel)) {
    return NextResponse.json({ success: false, error: `Forbidden — ${channel} not enabled at this location for your role` }, { status: 403 })
  }
  const { contact, locationName, copy, baseUrl } = ctx

  // ── Pre-flight per channel (before a link is minted) ─────────────────
  let conversation = null
  let waPhone = null
  let template = null
  if (channel === 'email') {
    if (!contact.email) return NextResponse.json({ success: false, error: 'Contact has no email address on file' }, { status: 400 })
    if (BLOCKED_EMAIL_STATUSES.includes(contact.email_status || '')) {
      return NextResponse.json({ success: false, error: `Cannot send — this address has ${contact.email_status}.` }, { status: 400 })
    }
  } else {
    if (!contact.wa_phone && !contact.phone) {
      return NextResponse.json({ success: false, error: 'Contact has no phone number on file' }, { status: 400 })
    }
    const opened = await getOrCreateContactConversation(db, contact)
    if (!opened.ok) return NextResponse.json({ success: false, error: opened.error }, { status: opened.status })
    conversation = opened.conversation
    waPhone = opened.waPhone
    if (!isWindowOpen(conversation)) {
      template = await loadTemplate(db, contact.location_id, copy.whatsapp_template_name)
      if (!templateUsable(template, baseUrl)) {
        return NextResponse.json({
          success: false,
          error: 'The 24-hour WhatsApp window has closed and no approved cancellation-form template is set up for this host. Send it by email, or configure the template under Settings → Customer agent.',
          window_expired: true,
          needs_template: true,
        }, { status: 409 })
      }
    }
  }

  // ── Mint the link ────────────────────────────────────────────────────
  const issued = await issueLink(db, {
    contactId: contact.id,
    locationId: contact.location_id,
    issuedBy: user.id,
    channel,
    conversationId: conversation?.id || null,
    baseUrl,
  })
  if (!issued.ok) return NextResponse.json({ success: false, error: issued.error }, { status: 500 })

  const texts = renderLinkTexts(copy, linkVars({ contact, locationName, url: issued.url }), { message })

  // ── Deliver ──────────────────────────────────────────────────────────
  let logNote = texts.emailBody
  try {
    if (channel === 'email') {
      await sendTransactionalEmail({
        to: contact.email,
        subject: texts.emailSubject,
        htmlBody: buildLinkEmailHtml(texts.emailBody, issued.url, { buttonText: texts.whatsappButtonText }),
        contactId: contact.id,
        locationId: contact.location_id,
        tag: 'cancellation_form',
      })
    } else {
      let result
      let messageType
      let body
      let templateName = null
      if (!template) {
        result = await sendCtaUrlMessage(waPhone, { bodyText: texts.whatsappText, buttonText: texts.whatsappButtonText, url: issued.url }, { locationId: contact.location_id })
        messageType = 'interactive'
        body = `${texts.whatsappText}\n${issued.url}`
      } else {
        // The token rides the dynamic URL button; resolveContactField falls
        // through to the literal because 'TOKEN' is not a contact field.
        const components = buildTemplateComponents(template, contact, { [URL_BUTTON_MAPPING_KEY]: issued.token }, null, { locationId: contact.location_id })
        result = await sendTemplateMessage(waPhone, template.name, template.language || 'en', components, { locationId: contact.location_id })
        messageType = 'template'
        templateName = template.name
        body = renderTemplateBody(template, contact, {}, { locationId: contact.location_id }) || `[Template: ${template.name}]`
      }
      logNote = body
      const nowIso = new Date().toISOString()
      const { error: msgErr } = await db.from('whatsapp_messages').insert({
        conversation_id: conversation.id,
        contact_id: contact.id,
        location_id: contact.location_id,
        wa_message_id: result.messageId,
        direction: 'outbound',
        message_type: messageType,
        body,
        template_name: templateName,
        status: 'sent',
        sent_by: user.id,
        sent_at: nowIso,
      })
      if (msgErr) console.error(`[cancel-form] whatsapp_messages insert failed: ${msgErr.message}`)
      // A staff send is a human take-over: pause Mia in this thread (same as
      // the composer and the inbox).
      const { error: convErr } = await db.from('whatsapp_conversations').update({
        last_message_at: nowIso,
        last_message_direction: 'outbound',
        last_message_preview: body.substring(0, 100),
        ...manualTakeoverPatch(conversation.agent_handed_off_at),
      }).eq('id', conversation.id).select('id')
      if (convErr) console.error(`[cancel-form] conversation update failed: ${convErr.message}`)
    }
  } catch (e) {
    await revokeLink(db, issued.linkId, e?.message || 'send failed')
    return NextResponse.json({ success: false, error: e?.message || 'Failed to send the form link' }, { status: 502 })
  }

  // Timeline activity — best-effort, the link is already delivered.
  const { error: actErr } = await db.from('activities').insert({
    contact_id: contact.id,
    location_id: contact.location_id,
    type: 'cancellation_form_sent',
    subject: `Cancellation form sent by ${channel === 'email' ? 'email' : 'WhatsApp'}`,
    note: logNote,
    created_by: user.id,
  })
  if (actErr) console.warn(`[cancel-form] activity insert failed: ${actErr.message}`)

  return NextResponse.json({ success: true, data: { linkId: issued.linkId, channel, expiresAt: issued.expiresAt } })
}
