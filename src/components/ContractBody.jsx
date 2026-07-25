'use client'

// CONTRACTS-MD.1 — shared markdown renderer for a contract's frozen
// `body_rendered`. Replaces the old `whitespace-pre-wrap` plain-text
// render used on every contract surface (admin detail, account
// detail, template-form preview, issue-wizard preview) — recipients
// were signing documents that showed literal `#`, `##`, `**`, `---`.
//
// react-markdown turns markdown into real React elements — it walks
// the parsed tree and calls React.createElement per node, there is
// no raw-HTML-string injection point anywhere in the pipeline. And
// `skipHtml` drops any raw HTML embedded in a template body instead
// of rendering it — a script tag a template author (or a compromised
// template) put in a body is dropped entirely, never executed.
//
// GFM (tables, strikethrough, task lists, ...) is intentionally NOT
// enabled — contract bodies only need headings, lists, emphasis, and
// horizontal rules, and pulling in remark-gfm is unneeded surface
// area for a legal-document renderer.
//
// Styling mirrors the print-friendly `bg-white text-gray-900 ...
// font-serif` article wrapper already used around this component on
// every page — see admin/contracts/[id] + account/contracts/[id].

import ReactMarkdown from 'react-markdown'

const COMPONENTS = {
  h1: (props) => <h1 className="text-2xl font-bold mt-8 mb-4 first:mt-0 print:text-xl" {...props} />,
  h2: (props) => <h2 className="text-xl font-bold mt-6 mb-3 first:mt-0 print:text-lg" {...props} />,
  h3: (props) => <h3 className="text-lg font-semibold mt-5 mb-2 print:text-base" {...props} />,
  h4: (props) => <h4 className="text-base font-semibold mt-4 mb-2" {...props} />,
  h5: (props) => <h5 className="text-sm font-semibold mt-3 mb-1" {...props} />,
  h6: (props) => <h6 className="text-sm font-semibold mt-3 mb-1" {...props} />,
  p: (props) => <p className="mb-4 last:mb-0" {...props} />,
  ul: (props) => <ul className="list-disc pl-6 mb-4 space-y-1" {...props} />,
  ol: (props) => <ol className="list-decimal pl-6 mb-4 space-y-1" {...props} />,
  li: (props) => <li className="pl-1" {...props} />,
  strong: (props) => <strong className="font-semibold" {...props} />,
  em: (props) => <em className="italic" {...props} />,
  hr: () => <hr className="my-6 border-gray-300 print:my-4" />,
  a: (props) => <a className="underline" {...props} />,
  blockquote: (props) => (
    <blockquote className="border-l-2 border-gray-300 pl-4 italic text-gray-700 mb-4" {...props} />
  ),
  code: (props) => <code className="bg-gray-100 px-1 py-0.5 rounded text-[0.9em] font-mono" {...props} />,
}

export default function ContractBody({ markdown }) {
  return (
    <div className="font-serif text-sm md:text-base leading-relaxed">
      <ReactMarkdown skipHtml components={COMPONENTS}>
        {markdown || ''}
      </ReactMarkdown>
    </div>
  )
}
