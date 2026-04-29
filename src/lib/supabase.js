import { createClient } from '@supabase/supabase-js'
import { createBrowserClient as createSSRBrowserClient } from '@supabase/ssr'

// Browser client (uses anon key, stores session in cookies via @supabase/ssr)
export function createBrowserClient() {
  return createSSRBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  )
}

// Server client (uses service role key, bypasses RLS — for API routes and triggers)
export function createServerClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}
