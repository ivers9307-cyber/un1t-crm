// Public booking pages use their own clean layout — no sidebar
export default function BookingLayout({ children }) {
  return (
    <div className="min-h-screen bg-white text-gray-900 flex items-start justify-center p-4 md:p-8">
      {children}
    </div>
  )
}
