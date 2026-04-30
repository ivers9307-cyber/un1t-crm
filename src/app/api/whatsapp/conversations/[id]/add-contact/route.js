import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { email as emailSchema, phone as phoneSchema, leadStatusSchema } from '@/lib/schemas'

const AddContactSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  first_name: z.string().max(100).optional(),
  email: emailSchema.nullable().optional(),
  phone: phoneSchema.nullable().optional(),
  lead_status: leadStatusSchema.optional(),
  pipeline_stage: z.string().max(100).optional(),
  add_to_pipeline: z.boolean().optional(),
})

// POST /api/whatsapp/conversations/[id]/add-contact
// Promotes an unknown WhatsApp sender to a full contact, optionally adds to pipeline
export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, AddContactSchema)
  if (!validation.ok) return validation.response
  const { name, first_name, email, phone, lead_status, pipeline_stage, add_to_pipeline } = validation.data
  const db = createServerClient()
  const conversationId = params.id

  try {
    // Get the conversation
    const { data: conversation, error: convErr } = await db.from('whatsapp_conversations')
      .select('id, contact_id, wa_phone, wa_profile_name, location_id')
      .eq('id', conversationId)
      .single()

    if (convErr || !conversation) {
      return NextResponse.json({ success: false, error: 'Conversation not found' }, { status: 404 })
    }

    // Caller must belong to the conversation's location.
    const guard = assertLocationAccess(user, conversation.location_id)
    if (guard) return guard

    // If already linked to a contact, return that
    if (conversation.contact_id) {
      return NextResponse.json({
        success: true,
        contact_id: conversation.contact_id,
        already_linked: true,
      })
    }

    // Create the contact
    const contactData = {
      name: name || conversation.wa_profile_name || conversation.wa_phone,
      first_name: first_name || name?.split(' ')[0] || null,
      email: email || null,
      phone: phone || conversation.wa_phone,
      wa_phone: conversation.wa_phone,
      lead_source: 'whatsapp',
      lead_status: lead_status || 'new_lead',
      location_id: conversation.location_id,
    }

    const { data: contact, error: contactErr } = await db.from('contacts')
      .insert(contactData)
      .select('id')
      .single()

    if (contactErr) {
      console.error('Failed to create contact:', contactErr)
      return NextResponse.json({ success: false, error: contactErr.message }, { status: 500 })
    }

    // Link the conversation to the new contact
    await db.from('whatsapp_conversations')
      .update({ contact_id: contact.id })
      .eq('id', conversationId)

    // Link all existing messages in this conversation to the new contact
    await db.from('whatsapp_messages')
      .update({ contact_id: contact.id })
      .eq('conversation_id', conversationId)
      .is('contact_id', null)

    // Optionally add to pipeline
    if (add_to_pipeline) {
      await db.from('pipeline').insert({
        contact_id: contact.id,
        location_id: conversation.location_id,
        stage: pipeline_stage || 'new',
      })

      // Log to timeline
      await db.from('activities').insert({
        contact_id: contact.id,
        type: 'note',
        subject: 'Contact created from WhatsApp',
        note: 'Contact created from WhatsApp conversation and added to pipeline.',
      })
    } else {
      // Just log the creation
      await db.from('activities').insert({
        contact_id: contact.id,
        type: 'note',
        subject: 'Contact created from WhatsApp',
        note: 'Contact created from WhatsApp conversation.',
      })
    }

    // Retroactively log WhatsApp messages to the contact's timeline
    const { data: messages } = await db.from('whatsapp_messages')
      .select('id, direction, body, message_type, sent_at')
      .eq('conversation_id', conversationId)
      .order('sent_at', { ascending: true })

    if (messages?.length) {
      const activities = messages.map(msg => ({
        contact_id: contact.id,
        type: msg.direction === 'inbound' ? 'whatsapp_received' : 'whatsapp_sent',
        subject: msg.direction === 'inbound' ? 'WhatsApp received' : 'WhatsApp sent',
        note: `WhatsApp: ${(msg.body || `[${msg.message_type}]`).substring(0, 100)}`,
        created_at: msg.sent_at,
      }))

      await db.from('activities').insert(activities)

      // Update contact WA stats
      const inbound = messages.filter(m => m.direction === 'inbound').length
      const outbound = messages.filter(m => m.direction === 'outbound').length
      await db.from('contacts').update({
        last_wa_message_at: messages[messages.length - 1].sent_at,
        total_wa_received: inbound,
        total_wa_sent: outbound,
      }).eq('id', contact.id)
    }

    return NextResponse.json({
      success: true,
      contact_id: contact.id,
      already_linked: false,
    })
  } catch (err) {
    console.error('Add contact error:', err)
    return NextResponse.json({ success: false, error: err.message }, { status: 500 })
  }
}
