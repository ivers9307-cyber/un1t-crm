import { describe, it, expect } from 'vitest'
import { RECIPES, renderPack, templateNameFor, studioSlugFor } from './recipes.js'
import { parseOfferConfig, stageSlugFor } from './offer-config.js'
import { validateGraph } from '../../src/lib/sequences/graph/validate.js'

const BASE = {
  boardKey: 'o_reset', studioSlug: 'un1t_stillorgan', studioName: 'UN1T Stillorgan', offerName: '14 Day Reset',
  durationDays: 14, signer: 'Garrett', bookingFlowId: '1343015528022374',
  appLinks: { iosUrl: 'https://apps.apple.com/ie/app/un1t-class-booking/id1532075895', androidUrl: 'https://play.google.com/store/apps/details?id=ie.zappy.fennec.untholborn' },
}
const bodyOf = (t) => t.components.find((c) => c.type === 'BODY').text
// Every path from the trigger to a whatsapp node passes an in-stage branch via its yes edge.
function expectGuarded(g, label) {
  const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]))
  const out = (id) => g.edges.filter((e) => e.from === id)
  const walk = (id, guarded) => {
    const n = byId[id]
    if (n.type === 'whatsapp') expect(guarded, `${label} ${id}`).toBe(true)
    for (const e of out(id)) {
      const stageYes = n.type === 'branch' && n.config.predicate.type === 'in_pipeline_stage_at_studio' && e.label === 'yes'
      walk(e.to, guarded || stageYes)
    }
  }
  for (const e of out('trigger')) walk(e.to, false)
  expect(g.nodes.some((n) => n.type === 'whatsapp')).toBe(true)
}
const allPacks = () => Object.values(RECIPES).flatMap((r) => r.packs.map((p) => [r.key, p.key]))

describe('expectGuarded', () => {
  it('fails on a send no in-stage branch guards', () => {
    const unguarded = {
      nodes: [{ id: 'trigger', type: 'trigger' }, { id: 'w', type: 'wait', config: {} }, { id: 's', type: 'whatsapp', config: {} }],
      edges: [{ from: 'trigger', to: 'w' }, { from: 'w', to: 's' }],
    }
    expect(() => expectGuarded(unguarded, 'neg')).toThrow()
    // The same send behind the in-stage branch's yes edge passes.
    const guarded = {
      nodes: [
        { id: 'trigger', type: 'trigger' },
        { id: 'b', type: 'branch', config: { predicate: { type: 'in_pipeline_stage_at_studio' } } },
        { id: 's', type: 'whatsapp', config: {} },
      ],
      edges: [{ from: 'trigger', to: 'b' }, { from: 'b', to: 's', label: 'yes' }],
    }
    expect(() => expectGuarded(guarded, 'pos')).not.toThrow()
  })
})

describe('recipes', () => {
  it('everyRecipeConfigParses', () => {
    for (const r of Object.values(RECIPES)) {
      const cfg = r.defaultConfig('o_b')
      expect(cfg.entry.values).toEqual([])
      // The parser refuses an empty value list; the builder completes it.
      expect(parseOfferConfig(cfg, { boardKey: 'o_b' }).ok).toBe(false)
      const filled = { ...cfg, entry: { ...cfg.entry, values: ['x'] } }
      const res = parseOfferConfig(filled, { boardKey: 'o_b' })
      expect(res.errors).toBeUndefined()
      expect(res.ok).toBe(true)
    }
    expect(RECIPES.paid_trial_offer.defaultConfig('o_b').stages.map((s) => s.slug))
      .toEqual(['new', 'first_class', 'checkpoint', 'done', 'converted'].map((r) => stageSlugFor('o_b', r, { day: 7 })))
  })

  it('everyPackGraphValidates', () => {
    for (const [rk, pk] of allPacks()) {
      const { templates, buildGraph } = renderPack(rk, pk, BASE)
      const ids = Object.fromEntries(templates.map((t) => [t.ref, `id-${t.ref}`]))
      const g = buildGraph(ids, 'o_reset_stage')
      const v = validateGraph(g)
      expect(v.errors, `${rk}/${pk}`).toEqual([])
      expect(g.trigger).toEqual({ type: 'pipeline_stage_change', config: { to_status: 'o_reset_stage' } })
      for (const n of g.nodes.filter((x) => x.type === 'whatsapp')) expect(Object.values(ids)).toContain(n.config.template_id)
      for (const n of g.nodes.filter((x) => x.type === 'apply_tag')) {
        expect(n.config.tag.startsWith(`o_reset_${pk}_`)).toBe(true)
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

  it('rejectsEmptyFillIns', () => {
    for (const k of ['studioName', 'offerName', 'signer']) {
      for (const bad of [undefined, null, '', '   ', '\n\t']) {
        expect(() => renderPack('paid_trial_offer', 'book_first_class', { ...BASE, [k]: bad }), `${k}=${JSON.stringify(bad)}`).toThrow(new RegExp(`${k} is required`))
      }
    }
  })

  it('rejectsMissingDuration', () => {
    for (const bad of [undefined, null, '', 0, -3, 1.5, '14', Number.NaN]) {
      expect(() => renderPack('paid_trial_offer', 'after_first_class', { ...BASE, durationDays: bad }), String(bad)).toThrow(/durationDays/)
    }
    // Every pack refuses it, including those whose wording has no {days}.
    for (const [rk, pk] of allPacks()) {
      expect(() => renderPack(rk, pk, { ...BASE, durationDays: undefined }), `${rk}/${pk}`).toThrow(/durationDays/)
    }
    expect(() => renderPack('promo_claim', 'welcome', { ...BASE, durationDays: 1 })).not.toThrow()
  })

  it('rejectsHalfwayDurationNotAfterCheckpoint', () => {
    for (const d of [1, 6, 7]) {
      expect(() => renderPack('paid_trial_offer', 'halfway', { ...BASE, durationDays: d }), String(d)).toThrow(/day 7 check-in/)
    }
    const ok = renderPack('paid_trial_offer', 'halfway', { ...BASE, durationDays: 8 })
    expect(bodyOf(ok.templates[0])).toContain("You've 1 days of unlimited classes left")
    // Only the halfway pack is held to it.
    expect(() => renderPack('paid_trial_offer', 'after_first_class', { ...BASE, durationDays: 7 })).not.toThrow()
  })

  it('rejectsBodyOver1024', () => {
    const long = 'x'.repeat(1000)
    expect(() => renderPack('paid_trial_offer', 'book_first_class', { ...BASE, offerName: long })).toThrow(/1024/)
    // The longest live wording with ordinary fill-ins stays well inside it.
    for (const [rk, pk] of allPacks()) {
      for (const t of renderPack(rk, pk, BASE).templates) expect(bodyOf(t).length).toBeLessThanOrEqual(1024)
    }
  })

  it('templateNameForRefusesEmptyPartsAndOverlongNames', () => {
    for (const bad of [undefined, null, '', '  ']) {
      expect(() => templateNameFor({ studioSlug: bad, boardKey: 'o_b', packKey: 'p', ref: 'main' })).toThrow(/studioSlug/)
      expect(() => templateNameFor({ studioSlug: 's', boardKey: bad, packKey: 'p', ref: 'main' })).toThrow(/boardKey/)
      expect(() => templateNameFor({ studioSlug: 's', boardKey: 'o_b', packKey: bad, ref: 'main' })).toThrow(/packKey/)
    }
    // A name over 512 throws instead of being cut into a possible collision.
    const long = 'b'.repeat(505)
    expect(templateNameFor({ studioSlug: 's', boardKey: long, packKey: 'p' })).toHaveLength(509)
    expect(() => templateNameFor({ studioSlug: 's', boardKey: long, packKey: 'p', ref: 'main' })).toThrow(/512/)
    expect(() => templateNameFor({ studioSlug: 's', boardKey: long, packKey: 'p', ref: 'followup' })).toThrow(/512/)
    // An unnamed studio reaches renderPack as an empty slug and is refused.
    expect(() => renderPack('paid_trial_offer', 'book_first_class', { ...BASE, studioSlug: studioSlugFor('!!!') })).toThrow(/studioSlug/)
  })

  it('noPackKeyIsAnUnderscoreSuffixOfAnother', () => {
    // `${board}_${pack}` names: a pack `done` beside a pack `trial_done` would
    // let board `x_trial` + `done` and board `x` + `trial_done` share a name.
    const keys = [...new Set(Object.values(RECIPES).flatMap((r) => r.packs.map((p) => p.key)))]
    for (const a of keys) {
      for (const b of keys) {
        if (a !== b) expect(b.endsWith(`_${a}`), `${b} ends with _${a}`).toBe(false)
      }
    }
  })

  it('collapsesNewlinesInSigner', () => {
    const t = renderPack('paid_trial_offer', 'book_first_class', { ...BASE, signer: '  Garrett\n\nat   UN1T\r\n' }).templates[0]
    expect(bodyOf(t).endsWith('book it for you. Garrett at UN1T')).toBe(true)
    expect(bodyOf(t)).not.toContain('\n')
  })

  it('versionedTemplateNames', () => {
    const v2 = renderPack('paid_trial_offer', 'book_first_class', { ...BASE, boardKey: 'o_reset', version: 2 })
    expect(v2.templates[0].name.endsWith('_v2')).toBe(true)
    const v1 = renderPack('paid_trial_offer', 'book_first_class', { ...BASE, boardKey: 'o_reset', version: 1 })
    const none = renderPack('paid_trial_offer', 'book_first_class', { ...BASE, boardKey: 'o_reset' })
    expect(v1.templates[0].name).toBe(none.templates[0].name)
    expect(v1.templates[0].name.endsWith('_v1')).toBe(false)
    expect(() => renderPack('paid_trial_offer', 'book_first_class', { ...BASE, version: 0 })).toThrow(/version/)
  })

  it('bodyOverrideRequiresFirstName', () => {
    const run = (main) => renderPack('paid_trial_offer', 'book_first_class', { ...BASE, bodies: { main } })
    expect(() => run('Hello there')).toThrow(/wording/)
    expect(() => run('Hi {{1}} and {{2}}')).toThrow(/wording/)
    expect(() => run('Hi {{1}} {nope}')).toThrow(/wording/)
    expect(() => run('Hi {{{1}}}')).toThrow(/wording/)
    expect(() => run('Hi {{1}}}')).toThrow(/wording/)
    expect(() => run('Hi {{1}} ' + 'x'.repeat(1100))).toThrow(/wording/)
    expect(() => renderPack('paid_trial_offer', 'book_first_class', { ...BASE, bodies: { other: 'Hi {{1}}' } })).toThrow(/wording/)
    const t = run('Hi {{1}}, {offer} at {studio} for {days} days. {signer}').templates[0]
    expect(bodyOf(t)).toBe('Hi {{1}}, 14 Day Reset at UN1T Stillorgan for 14 days. Garrett')
  })

  it('operatorWordingIsNeverEditedForButtons', () => {
    const body = 'Hi {{1}}. Tap below to book.'
    const t = renderPack('paid_trial_offer', 'book_first_class', { ...BASE, bookingFlowId: undefined, bodies: { main: body } }).templates[0]
    expect(bodyOf(t)).toBe(body)
  })

  it('dropsTapBelowWithoutButtons', () => {
    for (const [rk, pk] of allPacks()) {
      for (const t of renderPack(rk, pk, { ...BASE, bookingFlowId: undefined, appLinks: undefined }).templates) {
        expect(bodyOf(t), `${rk}/${pk}/${t.ref}`).not.toContain('Tap below')
        expect(bodyOf(t)).not.toMatch(/ {2}|\{signer\}/)
      }
    }
    const t = renderPack('programme_lead', 'welcome', { ...BASE, bookingFlowId: undefined }).templates[0]
    expect(bodyOf(t)).toBe("Hi {{1}}, welcome to the 14 Day Reset at UN1T Stillorgan 💪 We haven't seen you book your first class yet. Reply here and we'll book it for you. Garrett")
    for (const [rk, pk] of [['paid_trial_offer', 'book_first_class'], ['programme_lead', 'welcome'], ['promo_claim', 'welcome']]) {
      const b = bodyOf(renderPack(rk, pk, { ...BASE, bookingFlowId: undefined }).templates[0])
      expect(b, pk).toContain("yet. Reply here and we'll book it for you. Garrett")
      expect(b).not.toContain('Tap below')
    }
    // With a button the sentence stays.
    const withFlow = renderPack('programme_lead', 'welcome', BASE).templates[0]
    expect(bodyOf(withFlow)).toContain('Tap below')
  })
})
