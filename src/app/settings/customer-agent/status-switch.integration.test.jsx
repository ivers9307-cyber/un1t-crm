// @vitest-environment jsdom
// MIASETTINGS.2b — the Off / Test / Live switch inside the editor.
import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, screen, fireEvent } from '@testing-library/react'
import { LEGACY_FULL_BLOB_GET, STILLORGAN_GET } from './__fixtures__/agent-settings'
import { renderEditor, lastPutBody, saveNow, editByLabel } from './__fixtures__/harness'

afterEach(() => { cleanup(); delete global.fetch })

describe('Off / Test / Live in the editor', () => {
  it('a legacy live-and-test row saves its flags untouched when another field is edited', async () => {
    await renderEditor(LEGACY_FULL_BLOB_GET)
    await editByLabel('Agent name', 'Mia Two')
    await saveNow()
    expect(lastPutBody()).toMatchObject({ enabled: true, test_mode: true, agent_name: 'Mia Two' })
  })

  it('clicking Live on live-and-test saves enabled true, test_mode false', async () => {
    await renderEditor(LEGACY_FULL_BLOB_GET)
    expect(screen.getByText(/Click Live to tidy this up\./)).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: 'Live' }))
    expect(screen.queryByText(/Click Live to tidy this up\./)).toBeNull()
    await saveNow()
    expect(lastPutBody()).toMatchObject({ enabled: true, test_mode: false })
  })

  it('Live then back to Test keeps the test numbers', async () => {
    await renderEditor(STILLORGAN_GET)
    fireEvent.click(screen.getByRole('radio', { name: 'Test' }))
    fireEvent.change(screen.getByPlaceholderText('+353871234567, +353879999999'), { target: { value: '+353871111111, +353872222222' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Live' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Test' }))
    expect(screen.getByPlaceholderText('+353871234567, +353879999999').value).toBe('+353871111111, +353872222222')
    await saveNow()
    expect(lastPutBody()).toMatchObject({ enabled: false, test_mode: true, test_phones: ['+353871111111', '+353872222222'] })
  })
})
