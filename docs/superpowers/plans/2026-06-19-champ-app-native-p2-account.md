# champ-app Native App — Phase 2 (Account Screens) — Plan / Record

> **For agentic workers:** This phase was executed dispatch-driven (subagents per screen group). This doc records the design + the exact data mechanisms used, so P3/P4 (and any revisit) have the reference. Shipped as champ-app #12.

**Goal:** Native RN rebuilds of the champ-app Account section — index, achievements, goals, devices, integrations — mirroring the web screens' exact data access.

**Architecture:** RN screens read/write **directly via the mobile `supabase` client** under customer-self RLS (and the existing RPCs); no new backend. Dark NativeWind; reuse `shared/` + `mobile/components/ui`; in-screen back (root Stack `headerShown:false`). Branch `champ-native-p2-account` → main.

**Reference (mirrored):** `champ-app/src/app/account/{page,achievements/*,goals/*,devices/*,integrations/*}`.

---

## Files (created)
- `mobile/app/(tabs)/account.jsx` — account index: Card of links (Devices/Goals/Achievements/Integrations → `router.push('/account/<x>')`) + email + ghost sign-out.
- `mobile/app/account/achievements.jsx` — `achievement_rules` (all) + `contact_achievements` (earned); earned/locked grid + Unlocked/To-earn/All tab filter; lucide→Ionicon map.
- `mobile/app/account/goals.jsx` — active `contact_goals` + 35d sessions; `computeProgress`/`GOAL_DEFS` (from `../../../shared/goals`); add/edit-target/archive mutations via `supabase` (RLS, mig 117) mirroring `GoalsManager.jsx`.
- `mobile/app/account/devices.jsx` — `contact_devices` list; `supabase.rpc('scan_straps_for_contact')` polled every 2s in a Modal; register/pair via `contact_devices` insert (`added_by_contact:true`); remove via delete; device-key + onboarding helpers inlined (duplicate-by-design, like champ-bridge `device-key.js`).
- `mobile/app/account/integrations.jsx` — `supabase.rpc('list_enabled_integrations')` (SECURITY DEFINER, no secret leak) + `contact_external_integrations` (auto-export toggle / disconnect); Strava live (connect → `Linking.openURL('/api/oauth/strava/start')`), Garmin/Fitbit/Whoop coming-soon.

## Data mechanisms (exact)
| Screen | Read | Write |
|---|---|---|
| Achievements | `achievement_rules` + `contact_achievements(rule:achievement_rules(...))` | — |
| Goals | `contact_goals` (active) + recent sessions | insert `{contact_id,kind,target_value}`; update `{target_value}`; archive `{archived_at,is_active:false}` |
| Devices | `contact_devices` + `rpc scan_straps_for_contact` | insert `contact_devices`; delete own |
| Integrations | `rpc list_enabled_integrations` + `contact_external_integrations` | update `{auto_export_enabled}`; disconnect `{disconnected_at,auto_export_enabled:false}` |

## Known deltas (intentional, flagged)
- **OAuth connect** opens the system browser via `Linking.openURL` (no `expo-web-browser` dep); the OAuth callback returns to the **web** session (no native deep-link return wired) — the account links server-side, and the app's integrations list reflects it on next load. A native deep-link/`openAuthSessionAsync` return is a **P3+/polish** item.
- **Manufacturer picker** = tap-to-cycle (no RN `<select>`); functionally equivalent.
- **Device-key/onboarding helpers** inlined into `devices.jsx` rather than shared — consistent with the codebase's existing verbatim-duplication of device-key helpers across runtimes. A future cleanup could move `heart-rate-devices.js`/`device-onboarding.js` into `shared/` with shims.

## Verification
- `expo export --platform all` clean (both platforms); web `vitest+lint+build` green; no `mobile→src/lib` leaks.
- Device QA deferred until the operator prereqs (`eas init`, OTP email template, store records) exist.

## Remaining native phases
- **P3** — push: a new migration (`champ_push_tokens` keyed `contact_id`), `expo-notifications` registration via `/api`, a `sendCustomerPush()` send path, the deferred **Session Report native push**, an opt-in toggle on Account.
- **P4** — store packaging (real icons/splash, listings, privacy labels) + EAS Build + iOS EAS Submit + manual Android `.aab` upload + public review.
- Both are best done **after** the operator prereqs so builds are device-testable.
