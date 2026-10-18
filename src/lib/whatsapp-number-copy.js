// WACONFIGFALLBACK.1 / WAORGNUMBER.1 — staff-facing copy for removing or
// deactivating a WhatsApp number.
//
// A number belongs to the ORGANISATION and is switched on per studio, so
// removing or deactivating it acts at EVERY studio that has it switched on
// (the organisation's number page, where the remove and the active checkbox
// now live). There is no global env number to fall back to: a studio with no
// active number switched on sends nothing (Mia, booking and event
// confirmations, sequence reminders incl. dunning Pay now, broadcasts) and its
// inbound is dropped. A broken token is fixed by pasting a new one, not by
// removing or deactivating the number.
//
// Pure, no imports.

export const NO_ACTIVE_NUMBER_NOTE = 'This location will not send or receive WhatsApp while it has no active number.'
export const BROKEN_TOKEN_HINT = 'To fix a broken token, paste a new one instead of removing or deactivating the number.'
export const ACTIVE_CHECKBOX_LABEL = 'Active (an inactive number sends and receives no WhatsApp at any studio; to fix a broken token, paste a new one above instead)'

const WHATSAPP_STOPS = 'Every studio that has it switched on loses it: a studio with no other number switched on stops sending and receiving WhatsApp (Mia stops replying, and booking confirmations and reminders are no longer sent).'

/** The confirm() text for removing `number` from the organisation. */
export function removeNumberConfirm(number) {
  return `Remove "${number.label}"? It is deleted for good. ${WHATSAPP_STOPS} ${BROKEN_TOKEN_HINT}`
}

/** The confirm() text for switching `number` to inactive. */
export function deactivateNumberConfirm(number) {
  return `Deactivate "${number.label}"? ${WHATSAPP_STOPS} ${BROKEN_TOKEN_HINT}`
}
