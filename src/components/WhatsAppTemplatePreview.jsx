// A WhatsApp-style bubble for a Meta components array. Extracted from
// WATemplateEditor so the pipeline builder can show follow-up wording the
// same way. components: [{ type: 'HEADER'|'BODY'|'FOOTER'|'BUTTONS', ... }]
export default function WhatsAppTemplatePreview({ components }) {
  const list = Array.isArray(components) ? components : []
  const header = list.find((c) => c.type === 'HEADER')
  const body = list.find((c) => c.type === 'BODY')
  const footer = list.find((c) => c.type === 'FOOTER')
  const buttons = list.find((c) => c.type === 'BUTTONS')?.buttons || []
  const headerFormat = header?.format || (header?.text ? 'TEXT' : 'NONE')

  return (
    <div className="bg-[#e5ddd5] rounded-lg p-4">
      <div className="bg-white rounded-lg p-3 shadow-sm max-w-[260px]">
        {headerFormat === 'TEXT' && header?.text && (
          <p className="text-sm font-bold text-gray-900 mb-1">{header.text}</p>
        )}
        {['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerFormat) && (
          <div className="bg-gray-200 rounded h-32 flex items-center justify-center text-gray-600 text-xs mb-2">
            [{headerFormat}]
          </div>
        )}
        <p className="text-sm text-gray-800 whitespace-pre-wrap">
          {body?.text || 'Your message body here...'}
        </p>
        {footer?.text && (
          <p className="text-xs text-gray-600 mt-2">{footer.text}</p>
        )}
        <p className="text-[10px] text-gray-600 text-right mt-1">12:00</p>
      </div>
      {buttons.length > 0 && (
        <div className="mt-1 space-y-1 max-w-[260px]">
          {buttons.map((btn, i) => (
            <div key={i} className="bg-white rounded-lg py-2 text-center shadow-sm">
              <span className="text-sm text-blue-600">{btn.text || 'Button'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
