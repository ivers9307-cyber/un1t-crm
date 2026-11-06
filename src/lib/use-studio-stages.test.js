// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, waitFor, cleanup } from '@testing-library/react'
import { useStudioStages, resetStudioStagesCache } from './use-studio-stages'

const okResponse = (stages) => ({ ok: true, json: async () => ({ success: true, data: { stages } }) })

beforeEach(() => resetStudioStagesCache())
afterEach(() => cleanup())

describe('useStudioStages', () => {
  it('fetchesOncePerLocation', async () => {
    global.fetch = vi.fn(async () => okResponse([{ slug: 'a', name: 'A' }]))
    const one = renderHook(() => useStudioStages('loc1'))
    const two = renderHook(() => useStudioStages('loc1'))
    await waitFor(() => expect(one.result.current.stages).not.toBeNull())
    await waitFor(() => expect(two.result.current.stages).not.toBeNull())
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(one.result.current.bySlug.get('a').name).toBe('A')
    const other = renderHook(() => useStudioStages('loc2'))
    await waitFor(() => expect(other.result.current.stages).not.toBeNull())
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it('nullWhileLoadingAndOnError', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, json: async () => ({ success: false }) }))
    const { result } = renderHook(() => useStudioStages('loc1'))
    expect(result.current.stages).toBeNull()
    expect(result.current.error).toBe(false)
    await waitFor(() => expect(result.current.error).toBe(true))
    expect(result.current.stages).toBeNull()
    expect(result.current.bySlug.size).toBe(0)
  })
})
