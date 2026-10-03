// WACONFIGFALLBACK.1 — staff-facing copy for removing or deactivating a
// location's WhatsApp number (the settings tab and the integrations hub
// drawer share it, so the two can never disagree).
//
// There is no global env number to fall back to any more: a location with no
// active whatsapp_numbers row sends nothing (Mia, booking and event
// confirmations, sequence reminders incl. dunning Pay now, broadcasts) and
// its inbound is dropped. So removing or deactivating the LAST active number
// turns WhatsApp off at that studio, and the confirm says so. A broken token
// is fixed by pasting a new one, not by removing or deactivating the number.
//
// Rows come in two shapes: the numbers route's snake_case (`is_active`) and
// the integrations hub's camelCase (`isActive`). Pure, no imports.

export const NO_ACTIVE_NUMBER_NOTE = 'This location will not send or receive WhatsApp while it has no active number.'
export const BROKEN_TOKEN_HINT = 'To fix a broken token, paste a new one instead of removing or deactivating the number.'
export const ACTIVE_CHECKBOX_LABEL = 'Active (an inactive number sends and receives no WhatsApp; to fix a broken token, paste a new one above instead)'

const WHATSAPP_STOPS = 'It is the last active WhatsApp number at this location, so WhatsApp stops at this studio: Mia stops replying, and booking confirmations and reminders are no longer sent.'

const isActive = (n) => (n?.is_active ?? n?.isActive) === true

/** True when `number` is active and no other row in `numbers` is. */
export function isLastActiveNumber(number, numbers) {
  if (!isActive(number)) return false
  return !(numbers || []).some((n) => n?.id !== number.id && isActive(n))
}

/** The confirm() text for removing `number` from a location with `numbers`. */
export function removeNumberConfirm(number, numbers) {
  const head = `Remove "${number.label}"?`
  if (isLastActiveNumber(number, numbers)) return `${head} ${WHATSAPP_STOPS} ${BROKEN_TOKEN_HINT}`
  const otherActive = (numbers || []).some((n) => n?.id !== number.id && isActive(n))
  if (otherActive) return `${head} This location keeps using its other active number. ${BROKEN_TOKEN_HINT}`
  return `${head} This location has no active number, so it does not send or receive WhatsApp until one is connected.`
}

/**
 * The confirm() text for switching `number` to inactive, or null when no
 * confirm is needed (another active number keeps WhatsApp running here).
 */
export function deactivateNumberConfirm(number, numbers) {
  if (!isLastActiveNumber(number, numbers)) return null
  return `Deactivate "${number.label}"? ${WHATSAPP_STOPS} ${BROKEN_TOKEN_HINT}`
}
