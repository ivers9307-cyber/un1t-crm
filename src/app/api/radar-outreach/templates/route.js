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
// Access: churn_radar (the Lead Radar that shared this picker is retired, CONTACTLOG.2).

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { hasPermission } from '@/lib/permissions'
import { extractTemplateBody, isSendableUtilityTemplate } from '@/lib/radar-outreach'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// churn_radar at the active studio ('Forbidden' 403), then the active studio
// (400), in that order and with these texts, as before.
export const GET = withAuth(
  { permission: null, location: false, allow: (user) => hasPermission(user, 'churn_radar'), forbiddenMessage: 'Forbidden' },
  async ({ user, db }) => {
    const locationId = user.activeLocation?.id
    if (!locationId) {
      return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
    }

    const { data, error } = await db
      .from('whatsapp_templates')
      .select('name, language, category, status, components')
      .eq('location_id', locationId)
      .eq('category', 'UTILITY')
      .eq('status', 'APPROVED')
      .order('name', { ascending: true })
    if (error) {
      logError('radar-outreach', 'template read failed', { locationId, err: error })
      return NextResponse.json({ success: false, error: 'Could not load the templates. Try again.' }, { status: 500 })
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
  },
)
