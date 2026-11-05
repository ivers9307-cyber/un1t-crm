// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import OverviewSection from './OverviewSection'

afterEach(cleanup)

function agentWith(extra) {
  return {
    settings: { enabled: false, test_mode: true, test_phones: [], quiet_hours: {} },
    location: { timezone: 'Europe/Dublin' },
    setField: vi.fn(), setQuietHours: vi.fn(), setNoQuietHours: vi.fn(),
    sourceTag: () => null, holds: [], overridden: [], org: null, ...extra,
  }
}

describe('OverviewSection summary', () => {
  it('is hidden when the studio has no organisation layer', () => {
    render(<OverviewSection agent={agentWith({ overridden: ['followups.daily_cap'] })} canEdit />)
    expect(screen.queryByText('What this studio has changed')).toBeNull()
  })
  it('lists changed sections as buttons that open them', () => {
    const onOpenSection = vi.fn()
    render(<OverviewSection onOpenSection={onOpenSection} canEdit
      agent={agentWith({ org: {}, overridden: ['followups.daily_cap', 'followups.enabled', 'quiet_hours.start', 'quiet_hours.end'] })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Follow-ups: 2 settings' }))
    expect(onOpenSection).toHaveBeenCalledWith('followups')
    expect(screen.getByRole('button', { name: 'Overview: 1 setting' })).toBeTruthy()
  })
  it('says everything is inherited when nothing is changed', () => {
    render(<OverviewSection agent={agentWith({ org: {} })} canEdit />)
    expect(screen.getByText("This studio uses the organisation's settings for everything.")).toBeTruthy()
  })
})
