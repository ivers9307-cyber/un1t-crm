// /api-docs — Swagger UI viewer for the CRM API spec.
// Loaded behind the standard middleware auth, so only logged-in users
// (or callers with a Bearer token) reach it.

export const dynamic = 'force-dynamic'

export default function ApiDocsPage() {
  return (
    <html>
      <head>
        <title>UN1T CRM — API Reference</title>
        <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
      </head>
      <body style={{ margin: 0 }}>
        <div id="swagger-ui" />
        <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js" defer />
        <script
          // Initialise after the bundle script has parsed.
          dangerouslySetInnerHTML={{
            __html: `
              window.addEventListener('load', () => {
                window.ui = SwaggerUIBundle({
                  url: '/api/openapi.json',
                  dom_id: '#swagger-ui',
                  deepLinking: true,
                  presets: [SwaggerUIBundle.presets.apis],
                  layout: 'BaseLayout',
                })
              })
            `,
          }}
        />
      </body>
    </html>
  )
}
