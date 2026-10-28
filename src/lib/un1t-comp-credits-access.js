// UN1TCOMP.1 — who may add complimentary un1t.online credits at a studio:
// the un1t_comp_credits web permission there (owner, manager and reception
// by default; master always), resolved at the BOOKING studio through the full
// tier order, role templates included. Pure.

import { hasPermissionForLocation } from './permissions.js'

export const UN1T_COMP_CREDITS_PERMISSION = 'un1t_comp_credits'

export const canGrantCompCredits = (user, locationId) =>
  !!user && !!locationId && hasPermissionForLocation(user, locationId, UN1T_COMP_CREDITS_PERMISSION)
