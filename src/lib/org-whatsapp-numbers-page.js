// WAORGNUMBER.1 / INTEGONE.3 — where the organisation's WhatsApp numbers are
// managed: the Integrations hub's `whatsapp-numbers` drawer (the standalone
// /settings/whatsapp-numbers page redirects to it). Pure, so the retired studio
// routes (410 moved_to) and the client screens that link to it share ONE path
// without a client bundle importing a server module.
//
// ORG_NUMBERS_PAGE names no organisation: the hub opens the drawer for the
// viewer's only managed organisation, or the first of several. A caller that
// knows the organisation (a studio's own tab) uses orgNumbersHref(orgId).
export const ORG_NUMBERS_PAGE = '/settings/integrations-hub?manage=whatsapp-numbers'

/** The hub URL that opens the numbers drawer of one organisation (the bare page when none is given). Pure. */
export function orgNumbersHref(orgId) {
  return orgId ? `${ORG_NUMBERS_PAGE}&org=${encodeURIComponent(orgId)}` : ORG_NUMBERS_PAGE
}
