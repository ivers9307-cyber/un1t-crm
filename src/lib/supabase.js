import { createClient } from '@supabase/supabase-js'
import { createBrowserClient as createSSRBrowserClient } from '@supabase/ssr'

// Browser client (uses anon key, stores session in cookies via @supabase/ssr)
export function createBrowserClient() {
  return createSSRBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  )
}

// no-store fetch wrapper — Next.js 14 caches fetch() responses inside its
// data cache by default, even from inside `dynamic = 'force-dynamic'`
// routes when the fetch is made by a third-party client (the Supabase
// JS client opens its own fetch instance and doesn't inherit the
// route-level no-store default). Without this wrapper, an UPDATE to a
// row in Postgres can be invisible to subsequent reads on the same
// deployment until the cache evicts — we hit this on the deposit
// expiry hotfix on 2026-05-05 where DB said the token was valid for 3
// more days but the API kept returning TOKEN_EXPIRED from a stale
// cached fetch.
function noStoreFetch(input, init) {
  return fetch(input, { ...init, cache: 'no-store' })
}

// Server client (uses service role key, bypasses RLS — for API routes and triggers)
export function createServerClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { global: { fetch: noStoreFetch } }
  )
}
