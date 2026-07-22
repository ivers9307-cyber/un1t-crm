'use client'

// Root error boundary (OBSERVABILITY — audit OBS-2/3). A render crash that
// escapes every nested boundary replaces the whole document, so this must ship
// its own <html>/<body> and cannot rely on the app's layout or CSS (inline
// styles only). When the crash originates server-side, error.digest matches the
// row captured by src/instrumentation.js onRequestError, so a user who quotes it
// can be joined to the server error. (Server-side beacon for purely-client
// crashes is a deliberate follow-up — avoided here to not add a public endpoint.)

import { useEffect } from 'react'

export default function GlobalError({ error, reset }) {
  useEffect(() => {
    // Vercel captures SSR console, not the client's; this at least surfaces the
    // crash + its digest in the browser console for support.
    console.error('[global-error] render crash', {
      digest: error?.digest,
      name: error?.name,
      message: error?.message,
    })
  }, [error])

  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif', background: '#F7F8FA', color: '#1E293B' }}>
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
          <div style={{ maxWidth: 420, width: '100%', textAlign: 'center' }}>
            <h1 style={{ fontSize: '1.25rem', fontWeight: 600, margin: '0 0 0.5rem' }}>Something went wrong</h1>
            <p style={{ fontSize: '0.875rem', color: '#64748B', margin: '0 0 1.5rem' }}>
              An unexpected error interrupted this page. Trying again usually fixes it.
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center' }}>
              <button
                type="button"
                onClick={() => reset()}
                style={{ padding: '0.5rem 1rem', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: '0.875rem', fontWeight: 600, background: '#1E293B', color: '#fff' }}
              >
                Try again
              </button>
              <button
                type="button"
                onClick={() => { if (typeof window !== 'undefined') window.location.reload() }}
                style={{ padding: '0.5rem 1rem', borderRadius: 6, border: '1px solid #CBD5E1', cursor: 'pointer', fontSize: '0.875rem', fontWeight: 600, background: '#fff', color: '#1E293B' }}
              >
                Reload
              </button>
            </div>
            {error?.digest ? (
              <p style={{ fontSize: '0.75rem', color: '#94A3B8', marginTop: '1.5rem' }}>Reference: {error.digest}</p>
            ) : null}
          </div>
        </div>
      </body>
    </html>
  )
}
