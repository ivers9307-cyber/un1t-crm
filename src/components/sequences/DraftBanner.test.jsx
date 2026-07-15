import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

// Node-environment static-markup test (same pattern as InstagramStrip.test.jsx —
// no jsdom/testing-library in this repo). useRouter needs the app router
// mounted, so stub next/navigation.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import DraftBanner from './DraftBanner.jsx'

const SEQ_ID = 'a0000000-0000-0000-0000-000000000001'

describe('DraftBanner', () => {
  it('flags that production differs and offers Discard when a draft masks a published graph', () => {
    const html = renderToStaticMarkup(
      <DraftBanner sequenceId={SEQ_ID} isDraft isPublished writeSteps={[]} />,
    )
    expect(html).toContain('Viewing draft')
    expect(html).toContain('production differs')
    expect(html).toContain('Discard draft')
  })

  it('labels a never-published sequence as draft-only, with no discard-to-production', () => {
    const html = renderToStaticMarkup(
      <DraftBanner sequenceId={SEQ_ID} isDraft isPublished={false} writeSteps={[]} />,
    )
    expect(html).toContain('Unpublished draft')
    expect(html).not.toContain('Discard draft')
    expect(html).not.toContain('production differs')
  })

  it('keeps the write-steps heads-up in both draft states', () => {
    for (const isPublished of [true, false]) {
      const html = renderToStaticMarkup(
        <DraftBanner sequenceId={SEQ_ID} isDraft isPublished={isPublished} writeSteps={['add a tag']} />,
      )
      expect(html).toContain('add a tag')
    }
  })

  it('renders nothing when there is no draft', () => {
    const html = renderToStaticMarkup(
      <DraftBanner sequenceId={SEQ_ID} isDraft={false} isPublished writeSteps={[]} />,
    )
    expect(html).toBe('')
  })
})
