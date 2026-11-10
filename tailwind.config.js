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
        ink: {
          900: tone('ink-900'),
          800: tone('ink-800'),
          700: tone('ink-700'),
          600: tone('ink-600'),
          500: tone('ink-500'),
        },
        cash: {
          300: tone('cash-300'),
          400: tone('cash-400'),
          500: tone('cash-500'),
          600: tone('cash-600'),
        },
        // Text and icons that sit on a bright accent button. Dark on the dark
        // theme's neon green, white on the light theme's deeper green.
        'on-accent': tone('on-accent'),
        slate: {
          100: tone('slate-100'),
          200: tone('slate-200'),
          300: tone('slate-300'),
          400: tone('slate-400'),
          500: tone('slate-500'),
          600: tone('slate-600'),
          700: tone('slate-700'),
        },
        amber: {
          200: tone('amber-200'),
          300: tone('amber-300'),
          400: tone('amber-400'),
          500: tone('amber-500'),
        },
        red: {
          200: tone('red-200'),
          300: tone('red-300'),
          400: tone('red-400'),
          500: tone('red-500'),
          600: tone('red-600'),
          900: tone('red-900'),
        },
        sky: {
          300: tone('sky-300'),
          400: tone('sky-400'),
          500: tone('sky-500'),
        },
        rose: {
          200: tone('rose-200'),
          300: tone('rose-300'),
          500: tone('rose-500'),
        },
        // Info / loan / ad-hoc badges. Emerald stays a literal colour because it
        // is only used over the black camera preview.
        indigo: {
          300: tone('indigo-300'),
          500: tone('indigo-500'),
        },
        violet: {
          300: tone('violet-300'),
          500: tone('violet-500'),
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
