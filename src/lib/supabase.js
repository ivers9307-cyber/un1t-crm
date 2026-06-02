import { createClient } from '@supabase/supabase-js'
import { createBrowserClient as createSSRBrowserClient } from '@supabase/ssr'

// Browser client (uses anon key, stores session in cookies via @supabase/ssr).
//
// `options` is passed straight through to @supabase/ssr's createBrowserClient.
// Default callers pass nothing and get the standard auto-detecting client.
// The /reset-password page passes `{ auth: { detectSessionInUrl: false } }` so
// it can establish the recovery session from the URL token deterministically
// (auto-detection races the page's forced sign-out — see that page's comment).
export function createBrowserClient(options) {
  return createSSRBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    options
  )
}

// Server client (uses service role key, bypasses RLS — for API routes and triggers).
//
// Historical note: under Next 14 this client was constructed with a
// `noStoreFetch` wrapper because Next 14 cached every `fetch()` call in
// its data cache by default — including the internal fetches the
// Supabase JS client makes — even on `force-dynamic` routes. Without
// the wrapper, an UPDATE in Postgres could be invisible to subsequent
// reads on the same deployment until the data cache evicted. Hit on
// 2026-05-05 (deposit token expiry incident, see CLAUDE.md "Lessons
// learned"). The wrapper was retired under NEXT.16 (Next 15+ defaults
// fetch to `cache: 'no-store'`, so the Supabase client's internal
// fetch is no longer cached by the framework).
export function createServerClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}
