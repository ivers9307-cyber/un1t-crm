// GET /api/radar-outreach/templates
//
// RADAR-OUTREACH.1 — the WhatsApp templates an operator can pick for
// one-click radar outreach. Returns the APPROVED, UTILITY-category
// templates for the caller's active location (synced into the local
// whatsapp_templates table from Meta), each with a body preview and a
// `sendable` flag — a template with more than one variable, a named
// variable or a media header can't be auto-filled in v1.
//
// UTILITY-only by construction: a marketing template can never appear
// here, so radar outreach is always a utility message. Read-only.
//
// Access: churn_radar OR lead_radar — both radars share this picker.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { extractTemplateBody, isSendableUtilityTemplate } from '@/lib/radar-outreach'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!hasPermission(user, 'churn_radar') && !hasPermission(user, 'lead_radar')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
  }

  const db = createServerClient()
  const { data, error } = await db
    .from('whatsapp_templates')
    .select('name, language, category, status, components')
    .eq('location_id', locationId)
    .eq('category', 'UTILITY')
    .eq('status', 'APPROVED')
    .order('name', { ascending: true })
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  const templates = (data || []).map((t) => {
    const { bodyText, varCount } = extractTemplateBody(t.components)
    return {
      name: t.name,
      language: t.language || 'en',
      bodyText,
      varCount,
      sendable: isSendableUtilityTemplate(t),
    }
  })

  return NextResponse.json({ success: true, data: { templates } })
}
