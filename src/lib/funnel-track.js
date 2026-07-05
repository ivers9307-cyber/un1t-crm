// funnel-track.js — fire a /start funnel-step event to the Meta Pixel (as a
// CUSTOM event) and Vercel Analytics, so the exact drop-off point in the
// booking wizard is visible in both dashboards. Client-only: safely no-ops
// during SSR, before cookie-consent loads the pixel, or when an ad-blocker
// strips fbq. Custom names (start_*) keep these diagnostic steps separate from
// the server-side CAPI conversion events (Lead/Schedule) so nothing
// double-counts against ad optimisation.
import { track } from '@vercel/analytics'

export function trackFunnelStep(step, params = {}) {
  if (typeof window === 'undefined') return
  const name = `start_${step}`
  try {
    if (typeof window.fbq === 'function') window.fbq('trackCustom', name, params)
  } catch { /* pixel not loaded / blocked */ }
  try {
    track(name, params)
  } catch { /* analytics not mounted */ }
}
