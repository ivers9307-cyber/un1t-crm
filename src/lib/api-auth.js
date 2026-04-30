import { NextResponse } from 'next/server'
import { safeEqual } from './webhook-auth'

// Validates the API key sent by n8n in the Authorization header.
// Comparison is constant-time so an attacker can't observe how many leading
// bytes of CRM_API_KEY they got right by timing 401 responses. Vercel's edge
// adds enough latency noise that a real timing attack is impractical, but
// there's no reason to leave a `!==` here either.
//
// Note: token extraction now uses startsWith() instead of replace(), which
// previously would strip "Bearer " from anywhere in the string (e.g.
// "abcBearer xyz" became "abcxyz") rather than only the prefix.
//
// Usage: const error = requireApiKey(request); if (error) return error;
export function requireApiKey(request) {
  const auth = request.headers.get('authorization') || ''
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : ''
  const expected = process.env.CRM_API_KEY

  if (!expected || !safeEqual(token, expected)) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized' },
      { status: 401 }
    )
  }
  return null // auth OK
}
