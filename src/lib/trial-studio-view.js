// TRIALFIRST.1 — the client-safe view of one studio's paid trial, shared by
// /trial and the two studio pages so the card they render is the same card.
// Moved out of src/app/trial/page.js unchanged.

import { paidTrialCopyFromBlock } from '@/lib/paid-trial'

// Only the words the card shows travel to the browser: never the Glofox ids,
// the un1t.online product id, the location or the tag.
const CLIENT_BLOCK_FIELDS = [
  'eyebrow', 'heading', 'subhead', 'product_name', 'ticks', 'cta_label', 'consent_label',
  'done_title', 'done_body',
]

// The refusal, help and being-confirmed words are the resolved ones (each
// missing or blank field on its default, as the POST and the help route
// serve them), so a stored block that predates them never renders an empty
// message; resolved even for a studio not for sale, since a return reads them.
export function clientTrialBlock(block) {
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

// The card's client-safe view of one `loadTrialStudios` entry. The price is the
// config's (Hatch: the mirrored un1t.online product's), so an unsellable studio
// has none.
export function trialStudioView(entry, brand) {
  const block = entry.block || {}
  const name = brand?.companyName || brand?.locationName || (entry.key === 'hatch' ? 'Hatch Street' : 'Stillorgan')
  return {
    key: entry.key,
    // PAGES.1 — the studio's public path (a URL segment, client-safe): a page's
    // funnel names the studio by it when it posts.
    publicPath: entry.publicPath || null,
    label: (typeof block.studio_label === 'string' && block.studio_label.trim()) || name,
    // The POST sells each studio through its own provider only; agree with it.
    sellable: Boolean(entry.sellable && entry.locationId && entry.config?.provider === (entry.key === 'hatch' ? 'un1t_online' : 'glofox')),
    block: clientTrialBlock(entry.block),
    priceCents: entry.config?.priceCents ?? null,
    currency: entry.config?.currency || 'EUR',
    durationDays: entry.config?.durationDays || 14,
    productName: entry.config?.productName || block.product_name || '',
  }
}
