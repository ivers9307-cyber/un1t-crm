import { createServerClient } from '@supabase/ssr'
import { NextResponse } from 'next/server'

// Constant-time string compare. Implemented inline because middleware runs
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

export async function middleware(request) {
  // Public routes that don't require auth
  const publicPaths = ['/login', '/reset-password', '/book/', '/api/public/', '/unsubscribe/', '/preferences/', '/api/unsubscribe/', '/api/preferences/', '/api/webhooks/', '/api/cron/', '/cars/deposit/']
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
