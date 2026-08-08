// Single source of truth for the global Postmark server token.
//
// Both names are live in prod: Vercel has carried POSTMARK_SERVER_TOKEN
// since the start, while newer code and .env.local.example standardised
// on POSTMARK_API_KEY. Any sender that reads one name directly breaks
// in whichever environment only has the other (the 2026-08-02
// invoice-approval email outage). Resolve through here instead.
//
// Returns the token, or null when neither var is set — callers decide
// whether a missing token is a throw (transactional send) or a skip.
export function resolvePostmarkToken() {
  return process.env.POSTMARK_API_KEY || process.env.POSTMARK_SERVER_TOKEN || null
}
