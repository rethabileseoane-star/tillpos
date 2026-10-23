/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          900: '#0b1120',
          800: '#0f172a',
          700: '#1e293b',
          600: '#334155',
          500: '#475569',
        },
        cash: {
          400: '#34d399',
          500: '#10b981',
          600: '#059669',
        },
      },
      fontFamily: {
        // Bundled via @fontsource, no CDN so it works offline.
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        // Large touch targets for a till counter.
        tap: ['1.25rem', { lineHeight: '1.75rem' }],
        price: ['2.25rem', { lineHeight: '2.5rem', letterSpacing: '-0.02em' }],
      },
      boxShadow: {
        // From TailAdmin's shadow tokens, darkened for a dark theme: cards
        // sit on a faint ground shadow instead of floating border-only.
        soft: '0 1px 2px 0 rgba(0, 0, 0, 0.45)',
        lift: '0 12px 32px -8px rgba(0, 0, 0, 0.6)',
      },
      keyframes: {
        beep: {
          '0%': { transform: 'scale(0.9)', opacity: '0' },
          '50%': { transform: 'scale(1.03)', opacity: '1' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        slideUp: {
          from: { transform: 'translateY(100%)' },
          to: { transform: 'translateY(0)' },
        },
        pop: {
          '0%': { transform: 'scale(0.5)', opacity: '0' },
          '60%': { transform: 'scale(1.08)', opacity: '1' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        // Wrong PIN/password. Suppressed by the reduced-motion rule in index.css.
        shake: {
          '0%, 100%': { transform: 'translateX(0)' },
          '20%, 60%': { transform: 'translateX(-6px)' },
          '40%, 80%': { transform: 'translateX(6px)' },
        },
      },
      animation: {
        beep: 'beep 180ms ease-out',
        slideUp: 'slideUp 220ms cubic-bezier(0.32, 0.72, 0, 1)',
        pop: 'pop 240ms cubic-bezier(0.34, 1.56, 0.64, 1)',
        shake: 'shake 320ms ease-in-out',
      },
    },
  },
  plugins: [],
}