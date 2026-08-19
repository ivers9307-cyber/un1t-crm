import { createServerClient } from '@supabase/ssr'
import { NextResponse } from 'next/server'
import { resolveBrand, isFrameworkAsset } from '@/lib/brands'
import { resolveTenantDomainBrand } from '@/lib/tenant-domains-edge'
import { isApiKeyToken, sha256HexEdge } from '@/lib/api-keys-edge'
import { readSupportModeEdge, decideSupportWriteBlock } from '@/lib/support-session-edge'
import { decideLegacyHostRedirect } from '@/lib/legacy-host-redirect'
import { decideStaffWebLock, STUDIO_SESSION_COOKIE } from '@/lib/staff-web-lock'

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

  // ── Legacy CRM host → canonical repset host (REPSET-P6.S2) ───────
  // Env-gated safety valve, default OFF. When REDIRECT_LEGACY_CRM_HOST=1,
  // GET/HEAD page requests arriving on the exact legacy host
  // (crm.un1tdublin.com) 308 to https://crm.repset.ie preserving the full
  // path + query. The decision table — flag, exact-host match, method,
  // the /api/* + /auth/callback + /reset-password exclusions — is pure
  // and unit-tested in src/lib/legacy-host-redirect.test.js. Because it
  // matches ONLY the exact CRM host it cannot interfere with the brand
  // hosts resolved below (marketing un1tdublin.com, pay.ccfautos.com,
  // DB-tier tenant domains all fall straight through).
  {
    const legacy = decideLegacyHostRedirect({
      enabled: process.env.REDIRECT_LEGACY_CRM_HOST === '1',
      host: hostname,
      method: request.method,
      pathname: request.nextUrl.pathname,
      search: request.nextUrl.search,
    })
    if (legacy) {
      return NextResponse.redirect(legacy.location, legacy.status)
    }
  }

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
  let brand = resolveBrand(hostname)

  // ── DB tier (SAAS-8, tenant_domains — mig 415) ───────────────────
  // Consulted ONLY when the in-code registry misses, so the live
  // hostnames above never pay the lookup and behave identically even
  // with the DB slow/down/empty. The module holds a ~5-min in-memory
  // cache of the active rows (failures cached too), so per-request
  // cost here is an in-memory scan; any error resolves null and the
  // request falls through to the CRM auth gate below exactly as an
  // unknown hostname does today. A DB brand returns the same shape as
  // resolveBrand (+ organizationId) and rides the identical handler
  // block — including the in-proxy root "/" rewrite, which DB brands
  // depend on outright (the next.config host rewrites are build-baked
  // and only cover un1tdublin.com).
  if (!brand) {
    brand = await resolveTenantDomainBrand(hostname)
  }
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

  // ── SUPPORT-ACCESS — read-only support-session write block ───────
  // THE SECURITY CRUX (Repset Phase 3). A master helping a tenant can
  // open a READ-ONLY support session (mode=read_only, carried in the
  // signed `un1t_support` cookie). While that session is read-only,
  // EVERY state-changing request is rejected HERE — the single central
  // chokepoint that already runs on every request — so enforcement
  // never relies on hiding UI buttons. This deliberately runs BEFORE the
  // public-path / Bearer gates so nothing mutating can slip past it, and
  // it covers BOTH `/api/*` mutations AND Next.js server-action POSTs to
  // page routes (both arrive here as POST/PUT/PATCH/DELETE).
  //
  // FAIL CLOSED (see decideSupportWriteBlock): a write is allowed ONLY
  // when the mode is EXACTLY 'act_on_behalf'; a present-but-unverifiable
  // (tampered/corrupt) cookie resolves to read_only and blocks. GET/HEAD/
  // OPTIONS are always allowed. The ONLY mutating exceptions are the
  // support-session control routes (exit / switch-mode) + the
  // impersonation stop escape-hatch — a master must always be able to
  // leave or upgrade the session.
  {
    const support = await readSupportModeEdge(request)
    const decision = decideSupportWriteBlock(support, request.method, request.nextUrl.pathname)
    if (decision.block) {
      return NextResponse.json(
        {
          success: false,
          error: 'read_only_support_mode',
          message: 'Read-only support mode — writes are disabled. Switch to “Act on behalf” to make changes.',
        },
        { status: 403 }
      )
    }
  }

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
  // /api/fleet/ — the Pi fleet agent (FLEET-CMD.1). Exactly the /api/bridge/
  // case: the agent authenticates per-request with its own `fdv_` bearer,
  // verified in-handler by verifyFleetDeviceToken (sha256 match against
  // fleet_devices.api_token_hash), and both routes scope every read and write
  // to the device that token resolves to. Without this entry every agent call
  // 307s to /login — which is precisely how it failed on stillorgan-tv2 on
  // 2026-08-02: the agent received the login PAGE, tried to JSON.parse the
  // HTML, and crash-looped. NOTE the admin side (/api/admin/fleet/*) is
  // deliberately NOT here — that is session-authenticated staff surface.
  // /h/ — public host mailing-list signup pages (HOST-EMAIL.2); their backing
  // API (/api/public/host-list/) rides the existing /api/public/ prefix. The
  // per-host unsubscribe page (/unsubscribe/host/[token]) rides /unsubscribe/.
  // /view-email/ — WEBVIEW.1, the hosted "view in browser" copy of a campaign
  // (Gmail clips a message over ~102KB, taking the footer and its unsubscribe
  // link with it). Authorised by an HMAC token that names one campaign and no
  // contact, so there is no session to gate on and nothing personal behind it.
  // /account-deletion — PUBPATH.1. App-store compliance surface: it is the URL
  // registered in the Google Play Console's "Account Deletion URL" field
  // (docs/architecture/MOBILE.md — https://crm.un1tdublin.com/account-deletion,
  // i.e. THIS host) and the Apple Guideline 5.1.1(v) deletion page, so a store
  // reviewer with no session must reach it. It shipped auth-walled: the page's
  // own header says "Must be publicly accessible (no auth) so reviewers can
  // verify" while every anonymous hit 307'd to /login. Nothing personal is
  // behind it — it is static copy naming an email address.
  const publicPaths = ['/login', '/auth/callback', '/reset-password', '/book/', '/event/', '/event-pay/', '/class-pay/', '/tv/', '/present/', '/api/public/', '/unsubscribe/', '/preferences/', '/view-email/', '/api/unsubscribe/', '/api/preferences/', '/api/webhooks/', '/api/whatsapp/flow', '/api/cron/', '/api/bridge/', '/api/fleet/', '/deposit/', '/welcome', '/free-class', '/start', '/offers', '/.well-known/', '/privacy', '/terms', '/legal/', '/technical', '/account-deletion', '/ccf', '/studio-login', '/api/auth/pin-login', '/api/auth/studio-heartbeat', '/api/auth/studio-signout', '/ffmpeg/', '/embed/', '/bca/', '/host-connect/', '/host', '/api/host/', '/h/', '/use-the-app']
  const isPublic = publicPaths.some(p => request.nextUrl.pathname.startsWith(p))
  if (isPublic) return NextResponse.next()

  // Allow API requests authenticated with a valid Bearer token. Three paths:
  //   1. CRM_API_KEY — the legacy shared key used by n8n and similar
  //      external integrations. Fixed 64-char hex, compared constant-time.
  //      Unchanged — live n8n workflows depend on it.
  //   2. Per-org API key (SAAS-3) — `unitk_…` keys from mig 217, issued at
  //      /settings/api-keys. REAL validation here (SHA-256 via Web Crypto +
  //      an active-row lookup in api_keys), not just a format sniff: a few
  //      routes behind this gate (e.g. /api/openapi.json) have no in-route
  //      auth of their own, so format-only admission would open them to
  //      any `unitk_`-shaped string. Routes that carry data re-resolve the
  //      key via authenticateApiKey()/requireApiKeyOrManager() and scope
  //      every query to the key's organization — defense in depth, same
  //      double-validation shape as the CRM_API_KEY path.
  //   3. Supabase JWT — used by the iOS mobile app. The JWT is the
  //      `access_token` from a successful Supabase auth session on the
  //      device. We validate it via `supabase.auth.getUser(token)`, which
  //      verifies the signature against the project's JWT secret over the
  //      network (no node:crypto needed — Edge-runtime safe).
  //
  // Routes without their own key check will still see the request as
  // authenticated and can call getCurrentUser() — which itself tries the
  // Bearer header (mobile) before falling back to cookies (web).
  if (request.nextUrl.pathname.startsWith('/api/')) {
    const auth = request.headers.get('authorization') || ''
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : ''

    if (token) {
      // Path 1: CRM_API_KEY (n8n)
      const expected = process.env.CRM_API_KEY
      if (expected && timingSafeEqualEdge(token, expected)) {
        return NextResponse.next()
      }

      if (isApiKeyToken(token)) {
        // Path 2: per-org API key (SAAS-3). One PostgREST lookup by hash
        // (unique partial index on active key_hash) — comparable edge cost
        // to the JWT path's auth.getUser() network call, and only paid by
        // `unitk_` traffic. No last_used_at stamp here: middleware stays
        // read-only; authenticateApiKey() stamps it in-route.
        if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
          try {
            const admin = createServerClient(
              process.env.NEXT_PUBLIC_SUPABASE_URL,
              process.env.SUPABASE_SERVICE_ROLE_KEY,
              { cookies: { getAll: () => [], setAll: () => {} } }
            )
            const { data: keyRow } = await admin
              .from('api_keys')
              .select('id')
              .eq('key_hash', await sha256HexEdge(token))
              .is('revoked_at', null)
              .maybeSingle()
            if (keyRow) return NextResponse.next()
          } catch {
            // Lookup failure — fail closed, fall through to the cookie gate.
          }
        }
        // Unknown/revoked per-org key. A `unitk_` token is never a valid
        // Supabase JWT — skip Path 3's network round-trip and fall through
        // to the cookie gate below (which rejects keyless callers).
      } else {
        // Path 3: Supabase JWT (mobile app). Use a stripped client (no
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

  // STAFF-WEB-LOCK — with the flag on, an authenticated page request from a
  // staff session is walled off to /use-the-app (every resolved profile on
  // this host is a staff role, so no profiles lookup is needed). Studio
  // devices ride the studio_session cookie exemption; TVs/present/cast and
  // /api/* returned earlier and never reach this. Decision + full rationale
  // in src/lib/staff-web-lock.js.
  const lock = decideStaffWebLock({
    enabled: process.env.STAFF_WEB_LOCK === '1',
    pathname: request.nextUrl.pathname,
    hasStudioSession: Boolean(request.cookies.get(STUDIO_SESSION_COOKIE)?.value),
  })
  if (lock) {
    const url = request.nextUrl.clone()
    url.pathname = lock.redirect
    url.search = ''
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
