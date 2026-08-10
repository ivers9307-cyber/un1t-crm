// GET /api/public/countdown.gif — the live sale countdown as an animated GIF,
// for use as an <img> in marketing email (COUNTDOWN.1).
//
// Email clients run no JavaScript, so the only way to show a real ticking
// clock is to re-render it server-side on every open. The deadline is read
// from the SAME source the website countdown uses (sale_offers.ends_at), so
// the email and the page can never disagree.
//
// KNOWN LIMIT, and it applies to every countdown-image service equally:
// Gmail proxies images through googleusercontent and caches them, so the
// timer is accurate on FIRST open but may freeze on re-opens. The no-store
// headers below ask every cache not to; some ignore it. The email must
// therefore still state the deadline in text — the image is reinforcement,
// never the only place the deadline appears (it is also invisible to the
// ~image-blocked, e.g. Outlook desktop by default).
//
// Public and unauthenticated by design: it is an image in a broadcast email,
// there is nothing to authorise, and it leaks nothing but a countdown that
// is already public on the website.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { buildCountdownGif } from '@/lib/countdown-gif'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs' // sharp is a native module
export const dynamic = 'force-dynamic'

// 30 one-second frames ≈ 90KB. 60 frames doubles the weight for 30 more
// seconds of ticking, which is not worth it in an inbox.
const FRAMES = 30

// 1×1 transparent GIF — served if anything goes wrong, so a failure degrades
// to "no image" rather than a broken-image icon in the middle of the hero.
const BLANK_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

const NO_CACHE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
}

export async function GET() {
  try {
    const db = createServerClient()
    const { data } = await db
      .from('sale_offers')
      .select('ends_at')
      .eq('active', true)
      .order('ends_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!data?.ends_at) {
      return new NextResponse(BLANK_GIF, { headers: { 'Content-Type': 'image/gif', ...NO_CACHE } })
    }

    const msLeft = new Date(data.ends_at).getTime() - Date.now()
    const gif = await buildCountdownGif({ msLeft, frames: FRAMES })

    return new NextResponse(gif, {
      headers: { 'Content-Type': 'image/gif', 'Content-Length': String(gif.length), ...NO_CACHE },
    })
  } catch (e) {
    logWarn('countdown-gif', 'render failed', { err: e })
    return new NextResponse(BLANK_GIF, { headers: { 'Content-Type': 'image/gif', ...NO_CACHE } })
  }
}
