// PHASE2 (one-app merge, stage B) — the member tree does NOT get its own
// Supabase client. Champ's lib/supabase.js built a second createClient()
// over the SAME chunked-SecureStore session key as the staff client; two
// clients racing refresh-token rotation is a verified logout hazard, so the
// merged app has exactly ONE client (mobile/lib/supabase.js) and this module
// is a re-export shim keeping every ported member import path working.
//
// STAGE C: champ's AppState-driven startAutoRefresh/stopAutoRefresh +
// proactive foreground refreshSession() wiring now lives ON THE SHARED
// CLIENT (mobile/lib/supabase.js, guarded against double-wiring) — both
// shells' direct supabase.from() reads get a fresh token after a long
// background, exactly as champ's members did.

export { supabase } from '../supabase'
