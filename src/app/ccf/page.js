// /ccf — CCF Autos coming-soon landing page (CCF-WEB.1, spec
// 2026-08-04-ccfautos-coming-soon-design.md; visual refresh CCF-WEB.2,
// Richard 2026-08-04: "make it look like a car dealership site" — the
// original dark/champagne treatment read as an AI template).
//
// Served on ccfautos.com (brand 'ccfautos-web' in src/lib/brands.js —
// root "/" rewrites here, so the URL bar stays clean). Deliberately
// self-contained: it carries its own scoped stylesheet and shares
// nothing with the CRM chrome. Copy is hard-coded by design for the
// placeholder (approved deviation from the operator-editable-copy
// invariant, spec §Decisions; the real inventory site gets editable
// copy). No em-dashes in customer-facing copy (Richard's rule).
//
// Public reachability: '/ccf' is allowlisted in src/lib/brands.js,
// src/proxy.js publicPaths and src/components/AppShell.jsx
// PUBLIC_PATHS — the three gates a logged-out visitor passes through.

import { Barlow, Barlow_Condensed } from 'next/font/google'
import EnquiryForm from './EnquiryForm'

const barlow = Barlow({ subsets: ['latin'], weight: ['400', '500', '600', '700'] })
const barlowCondensed = Barlow_Condensed({ subsets: ['latin'], weight: ['600', '700'] })

export const metadata = {
  title: 'CCF Autos — Quality Used Cars, Stillorgan · Opening Soon',
  description:
    'CCF Autos is opening soon at Stillorgan Village Centre, Lower Kilmacud Road, Dublin (A94 AC67). Quality used cars. Call 086 822 5779.',
}

export const viewport = { themeColor: '#152a4e' }

const PHONE_DISPLAY = '086 822 5779'
const PHONE_TEL = 'tel:+353868225779'
const MAPS_URL = 'https://maps.google.com/?q=Stillorgan+Village+Centre,+Lower+Kilmacud+Road,+Dublin'

function PinIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 1 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  )
}

function PhoneIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.5 2.1L8 10a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.9.7a2 2 0 0 1 1.7 2Z" />
    </svg>
  )
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  )
}

export default function CcfComingSoonPage() {
  return (
    <div className={`ccf-page ${barlow.className}`}>
      <style>{CSS}</style>

      <div className="ccf-topbar">
        <span className="ccf-topbar-item">
          <PinIcon /> Stillorgan Village Centre, Lower Kilmacud Road
        </span>
        <a className="ccf-topbar-item ccf-topbar-phone" href={PHONE_TEL}>
          <PhoneIcon /> {PHONE_DISPLAY}
        </a>
      </div>

      <header className="ccf-header">
        <div className="ccf-logo" aria-label="CCF Autos, quality used cars">
          <span className={`ccf-logo-badge ${barlowCondensed.className}`}>CCF</span>
          <span className="ccf-logo-text">
            <span className={`ccf-logo-name ${barlowCondensed.className}`}>AUTOS</span>
            <span className="ccf-logo-tag">Quality Used Cars</span>
          </span>
        </div>
        <a className="ccf-call-btn" href={PHONE_TEL}>
          <PhoneIcon />
          <span className="ccf-call-btn-text">
            <span className="ccf-call-btn-label">Call us today</span>
            <span className="ccf-call-btn-number">{PHONE_DISPLAY}</span>
          </span>
        </a>
      </header>

      <main>
        <section className="ccf-hero">
          <div className="ccf-hero-inner">
            <div className="ccf-hero-copy">
              <p className={`ccf-badge ${barlowCondensed.className}`}>Opening soon</p>
              <h1 className={barlowCondensed.className}>
                Quality used cars,<br />coming to Stillorgan
              </h1>
              <p className="ccf-hero-sub">
                CCF Autos is opening at Stillorgan Village Centre. We&apos;re
                fitting out the premises and sourcing our first cars now. For
                early enquiries, give us a call or leave your details below.
              </p>
              <div className="ccf-hero-ctas">
                <a className="ccf-btn ccf-btn-primary" href={PHONE_TEL}>Call {PHONE_DISPLAY}</a>
                <a className="ccf-btn ccf-btn-outline" href="#enquiry">Register your interest</a>
              </div>
            </div>

            <aside className="ccf-visit-card">
              <h2 className={`ccf-visit-title ${barlowCondensed.className}`}>Find us</h2>
              <ul className="ccf-visit-list">
                <li>
                  <PinIcon />
                  <div>
                    First Floor Unit, Stillorgan Village Centre,<br />
                    Lower Kilmacud Road, Co. Dublin
                    <div className="ccf-eircode">Eircode: A94 AC67</div>
                  </div>
                </li>
                <li>
                  <PhoneIcon />
                  <div><a href={PHONE_TEL}>{PHONE_DISPLAY}</a></div>
                </li>
                <li>
                  <ClockIcon />
                  <div>Opening hours announced soon</div>
                </li>
              </ul>
              <a className="ccf-maps-link" href={MAPS_URL} target="_blank" rel="noopener noreferrer">
                Get directions on Google Maps
              </a>
            </aside>
          </div>
        </section>

        <section className="ccf-enquiry" id="enquiry">
          <div className="ccf-enquiry-inner">
            <div className="ccf-enquiry-copy">
              <h2 className={barlowCondensed.className}>Looking for a particular car?</h2>
              <p>
                Tell us the make, model or budget you have in mind and
                we&apos;ll be in touch as soon as we can help. You&apos;ll also
                be first to hear when we open.
              </p>
              <p className="ccf-enquiry-alt">
                Prefer to talk? Call <a href={PHONE_TEL}>{PHONE_DISPLAY}</a>.
              </p>
            </div>
            <EnquiryForm />
          </div>
        </section>
      </main>

      <footer className="ccf-footer">
        <div className="ccf-footer-inner">
          <div className="ccf-logo ccf-logo-footer" aria-hidden="true">
            <span className={`ccf-logo-badge ${barlowCondensed.className}`}>CCF</span>
            <span className={`ccf-logo-name ${barlowCondensed.className}`}>AUTOS</span>
          </div>
          <p>
            First Floor Unit, Stillorgan Village Centre, Lower Kilmacud Road, Co. Dublin, A94 AC67
            <br />
            <a href={PHONE_TEL}>{PHONE_DISPLAY}</a> · © 2026 CCF Autos
          </p>
        </div>
      </footer>
    </div>
  )
}

// Scoped stylesheet — every selector is ccf-prefixed and everything
// hangs off .ccf-page, so nothing leaks into (or depends on) the CRM's
// styles. Tailwind's preflight still applies underneath.
const CSS = `
.ccf-page {
  --ccf-navy: #152a4e;
  --ccf-navy-deep: #0f1f3c;
  --ccf-red: #d22b2b;
  --ccf-red-dark: #b32222;
  --ccf-ink: #1c2434;
  --ccf-muted: #5b6472;
  --ccf-bg: #ffffff;
  --ccf-grey: #f2f4f7;
  --ccf-line: #e3e7ee;
  min-height: 100vh;
  background: var(--ccf-bg);
  color: var(--ccf-ink);
  font-size: 16px;
  line-height: 1.6;
}
.ccf-page svg { width: 1.15em; height: 1.15em; flex: none; }

/* ── top bar ─────────────────────────────────────────────────── */
.ccf-topbar {
  background: var(--ccf-navy-deep);
  color: #c7d0de;
  font-size: 0.85rem;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  padding: 0.45rem 1.25rem;
}
.ccf-topbar-item { display: inline-flex; align-items: center; gap: 0.45rem; }
.ccf-topbar-phone { color: #fff; text-decoration: none; font-weight: 600; }
.ccf-topbar-phone:hover { text-decoration: underline; }
@media (max-width: 640px) { .ccf-topbar-item:first-child { display: none; } .ccf-topbar { justify-content: center; } }

/* ── header ──────────────────────────────────────────────────── */
.ccf-header {
  max-width: 70rem;
  margin: 0 auto;
  padding: 1.1rem 1.25rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}
.ccf-logo { display: flex; align-items: center; gap: 0.7rem; }
.ccf-logo-badge {
  background: var(--ccf-red);
  color: #fff;
  font-weight: 700;
  font-size: 1.5rem;
  line-height: 1;
  padding: 0.5rem 0.55rem 0.4rem;
  border-radius: 4px;
  letter-spacing: 0.04em;
}
.ccf-logo-text { display: flex; flex-direction: column; line-height: 1.1; }
.ccf-logo-name {
  color: var(--ccf-navy);
  font-weight: 700;
  font-size: 1.5rem;
  letter-spacing: 0.16em;
}
.ccf-logo-tag {
  color: var(--ccf-muted);
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}
.ccf-call-btn {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  text-decoration: none;
  border: 2px solid var(--ccf-navy);
  border-radius: 6px;
  padding: 0.45rem 0.9rem;
  color: var(--ccf-navy);
  transition: background 0.15s, color 0.15s;
}
.ccf-call-btn:hover { background: var(--ccf-navy); color: #fff; }
.ccf-call-btn-text { display: flex; flex-direction: column; line-height: 1.15; }
.ccf-call-btn-label { font-size: 0.68rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; opacity: 0.75; }
.ccf-call-btn-number { font-weight: 700; font-size: 1.05rem; white-space: nowrap; }
@media (max-width: 640px) {
  .ccf-call-btn-label { display: none; }
  .ccf-call-btn { padding: 0.4rem 0.7rem; }
  .ccf-call-btn-number { font-size: 0.95rem; }
  .ccf-logo-tag { display: none; }
  .ccf-logo-badge { font-size: 1.25rem; }
  .ccf-logo-name { font-size: 1.25rem; }
}

/* ── hero ────────────────────────────────────────────────────── */
.ccf-hero {
  background:
    linear-gradient(115deg, var(--ccf-navy) 0%, var(--ccf-navy) 55%, #1d3a6b 55.2%, #1d3a6b 70%, #22437c 70.2%, #22437c 100%);
  color: #fff;
}
.ccf-hero-inner {
  max-width: 70rem;
  margin: 0 auto;
  padding: 3.5rem 1.25rem 3.75rem;
  display: grid;
  grid-template-columns: 7fr 5fr;
  gap: 2.5rem;
  align-items: center;
}
@media (max-width: 860px) { .ccf-hero-inner { grid-template-columns: 1fr; } }
.ccf-badge {
  display: inline-block;
  background: var(--ccf-red);
  color: #fff;
  font-weight: 700;
  font-size: 0.85rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  padding: 0.32rem 0.7rem 0.26rem;
  border-radius: 4px;
}
.ccf-hero-copy h1 {
  margin-top: 1rem;
  font-size: clamp(2.3rem, 5.4vw, 3.6rem);
  font-weight: 700;
  line-height: 1.06;
  letter-spacing: 0.01em;
}
.ccf-hero-sub {
  margin-top: 1.1rem;
  max-width: 32rem;
  color: #cfd8e6;
  font-size: 1.05rem;
}
.ccf-hero-ctas { margin-top: 1.7rem; display: flex; flex-wrap: wrap; gap: 0.8rem; }
.ccf-btn {
  display: inline-block;
  text-decoration: none;
  font-weight: 700;
  font-size: 1rem;
  padding: 0.8rem 1.4rem;
  border-radius: 6px;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.ccf-btn-primary { background: var(--ccf-red); color: #fff; }
.ccf-btn-primary:hover { background: var(--ccf-red-dark); }
.ccf-btn-outline { border: 2px solid rgba(255,255,255,0.75); color: #fff; }
.ccf-btn-outline:hover { background: #fff; color: var(--ccf-navy); }

/* ── visit card ──────────────────────────────────────────────── */
.ccf-visit-card {
  background: #fff;
  color: var(--ccf-ink);
  border-radius: 10px;
  padding: 1.6rem 1.6rem 1.5rem;
  box-shadow: 0 18px 45px rgba(8, 17, 35, 0.35);
}
.ccf-visit-title {
  color: var(--ccf-navy);
  font-weight: 700;
  font-size: 1.15rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  border-bottom: 3px solid var(--ccf-red);
  display: inline-block;
  padding-bottom: 0.3rem;
  margin-bottom: 1.1rem;
}
.ccf-visit-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.9rem; }
.ccf-visit-list li { display: flex; gap: 0.7rem; align-items: flex-start; font-size: 0.98rem; }
.ccf-visit-list svg { color: var(--ccf-red); margin-top: 0.2rem; }
.ccf-visit-list a { color: var(--ccf-navy); font-weight: 700; text-decoration: none; }
.ccf-visit-list a:hover { text-decoration: underline; }
.ccf-eircode { color: var(--ccf-muted); font-size: 0.88rem; margin-top: 0.15rem; }
.ccf-maps-link {
  display: inline-block;
  margin-top: 1.1rem;
  color: var(--ccf-navy);
  font-weight: 600;
  font-size: 0.92rem;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.ccf-maps-link:hover { color: var(--ccf-red); }

/* ── enquiry ─────────────────────────────────────────────────── */
.ccf-enquiry { background: var(--ccf-grey); border-top: 1px solid var(--ccf-line); }
.ccf-enquiry-inner {
  max-width: 70rem;
  margin: 0 auto;
  padding: 3.25rem 1.25rem 3.75rem;
  display: grid;
  grid-template-columns: 5fr 7fr;
  gap: 2.5rem;
  align-items: start;
}
@media (max-width: 860px) { .ccf-enquiry-inner { grid-template-columns: 1fr; } }
.ccf-enquiry-copy h2 {
  color: var(--ccf-navy);
  font-size: clamp(1.7rem, 3.6vw, 2.3rem);
  font-weight: 700;
  line-height: 1.12;
}
.ccf-enquiry-copy p { margin-top: 0.9rem; color: var(--ccf-muted); max-width: 26rem; }
.ccf-enquiry-alt a { color: var(--ccf-navy); font-weight: 700; text-decoration: none; }
.ccf-enquiry-alt a:hover { text-decoration: underline; }

.ccf-form-card {
  background: #fff;
  border: 1px solid var(--ccf-line);
  border-radius: 10px;
  box-shadow: 0 6px 24px rgba(21, 42, 78, 0.08);
  padding: 1.7rem;
  display: flex;
  flex-direction: column;
  gap: 1.05rem;
}
.ccf-field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 1.05rem; }
@media (max-width: 560px) { .ccf-field-row { grid-template-columns: 1fr; } }
.ccf-field { display: flex; flex-direction: column; gap: 0.35rem; }
.ccf-field > span { font-size: 0.85rem; font-weight: 600; color: var(--ccf-ink); }
.ccf-field input,
.ccf-field textarea {
  background: #fff;
  border: 1px solid #c8cfda;
  color: var(--ccf-ink);
  padding: 0.65rem 0.8rem;
  font-size: 1rem;
  border-radius: 6px;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.ccf-field input::placeholder,
.ccf-field textarea::placeholder { color: #9aa3b0; }
.ccf-field input:focus,
.ccf-field textarea:focus {
  border-color: var(--ccf-navy);
  box-shadow: 0 0 0 3px rgba(21, 42, 78, 0.15);
}
.ccf-field textarea { resize: vertical; min-height: 5.5rem; }
.ccf-form-error { color: var(--ccf-red-dark); font-size: 0.95rem; }
.ccf-submit {
  background: var(--ccf-red);
  color: #fff;
  border: none;
  cursor: pointer;
  font-weight: 700;
  font-size: 1rem;
  padding: 0.85rem 1rem;
  border-radius: 6px;
  transition: background 0.15s;
}
.ccf-submit:hover:not(:disabled) { background: var(--ccf-red-dark); }
.ccf-submit:disabled { opacity: 0.6; cursor: default; }
.ccf-form-note { color: #8a93a1; font-size: 0.8rem; }
.ccf-sent { align-items: flex-start; gap: 0.6rem; }
.ccf-sent-mark {
  width: 2.4rem;
  height: 2.4rem;
  border-radius: 50%;
  background: #e7f4ea;
  color: #1d7a35;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.2rem;
}
.ccf-sent h3 { font-size: 1.2rem; font-weight: 700; color: var(--ccf-navy); }
.ccf-sent p { color: var(--ccf-muted); }
.ccf-sent a { color: var(--ccf-navy); font-weight: 700; text-decoration: none; }

/* ── footer ──────────────────────────────────────────────────── */
.ccf-footer { background: var(--ccf-navy-deep); color: #aab6c8; }
.ccf-footer-inner {
  max-width: 70rem;
  margin: 0 auto;
  padding: 2rem 1.25rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1.5rem;
  font-size: 0.9rem;
}
@media (max-width: 640px) { .ccf-footer-inner { flex-direction: column; text-align: center; } }
.ccf-logo-footer .ccf-logo-name { color: #fff; }
.ccf-footer a { color: #fff; font-weight: 600; text-decoration: none; }
.ccf-footer a:hover { text-decoration: underline; }
`
