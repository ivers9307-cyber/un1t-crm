import { createServerClient } from '@supabase/ssr'
import { NextResponse } from 'next/server'
import { resolveBrand, isFrameworkAsset } from '@/lib/brands'

// Constant-time string compare. Implemented inline because the proxy runs
// in the Edge runtime which doesn't expose node:crypto.timingSafeEqual. The
// length-mismatch early exit leaks key length, but CRM_API_KEY is a fixed
// 64-char hex string by convention so that's effectively zero info.
function timingSafeEqualEdge(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return mismatch === 0
}

// PROXY.1 — renamed from middleware → proxy for the Next.js 16 "proxy"
// file convention (the old "middleware" name is deprecated and the
// Vercel build pipeline now hard-fails on it). Behaviour is unchanged.
// REDEPLOY 2026-05-30 — force a fresh middleware bundle. The edge
// proxy chunk on production had gone stale: /event-pay/ (added to
// publicPaths in #212) was still being gated to /login while older
// entries like /studio-login resolved public, proving the deployed
// middleware predated #212. Touching this file changes its content
// hash so Next re-emits the middleware on the next build.
export async function proxy(request) {
  const hostname = request.headers.get('host') || ''

  // ── Multi-brand routing (MULTIBRAND.1) ───────────────────────────
  // Tenant brands sharing this deployment (pay.ccfautos.com, the
  // un1tdublin.com marketing site, future partner studios, etc.)
  // are declared as data in src/lib/brands.js. resolveBrand() returns
  // null on the default CRM hostname so we fall through to the CRM
  // auth path below; otherwise it returns a brand entry and we apply
  // the per-brand allowlist + handler.
  //
  // Two handlers per brand:
  //   • 'reject'   — disallowed paths 404 (buyer-facing payment
  //                   hostnames that must not hint at the CRM's
  //                   existence)
  //   • 'rewrite'  — disallowed paths rewrite to a marketing
  //                   landing (public marketing hosts)
  //
  // Adding a third brand is one entry in src/lib/brands.js — no
  // edit to this file required.
  const brand = resolveBrand(hostname)
  if (brand) {
    const path = request.nextUrl.pathname
    // Framework assets pass through unconditionally — the brand
    // landing page itself can't render without them.
    if (isFrameworkAsset(path)) return NextResponse.next()

    // Root path handling. 'rewrite' brands map "/" to a landing
    // (e.g. /welcome) so the URL bar stays clean; 'reject' brands
    // 404 "/" to keep the brand isolation tight.
    if (path === '/') {
      if (brand.rootHandler === 'rewrite') {
        return NextResponse.rewrite(new URL(brand.rootRewriteTo, request.url))
      }
      if (brand.rootHandler === 'reject') {
        return new NextResponse('Not found', { status: 404 })
      }
    }

    // Per-brand allowlist. Anything outside it gets the fallback
    // treatment for the brand (404 or rewrite home).
    const allowed = brand.allowedPaths.some((p) => path.startsWith(p))
    if (!allowed) {
      if (brand.fallbackHandler === 'reject') {
        return new NextResponse('Not found', { status: 404 })
      }
      if (brand.fallbackHandler === 'rewrite') {
        return NextResponse.rewrite(new URL(brand.fallbackRewriteTo, request.url))
      }
    }
    // Allowlisted brand path — let it through, no CRM auth gate.
    return NextResponse.next()
  }

  // ── CRM hostname (default) — existing behaviour ──────────────────
  // Public routes that don't require auth.
  // /tv/ — big-screen kiosk displays (HR live board, future race
  // display moves here too). TV browsers don't have CRM accounts
  // and shouldn't need them; the API endpoints under /api/public/
  // expose only display-safe data.
  // /ffmpeg/ — the self-hosted ffmpeg.wasm worker + core/wasm (landing-
  // page in-browser video compression). ffmpeg fetches these like a
  // public CDN asset; behind the auth gate the worker's subresource
  // fetches get a 307→/login (HTML) instead of the binary and ffmpeg
  // fails to load. They're non-sensitive open-source binaries — public.
  // /embed/ — the paste-anywhere iframe widgets (event signup). The
  // whole point is third-party sites iframing them for anonymous
  // visitors; without this entry the iframe showed a login redirect
  // (found in the 2026-06-10 audit — the page itself documents the
  // public-embed intent). Data access stays via /api/public/*.
  // /api/bridge/ — heart-rate bridge endpoints (heartbeat / samples /
  // scan). Pi devices running champ-bridge authenticate per-request with
  // their own `bbr_` bearer token, verified in-handler by verifyBridgeToken
  // (sha256 match against ble_bridges.api_token_hash) — same self-guarding
  // pattern as /api/webhooks/ (HMAC) and /api/cron/ (CRON_SECRET). Without
  // this entry every bridge call 307s to /login and never reaches the handler.
  const publicPaths = ['/login', '/reset-password', '/book/', '/event/', '/event-pay/', '/tv/', '/present/', '/api/public/', '/unsubscribe/', '/preferences/', '/api/unsubscribe/', '/api/preferences/', '/api/webhooks/', '/api/cron/', '/api/bridge/', '/deposit/', '/welcome', '/privacy', '/studio-login', '/api/auth/pin-login', '/api/auth/studio-heartbeat', '/api/auth/studio-signout', '/ffmpeg/', '/embed/', '/bca/']
  const isPublic = publicPaths.some(p => request.nextUrl.pathname.startsWith(p))
  if (isPublic) return NextResponse.next()

  // Allow API requests authenticated with a valid Bearer token. Two paths:
  //   1. CRM_API_KEY — used by n8n and similar external integrations. Fixed
  //      64-char hex, compared constant-time.
  //   2. Supabase JWT — used by the iOS mobile app. The JWT is the
  //      `access_token` from a successful Supabase auth session on the
  //      device. We validate it via `supabase.auth.getUser(token)`, which
  //      verifies the signature against the project's JWT secret over the
  //      network (no node:crypto needed — Edge-runtime safe).
  //
  // The CRM_API_KEY path is validated constant-time here AND a second time
  // in routes that call requireApiKey() — defense in depth. Routes without
  // requireApiKey() will still see the request as authenticated and can
  // call getCurrentUser() — which itself tries the Bearer header (mobile)
  // before falling back to cookies (web).
  if (request.nextUrl.pathname.startsWith('/api/')) {
    const auth = request.headers.get('authorization') || ''
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : ''

    if (token) {
      // Path 1: CRM_API_KEY (n8n)
      const expected = process.env.CRM_API_KEY
      if (expected && timingSafeEqualEdge(token, expected)) {
        return NextResponse.next()
      }

      // Path 2: Supabase JWT (mobile app). Use a stripped client (no
      // cookies) since the JWT is the source of truth. If the token is
      // malformed or expired, getUser() returns { user: null } and we
      // fall through to the cookie-session check below.
      try {
        const supabaseJwt = createServerClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL,
          process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
          { cookies: { getAll: () => [], setAll: () => {} } }
        )
        const { data: { user: jwtUser } } = await supabaseJwt.auth.getUser(token)
        if (jwtUser) return NextResponse.next()
      } catch {
        // Network blip or malformed token — fall through.
      }
    }
  }

  let response = NextResponse.next({
    request: { headers: request.headers },
  })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            request.cookies.set(name, value)
            response = NextResponse.next({
              request: { headers: request.headers },
            })
            response.cookies.set(name, value, options)
          })
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('redirect', request.nextUrl.pathname)
    return NextResponse.redirect(url)
  }

  return response
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico
     * - public assets
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
