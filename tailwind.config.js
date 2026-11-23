/** @type {import('tailwindcss').Config} */

// Every colour below resolves through a CSS variable defined in src/index.css.
// That lets the whole app switch between the dark and light palettes without a
// `dark:` class on every element. Values are space-separated RGB channels so
// Tailwind opacity modifiers (bg-ink-800/60) keep working.
const tone = (name) => `rgb(var(--${name}) / <alpha-value>)`

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          900: tone('surface-900'),
          800: tone('surface-800'),
          700: tone('surface-700'),
          600: tone('surface-600'),
          500: tone('surface-500'),
          400: tone('surface-400'),
          300: tone('surface-300'),
          200: tone('surface-200'),
          100: tone('surface-100'),
        },
        ice: {
          100: tone('ice-100'),
          200: tone('ice-200'),
          300: tone('ice-300'),
          400: tone('ice-400'),
        },
        cyan: {
          400: tone('cyan-400'),
          500: tone('cyan-500'),
          600: tone('cyan-600'),
        },
        glass: {
          bg: tone('glass-bg'),
          border: tone('glass-border'),
          shadow: tone('glass-shadow'),
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
        // Ground shadow for cards; light theme softens it via the variable.
        soft: 'var(--shadow-soft)',
        lift: 'var(--shadow-lift)',
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
