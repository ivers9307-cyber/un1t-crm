// FEES.1 — who may see and act on class fees at a studio: the class_fees
// web permission there, at a un1t.online studio. Pure.

import { hasPermissionForLocation } from './permissions.js'

export const canUseClassFees = (user, locationId) =>
  !!user && !!locationId && hasPermissionForLocation(user, locationId, 'class_fees')
