/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        un1t: {
          black: '#0A0A0A',
          dark: '#1A1A1A',
          gray: '#2A2A2A',
          mid: '#4A4A4A',
          light: '#8A8A8A',
          white: '#F5F5F5',
          accent: '#E5E5E5',
        },
        stage: {
          new: '#3B82F6',
          social: '#8B5CF6',
          trial: '#10B981',
          conversion: '#F59E0B',
          followup: '#EF4444',
          member: '#059669',
          cold: '#9CA3AF',
          lost: '#DC2626',
          returning: '#6366F1',
        }
      }
    }
  },
  plugins: [],
}
