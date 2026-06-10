# Staff & Access — C2a: Safe Mobile Write Actions (Cycle 1, Plan C, slice 2a)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let mobile admins perform the **safe** staff write actions — edit basic details (name + employment type) and send a password reset — by calling the *existing* staff routes through the SDK with minimal payloads. This proves the write path + the Plan-B `Form`/`FormField` primitives end-to-end, with **zero changes to the 632-LOC PUT monolith** (the editor never sends `assignments`, so the UniFi/door-access/assignment-diff branch — guarded at `route.js:269` by `if (body.assignments !== undefined)` — is provably never reached).

**Architecture:** Additive, exactly like C1's read slice. Two new SDK methods (`sdk.staff.update`, `sdk.staff.sendPasswordReset`) wrap `PUT /api/staff/[id]` and `POST /api/staff/[id]/send-password-reset`. A new mobile edit screen uses `Form` + `FormField`; the detail screen gains an "Edit" header action (owner/master, matching the PUT gate) and a "Send password reset" button (master/owner/manager, matching that route's gate). No route or service logic changes.

**Tech Stack:** JS, Expo Router, the `mobile/components/ui` `Form`/`FormField`/`Button` primitives, `mobile/lib/sdk`, Zod (mobile dep).

**Scope guardrails (safety):**
- The mobile editor sends ONLY `{ full_name, employment_type }`. Never `assignments`, never comp/salary fields → the PUT's assignment/UniFi/door branch and the comp dual-write are both avoided.
- `employment_type` options are limited to `fte` / `contractor` (the DB CHECK constraint; `casual` from the Zod enum would fail the DB constraint).
- Role / permission / studio-assignment / door-access editing remains **C2b/C3** — that needs the careful PUT-extraction-first treatment and is explicitly out of scope here.

**Branch:** `mobile-parity-staff-c2a` (off `main` — rails + primitives + C1 are now merged to main).

**Reference before starting:** `shared/sdk/staff.js` (the read domain — add write methods alongside), `shared/sdk/staff.test.js`, `mobile/app/staff/[id].jsx` (the detail screen to extend), `mobile/components/ui/index.js` (`Form`, `useForm`, `FormField`, `Button`), `mobile/components/ui/Form.jsx` (render-prop API: `{ values, errors, setValue, submit }`), `mobile/components/ui/FormField.jsx` (default TextInput + render-prop child for custom controls).

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `shared/sdk/staff.js` | add `update(id, patch)`, `sendPasswordReset(id)` | Modify |
| `shared/sdk/staff.test.js` | tests for the two write methods | Modify |
| `mobile/app/staff/edit/[id].jsx` | edit screen (Form/FormField: full_name + employment_type) | Create |
| `mobile/app/staff/[id].jsx` | add Edit header action + Send-password-reset button | Modify |

---

## Task 1: SDK staff write methods

**Files:** Modify `shared/sdk/staff.js`, `shared/sdk/staff.test.js`.

- [ ] **Step 1: Add the failing tests**

Append to `shared/sdk/staff.test.js` (inside the existing `describe('sdk.staff', ...)` block, reusing the `okResponse` helper + `createSdk` import already at the top):

```js
  it('update(id, patch) PUTs /api/staff/:id with the patch body', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ success: true, data: { id: 'p1', full_name: 'Ada L' } }))
    const sdk = createSdk({ baseUrl: '', getAuthHeaders: () => ({}), fetchImpl })
    await sdk.staff.update('p1', { full_name: 'Ada L' })
    const [url, opts] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/staff/p1')
    expect(opts.method).toBe('PUT')
    expect(opts.body).toBe(JSON.stringify({ full_name: 'Ada L' }))
  })

  it('sendPasswordReset(id) POSTs the reset route', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ success: true }))
    const sdk = createSdk({ baseUrl: '', getAuthHeaders: () => ({}), fetchImpl })
    await sdk.staff.sendPasswordReset('p1')
    expect(fetchImpl).toHaveBeenCalledWith('/api/staff/p1/send-password-reset', expect.objectContaining({ method: 'POST' }))
  })
```

- [ ] **Step 2: Run → FAIL**

Run: `npx vitest run shared/sdk/staff.test.js`
Expected: FAIL — `sdk.staff.update` / `sendPasswordReset` are not functions.

- [ ] **Step 3: Add the methods**

In `shared/sdk/staff.js`, extend the returned object so the domain reads:

```js
export function staffDomain(request) {
  return {
    list: () => request('/api/staff', { method: 'GET' }),
    get: (id) => request(`/api/staff/${id}`, { method: 'GET' }),
    // Write — C2a. update() only ever carries safe profile fields
    // (full_name, employment_type) from the mobile editor; it never
    // sends `assignments`, so the PUT's UniFi/door/assignment branch
    // (route.js:269) is not reached. The route enforces owner/master.
    update: (id, patch) => request(`/api/staff/${id}`, { method: 'PUT', body: patch }),
    sendPasswordReset: (id) => request(`/api/staff/${id}/send-password-reset`, { method: 'POST' }),
  }
}
```

- [ ] **Step 4: Run → PASS (4 cases total in the file)**

Run: `npx vitest run shared/sdk/staff.test.js`

- [ ] **Step 5: Commit**

```bash
git add shared/sdk/staff.js shared/sdk/staff.test.js
git commit -m "STAFF-C2a.1 — sdk.staff write methods (update, sendPasswordReset)"
```

---

## Task 2: Mobile edit screen

**Files:** Create `mobile/app/staff/edit/[id].jsx`.

Read `mobile/components/ui/Form.jsx` + `FormField.jsx` + `mobile/app/staff/[id].jsx` first.

- [ ] **Step 1: Create the edit screen**

Create `mobile/app/staff/edit/[id].jsx`:

```js
// STAFF-C2a — edit a staff member's basic details (name + employment
// type) from mobile. Owner/master only (matches the PUT gate). Sends
// ONLY { full_name, employment_type } — never `assignments` — so the
// server's UniFi/door/assignment branch is never reached. Role /
// permission / studio / door editing stays on web (C2b/C3).
import { useState, useEffect, useCallback } from 'react'
import { View, Text, ScrollView, ActivityIndicator, Pressable } from 'react-native'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { z } from 'zod'
import { useAuth } from '../../../lib/auth-context'
import { sdk } from '../../../lib/sdk'
import { Form, FormField, Button } from '../../../components/ui'
import BackHeaderLeft from '../../../components/BackHeaderLeft'

const OWNER_ROLES = ['master', 'owner']
const EMPLOYMENT = [{ key: 'fte', label: 'Full-time' }, { key: 'contractor', label: 'Contractor' }]

const EditSchema = z.object({
  full_name: z.string().min(1, 'Name is required').max(200),
  employment_type: z.enum(['fte', 'contractor']),
})

export default function StaffEdit() {
  const params = useLocalSearchParams()
  const id = Array.isArray(params.id) ? params.id[0] : params.id
  const { profile } = useAuth()
  const router = useRouter()
  const canEdit = !!profile && OWNER_ROLES.includes(profile.role)

  const [initial, setInitial] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    const res = await sdk.staff.get(id)
    if (!res.success) { setError(res.error || 'Failed to load'); return }
    setInitial({
      full_name: res.data?.full_name || '',
      employment_type: res.data?.employment_type === 'contractor' ? 'contractor' : 'fte',
    })
  }, [id])

  useEffect(() => {
    if (!canEdit) { setLoading(false); return }
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [canEdit, load])

  async function save(values) {
    setSaving(true)
    setError(null)
    // Only the two safe fields — never assignments / comp.
    const res = await sdk.staff.update(id, {
      full_name: values.full_name,
      employment_type: values.employment_type,
    })
    setSaving(false)
    if (!res.success) { setError(res.error || 'Save failed'); return }
    router.back()
  }

  return (
    <View className="flex-1 bg-un1t-bg">
      <Stack.Screen options={{ title: 'Edit staff', headerLeft: () => <BackHeaderLeft label="Back" fallbackHref={`/staff/${id}`} /> }} />

      {!canEdit ? (
        <View className="py-16 items-center px-6">
          <Text className="text-base font-semibold text-un1t-text mt-3">Not available</Text>
          <Text className="text-xs text-un1t-subtle text-center mt-1">Editing staff is owner-only.</Text>
        </View>
      ) : loading || !initial ? (
        <View className="py-16 items-center"><ActivityIndicator /></View>
      ) : (
        <ScrollView contentContainerClassName="px-4 pt-4 pb-10">
          {error && (
            <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
              <Text className="text-red-500 text-sm">{error}</Text>
            </View>
          )}
          <Form initialValues={initial} schema={EditSchema} onSubmit={save}>
            {({ values, setValue, submit }) => (
              <>
                <FormField name="full_name" label="Full name" required />

                {/* employment_type via the FormField render-prop child:
                    a simple two-option segmented control. */}
                <FormField name="employment_type" label="Employment">
                  {({ value, onChange }) => (
                    <View className="flex-row gap-2">
                      {EMPLOYMENT.map(opt => {
                        const active = value === opt.key
                        return (
                          <Pressable
                            key={opt.key}
                            onPress={() => onChange(opt.key)}
                            className={`flex-1 rounded-xl px-3 py-2 items-center ${active ? 'bg-un1t-accent' : 'bg-un1t-surface border border-un1t-border'}`}
                            accessibilityRole="button"
                            accessibilityState={{ selected: active }}
                          >
                            <Text className={`text-sm font-medium ${active ? 'text-white' : 'text-un1t-subtle'}`}>{opt.label}</Text>
                          </Pressable>
                        )
                      })}
                    </View>
                  )}
                </FormField>

                <View className="mt-6">
                  <Button onPress={submit} disabled={saving}>
                    <Text className="text-white font-semibold">{saving ? 'Saving…' : 'Save changes'}</Text>
                  </Button>
                </View>
              </>
            )}
          </Form>
        </ScrollView>
      )}
    </View>
  )
}
```

> Note: confirm `Button`'s children/label convention from `mobile/components/ui/Button.jsx` — if it renders its own `<Text>` from a `label`/`title` prop rather than children, adapt the Button usage (e.g. `<Button label={saving ? 'Saving…' : 'Save changes'} onPress={submit} disabled={saving} />`). The `disabled` prop is supported (see `buttonClasses({disabled})`).

- [ ] **Step 2: Verify imports + commit**

Run: `npm run check:mobile-imports` (clean).

```bash
git add "mobile/app/staff/edit/[id].jsx"
git commit -m "STAFF-C2a.2 — mobile staff edit screen (name + employment, Form primitive)"
```

---

## Task 3: Detail-screen actions + gate + PR

**Files:** Modify `mobile/app/staff/[id].jsx`.

- [ ] **Step 1: Add the Edit action + Send-password-reset button**

In `mobile/app/staff/[id].jsx`:
- Import `useRouter` from `expo-router` and add `const router = useRouter()`; add `import { Button } from '../../components/ui'` (alongside the existing `Card` import — adjust to a single `{ Card, Button }` import).
- Add role helpers near the existing `isAdmin`:
```js
const OWNER_ROLES = ['master', 'owner']
const canEdit = !!profile && OWNER_ROLES.includes(profile.role)
```
- Add an Edit header action when `canEdit`, by extending the `Stack.Screen` options:
```js
<Stack.Screen options={{
  title: staff?.full_name || 'Staff',
  headerLeft: () => <BackHeaderLeft label="Staff" fallbackHref="/staff" />,
  headerRight: () => canEdit && staff
    ? <Pressable onPress={() => router.push(`/staff/edit/${id}`)} hitSlop={8}><Text className="text-un1t-accent font-semibold">Edit</Text></Pressable>
    : null,
}} />
```
(import `Pressable` from react-native if not already imported.)
- After the assignments `Card`, add a "Send password reset" action for admins (master/owner/manager — `isAdmin`), with a confirmation-then-send + inline result. Keep it simple:
```js
{isAdmin && staff?.email && (
  <View className="mt-6">
    <Button
      variant="secondary"
      onPress={async () => {
        setError(null)
        const res = await sdk.staff.sendPasswordReset(id)
        if (!res.success) setError(res.error || 'Could not send reset')
        else setError(null)
      }}
    >
      <Text className="text-un1t-text font-semibold">Send password reset</Text>
    </Button>
  </View>
)}
```
> Adapt the `Button` children/label convention to the real `Button` API (see Task 2 note). For a nicer UX a success toast/inline confirmation is welcome but optional; minimum bar is: calls the SDK, surfaces an error on failure.

Also: when the user returns from the edit screen, the detail should refresh. Add a focus refresh using expo-router's `useFocusEffect` if the existing screen doesn't already reload on focus — OR keep it simple and rely on the existing pull-to-refresh (acceptable for C2a; note it in the commit). Prefer the pull-to-refresh route to avoid adding a new effect dependency unless trivial.

- [ ] **Step 2: Verify imports + commit**

Run: `npm run check:mobile-imports` (clean).

```bash
git add "mobile/app/staff/[id].jsx"
git commit -m "STAFF-C2a.3 — staff detail: Edit action + send-password-reset (admin)"
```

- [ ] **Step 3: Full CI mirror + build**

Run:
```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports
```
Expected: all green (existing + the 2 new sdk.staff write tests). 1 pre-existing lint warning OK.

Run: `npm run build`
Expected: `✓ Compiled successfully` (no web changes here, but confirms nothing regressed).

- [ ] **Step 4: Push + open PR**

```bash
git push -u origin mobile-parity-staff-c2a
```
Open the PR against `main`, title `STAFF-C2a — safe mobile staff write actions (edit basics + password reset)`. Body: the two SDK write methods; the mobile edit screen (Form/FormField — first real use of those primitives) sending only `{ full_name, employment_type }`; the detail-screen Edit + reset actions; that the **PUT monolith is untouched** (editor never sends `assignments`, verified against `route.js:269`); and that role/permission/studio/door editing remains C2b/C3.

---

## Self-review

- **Spec coverage:** delivers the safe subset of the spec's §6 staff *write* surface on the shared core — edit basics + password reset — proving the write path + the `Form`/`FormField` primitives. The assignment/permission/door write surface is explicitly deferred (C2b/C3).
- **Placeholder scan:** none — full code + commands. The two "confirm the real `Button` API" notes are verification instructions (the surrounding code is complete and a fallback form is given).
- **Type/name consistency:** `sdk.staff.update(id, patch)` / `sendPasswordReset(id)` defined in Task 1, consumed by Tasks 2–3; the edit screen's `EditSchema` only permits `full_name` + `employment_type`; the `id` array-guard matches the C1 detail screen.
- **Safety:** no route/service change; the editor's payload is constrained to two profile-only fields, so the PUT's `assignments`-guarded UniFi/door/comp-heavy branch is never entered; the PUT route still enforces owner/master server-side (the mobile gate is UX). No permission-registry/parity change.
