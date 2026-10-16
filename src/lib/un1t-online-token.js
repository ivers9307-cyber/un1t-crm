// UN1TSYNC.10 — a non-secret handle for an un1t.online token.
//
// Rotating a token (POST /api-tokens/{id}/rotate) keeps its id, so the id cannot
// tell the old secret from the new one. The first 16 hex characters of the
// token's SHA-256 can: it is stored in channel_connections.config beside the
// token at connect time, and the sync guards its connection writes on it. It is
// one-way and truncated, so it is safe in a PostgREST filter (a URL) and in a
// log; the token itself never is.
import { createHash } from 'node:crypto'

export function tokenFingerprint(token) {
  if (typeof token !== 'string' || token === '') return null
  return createHash('sha256').update(token).digest('hex').slice(0, 16)
}
