// PAGES.1 — the one public page route: /<slug> (and /<slug>/<sub-path>)
// renders a `landing_pages` row and its `landing_page_studios` rows. The
// design is docs/superpowers/specs/2026-10-30-landing-pages-editor-design.md
// (§2 the route, §4 the layouts).
//
//   1. Organisation: the host's (publicOrgIdForHost: the un1t-marketing brand,
//      a tenant_domains host, else UN1T Group). `?edit=1` from a signed-in
//      user is the editor's preview iframe on the CRM host: their active
//      organisation instead. An anonymous `?edit=1` is an ordinary visit.
//   2. The page by (organisation, slug): a campaign page or a studio page
//      (kind='studio', /stillorgan). draft and coming_soon 404 (edit mode
//      previews them); retired redirects to `redirect_to` with the query kept.
//      A failed read is a 404 with a warning, never a 500 for paid traffic.
//      A paid-trial buyer back from a checkout (?purchase=) on a studio path
//      whose page is missing or hidden goes on to /trial, which can resume it.
//   3. The studio: scope='one' is the primary's row; scope='all' is the
//      enabled row `?studio=` names, else none yet (the offer shows its
//      picker over the enabled rows). A page switched on at no studio 404s.
//   4. Layout by offer type (layoutFor), the offer card built only from the
//      client-view helpers, then the page's content blocks, then the footer.
//   5. A studio page (renderStudioPage) is always the blocks layout: what
//      /welcome/[location] rendered (TRIALFIRST's card in its first hero,
//      pageCtas, the Events link, JSON-LD), from the page row and its one
//      studio row only, inside StudioShell (the /welcome typography). It
//      serves /<slug>/events and /<slug>/status (StudioEventsPage,
//      StudioStatusPage). Its forms and card post the way /welcome's did (by
//      public path / studio key, no `page`): the public routes take studio
//      pages in a later task.
//
// Next serves a static route before this dynamic one, so /trial, /50plus and
// /corp keep rendering from their code routes until Task 8 deletes them; this
// route answers any slug with no static route. The proxy admits a page slug
// (and anything under it) and sets x-public-page, and AppShellServer hands
// AppShell the slug list, so the client shell renders it bare.
//
// The browser gets only client-safe props: trialStudioView (never a plan,
// membership or product id), campaignFunnelClientCopy (never the trial ids or
// the class keywords), the corp promo's words, the terms payload. A studio
// row's `locations.settings` and `attribution` never reach the browser (the
// settings go to StudioStatusPage, a server component, for its status_page
// copy only). In edit mode the overlay gets the merged blocks for a user who
// may view the page (canViewPage), as /welcome/[location] did for its editor,
// through clientSafeBlocks, and `offerLayout`: the same layout and offer card
// the public page renders for the previewed studio (offerElementFor; a
// studio page's card rides in its hero as `trialPreview`).

import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { publicOrgIdForHost } from '@/lib/public-pages-edge'
import {
  loadPageBySlug, resolvePageStudio, studioParamToPublicPath, locationIdForPublicPath,
  mergedBlocksFor, studioPublicPath, canViewPage, studioTermsCopy,
} from '@/lib/landing-pages'
import { OFFER_BLOCK_TYPE } from '@/lib/landing-page-offers'
import { layoutFor, redirectTarget, pageSubpath } from '@/lib/landing-page-render'
import { trialEntryFromRow, TRIAL_STUDIOS } from '@/lib/trial-studios'
import { trialStudioView } from '@/lib/trial-studio-view'
import { parseTrialReturn } from '@/lib/trial-return-path'
import { paidTrialCopyFromBlock } from '@/lib/paid-trial'
import { un1tTermsPayload } from '@/lib/un1t-online-funnel-copy'
import { resolveGymSiteName } from '@/lib/default-site-name'
import { campaignFunnelCopy, campaignFunnelClientCopy } from '@/lib/campaign-funnel'
import { resolveCorpPromo, corpPromoCopyFromBlocks, fillCorpPromoTokens } from '@/lib/corp-promos'
import { classFunnelCtaLabel } from '@/lib/public-landing'
import { pageCtas, clientSafeBlocks, blocksOrDefault } from '@/lib/landing-page-blocks'
import { getLandingLogo, STILLORGAN_LANDING_LOGO } from '@/lib/landing-logo'
import { resolveOrgChrome, resolveLocationBrand } from '@/lib/host-brand'
import { logWarn } from '@/lib/log'
import { FrostedCardLayout, OneClassLayout, BlocksLayout } from '@/components/landing-page/PageLayout'
import PaidTrialFunnel from '@/components/landing-page/PaidTrialFunnel'
import CampaignFunnel from '@/components/landing-page/CampaignFunnel'
import CorpPromoFunnel from '@/components/landing-page/CorpPromoFunnel'
import ClassFunnel from '@/components/ClassFunnel'
import EditModeOverlay from '@/components/landing-page/EditModeOverlay'
import StudioShell from '@/components/landing-page/StudioShell'
import StudioEventsPage from '@/components/landing-page/StudioEventsPage'
import StudioStatusPage from '@/components/landing-page/StudioStatusPage'

export const dynamic = 'force-dynamic'

// The /trial photo: the frosted card's backdrop when the page has no hero block.
const HERO_IMAGE =
  'https://iyvtbjjxdggiadzwwvdj.supabase.co/storage/v1/object/public/branding/landing-page/28c78d6b-f7b3-4edf-8c7c-840bd047b3f4/3c80aac2-7007-43c5-81f4-be44f180ef99.jpg'

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
// The two funnels that post against their studio's public path.
const needsPath = (offerType) => offerType === 'class_funnel' || offerType === 'one_class'
const isObj = (b) => Boolean(b) && typeof b === 'object'

// The signed-in user behind an `?edit=1`, or null (no flag, anonymous, or a
// session we could not read: then it is an ordinary visit).
async function editorFor(sp) {
  if (sp?.edit !== '1') return null
  try {
    const user = await getCurrentUser()
    return user?.activeOrganization?.id ? user : null
  } catch {
    return null
  }
}

// Steps 1 and 2: the organisation and the page. Never throws on a read error:
// `failed` (logged) means the route answers 404.
async function readPage(props) {
  const [params, searchParams] = await Promise.all([props.params, props.searchParams])
  const slug = typeof params?.slug === 'string' ? params.slug : ''
  const rest = Array.isArray(params?.rest) ? params.rest : undefined
  const sp = searchParams || {}
  const editor = await editorFor(sp)
  const db = createServerClient()
  let orgId = null
  try {
    orgId = editor ? editor.activeOrganization.id : await publicOrgIdForHost((await headers()).get('host'))
    let loaded = slug ? await loadPageBySlug(db, { orgId, slug }) : null
    let editMode = Boolean(editor && loaded && canViewPage(editor, loaded.page))
    // A signed-in `?edit=1` visitor who has no such page in their own
    // organisation, or may not view it, is an ordinary visit on the HOST's
    // organisation, exactly as an anonymous request would be (no overlay).
    if (editor && slug && !editMode) {
      const hostOrgId = await publicOrgIdForHost((await headers()).get('host'))
      if (hostOrgId !== orgId) {
        orgId = hostOrgId
        loaded = await loadPageBySlug(db, { orgId, slug })
      }
    }
    return { db, slug, rest, sp, orgId, loaded, editMode, failed: false }
  } catch (e) {
    logWarn('public-page', 'page unreadable; answering 404', { slug, orgId, code: e?.cause?.code ?? e?.code ?? null })
    return { db, slug, rest, sp, orgId, loaded: null, editMode: false, failed: true }
  }
}

// Is this page shown at all to this request (retired is handled by the caller)?
// Both kinds the route serves are public only when live; a studio page that is
// coming soon 404s as /welcome/[location] did.
const SERVED_KINDS = ['campaign', 'studio']
const shown = (page, editMode) => SERVED_KINDS.includes(page.kind) && (page.publish_state === 'live' || (editMode && page.publish_state !== 'retired'))

// The studio page's location, as embedded on its studio row (STUDIO_ROW_COLUMNS).
const embeddedOne = (v) => (Array.isArray(v) ? v[0] : v) || null
const studioRowOf = (page, studios) => resolvePageStudio({ page, studios }).studio

// TRIALFIRST.1 — a buyer redirected back from a checkout (?purchase=) to a
// studio path whose page is gone, hidden or unreadable goes on to /trial,
// which can resume any studio's purchase, rather than seeing a 404 after
// paying. Only the studio paths a buyer can be returned to (TRIAL_STUDIOS,
// trial-return-path.js) and only the page itself, never a sub-page.
function resumeElsewhere(slug, rest, sp) {
  if (Array.isArray(rest) && rest.length) return
  if (!TRIAL_STUDIOS.some((s) => s.publicPath === slug)) return
  const { resumePurchaseId, cancelled } = parseTrialReturn(sp)
  if (!resumePurchaseId) return
  const key = slug === 'hatch-street' ? 'hatch' : 'stillorgan'
  redirect(`/trial?purchase=${resumePurchaseId}&studio=${key}${cancelled ? '&cancelled=1' : ''}`)
}

// The three /welcome/[location] pages' metadata, kept to the character (their
// em-dashes included): the studio's name, its brand as the OG site name, the
// host's brand when neither resolves. Customer-visible strings unchanged by
// the move, by rule.
async function studioMetadata(page, studios, sub) {
  const loc = embeddedOne(studioRowOf(page, studios)?.locations)
  if (sub.kind === 'status') {
    const name = loc?.name || await resolveGymSiteName({ host: (await headers()).get('host') })
    return {
      title: `${name} — System status`,
      description: `Live service status for ${name}. Booking, messaging, payments and email.`,
      robots: { index: false }, // status page shouldn't compete with the studio's real pages
    }
  }
  if (sub.kind !== 'root' && sub.kind !== 'events') return {}
  const host = (await headers()).get('host')
  const brand = (await resolveLocationBrand({ locationId: page.primary_location_id })).companyName || await resolveGymSiteName({ host })
  const studioName = loc?.name || brand
  if (sub.kind === 'events') {
    const title = `Events — ${studioName}`
    const description = `Upcoming races, workshops and open days at ${studioName}. Book your spot.`
    return { title, description, openGraph: { title, description, siteName: brand, type: 'website' } }
  }
  const hero = blocksOrDefault(page.blocks).find((b) => b.type === 'hero')
  const heroImage = hero?.image_url || null
  const description = hero?.subtext || 'Coach-led strength + conditioning, built for racing. Book your free consultation.'
  const title = `${studioName} — Strength + conditioning, built for racing`
  const c = isObj(page.chrome) ? page.chrome : {}
  return {
    title,
    description,
    openGraph: { title, description, siteName: brand, type: 'website', ...(heroImage ? { images: [{ url: heroImage }] } : {}) },
    ...(c.noindex ? { robots: { index: false, follow: false } } : {}),
  }
}

export async function generateMetadata(props) {
  try {
    const { loaded, editMode, rest } = await readPage(props)
    if (!loaded || !shown(loaded.page, editMode)) return {}
    const { page } = loaded
    if (page.kind === 'studio') return await studioMetadata(page, loaded.studios, pageSubpath(page, rest))
    const c = isObj(page.chrome) ? page.chrome : {}
    // The meta title (else the page title), then the brand: the meta title is
    // the words before ' | <company>', as the page title is (mig 792 seeds the
    // campaign pages' meta titles that way).
    // Customer-visible (the tab, a share): no em-dash (CLAUDE.md).
    const base = str(c.meta_title) || page.title
    const chrome = await resolveOrgChrome({ orgId: page.organization_id })
    // An operator who already typed the brand into the meta title is not suffixed twice.
    const suffix = chrome.companyName ? ` | ${chrome.companyName}` : ''
    const title = suffix && !base.trim().toLowerCase().endsWith(suffix.toLowerCase()) ? `${base}${suffix}` : base
    return {
      title,
      description: str(c.meta_description) || '',
      robots: { index: !c.noindex, follow: !c.noindex },
    }
  } catch (e) {
    logWarn('public-page', 'metadata unreadable; defaults', { code: e?.code ?? null })
    return {}
  }
}

// A studio's public path, null (logged) when it cannot be read.
async function safePublicPath(db, locationId) {
  if (!locationId) return null
  try {
    return await studioPublicPath(db, locationId)
  } catch (e) {
    logWarn('public-page', 'studio path unreadable', { locationId, code: e?.cause?.code ?? null })
    return null
  }
}

// Reviews carousel data, only when the page has a reviews block (the read
// /welcome/[location] and /50plus do). Graceful: a failed read skips the data.
async function loadReviews(db, locationId, reviewsBlock) {
  if (!reviewsBlock || !locationId) return null
  try {
    const minRating = Number.isFinite(reviewsBlock.min_rating) ? reviewsBlock.min_rating : 4
    const { data: reviews, error } = await db.from('google_reviews')
      .select('id, google_review_id, rating, comment, author_name, author_photo_url, review_time, hidden')
      .eq('location_id', locationId)
      .eq('hidden', false)
      .gte('rating', minRating)
      .not('comment', 'is', null)
      .order('review_time', { ascending: false })
      .limit(30)
    if (error) throw error
    return { reviews: reviews || [] }
  } catch (e) {
    logWarn('public-page', 'reviews unreadable; section has no data', { locationId, code: e?.code ?? null })
    return null
  }
}

// un1t.online's terms tick for a studio, worded as /trial and /corp word it
// today: the studio page's chrome.un1t_terms (studioTermsCopy).
async function termsFor(db, locationId, { studioName, publicPath }) {
  const copy = await studioTermsCopy(db, locationId)
  return un1tTermsPayload({ terms: copy, studioName, publicPath })
}

// The paid trial's per-studio card data: the loadTrialStudios entry built from
// the studio row (trialEntryFromRow), its client view, and its terms tick.
// A studio page is its studio's public path (its slug) and words its tick
// from its own chrome.un1t_terms, so it reads neither again; a studio page
// switched off on its own row sells nothing.
async function paidTrialItems(db, page, rows) {
  const isStudioPage = page.kind === 'studio'
  return Promise.all(rows.map(async (row) => {
    const publicPath = isStudioPage ? page.slug : await safePublicPath(db, row.location_id)
    const block = mergedBlocksFor({ page, studio: row }).find((b) => isObj(b) && b.type === 'paid_trial') || null
    const brand = await resolveLocationBrand({ locationId: row.location_id })
    let entry
    try {
      entry = await trialEntryFromRow(db, { row, publicPath, mergedBlock: block })
    } catch (e) {
      logWarn('public-page', 'paid trial studio unreadable; not for sale', { locationId: row.location_id, code: e?.code ?? null })
      // The key trialEntryFromRow would have given, so a returning buyer's card still names its studio.
      const key = TRIAL_STUDIOS.find((s) => s.publicPath === publicPath)?.key || publicPath || null
      entry = { key, publicPath, locationId: row.location_id, membershipSource: null, block, product: null, sellable: false, config: null }
    }
    // No public path: no terms page and no way back from a checkout, so nothing for sale.
    if (!publicPath || (isStudioPage && row.enabled === false)) entry = { ...entry, sellable: false, config: null }
    entry = { ...entry, key: entry.key || row.location_id }
    const view = trialStudioView(entry, brand)
    const studioName = brand?.locationName || view.label
    const hatchTerms = entry.membershipSource === 'un1t_online' && view.sellable
      ? (isStudioPage
          ? un1tTermsPayload({ terms: isObj(page.chrome) ? page.chrome.un1t_terms : null, studioName, publicPath })
          : await termsFor(db, row.location_id, { studioName, publicPath }))
      : null
    return { row, entry, view, hatchTerms }
  }))
}

// Step 4: what the page's layout wraps round its blocks, built ONCE for the
// public page and the editor's preview (`preview`) so the two cannot drift:
// the layout kind, the CTA, and for an offer the card (`offer`, the live
// component), its section anchor and photo, the cue under it, and on a
// one_class page the coach video hero and the expect strip. A paid trial's
// card renders disabled in the preview (PaidTrialFunnel's `preview`) and never
// resumes a checkout; every other card stays live, as the editor tests it.
async function offerElementFor({ db, page, sp, sub, studio, merged, mergedOffer, bodyBlocks, heroImageUrl, trialItems, contextPath, contextBrand, contextLocationId, studioName, preview = false }) {
  const kind = layoutFor(page.offer_type, page.kind)

  if (page.offer_type === 'paid_trial') {
    const { resumePurchaseId, cancelled } = preview ? { resumePurchaseId: null, cancelled: false } : parseTrialReturn(sp)
    const views = trialItems.map((i) => i.view)
    const chosen = page.scope === 'one' ? trialItems[0] : trialItems.find((i) => i.row === studio)
    const initialStudio = chosen?.view.key || null
    const hatchTerms = trialItems.find((i) => i.hatchTerms)?.hatchTerms || null
    const lead = trialItems.find((i) => i.view.key === initialStudio && i.view.sellable) || trialItems.find((i) => i.view.sellable) || trialItems[0]
    const cta = { href: '#trial', label: lead?.view.block?.cta_label || 'Start my trial' }
    // TRIALSCROLL.1 — the cue under the card; no sections, no cue.
    const scrollCueLabel = bodyBlocks.length > 0 ? paidTrialCopyFromBlock(lead?.entry.block).scrollCueLabel : null
    return {
      kind, cta, anchor: 'trial', heroImageUrl, scrollCueLabel,
      offer: (
        <PaidTrialFunnel
          studios={views}
          initialStudio={initialStudio}
          resumePurchaseId={resumePurchaseId}
          cancelled={cancelled}
          hatchTerms={hatchTerms}
          returnPath={`/${page.slug}`}
          page={page.slug}
          {...(preview ? { preview: true } : {})}
        />
      ),
    }
  }

  if (page.offer_type === 'one_class') {
    const copy = campaignFunnelCopy(mergedOffer || {}, { brand: studioName })
    return {
      kind,
      cta: { href: '#book', label: 'Book a free class' },
      hero: { videoUrl: copy.video_url, posterUrl: copy.poster_url, soundLabel: copy.sound_label, eyebrow: copy.eyebrow, heading: copy.heading, subhead: copy.subhead },
      expect: { eyebrow: copy.expect_eyebrow, heading: copy.expect_heading, cards: copy.expect_cards },
      offer: <CampaignFunnel publicPath={contextPath} campaign={page.slug} page={page.slug} copy={campaignFunnelClientCopy(copy)} locationName={studioName} />,
    }
  }

  if (page.offer_type === 'promo_credits') {
    // The promo is the registry's (credits, expiry, studio); the page names
    // which one, and only a live promo at this page's studio is offered. The
    // page offers ONLY its row's promo: a sub-path naming another key (even a
    // live one) is "not available right now", as the claim route refuses it.
    const rowKey = str(mergedOffer?.promo_key)
    const wantedKey = sub.kind === 'promo' ? sub.key : rowKey
    const resolved = rowKey && wantedKey === rowKey ? resolveCorpPromo(rowKey) : null
    const promo = resolved && resolved.live && resolved.publicPath === contextPath ? resolved : null
    const corpStudioName = contextBrand?.locationName || contextBrand?.companyName || ''
    const raw = corpPromoCopyFromBlocks(mergedOffer ? [mergedOffer] : [], rowKey)
    const tokens = { studio_name: corpStudioName, credits: promo?.credits ?? '' }
    const copy = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v.map((t) => fillCorpPromoTokens(t, tokens)) : fillCorpPromoTokens(v, tokens)]))
    const terms = promo ? await termsFor(db, contextLocationId, { studioName: corpStudioName, publicPath: promo.publicPath }) : null
    return {
      kind, cta: { href: '#corp', label: copy.cta_label }, anchor: 'corp', heroImageUrl, scrollCueLabel: null,
      offer: <CorpPromoFunnel promoKey={promo ? promo.key : null} copy={copy} terms={terms} page={page.slug} studio={contextPath} />,
    }
  }

  if (page.offer_type === 'class_funnel') {
    const funnel = mergedOffer || {}
    return {
      kind, cta: { href: '#start', label: classFunnelCtaLabel(merged) }, anchor: 'start', heroImageUrl, scrollCueLabel: null,
      offer: (
        <ClassFunnel
          publicPath={contextPath}
          page={page.slug}
          locationName={contextBrand?.locationName || ''}
          // '' is "no consult upsell" and must be passed explicitly: an
          // absent prop falls back to Stillorgan's booking type.
          consultSlug={funnel.consult_slug || ''}
          heading={funnel.heading}
          subhead={funnel.subhead}
          consentLabel={funnel.consent_label}
          classDoneTitle={funnel.class_done_title}
          classDoneBody={funnel.class_done_body}
          consultDoneTitle={funnel.consult_done_title}
          consultDoneBody={funnel.consult_done_body}
        />
      ),
    }
  }

  // offer_type 'none': the page's own blocks, its CTA from its own capture blocks.
  const { primary } = pageCtas(bodyBlocks)
  return { kind, cta: { href: primary?.href || null, label: primary?.label } }
}

// Step 5: a studio page (/stillorgan) and its two sub-pages, as
// /welcome/[location] rendered them. Reads the page row and its one studio row
// (and, for a page with no logo of its own, the existing logo fallback);
// nothing from landing_page_settings otherwise. Everything the browser gets
// is client-safe: trialStudioView, the terms payload, clientSafeBlocks, and
// named location fields (the studio row's locations.settings stays here, read
// by the status page for its status_page copy only).
async function renderStudioPage({ db, page, studios, sp, sub, editMode }) {
  const studio = studioRowOf(page, studios)
  const location = embeddedOne(studio?.locations)
  const locationId = page.primary_location_id

  if (sub.kind === 'status') {
    if (!location?.id) notFound()
    return (
      <StudioShell>
        <StudioStatusPage db={db} location={{ id: location.id, name: location.name || null, settings: location.settings || null, timezone: location.timezone || null }} />
      </StudioShell>
    )
  }

  const c = isObj(page.chrome) ? page.chrome : {}
  const [brand, chrome] = await Promise.all([
    resolveLocationBrand({ locationId }),
    resolveOrgChrome({ orgId: page.organization_id }),
  ])
  const footer = { brand: chrome.companyName, studios: chrome.studios, legalName: chrome.legalName }
  const logoUrl = str(c.logo_url) || await getLandingLogo(page.slug, STILLORGAN_LANDING_LOGO)
  const logoAlt = str(c.logo_alt) || brand.companyName
  const logoWidthPx = Number(c.logo_width_px) || 200

  if (sub.kind === 'events') {
    if (!location?.id) notFound()
    return (
      <StudioShell>
        <StudioEventsPage
          db={db}
          slug={page.slug}
          location={{ id: location.id, name: location.name || null, timezone: location.timezone || null }}
          brand={brand}
          logo={{ url: logoUrl, alt: logoAlt, widthPx: logoWidthPx }}
          footer={footer}
          showInstagramFeed={c.show_instagram_feed !== false}
        />
      </StudioShell>
    )
  }

  const merged = mergedBlocksFor({ page, studio })
  const offerBlockType = OFFER_BLOCK_TYPE[page.offer_type]
  const offerIdx = offerBlockType ? merged.findIndex((b) => isObj(b) && b.type === offerBlockType) : -1
  const content = merged.filter((b, i) => i !== offerIdx && isObj(b))
  const tone = c.tone === 'light' ? 'light' : 'dark'
  const returnPath = `/${page.slug}`

  // TRIALFIRST.1 — the studio's paid trial, from its own row. Shown =
  // sellable, or a buyer back from a checkout (a return always lands on the
  // card, which reads the purchase's own state). The editor preview shows the
  // card disabled, sellable or not, and never resumes a checkout.
  const { resumePurchaseId, cancelled } = editMode ? { resumePurchaseId: null, cancelled: false } : parseTrialReturn(sp)
  const trialItem = page.offer_type === 'paid_trial' && studio
    ? (await paidTrialItems(db, page, [studio]))[0]
    : null
  const view = trialItem?.view || null
  const hatchTerms = trialItem?.hatchTerms || null

  if (editMode) {
    const trialPreview = view ? { studio: view, returnPath, resumePurchaseId: null, cancelled: false, hatchTerms, preview: true } : null
    const { primary } = pageCtas(merged, { trialShown: Boolean(trialPreview) })
    return (
      <StudioShell>
        <EditModeOverlay
          // EDITGATE.1: the studio half (plan ids, product id, attribution) never rides the RSC payload.
          initialBlocks={clientSafeBlocks(merged)}
          initialLogoUrl={logoUrl}
          initialLogoAlt={logoAlt}
          initialLogoWidthPx={logoWidthPx}
          fallbackLogoAlt={brand.companyName}
          wordmark={brand.shortName}
          locationName={brand.locationName}
          footer={footer}
          // The blocks layout: no pinned offer region; the card rides in the
          // first hero as on the public page, disabled (preview: true).
          offerLayout={{ kind: 'blocks', tone, cta: { href: primary?.href || null, label: primary?.label }, offerBlockId: null }}
          trialPreview={trialPreview}
        />
      </StudioShell>
    )
  }

  const trialShown = Boolean(view && (view.sellable || resumePurchaseId))
  const trial = trialShown ? { studio: view, returnPath, resumePurchaseId, cancelled, hatchTerms, preview: false } : null
  const { primary: cta, secondary: cta2 } = pageCtas(merged, { trialShown })
  const reviewsData = await loadReviews(db, locationId, content.find((b) => b.type === 'reviews'))
  const hero = content.find((b) => b.type === 'hero')
  // Gym structured data: name, url, hero image, logo. No aggregateRating
  // (reviews are entered by hand since mig 410; never invent one).
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Gym',
    name: location?.name || brand.companyName,
    url: `https://un1tdublin.com/${page.slug}`,
    ...(hero?.image_url ? { image: hero.image_url } : {}),
    ...(logoUrl ? { logo: logoUrl } : {}),
  }

  return (
    <StudioShell>
      <BlocksLayout
        tone={tone}
        logo={{ url: logoUrl, alt: logoAlt, widthPx: logoWidthPx, wordmark: brand.shortName }}
        cta={{ href: cta?.href || null, label: cta?.label, labelShort: cta?.labelShort || '' }}
        cta2={cta2 || null}
        footer={footer}
        blocks={content}
        // No `page`: the forms post by public path as /welcome's did.
        blockProps={{ publicPath: page.slug, page: null, wordmark: brand.shortName, locationName: brand.locationName, reviewsData }}
        eventsHref={`/${page.slug}/events`}
        trial={trial}
        trialShown={trialShown}
        jsonLd={jsonLd}
      />
    </StudioShell>
  )
}

export default async function PublicPage(props) {
  const req = await readPage(props)
  if (req.failed || !req.loaded) {
    resumeElsewhere(req.slug, req.rest, req.sp)
    notFound()
  }
  const { db, sp, editMode } = req
  const { page, studios } = req.loaded
  if (!SERVED_KINDS.includes(page.kind)) notFound()
  if (page.publish_state === 'retired') {
    const target = redirectTarget(page, req.rest, sp, { studioFromSegment: studioParamToPublicPath })
    if (target) redirect(target)
    notFound()
  }
  if (!shown(page, editMode)) {
    if (page.kind === 'studio') resumeElsewhere(page.slug, req.rest, sp)
    notFound()
  }
  const sub = pageSubpath(page, req.rest)
  if (sub.kind === 'unknown') notFound()
  if (page.kind === 'studio') return renderStudioPage({ db, page, studios, sp, sub, editMode })

  // Step 3: the studio. A wrong `?studio=` is no studio (the picker shows).
  let studioLocationId = null
  const requested = page.scope === 'all' ? studioParamToPublicPath(sp.studio) : null
  if (requested) {
    try {
      studioLocationId = await locationIdForPublicPath(db, page.organization_id, requested)
    } catch (e) {
      logWarn('public-page', 'studio param unreadable; picker shown', { slug: page.slug, code: e?.cause?.code ?? null })
    }
  }
  const { studio, picker } = resolvePageStudio({ page, studios, studioLocationId })
  // The studios the offer may sell at: a disabled studio is never offered.
  const offerRows = page.scope === 'one' ? (studio?.enabled ? [studio] : []) : picker
  if (page.offer_type !== 'none' && offerRows.length === 0 && !editMode) notFound()

  // The studio the page's chrome, reviews and content blocks speak for: the
  // chosen one, else (an all-studios page with none chosen yet) the first
  // enabled one, so reviews and stats show that studio's until one is picked.
  const context = studio || offerRows[0] || null
  const contextLocationId = context?.location_id || page.primary_location_id || null

  const merged = mergedBlocksFor({ page, studio: context })
  const offerBlockType = OFFER_BLOCK_TYPE[page.offer_type]
  const offerIdx = offerBlockType ? merged.findIndex((b) => isObj(b) && b.type === offerBlockType) : -1
  const mergedOffer = offerIdx >= 0 ? merged[offerIdx] : null
  const content = merged.filter((b, i) => i !== offerIdx && isObj(b))

  const c = isObj(page.chrome) ? page.chrome : {}
  const [contextPath, contextBrand, chrome] = await Promise.all([
    safePublicPath(db, contextLocationId),
    contextLocationId ? resolveLocationBrand({ locationId: contextLocationId }) : null,
    resolveOrgChrome({ orgId: page.organization_id }),
  ])
  const studioName = contextBrand?.companyName || chrome.companyName || ''
  const logoUrl = str(c.logo_url) || (contextPath ? await getLandingLogo(contextPath, STILLORGAN_LANDING_LOGO) : null)
  const logoAlt = str(c.logo_alt) || chrome.companyName || studioName
  const logoWidthPx = Number(c.logo_width_px) || 150
  const tone = c.tone === 'light' ? 'light' : 'dark'
  const footer = { brand: chrome.companyName, studios: chrome.studios, legalName: chrome.legalName }
  const logo = { url: logoUrl, alt: logoAlt, widthPx: logoWidthPx, wordmark: chrome.shortName }

  // The paid trial's cards are wanted by the public page and the editor preview.
  const trialItems = page.offer_type === 'paid_trial'
    ? await paidTrialItems(db, page, offerRows.length ? offerRows : (editMode && context ? [context] : []))
    : []

  const layout = layoutFor(page.offer_type, page.kind)
  // The card and the coach video are the hero on these two layouts.
  const heroBlock = content.find((b) => b.type === 'hero')
  const bodyBlocks = layout === 'blocks' ? content : content.filter((b) => b.type !== 'hero')
  const heroImageUrl = str(heroBlock?.image_url) || HERO_IMAGE
  const offerArgs = { db, page, sp, sub, studio, merged, mergedOffer, bodyBlocks, heroImageUrl, trialItems, contextPath, contextBrand, contextLocationId, studioName }

  if (editMode) {
    // The preview renders the page's own layout round the editable blocks:
    // the same offer card (a paid trial's disabled), and the pinned offer
    // block (blocks[0], the editor's rule) is the region that selects it.
    const built = await offerElementFor({ ...offerArgs, preview: true })
    const offerBlockId = offerIdx === 0 ? mergedOffer.id || null : null
    // A funnel with no studio path is not for sale (the public page 404s), and
    // a live card here would book at the fallback studio: say so instead.
    if (needsPath(page.offer_type) && !contextPath) {
      built.offer = (
        <p className="max-w-md rounded-2xl bg-white text-black p-6 text-center text-sm">
          This studio has no public path yet, so its booking card cannot show here.
        </p>
      )
    }
    return (
      <EditModeOverlay
        // EDITGATE.1 parity: the studio half (trial ids, plan codes, keywords) never rides the RSC payload; the overlay edits words and media only.
        initialBlocks={clientSafeBlocks(merged)}
        initialLogoUrl={logoUrl}
        initialLogoAlt={logoAlt}
        initialLogoWidthPx={logoWidthPx}
        fallbackLogoAlt={studioName}
        wordmark={chrome.shortName}
        locationName={studioName}
        footer={footer}
        offerLayout={{ ...built, tone, offerBlockId }}
      />
    )
  }

  // A funnel posts against its studio's public path; without one there is
  // nothing to book (ClassFunnel would fall back to Stillorgan, CampaignFunnel
  // would ask for ?path=null), so the page is not for sale: a 404, as a
  // paid-trial studio with no path is not sellable. Edit mode returned above.
  if (needsPath(page.offer_type) && !contextPath) {
    logWarn('public-page', 'studio has no public path; offer not for sale', { slug: page.slug, locationId: contextLocationId })
    notFound()
  }

  const reviewsData = await loadReviews(db, contextLocationId, bodyBlocks.find((b) => b.type === 'reviews'))
  // PAGES.1 — every form on the page posts `{ page, studio }` (Task 7): the
  // public routes resolve the studio row and its attribution from the page.
  const blockProps = { publicPath: contextPath, page: page.slug, wordmark: chrome.shortName, locationName: studioName, reviewsData }
  const built = await offerElementFor(offerArgs)
  const shared = { tone, logo, cta: built.cta, footer, blocks: bodyBlocks, blockProps }

  if (built.kind === 'frosted') {
    return <FrostedCardLayout {...shared} anchor={built.anchor} heroImageUrl={built.heroImageUrl} scrollCueLabel={built.scrollCueLabel} offer={built.offer} />
  }
  if (built.kind === 'one_class') {
    return <OneClassLayout {...shared} hero={built.hero} expect={built.expect} offer={built.offer} />
  }
  return <BlocksLayout {...shared} />
}
