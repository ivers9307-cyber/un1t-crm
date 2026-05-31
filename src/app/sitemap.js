import { createServerClient } from '@/lib/supabase'

export const revalidate = 3600

const BASE = 'https://crm.un1tdublin.com'

// Static marketing + app entry routes that should always be indexed.
const STATIC_ROUTES = [
  '',
  '/welcome',
  '/welcome/stillorgan',
  '/welcome/hatch-street',
]

// Pull published location landing pages for the sitemap. Queries
// Supabase DIRECTLY rather than self-fetching ${BASE}/api/public/locations
// — a build-time self-fetch hits the production domain before the new
// deployment is live, which fails the production build with ECONNREFUSED
// (the cause of the 7f57b3e build failure). Reading the DB is also faster
// and removes the network round-trip. Mirrors the query in
// /api/public/locations. Any failure degrades to the static routes so a
// transient DB blip can never fail the build.
async function publicLocations() {
  try {
    const db = createServerClient()
    const { data, error } = await db
      .from('landing_page_settings')
      .select('public_path, updated_at, published, locations(active)')
      .eq('published', true)
      .order('public_path')
    if (error) return []
    return (data || [])
      .filter((r) => r.public_path && r.locations?.active)
      .map((r) => ({ public_path: r.public_path, updated_at: r.updated_at }))
  } catch {
    return []
  }
}

export default async function sitemap() {
  const locations = await publicLocations()
  const locationRoutes = locations.map((loc) => ({
    url: `${BASE}/welcome/${loc.public_path}`,
    lastModified: loc.updated_at || new Date().toISOString(),
    changeFrequency: 'weekly',
    priority: 0.7,
  }))

  const staticRoutes = STATIC_ROUTES.map((path) => ({
    url: `${BASE}${path}`,
    lastModified: new Date().toISOString(),
    changeFrequency: 'weekly',
    priority: path === '' ? 1 : 0.8,
  }))

  return [...staticRoutes, ...locationRoutes]
}
