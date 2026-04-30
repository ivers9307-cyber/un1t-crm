import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'

// POST /api/whatsapp/conversations/start
// Get or create a conversation for an existing contact
export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const body = await request.json()
  const { contact_id } = body

  if (!contact_id) {
    return NextResponse.json({ error: 'contact_id is required' }, { status: 400 })
  }

  try {
    // Get the contact
    const { data: contact, error: contactErr } = await db.from('contacts')
      .select('id, phone, wa_phone, location_id')
      .eq('id', contact_id)
      .single()

    if (contactErr || !contact) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }

    // Caller must belong to the contact's location.
    const guard = assertLocationAccess(user, contact.location_id)
    if (guard) return guard

    const phone = contact.wa_phone || contact.phone
    if (!phone) {
      return NextResponse.json({ error: 'Contact has no phone number' }, { status: 400 })
    }

    // Normalize phone — strip the + for consistency with Meta's format
    const normalizedPhone = phone.startsWith('+') ? phone.slice(1) : phone

    // Check for existing conversation
    const { data: existing } = await db.from('whatsapp_conversations')
      .select('id')
      .eq('contact_id', contact_id)
      .limit(1)
      .single()

    if (existing) {
      return NextResponse.json({ success: true, conversation_id: existing.id })
    }

    // Create a new conversation
    const { data: newConv, error: convErr } = await db.from('whatsapp_conversations')
      .insert({
        location_id: contact.location_id,
        contact_id: contact.id,
        wa_phone: normalizedPhone,
        status: 'active',
      })
      .select('id')
      .single()

    if (convErr) {
      // Might be a unique constraint conflict — try fetching by phone
      const { data: byPhone } = await db.from('whatsapp_conversations')
        .select('id')
        .eq('wa_phone', normalizedPhone)
        .eq('location_id', contact.location_id)
        .single()

      if (byPhone) {
        // Link it to the contact if it wasn't already
        await db.from('whatsapp_conversations')
          .update({ contact_id: contact.id })
          .eq('id', byPhone.id)

        return NextResponse.json({ success: true, conversation_id: byPhone.id })
      }

      return NextResponse.json({ error: convErr.message }, { status: 500 })
    }

    // Update contact's wa_phone if not set
    if (!contact.wa_phone) {
      await db.from('contacts')
        .update({ wa_phone: normalizedPhone })
        .eq('id', contact.id)
    }

    return NextResponse.json({ success: true, conversation_id: newConv.id })
  } catch (err) {
    console.error('Start conversation error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
