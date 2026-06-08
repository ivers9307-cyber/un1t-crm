// Block renderers for the public /welcome page.
//
// Pure presentational components — no hooks, no client state — so
// they can be rendered from either a server component (the live
// public page) or a client component (the in-iframe edit overlay).
//
// SOURCE OF TRUTH for "what does each block type look like".
// Adding a new block type means: register it in
// src/lib/landing-page-blocks.js, add a case here, add an edit
// panel in LandingPageSettingsForm.jsx.

import Link from 'next/link'
import BookingWidget from '@/components/BookingWidget'
import RaceSignupWidget from '@/components/RaceSignupWidget'
import WaitlistWidget from '@/components/WaitlistWidget'
import { parseEmbed } from '@/lib/landing-page-embed'
import EditableText from './EditableText'
import EditableImage from './EditableImage'
import HeroMediaTools from './HeroMediaTools'
import LogoSwapper from './LogoSwapper'

// Pass-through wrapper used by every block renderer. When `onEdit`
// is provided (i.e. we're rendering inside the iframe edit
// overlay), the text becomes contentEditable and edits propagate
// via onEdit(path, newValue). When `onEdit` is absent (public page
// render), it's a plain text fragment — zero overhead.
function E({ value, onEdit, path, multiline }) {
  if (!onEdit) return <>{value}</>
  return (
    <EditableText
      value={value || ''}
      onChange={(v) => onEdit(path, v)}
      multiline={multiline}
    />
  )
}

export default function BlockRenderer({ block, onEdit, locationId, publicPath }) {
  // onEdit is bound to this block: caller hands us a generic
  // (blockId, path, value) function and we curry the blockId so
  // each child renderer thinks in local field paths.
  const localOnEdit = onEdit
    ? (path, value) => onEdit(block.id, path, value)
    : null
  // Common props bundled so we don't repeat ourselves on every
  // block case. locationId is needed by EditableImage to attribute
  // the upload to the right tenant.
  const editProps = { onEdit: localOnEdit, locationId }
  switch (block.type) {
    case 'hero':        return <HeroBlock        block={block} {...editProps} />
    case 'booking':     return <BookingBlock     block={block} />
    case 'pillars':     return <PillarsBlock     block={block} {...editProps} />
    case 'gallery':     return <GalleryBlock     block={block} {...editProps} />
    case 'event':       return <EventBlock       block={block} />
    case 'lead_form':   return <LeadFormBlock    block={block} onEdit={localOnEdit} publicPath={publicPath} />
    case 'embed':       return <EmbedBlock       block={block} onEdit={localOnEdit} />
    case 'stats':       return <StatsBlock       block={block} onEdit={localOnEdit} />
    case 'testimonial': return <TestimonialBlock block={block} onEdit={localOnEdit} />
    default:            return null
  }
}

// Hero — backdrop precedence: video > image > radial gradient.
// Video uses the image as poster so the hero never flashes black
// while the video downloads.
export function HeroBlock({ block, onEdit, locationId }) {
  return (
    <section className="relative pt-24 pb-8 md:pt-32 md:pb-10 overflow-hidden">
      {block.video_url ? (
        <>
          <video
            className="absolute inset-0 w-full h-full object-cover pointer-events-none"
            src={block.video_url}
            poster={block.image_url || undefined}
            autoPlay
            muted
            loop
            playsInline
            preload="metadata"
            aria-hidden="true"
          />
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background:
                'linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.7) 60%, rgba(0,0,0,0.95) 100%)',
            }}
            aria-hidden="true"
          />
        </>
      ) : block.image_url ? (
        <>
          <div
            className="absolute inset-0 pointer-events-none bg-cover bg-center"
            style={{ backgroundImage: `url(${block.image_url})` }}
            aria-hidden="true"
          />
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background:
                'linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.7) 60%, rgba(0,0,0,0.95) 100%)',
            }}
            aria-hidden="true"
          />
        </>
      ) : (
        <div
          className="absolute inset-0 pointer-events-none opacity-60"
          style={{
            background:
              'radial-gradient(ellipse 80% 60% at 50% 30%, rgba(255,255,255,0.08) 0%, rgba(0,0,0,0) 60%)',
          }}
          aria-hidden="true"
        />
      )}
      {/* Hero media tools — only when in edit mode. Sit top-right
          inside the hero so they're visible without overlapping the
          headline. Uses the same /media upload route as everything
          else. */}
      {onEdit && (
        <HeroMediaTools
          imageUrl={block.image_url}
          videoUrl={block.video_url}
          locationId={locationId}
          onChangeImage={(url) => onEdit(['image_url'], url)}
          onChangeVideo={(url) => onEdit(['video_url'], url)}
        />
      )}
      <div className="relative max-w-5xl mx-auto px-6 text-center">
        {(block.eyebrow || onEdit) && (
          <p className="text-xs md:text-sm uppercase tracking-[0.3em] text-white/60 mb-5">
            <E value={block.eyebrow} onEdit={onEdit} path={['eyebrow']} />
          </p>
        )}
        {(block.headline || block.subhead || onEdit) && (
          <h1 className="text-4xl md:text-6xl font-black leading-[1.05] tracking-tight mb-4">
            <E value={block.headline} onEdit={onEdit} path={['headline']} />
            {(block.subhead || onEdit) && (
              <>
                <br />
                <span className="text-white/70">
                  <E value={block.subhead} onEdit={onEdit} path={['subhead']} />
                </span>
              </>
            )}
          </h1>
        )}
        {(block.subtext || onEdit) && (
          <p className="text-base md:text-lg text-white/70 max-w-2xl mx-auto leading-relaxed">
            <E value={block.subtext} onEdit={onEdit} path={['subtext']} multiline />
          </p>
        )}
      </div>
    </section>
  )
}

export function BookingBlock({ block }) {
  return (
    <section id="book" className="bg-black pt-2 pb-20 md:pb-28">
      <div className="max-w-6xl mx-auto px-6">
        <div className="flex justify-center">
          {block.slug ? (
            <BookingWidget slug={block.slug} />
          ) : (
            <p className="text-white/50 text-sm">Booking form not configured.</p>
          )}
        </div>
        <p className="text-center text-xs text-white/50 mt-6">
          Or just walk in &mdash; we&apos;re at <span className="text-white/80">UN1T Stillorgan, Dublin</span>.
        </p>
      </div>
    </section>
  )
}

export function EventBlock({ block }) {
  // Inline event signup — the full RaceSignupWidget for a chosen event,
  // rendered into the page. block.slug picks the event; unset shows a
  // gentle placeholder so the public page never has a broken section.
  return (
    <section id={`event-${block.slug || 'signup'}`} className="bg-black pt-2 pb-20 md:pb-28">
      <div className="max-w-3xl mx-auto px-6">
        {block.title && (
          <h2 className="text-2xl md:text-3xl font-extrabold text-white text-center mb-6">{block.title}</h2>
        )}
        <div className="flex justify-center">
          {block.slug ? (
            <RaceSignupWidget slug={block.slug} />
          ) : (
            <p className="text-white/50 text-sm">Event signup not configured.</p>
          )}
        </div>
      </div>
    </section>
  )
}

export function LeadFormBlock({ block, onEdit, publicPath }) {
  return (
    <section id="waitlist" className="bg-black text-white py-20 md:py-28 border-t border-white/10">
      <div className="max-w-xl mx-auto px-6 text-center">
        {(block.heading || onEdit) && (
          <h2 className="text-3xl md:text-4xl font-black tracking-tight mb-3">
            <E value={block.heading} onEdit={onEdit} path={['heading']} />
          </h2>
        )}
        {(block.subtext || onEdit) && (
          <p className="text-white/70 leading-relaxed mb-8 max-w-md mx-auto">
            <E value={block.subtext} onEdit={onEdit} path={['subtext']} multiline />
          </p>
        )}
        <WaitlistWidget
          publicPath={publicPath}
          buttonLabel={block.button_label}
          successMessage={block.success_message}
          consentLabel={block.consent_label}
        />
      </div>
    </section>
  )
}

export function PillarsBlock({ block, onEdit, locationId }) {
  const items = Array.isArray(block.items) ? block.items.slice(0, 3) : []
  if (items.length === 0 && !onEdit) return null
  return (
    <section className="bg-white text-black py-20 md:py-28">
      <div className="max-w-6xl mx-auto px-6">
        <div className="grid md:grid-cols-3 gap-px bg-black/10">
          {items.map((p, i) => (
            <Pillar
              key={i}
              number={p.number || ''}
              title={p.title || ''}
              body={p.body || ''}
              photoUrl={p.photo_url || null}
              onEdit={onEdit}
              locationId={locationId}
              itemIndex={i}
            />
          ))}
        </div>
      </div>
    </section>
  )
}

export function GalleryBlock({ block, onEdit, locationId }) {
  const items = Array.isArray(block.items) ? block.items : []
  if (items.length === 0 && !onEdit) return null
  return (
    <section className="bg-black py-20 md:py-28 border-t border-white/10">
      <div className="max-w-6xl mx-auto px-6">
        {(block.title || onEdit) && (
          <p className="text-xs uppercase tracking-[0.3em] text-white/50 mb-4">
            <E value={block.title} onEdit={onEdit} path={['title']} />
          </p>
        )}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 md:gap-4">
          {items.map((g, i) => (
            <figure key={i} className="relative aspect-square overflow-hidden bg-white/5 group">
              {onEdit ? (
                <EditableImage
                  src={g.url}
                  alt={g.alt || ''}
                  kind="image"
                  locationId={locationId}
                  className="absolute inset-0"
                  onChange={(url) => {
                    // null = remove this item; otherwise swap.
                    if (url === null) {
                      const next = items.filter((_, j) => j !== i)
                      onEdit(['items'], next)
                    } else {
                      onEdit(['items', i, 'url'], url)
                    }
                  }}
                />
              ) : (
                 
                <img
                  src={g.url}
                  alt={g.alt || ''}
                  className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                  loading="lazy"
                />
              )}
              {g.caption && (
                <figcaption className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-3 text-xs text-white/90 z-20 pointer-events-none">
                  {g.caption}
                </figcaption>
              )}
            </figure>
          ))}
          {onEdit && items.length < 24 && (
            // "Add photo" tile — sits at the end of the grid.
            // EditableImage with empty src renders the dashed
            // placeholder; on upload we append to items via the
            // setByPath route on the parent (path = ['items']
            // with the full new array).
            <figure className="relative aspect-square overflow-hidden bg-white/5">
              <EditableImage
                src=""
                kind="image"
                locationId={locationId}
                className="absolute inset-0"
                emptyLabel="+ Add photo"
                onChange={(url) => {
                  if (!url) return
                  const next = [...items, { url, alt: '', caption: '' }]
                  onEdit(['items'], next)
                }}
              />
            </figure>
          )}
        </div>
      </div>
    </section>
  )
}

export function EmbedBlock({ block, onEdit }) {
  const embed = parseEmbed(block.url)
  // In edit mode, keep the block visible even when the URL hasn't
  // been pasted yet (or is invalid) so the operator can still edit
  // the title / caption from the iframe and isn't fighting an
  // invisible section.
  if (!embed && !onEdit) return null
  return (
    <section className="bg-black py-20 md:py-28 border-t border-white/10">
      <div className="max-w-4xl mx-auto px-6">
        {(block.title || onEdit) && (
          <p className="text-xs uppercase tracking-[0.3em] text-white/50 mb-4">
            <E value={block.title} onEdit={onEdit} path={['title']} />
          </p>
        )}
        {/* 16:9 wrapper for YouTube; Instagram uses a taller portrait
            aspect for reels — we let IG decide its own height inside
            its own iframe. */}
        <div
          className={
            embed.provider === 'instagram'
              ? 'relative w-full max-w-md mx-auto'
              : 'relative w-full aspect-video bg-white/5'
          }
          style={embed.provider === 'instagram' ? { minHeight: '600px' } : undefined}
        >
          <iframe
            src={embed.embedUrl}
            title={block.title || 'Embedded video'}
            className="absolute inset-0 w-full h-full"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
          />
        </div>
        {(block.caption || onEdit) && (
          <p className="text-center text-sm text-white/60 mt-4">
            <E value={block.caption} onEdit={onEdit} path={['caption']} />
          </p>
        )}
        {!embed && onEdit && (
          // Placeholder shown only in edit mode when no valid URL
          // is set — keeps the section interactive while the
          // operator pastes a YouTube / Instagram link in the form.
          <div className="aspect-video w-full bg-white/5 border border-dashed border-white/20 rounded flex items-center justify-center text-sm text-white/40 mt-2">
            Paste a YouTube or Instagram URL on the left to embed
          </div>
        )}
      </div>
    </section>
  )
}

export function StatsBlock({ block, onEdit }) {
  const items = Array.isArray(block.items) ? block.items.slice(0, 3) : []
  if (items.length === 0 && !onEdit) return null
  return (
    <section className="bg-black text-white py-20 md:py-28 border-t border-white/10">
      <div className="max-w-6xl mx-auto px-6">
        <div className="grid md:grid-cols-3 gap-12 text-center">
          {items.map((s, i) => (
            <Stat
              key={i}
              number={s.number || ''}
              label={s.label || ''}
              onEdit={onEdit}
              itemIndex={i}
            />
          ))}
        </div>
        <div className="text-center mt-14">
          <a
            href="#book"
            className="inline-flex items-center gap-2 bg-white text-black font-semibold text-sm md:text-base px-6 py-3 md:px-8 md:py-4 rounded-full hover:bg-white/90 transition-colors"
          >
            Book your free consultation
            <span aria-hidden="true">↑</span>
          </a>
        </div>
      </div>
    </section>
  )
}

export function TestimonialBlock({ block, onEdit }) {
  if (!block.quote && !block.author && !onEdit) return null
  return (
    <section className="bg-black text-white py-20 md:py-28 border-t border-white/10">
      <div className="max-w-6xl mx-auto px-6">
        <blockquote className="max-w-3xl mx-auto text-center">
          {(block.quote || onEdit) && (
            <p className="text-2xl md:text-3xl font-medium leading-snug text-white/90">
              {onEdit
                ? <E value={block.quote} onEdit={onEdit} path={['quote']} multiline />
                : <>&ldquo;{block.quote}&rdquo;</>
              }
            </p>
          )}
          {(block.author || onEdit) && (
            <footer className="mt-6 text-sm uppercase tracking-widest text-white/60">
              {onEdit ? null : <>&mdash; </>}
              <E value={block.author} onEdit={onEdit} path={['author']} />
            </footer>
          )}
        </blockquote>
      </div>
    </section>
  )
}

function Pillar({ number, title, body, photoUrl, onEdit, locationId, itemIndex }) {
  // Show the photo region if there IS a photo OR we're in edit mode
  // (so the operator has somewhere to drop one). Same -mx/-mt as
  // before so the image bleeds to the tile edges.
  const showPhotoRegion = !!photoUrl || !!onEdit
  return (
    <div className="bg-white p-8 md:p-10">
      {showPhotoRegion && (
        <div className="aspect-[3/4] mb-6 overflow-hidden -mx-8 -mt-8 md:-mx-10 md:-mt-10 bg-black/5 relative">
          {onEdit ? (
            <EditableImage
              src={photoUrl || ''}
              kind="image"
              locationId={locationId}
              onChange={(url) => onEdit(['items', itemIndex, 'photo_url'], url)}
              emptyLabel="Add pillar photo"
              className="absolute inset-0"
            />
          ) : (
             
            <img
              src={photoUrl}
              alt=""
              className="w-full h-full object-cover"
              loading="lazy"
            />
          )}
        </div>
      )}
      <div className="text-xs font-mono text-black/40 mb-6">
        <E value={number} onEdit={onEdit} path={['items', itemIndex, 'number']} />
      </div>
      <h3 className="text-xl md:text-2xl font-black mb-3 leading-tight">
        <E value={title} onEdit={onEdit} path={['items', itemIndex, 'title']} />
      </h3>
      <p className="text-black/70 leading-relaxed">
        <E value={body} onEdit={onEdit} path={['items', itemIndex, 'body']} multiline />
      </p>
    </div>
  )
}

function Stat({ number, label, onEdit, itemIndex }) {
  return (
    <div>
      <div className="text-5xl md:text-6xl font-black tracking-tight mb-2">
        <E value={number} onEdit={onEdit} path={['items', itemIndex, 'number']} />
      </div>
      <div className="text-sm uppercase tracking-widest text-white/60">
        <E value={label} onEdit={onEdit} path={['items', itemIndex, 'label']} />
      </div>
    </div>
  )
}

// Site chrome — top nav (logo or wordmark) + footer. Same in both
// public + edit-mode renders. Pulled out so the welcome page and
// the EditModeOverlay don't drift on chrome over time.
//
// Edit mode: when onChangeLogo is provided (only the iframe edit
// overlay does this), the logo becomes click-to-change with a
// hover overlay. When no logo is set, the wordmark text is
// replaced with a small "+ Add logo" upload button so the
// operator has a visible affordance — not a hidden hover target
// they wouldn't think to look for.
export function SiteHeader({
  logoUrl,
  logoAlt = 'UN1T Dublin',
  logoWidthPx = 200,
  onChangeLogo = null,
  locationId = null,
}) {
  return (
    <header className="absolute inset-x-0 top-0 z-20">
      <div className="max-w-6xl mx-auto px-6 py-5 flex items-center justify-between">
        {onChangeLogo ? (
          <EditableLogo
            logoUrl={logoUrl}
            logoAlt={logoAlt}
            logoWidthPx={logoWidthPx}
            locationId={locationId}
            onChange={onChangeLogo}
          />
        ) : logoUrl ? (
           
          <img
            src={logoUrl}
            alt={logoAlt}
            style={{ width: `${logoWidthPx}px`, height: 'auto' }}
            className="object-contain"
          />
        ) : (
          <div className="text-xl font-black tracking-widest">UN1T</div>
        )}
        <nav className="hidden md:flex items-center gap-8 text-sm font-medium">
          <a href="#book" className="text-white/70 hover:text-white transition-colors">Book</a>
        </nav>
      </div>
    </header>
  )
}

// EditableLogo — iframe-only affordance for swapping/removing the
// site logo. Lives here (in the same file as SiteHeader) because
// it's intimately tied to the logo's specific layout — width-driven
// sizing with auto height, object-contain (NOT object-cover so the
// logo isn't cropped). EditableImage is sized for full-bleed media
// and would need too many overrides to fit this.
//
// Rendered as a self-contained inline element that delegates the
// React import to its own (declared in the file's hooks via the
// imported HeroMediaTools helpers — but we just inline the upload
// here for simplicity).
function EditableLogo({ logoUrl, logoAlt, logoWidthPx, locationId, onChange }) {
  return (
    <LogoSwapper
      src={logoUrl}
      alt={logoAlt}
      widthPx={logoWidthPx}
      locationId={locationId}
      onChange={onChange}
    />
  )
}

export function SiteFooter() {
  return (
    <footer className="bg-black text-white border-t border-white/10 py-12">
      <div className="max-w-6xl mx-auto px-6 grid md:grid-cols-3 gap-10 text-sm">
        <div>
          <div className="text-lg font-black tracking-widest mb-3">UN1T DUBLIN</div>
          <p className="text-white/60 leading-relaxed">
            Strength &amp; conditioning. Hyrox-style training. Coach-led.
          </p>
        </div>
        <div>
          <div className="text-xs uppercase tracking-widest text-white/50 mb-3">Find us</div>
          <p className="text-white/80 leading-relaxed">
            UN1T Stillorgan
            <br />
            Stillorgan, Co. Dublin
            <br />
            Ireland
          </p>
        </div>
        <div>
          <div className="text-xs uppercase tracking-widest text-white/50 mb-3">Get in touch</div>
          <p className="text-white/80 leading-relaxed">
            <a href="#book" className="hover:text-white">Book a free consultation</a>
            <br />
            <a href="https://instagram.com/un1tdublin" target="_blank" rel="noreferrer" className="hover:text-white">@un1tdublin on Instagram</a>
          </p>
        </div>
      </div>
      <div className="max-w-6xl mx-auto px-6 mt-12 pt-8 border-t border-white/10 flex flex-wrap items-center justify-between gap-4 text-xs text-white/50">
        <span>© {new Date().getFullYear()} UN1T Dublin. All rights reserved.</span>
        <Link href="/login" className="hover:text-white/80">Member &amp; staff login</Link>
      </div>
    </footer>
  )
}
