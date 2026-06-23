// Member (customer) auth for the few un1t-crm routes a champ-app member calls
// directly with their Supabase access token (e.g. direct Apple Health ingest).
//
// un1t-crm's getCurrentUser() resolves STAFF (profiles). A member is an
// auth.users row linked to a contacts row via contacts.user_id — there is no
// staff profile. The proxy (src/proxy.js) already lets a valid Supabase JWT
// through /api/*, so we validate the token here and resolve the contact.
//
// Pure-ish: the Supabase auth client + service-role db are injectable so the
// resolution logic is unit-testable without env or network.

import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@/lib/supabase'

function bearerFromRequest(request) {
  const auth = request?.headers?.get?.('authorization') || ''
  return auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null
}

// Anon client (no session) used only to validate a member's access token via
// getUser(token) — verifies the signature against the project JWT secret.
function defaultAuthClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
}

/**
 * Resolve the member's contacts row from their Supabase Bearer JWT.
 *
 * @param {Request} request
 * @param {{ authClient?: object, db?: object }} [deps]  Injectable for tests.
 * @returns {Promise<{ contact: object } | { error: 'unauthorised' | 'no_contact' }>}
 */
export async function resolveCustomerContact(request, { authClient, db } = {}) {
  const token = bearerFromRequest(request)
  if (!token) return { error: 'unauthorised' }

  const auth = authClient || defaultAuthClient()
  const { data } = await auth.auth.getUser(token)
  const user = data?.user
  if (!user) return { error: 'unauthorised' }

  const database = db || createServerClient()
  const { data: contact } = await database
    .from('contacts')
    .select('id, location_id, max_hr_override, dob')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!contact) return { error: 'no_contact' }

  return { contact }
}
