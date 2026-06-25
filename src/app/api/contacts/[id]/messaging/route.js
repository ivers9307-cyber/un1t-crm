// GET /api/contacts/[id]/messaging
//
// MOBILE-COMPOSER.1 — the context the message composer needs to render
// for a contact: the WhatsApp 24-hour window state and the approved
// UTILITY templates (already parsed for sendability). The web composer
// gets this from the server page; the iOS app calls this endpoint so
// it never has to import web-side libraries or re-implement the
// template parsing.
//
// Access: the contact's location + a WhatsApp capability — web
// `whatsapp` permission OR the `.mobile.whatsapp` toggle, so the same
// endpoint serves both clients.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermission, hasMobilePermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { extractTemplateBody, isSendableUtilityTemplate } from '@/lib/radar-outreach'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!hasPermission(user, 'whatsapp') && !hasMobilePermission(user, 'whatsapp')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const { id: contactId } = params
  const db = createServerClient()

  const { data: contact } = await db
    .from('contacts')
    .select('id, location_id')
    .eq('id', contactId)
    .maybeSingle()
  if (!contact) {
    return NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })
  }
  const guard = assertLocationAccessOr404(user, contact.location_id)
  if (guard) return guard

  // WhatsApp 24h window — open while the most recent conversation's
  // window_expires_at is still in the future.
  const { data: convs } = await db
    .from('whatsapp_conversations')
    .select('window_expires_at')
    .eq('contact_id', contactId)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(1)
  const windowExpiresAt = convs?.[0]?.window_expires_at || null
  const windowOpen = windowExpiresAt ? new Date(windowExpiresAt) > new Date() : false

  // Approved UTILITY templates the composer can send once the window
  // is closed — parsed + filtered to the ones that are actually
  // sendable (<=1 numeric variable, no media header).
  const { data: rawTemplates } = await db
    .from('whatsapp_templates')
    .select('name, language, components, status, category')
    .eq('location_id', contact.location_id)
    .eq('category', 'UTILITY')
    .eq('status', 'APPROVED')
    .order('name', { ascending: true })
  const templates = (rawTemplates || [])
    .filter(isSendableUtilityTemplate)
    .map((t) => ({
      name: t.name,
      language: t.language || 'en',
      bodyText: extractTemplateBody(t.components).bodyText,
    }))

  return NextResponse.json({
    success: true,
    data: {
      whatsapp: { windowOpen, windowExpiresAt },
      templates,
    },
  })
}
