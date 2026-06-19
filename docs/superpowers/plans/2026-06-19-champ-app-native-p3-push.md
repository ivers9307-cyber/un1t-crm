# champ-app Native App — Phase 3 (Push) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Native push for the champ-app customer app — device-token registration, an opt-in toggle, and the deferred **Session Report "your session is ready" push** firing when a class session ends.

**Architecture:** A new `champ_push_tokens` table (keyed by `contact_id`, mirroring staff `device_tokens`). The champ-app native app registers its Expo token via a new `/api/mobile/push-token` route (service-client write after `getUser`→contact). un1t-crm gets a self-contained `sendCustomerPush()` (parallel to `src/lib/push.js`; does NOT touch the staff path) that fans out via Expo Push + prunes dead tokens; it fires from the two existing post-class trigger points (`live-class.js#endSession` + the `auto-end-stale-hr-sessions` cron), right after `sendPostClassEmail`. Opt-in = token presence (an Account toggle registers/unregisters), so no new pref column. Tapping the push deep-links to the session.

**Tech Stack:** Supabase (mig), Next.js API (champ-app + un1t-crm), Expo `expo-notifications` (already a dep). Repos: **un1t-crm** (mig + send path + triggers) + **champ-app** (route + RN). 

**Spec:** `…specs/2026-06-19-champ-app-native-app-design.md`. **Reference:** un1t-crm `src/lib/push.js`, `src/app/api/mobile/device-tokens/route.js`, `mobile/lib/push-register.js`, `mobile/app/_layout.jsx` (NotificationRouter), `src/lib/live-class.js#endSession`.

> **Gates:** mig applied to prod before merge; un1t-crm full CI (`vitest+lint+parity+imports+route-guards`); champ-app web `vitest+lint+build` + `expo export --platform all`. Real push delivery is device-verified later (needs the iOS APNs setup); the code is verified by the above.

---

### Task 1: Migration — `champ_push_tokens` (un1t-crm)

**Files:** Create `un1t-crm/supabase/migrations/295_champ_push_tokens.sql`

- [ ] **Step 1: branch + write**

```bash
cd /Users/richardivers/code/un1t-crm && git checkout main && git pull origin main && git checkout -b champ-native-p3-push-crm
```
`295_champ_push_tokens.sql`:
```sql
-- 295: CHAMP-NATIVE.1 P3 — Expo push tokens for the champ-app CUSTOMER native
-- app, keyed by contact_id (mirrors staff device_tokens, mig 023). Written by
-- champ-app /api/mobile/push-token via the service client; read by un1t-crm
-- sendCustomerPush(). Service-role only — RLS denies anon/authenticated.
CREATE TABLE IF NOT EXISTS public.champ_push_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  expo_push_token text NOT NULL UNIQUE,
  platform text NOT NULL CHECK (platform IN ('ios','android','web')),
  device_name text,
  app_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_champ_push_tokens_contact ON public.champ_push_tokens(contact_id);

ALTER TABLE public.champ_push_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "champ_push_tokens deny anon" ON public.champ_push_tokens
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY "champ_push_tokens deny authenticated" ON public.champ_push_tokens
  AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);

COMMENT ON TABLE public.champ_push_tokens IS 'CHAMP-NATIVE.1 P3: Expo push tokens for the champ-app customer native app, keyed by contact_id. Service-role only.';
```

- [ ] **Step 2: commit** (applied to prod in the ship task)
```bash
git add 'supabase/migrations/295_champ_push_tokens.sql'
git commit -m "CHAMP-NATIVE.1 P3 — mig 295: champ_push_tokens (customer push tokens)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: un1t-crm send path — `sendCustomerPush` + trigger wiring

**Files:** Create `un1t-crm/src/lib/customer-push.js` + test; modify `src/lib/live-class.js` + `src/app/api/cron/auto-end-stale-hr-sessions/route.js`.

- [ ] **Step 1: `src/lib/customer-push.js`** (self-contained — does NOT import/modify `push.js`)
```js
// Expo push fan-out for the champ-app CUSTOMER native app (champ_push_tokens).
// Parallel to src/lib/push.js (staff) but keyed by contact_id with no per-user
// permission gating (a registered token = opted in). Self-contained so it never
// touches the load-bearing staff push path. Best-effort: never throws to callers
// that wrap it; prunes DeviceNotRegistered tokens.

const EXPO_URL = 'https://exp.host/--/api/v2/push/send'
const BATCH = 100

export async function sendCustomerPush(db, contactIds, payload) {
  const ids = (Array.isArray(contactIds) ? contactIds : [contactIds]).filter(Boolean)
  if (!ids.length) return { sent: 0, invalidated: 0 }

  const { data: rows } = await db
    .from('champ_push_tokens')
    .select('id, expo_push_token')
    .in('contact_id', ids)
  if (!rows || !rows.length) return { sent: 0, invalidated: 0 }

  const messages = rows.map((r) => ({
    to: r.expo_push_token,
    title: payload.title,
    body: payload.body,
    data: payload.data || {},
    sound: 'default',
  }))

  const tickets = []
  for (let i = 0; i < messages.length; i += BATCH) {
    const chunk = messages.slice(i, i + BATCH)
    try {
      const res = await fetch(EXPO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(chunk),
      })
      const json = await res.json()
      if (Array.isArray(json?.data)) {
        json.data.forEach((t, j) => tickets.push({ t, token: chunk[j].to }))
      }
    } catch (e) {
      console.warn(`[customer-push] send failed: ${e?.message || e}`)
    }
  }

  const dead = tickets
    .filter(({ t }) => t?.status === 'error' && t?.details?.error === 'DeviceNotRegistered')
    .map(({ token }) => token)
  let invalidated = 0
  if (dead.length) {
    const { error } = await db.from('champ_push_tokens').delete().in('expo_push_token', dead)
    if (!error) invalidated = dead.length
  }
  return { sent: rows.length - invalidated, invalidated }
}
```

- [ ] **Step 2: test `src/lib/customer-push.test.js`** — stub `db` + `global.fetch`; assert: no tokens → `{sent:0}`; sends batched messages with the payload; prunes a `DeviceNotRegistered` ticket (delete called, `invalidated:1`). (Mirror the style of existing lib tests; mock `db.from().select().in()` to return rows and `db.from().delete().in()`.)
```js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { sendCustomerPush } from './customer-push.js'

function db(rows) {
  const deleted = { tokens: null }
  return {
    deleted,
    from() {
      return {
        select() { return { in: () => Promise.resolve({ data: rows }) } },
        delete() { return { in: (_c, toks) => { deleted.tokens = toks; return Promise.resolve({ error: null }) } } },
      }
    },
  }
}
beforeEach(() => { global.fetch = vi.fn() })

describe('sendCustomerPush', () => {
  it('no tokens → sends nothing', async () => {
    expect(await sendCustomerPush(db([]), 'c1', { title: 't', body: 'b' })).toEqual({ sent: 0, invalidated: 0 })
    expect(global.fetch).not.toHaveBeenCalled()
  })
  it('sends to each token', async () => {
    global.fetch.mockResolvedValue({ json: async () => ({ data: [{ status: 'ok' }] }) })
    const out = await sendCustomerPush(db([{ id: '1', expo_push_token: 'ExponentPushToken[a]' }]), 'c1', { title: 't', body: 'b', data: { type: 'session_report', session_id: 's1' } })
    expect(out.sent).toBe(1)
    const sent = JSON.parse(global.fetch.mock.calls[0][1].body)
    expect(sent[0]).toMatchObject({ to: 'ExponentPushToken[a]', title: 't', data: { type: 'session_report' } })
  })
  it('prunes DeviceNotRegistered', async () => {
    global.fetch.mockResolvedValue({ json: async () => ({ data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }] }) })
    const d = db([{ id: '1', expo_push_token: 'ExponentPushToken[dead]' }])
    const out = await sendCustomerPush(d, 'c1', { title: 't', body: 'b' })
    expect(out.invalidated).toBe(1)
    expect(d.deleted.tokens).toEqual(['ExponentPushToken[dead]'])
  })
})
```
Run: `npx vitest run src/lib/customer-push.test.js` → PASS.

- [ ] **Step 3: wire into `live-class.js#endSession`** — READ the function; right AFTER the existing `sendPostClassEmail(db, sessionId).catch(...)` best-effort call, add a sibling best-effort push using the finalised session's `contact_id` + `effort_points` + `class_name` (whatever the local var holds — match it):
```js
import { sendCustomerPush } from '@/lib/customer-push'
// …after the email call, same fire-and-forget style:
if (session?.contact_id) {
  sendCustomerPush(db, session.contact_id, {
    title: 'Your session is ready',
    body: `${Number.isFinite(session.effort_points) ? session.effort_points + ' UN1T Points' : 'Tap to see your stats'}${session.class_name ? ' · ' + session.class_name : ''}`,
    data: { type: 'session_report', session_id: sessionId },
  }).catch((err) => logWarn('live-class', 'customer push threw', { err, sessionId }))
}
```
(Use the actual session variable + logger already in scope. Null-contact walk-in sessions are skipped by the `contact_id` guard. Use the same import convention the file uses — `@/lib/...` or relative.)

- [ ] **Step 4: wire into the cron** — in `src/app/api/cron/auto-end-stale-hr-sessions/route.js`, where it calls `sendPostClassEmail` per auto-closed session, add the same `sendCustomerPush` call (it needs each session's `contact_id`/`effort_points`/`class_name` — select those columns if not already, and guard on `contact_id`).

- [ ] **Step 5: commit**
```bash
noglob git add src/lib/customer-push.js src/lib/customer-push.test.js src/lib/live-class.js 'src/app/api/cron/auto-end-stale-hr-sessions/route.js'
git commit -m "CHAMP-NATIVE.1 P3 — sendCustomerPush + fire Session Report push on session end (live-class + cron)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: champ-app push-token registration route

**Files:** Create `champ-app/src/app/api/mobile/push-token/route.js` + test.

- [ ] **Step 1: branch**
```bash
cd /Users/richardivers/code/champ-app && git checkout main && git pull origin main && git checkout -b champ-native-p3-push
```

- [ ] **Step 2: route** (auth via `getUser` → resolve contact → service-client upsert/delete; mirrors the share-mint route's auth pattern)
```js
import { NextResponse } from 'next/server'
import { createServerClient, createServiceClient } from '@/lib/supabase-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function callerContact() {
  const supabase = createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'unauthorised' }, { status: 401 }) }
  const { data: contact } = await supabase.from('contacts').select('id').eq('user_id', user.id).maybeSingle()
  if (!contact) return { error: NextResponse.json({ error: 'no-contact' }, { status: 404 }) }
  return { contactId: contact.id }
}

const TOKEN_RE = /^ExponentPushToken\[[A-Za-z0-9_-]+\]$/

export async function POST(request) {
  const { error, contactId } = await callerContact()
  if (error) return error
  let body
  try { body = await request.json() } catch { return NextResponse.json({ error: 'bad-json' }, { status: 400 }) }
  if (!body?.expo_push_token || !TOKEN_RE.test(body.expo_push_token)) {
    return NextResponse.json({ error: 'bad-token' }, { status: 400 })
  }
  const platform = ['ios', 'android', 'web'].includes(body?.platform) ? body.platform : 'ios'
  const { error: upErr } = await createServiceClient().from('champ_push_tokens').upsert({
    contact_id: contactId,
    expo_push_token: body.expo_push_token,
    platform,
    device_name: body?.device_name || null,
    app_version: body?.app_version || null,
    last_seen_at: new Date().toISOString(),
  }, { onConflict: 'expo_push_token' })
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(request) {
  const { error, contactId } = await callerContact()
  if (error) return error
  let body = {}
  try { body = await request.json() } catch { /* allow empty */ }
  const svc = createServiceClient()
  let q = svc.from('champ_push_tokens').delete().eq('contact_id', contactId)
  if (body?.expo_push_token) q = q.eq('expo_push_token', body.expo_push_token)
  const { error: delErr } = await q
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 3: test** `route.test.js` — mock `@/lib/supabase-server`; 401 without user, 404 without contact, 200 + service upsert on valid token, 400 on bad token, DELETE scoped to contactId. (Mirror the share route's test style from P-Slice4.)

- [ ] **Step 4: build + commit**
```bash
cd /Users/richardivers/code/champ-app && npm run build
noglob git add 'src/app/api/mobile/push-token/route.js' 'src/app/api/mobile/push-token/route.test.js'
git commit -m "CHAMP-NATIVE.1 P3 — champ-app push-token register/unregister route (customer-self)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: champ-app RN — registration + opt-in toggle + deep-link

**Files:** Create `champ-app/mobile/lib/push-register.js`; modify `mobile/app/(tabs)/_layout.jsx` (register on login), `mobile/lib/auth-context.jsx` (unregister on signOut), `mobile/app/(tabs)/account.jsx` (toggle), `mobile/app/_layout.jsx` (NotificationRouter).

- [ ] **Step 1: `mobile/lib/push-register.js`** — mirror un1t-crm `mobile/lib/push-register.js` (READ it), but POST/DELETE to `/api/mobile/push-token` via the champ `api()` helper:
```js
import * as Notifications from 'expo-notifications'
import * as Device from 'expo-device'
import Constants from 'expo-constants'
import { Platform } from 'react-native'
import { api } from './api'

export async function registerForPushNotifications() {
  if (!Device.isDevice) return { skipped: true, reason: 'simulator' }
  const { status: existing } = await Notifications.getPermissionsAsync()
  let final = existing
  if (existing !== 'granted') final = (await Notifications.requestPermissionsAsync()).status
  if (final !== 'granted') return { skipped: true, reason: 'permission_denied' }
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', { name: 'default', importance: Notifications.AndroidImportance.DEFAULT })
  }
  const projectId = Constants.expoConfig?.extra?.eas?.projectId
  let token
  try { token = (await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined)).data } catch (e) { return { skipped: true, reason: `token_error: ${e.message || e}` } }
  if (!token) return { skipped: true, reason: 'no_token' }
  const res = await api('/api/mobile/push-token', { method: 'POST', body: { expo_push_token: token, platform: Platform.OS, device_name: Device.deviceName || undefined, app_version: Constants.expoConfig?.version } })
  return { token, result: res }
}

export async function unregisterCurrentDevicePush() {
  try {
    const projectId = Constants.expoConfig?.extra?.eas?.projectId
    const token = (await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined)).data
    if (token) await api('/api/mobile/push-token', { method: 'DELETE', body: { expo_push_token: token } })
  } catch { /* best-effort */ }
}

export async function getPushPermission() {
  const { status } = await Notifications.getPermissionsAsync()
  return status // 'granted' | 'denied' | 'undetermined'
}
```
Add `expo-device` to `mobile/package.json` deps (it's in the staff app; confirm it's present — if not, add `"expo-device": "~8.0.10"` and `npm install`).

- [ ] **Step 2: register on login** — in `mobile/app/(tabs)/_layout.jsx`, after the `session` gate, a `useRef`-guarded `useEffect` that calls `registerForPushNotifications().catch(()=>{})` once when `session` is present (mirror the staff tabs layout).

- [ ] **Step 3: unregister on signOut** — in `mobile/lib/auth-context.jsx` `signOut`, before `supabase.auth.signOut()`, call `await unregisterCurrentDevicePush().catch(()=>{})` (import it).

- [ ] **Step 4: opt-in toggle** — in `mobile/app/(tabs)/account.jsx`, a "Push notifications" row with a `Switch`: on → `registerForPushNotifications()`, off → `unregisterCurrentDevicePush()`; reflect `getPushPermission()` on mount. Dark styling.

- [ ] **Step 5: NotificationRouter (deep-link)** — in `mobile/app/_layout.jsx`, add a `NotificationRouter` (mirror the staff one): on a tapped notification with `data.type === 'session_report'` → `router.push('/sessions/' + data.session_id)`; handle cold-start via `getLastNotificationResponseAsync`. Render it inside `AuthProvider` (needs `useAuth` for the session gate + `useRouter`).

- [ ] **Step 6: verify + commit**
```bash
cd /Users/richardivers/code/champ-app/mobile && npx expo export --platform all && rm -rf dist
cd /Users/richardivers/code/champ-app
noglob git add mobile/lib/push-register.js 'mobile/app/(tabs)/_layout.jsx' mobile/lib/auth-context.jsx 'mobile/app/(tabs)/account.jsx' mobile/app/_layout.jsx mobile/package.json mobile/package-lock.json
git commit -m "CHAMP-NATIVE.1 P3 — RN push registration + opt-in toggle + session-report deep-link

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Ship Phase 3

- [ ] **Step 1: apply mig 295 to prod** via Supabase MCP `apply_migration` (project `iyvtbjjxdggiadzwwvdj`). Then `get_advisors` (security) — expect no new ERROR (service-role-only table; RLS deny policies present).
- [ ] **Step 2: un1t-crm CI** — `cd un1t-crm && npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards`. (New route? No — the push send is a lib + trigger; the new `champ_push_tokens` is champ-app's route. The route-guard check covers un1t-crm routes only; `customer-push.js` is a lib. Confirm green.) Also `npm run build` (un1t-crm changed `live-class.js` + a cron — build to catch import issues).
- [ ] **Step 3: champ-app checks** — `cd champ-app && npm test && npm run lint && npm run build && (cd mobile && npx expo export --platform all && rm -rf dist)`.
- [ ] **Step 4: push both branches + open both PRs (base=main)** — un1t-crm (`champ-native-p3-push-crm`: mig 295 + customer-push + triggers) and champ-app (`champ-native-p3-push`: route + RN). Cross-reference them in the bodies.
- [ ] **Step 5: watch checks + merge both** (un1t-crm CI + Vercel; champ-app Vercel). Confirm both squash-merged to main. mig 295 already on prod.

---

## Self-review notes

- **Spec coverage (P3):** `champ_push_tokens` migration ✓; registration route ✓; RN registration + opt-in ✓; `sendCustomerPush` + the Session Report native push from the post-class triggers ✓; deep-link ✓.
- **Isolation:** `customer-push.js` is self-contained (doesn't import/alter the staff `push.js`); the trigger wiring is best-effort fire-and-forget (can't break session finalisation or the email).
- **Opt-in model:** token presence = opted in; the Account toggle + signOut register/unregister; no new pref column. Null-contact (walk-in) sessions are guarded out.
- **Security:** `champ_push_tokens` is service-role-only (RLS deny anon/auth); the route authenticates (`getUser`) + resolves the caller's own `contact_id` before the service-client write — a caller can only register/clear their own contact's tokens.
- **Verification:** mig advisor-checked; un1t-crm + champ-app CI; `expo export`. Real APNs/FCM delivery is device-verified after the Apple push-capability setup (P4 prereq) — the code path is exercised by the unit test + builds.
- **Field-name risk:** the exact `session` variable + columns at the `live-class.js#endSession` + cron call sites must be read and matched (the plan says to read them) — not guessed. If `class_name`/`effort_points` aren't in scope there, select them or adjust the payload.
