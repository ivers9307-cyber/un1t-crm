import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess, hasRoleAtLocation } from '@/lib/auth'
import { MANAGER_ROLES } from '@/lib/schemas'
import { maskConnectionRow, buildConnectionPatch, SUPPORTED_PLATFORMS } from '@/lib/agent/channels'
import { validateBody } from '@/lib/validate'
import { canEditMiaSettings } from '@/lib/agent/settings-access'

// MIANITS (Richard's call, 30 Sep) — Mia's on/off switch for a channel is
// owner-only, like Mia's settings. agent_enabled defaults to false (mig 407),
// so only a create that switches her ON is a change to gate.
const MIA_SWITCH_OWNER_ONLY = 'Only an owner can switch the customer agent on or off for a channel.'

const ChannelConnectionSchema = z.object({
  platform: z.string().min(1),
  label: z.string().max(200).optional(),
  external_account_id: z.string().max(200).optional(),
  page_id: z.string().max(200).optional(),
  app_id: z.string().max(200).optional(),
  display_name: z.string().max(200).optional(),
  is_active: z.boolean().optional(),
  agent_enabled: z.boolean().optional(),
  access_token: z.string().max(2000).optional(),
  app_secret: z.string().max(500).optional(),
})

// Staff-facing names for the 409 copy (SUPPORTED_PLATFORMS).
const PLATFORM_LABELS = { instagram: 'Instagram', messenger: 'Messenger' }
const withArticle = (label) => `${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label}`

// GET /api/locations/[id]/channels — list channel connections for a
// location, every secret presence-only.
//
// SECFIX.3a (review S1) — this was MEMBERSHIP ONLY, and maskConnectionRow
// masked the two token columns to their last 6 characters and left `config`
// alone, where the registry keeps a Glofox connection's api_token. So any
// plain staff member of a studio could read its Glofox API token in clear.
// Now: the same gate as POST/PATCH/DELETE (membership, then MANAGER_ROLES AT
// params.id; whoever may replace a token may see that one is set; the
// Integrations cards that call this are owner/master screens), and every
// secret-named key at any depth comes back as the mask, never a character.
export async function GET(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const locationId = params.id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!hasRoleAtLocation(user, locationId, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const db = createServerClient()
  const { data, error } = await db.from('channel_connections')
    .select('*')
    .eq('location_id', locationId)
    .order('platform', { ascending: true })
    .order('updated_at', { ascending: false })
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  // MIANITS — whether this caller may switch Mia on or off for a channel, so
  // the card greys the switch out for anyone the writes would refuse.
  return NextResponse.json({
    success: true,
    connections: (data || []).map(maskConnectionRow),
    can_edit_agent: canEditMiaSettings(user, locationId),
  })
}

// POST /api/locations/[id]/channels — add a connection (never replaces an active one: 409).
//
// LOCFIX-ROLEGATE.1 — the role is judged AT params.id, never via `user.role`.
// That field resolves at the caller's ACTIVE location (with a
// highest-role-anywhere fallback in auth.js), while this write lands on the
// path-param location — so the old single `allowed` boolean
// (`user.role === 'master' || (MANAGER_ROLES.includes(user.role) && member)`)
// let a manager at studio A who is plain STAFF at studio B attach their own
// Instagram account to B and take over B's DMs, with a 200: membership was
// judged at the target but the ROLE was judged at A.
//
// The boolean is split into the two questions it was conflating, in the #1589
// email-copy order: MEMBERSHIP (assertLocationAccess) then the role AT THAT
// TARGET. The membership half now answers the guard's own copy — "Forbidden —
// location not in your assignments" instead of the generic "Forbidden" — an
// intended, more informative change; the ROLE miss keeps this route's
// "Forbidden". Tier is MANAGER_ROLES (head_coach INCLUDED), deliberately wider
// than the ['master','owner','manager'] the stripe-connect routes use.
// CHANNELREAD.1 — a 23505 means "already connected" only when it is THIS
// partial unique index (mig 230). The code alone is any unique violation on
// the table (a primary-key clash, a future index), and calling that
// "already connected" would send the operator to Update over a failure that
// has nothing to do with an existing row. PostgREST carries the index name in
// `message` ("... violates unique constraint \"idx_...\""); `details` and
// `constraint` are checked too in case the shape differs.
const ONE_ACTIVE_INDEX = 'idx_channel_connections_one_active'
function isOneActiveConflict(error) {
  if (error?.code !== '23505') return false
  return [error.message, error.details, error.constraint]
    .some((v) => typeof v === 'string' && v.includes(ONE_ACTIVE_INDEX))
}

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const locationId = params.id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!hasRoleAtLocation(user, locationId, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const validation = await validateBody(request, ChannelConnectionSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  if (body.agent_enabled === true && !canEditMiaSettings(user, locationId)) {
    return NextResponse.json({ success: false, error: MIA_SWITCH_OWNER_ONLY }, { status: 403 })
  }
  if (!SUPPORTED_PLATFORMS.includes(body.platform)) {
    return NextResponse.json({ success: false, error: `platform must be one of: ${SUPPORTED_PLATFORMS.join(', ')}` }, { status: 400 })
  }

  const db = createServerClient()
  const patch = buildConnectionPatch(body)

  // CHANNELREAD.1 — POST CREATES; it never REPLACES. It used to deactivate
  // the active row for (location, platform) and insert the new one, so the
  // Instagram card, after a failed read made it believe nothing was
  // connected, swapped a working connection for whatever was typed into an
  // empty form. Now the partial unique index (mig 230,
  // idx_channel_connections_one_active) is the refusal, atomically: an
  // existing active row answers 23505 → 409. Replacing an account is the
  // explicit PATCH ("Update Instagram") or Disconnect then Connect.
  if (patch.is_active !== false) patch.is_active = true

  const { data, error } = await db.from('channel_connections').insert({
    location_id: locationId,
    updated_by: user.id,
    ...patch,
  }).select().single()
  if (error) {
    if (isOneActiveConflict(error)) {
      return NextResponse.json({
        success: false,
        code: 'already_connected',
        // The card reloads on a 409 and switches to Update itself (keeping
        // what was typed), so the copy never asks for a reload.
        error: `This location already has ${withArticle(PLATFORM_LABELS[body.platform] || body.platform)} connection. Use Update to change its token.`,
      }, { status: 409 })
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, connection: maskConnectionRow(data) })
}
