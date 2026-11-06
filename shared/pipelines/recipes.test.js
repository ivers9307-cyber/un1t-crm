import { describe, it, expect } from 'vitest'
import { RECIPES, renderPack, templateNameFor, studioSlugFor } from './recipes.js'
import { parseOfferConfig, stageSlugFor } from './offer-config.js'
import { validateGraph } from '../../src/lib/sequences/graph/validate.js'

const BASE = {
  boardKey: 'reset', studioSlug: 'un1t_stillorgan', studioName: 'UN1T Stillorgan', offerName: '14 Day Reset',
  durationDays: 14, signer: 'Garrett', bookingFlowId: '1343015528022374',
  appLinks: { iosUrl: 'https://apps.apple.com/ie/app/un1t-class-booking/id1532075895', androidUrl: 'https://play.google.com/store/apps/details?id=ie.zappy.fennec.untholborn' },
}
const bodyOf = (t) => t.components.find((c) => c.type === 'BODY').text
const allPacks = () => Object.values(RECIPES).flatMap((r) => r.packs.map((p) => [r.key, p.key]))

describe('recipes', () => {
  it('everyRecipeConfigParses', () => {
    for (const r of Object.values(RECIPES)) {
      const cfg = r.defaultConfig('b')
      expect(cfg.entry.values).toEqual([])
      // The parser refuses an empty value list; the builder completes it.
      expect(parseOfferConfig(cfg, { boardKey: 'b' }).ok).toBe(false)
      const filled = { ...cfg, entry: { ...cfg.entry, values: ['x'] } }
      const res = parseOfferConfig(filled, { boardKey: 'b' })
      expect(res.errors).toBeUndefined()
      expect(res.ok).toBe(true)
    }
    expect(RECIPES.paid_trial_offer.defaultConfig('b').stages.map((s) => s.slug))
      .toEqual(['new', 'first_class', 'checkpoint', 'done', 'converted'].map((r) => stageSlugFor('b', r, { day: 7 })))
  })

  it('everyPackGraphValidates', () => {
    for (const [rk, pk] of allPacks()) {
      const { templates, buildGraph } = renderPack(rk, pk, BASE)
      const ids = Object.fromEntries(templates.map((t) => [t.ref, `id-${t.ref}`]))
      const g = buildGraph(ids, 'reset_stage')
      const v = validateGraph(g)
      expect(v.errors, `${rk}/${pk}`).toEqual([])
      expect(g.trigger).toEqual({ type: 'pipeline_stage_change', config: { to_status: 'reset_stage' } })
      for (const n of g.nodes.filter((x) => x.type === 'whatsapp')) expect(Object.values(ids)).toContain(n.config.template_id)
      for (const n of g.nodes.filter((x) => x.type === 'apply_tag')) {
        expect(n.config.tag.startsWith(`reset_${pk}_`)).toBe(true)
        expect(n.config.tag.length).toBeLessThanOrEqual(60)
      }
      // every WhatsApp node is guarded by an in-stage check somewhere upstream
      expect(g.nodes.some((x) => x.type === 'branch' && x.config.predicate.type === 'in_pipeline_stage_at_studio')).toBe(true)
      const firstWait = g.nodes.find((x) => x.type === 'wait')
      if (firstWait && pk !== 'trial_done') expect(firstWait.config).toEqual({ minutes: 1 })
    }
  })

  it('rendersFillIns', () => {
    for (const [rk, pk] of allPacks()) {
      for (const t of renderPack(rk, pk, BASE).templates) {
        const body = bodyOf(t)
        expect(body).not.toMatch(/(?<!\{)\{[a-z_]+\}(?!\})/)
        expect(body).toContain('{{1}}')
        expect(t.components.find((c) => c.type === 'FOOTER').text).toBe('Reply STOP to unsubscribe')
        expect(t.components[0].example).toEqual({ body_text: [['Tim']] })
        expect(t.category).toBe('MARKETING')
        expect(t.language).toBe('en')
      }
    }
  })

  it('missingButtonsAreDropped', () => {
    const none = renderPack('paid_trial_offer', 'after_first_class', { ...BASE, bookingFlowId: undefined, appLinks: {} })
    expect(none.templates[0].components.map((c) => c.type)).toEqual(['BODY', 'FOOTER'])
    const ios = renderPack('paid_trial_offer', 'after_first_class', { ...BASE, bookingFlowId: undefined, appLinks: { iosUrl: 'https://x.test/i' } })
    expect(ios.templates[0].components.at(-1).buttons).toEqual([{ type: 'URL', text: 'iPhone app', url: 'https://x.test/i' }])
    const full = renderPack('paid_trial_offer', 'after_first_class', BASE)
    expect(full.templates[0].components.at(-1).buttons.map((b) => b.text)).toEqual(['Book a class', 'iPhone app', 'Android app'])
    expect(full.templates[0].components.at(-1).buttons[0]).toEqual({ type: 'FLOW', text: 'Book a class', flow_id: '1343015528022374', flow_action: 'data_exchange' })
    for (const [rk, pk] of allPacks()) {
      for (const t of renderPack(rk, pk, { ...BASE, bookingFlowId: undefined, appLinks: {} }).templates) {
        const b = t.components.find((c) => c.type === 'BUTTONS')
        expect(b === undefined || b.buttons.length > 0).toBe(true)
      }
    }
  })

  it('templateNamesSafeAndUnique', () => {
    expect(studioSlugFor('UN1T Stillorgan')).toBe('un1t_stillorgan')
    expect(studioSlugFor('  CCF -- Autos! ')).toBe('ccf_autos')
    expect(templateNameFor({ studioSlug: 'a', boardKey: 'B', packKey: 'p', ref: 'Main' })).toBe('a_b_p_main')
    const names = []
    for (const [rk, pk] of allPacks()) for (const t of renderPack(rk, pk, BASE).templates) names.push(t.name)
    for (const n of names) { expect(n).toMatch(/^[a-z0-9_]+$/); expect(n.length).toBeLessThanOrEqual(512) }
    // one board per recipe, so uniqueness is judged within each recipe
    for (const r of Object.values(RECIPES)) {
      const rn = r.packs.flatMap((p) => renderPack(r.key, p.key, BASE).templates.map((t) => t.name))
      expect(new Set(rn).size).toBe(rn.length)
    }
  })

  it('paidTrialCopyMatchesLive', () => {
    const t = (pk) => Object.fromEntries(renderPack('paid_trial_offer', pk, BASE).templates.map((x) => [x.ref, bodyOf(x)]))
    const book = 'Hi {{1}}, thanks for starting your 14 Day Reset at UN1T Stillorgan 💪 We haven\'t seen you book your first class yet. Tap below to pick one this week, or reply here and we\'ll book it for you. Garrett'
    expect(t('book_first_class').main).toBe(book)
    expect(t('after_first_class').main).toBe('Hi {{1}}, great to have you in for your first class of the 14 Day Reset at UN1T Stillorgan 💪 How did you find it? If you\'ve any questions about classes, I\'m here to help. The more you come in over the 14 days, the more you\'ll get out of it. Download the app to book your classes, or reply here and I can get you sorted. Thanks, Garrett')
    expect(t('halfway').main).toBe('Hi {{1}}, you\'re halfway through your 14 Day Reset at UN1T Stillorgan 💪 You\'ve 7 days of unlimited classes left, so book your next few sessions now and finish strong. Any questions, just reply here. Garrett')
    expect(t('halfway').nudge).toBe(book)
  })
})
