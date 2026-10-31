// @vitest-environment jsdom
//
// PAGES.1 (Task 18b): the edit-overlay upload sites attribute an upload to a
// page: with pageId (and no locationId, as on a scope='all' page) they upload;
// with only locationId (legacy /welcome) they still do; with neither, nothing.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup, act } from '@testing-library/react'

const upload = vi.hoisted(() => vi.fn(async () => ({ success: true, url: 'https://cdn/new.png' })))
vi.mock('@/lib/landing-media-upload', () => ({ uploadLandingMedia: upload }))

import EditableImage from './EditableImage.jsx'
import HeroMediaTools from './HeroMediaTools.jsx'
import LogoSwapper from './LogoSwapper.jsx'

const png = () => new File(['x'], 'a.png', { type: 'image/png' })
beforeEach(() => upload.mockClear())
afterEach(() => cleanup())

const pick = async (input) => {
  await act(async () => { fireEvent.change(input, { target: { files: [png()] } }) })
}

describe('EditableImage', () => {
  it('uploads with pageId and no locationId', async () => {
    const onChange = vi.fn()
    const { container } = render(<EditableImage kind="image" pageId="p-1" locationId={null} onChange={onChange} />)
    await pick(container.querySelector('input[type=file]'))
    expect(upload).toHaveBeenCalledTimes(1)
    const arg = upload.mock.calls[0][0]
    expect(arg.pageId).toBe('p-1')
    expect(arg.locationId).toBeFalsy()
    expect(onChange).toHaveBeenCalledWith('https://cdn/new.png')
  })

  it('still uploads with locationId alone (legacy)', async () => {
    const { container } = render(<EditableImage kind="image" locationId="loc-1" onChange={() => {}} />)
    await pick(container.querySelector('input[type=file]'))
    expect(upload.mock.calls[0][0]).toMatchObject({ locationId: 'loc-1' })
    expect(upload.mock.calls[0][0].pageId).toBeFalsy()
  })

  it('refuses without either id', async () => {
    const { container } = render(<EditableImage kind="image" onChange={() => {}} />)
    await pick(container.querySelector('input[type=file]'))
    expect(upload).not.toHaveBeenCalled()
  })
})

describe('HeroMediaTools', () => {
  it('uploads with pageId and no locationId', async () => {
    const onChangeImage = vi.fn()
    const { container } = render(<HeroMediaTools pageId="p-1" onChangeImage={onChangeImage} />)
    await pick(container.querySelector('input[accept^="image"]'))
    expect(upload.mock.calls[0][0]).toMatchObject({ pageId: 'p-1', kind: 'image' })
    expect(upload.mock.calls[0][0].locationId).toBeFalsy()
    expect(onChangeImage).toHaveBeenCalledWith('https://cdn/new.png')
  })

  it('uploads with locationId alone (legacy) and refuses with neither', async () => {
    const a = render(<HeroMediaTools locationId="loc-1" onChangeImage={() => {}} />)
    await pick(a.container.querySelector('input[accept^="image"]'))
    expect(upload.mock.calls[0][0]).toMatchObject({ locationId: 'loc-1' })
    cleanup(); upload.mockClear()
    const b = render(<HeroMediaTools onChangeImage={() => {}} />)
    await pick(b.container.querySelector('input[accept^="image"]'))
    expect(upload).not.toHaveBeenCalled()
  })
})

describe('LogoSwapper', () => {
  it('uploads with pageId and no locationId', async () => {
    const { container } = render(<LogoSwapper src="" pageId="p-1" onChange={() => {}} />)
    await pick(container.querySelector('input[type=file]'))
    expect(upload.mock.calls[0][0]).toMatchObject({ pageId: 'p-1', kind: 'image' })
    expect(upload.mock.calls[0][0].locationId).toBeFalsy()
  })
})
