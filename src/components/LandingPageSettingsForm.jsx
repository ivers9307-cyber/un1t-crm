'use client'

// LandingPageSettingsForm — operator UI for editing the public
// /welcome page (Phase 2 of landing-page work, mig 126). Single
// PUT to /api/landing-page-settings on save. Hero image upload is
// a separate POST so a half-saved form doesn't lose the bytes.
//
// Field shape mirrors the columns in landing_page_settings + the
// hard-coded defaults in src/app/welcome/page.js. Operator-friendly
// labels with hint text under each field explaining where it appears
// on the public page.

import { useState } from 'react'
import { Loader2, Save, AlertCircle, ImagePlus, X as XIcon, ExternalLink } from 'lucide-react'

// Same defaults baked into welcome/page.js so the form pre-fills
// with the live values when no row exists yet (rather than empty
// inputs that look like the page would render blank).
const DEFAULTS = {
  hero_eyebrow:       'Stillorgan, Dublin',
  hero_headline:      'Train with intent.',
  hero_subhead:       'Race with proof.',
  hero_subtext:       'Coach-led strength & conditioning, built for racing. Beginners welcome — book a free 30-minute consultation below.',
  booking_slug:       'consultation',
  pillars: [
    { number: '01', title: 'Coach-led, every session', body: "A head coach on the floor for every class — programming, cueing, form-checking. You're not just being timed; you're being taught." },
    { number: '02', title: 'Race-ready conditioning', body: "Hyrox-style stations built into your week. Whether you're racing or just training like you might, you'll be ready when the day comes." },
    { number: '03', title: 'A room that shows up',     body: 'Members across every level — first-time movers to elite competitors. Intense, friendly, zero judgment.' },
  ],
  stats: [
    { number: '200+', label: 'Members training every week' },
    { number: '6',    label: 'Race events hosted in 2025' },
    { number: '4.9',  label: 'Average member rating' },
  ],
  testimonial_quote:  "The coaching is what separates UN1T from any gym I've trained at. I came in for a Hyrox PB. I stayed for the room.",
  testimonial_author: 'Member, joined 2024',
}

function withDefaults(s) {
  if (!s) return { ...DEFAULTS }
  // Use saved value if present, else fall back to default.
  // Empty string counts as "use default" so clearing a field
  // restores the public default rather than rendering blank.
  const merged = { ...DEFAULTS }
  for (const k of Object.keys(DEFAULTS)) {
    const v = s[k]
    if (Array.isArray(DEFAULTS[k])) {
      merged[k] = Array.isArray(v) && v.length > 0 ? v : DEFAULTS[k]
    } else {
      merged[k] = v && String(v).trim().length > 0 ? v : DEFAULTS[k]
    }
  }
  if (s.hero_image_url) merged.hero_image_url = s.hero_image_url
  return merged
}

export default function LandingPageSettingsForm({ locationId, initialSettings, availableBookingTypes }) {
  const init = withDefaults(initialSettings)

  const [heroEyebrow,  setHeroEyebrow]  = useState(init.hero_eyebrow)
  const [heroHeadline, setHeroHeadline] = useState(init.hero_headline)
  const [heroSubhead,  setHeroSubhead]  = useState(init.hero_subhead)
  const [heroSubtext,  setHeroSubtext]  = useState(init.hero_subtext)
  const [bookingSlug,  setBookingSlug]  = useState(init.booking_slug)
  const [heroImageUrl, setHeroImageUrl] = useState(init.hero_image_url || '')
  const [pillars,      setPillars]      = useState(init.pillars)
  const [stats,        setStats]        = useState(init.stats)
  const [testQuote,    setTestQuote]    = useState(init.testimonial_quote)
  const [testAuthor,   setTestAuthor]   = useState(init.testimonial_author)

  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState(null)
  const [savedAt, setSavedAt] = useState(null)

  const [imgUploading, setImgUploading] = useState(false)
  const [imgError,     setImgError]     = useState(null)

  async function handleHeroUpload(file) {
    if (!file) return
    setImgError(null)
    setImgUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('location_id', locationId)
      const r = await fetch('/api/landing-page-settings/hero-image', { method: 'POST', body: fd })
      const j = await r.json()
      if (!r.ok || j.success === false) throw new Error(j.error || `Upload failed (${r.status})`)
      setHeroImageUrl(j.url)
    } catch (e) {
      setImgError(e.message || 'Upload failed')
    } finally {
      setImgUploading(false)
    }
  }

  async function handleSave(e) {
    e?.preventDefault?.()
    setError(null)
    setSaving(true)
    try {
      const payload = {
        location_id: locationId,
        hero_eyebrow:       heroEyebrow.trim() || null,
        hero_headline:      heroHeadline.trim() || null,
        hero_subhead:       heroSubhead.trim() || null,
        hero_subtext:       heroSubtext.trim() || null,
        booking_slug:       bookingSlug.trim() || null,
        hero_image_url:     heroImageUrl.trim() || null,
        pillars,
        stats,
        testimonial_quote:  testQuote.trim() || null,
        testimonial_author: testAuthor.trim() || null,
      }
      const r = await fetch('/api/landing-page-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const j = await r.json()
      if (!r.ok || j.success === false) throw new Error(j.error || `Save failed (${r.status})`)
      setSavedAt(new Date())
    } catch (err) {
      setError(err.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSave} className="space-y-6">
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-md p-3 inline-flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {/* Quick-action header — preview link + save status */}
      <div className="flex items-center justify-between gap-3 pb-2">
        <a
          href="/welcome"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-blue-400 hover:text-blue-300"
        >
          <ExternalLink size={13} /> Preview public page
        </a>
        {savedAt && !saving && (
          <span className="text-xs text-emerald-700">Saved {savedAt.toLocaleTimeString('en-IE')}</span>
        )}
      </div>

      {/* ── Hero ──────────────────────────────────────────── */}
      <Section title="Hero" hint="Top of the page. The first thing every visitor sees.">
        <Field label="Eyebrow" hint='Small uppercase line above the headline (e.g. "Stillorgan, Dublin").'>
          <Input value={heroEyebrow} onChange={setHeroEyebrow} maxLength={200} />
        </Field>
        <Field label="Headline (line 1)" hint="Main headline. Bold, white text.">
          <Input value={heroHeadline} onChange={setHeroHeadline} maxLength={400} />
        </Field>
        <Field label="Headline (line 2)" hint="Second line of the headline. Renders in muted white for contrast.">
          <Input value={heroSubhead} onChange={setHeroSubhead} maxLength={400} />
        </Field>
        <Field label="Subtext" hint="Paragraph under the headline. One or two sentences max.">
          <Textarea value={heroSubtext} onChange={setHeroSubtext} maxLength={2000} rows={3} />
        </Field>

        {/* Hero image upload */}
        <Field label="Hero background image" hint="Optional. PNG / JPEG / WebP, ≤ 5MB. When set, replaces the dark gradient backdrop. Plain dark background renders without one.">
          <div className="flex items-start gap-3">
            {heroImageUrl ? (
              <div className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={heroImageUrl} alt="Hero preview" className="w-32 h-20 object-cover rounded-md border border-un1t-gray" />
                <button
                  type="button"
                  onClick={() => setHeroImageUrl('')}
                  className="absolute -top-2 -right-2 bg-un1t-dark border border-un1t-gray rounded-full p-1 text-un1t-light hover:text-red-500"
                  title="Clear hero image"
                >
                  <XIcon size={11} />
                </button>
              </div>
            ) : (
              <label className={`bg-un1t-black border-2 border-dashed border-un1t-gray hover:border-un1t-mid rounded-md w-32 h-20 flex flex-col items-center justify-center text-un1t-light cursor-pointer ${imgUploading ? 'opacity-50 pointer-events-none' : ''}`}>
                {imgUploading ? <Loader2 size={18} className="animate-spin" /> : <ImagePlus size={18} />}
                <span className="text-[10px] mt-1">{imgUploading ? 'Uploading…' : 'Add image'}</span>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) handleHeroUpload(f)
                    e.target.value = ''
                  }}
                />
              </label>
            )}
            {imgError && <p className="text-[11px] text-red-700 mt-1">{imgError}</p>}
          </div>
        </Field>
      </Section>

      {/* ── Booking form ──────────────────────────────────── */}
      <Section title="Booking form" hint="Which booking type the embedded form captures into.">
        <Field label="Booking type" hint={availableBookingTypes.length === 0 ? 'No active booking types found. Create one under Bookings → Booking types first.' : 'Pick the booking type whose form embeds on the page.'}>
          {availableBookingTypes.length > 0 ? (
            <select
              value={bookingSlug}
              onChange={(e) => setBookingSlug(e.target.value)}
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white"
            >
              {availableBookingTypes.map((bt) => (
                <option key={bt.id} value={bt.slug}>{bt.name} ({bt.slug})</option>
              ))}
              {/* If the saved slug isn't in the active list, surface
                  it anyway so the operator sees what's currently
                  configured even if the type was disabled. */}
              {bookingSlug && !availableBookingTypes.some((bt) => bt.slug === bookingSlug) && (
                <option value={bookingSlug}>{bookingSlug} (no longer active)</option>
              )}
            </select>
          ) : (
            <Input value={bookingSlug} onChange={setBookingSlug} maxLength={200} placeholder="consultation" />
          )}
        </Field>
      </Section>

      {/* ── Pillars (3 value props) ───────────────────────── */}
      <Section title="What we do — 3 pillars" hint="The three value-proposition tiles in the white section. Number / title / body for each.">
        {pillars.slice(0, 3).map((p, i) => (
          <div key={i} className="grid grid-cols-1 md:grid-cols-[80px_1fr] gap-3 items-start">
            <Input
              value={p.number || ''}
              onChange={(v) => setPillars(prev => prev.map((x, j) => j === i ? { ...x, number: v } : x))}
              maxLength={20}
              placeholder={`0${i + 1}`}
              ariaLabel={`Pillar ${i + 1} number`}
            />
            <div className="space-y-2">
              <Input
                value={p.title || ''}
                onChange={(v) => setPillars(prev => prev.map((x, j) => j === i ? { ...x, title: v } : x))}
                maxLength={200}
                placeholder="Title"
                ariaLabel={`Pillar ${i + 1} title`}
              />
              <Textarea
                value={p.body || ''}
                onChange={(v) => setPillars(prev => prev.map((x, j) => j === i ? { ...x, body: v } : x))}
                maxLength={1000}
                rows={2}
                placeholder="Description"
                ariaLabel={`Pillar ${i + 1} body`}
              />
            </div>
          </div>
        ))}
      </Section>

      {/* ── Stats (3 tiles) ───────────────────────────────── */}
      <Section title="Social proof — 3 stats" hint='Big-number tiles in the proof section (e.g. "200+ members training every week").'>
        {stats.slice(0, 3).map((s, i) => (
          <div key={i} className="grid grid-cols-[120px_1fr] gap-3 items-start">
            <Input
              value={s.number || ''}
              onChange={(v) => setStats(prev => prev.map((x, j) => j === i ? { ...x, number: v } : x))}
              maxLength={20}
              placeholder="200+"
              ariaLabel={`Stat ${i + 1} number`}
            />
            <Input
              value={s.label || ''}
              onChange={(v) => setStats(prev => prev.map((x, j) => j === i ? { ...x, label: v } : x))}
              maxLength={200}
              placeholder="Label"
              ariaLabel={`Stat ${i + 1} label`}
            />
          </div>
        ))}
      </Section>

      {/* ── Testimonial ───────────────────────────────────── */}
      <Section title="Testimonial" hint="Member quote rendered below the stats. One quote, one attribution.">
        <Field label="Quote">
          <Textarea value={testQuote} onChange={setTestQuote} maxLength={2000} rows={3} placeholder="Member quote" />
        </Field>
        <Field label="Author" hint='How the quote is attributed (e.g. "Member, joined 2024").'>
          <Input value={testAuthor} onChange={setTestAuthor} maxLength={200} placeholder="Member, joined 2024" />
        </Field>
      </Section>

      <div className="sticky bottom-4 flex items-center justify-end gap-2 bg-un1t-dark/80 backdrop-blur border border-un1t-gray rounded-md p-3">
        <a
          href="/welcome"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-un1t-light hover:text-un1t-white inline-flex items-center gap-1.5"
        >
          <ExternalLink size={12} /> Preview
        </a>
        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-2 bg-un1t-white text-un1t-black font-semibold text-sm py-2 px-4 rounded-md hover:bg-un1t-accent disabled:opacity-50"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  )
}

function Section({ title, hint, children }) {
  return (
    <section className="bg-un1t-dark border border-un1t-gray rounded-lg p-5 space-y-4">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light">{title}</h3>
        {hint && <p className="text-[11px] text-un1t-mid mt-1">{hint}</p>}
      </div>
      {children}
    </section>
  )
}

function Field({ label, hint, children }) {
  return (
    <div>
      <label className="block text-sm text-un1t-light mb-1">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-un1t-mid mt-1">{hint}</p>}
    </div>
  )
}

function Input({ value, onChange, maxLength, placeholder, ariaLabel }) {
  return (
    <input
      type="text"
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      maxLength={maxLength}
      placeholder={placeholder}
      aria-label={ariaLabel}
      className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white"
    />
  )
}

function Textarea({ value, onChange, maxLength, rows, placeholder, ariaLabel }) {
  return (
    <textarea
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      maxLength={maxLength}
      rows={rows || 2}
      placeholder={placeholder}
      aria-label={ariaLabel}
      className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white resize-y"
    />
  )
}
