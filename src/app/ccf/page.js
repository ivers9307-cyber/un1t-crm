// /ccf — CCF Autos coming-soon landing page (CCF-WEB.1, spec
// 2026-08-04-ccfautos-coming-soon-design.md).
//
// Served on ccfautos.com (brand 'ccfautos-web' in src/lib/brands.js —
// root "/" rewrites here, so the URL bar stays clean). Deliberately
// self-contained: the CRM's un1t-* palette is a light theme and this
// page is a dark showroom — it carries its own scoped stylesheet and
// shares nothing with the CRM chrome. Copy is hard-coded by design for
// the placeholder (approved deviation from the operator-editable-copy
// invariant, spec §Decisions; the real inventory site gets editable
// copy).
//
// Public reachability: '/ccf' is allowlisted in src/lib/brands.js,
// src/proxy.js publicPaths and src/components/AppShell.jsx
// PUBLIC_PATHS — the three gates a logged-out visitor passes through.

import { Barlow, Barlow_Condensed } from 'next/font/google'
import EnquiryForm from './EnquiryForm'

const barlow = Barlow({ subsets: ['latin'], weight: ['400', '500', '600'] })
const barlowCondensed = Barlow_Condensed({ subsets: ['latin'], weight: ['500', '600', '700'] })

export const metadata = {
  title: 'CCF Autos — Quality Used Cars, Stillorgan · Coming Soon',
  description:
    'CCF Autos is opening soon at Stillorgan Village Centre, Lower Kilmacud Road, Dublin (A94 AC67). Quality used cars, hand-picked. Call 086 822 5779.',
}

export const viewport = { themeColor: '#0a0a0c' }

const PHONE_DISPLAY = '086 822 5779'
const PHONE_TEL = 'tel:+353868225779'
const MAPS_URL = 'https://maps.google.com/?q=Stillorgan+Village+Centre,+Lower+Kilmacud+Road,+Dublin'

export default function CcfComingSoonPage() {
  return (
    <div className={`ccf-page ${barlow.className}`}>
      <style>{CSS}</style>

      <header className="ccf-header ccf-reveal">
        <div className="ccf-wordmark" aria-label="CCF Autos">
          <span className={`ccf-wordmark-badge ${barlowCondensed.className}`}>CCF</span>
          <span className={`ccf-wordmark-text ${barlowCondensed.className}`}>AUTOS</span>
        </div>
        <a className="ccf-header-phone" href={PHONE_TEL}>
          <span className="ccf-header-phone-label">Call us&nbsp;·&nbsp;</span>
          {PHONE_DISPLAY}
        </a>
      </header>

      <main>
        <section className="ccf-hero">
          <p className="ccf-eyebrow ccf-reveal ccf-d1">Stillorgan · Dublin</p>
          <h1 className={`ccf-title ${barlowCondensed.className} ccf-reveal ccf-d2`}>
            CCF AUTOS
          </h1>
          <p className={`ccf-coming ${barlowCondensed.className} ccf-reveal ccf-d3`} aria-label="Coming soon">
            COMING&nbsp;SOON
          </p>
          <p className="ccf-lede ccf-reveal ccf-d4">
            A hand-picked selection of quality used cars is on its way to
            Stillorgan Village Centre. The showroom is being fitted out —
            the cars are already being chosen.
          </p>
        </section>

        <section className="ccf-info ccf-reveal ccf-d5" aria-label="Visit and contact details">
          <div className="ccf-info-card">
            <h2 className={`ccf-info-heading ${barlowCondensed.className}`}>Visit</h2>
            <address className="ccf-address">
              First Floor Unit<br />
              Stillorgan Village Centre<br />
              Lower Kilmacud Road<br />
              Co. Dublin
            </address>
            <p className="ccf-plate-row">
              <span className="ccf-plate" aria-label="Eircode A94 AC67">
                <span className={`ccf-plate-band ${barlowCondensed.className}`} aria-hidden="true">IRL</span>
                <span className={`ccf-plate-text ${barlowCondensed.className}`}>A94&nbsp;AC67</span>
              </span>
            </p>
            <a className="ccf-info-link" href={MAPS_URL} target="_blank" rel="noopener noreferrer">
              Open in Maps ↗
            </a>
          </div>
          <div className="ccf-info-card">
            <h2 className={`ccf-info-heading ${barlowCondensed.className}`}>Call</h2>
            <a className={`ccf-info-phone ${barlowCondensed.className}`} href={PHONE_TEL}>
              {PHONE_DISPLAY}
            </a>
            <p className="ccf-info-sub">Questions, early enquiries, or a car you&apos;re chasing — pick up the phone.</p>
          </div>
          <div className="ccf-info-card">
            <h2 className={`ccf-info-heading ${barlowCondensed.className}`}>Opening</h2>
            <p className={`ccf-info-big ${barlowCondensed.className}`}>Soon</p>
            <p className="ccf-info-sub">Doors open once the showroom&apos;s ready. Leave your details below and you&apos;ll be first to know.</p>
          </div>
        </section>

        <section className="ccf-enquire" aria-label="Send an enquiry">
          <div className="ccf-enquire-intro">
            <h2 className={`ccf-section-title ${barlowCondensed.className}`}>Looking for a particular car?</h2>
            <p className="ccf-section-sub">
              Tell us what you&apos;re after and we&apos;ll let you know the moment
              it — or the showroom — arrives.
            </p>
          </div>
          <EnquiryForm />
        </section>
      </main>

      <footer className="ccf-footer">
        <p>© 2026 CCF Autos · First Floor Unit, Stillorgan Village Centre, Lower Kilmacud Road, Co. Dublin, A94 AC67 · <a href={PHONE_TEL}>{PHONE_DISPLAY}</a></p>
      </footer>
    </div>
  )
}

// Scoped stylesheet — every selector is ccf-prefixed and everything
// hangs off .ccf-page, so nothing leaks into (or depends on) the CRM's
// light-theme styles. Tailwind's preflight still applies underneath.
const CSS = `
.ccf-page {
  --ccf-bg: #0a0a0c;
  --ccf-panel: #101013;
  --ccf-ink: #e8e6e1;
  --ccf-muted: #8f8b84;
  --ccf-accent: #c8a860;
  --ccf-line: rgba(255, 255, 255, 0.08);
  min-height: 100vh;
  background-color: var(--ccf-bg);
  background-image:
    radial-gradient(ellipse 90% 55% at 50% -12%, rgba(200, 168, 96, 0.16), transparent 62%),
    radial-gradient(ellipse 45% 30% at 50% 0%, rgba(255, 244, 214, 0.10), transparent 70%),
    linear-gradient(to bottom, transparent 58%, rgba(200, 168, 96, 0.045) 66%, transparent 78%);
  color: var(--ccf-ink);
  overflow-x: hidden;
  position: relative;
}
.ccf-page::after {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
  opacity: 0.05;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E");
}

/* ── reveal choreography ─────────────────────────────────────── */
.ccf-reveal {
  opacity: 0;
  transform: translateY(18px);
  animation: ccf-up 0.7s cubic-bezier(0.22, 1, 0.36, 1) forwards;
}
.ccf-d1 { animation-delay: 0.08s; }
.ccf-d2 { animation-delay: 0.16s; }
.ccf-d3 { animation-delay: 0.28s; }
.ccf-d4 { animation-delay: 0.4s; }
.ccf-d5 { animation-delay: 0.52s; }
@keyframes ccf-up {
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .ccf-reveal { animation: none; opacity: 1; transform: none; }
}

/* ── header ──────────────────────────────────────────────────── */
.ccf-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  max-width: 72rem;
  margin: 0 auto;
  padding: 1.5rem 1.5rem 0;
}
.ccf-wordmark { display: flex; align-items: center; gap: 0.6rem; }
.ccf-wordmark-badge {
  border: 1px solid var(--ccf-accent);
  color: var(--ccf-accent);
  font-weight: 700;
  font-size: 1.05rem;
  letter-spacing: 0.14em;
  padding: 0.28rem 0.5rem 0.22rem 0.62rem;
  line-height: 1;
}
.ccf-wordmark-text {
  font-weight: 600;
  font-size: 1.05rem;
  letter-spacing: 0.34em;
}
.ccf-header-phone {
  color: var(--ccf-ink);
  text-decoration: none;
  font-size: 0.95rem;
  letter-spacing: 0.06em;
  border-bottom: 1px solid rgba(200, 168, 96, 0.45);
  padding-bottom: 2px;
  transition: color 0.2s;
}
.ccf-header-phone:hover { color: var(--ccf-accent); }
@media (max-width: 640px) { .ccf-header-phone-label { display: none; } }

/* ── hero ────────────────────────────────────────────────────── */
.ccf-hero {
  max-width: 72rem;
  margin: 0 auto;
  padding: clamp(4.5rem, 12vh, 8.5rem) 1.5rem 3rem;
}
.ccf-eyebrow {
  display: flex;
  align-items: center;
  gap: 0.9rem;
  color: var(--ccf-accent);
  font-size: 0.8rem;
  font-weight: 600;
  letter-spacing: 0.42em;
  text-transform: uppercase;
}
.ccf-eyebrow::before {
  content: '';
  width: 2.6rem;
  height: 1px;
  background: var(--ccf-accent);
}
.ccf-title {
  margin-top: 1.1rem;
  font-size: clamp(4.2rem, 15vw, 10.5rem);
  font-weight: 700;
  line-height: 0.9;
  letter-spacing: 0.01em;
  background: linear-gradient(to bottom, #f5f2ea 55%, #a49a86);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.ccf-coming {
  margin-top: 0.4rem;
  font-size: clamp(2rem, 6.5vw, 4.4rem);
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0.12em;
  color: transparent;
  -webkit-text-stroke: 1.5px var(--ccf-accent);
}
.ccf-lede {
  margin-top: 1.8rem;
  max-width: 34rem;
  color: var(--ccf-muted);
  font-size: 1.08rem;
  line-height: 1.7;
}

/* ── info cards ──────────────────────────────────────────────── */
.ccf-info {
  max-width: 72rem;
  margin: 0 auto;
  padding: 1.5rem;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1rem;
}
@media (max-width: 820px) { .ccf-info { grid-template-columns: 1fr; } }
.ccf-info-card {
  background: var(--ccf-panel);
  border: 1px solid var(--ccf-line);
  border-top: 2px solid rgba(200, 168, 96, 0.55);
  padding: 1.6rem 1.5rem 1.5rem;
}
.ccf-info-heading {
  font-size: 0.85rem;
  font-weight: 600;
  letter-spacing: 0.34em;
  text-transform: uppercase;
  color: var(--ccf-accent);
  margin-bottom: 0.9rem;
}
.ccf-address { font-style: normal; line-height: 1.65; color: var(--ccf-ink); }
.ccf-plate-row { margin-top: 0.9rem; }
.ccf-plate {
  display: inline-flex;
  align-items: stretch;
  border-radius: 5px;
  overflow: hidden;
  border: 1px solid rgba(0, 0, 0, 0.6);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.45);
}
.ccf-plate-band {
  background: #003399;
  color: #ffcc00;
  font-size: 0.62rem;
  font-weight: 700;
  display: flex;
  align-items: flex-end;
  padding: 0.24rem 0.3rem;
}
.ccf-plate-text {
  background: #f4f4f0;
  color: #111;
  font-weight: 700;
  font-size: 1.02rem;
  letter-spacing: 0.1em;
  padding: 0.24rem 0.6rem 0.18rem;
}
.ccf-info-link {
  display: inline-block;
  margin-top: 1rem;
  color: var(--ccf-muted);
  font-size: 0.9rem;
  text-decoration: none;
  border-bottom: 1px solid rgba(255, 255, 255, 0.2);
  padding-bottom: 2px;
  transition: color 0.2s, border-color 0.2s;
}
.ccf-info-link:hover { color: var(--ccf-accent); border-color: var(--ccf-accent); }
.ccf-info-phone {
  display: inline-block;
  color: var(--ccf-ink);
  text-decoration: none;
  font-size: clamp(1.9rem, 3.2vw, 2.4rem);
  font-weight: 700;
  letter-spacing: 0.05em;
  transition: color 0.2s;
}
.ccf-info-phone:hover { color: var(--ccf-accent); }
.ccf-info-big {
  font-size: clamp(1.9rem, 3.2vw, 2.4rem);
  font-weight: 700;
  letter-spacing: 0.05em;
}
.ccf-info-sub { margin-top: 0.6rem; color: var(--ccf-muted); font-size: 0.95rem; line-height: 1.6; }

/* ── enquiry section ─────────────────────────────────────────── */
.ccf-enquire {
  max-width: 72rem;
  margin: 0 auto;
  padding: 3.5rem 1.5rem 4.5rem;
  display: grid;
  grid-template-columns: 5fr 7fr;
  gap: 2.5rem;
  align-items: start;
}
@media (max-width: 820px) { .ccf-enquire { grid-template-columns: 1fr; } }
.ccf-section-title {
  font-size: clamp(2rem, 4.4vw, 3rem);
  font-weight: 700;
  line-height: 1.05;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}
.ccf-section-sub { margin-top: 1rem; color: var(--ccf-muted); line-height: 1.7; max-width: 26rem; }
.ccf-form-card {
  background: var(--ccf-panel);
  border: 1px solid var(--ccf-line);
  padding: 1.8rem;
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
}
.ccf-field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 1.1rem; }
@media (max-width: 560px) { .ccf-field-row { grid-template-columns: 1fr; } }
.ccf-field { display: flex; flex-direction: column; gap: 0.45rem; }
.ccf-field > span {
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--ccf-muted);
}
.ccf-field input,
.ccf-field textarea {
  background: #16161a;
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: var(--ccf-ink);
  padding: 0.7rem 0.85rem;
  font-size: 1rem;
  border-radius: 2px;
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.ccf-field input::placeholder,
.ccf-field textarea::placeholder { color: #5c5952; }
.ccf-field input:focus,
.ccf-field textarea:focus {
  border-color: var(--ccf-accent);
  box-shadow: 0 0 0 3px rgba(200, 168, 96, 0.22);
}
.ccf-field textarea { resize: vertical; min-height: 6rem; }
.ccf-form-error { color: #e2a1a1; font-size: 0.95rem; }
.ccf-submit {
  background: var(--ccf-accent);
  color: #131313;
  border: none;
  cursor: pointer;
  font-weight: 600;
  font-size: 0.9rem;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  padding: 0.95rem 1rem;
  border-radius: 2px;
  transition: filter 0.2s, transform 0.15s;
}
.ccf-submit:hover:not(:disabled) { filter: brightness(1.12); }
.ccf-submit:active:not(:disabled) { transform: translateY(1px); }
.ccf-submit:disabled { opacity: 0.6; cursor: default; }
.ccf-form-note { color: #6a675f; font-size: 0.8rem; }
.ccf-sent { align-items: flex-start; gap: 0.7rem; }
.ccf-sent-mark {
  width: 2.4rem;
  height: 2.4rem;
  border-radius: 50%;
  border: 1px solid var(--ccf-accent);
  color: var(--ccf-accent);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.2rem;
}
.ccf-sent h3 { font-size: 1.25rem; font-weight: 600; }
.ccf-sent p { color: var(--ccf-muted); line-height: 1.65; }
.ccf-sent a { color: var(--ccf-accent); text-decoration: none; }

/* ── footer ──────────────────────────────────────────────────── */
.ccf-footer {
  border-top: 1px solid var(--ccf-line);
  padding: 1.6rem 1.5rem 2rem;
  text-align: center;
  color: #6a675f;
  font-size: 0.82rem;
  line-height: 1.7;
}
.ccf-footer a { color: inherit; text-decoration: none; border-bottom: 1px solid rgba(255,255,255,0.15); }
.ccf-footer a:hover { color: var(--ccf-accent); }
`
