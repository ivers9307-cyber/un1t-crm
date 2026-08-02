// TIMER-PUSH.1 — realtime nudge for the class timer.
//
// The TV board and coach screens learn about run changes by polling
// (4s TV / 2s control) — a coach pressing Start could wait a full poll
// interval before the TV reacted. This helper pushes a Supabase Realtime
// BROADCAST ping on `timer:<locationId>` via the HTTP endpoint (no
// websocket from the serverless route, no DB publication, no RLS changes);
// listeners react by re-fetching their existing authoritative endpoint
// immediately. Delivery is ~100ms, so start/pause/stop feel instant.
//
// The ping is a pure cache-invalidation signal: the payload is never
// trusted or rendered — subscribers only use it to poll NOW instead of at
// the next interval. Polling remains the source of truth and the fallback
// when the websocket is down, so a lost ping degrades to the old latency,
// never to wrong data.
//
// Fire-and-forget by convention: swallow every error, cap at 1.5s so a
// slow Realtime API can't hold up the run mutation's response.

export async function broadcastTimerPing(locationId) {
  try {
    await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        messages: [{ topic: `timer:${locationId}`, event: 'timer', payload: { at: Date.now() } }],
      }),
      signal: AbortSignal.timeout(1500),
    })
  } catch {
    // Best-effort: listeners fall back to their normal poll cadence.
  }
}
