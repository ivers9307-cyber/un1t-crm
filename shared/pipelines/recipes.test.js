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
// Every path from the trigger to a whatsapp node passes an in-stage branch via its yes edge.
function expectGuarded(g, label) {
  const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]))
  const out = (id) => g.edges.filter((e) => e.from === id)
  const walk = (id, guarded, seen) => {
    const n = byId[id]
    if (n.type === 'whatsapp') expect(guarded, `${label} ${id}`).toBe(true)
    for (const e of out(id)) {
      const stageYes = n.type === 'branch' && n.config.predicate.type === 'in_pipeline_stage_at_studio' && e.label === 'yes'
      walk(e.to, guarded || stageYes, seen)
    }
  }
  for (const e of out('trigger')) walk(e.to, false)
  expect(g.nodes.some((n) => n.type === 'whatsapp')).toBe(true)
}
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
      expectGuarded(g, `${rk}/${pk}`)
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

  it('tagsNeverCollideWithLongBoardKey', () => {
    const boardKey = 'a_very_long_board_key_name_that_goes_on_and_on_xx12'.padEnd(50, 'z').slice(0, 50)
    const other = boardKey.slice(0, 49) + 'y'
    expect(boardKey.length).toBe(50)
    const tagsOf = (bk, only) => allPacks().filter(([rk]) => !only || rk === only).flatMap(([rk, pk]) => {
      const { templates, buildGraph } = renderPack(rk, pk, { ...BASE, boardKey: bk })
      const g = buildGraph(Object.fromEntries(templates.map((t) => [t.ref, 'id'])), 's')
      const tags = g.nodes.filter((n) => n.type === 'apply_tag').map((n) => n.config.tag)
      expect(new Set(tags).size, `${rk}/${pk}`).toBe(tags.length)
      tags.forEach((t) => expect(t.length).toBeLessThanOrEqual(60))
      return tags
    })
    // one board per recipe, so uniqueness is judged within a recipe
    for (const rk of Object.keys(RECIPES)) {
      const a = tagsOf(boardKey, rk)
      expect(new Set(a).size).toBe(a.length)
      expect(tagsOf(other, rk).filter((t) => a.includes(t))).toEqual([])
    }
    expect(tagsOf(boardKey).some((t) => t.endsWith('_already_booked'))).toBe(true)
  })

  it('rejectsDoubleBraceInFillIn', () => {
    for (const k of ['studioName', 'offerName', 'signer']) {
      for (const bad of ['x {{1}}', 'a {{', 'b }}']) {
        expect(() => renderPack('paid_trial_offer', 'book_first_class', { ...BASE, [k]: bad })).toThrow(/\{\{ or \}\}/)
      }
    }
  })

  it('collapsesNewlinesInSigner', () => {
    const t = renderPack('paid_trial_offer', 'book_first_class', { ...BASE, signer: '  Garrett\n\nat   UN1T\r\n' }).templates[0]
    expect(bodyOf(t).endsWith('book it for you. Garrett at UN1T')).toBe(true)
    expect(bodyOf(t)).not.toContain('\n')
  })
})
