// /welcome/[location]/status — PUBLIC, member-facing system status page
// (STATUS-PAGE.1). Lives under /welcome (already public in proxy.js +
// AppShell), resolved by landing_page_settings.public_path like the other
// public studio pages. No auth: it renders ONLY the coy member view from
// buildStatusView() — internal detail (counts, cron names, errors) never
// reaches it. Copy is operator-override-able via locations.settings.status_page.

import { notFound } from 'next/navigation'
import { createServerClient } from '@/lib/supabase'
import { getIntegrationHealth } from '@/lib/integration-health'
import { buildStatusView } from '@/lib/status-page'

// Short ISR cache — a public, unauthenticated page shouldn't run the health
// aggregator on every hit, and ~1 min freshness is fine for a status page.
export const revalidate = 60

const PILL = { operational: 'Operational', degraded: 'Degraded', down: 'Down' }

async function loadLocation(path) {
  try {
    const db = createServerClient()
    const { data } = await db
      .from('landing_page_settings')
      .select('location_id, locations:location_id ( id, name, settings )')
      .eq('public_path', path)
      .maybeSingle()
    return data?.locations || null
  } catch {
    return null
  }
}

export async function generateMetadata(props) {
  const { location } = await props.params
  const loc = await loadLocation(location)
  const name = loc?.name || 'UN1T'
  return {
    title: `${name} — System status`,
    description: `Live service status for ${name}. Booking, messaging, payments and email.`,
    robots: { index: false }, // status page shouldn't compete with the studio's real pages
  }
}

export default async function StatusPage(props) {
  const { location } = await props.params
  const loc = await loadLocation(location)
  if (!loc?.id) notFound()

  const db = createServerClient()
  let rows = []
  try { rows = await getIntegrationHealth(db, loc.id) } catch { rows = [] }
  const overrides = loc.settings?.status_page || {}
  const view = buildStatusView(rows, overrides)

  const updated = new Date().toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Dublin' })

  return (
    <div className="us-root" data-st={view.overall}>
      <style>{CSS}</style>
      <div className="us-wrap">
        <header className="us-mast">
          <div className="us-brand">
            <div className="us-wordmark">{view.brand}</div>
            {loc.name ? <div className="us-sub">{loc.name}</div> : null}
          </div>
          <div className="us-kicker">System status · updated <time>{updated}</time></div>
        </header>

        <section className="us-verdict">
          <div className="us-lamp-row">
            <span className="us-lamp" aria-hidden="true"></span>
            <span className="us-tag">{view.verdict.tag}</span>
          </div>
          <h1 className="us-headline">{view.verdict.headline}</h1>
          <p className="us-subline">{view.verdict.subline}</p>
        </section>

        <main className="us-services">
          {view.services.map((s) => (
            <article className="us-svc" data-st={s.status} key={s.key}>
              <div className="us-svc-top">
                <div className="us-svc-name"><span className="us-dot" aria-hidden="true"></span>{s.label}</div>
                <span className="us-pill">{PILL[s.status]}</span>
              </div>
              <p className="us-svc-desc">{s.desc}</p>
            </article>
          ))}
        </main>

        <footer className="us-foot">
          <div>This page updates automatically.</div>
          <div className="us-mono">No login needed</div>
        </footer>
      </div>
    </div>
  )
}

// Scoped, self-contained styling (namespaced .us-*). Monochrome UN1T with
// status as the only colour; light default + dark via prefers-color-scheme.
const CSS = `
.us-root { --bg:#F5F5F2; --panel:#FFF; --ink:#17181A; --muted:#6B6E73; --faint:#9A9DA2;
  --line:#E4E4E0; --mono:#55585D;
  --c-ok:#1F9D4D; --c-ok-soft:rgba(31,157,77,.12);
  --c-warn:#B67908; --c-warn-soft:rgba(182,121,8,.14);
  --c-down:#CE3134; --c-down-soft:rgba(206,49,52,.12);
  --mono-face:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  --body-face:"Helvetica Neue",Helvetica,Arial,system-ui,sans-serif;
  min-height:100vh; background:var(--bg); color:var(--ink); font-family:var(--body-face); }
@media (prefers-color-scheme: dark) { .us-root {
  --bg:#0E0F11; --panel:#16181B; --ink:#ECECEA; --muted:#9CA0A6; --faint:#6A6E74;
  --line:#24272B; --mono:#A7ABB1;
  --c-ok:#45C46B; --c-ok-soft:rgba(69,196,107,.14);
  --c-warn:#E0A012; --c-warn-soft:rgba(224,160,18,.15);
  --c-down:#E5484D; --c-down-soft:rgba(229,72,77,.15); } }
.us-root [data-st="operational"] { --st:var(--c-ok); --st-soft:var(--c-ok-soft); }
.us-root[data-st="operational"] { --st:var(--c-ok); --st-soft:var(--c-ok-soft); }
.us-root [data-st="degraded"] { --st:var(--c-warn); --st-soft:var(--c-warn-soft); }
.us-root[data-st="degraded"] { --st:var(--c-warn); --st-soft:var(--c-warn-soft); }
.us-root [data-st="down"] { --st:var(--c-down); --st-soft:var(--c-down-soft); }
.us-root[data-st="down"] { --st:var(--c-down); --st-soft:var(--c-down-soft); }
.us-wrap { max-width:680px; margin:0 auto; padding:clamp(20px,5vw,56px) 20px 48px; }
.us-mast { display:flex; align-items:baseline; justify-content:space-between; gap:16px;
  padding-bottom:22px; border-bottom:1px solid var(--line); flex-wrap:wrap; }
.us-brand { display:flex; align-items:baseline; gap:10px; }
.us-wordmark { font-weight:800; font-size:1.55rem; letter-spacing:.14em; text-transform:uppercase; }
.us-sub { font-family:var(--mono-face); font-size:.62rem; letter-spacing:.28em; text-transform:uppercase; color:var(--faint); }
.us-kicker { font-family:var(--mono-face); font-size:.66rem; letter-spacing:.2em; text-transform:uppercase; color:var(--muted); text-align:right; }
.us-kicker time { color:var(--ink); }
.us-verdict { margin:30px 0 34px; }
.us-lamp-row { display:flex; align-items:center; gap:14px; margin-bottom:20px; }
.us-lamp { width:15px; height:15px; border-radius:50%; background:var(--st);
  box-shadow:0 0 0 5px var(--st-soft), 0 0 18px 1px var(--st); flex:none; animation:us-pulse 2.4s ease-in-out infinite; }
@keyframes us-pulse { 0%,100%{ box-shadow:0 0 0 5px var(--st-soft),0 0 14px 0 var(--st);} 50%{ box-shadow:0 0 0 9px transparent,0 0 22px 2px var(--st);} }
.us-tag { font-family:var(--mono-face); font-size:.66rem; letter-spacing:.2em; text-transform:uppercase;
  color:var(--st); border:1px solid var(--st); padding:4px 9px; border-radius:999px; }
.us-headline { font-weight:800; font-size:clamp(2.2rem,7vw,4rem); line-height:.96; text-transform:uppercase;
  letter-spacing:-.01em; text-wrap:balance; margin:0; color:var(--st); }
.us-subline { color:var(--muted); font-size:1.02rem; line-height:1.5; margin:14px 0 0; max-width:46ch; }
.us-services { display:flex; flex-direction:column; gap:10px; }
.us-svc { position:relative; background:var(--panel); border:1px solid var(--line); border-radius:14px;
  padding:16px 18px 16px 20px; overflow:hidden; }
.us-svc::before { content:""; position:absolute; left:0; top:0; bottom:0; width:3px; background:var(--st); }
.us-svc-top { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.us-svc-name { display:flex; align-items:center; gap:10px; font-weight:700; font-size:1.02rem; }
.us-dot { width:9px; height:9px; border-radius:50%; background:var(--st); flex:none; }
.us-pill { font-family:var(--mono-face); font-size:.6rem; letter-spacing:.16em; text-transform:uppercase;
  color:var(--st); background:var(--st-soft); padding:4px 9px; border-radius:999px; white-space:nowrap; }
.us-svc-desc { color:var(--muted); font-size:.9rem; line-height:1.45; margin:7px 0 0; }
.us-foot { margin-top:30px; padding-top:22px; border-top:1px solid var(--line);
  display:flex; justify-content:space-between; gap:16px; flex-wrap:wrap; color:var(--faint); font-size:.84rem; }
.us-mono { font-family:var(--mono-face); font-size:.72rem; letter-spacing:.05em; }
@media (prefers-reduced-motion: reduce) { .us-lamp { animation:none; } }
`
