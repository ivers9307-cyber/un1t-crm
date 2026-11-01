// MCP.1 — `create_contact`: the in-app assistant's create_contact
// (src/app/api/assistant/chat/route.js): one insert stamped with the studio
// (never a client-supplied one), then the two best-effort hooks (Glofox lead
// provisioning, the contact-created sequences), which never fail the call.
//
// A contact's email is unique per organisation (contacts_email_org_unique,
// mig 712). On that violation the existing contact is read by email among
// the contacts homed at this organisation's studios the person may read
// through MCP (readableContactStudios), and returned as `{ existing: true, contact }`; one homed anywhere
// else is a `conflict` that names no one (a contact is never shown to someone
// who cannot read it, _contact-scope.js).

import { z } from 'zod'
import { defineTool, ToolRefusal } from './registry.js'
import { isAdminAt } from '@/lib/mcp/context'
import { hasPermissionForLocation } from '@/lib/permissions'
import { escapeLikePattern } from '@/lib/like-escape'
import { readableContactStudios } from './_contact-scope.js'

const RETURN_COLUMNS = 'id, name, email, location_id'

export default defineTool({
  name: 'create_contact',
  title: 'Create contact',
  description: 'Create a contact at the studio (a new lead). This writes to the CRM and can start automations '
    + '(Glofox lead creation, welcome sequences): confirm the details with the user first and never retry on your own. '
    + 'If someone in the organisation already has that email the call returns them with existing: true and creates '
    + 'nothing. For owners and managers with the Contacts permission.',
  inputSchema: z.object({
    studio_id: z.string().uuid().optional().describe('A studio id; omit for the default studio.'),
    name: z.string().trim().min(1).max(200).describe('Full name.'),
    email: z.string().trim().email().max(320).describe('Email address.'),
    phone: z.string().trim().max(50).optional().describe('Phone number.'),
    lead_source: z.string().trim().min(1).max(100).optional().describe('Where the lead came from; "other" when omitted.'),
  }),
  gate: (user, studioId) => isAdminAt(user, studioId) && hasPermissionForLocation(user, studioId, 'contacts'),
  writes: true,
  run: async (input, ctx) => {
    const { db, user, studio } = ctx
    const record = {
      name: input.name,
      email: input.email,
      phone: input.phone || null,
      lead_source: input.lead_source || 'other',
      location_id: studio.id,
    }
    const { data, error } = await db.from('contacts').insert(record).select(RETURN_COLUMNS).single()

    if (error?.code === '23505') {
      const orgStudioIds = readableContactStudios(user, ctx)
      // Case-insensitive equality: contacts keep the email as entered.
      const { data: existing, error: lookupError } = await db.from('contacts')
        .select(RETURN_COLUMNS)
        .in('location_id', orgStudioIds)
        .ilike('email', escapeLikePattern(input.email))
        .limit(1)
        .maybeSingle()
      if (lookupError) throw new Error(`Failed to read the existing contact: ${lookupError.message}`)
      if (!existing) throw new ToolRefusal('conflict', 'A contact with this email already exists in the organisation.')
      return { existing: true, contact: existing }
    }
    if (error || !data) throw new Error(`Failed to create the contact: ${error?.message || 'no row returned'}`)

    // AUTOMATIONS: glofox_lead_provisioning, as for an assistant-created lead.
    try {
      const { maybeProvisionLeadInGlofox } = await import('@/lib/automations/glofox-lead-provisioning')
      await maybeProvisionLeadInGlofox({ db, locationId: studio.id, contact: { ...data, phone: record.phone, lead_source: record.lead_source }, source: 'assistant' })
      const { triggerSequencesForContactCreated } = await import('@/lib/sequences/triggers')
      await triggerSequencesForContactCreated(data.id)
    } catch { /* hook never throws */ }

    return { existing: false, contact: data }
  },
})
