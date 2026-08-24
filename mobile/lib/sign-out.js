// PHASE2 stage C — THE sign-out teardown union. One session serves both
// shells, so one teardown must cover both identities regardless of which
// surface triggered it. Every consumer routes through here:
//
//   - staff auth-context signOut (More tab, kiosk idle-lock via
//     StudioPinProvider.lock(), biometric bail-out)
//   - member contact-context signOut (member account screen)
//   - the member api helper's invalid-refresh-token self-sign-out
//
// Order matters: everything that rides the still-valid JWT (impersonation
// stop, both push-token DELETEs) runs BEFORE supabase.auth.signOut clears
// the session. Every step is best-effort — sign-out must never block on
// bookkeeping.

import { supabase } from './supabase'
import { api } from './api'
import { readImpersonate, clearImpersonate } from './impersonate'
import { unregisterCurrentDevicePush as unregisterStaffPush } from './push-register'
import { unregisterCurrentDevicePush as unregisterMemberPush } from './member/push-register'
import { hkConnectedKey, hkCursorKey, hkPermsVersionKey } from './member/apple-health-keys'
import {
  readCachedMemberContactId,
  clearCachedMemberContactId,
  clearHasEverBeenStaff,
} from './identity'
import { clearLastSide } from './last-side'
import * as SecureStore from 'expo-secure-store'

export async function performFullSignOut() {
  // 1. Stop any active "view as user" session first so its audit row gets
  //    a precise ended_at + the local target clears, rather than dangling
  //    until the close-stale-impersonations cron reaps it.
  try {
    const imp = await readImpersonate()
    if (imp?.targetId) {
      await api('/api/mobile/impersonate/stop', { method: 'POST' })
      await clearImpersonate()
    }
  } catch {
    // ignore — the reaper cron is the backstop
  }

  // 2. Delete this device's STAFF push-token registration while the JWT is
  //    still valid (server scopes the DELETE to user_id). Without this a
  //    shared/studio device kept receiving the previous user's staff
  //    notifications (lead alerts, WhatsApp — customer PII).
  try {
    await unregisterStaffPush()
  } catch {
    // ignore — next sign-in re-registers for the new user
  }

  // 3. Delete the MEMBER push-token registration too (champ host,
  //    /api/mobile/push-token) — but only when a member identity was ever
  //    active on this device (cached contact id), so a staff-only sign-out
  //    doesn't burn a round-trip to the champ host for nothing.
  let memberContactId = null
  try {
    memberContactId = await readCachedMemberContactId()
    if (memberContactId) await unregisterMemberPush()
  } catch {
    // ignore — best-effort
  }

  // 4. Champ pattern: clear the OUTGOING contact's per-contact Apple-Health
  //    SecureStore keys before the auth flip so no foreground sync can race
  //    sign-out. Namespacing by contact_id is the durable fix; this is
  //    belt-and-braces for a shared/hand-me-down device.
  try {
    if (memberContactId) {
      await SecureStore.deleteItemAsync(hkConnectedKey(memberContactId))
      await SecureStore.deleteItemAsync(hkCursorKey(memberContactId))
      await SecureStore.deleteItemAsync(hkPermsVersionKey(memberContactId))
    }
  } catch { /* best-effort */ }
  try { await clearCachedMemberContactId() } catch { /* best-effort */ }

  // 5. Identity history is PER-SESSION: a different user may sign in on
  //    this device next, so both the has-ever-been-staff flag and the
  //    last-used-side preference must not outlive the session.
  try { await clearHasEverBeenStaff() } catch { /* best-effort */ }
  try { await clearLastSide() } catch { /* best-effort */ }

  // 6. Physical-location caches (HOME-LOC.5b) — the geofence regions AND
  //    the last position fix live at module level, so on a shared studio
  //    device the next user would resolve "which studio am I in" against
  //    the previous user's config and their last GPS fix. Lazily imported
  //    on purpose: use-physical-location.js reaches auth-context, which
  //    imports THIS module, and a static import would close that cycle at
  //    module-init time. Same `await import()` idiom geofence.js and
  //    auth-context use for studio-device.
  try {
    const { clearPhysicalLocationCaches } = await import('./use-physical-location')
    clearPhysicalLocationCaches()
  } catch { /* best-effort */ }

  // 7. scope:'local' — revoke THIS device's session only. supabase-js
  //    defaults to scope:'global', which revokes every refresh token the
  //    user holds — a studio kiosk's 5-minute idle lock would sign the
  //    staffer out of their own phone and the web CRM.
  await supabase.auth.signOut({ scope: 'local' })
}
