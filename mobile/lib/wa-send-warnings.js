// WATPLSEND.1 (review) — POST /api/whatsapp/conversations/[id]/send answers
// SUCCESS with `warnings` (finished, staff-facing sentences) when Meta accepted
// the message but saving it to the thread or updating the conversation failed.
// The customer HAS the message, so the phone must say so rather than let a
// missing thread row look like a failed send (staff would send it twice).
// Pure: the thread screen turns the result into an Alert.

export const SEND_WARNINGS_TITLE = 'Sent, with a problem'

/**
 * @param {object} res  the api() result of a WhatsApp send
 * @returns {null | { title: string, message: string }}
 */
export function sendWarningsNotice(res) {
  if (!res || res.success !== true || !Array.isArray(res.warnings)) return null
  const lines = res.warnings.filter((w) => typeof w === 'string' && w.trim()).map((w) => w.trim())
  if (lines.length === 0) return null
  return { title: SEND_WARNINGS_TITLE, message: lines.join('\n\n') }
}
