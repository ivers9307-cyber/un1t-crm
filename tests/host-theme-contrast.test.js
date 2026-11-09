import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..')
const css = readFileSync(join(root, 'src/app/globals.css'), 'utf8')
const tailwindConfig = require('../tailwind.config.js')

// Balanced-brace body of the first block that starts at `open` (index of '{').
function bodyAt(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') { depth--; if (depth === 0) return text.slice(open + 1, i) }
  }
  throw new Error('unbalanced braces')
}

// All top-level-in-`text` rules as { selector, body }.
function rules(text) {
  const out = []
  let i = 0
  while (i < text.length) {
    const open = text.indexOf('{', i)
    if (open === -1) break
    const selector = text.slice(i, open).replace(/\/\*[\s\S]*?\*\//g, '').trim()
    const body = bodyAt(text, open)
    out.push({ selector, body })
    i = open + body.length + 2
  }
  return out
}

function vars(body) {
  const v = {}
  for (const m of body.matchAll(/--host-([a-z-]+)\s*:\s*([^;]+);/g)) v[m[1]] = m[2].trim()
  return v
}
const colorScheme = (body) => body.match(/color-scheme\s*:\s*([a-z]+)\s*;/)?.[1]

const allRules = rules(css)
const hostRules = allRules.filter((r) => r.selector.includes('data-host-theme'))
const selectors = (r) => r.selector.split(',').map((s) => s.trim())
const ruleFor = (sel) => hostRules.find((r) => selectors(r).includes(sel))
// The media query is found by CONTENT (the one that targets the system wrapper), not by position.
const mediaStarts = [...css.matchAll(/@media \(prefers-color-scheme: light\)\s*\{/g)].map((m) => m.index)
const hostMedia = mediaStarts
  .map((start) => ({ start, body: bodyAt(css, css.indexOf('{', start)) }))
  .find((m) => m.body.includes("[data-host-theme='system']"))
const mediaBody = hostMedia.body
const mediaRule = rules(mediaBody).find((r) => selectors(r).includes("[data-host-theme='system']"))

const themes = {
  dark: ruleFor("[data-host-theme='dark']"),
  light: ruleFor("[data-host-theme='light']"),
}
const tokens = { dark: vars(themes.dark.body), light: vars(themes.light.body) }

function lum(hex) {
  const n = parseInt(hex.slice(1), 16)
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
}
function ratio(a, b) {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
function check(theme, fg, bg, min, failures) {
  const t = tokens[theme]
  const r = ratio(t[fg], t[bg])
  if (r < min) failures.push(`${theme}: ${fg} ${t[fg]} on ${bg} ${t[bg]} = ${r.toFixed(2)} (< ${min})`)
}

const TEXT_ON = { text: ['bg', 'panel', 'well', 'input', 'hover'], label: ['bg', 'panel', 'well', 'hover'], hint: ['bg', 'panel', 'well', 'hover'] }

describe('host theme contrast (WCAG)', () => {
  it('every token is a six-digit hex so the parser stays honest', () => {
    for (const theme of ['dark', 'light']) {
      for (const [k, v] of Object.entries(tokens[theme])) expect(v, `${theme} ${k}`).toMatch(/^#[0-9A-Fa-f]{6}$/)
    }
  })
  it.each(['dark', 'light'])('%s: every text token meets 4.5:1 on every surface it sits on', (theme) => {
    const failures = []
    for (const [fg, bgs] of Object.entries(TEXT_ON)) for (const bg of bgs) check(theme, fg, bg, 4.5, failures)
    expect(failures).toEqual([])
  })
  it.each(['dark', 'light'])('%s: on-accent on accent and on-danger on danger meet 4.5:1', (theme) => {
    const failures = []
    check(theme, 'on-accent', 'accent', 4.5, failures)
    check(theme, 'on-danger', 'danger', 4.5, failures)
    expect(failures).toEqual([])
  })
  it.each(['dark', 'light'])('%s: each status text meets 4.5:1 on its own -bg and on panel', (theme) => {
    const failures = []
    for (const s of ['ok', 'warn', 'bad', 'info']) { check(theme, s, `${s}-bg`, 4.5, failures); check(theme, s, 'panel', 4.5, failures) }
    expect(failures).toEqual([])
  })
  it.each(['dark', 'light'])('%s: faint on input, and edge on panel and on input, meet 3:1', (theme) => {
    const failures = []
    check(theme, 'faint', 'input', 3, failures)
    check(theme, 'edge', 'panel', 3, failures)
    check(theme, 'edge', 'input', 3, failures)
    expect(failures).toEqual([])
  })
  it.each(['dark', 'light'])('%s: star meets 3:1 on panel and on bg', (theme) => {
    const failures = []
    check(theme, 'star', 'panel', 3, failures)
    check(theme, 'star', 'bg', 3, failures)
    expect(failures).toEqual([])
  })
  it('the contrast helper agrees with known WCAG values', () => {
    expect(ratio('#000000', '#FFFFFF')).toBeCloseTo(21, 1)
    expect(ratio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 1)
  })
})

describe('host theme token completeness', () => {
  const group = Object.keys(tailwindConfig.theme.extend.colors.host)
  it('every token in the Tailwind host group has a value in both themes', () => {
    expect(group.length).toBeGreaterThan(20)
    for (const name of group) {
      expect(tailwindConfig.theme.extend.colors.host[name]).toBe(`var(--host-${name})`)
      expect(tokens.dark[name], `dark ${name}`).toBeTruthy()
      expect(tokens.light[name], `light ${name}`).toBeTruthy()
    }
    expect(Object.keys(tokens.dark).sort()).toEqual([...group].sort())
    expect(Object.keys(tokens.light).sort()).toEqual([...group].sort())
  })
  it('the system theme sets the dark values and switches every token to light under prefers-color-scheme: light', () => {
    expect(selectors(themes.dark)).toContain("[data-host-theme='system']")
    expect(mediaRule, 'system rule inside the media query').toBeTruthy()
    expect(vars(mediaRule.body)).toEqual(tokens.light)
    expect(colorScheme(mediaRule.body)).toBe('light')
  })
  it('the light media block comes after the dark/system rule, so it wins at equal specificity', () => {
    expect(hostMedia.start).toBeGreaterThan(css.indexOf(themes.dark.body))
  })
  it('each theme sets color-scheme to its own name', () => {
    expect(colorScheme(themes.dark.body)).toBe('dark')
    expect(colorScheme(themes.light.body)).toBe('light')
  })
  it('the focus outline inside a themed wrapper uses the accent token', () => {
    expect(css).toMatch(/\[data-host-theme\]\s+:focus-visible\s*\{[^}]*var\(--host-accent\)/)
  })
})
