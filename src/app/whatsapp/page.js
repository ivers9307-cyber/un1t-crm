import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { MessageCircle, Megaphone, FileText, Plus } from 'lucide-react'

export const dynamic = 'force-dynamic'

export default async function WhatsAppPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">WhatsApp</h2>
          <p className="text-sm text-un1t-light mt-1">Messages, broadcasts, and templates</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Conversations */}
        <Link
          href="/whatsapp/inbox"
          className="bg-un1t-dark border border-un1t-gray rounded-lg p-6 hover:border-un1t-white/30 transition-colors group"
        >
          <div className="w-12 h-12 rounded-lg bg-green-500/20 flex items-center justify-center mb-4">
            <MessageCircle size={24} className="text-green-400" />
          </div>
          <h3 className="font-semibold mb-1 group-hover:text-un1t-white transition-colors">Inbox</h3>
          <p className="text-sm text-un1t-light">
            View and reply to WhatsApp conversations with your contacts
          </p>
        </Link>

        {/* Broadcasts */}
        <Link
          href="/whatsapp/broadcasts"
          className="bg-un1t-dark border border-un1t-gray rounded-lg p-6 hover:border-un1t-white/30 transition-colors group"
        >
          <div className="w-12 h-12 rounded-lg bg-blue-500/20 flex items-center justify-center mb-4">
            <Megaphone size={24} className="text-blue-400" />
          </div>
          <h3 className="font-semibold mb-1 group-hover:text-un1t-white transition-colors">Broadcasts</h3>
          <p className="text-sm text-un1t-light">
            Send approved template messages to filtered audiences
          </p>
        </Link>

        {/* Templates */}
        <Link
          href="/whatsapp/templates"
          className="bg-un1t-dark border border-un1t-gray rounded-lg p-6 hover:border-un1t-white/30 transition-colors group"
        >
          <div className="w-12 h-12 rounded-lg bg-purple-500/20 flex items-center justify-center mb-4">
            <FileText size={24} className="text-purple-400" />
          </div>
          <h3 className="font-semibold mb-1 group-hover:text-un1t-white transition-colors">Templates</h3>
          <p className="text-sm text-un1t-light">
            Create and manage Meta-approved message templates
          </p>
        </Link>
      </div>
    </div>
  )
}
