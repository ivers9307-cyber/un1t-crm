import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { isOrgAdminSomewhere, resolveAdminOrgId } from '@/lib/org-admin'
import { validateBody, uuidLike } from '@/lib/validate'
import { logError } from '@/lib/log'
import { connectorUrl, loadOrgMcpState } from '@/lib/mcp/org-switch'

// MCP.1 — the organisation switch for the staff MCP server (mig 801,
// org_settings.mcp_enabled, default OFF). /api/mcp refuses an organisation
// whose switch is off. Organisation admins only (a master, or an org_admin
// grant), the org-branding posture: a studio owner is not one. org_settings is
// closed to clients (mig 730), so this service-role route is the only writer.

const OrgMcpSchema = z.object({
  organization_id: uuidLike.optional(),
  enabled: z.boolean(),
})

const resolveOrgId = (user, requested) => resolveAdminOrgId(user, requested).orgId || null

// GET /api/settings/org-mcp?organization_id=xxx
export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const orgId = resolveOrgId(user, searchParams.get('organization_id'))
  if (!orgId) return NextResponse.json({ success: false, error: 'No organisation access' }, { status: 403 })

  try {
    const state = await loadOrgMcpState(createServerClient(), orgId)
    return NextResponse.json({
      success: true,
      data: { organization_id: orgId, mcp_enabled: state.mcp_enabled, connector_url: connectorUrl(), people_30d: state.people_30d },
    })
  } catch (error) {
    logError('org-mcp', 'GET failed', { error, organizationId: orgId })
    return NextResponse.json({ success: false, error: 'Could not load the agent access settings just now.' }, { status: 500 })
  }
}

// PUT /api/settings/org-mcp — switch the organisation's MCP access on or off
export async function PUT(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!isOrgAdminSomewhere(user)) {
    return NextResponse.json({ success: false, error: 'Only organisation admins can change agent access' }, { status: 403 })
  }

  const validation = await validateBody(request, OrgMcpSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const orgId = resolveOrgId(user, body.organization_id)
  if (!orgId) return NextResponse.json({ success: false, error: 'No organisation access' }, { status: 403 })

  const db = createServerClient()
  // updated_by: mig 733's audit trigger reads it for a service-role write.
  const { data, error } = await db.from('org_settings')
    .upsert({
      organization_id: orgId,
      mcp_enabled: body.enabled,
      updated_at: new Date().toISOString(),
      updated_by: user.id,
    }, { onConflict: 'organization_id' })
    .select('mcp_enabled')
    .single()

  if (error) {
    logError('org-mcp', 'PUT failed', { error, organizationId: orgId })
    return NextResponse.json({ success: false, error: 'Could not save the agent access switch just now.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, data: { mcp_enabled: data.mcp_enabled === true } })
}
