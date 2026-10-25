'use client'

// VISIT-ORIGIN.1 — remembers the first page of a public-site visit and its
// referrer in sessionStorage so the booking and lead forms can say where the
// visitor came from. Renders nothing. Mounted on every public marketing page
// (the /welcome segment and /start); the first one to mount wins, later
// pages in the same tab are no-ops. See src/lib/visit-origin.js.

import { useEffect } from 'react'
import { rememberVisitOrigin } from '@/lib/visit-origin'

export default function VisitOriginCapture() {
  useEffect(() => { rememberVisitOrigin() }, [])
  return null
}
