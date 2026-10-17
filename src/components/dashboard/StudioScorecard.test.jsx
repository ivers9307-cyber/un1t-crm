// UN1TCLASS.5 — the FloorTable footer only promises per-coach "once Glofox
// trainer names are mapped" where the source is Glofox. Static markup, like
// RosterRunwayChip.test.jsx (node environment, no jsdom).

import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { FloorTable } from './StudioScorecard'

const ROWS = [{ label: 'HYROX', classes: 40, fillPct: 80, noShowPct: null }]

describe('FloorTable footer', () => {
  it('Glofox source (bookingKpis true): keeps the per-coach / Glofox trainer names note', () => {
    const html = renderToStaticMarkup(<FloorTable rows={ROWS} groupedBy="class" bookingKpis />)
    expect(html).toContain('Split by class — per-coach arrives once Glofox trainer names are mapped.')
  })

  it('defaults to the Glofox note when bookingKpis is not passed', () => {
    const html = renderToStaticMarkup(<FloorTable rows={ROWS} groupedBy="class" />)
    expect(html).toContain('Glofox trainer names')
  })

  it('non-Glofox source (bookingKpis false): says only "Split by class."', () => {
    const html = renderToStaticMarkup(<FloorTable rows={ROWS} groupedBy="class" bookingKpis={false} />)
    expect(html).toContain('Split by class.')
    expect(html).not.toContain('Glofox')
    expect(html).not.toContain('per-coach')
  })

  it('no footer when grouped by coach', () => {
    const html = renderToStaticMarkup(<FloorTable rows={ROWS} groupedBy="coach" bookingKpis={false} />)
    expect(html).not.toContain('Split by class')
  })
})
