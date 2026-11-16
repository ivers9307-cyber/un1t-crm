// STAFFPAYLINK.1 — who may send a un1t.online payment link at a studio: the
// un1t_payment_links web permission there (owner, manager and reception by
// default; master always), resolved at the studio through the full tier
// order, role templates included. Pure.

import { hasPermissionForLocation } from './permissions.js'

export const UN1T_PAYMENT_LINKS_PERMISSION = 'un1t_payment_links'

export const canSendUn1tPaymentLink = (user, locationId) =>
  !!user && !!locationId && hasPermissionForLocation(user, locationId, UN1T_PAYMENT_LINKS_PERMISSION)
