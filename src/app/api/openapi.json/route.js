import { NextResponse } from 'next/server'
import { getOpenApiSpec } from '@/lib/openapi'

export const runtime = 'nodejs'

// GET /api/openapi.json
//
// Returns the OpenAPI 3.1 spec for the CRM HTTP API. Auth via either:
//   - Supabase session (handled by middleware — any logged-in user)
//   - Authorization: Bearer <CRM_API_KEY> (also handled by middleware)
//
// The spec describes the API surface, not the data, so exposing it to any
// authenticated user is fine. Swagger UI / Redoc / Stoplight Studio can
// point at this URL directly.
export async function GET() {
  const spec = getOpenApiSpec()
  return NextResponse.json(spec, {
    headers: {
      // Cache for 5 minutes — spec changes only on deploy
      'Cache-Control': 'public, max-age=300',
    },
  })
}
