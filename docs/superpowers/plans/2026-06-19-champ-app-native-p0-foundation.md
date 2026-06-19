# champ-app Native App — Phase 0 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up `champ-app/mobile/` — an Expo/React Native app that boots, lets a member sign in with an email OTP code, and shows a 3-tab dark shell — plus the `champ-app/shared/` pure-logic seam. Screens come in later phases; this is the scaffold everything builds on.

**Architecture:** Mirror the proven `un1t-crm/mobile` staff app (Expo SDK 54, expo-router, NativeWind v4, chunked-SecureStore Supabase client, EAS) but **(a)** use the **dark** `un1t-*` tokens from the web refresh, **(b)** a **customer** auth model (Supabase email OTP → `contacts.user_id`; no profiles/locations/permissions/impersonation), and **(c)** a `champ-app/shared/` seam (Metro-watched) holding the pure logic, with `src/lib` re-export shims so the web doesn't churn.

**Tech Stack:** Expo SDK 54, React Native 0.81, expo-router 6, NativeWind 4, @supabase/supabase-js, expo-secure-store, react-native-svg (new — for the HR chart in later phases). Repo: **champ-app**. **Reference template:** `/Users/richardivers/code/un1t-crm/mobile/` (copy boilerplate verbatim except where noted).

**Spec:** `un1t-crm/docs/superpowers/specs/2026-06-19-champ-app-native-app-design.md`

> **Verification reality:** champ-app has no mobile CI and no device here. The headless gate for this phase is **`npm install` + `npx expo export`** (bundles the JS for both platforms and catches config/import/JSX errors) + the web's `npm run build` staying green through the shared-seam refactor. Device/simulator QA is deferred.

---

## File structure (created in this phase)

```
champ-app/
  shared/                         # NEW pure-logic seam (Metro-watched, web-imported)
    hr-session-report.js          # moved from src/lib
    heart-rate.js                 # moved from src/lib
    format.js                     # moved from src/lib
    goals.js                      # moved from src/lib
    share-card.js                 # moved from src/lib
    session-report.fixture.json   # moved from src/lib (+ its test)
    *.test.js                     # the existing pure tests, moved
  src/lib/<name>.js               # re-export shims → '../../shared/<name>'
  mobile/                         # NEW Expo app
    package.json  app.config.js  eas.json  babel.config.js  metro.config.js
    tailwind.config.js  global.css  .env.example
    lib/ supabase.js  auth-context.jsx  api.js
    app/ _layout.jsx  index.jsx
      (auth)/ _layout.jsx  login.jsx
      (tabs)/ _layout.jsx  index.jsx  sessions.jsx  account.jsx
    components/ui/ Card.jsx  Button.jsx  Screen.jsx
    assets/ icon.png  splash.png  adaptive-icon.png  notification-icon.png
```

---

### Task 1: Branch + the `champ-app/shared/` seam (web stays green)

**Files:** Create `champ-app/shared/*`; replace `champ-app/src/lib/{hr-session-report,heart-rate,format,goals,share-card}.js` with shims.

- [ ] **Step 1: Branch**

```bash
cd /Users/richardivers/code/champ-app
git checkout main && git pull origin main
git checkout -b champ-native-p0-foundation
mkdir -p shared
```

- [ ] **Step 2: Move the pure modules to `shared/`** (git mv preserves history; these are confirmed pure — no `next/*` imports)

```bash
cd /Users/richardivers/code/champ-app
git mv src/lib/hr-session-report.js shared/hr-session-report.js
git mv src/lib/heart-rate.js shared/heart-rate.js
git mv src/lib/format.js shared/format.js
git mv src/lib/goals.js shared/goals.js
git mv src/lib/share-card.js shared/share-card.js
# move the fixtures + co-located tests too (whatever exists):
git mv src/lib/session-report.fixture.json shared/session-report.fixture.json 2>/dev/null || true
for f in hr-session-report heart-rate format goals share-card; do
  git mv "src/lib/$f.test.js" "shared/$f.test.js" 2>/dev/null || true
done
```
If any moved test imports the fixture via a relative path, it still resolves (test + fixture move together). If a test imported a sibling that did NOT move, fix that import to `../shared/...` or revert that test's move — verify in Step 4.

- [ ] **Step 3: Add re-export shims in `src/lib/`** so existing web imports (`@/lib/<name>`) keep working. Create each of these files:

`src/lib/heart-rate.js`:
```js
export * from '../../shared/heart-rate'
```
`src/lib/format.js`:
```js
export * from '../../shared/format'
```
`src/lib/goals.js`:
```js
export * from '../../shared/goals'
```
`src/lib/share-card.js`:
```js
export * from '../../shared/share-card'
```
`src/lib/hr-session-report.js`:
```js
export * from '../../shared/hr-session-report'
```
(If any of these modules had a `default` export, also add `export { default } from '../../shared/<name>'`. Check each moved file's exports and match; the listed five are all named-export modules.)

- [ ] **Step 4: Verify the web is unaffected**

```bash
cd /Users/richardivers/code/champ-app
npx vitest run && npm run lint && npm run build
```
Expected: all green (the shims make `@/lib/...` resolve to `shared/`; tests that moved run from `shared/`). Fix any broken relative import surfaced here before continuing. Total tests unchanged (116).

- [ ] **Step 5: Commit**

```bash
git add shared src/lib
git commit -m "CHAMP-NATIVE.1 P0 — shared/ pure-logic seam (move report builder/zones/format/goals/share-card; src/lib shims)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Expo app skeleton + config

**Files:** Create under `champ-app/mobile/`: `package.json`, `app.config.js`, `eas.json`, `babel.config.js`, `metro.config.js`, `tailwind.config.js`, `global.css`, `.env.example`, and copy `assets/*` from the staff app as placeholders.

- [ ] **Step 1: `mobile/package.json`** (staff deps + `react-native-svg` for the HR chart; name/scripts adjusted)

```json
{
  "name": "champ-app-mobile",
  "version": "0.1.0",
  "private": true,
  "main": "expo-router/entry",
  "scripts": {
    "start": "expo start",
    "ios": "expo start --ios",
    "android": "expo start --android",
    "lint": "expo lint",
    "export": "expo export --platform all"
  },
  "dependencies": {
    "@expo/vector-icons": "^15.0.3",
    "@react-native-async-storage/async-storage": "2.2.0",
    "@react-navigation/native": "^7.0.0",
    "@supabase/supabase-js": "^2.45.0",
    "expo": "^54.0.34",
    "expo-constants": "~18.0.13",
    "expo-device": "~8.0.10",
    "expo-font": "~14.0.11",
    "expo-haptics": "~15.0.8",
    "expo-linking": "~8.0.12",
    "expo-notifications": "~0.32.17",
    "expo-router": "~6.0.23",
    "expo-secure-store": "~15.0.8",
    "expo-sharing": "~14.0.7",
    "expo-splash-screen": "~31.0.13",
    "expo-status-bar": "~3.0.9",
    "expo-system-ui": "~6.0.9",
    "expo-updates": "~29.0.17",
    "nativewind": "^4.1.20",
    "react": "19.1.0",
    "react-dom": "19.1.0",
    "react-native": "0.81.5",
    "react-native-gesture-handler": "~2.28.0",
    "react-native-reanimated": "~4.1.1",
    "react-native-safe-area-context": "~5.6.0",
    "react-native-screens": "~4.16.0",
    "react-native-svg": "15.12.1",
    "react-native-url-polyfill": "^2.0.0",
    "react-native-worklets": "0.5.1",
    "tailwindcss": "^3.4.0"
  },
  "devDependencies": {
    "@babel/core": "^7.25.2"
  }
}
```

- [ ] **Step 2: `mobile/app.config.js`** (champ identity; dark splash; OTP needs no scheme deep-link, but a scheme is still set for expo-router)

```js
export default ({ config }) => ({
  ...config,
  name: 'UN1T',
  slug: 'champ-app-mobile',
  version: '0.1.0',
  platforms: ['ios', 'android'],
  orientation: 'portrait',
  icon: './assets/icon.png',
  scheme: 'un1tapp',
  userInterfaceStyle: 'dark',
  splash: { image: './assets/splash.png', resizeMode: 'contain', backgroundColor: '#0B0B0C' },
  assetBundlePatterns: ['**/*'],
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'ie.champfitness.app',
    infoPlist: { UIBackgroundModes: ['remote-notification'], ITSAppUsesNonExemptEncryption: false },
  },
  android: {
    package: 'ie.champfitness.app',
    adaptiveIcon: { foregroundImage: './assets/adaptive-icon.png', backgroundColor: '#0B0B0C' },
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    'expo-font',
    ['expo-notifications', { icon: './assets/notification-icon.png', color: '#0B0B0C' }],
  ],
  experiments: { typedRoutes: true },
  updates: { enabled: true, checkAutomatically: 'ON_LOAD', fallbackToCacheTimeout: 0 },
  runtimeVersion: '0.1.0',
  extra: {
    supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL || 'https://iyvtbjjxdggiadzwwvdj.supabase.co',
    supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '',
    apiBaseUrl: process.env.EXPO_PUBLIC_API_BASE_URL || 'https://app.champfitness.ie',
    eas: { projectId: process.env.EAS_PROJECT_ID || '' },
  },
})
```
(`extra.eas.projectId` + `updates.url` are filled by `eas init` in Phase 4. The anon key default is empty — it's read from `.env`; the real value is the same public anon key the web uses.)

- [ ] **Step 2b: `eas.json`** — copy `un1t-crm/mobile/eas.json` verbatim, then blank the `submit.production.ios` values (`appleId`/`appleTeamId`/`ascAppId` → empty strings; filled in Phase 4).

- [ ] **Step 3: `mobile/babel.config.js`** — copy `un1t-crm/mobile/babel.config.js` verbatim:
```js
module.exports = function (api) {
  api.cache(true)
  return {
    presets: [['babel-preset-expo', { jsxImportSource: 'nativewind' }], 'nativewind/babel'],
    plugins: ['react-native-reanimated/plugin'],
  }
}
```

- [ ] **Step 4: `mobile/metro.config.js`** — copy the staff app's, with the shared root pointed at `champ-app/shared`:
```js
const { getDefaultConfig } = require('expo/metro-config')
const { withNativeWind } = require('nativewind/metro')
const path = require('node:path')

const config = getDefaultConfig(__dirname)
const sharedRoot = path.resolve(__dirname, '..', 'shared')
config.watchFolders = [...(config.watchFolders || []), sharedRoot]
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')]

module.exports = withNativeWind(config, { input: './global.css' })
```

- [ ] **Step 5: `mobile/tailwind.config.js`** — **DARK** un1t tokens (matching the web refresh, NOT the staff app's light tokens):
```js
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{js,jsx,ts,tsx}', './components/**/*.{js,jsx,ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        'un1t-bg': '#0B0B0C',
        'un1t-surface': '#161618',
        'un1t-surface-2': '#1F1F23',
        'un1t-border': '#1F1F23',
        'un1t-text': '#FFFFFF',
        'un1t-text-2': '#8A8A93',
        'un1t-text-3': '#5A5A61',
      },
    },
  },
  plugins: [],
}
```

- [ ] **Step 6:** `mobile/global.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```
And `mobile/.env.example`:
```bash
EXPO_PUBLIC_SUPABASE_URL=https://iyvtbjjxdggiadzwwvdj.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=YOUR-ANON-KEY
EXPO_PUBLIC_API_BASE_URL=https://app.champfitness.ie
EAS_PROJECT_ID=
```
And copy placeholder assets: `cp /Users/richardivers/code/un1t-crm/mobile/assets/{icon,splash,adaptive-icon,notification-icon}.png /Users/richardivers/code/champ-app/mobile/assets/` (real champ branding in Phase 4).

- [ ] **Step 7: Install + commit**

```bash
cd /Users/richardivers/code/champ-app/mobile && npm install
```
(Generates `mobile/package-lock.json`.) Then:
```bash
cd /Users/richardivers/code/champ-app
git add mobile/package.json mobile/package-lock.json mobile/app.config.js mobile/eas.json mobile/babel.config.js mobile/metro.config.js mobile/tailwind.config.js mobile/global.css mobile/.env.example mobile/assets
git commit -m "CHAMP-NATIVE.1 P0 — Expo app skeleton + config (SDK 54, NativeWind dark, metro shared seam)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Supabase client + customer auth context (OTP) + api client

**Files:** Create `mobile/lib/supabase.js`, `mobile/lib/auth-context.jsx`, `mobile/lib/api.js`.

- [ ] **Step 1: `mobile/lib/supabase.js`** — copy `un1t-crm/mobile/lib/supabase.js` **verbatim** (the chunked-SecureStore adapter + `flowType:'pkce'` are exactly what we want; it reads `Constants.expoConfig.extra.supabaseUrl/supabaseAnonKey`). No changes.

- [ ] **Step 2: `mobile/lib/api.js`** — a trimmed customer version (no impersonation/location headers — customers have none):
```js
import Constants from 'expo-constants'
import { supabase } from './supabase'

const API_BASE = Constants.expoConfig?.extra?.apiBaseUrl

export async function authHeaders({ json = false } = {}) {
  const { data: { session } } = await supabase.auth.getSession()
  const headers = { Accept: 'application/json' }
  if (json) headers['Content-Type'] = 'application/json'
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`
  return headers
}

export async function api(path, options = {}) {
  const headers = await authHeaders({ json: true })
  let response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    })
  } catch (err) {
    return { success: false, error: `Network error: ${err.message || err}` }
  }
  let json
  try { json = await response.json() } catch { return { success: false, error: `Non-JSON response (${response.status})` } }
  if (!response.ok && json?.success !== false) return { success: false, error: json?.error || `HTTP ${response.status}` }
  return json
}
```

- [ ] **Step 3: `mobile/lib/auth-context.jsx`** — customer auth (session + the member's `contacts` row; OTP sign-in). Much simpler than the staff context (no profile/locations/permissions/impersonation):
```jsx
import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { supabase } from './supabase'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [contact, setContact] = useState(null)
  const [loading, setLoading] = useState(true)

  const loadContact = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setContact(null); return }
    const { data } = await supabase
      .from('contacts')
      .select('id, name, email')
      .eq('user_id', user.id)
      .maybeSingle()
    setContact(data || null)
  }, [])

  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        const { data } = await supabase.auth.getSession()
        if (!mounted) return
        setSession(data.session)
        if (data.session) loadContact().catch(() => {})
      } finally {
        if (mounted) setLoading(false)
      }
    })()
    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      if (!mounted) return
      setSession(newSession)
      if (newSession) loadContact().catch(() => {})
      else setContact(null)
    })
    return () => { mounted = false; sub?.subscription?.unsubscribe?.() }
  }, [loadContact])

  // Step 1 of OTP: send the 6-digit code.
  const requestCode = useCallback(async (email) => {
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: { shouldCreateUser: false },
    })
    if (error) return { success: false, error: error.message }
    return { success: true }
  }, [])

  // Step 2 of OTP: verify the code → session lands via onAuthStateChange.
  const verifyCode = useCallback(async (email, token) => {
    const { error } = await supabase.auth.verifyOtp({
      email: email.trim().toLowerCase(),
      token: token.trim(),
      type: 'email',
    })
    if (error) return { success: false, error: error.message }
    return { success: true }
  }, [])

  const signOut = useCallback(async () => { await supabase.auth.signOut() }, [])

  return (
    <AuthContext.Provider value={{ session, contact, loading, requestCode, verifyCode, signOut, refresh: loadContact }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
```

- [ ] **Step 4: Commit**

```bash
cd /Users/richardivers/code/champ-app
git add mobile/lib
git commit -m "CHAMP-NATIVE.1 P0 — Supabase client (chunked SecureStore) + customer OTP auth context + api client

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Routing shell (layout, index, OTP login, 3 tabs + placeholders)

**Files:** Create `mobile/app/_layout.jsx`, `index.jsx`, `(auth)/_layout.jsx`, `(auth)/login.jsx`, `(tabs)/_layout.jsx`, `(tabs)/index.jsx`, `(tabs)/sessions.jsx`, `(tabs)/account.jsx`.

- [ ] **Step 1: `mobile/app/_layout.jsx`**
```jsx
import '../global.css'
import { Stack, SplashScreen } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { useEffect } from 'react'
import { AuthProvider, useAuth } from '../lib/auth-context'

SplashScreen.preventAutoHideAsync()

function SplashGate() {
  const { loading } = useAuth()
  useEffect(() => { if (!loading) SplashScreen.hideAsync() }, [loading])
  return null
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AuthProvider>
          <StatusBar style="light" />
          <SplashGate />
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="(auth)" />
            <Stack.Screen name="(tabs)" />
          </Stack>
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
```

- [ ] **Step 2: `mobile/app/index.jsx`**
```jsx
import { Redirect } from 'expo-router'
import { useAuth } from '../lib/auth-context'

export default function Index() {
  const { session, loading } = useAuth()
  if (loading) return null
  return <Redirect href={session ? '/(tabs)' : '/(auth)/login'} />
}
```

- [ ] **Step 3: `mobile/app/(auth)/_layout.jsx`**
```jsx
import { Stack } from 'expo-router'
export default function AuthLayout() { return <Stack screenOptions={{ headerShown: false }} /> }
```

- [ ] **Step 4: `mobile/app/(auth)/login.jsx`** — two-step OTP (email → code), dark-branded:
```jsx
import { useState } from 'react'
import { useRouter } from 'expo-router'
import { View, Text, TextInput, Pressable, KeyboardAvoidingView, Platform, ActivityIndicator } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useAuth } from '../../lib/auth-context'

export default function Login() {
  const { requestCode, verifyCode } = useAuth()
  const router = useRouter()
  const [step, setStep] = useState('email') // 'email' | 'code'
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function sendCode() {
    setError(null); setBusy(true)
    const r = await requestCode(email)
    setBusy(false)
    if (!r.success) { setError('Couldn’t send a code to that email. Check it and try again.'); return }
    setStep('code')
  }
  async function confirm() {
    setError(null); setBusy(true)
    const r = await verifyCode(email, code)
    setBusy(false)
    if (!r.success) { setError('That code didn’t work. Check it or request a new one.'); return }
    router.replace('/(tabs)')
  }

  return (
    <SafeAreaView className="flex-1 bg-un1t-bg">
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} className="flex-1">
        <View className="flex-1 px-6 justify-center">
          <Text className="text-2xl font-extrabold tracking-[6px] text-un1t-text text-center mb-2">UN1T</Text>
          <Text className="text-sm text-un1t-text-2 text-center mb-10">
            {step === 'email' ? 'Sign in with your email' : `Enter the code we sent to ${email}`}
          </Text>

          {error ? (
            <View className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 mb-4">
              <Text className="text-red-400 text-sm">{error}</Text>
            </View>
          ) : null}

          {step === 'email' ? (
            <>
              <TextInput
                value={email} onChangeText={setEmail}
                placeholder="you@email.com" placeholderTextColor="#5A5A61"
                autoCapitalize="none" autoCorrect={false} keyboardType="email-address" textContentType="username"
                className="rounded-xl border border-un1t-border bg-un1t-surface-2 px-4 py-3 text-un1t-text mb-3"
              />
              <Pressable onPress={sendCode} disabled={busy || !email}
                className={`rounded-xl py-4 items-center ${busy || !email ? 'bg-un1t-surface-2' : 'bg-white'}`}>
                {busy ? <ActivityIndicator color="#0B0B0C" /> : <Text className="font-semibold text-un1t-bg">Send code</Text>}
              </Pressable>
            </>
          ) : (
            <>
              <TextInput
                value={code} onChangeText={setCode}
                placeholder="123456" placeholderTextColor="#5A5A61"
                keyboardType="number-pad" textContentType="oneTimeCode" maxLength={6}
                className="rounded-xl border border-un1t-border bg-un1t-surface-2 px-4 py-3 text-un1t-text text-center text-lg tracking-[8px] mb-3"
              />
              <Pressable onPress={confirm} disabled={busy || code.length < 6}
                className={`rounded-xl py-4 items-center ${busy || code.length < 6 ? 'bg-un1t-surface-2' : 'bg-white'}`}>
                {busy ? <ActivityIndicator color="#0B0B0C" /> : <Text className="font-semibold text-un1t-bg">Sign in</Text>}
              </Pressable>
              <Pressable onPress={() => { setStep('email'); setCode(''); setError(null) }} className="py-3 items-center">
                <Text className="text-sm text-un1t-text-2">Use a different email</Text>
              </Pressable>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}
```

- [ ] **Step 5: `mobile/app/(tabs)/_layout.jsx`** — 3 fixed tabs, dark:
```jsx
import { Tabs, Redirect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../lib/auth-context'

export default function TabsLayout() {
  const { session, loading } = useAuth()
  if (loading) return null
  if (!session) return <Redirect href="/(auth)/login" />
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: '#0B0B0C' },
        headerTitleStyle: { color: '#FFFFFF', fontWeight: '700' },
        headerShadowVisible: false,
        tabBarActiveTintColor: '#FFFFFF',
        tabBarInactiveTintColor: '#5A5A61',
        tabBarStyle: { backgroundColor: '#0B0B0C', borderTopColor: '#1F1F23' },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Home', tabBarIcon: ({ color, size }) => <Ionicons name="home-outline" size={size} color={color} /> }} />
      <Tabs.Screen name="sessions" options={{ title: 'Sessions', tabBarIcon: ({ color, size }) => <Ionicons name="pulse-outline" size={size} color={color} /> }} />
      <Tabs.Screen name="account" options={{ title: 'Account', tabBarIcon: ({ color, size }) => <Ionicons name="person-outline" size={size} color={color} /> }} />
    </Tabs>
  )
}
```

- [ ] **Step 6: Placeholder tab screens** (real content in Phase 1/2). Each renders a dark screen with a heading so the shell is navigable.

`mobile/app/(tabs)/index.jsx`:
```jsx
import { View, Text } from 'react-native'
import { useAuth } from '../../lib/auth-context'

export default function Home() {
  const { contact } = useAuth()
  const first = contact?.name?.split(' ')[0] || 'there'
  return (
    <View className="flex-1 bg-un1t-bg p-5">
      <Text className="text-2xl font-bold text-un1t-text">Hi, {first}</Text>
      <Text className="text-sm text-un1t-text-2 mt-1">Your dashboard lands here.</Text>
    </View>
  )
}
```
`mobile/app/(tabs)/sessions.jsx`:
```jsx
import { View, Text } from 'react-native'
export default function Sessions() {
  return (
    <View className="flex-1 bg-un1t-bg p-5">
      <Text className="text-2xl font-bold text-un1t-text">Sessions</Text>
      <Text className="text-sm text-un1t-text-2 mt-1">Your session history lands here.</Text>
    </View>
  )
}
```
`mobile/app/(tabs)/account.jsx`:
```jsx
import { View, Text, Pressable } from 'react-native'
import { useAuth } from '../../lib/auth-context'

export default function Account() {
  const { contact, signOut } = useAuth()
  return (
    <View className="flex-1 bg-un1t-bg p-5">
      <Text className="text-2xl font-bold text-un1t-text">Account</Text>
      <Text className="text-sm text-un1t-text-2 mt-1">{contact?.email || ''}</Text>
      <Pressable onPress={signOut} className="mt-6 rounded-xl border border-un1t-border px-5 py-3 self-start">
        <Text className="text-un1t-text font-semibold">Sign out</Text>
      </Pressable>
    </View>
  )
}
```

- [ ] **Step 7: Commit**

```bash
cd /Users/richardivers/code/champ-app
noglob git add 'mobile/app'
git commit -m "CHAMP-NATIVE.1 P0 — routing shell: OTP login + 3-tab dark scaffold + placeholders

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: RN dark UI primitives + headless bundle verify

**Files:** Create `mobile/components/ui/{Card,Button,Screen}.jsx`.

- [ ] **Step 1: Primitives** (the RN analogues of the web `ui/`; more added in Phase 1 as screens need them)

`mobile/components/ui/Screen.jsx`:
```jsx
import { ScrollView } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
export default function Screen({ children }) {
  return (
    <SafeAreaView className="flex-1 bg-un1t-bg" edges={['left','right']}>
      <ScrollView contentContainerClassName="p-5 pb-24">{children}</ScrollView>
    </SafeAreaView>
  )
}
```
`mobile/components/ui/Card.jsx`:
```jsx
import { View } from 'react-native'
export default function Card({ children, className = '' }) {
  return <View className={`rounded-[20px] border border-un1t-border bg-un1t-surface p-5 ${className}`}>{children}</View>
}
```
`mobile/components/ui/Button.jsx`:
```jsx
import { Pressable, Text, ActivityIndicator } from 'react-native'
export default function Button({ title, onPress, variant = 'primary', busy = false, disabled = false }) {
  const off = disabled || busy
  const base = variant === 'primary'
    ? (off ? 'bg-un1t-surface-2' : 'bg-white')
    : 'border border-un1t-border'
  const textColor = variant === 'primary' ? 'text-un1t-bg' : 'text-un1t-text'
  return (
    <Pressable onPress={onPress} disabled={off} className={`rounded-xl py-3.5 px-5 items-center ${base}`}>
      {busy ? <ActivityIndicator color={variant === 'primary' ? '#0B0B0C' : '#FFFFFF'} /> : <Text className={`font-semibold ${textColor}`}>{title}</Text>}
    </Pressable>
  )
}
```

- [ ] **Step 2: Headless bundle verify** (the Phase-0 gate — no device needed)

```bash
cd /Users/richardivers/code/champ-app/mobile
npx expo export --platform all
```
Expected: exports both bundles with **no errors** (catches NativeWind wiring, the metro `../shared` resolution, expo-router structure, bad imports). If it fails, fix the cause (common: a `shared/` import path, a NativeWind/babel mismatch, a missing dep). Then clean the export output:
```bash
rm -rf dist
```

- [ ] **Step 3: Commit**

```bash
cd /Users/richardivers/code/champ-app
git add mobile/components
git commit -m "CHAMP-NATIVE.1 P0 — dark RN UI primitives (Screen/Card/Button); expo export verified

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Ship Phase 0 (foundation PR)

**Files:** none (release). Phase 0 does NOT touch the stores — it merges the scaffold so later phases build on `main`.

- [ ] **Step 1: Final checks**

```bash
cd /Users/richardivers/code/champ-app
npx vitest run && npm run lint && npm run build      # web stays green (shared seam)
cd mobile && npm install && npx expo export --platform all && rm -rf dist   # mobile bundles
```

- [ ] **Step 2: Push + PR**

```bash
cd /Users/richardivers/code/champ-app
git push -u origin champ-native-p0-foundation
gh pr create --base main --head champ-native-p0-foundation -R ivers9307-cyber/champ-app \
  --title "CHAMP-NATIVE.1 P0 — native app foundation (Expo scaffold + shared seam + OTP auth + dark tab shell)" \
  --body "Phase 0 of the champ-app native app. Stands up champ-app/mobile/ (Expo SDK 54, expo-router, NativeWind dark tokens) + the champ-app/shared/ pure-logic seam. Screens come in P1+.

- shared/ seam: moved the pure modules (report builder, zones, format, goals, share-card) out of src/lib with re-export shims so the web is unchanged (web build + 116 tests stay green).
- Expo app mirrors the staff app's scaffold: chunked-SecureStore Supabase client, metro watching ../shared, EAS config (submit creds blank until P4).
- Customer auth = Supabase email OTP (no profiles/locations/permissions); 3 fixed dark tabs (Home/Sessions/Account) with placeholders.

Verified: web vitest+lint+build green; \`expo export --platform all\` bundles clean. No store/native binary in this phase. Prereqs for later phases: OTP email template ({{ .Token }}), \`eas init\`, Apple/Google app records.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 3: Watch Vercel (the web build still runs on champ-app PRs) + merge**

```bash
gh pr checks <champ-app#> -R ivers9307-cyber/champ-app --watch --interval 20
gh pr merge <champ-app#> -R ivers9307-cyber/champ-app --squash --delete-branch
```
(The Vercel check builds the *web* app — confirms the shared-seam refactor didn't break it. The mobile scaffold isn't built by Vercel; `expo export` locally is its gate.)

---

## Self-review notes

- **Spec coverage (P0):** Expo scaffold mirroring the staff app ✓ (Tasks 2–5); `shared/` seam + src/lib shims ✓ (Task 1); NativeWind dark tokens ✓ (Task 2); chunked-SecureStore Supabase client ✓ (Task 3); **email-OTP** customer auth ✓ (Task 3–4); 3-tab dark shell + placeholders ✓ (Task 4). Screens, push, store packaging are P1–P4.
- **Web safety:** the seam move uses `git mv` + `src/lib` re-export shims so every `@/lib/...` web import keeps resolving; Task 1 Step 4 + Task 6 re-run the web `vitest+lint+build`. The shims are the key risk-control.
- **Mirrors the proven template:** package.json/eas.json/babel/metro/supabase client are the staff app's (copied), so the toolchain is known-good; the deliberate diffs (dark tokens, OTP auth, simplified customer context, 3 fixed tabs, `react-native-svg` added, bundle id `ie.champfitness.app`) are called out.
- **Verification:** `npx expo export --platform all` is the headless gate (no device/CI for mobile); the web Vercel build gates the seam refactor. Device QA + EAS build are later.
- **No placeholders:** every file's content is given or "copy verbatim from un1t-crm/mobile/<file>" (an exact in-repo source). Deferred-to-later-phase items (eas projectId, submit creds, real assets) are explicitly marked, not vague.
- **Deps note:** `react-native-svg@15.12.1` is the one dep added beyond the staff set (HR chart, used in P1) — pinned to the SDK-54-compatible line.
