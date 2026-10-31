// PAGES.1 — the one public page route: /<slug> (and /<slug>/<sub-path>)
// renders a `landing_pages` row and its `landing_page_studios` rows. The
// design is docs/superpowers/specs/2026-10-30-landing-pages-editor-design.md
// (§2 the route, §4 the layouts).
//
//   1. Organisation: the host's (publicOrgIdForHost: the un1t-marketing brand,
//      a tenant_domains host, else UN1T Group). `?edit=1` from a signed-in
//      user is the editor's preview iframe on the CRM host: their active
//      organisation instead. An anonymous `?edit=1` is an ordinary visit.
//   2. The page by (organisation, slug). PR1 serves kind='campaign' only: a
//      studio page 404s here and keeps rendering through next.config's
//      rewrite to /welcome/[location]. draft and coming_soon 404 (edit mode
//      previews them); retired redirects to `redirect_to` with the query kept.
//      A failed read is a 404 with a warning, never a 500 for paid traffic.
//   3. The studio: scope='one' is the primary's row; scope='all' is the
//      enabled row `?studio=` names, else none yet (the offer shows its
//      picker over the enabled rows). A page switched on at no studio 404s.
//   4. Layout by offer type (layoutFor), the offer card built only from the
//      client-view helpers, then the page's content blocks, then the footer.
//
// Next serves a static route before this dynamic one, so /trial, /50plus and
// /corp keep rendering from their code routes until Task 8 deletes them; this
// route answers any slug with no static route. The proxy admits a page slug
// (and anything under it) and sets x-public-page, so AppShell renders it bare.
//
// The browser gets only client-safe props: trialStudioView (never a plan,
// membership or product id), campaignFunnelClientCopy (never the trial ids or
// the class keywords), the corp promo's words, the terms payload. A studio
// row's `locations.settings` and `attribution` never leave this file, except
// in edit mode, where the overlay gets the merged blocks for a user who may
// view the page (canViewPage), as /welcome/[location] does for its editor.

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
import { trialEntryFromRow } from '@/lib/trial-studios'
import { trialStudioView } from '@/lib/trial-studio-view'
import { parseTrialReturn } from '@/lib/trial-return-path'
import { paidTrialCopyFromBlock } from '@/lib/paid-trial'
import { un1tTermsPayload } from '@/lib/un1t-online-funnel-copy'
import { campaignFunnelCopy, campaignFunnelClientCopy } from '@/lib/campaign-funnel'
import { resolveCorpPromo, corpPromoCopyFromBlocks, fillCorpPromoTokens } from '@/lib/corp-promos'
import { classFunnelCtaLabel } from '@/lib/public-landing'
import { pageCtas, clientSafeBlocks } from '@/lib/landing-page-blocks'
import { getLandingLogo, STILLORGAN_LANDING_LOGO } from '@/lib/landing-logo'
import { resolveOrgChrome, resolveLocationBrand } from '@/lib/host-brand'
import { logWarn } from '@/lib/log'
import { FrostedCardLayout, OneClassLayout, BlocksLayout } from '@/components/landing-page/PageLayout'
import PaidTrialFunnel from '@/components/landing-page/PaidTrialFunnel'
import CampaignFunnel from '@/components/landing-page/CampaignFunnel'
import CorpPromoFunnel from '@/components/landing-page/CorpPromoFunnel'
import ClassFunnel from '@/components/ClassFunnel'
import EditModeOverlay from '@/components/landing-page/EditModeOverlay'

export const dynamic = 'force-dynamic'

// The /trial photo: the frosted card's backdrop when the page has no hero block.
const HERO_IMAGE =
  'https://iyvtbjjxdggiadzwwvdj.supabase.co/storage/v1/object/public/branding/landing-page/28c78d6b-f7b3-4edf-8c7c-840bd047b3f4/3c80aac2-7007-43c5-81f4-be44f180ef99.jpg'

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
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
    const loaded = slug ? await loadPageBySlug(db, { orgId, slug }) : null
    const editMode = Boolean(editor && loaded && canViewPage(editor, loaded.page))
    return { db, slug, rest, sp, orgId, loaded, editMode, failed: false }
  } catch (e) {
    logWarn('public-page', 'page unreadable; answering 404', { slug, orgId, code: e?.cause?.code ?? e?.code ?? null })
    return { db, slug, rest, sp, orgId, loaded: null, editMode: false, failed: true }
  }
}

// Is this page shown at all to this request (retired is handled by the caller)?
const shown = (page, editMode) => page.kind === 'campaign' && (page.publish_state === 'live' || (editMode && page.publish_state !== 'retired'))

export async function generateMetadata(props) {
  try {
    const { loaded, editMode } = await readPage(props)
    if (!loaded || !shown(loaded.page, editMode)) return {}
    const { page } = loaded
    const c = isObj(page.chrome) ? page.chrome : {}
    // The meta title (else the page title), then the brand: the meta title is
    // the words before ' | <company>', as the page title is (mig 792 seeds the
    // campaign pages' meta titles that way).
    // Customer-visible (the tab, a share): no em-dash (CLAUDE.md).
    const base = str(c.meta_title) || page.title
    const chrome = await resolveOrgChrome({ orgId: page.organization_id })
    const title = chrome.companyName ? `${base} | ${chrome.companyName}` : base
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
// today: the class_funnel copy on the studio's legacy landing row
// (studioTermsCopy, PR1; PR3 reads the studio page's chrome.un1t_terms).
async function termsFor(db, locationId, { studioName, publicPath }) {
  const copy = await studioTermsCopy(db, locationId)
  return un1tTermsPayload({ blocks: [{ type: 'class_funnel', ...copy }], studioName, publicPath })
}

// The paid trial's per-studio card data: the loadTrialStudios entry built from
// the studio row (trialEntryFromRow), its client view, and its terms tick.
async function paidTrialItems(db, page, rows) {
  return Promise.all(rows.map(async (row) => {
    const publicPath = await safePublicPath(db, row.location_id)
    const block = mergedBlocksFor({ page, studio: row }).find((b) => isObj(b) && b.type === 'paid_trial') || null
    const brand = await resolveLocationBrand({ locationId: row.location_id })
    let entry
    try {
      entry = await trialEntryFromRow(db, { row, publicPath, mergedBlock: block })
    } catch (e) {
      logWarn('public-page', 'paid trial studio unreadable; not for sale', { locationId: row.location_id, code: e?.code ?? null })
      entry = { key: null, publicPath, locationId: row.location_id, membershipSource: null, block, product: null, sellable: false, config: null }
    }
    // No public path: no terms page and no way back from a checkout, so nothing for sale.
    if (!publicPath) entry = { ...entry, sellable: false, config: null }
    entry = { ...entry, key: entry.key || row.location_id }
    const view = trialStudioView(entry, brand)
    const hatchTerms = entry.membershipSource === 'un1t_online' && view.sellable
      ? await termsFor(db, row.location_id, { studioName: brand?.locationName || view.label, publicPath })
      : null
    return { row, entry, view, hatchTerms }
  }))
}

export default async function PublicPage(props) {
  const req = await readPage(props)
  if (req.failed || !req.loaded) notFound()
  const { db, sp, editMode } = req
  const { page, studios } = req.loaded
  if (page.kind !== 'campaign') notFound()
  if (page.publish_state === 'retired') {
    const target = redirectTarget(page, req.rest, sp, { studioFromSegment: studioParamToPublicPath })
    if (target) redirect(target)
    notFound()
  }
  if (!shown(page, editMode)) notFound()
  const sub = pageSubpath(page, req.rest)
  if (sub.kind === 'unknown') notFound()

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

  if (editMode) {
    const previewItem = trialItems.find((i) => i.row === context) || trialItems[0] || null
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
        trialPreview={previewItem
          ? { studio: previewItem.view, returnPath: `/${page.slug}`, resumePurchaseId: null, cancelled: false, hatchTerms: previewItem.hatchTerms, preview: true }
          : null}
      />
    )
  }

  // A funnel posts against its studio's public path; without one there is
  // nothing to book (ClassFunnel would fall back to Stillorgan, CampaignFunnel
  // would ask for ?path=null), so the page is not for sale: a 404, as a
  // paid-trial studio with no path is not sellable. Edit mode returned above.
  if ((page.offer_type === 'class_funnel' || page.offer_type === 'one_class') && !contextPath) {
    logWarn('public-page', 'studio has no public path; offer not for sale', { slug: page.slug, locationId: contextLocationId })
    notFound()
  }

  const layout = layoutFor(page.offer_type)
  // The card and the coach video are the hero on these two layouts.
  const heroBlock = content.find((b) => b.type === 'hero')
  const bodyBlocks = layout === 'blocks' ? content : content.filter((b) => b.type !== 'hero')
  const reviewsData = await loadReviews(db, contextLocationId, bodyBlocks.find((b) => b.type === 'reviews'))
  // PAGES.1 — every form on the page posts `{ page, studio }` (Task 7): the
  // public routes resolve the studio row and its attribution from the page.
  const blockProps = { publicPath: contextPath, page: page.slug, wordmark: chrome.shortName, locationName: studioName, reviewsData }
  const heroImageUrl = str(heroBlock?.image_url) || HERO_IMAGE

  if (page.offer_type === 'paid_trial') {
    const { resumePurchaseId, cancelled } = parseTrialReturn(sp)
    const views = trialItems.map((i) => i.view)
    const chosen = page.scope === 'one' ? trialItems[0] : trialItems.find((i) => i.row === studio)
    const initialStudio = chosen?.view.key || null
    const hatchTerms = trialItems.find((i) => i.hatchTerms)?.hatchTerms || null
    const lead = trialItems.find((i) => i.view.key === initialStudio && i.view.sellable) || trialItems.find((i) => i.view.sellable) || trialItems[0]
    const cta = { href: '#trial', label: lead?.view.block?.cta_label || 'Start my trial' }
    // TRIALSCROLL.1 — the cue under the card; no sections, no cue.
    const scrollCueLabel = bodyBlocks.length > 0 ? paidTrialCopyFromBlock(lead?.entry.block).scrollCueLabel : null
    return (
      <FrostedCardLayout
        tone={tone} logo={logo} cta={cta} footer={footer} blocks={bodyBlocks} blockProps={blockProps}
        anchor="trial" heroImageUrl={heroImageUrl} scrollCueLabel={scrollCueLabel}
        offer={(
          <PaidTrialFunnel
            studios={views}
            initialStudio={initialStudio}
            resumePurchaseId={resumePurchaseId}
            cancelled={cancelled}
            hatchTerms={hatchTerms}
            returnPath={`/${page.slug}`}
            page={page.slug}
          />
        )}
      />
    )
  }

  if (page.offer_type === 'one_class') {
    const copy = campaignFunnelCopy(mergedOffer || {}, { brand: studioName })
    const cta = { href: '#book', label: 'Book a free class' }
    return (
      <OneClassLayout
        tone={tone} logo={logo} cta={cta} footer={footer} blocks={bodyBlocks} blockProps={blockProps}
        hero={{ videoUrl: copy.video_url, posterUrl: copy.poster_url, soundLabel: copy.sound_label, eyebrow: copy.eyebrow, heading: copy.heading, subhead: copy.subhead }}
        expect={{ eyebrow: copy.expect_eyebrow, heading: copy.expect_heading, cards: copy.expect_cards }}
        offer={<CampaignFunnel publicPath={contextPath} campaign={page.slug} page={page.slug} copy={campaignFunnelClientCopy(copy)} locationName={studioName} />}
      />
    )
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
    const cta = { href: '#corp', label: copy.cta_label }
    return (
      <FrostedCardLayout
        tone={tone} logo={logo} cta={cta} footer={footer} blocks={bodyBlocks} blockProps={blockProps}
        anchor="corp" heroImageUrl={heroImageUrl}
        offer={<CorpPromoFunnel promoKey={promo ? promo.key : null} copy={copy} terms={terms} page={page.slug} studio={contextPath} />}
      />
    )
  }

  if (page.offer_type === 'class_funnel') {
    const funnel = mergedOffer || {}
    const cta = { href: '#start', label: classFunnelCtaLabel(merged) }
    return (
      <FrostedCardLayout
        tone={tone} logo={logo} cta={cta} footer={footer} blocks={bodyBlocks} blockProps={blockProps}
        anchor="start" heroImageUrl={heroImageUrl}
        offer={(
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
        )}
      />
    )
  }

  // offer_type 'none': the page's own blocks, its CTA from its own capture blocks.
  const { primary } = pageCtas(bodyBlocks)
  const cta = { href: primary?.href || null, label: primary?.label }
  return <BlocksLayout tone={tone} logo={logo} cta={cta} footer={footer} blocks={bodyBlocks} blockProps={blockProps} />
}
