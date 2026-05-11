'use client'

// LandingPageSettingsForm — operator UI for editing the public
// /welcome page (Phase 2 mig 126; Phase 3a mig 127 added hero video,
// gallery, YouTube/Instagram embed section, and per-pillar photos).
//
// Single PUT to /api/landing-page-settings on save. Media uploads
// (hero image, hero video, gallery photos, pillar photos) are
// separate POSTs so a half-saved form doesn't lose the bytes.
//
// Field shape mirrors the columns in landing_page_settings + the
// hard-coded defaults in src/app/welcome/page.js. Operator-friendly
// labels with hint text under each field explaining where it appears
// on the public page.

import { useState } from 'react'
import { Loader2, Save, AlertCircle, ImagePlus, X as XIcon, ExternalLink, Video, Trash2, ArrowUp, ArrowDown } from 'lucide-react'

// Same defaults baked into welcome/page.js so the form pre-fills
// with the live values when no row exists yet.
const DEFAULTS = {
  hero_eyebrow:       'Stillorgan, Dublin',
  hero_headline:      'Train with intent.',
  hero_subhead:       'Race with proof.',
  hero_subtext:       'Coach-led strength & conditioning, built for racing. Beginners welcome — book a free 30-minute consultation below.',
  booking_slug:       'consultation',
  gallery_title:      'Inside the studio',
  embed_title:        'See it in motion',
  pillars: [
    { number: '01', title: 'Coach-led, every session', body: "A head coach on the floor for every class — programming, cueing, form-checking. You're not just being timed; you're being taught.", photo_url: null },
    { number: '02', title: 'Race-ready conditioning', body: "Hyrox-style stations built into your week. Whether you're racing or just training like you might, you'll be ready when the day comes.", photo_url: null },
    { number: '03', title: 'A room that shows up',     body: 'Members across every level — first-time movers to elite competitors. Intense, friendly, zero judgment.', photo_url: null },
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
  if (!s) return {
    ...DEFAULTS,
    hero_image_url: '',
    hero_video_url: '',
    gallery: [],
    embed_url: '',
    embed_caption: '',
  }
  // Use saved value if present, else fall back to default for text
  // fields. Empty string counts as "use default" so clearing a field
  // restores the public default rather than rendering blank.
  // Media + arrays are passed through as-is so an operator who has
  // explicitly cleared the gallery sees an empty list, not the default.
  const merged = { ...DEFAULTS }
  for (const k of Object.keys(DEFAULTS)) {
    const v = s[k]
    if (Array.isArray(DEFAULTS[k])) {
      merged[k] = Array.isArray(v) && v.length > 0 ? v : DEFAULTS[k]
    } else {
      merged[k] = v && String(v).trim().length > 0 ? v : DEFAULTS[k]
    }
  }
  // Pass-through opt-in fields verbatim (no default substitution).
  merged.hero_image_url = s.hero_image_url || ''
  merged.hero_video_url = s.hero_video_url || ''
  merged.gallery        = Array.isArray(s.gallery) ? s.gallery : []
  merged.embed_url      = s.embed_url || ''
  merged.embed_caption  = s.embed_caption || ''
  return merged
}

export default function LandingPageSettingsForm({ locationId, initialSettings, availableBookingTypes }) {
  const init = withDefaults(initialSettings)

  const [heroEyebrow,  setHeroEyebrow]  = useState(init.hero_eyebrow)
  const [heroHeadline, setHeroHeadline] = useState(init.hero_headline)
  const [heroSubhead,  setHeroSubhead]  = useState(init.hero_subhead)
  const [heroSubtext,  setHeroSubtext]  = useState(init.hero_subtext)
  const [bookingSlug,  setBookingSlug]  = useState(init.booking_slug)
  const [heroImageUrl, setHeroImageUrl] = useState(init.hero_image_url)
  const [heroVideoUrl, setHeroVideoUrl] = useState(init.hero_video_url)
  const [pillars,      setPillars]      = useState(init.pillars)
  const [stats,        setStats]        = useState(init.stats)
  const [galleryTitle, setGalleryTitle] = useState(init.gallery_title)
  const [gallery,      setGallery]      = useState(init.gallery)
  const [embedTitle,   setEmbedTitle]   = useState(init.embed_title)
  const [embedUrl,     setEmbedUrl]     = useState(init.embed_url)
  const [embedCaption, setEmbedCaption] = useState(init.embed_caption)
  const [testQuote,    setTestQuote]    = useState(init.testimonial_quote)
  const [testAuthor,   setTestAuthor]   = useState(init.testimonial_author)

  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState(null)
  const [savedAt, setSavedAt] = useState(null)

  // Generic upload state — keyed so multiple slots (hero image, hero
  // video, gallery, pillar 0/1/2) can show their own spinner +
  // error without trampling each other.
  const [uploading, setUploading] = useState({}) // { key: bool }
  const [uploadErr, setUploadErr] = useState({}) // { key: string }

  function setUploadState(key, isUploading, err) {
    setUploading((prev) => ({ ...prev, [key]: isUploading }))
    setUploadErr((prev) => ({ ...prev, [key]: err || null }))
  }

  async function uploadFile({ file, endpoint, extraForm = {}, key }) {
    setUploadState(key, true, null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('location_id', locationId)
      for (const [k, v] of Object.entries(extraForm)) fd.append(k, v)
      const r = await fetch(endpoint, { method: 'POST', body: fd })
      const j = await r.json()
      if (!r.ok || j.success === false) throw new Error(j.error || `Upload failed (${r.status})`)
      setUploadState(key, false, null)
      return j.url
    } catch (e) {
      setUploadState(key, false, e.message || 'Upload failed')
      return null
    }
  }

  async function handleHeroImage(file) {
    if (!file) return
    const url = await uploadFile({
      file, endpoint: '/api/landing-page-settings/hero-image', key: 'hero-image',
    })
    if (url) setHeroImageUrl(url)
  }

  async function handleHeroVideo(file) {
    if (!file) return
    const url = await uploadFile({
      file, endpoint: '/api/landing-page-settings/hero-video', key: 'hero-video',
    })
    if (url) setHeroVideoUrl(url)
  }

  async function handleGalleryAdd(file) {
    if (!file) return
    const url = await uploadFile({
      file, endpoint: '/api/landing-page-settings/gallery-photo', key: 'gallery',
    })
    if (url) setGallery((prev) => [...prev, { url, alt: '', caption: '' }])
  }

  async function handlePillarPhoto(file, slot) {
    if (!file) return
    const url = await uploadFile({
      file, endpoint: '/api/landing-page-settings/pillar-photo',
      extraForm: { slot: String(slot) },
      key: `pillar-${slot}`,
    })
    if (url) setPillars((prev) => prev.map((p, i) => i === slot ? { ...p, photo_url: url } : p))
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
        hero_video_url:     heroVideoUrl.trim() || null,
        pillars,
        stats,
        gallery_title:      galleryTitle.trim() || null,
        gallery,
        embed_title:        embedTitle.trim() || null,
        embed_url:          embedUrl.trim() || null,
        embed_caption:      embedCaption.trim() || null,
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

        {/* Hero IMAGE upload */}
        <Field
          label="Hero background image"
          hint="Optional. PNG / JPEG / WebP, ≤ 5MB. Replaces the dark gradient. The video below takes precedence over this image when both are set; the image then becomes the video's poster (the still frame shown while the video loads)."
        >
          <MediaSlot
            url={heroImageUrl}
            onClear={() => setHeroImageUrl('')}
            onUpload={handleHeroImage}
            uploading={!!uploading['hero-image']}
            error={uploadErr['hero-image']}
            accept="image/png,image/jpeg,image/webp"
            label="Add image"
            kind="image"
          />
        </Field>

        {/* Hero VIDEO upload (mig 127) */}
        <Field
          label="Hero background video"
          hint="Optional. MP4 / WebM, ≤ 25MB. Auto-plays muted on loop behind the headline. Tip: 720p, 5–15 seconds, ~3-5Mbps for fast load."
        >
          <MediaSlot
            url={heroVideoUrl}
            onClear={() => setHeroVideoUrl('')}
            onUpload={handleHeroVideo}
            uploading={!!uploading['hero-video']}
            error={uploadErr['hero-video']}
            accept="video/mp4,video/webm"
            label="Add video"
            kind="video"
          />
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
      <Section title="What we do — 3 pillars" hint="The three value-proposition tiles in the white section. Each has number / title / body, plus an optional photo above.">
        {pillars.slice(0, 3).map((p, i) => (
          <div key={i} className="border border-un1t-gray rounded-md p-3 space-y-3">
            <div className="text-[11px] uppercase tracking-wider text-un1t-mid">Pillar {i + 1}</div>
            <div className="grid grid-cols-1 md:grid-cols-[80px_1fr] gap-3 items-start">
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
            <div>
              <p className="text-[11px] text-un1t-mid mb-2">Optional photo above this pillar (PNG/JPEG/WebP, ≤ 5MB)</p>
              <MediaSlot
                url={p.photo_url || ''}
                onClear={() => setPillars(prev => prev.map((x, j) => j === i ? { ...x, photo_url: null } : x))}
                onUpload={(file) => handlePillarPhoto(file, i)}
                uploading={!!uploading[`pillar-${i}`]}
                error={uploadErr[`pillar-${i}`]}
                accept="image/png,image/jpeg,image/webp"
                label="Add photo"
                kind="image"
              />
            </div>
          </div>
        ))}
      </Section>

      {/* ── Gallery (mig 127) ─────────────────────────────── */}
      <Section
        title="Photo gallery"
        hint="Optional grid of photos rendered between the pillars and the proof section. Empty list hides the section entirely. Drag arrows to reorder; click ✕ on a photo to remove it."
      >
        <Field label="Section heading" hint="Small uppercase label above the grid (e.g. &ldquo;Inside the studio&rdquo;).">
          <Input value={galleryTitle} onChange={setGalleryTitle} maxLength={200} />
        </Field>

        <Field label={`Photos (${gallery.length}/24)`} hint="Click ＋ to upload. PNG/JPEG/WebP, ≤ 5MB each. Caption is optional — shows on hover.">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {gallery.map((g, i) => (
              <div key={i} className="relative group border border-un1t-gray rounded-md overflow-hidden bg-un1t-black">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={g.url} alt={g.alt || ''} className="w-full aspect-square object-cover" />
                <div className="p-2 space-y-1">
                  <input
                    type="text"
                    value={g.caption || ''}
                    onChange={(e) => setGallery(prev => prev.map((x, j) => j === i ? { ...x, caption: e.target.value } : x))}
                    placeholder="Caption (optional)"
                    maxLength={400}
                    className="w-full bg-un1t-dark border border-un1t-gray rounded px-2 py-1 text-[11px] text-un1t-white"
                  />
                  <input
                    type="text"
                    value={g.alt || ''}
                    onChange={(e) => setGallery(prev => prev.map((x, j) => j === i ? { ...x, alt: e.target.value } : x))}
                    placeholder="Alt text (a11y)"
                    maxLength={400}
                    className="w-full bg-un1t-dark border border-un1t-gray rounded px-2 py-1 text-[11px] text-un1t-white"
                  />
                </div>
                <div className="absolute top-1 right-1 flex gap-1">
                  <button
                    type="button"
                    onClick={() => setGallery(prev => prev.map((x, j) => j === i ? prev[i - 1] : j === i - 1 ? prev[i] : x))}
                    disabled={i === 0}
                    title="Move left"
                    className="p-1 bg-black/70 text-white rounded hover:bg-black disabled:opacity-30"
                  >
                    <ArrowUp size={11} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setGallery(prev => prev.map((x, j) => j === i ? prev[i + 1] : j === i + 1 ? prev[i] : x))}
                    disabled={i === gallery.length - 1}
                    title="Move right"
                    className="p-1 bg-black/70 text-white rounded hover:bg-black disabled:opacity-30"
                  >
                    <ArrowDown size={11} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setGallery(prev => prev.filter((_, j) => j !== i))}
                    title="Remove photo"
                    className="p-1 bg-black/70 text-red-300 rounded hover:bg-red-700 hover:text-white"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              </div>
            ))}
            {gallery.length < 24 && (
              <label className={`bg-un1t-black border-2 border-dashed border-un1t-gray hover:border-un1t-mid rounded-md aspect-square flex flex-col items-center justify-center text-un1t-light cursor-pointer ${uploading['gallery'] ? 'opacity-50 pointer-events-none' : ''}`}>
                {uploading['gallery'] ? <Loader2 size={20} className="animate-spin" /> : <ImagePlus size={20} />}
                <span className="text-[10px] mt-2">{uploading['gallery'] ? 'Uploading…' : 'Add photo'}</span>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleGalleryAdd(f); e.target.value = '' }}
                />
              </label>
            )}
          </div>
          {uploadErr['gallery'] && <p className="text-[11px] text-red-700 mt-2">{uploadErr['gallery']}</p>}
        </Field>
      </Section>

      {/* ── Embed (mig 127) ───────────────────────────────── */}
      <Section
        title="Video embed"
        hint="Optional embed of a YouTube or Instagram video / reel. Empty URL hides the section. Paste the public URL — we figure out the embed format."
      >
        <Field label="Section heading">
          <Input value={embedTitle} onChange={setEmbedTitle} maxLength={200} placeholder="See it in motion" />
        </Field>
        <Field
          label="YouTube or Instagram URL"
          hint="Examples: https://youtu.be/abc123, https://www.instagram.com/reel/xyz/"
        >
          <Input value={embedUrl} onChange={setEmbedUrl} maxLength={2000} placeholder="https://" />
        </Field>
        <Field label="Caption (optional)" hint="Small text under the embed.">
          <Input value={embedCaption} onChange={setEmbedCaption} maxLength={400} />
        </Field>
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

// ─────────────────────────────────────────────────────────────
// Helper components
// ─────────────────────────────────────────────────────────────

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

// MediaSlot — uniform single-file upload tile used for hero image,
// hero video, and per-pillar photos. Shows a thumbnail + clear button
// when set; an upload-on-click slot when empty.
function MediaSlot({ url, onClear, onUpload, uploading, error, accept, label, kind }) {
  return (
    <div className="flex flex-col gap-1">
      {url ? (
        <div className="relative inline-block">
          {kind === 'video' ? (
            <video
              src={url}
              className="w-40 h-24 object-cover rounded-md border border-un1t-gray bg-black"
              muted
              playsInline
              autoPlay
              loop
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={url} alt="Preview" className="w-40 h-24 object-cover rounded-md border border-un1t-gray" />
          )}
          <button
            type="button"
            onClick={onClear}
            className="absolute -top-2 -right-2 bg-un1t-dark border border-un1t-gray rounded-full p-1 text-un1t-light hover:text-red-500"
            title="Clear"
          >
            <XIcon size={11} />
          </button>
        </div>
      ) : (
        <label className={`bg-un1t-black border-2 border-dashed border-un1t-gray hover:border-un1t-mid rounded-md w-40 h-24 flex flex-col items-center justify-center text-un1t-light cursor-pointer ${uploading ? 'opacity-50 pointer-events-none' : ''}`}>
          {uploading
            ? <Loader2 size={18} className="animate-spin" />
            : (kind === 'video' ? <Video size={18} /> : <ImagePlus size={18} />)}
          <span className="text-[10px] mt-1">{uploading ? 'Uploading…' : label}</span>
          <input
            type="file"
            accept={accept}
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = '' }}
          />
        </label>
      )}
      {error && <p className="text-[11px] text-red-700">{error}</p>}
    </div>
  )
}
