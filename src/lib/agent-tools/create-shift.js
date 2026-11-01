// MCP.1 — `create_shift`: put one person on one shift template on one date.
// Writes through upsertShiftAssignment, the helper the roster routes and the
// in-app assistant use: it checks the template and the person belong to this
// studio, refuses a deactivated or deleted person, finds or creates the day's
// block (joining a published roster when one covers it) and records the
// caller as the one who assigned it.

import { z } from 'zod'
import { defineTool } from './registry.js'
import { isManagerAt } from '@/lib/mcp/context'
import { isRealCalendarDate } from '@/lib/schemas'
import { upsertShiftAssignment } from '@/lib/roster-write'

export default defineTool({
  name: 'create_shift',
  title: 'Create shift',
  description: 'Put a staff member on a shift template for a date at the studio (get ids from list_staff and '
    + 'list_shift_templates). This changes the live roster: confirm the person, template and date with the '
    + 'user first, and never retry on your own. If the person is already on '
    + 'that shift the call succeeds with created: false. For managers.',
  inputSchema: z.object({
    studio_id: z.string().uuid().optional().describe('A studio id; omit for the default studio.'),
    profile_id: z.string().uuid().describe('The staff member (list_staff).'),
    shift_template_id: z.string().uuid().describe('The shift template (list_shift_templates).'),
    date: z.string().refine(isRealCalendarDate, 'date must be a real calendar date, YYYY-MM-DD').describe('The shift date, YYYY-MM-DD.'),
  }),
  gate: (user, studioId) => isManagerAt(user, studioId),
  writes: true,
  run: async (input, ctx) => {
    const { db, user, studio } = ctx
    const result = await upsertShiftAssignment(db, {
      locationId: studio.id,
      profileId: input.profile_id,
      shiftTemplateId: input.shift_template_id,
      shiftDate: input.date,
      actorId: user.id,
    })
    if (result.error) {
      // A database error carries a code and is a failed call (logged, generic
      // to the client); the helper's own refusals ("profile not linked to this
      // location", "shift_template not found") are answers the client can act on.
      if (result.error.code) throw new Error(`Failed to create the shift: ${result.error.message}`)
      return { success: false, error: result.error.message }
    }
    return {
      success: true,
      created: result.created,
      studio: { id: studio.id, name: studio.name },
      date: input.date,
      template: result.template?.name ?? null,
      block_id: result.blockId,
      assignment: result.assignment,
    }
  },
})
