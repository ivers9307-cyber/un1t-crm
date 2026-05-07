'use client'

// Tiny client island for the "Print / Save as PDF" affordance.
// window.print() opens the browser's print dialog where the user
// picks "Save as PDF" as the destination. Combined with print:*
// Tailwind utilities elsewhere on the page, the result is a
// clean single-page document with the contract body + dual
// signature block visible.

export default function ContractPrintButton({ className }) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className={className || 'text-xs px-3 py-1.5 rounded-md border border-un1t-gray text-un1t-light hover:text-un1t-white'}
    >
      Print / Save as PDF
    </button>
  )
}
