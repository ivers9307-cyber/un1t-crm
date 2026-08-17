// /api-docs — Swagger UI viewer for the CRM API spec.
//
// Served as a raw HTML route handler (not a Next.js page) so it bypasses the
// app's root layout (sidebar, providers, fonts) and renders standalone.
// Auth is still enforced by the global middleware — only logged-in users or
// callers with a valid Bearer token reach this URL.

export const runtime = 'nodejs'

// Phase 6 (Repset domain separation): the champ backend is gaining
// api.repset.ie. Stage 1 keeps the default on app.champfitness.ie (which
// keeps serving forever); Stage 2 flips this via CHAMP_OPENAPI_URL env
// once certs on the new host are live — no code change needed then.
const CHAMP_OPENAPI_URL =
  process.env.CHAMP_OPENAPI_URL || 'https://app.champfitness.ie/api/openapi.json'

const HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>UN1T — API Portal</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
    <style>
      html, body { margin: 0; padding: 0; }
      .topbar { display: none; }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      window.addEventListener('load', function () {
        window.ui = SwaggerUIBundle({
          urls: [
            { url: '/api/openapi.json', name: 'UN1T CRM' },
            { url: '${CHAMP_OPENAPI_URL}', name: 'Champ App' },
          ],
          'urls.primaryName': 'UN1T CRM',
          dom_id: '#swagger-ui',
          deepLinking: true,
          presets: [SwaggerUIBundle.presets.apis],
          layout: 'BaseLayout',
          docExpansion: 'list',
          defaultModelsExpandDepth: 1,
          tryItOutEnabled: true,
        })
      })
    </script>
  </body>
</html>`

export async function GET() {
  return new Response(HTML, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  })
}
