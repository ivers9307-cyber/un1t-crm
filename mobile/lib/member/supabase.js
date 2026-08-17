// PHASE2 (one-app merge, stage B) — the member tree does NOT get its own
// Supabase client. Champ's lib/supabase.js built a second createClient()
// over the SAME chunked-SecureStore session key as the staff client; two
// clients racing refresh-token rotation is a verified logout hazard, so the
// merged app has exactly ONE client (mobile/lib/supabase.js) and this module
// is a re-export shim keeping every ported member import path working.
//
// Champ-only behaviour NOT carried over here (deliberately):
//   - the AppState-driven startAutoRefresh/stopAutoRefresh + proactive
//     foreground refreshSession() wiring lived in champ's client module.
//     TODO(stage C): decide whether the shared client adopts it when the
//     member tree goes live — wiring it now would change today's staff
//     token-refresh behaviour.

export { supabase } from '../supabase'
