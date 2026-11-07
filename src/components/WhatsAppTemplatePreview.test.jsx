// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import WhatsAppTemplatePreview from './WhatsAppTemplatePreview.jsx'

afterEach(cleanup)

describe('WhatsAppTemplatePreview', () => {
  it('previewRendersBodyFooterButtons', () => {
    render(<WhatsAppTemplatePreview components={[
      { type: 'HEADER', format: 'TEXT', text: 'Hello header' },
      { type: 'BODY', text: 'Body words' },
      { type: 'FOOTER', text: 'Foot' },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Yes please' }] },
    ]} />)
    expect(screen.getByText('Hello header')).toBeTruthy()
    expect(screen.getByText('Body words')).toBeTruthy()
    expect(screen.getByText('Foot')).toBeTruthy()
    expect(screen.getByText('Yes please')).toBeTruthy()
  })
  it('shows a placeholder with no body', () => {
    render(<WhatsAppTemplatePreview components={[]} />)
    expect(screen.getByText('Your message body here...')).toBeTruthy()
  })
})
