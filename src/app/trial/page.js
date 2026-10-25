// /trial — PAIDTRIAL.1: the public Meta-ad product page for the paid trial.
// Same layout as /start (the paid-ad twin): a hero photo with the product card
// as a frosted panel, then the content blocks, with every CTA scrolling back
// up to the card. TRIALSTUDIO.10: the card opens with a studio choice
// (Stillorgan Village or Hatch Street); each studio's product (copy, price,
// duration, what is granted after payment) is its own landing row's
// paid_trial block, edited at /settings/landing-page, and a studio with no
// sellable block is shown as not available online, never a 404 for paid
// traffic. `?studio=stillorgan|hatch` preselects; `?purchase=<id>` is a
// return from a checkout (`&studio=hatch` from un1t.online's, `&cancelled=1`
// when the buyer backed out). The chrome (title, description, footer) is the
// organisation's; studio-specific words live only on the two blocks.
//
// Allowlisted on the proxy, AppShell and the un1t-marketing brand (UN1T-only,
// like /start: not served on tenant hosts, pinned in
// src/public-compliance-paths.test.jsx). noindex: a paid funnel should not
// compete in organic search. Only the site Meta pixel loads here (spec §6,
// src/lib/meta-pixel-paths.js); the server sends Lead, InitiateCheckout and
// Purchase to the chosen studio's own dataset.

import { createServerClient } from '@/lib/supabase'
import { blocksOrDefault } from '@/lib/landing-page-blocks'
import { loadTrialStudios } from '@/lib/trial-studios'
import { paidTrialCopyFromBlock } from '@/lib/paid-trial'
import { un1tTermsPayload } from '@/lib/un1t-online-funnel-copy'
import BlockRenderer, { SiteHeader, SiteFooter } from '@/components/landing-page/BlockRenderers'
import RevealManager from '@/components/landing-page/RevealManager'
import { RevealArmScript } from '@/components/landing-page/reveal-arm'
import VisitOriginCapture from '@/components/VisitOriginCapture'
import PaidTrialFunnel from '@/components/landing-page/PaidTrialFunnel'
import { getLandingLogo, STILLORGAN_LANDING_LOGO } from '@/lib/landing-logo'
import { resolveOrgChrome, resolveLocationBrand } from '@/lib/host-brand'
import { UN1T_GROUP_ORG_ID } from '@/lib/brands'
import { logWarn } from '@/lib/log'

export const dynamic = 'force-dynamic'

const STILLORGAN_LOCATION_ID = 'a0000000-0000-0000-0000-000000000001'
const CONTENT_PATHS = ['stillorgan', 'hatch-street']
const NOT_CONTENT = ['hero', 'lead_form', 'class_funnel', 'paid_trial']
const STUDIO_KEYS = ['stillorgan', 'hatch']
const HERO_IMAGE =
  'https://iyvtbjjxdggiadzwwvdj.supabase.co/storage/v1/object/public/branding/landing-page/28c78d6b-f7b3-4edf-8c7c-840bd047b3f4/3c80aac2-7007-43c5-81f4-be44f180ef99.jpg'
const CTA_HREF = '#trial'
// Only the words the card shows travel to the browser: never the Glofox ids,
// the un1t.online product id, the location or the tag.
const CLIENT_BLOCK_FIELDS = [
  'eyebrow', 'heading', 'subhead', 'product_name', 'ticks', 'cta_label', 'consent_label',
  'done_title', 'done_body',
]

export async function generateMetadata() {
  const chrome = await resolveOrgChrome({ orgId: UN1T_GROUP_ORG_ID })
  const name = chrome.companyName
  return {
    title: name ? `The UN1T Trial — ${name}` : 'The UN1T Trial',
    description: `The UN1T Trial${name ? ` at ${name}` : ''}. Choose your studio, pay once, start this week.`,
    robots: { index: false, follow: false },
  }
}

// Both landing rows' blocks in one read: the page's content sections are
// Stillorgan's own if it has any beyond the product, else Hatch Street's (the
// sections /start uses); Hatch Street's blocks also carry its un1t.online
// terms copy. Graceful: any miss → the hero and the card still render.
async function loadContent(db) {
  try {
    const { data, error } = await db.from('landing_page_settings').select('public_path, blocks').in('public_path', CONTENT_PATHS)
    if (error) throw error
    const byPath = new Map((data || []).map((r) => [r.public_path, r.blocks]))
    const content = (path) => blocksOrDefault(byPath.get(path)).filter((b) => !NOT_CONTENT.includes(b.type))
    const own = content('stillorgan')
    return { blocks: own.length > 0 ? own : content('hatch-street'), hatchBlocks: byPath.get('hatch-street') || [] }
  } catch (e) {
    logWarn('trial-page', 'landing rows unreadable; hero and card only', { err: e })
    return { blocks: [], hatchBlocks: [] }
  }
}

// The refusal, help and being-confirmed words are the resolved ones (each
// missing or blank field on its default, as the POST and the help route
// serve them), so a stored block that predates them never renders an empty
// message; resolved even for a studio not for sale, since a return reads them.
function clientBlock(block) {
  const out = {}
  for (const k of CLIENT_BLOCK_FIELDS) if (block && block[k] !== undefined) out[k] = block[k]
  const copy = paidTrialCopyFromBlock(block)
  out.trial_used_text = copy.trialUsedText
  out.active_member_text = copy.activeMemberText
  out.help_cta_label = copy.helpCtaLabel
  out.help_sent_text = copy.helpSentText
  out.pending_body = copy.pendingBody
  return out
}

export default async function TrialPage(props) {
  const sp = await props.searchParams
  const resumePurchaseId = typeof sp?.purchase === 'string' && /^[0-9a-f-]{36}$/i.test(sp.purchase) ? sp.purchase : null
  const initialStudio = STUDIO_KEYS.includes(sp?.studio) ? sp.studio : null
  const cancelled = sp?.cancelled === '1'
  const db = createServerClient()
  const [{ blocks, hatchBlocks }, entries, logoUrl, chrome] = await Promise.all([
    loadContent(db),
    loadTrialStudios(db),
    getLandingLogo('stillorgan', STILLORGAN_LANDING_LOGO),
    resolveOrgChrome({ orgId: UN1T_GROUP_ORG_ID }),
  ])
  const brands = await Promise.all(entries.map((s) => {
    const locationId = s.locationId || (s.key === 'stillorgan' ? STILLORGAN_LOCATION_ID : null)
    return locationId ? resolveLocationBrand({ locationId }) : null
  }))

  // The card's client-safe view of each studio. The price is the config's
  // (Hatch: the mirrored un1t.online product's), so an unsellable studio has none.
  const studios = entries.map((s, i) => {
    const block = s.block || {}
    const name = brands[i]?.companyName || brands[i]?.locationName || (s.key === 'hatch' ? 'Hatch Street' : 'Stillorgan')
    return {
      key: s.key,
      label: (typeof block.studio_label === 'string' && block.studio_label.trim()) || name,
      // The POST sells each studio through its own provider only; agree with it.
      sellable: Boolean(s.sellable && s.locationId && s.config?.provider === (s.key === 'hatch' ? 'un1t_online' : 'glofox')),
      block: clientBlock(s.block),
      priceCents: s.config?.priceCents ?? null,
      currency: s.config?.currency || 'EUR',
      durationDays: s.config?.durationDays || 14,
      productName: s.config?.productName || block.product_name || '',
    }
  })
  const hatchIndex = entries.findIndex((s) => s.key === 'hatch')
  const hatch = studios[hatchIndex]
  // un1t.online's terms and waiver tick, as the server's terms_required answer
  // would carry it (the studio's locations.name, the hatch-street documents).
  const hatchTerms = hatch?.sellable
    ? un1tTermsPayload({ blocks: hatchBlocks, studioName: brands[hatchIndex]?.locationName || hatch.label, publicPath: 'hatch-street' })
    : null

  const lead = studios.find((s) => s.key === initialStudio && s.sellable) || studios.find((s) => s.sellable) || studios[0]
  const ctaLabel = lead?.block?.cta_label || 'Start my trial'
  const stillorganName = brands[entries.findIndex((s) => s.key === 'stillorgan')]?.companyName || chrome.companyName

  return (
    <div className="min-h-screen bg-black text-white antialiased">
      <RevealArmScript />
      <VisitOriginCapture />
      <RevealManager />
      <SiteHeader logoUrl={logoUrl} logoAlt={chrome.companyName || stillorganName} logoWidthPx={150} sticky ctaHref={CTA_HREF} ctaLabel={ctaLabel} />

      <section id="trial" className="relative min-h-[92svh] flex flex-col overflow-hidden bg-black lp-grain">
        <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
          <div className="absolute inset-0 bg-cover bg-center lp-kenburns" style={{ backgroundImage: `url(${HERO_IMAGE})` }} />
        </div>
        <div className="absolute inset-0 pointer-events-none" aria-hidden="true"
          style={{ background: 'linear-gradient(180deg, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0.5) 45%, rgba(0,0,0,0.85) 100%)' }} />
        <div className="relative z-10 flex-1 flex items-center justify-center px-5 pt-28 pb-16">
          <PaidTrialFunnel
            studios={studios}
            initialStudio={initialStudio}
            resumePurchaseId={resumePurchaseId}
            cancelled={cancelled}
            hatchTerms={hatchTerms}
          />
        </div>
      </section>

      {blocks.map((b) => (
        <BlockRenderer key={b.id} block={b} publicPath="stillorgan" ctaHref={CTA_HREF} ctaLabel={ctaLabel} wordmark={chrome.shortName} locationName={stillorganName} />
      ))}

      <SiteFooter ctaHref={CTA_HREF} ctaLabel={ctaLabel} brand={chrome.companyName} studios={chrome.studios} legalName={chrome.legalName} />
    </div>
  )
}
