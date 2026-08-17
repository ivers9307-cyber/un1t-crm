import * as SecureStore from 'expo-secure-store'

const KEY = 'profile_setup_dismissed_at'
// Separate key: the ProfileCompletionPrompt snooze is a longer (7-day) window
// than the first-login wizard's 24h cooldown, and re-appears until the fields
// are actually filled — so it must not share the wizard's dismissal timestamp.
const COMPLETION_KEY = 'profile_completion_snoozed_at'

export async function getDismissedAtMs() {
  try {
    const v = await SecureStore.getItemAsync(KEY)
    const n = v ? Number(v) : null
    return Number.isFinite(n) ? n : null
  } catch { return null }
}

export async function setDismissedNow(nowMs = Date.now()) {
  try { await SecureStore.setItemAsync(KEY, String(nowMs)) } catch { /* best-effort */ }
}

export async function clearDismissed() {
  try { await SecureStore.deleteItemAsync(KEY) } catch { /* best-effort */ }
}

// ── ProfileCompletionPrompt snooze (separate from the wizard dismissal) ──

export async function getCompletionSnoozedAtMs() {
  try {
    const v = await SecureStore.getItemAsync(COMPLETION_KEY)
    const n = v ? Number(v) : null
    return Number.isFinite(n) ? n : null
  } catch { return null }
}

export async function setCompletionSnoozedNow(nowMs = Date.now()) {
  try { await SecureStore.setItemAsync(COMPLETION_KEY, String(nowMs)) } catch { /* best-effort */ }
}

export async function clearCompletionSnooze() {
  try { await SecureStore.deleteItemAsync(COMPLETION_KEY) } catch { /* best-effort */ }
}
