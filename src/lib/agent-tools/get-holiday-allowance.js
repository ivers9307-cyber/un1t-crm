// MCP.1 — `get_holiday_allowance`: holiday days for a year. Anyone may ask
// about themselves; another person only for a manager, and only for someone
// with a membership at the studio (a bare profile_id would read any tenant's
// allowance). Read through the same helpers the allowances route uses, so a
// person with no stored row gets their real entitlement, not a default.

import { z } from 'zod'
import { defineTool } from './registry.js'
import { isManagerAt } from '@/lib/mcp/context'
import { parseAllowanceYear } from '@/lib/allowance-year'
import { getHolidayAllowance, getPendingHolidayDays } from '@/lib/time-off-leave'

export default defineTool({
  name: 'get_holiday_allowance',
  title: 'Holiday allowance',
  description: 'Holiday allowance for a calendar year: entitlement_days (this year\'s allowance plus carried-over days), '
    + 'used_days, pending_days (requested, not yet decided) and remaining_days (entitlement minus used; pending is '
    + 'not deducted). Omit profile_id for the caller\'s own allowance; another person\'s is for managers, and only '
    + 'for someone who works at the studio. year defaults to this year on the studio\'s calendar.',
  inputSchema: z.object({
    studio_id: z.string().uuid().optional().describe('A studio id; omit for the default studio.'),
    profile_id: z.string().uuid().optional().describe('A staff member\'s id (list_staff); omit for the caller.'),
    year: z.union([z.number().int(), z.string()]).optional().describe('Four-digit year; omit for this year.'),
  }).superRefine((value, ctx) => {
    const { error } = parseAllowanceYear(value.year)
    if (error) ctx.addIssue({ code: 'custom', path: ['year'], message: error })
  }),
  gate: () => true,
  run: async (input, ctx) => {
    const { db, user, studio, zone } = ctx
    const { year } = parseAllowanceYear(input.year, zone)
    const profileId = input.profile_id ?? user.id

    if (profileId !== user.id) {
      if (!isManagerAt(user, studio.id)) return { error: 'Only a manager can view another person\'s holiday allowance.' }
      const { data: link, error: linkError } = await db.from('profile_locations')
        .select('profile_id')
        .eq('profile_id', profileId)
        .eq('location_id', studio.id)
        .maybeSingle()
      if (linkError) throw new Error(`Failed to check the staff member: ${linkError.message}`)
      if (!link) return { error: 'Staff member not found at this studio.' }
    }

    const { allowance, error } = await getHolidayAllowance(db, profileId, year)
    if (error) throw new Error(`Failed to load the holiday allowance: ${error.message}`)
    const { days: pending, error: pendingError } = await getPendingHolidayDays(db, profileId, year)
    if (pendingError) throw new Error(`Failed to load pending holiday days: ${pendingError.message}`)

    const entitlement = allowance.total_days + allowance.carried_over
    return {
      profile_id: profileId,
      year,
      entitlement_days: entitlement,
      used_days: allowance.used_days,
      pending_days: pending,
      remaining_days: entitlement - allowance.used_days,
    }
  },
})
