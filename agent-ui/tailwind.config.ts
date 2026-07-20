import type { Config } from 'tailwindcss'
import tailwindcssAnimate from 'tailwindcss-animate'

/**
 * Every theme key below points at a CSS custom property defined on
 * :root in src/app/globals.css. There is exactly one place to change
 * a colour, a type step or a radius, and it is not this file.
 */
export default {
  darkMode: ['class', '[data-theme="dark"]'],
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}'
  ],
  theme: {
    extend: {
      colors: {
        primary: 'var(--text)',
        primaryAccent: 'var(--brand-fg)',
        brand: 'var(--brand)',
        background: {
          DEFAULT: 'var(--bg)',
          secondary: 'var(--bg-secondary)'
        },
        secondary: 'var(--text-secondary)',
        border: 'rgba(var(--color-border-default))',
        accent: 'var(--accent)',
        card: 'var(--surface)',
        muted: 'var(--text-muted)',
        destructive: 'var(--danger)',
        positive: 'var(--ok)',
        // token-native names — preferred in new code
        ink: 'var(--ink)',
        surface: {
          DEFAULT: 'var(--surface)',
          raised: 'var(--surface-raised)',
          inverse: 'var(--surface-inverse)'
        },
        ok: 'var(--ok-strong)',
        warn: 'var(--warn)',
        danger: 'var(--danger-strong)'
      },
      fontFamily: {
        display: 'var(--font-display)',
        body: 'var(--font-body)',
        mono: 'var(--font-mono)',
        // legacy aliases, still referenced by existing components
        geist: 'var(--font-body)',
        dmmono: 'var(--font-mono)'
      },
      fontSize: {
        '2xs': 'var(--text-2xs)'
      },
      letterSpacing: {
        tag: 'var(--tracking-tag)',
        brutal: 'var(--tracking-wide)'
      },
      borderRadius: {
        none: 'var(--radius-none)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
        full: 'var(--radius-full)'
      }
    }
  },
  plugins: [tailwindcssAnimate]
} satisfies Config
