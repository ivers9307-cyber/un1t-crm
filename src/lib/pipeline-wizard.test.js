import { describe, it, expect } from 'vitest'
import {
  initialWizardState, wizardReducer, wizardConfig, wizardBodies, stepErrors, followupPacks,
  previewTemplate, WIZARD_STEPS, UN1T_STUDIO_NOTICE, UN1T_SOURCES, isUn1tStudio,
} from './pipeline-wizard.js'
import { RECIPES } from '@shared/pipelines/recipes.js'
import { parseOfferConfig, MIA_NOTES_MAX } from '@shared/pipelines/offer-config.js'
import { UN1T_STUDIO_ERROR } from './pipeline-boards.js'
import { UN1T_MEMBERSHIP_SOURCES } from './pipeline-offer-claims.js'
import { boardCreateSchema } from './schemas.js'

const run = (state, ...actions) => actions.reduce(wizardReducer, state)
const base = () => initialWizardState({ studioName: 'UN1T Stillorgan' })
const picked = (key = 'paid_trial_offer') => run(base(), { type: 'pickRecipe', recipeKey: key })
const filled = () => run(
  picked(),
  { type: 'setName', name: 'Spring reset' },
  { type: 'setEntryValues', values: ['RESET39'] },
)

describe('pipeline wizard', () => {
  it('has the seven steps in order', () => {
    expect(WIZARD_STEPS).toEqual(['Recipe', 'Name and offer', 'Who enters', 'Stages', 'Follow-ups', 'Notes for Mia', 'Review'])
  })

  it('reducerBuildsConfigFromRecipe', () => {
    const s = run(filled(), { type: 'setOfferName', name: '14 Day Reset' }, { type: 'setSigner', name: 'Karl' })
    const config = wizardConfig(s)
    expect(config.entry).toEqual({ type: 'trial_purchase', match: 'plan_code', values: ['RESET39'] })
    expect(config.stages.map((st) => st.role)).toEqual(['new', 'first_class', 'checkpoint', 'done', 'converted'])
    expect(config.stages.find((st) => st.role === 'checkpoint')).toEqual({ role: 'checkpoint', name: 'Day 7', day: 7 })
    // Slugs are the server's job.
    expect(config.stages.every((st) => st.slug === undefined)).toBe(true)
    expect(config.duration_days).toBe(14)
    expect(config.offer_name).toBe('14 Day Reset')
    expect(config.signer).toBe('Karl')
    expect(config.mia_notes).toBeUndefined()
  })

  it('leaves unticked stages out of the config', () => {
    const s = run(filled(), { type: 'toggleStage', index: 2 })
    expect(wizardConfig(s).stages.map((st) => st.role)).toEqual(['new', 'first_class', 'done', 'converted'])
  })

  it('newStageCannotBeUnticked', () => {
    const s = run(picked(), { type: 'toggleStage', index: 0 })
    expect(s.stages[0]).toMatchObject({ role: 'new', enabled: true, locked: true })
  })

  it('renames a stage', () => {
    const s = run(filled(), { type: 'renameStage', index: 1, name: 'First visit' })
    expect(wizardConfig(s).stages[1].name).toBe('First visit')
  })

  it('checkpointDayEditable', () => {
    // A checkpoint with no follow-up pack (no recipe has one today, so add one).
    const promo = run(picked('promo_claim'), { type: 'setName', name: 'Promo' }, { type: 'setEntryValues', values: ['corp1'] })
    const s0 = { ...promo, stages: [...promo.stages, { role: 'checkpoint', name: 'Day 3', defaultName: 'Day 3', day: 3, enabled: true, locked: false }] }
    const s = wizardReducer(s0, { type: 'setStageDay', index: 4, day: '5' })
    expect(s.stages[4].day).toBe(5)
    expect(wizardConfig(s).stages[4]).toEqual({ role: 'checkpoint', name: 'Day 3', day: 5 })
    const bad = wizardReducer(s0, { type: 'setStageDay', index: 4, day: '' })
    expect(stepErrors(bad, 'Stages')).toEqual(['The check-in day must be a whole number, 1 or more.'])
  })

  it('a checkpoint with a follow-up pack keeps the pack day', () => {
    const s = picked()
    expect(s.stages[2]).toMatchObject({ role: 'checkpoint', day: 7, fixedDay: 7 })
    const moved = wizardReducer(s, { type: 'setStageDay', index: 2, day: '10' })
    expect(moved).toBe(s)
    expect(moved.stages[2].day).toBe(7)
  })

  it('edits a class count', () => {
    const s = { ...filled(), stages: [...filled().stages, { role: 'class_n', name: '3rd Class', count: 3, enabled: true, locked: false }] }
    expect(wizardReducer(s, { type: 'setStageCount', index: 5, count: '4' }).stages[5].count).toBe(4)
  })

  it('stepErrorsMirrorParser', () => {
    const s = picked()
    expect(stepErrors(s, 'Name and offer')).toEqual(['Give the board a name.'])
    expect(stepErrors(s, 'Who enters')).toEqual(['Pick at least one option.'])
    // The same config the parser refuses for the same reason.
    const parsed = parseOfferConfig(
      { ...wizardConfig(s), stages: wizardConfig(s).stages.map((st) => ({ ...st, slug: `o_preview_${st.role === 'checkpoint' ? `day_${st.day}` : st.role}` })) },
      { boardKey: 'o_preview' },
    )
    expect(parsed.ok).toBe(false)
    expect(parsed.errors).toContain('entry.values needs at least one value')
    expect(stepErrors(filled(), 'Review')).toEqual([])
  })

  it('maps stage name errors to the step in plain words', () => {
    const blank = run(filled(), { type: 'renameStage', index: 1, name: '  ' })
    expect(stepErrors(blank, 'Stages')).toEqual(['Give the 1st Class stage a name.'])
    const dup = run(filled(), { type: 'renameStage', index: 1, name: 'new leads' })
    expect(stepErrors(dup, 'Stages')).toEqual(['Two stages are called new leads. Give each stage its own name.'])
  })

  it('checks the offer fields', () => {
    const long = run(filled(), { type: 'setOfferName', name: 'x'.repeat(61) })
    expect(stepErrors(long, 'Name and offer')).toEqual(['The offer name must be 60 characters or fewer.'])
    const braces = run(filled(), { type: 'setSigner', name: 'Karl {{2}}' })
    expect(stepErrors(braces, 'Name and offer')).toEqual(["The sign-off can't contain {{ or }}."])
    const days = run(filled(), { type: 'setDurationDays', days: '0' })
    expect(stepErrors(days, 'Name and offer')).toEqual(['The offer length must be a whole number of days from 1 to 365.'])
    const prio = run(filled(), { type: 'setPriority', priority: '2000' })
    expect(stepErrors(prio, 'Name and offer')).toEqual(['Priority must be a whole number from 1 to 1000.'])
  })

  it('checks the Mia notes length', () => {
    const s = run(filled(), { type: 'setMiaNotes', notes: 'x'.repeat(MIA_NOTES_MAX + 1) })
    expect(stepErrors(s, 'Notes for Mia')).toEqual([`Notes for Mia must be ${MIA_NOTES_MAX} characters or fewer.`])
    const ok = run(filled(), { type: 'setMiaNotes', notes: 'Mention the free towel.' })
    expect(wizardConfig(ok).mia_notes).toBe('Mention the free towel.')
  })

  it('a trial purchase match change clears the values', () => {
    const s = run(filled(), { type: 'setEntryMatch', match: 'landing_path' })
    expect(s.entry).toEqual({ type: 'trial_purchase', match: 'landing_path', values: [] })
  })

  it('followupBodyDefaultsToRecipe', () => {
    const s = picked()
    const recipe = RECIPES.paid_trial_offer
    for (const pack of recipe.packs) {
      for (const t of pack.templates) expect(s.bodies[pack.key][t.ref]).toBe(t.body)
    }
    // Unchanged wording is not sent: the server renders the recipe's own.
    expect(wizardBodies(s)).toEqual({})
    const edited = run(s, { type: 'setBody', packKey: 'trial_done', ref: 'followup', body: 'Hi {{1}}, any thoughts? {signer}' })
    expect(wizardBodies(edited)).toEqual({ trial_done: { followup: 'Hi {{1}}, any thoughts? {signer}' } })
  })

  it('lists follow-ups only for ticked stages', () => {
    expect(followupPacks(filled()).map((p) => p.key)).toEqual(['book_first_class', 'after_first_class', 'halfway', 'trial_done'])
    const s = run(filled(), { type: 'toggleStage', index: 2 })
    expect(followupPacks(s).map((p) => p.key)).toEqual(['book_first_class', 'after_first_class', 'trial_done'])
  })

  it('previews with Tim and the tokens filled, and reports wording errors', () => {
    const s = run(filled(), { type: 'setOfferName', name: '14 Day Reset' }, { type: 'setSigner', name: 'Karl' })
    const p = previewTemplate(s, 'trial_done', 'followup')
    expect(p.error).toBeNull()
    const body = p.components.find((c) => c.type === 'BODY').text
    expect(body).toBe('Hey Tim, just bumping this in case it got buried! Reply here if you\'d like a hand choosing a membership, or a quick call 👍 Karl')
    const bad = run(s, { type: 'setBody', packKey: 'trial_done', ref: 'followup', body: 'Hello there' })
    expect(previewTemplate(bad, 'trial_done', 'followup').error).toBe('the message must include {{1}} (the first name)')
    expect(stepErrors(bad, 'Follow-ups')).toEqual(['End of trial: the message must include {{1}} (the first name)'])
    // An unticked stage's wording does not block.
    const off = run(bad, { type: 'toggleStage', index: 3 })
    expect(stepErrors(off, 'Follow-ups')).toEqual([])
  })

  it('falls back to the board and studio names in the preview', () => {
    const p = previewTemplate(filled(), 'trial_done', 'main')
    expect(p.components[0].text).toContain('Your Spring reset has come to an end')
    expect(p.components[0].text).toContain('UN1T Stillorgan here')
  })

  it('next is blocked on errors and back never goes below the first step', () => {
    const blocked = wizardReducer(base(), { type: 'next' })
    expect(blocked.step).toBe(0)
    expect(blocked.showErrors).toBe(true)
    const moved = wizardReducer(picked(), { type: 'next' })
    expect(moved.step).toBe(1)
    expect(moved.showErrors).toBe(false)
    expect(wizardReducer(base(), { type: 'back' }).step).toBe(0)
    expect(wizardReducer(moved, { type: 'back' }).step).toBe(0)
  })

  it('picking the same recipe again keeps the edits', () => {
    const s = run(filled(), { type: 'renameStage', index: 1, name: 'First visit' }, { type: 'pickRecipe', recipeKey: 'paid_trial_offer' })
    expect(s.stages[1].name).toBe('First visit')
    const other = run(s, { type: 'pickRecipe', recipeKey: 'promo_claim' })
    expect(other.entry).toEqual({ type: 'corp_promo', values: [] })
    expect(other.stages.map((st) => st.name)).toEqual(['New', '1st Class', 'Done', 'Converted'])
  })

  it('keeps the board name and priority bounds in step with boardCreateSchema', () => {
    const body = (over) => ({ name: 'Board', recipe_key: 'paid_trial_offer', config: {}, ...over })
    const nameErrors = (st) => stepErrors(st, 'Name and offer').filter((e) => e.startsWith('The board name') || e.startsWith('Give the board'))
    for (const len of [80, 81]) {
      const name = 'x'.repeat(len)
      const schemaOk = boardCreateSchema.safeParse(body({ name })).success
      expect(nameErrors(run(filled(), { type: 'setName', name })).length === 0).toBe(schemaOk)
    }
    expect(boardCreateSchema.safeParse(body({ name: 'x'.repeat(80) })).success).toBe(true)
    expect(boardCreateSchema.safeParse(body({ name: 'x'.repeat(81) })).success).toBe(false)
    for (const priority of [0, 1, 1000, 1001]) {
      const schemaOk = boardCreateSchema.safeParse(body({ priority })).success
      const wizardOk = !stepErrors(run(filled(), { type: 'setPriority', priority }), 'Name and offer')
        .some((e) => e.startsWith('Priority'))
      expect([priority, wizardOk]).toEqual([priority, schemaOk])
    }
    expect([0, 1, 1000, 1001].map((priority) => boardCreateSchema.safeParse(body({ priority })).success))
      .toEqual([false, true, true, false])
  })

  it('keeps the un1t.online notice and sources in step with the server', () => {
    expect(UN1T_STUDIO_NOTICE).toBe(UN1T_STUDIO_ERROR)
    expect([...UN1T_SOURCES]).toEqual([...UN1T_MEMBERSHIP_SOURCES])
    expect(isUn1tStudio('un1t_online')).toBe(true)
    expect(isUn1tStudio('glofox')).toBe(false)
    expect(isUn1tStudio(null)).toBe(false)
  })
})
