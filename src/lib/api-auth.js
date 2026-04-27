import { NextResponse } from 'next/server'

// Validates the API key sent by n8n in the Authorization header
// Usage: const error = requireApiKey(request); if (error) return error;
export function requireApiKey(request) {
  const auth = request.headers.get('authorization') || ''
  const token = auth.replace('Bearer ', '')

  if (!token || token !== process.env.CRM_API_KEY) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized' },
      { status: 401 }
    )
  }
  return null // auth OK
}
