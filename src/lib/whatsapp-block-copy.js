// WAORGNUMBER.4 (spec R8) — the inbox's block confirm. A block is set at Meta
// on the NUMBER, and a number is shared by every studio of its organisation
// that switched it on, so the confirm says so. `displayPhone` is the thread's
// stamped number (whatsapp_conversations.whatsapp_number_id); a thread with no
// stamp is blocked on the studio's default, named generically.
export function blockConfirmMessage(displayPhone) {
  const number = displayPhone ? String(displayPhone) : 'this number'
  return `Block this sender? This blocks them from messaging ${number} at every studio that uses it.`
}
