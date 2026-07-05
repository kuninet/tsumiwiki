/**
 * TsumiWiki Tailwind CSS preset
 *
 * Usage:
 *   // tailwind.config.js
 *   const tsumiwiki = require('./handoff/tailwind.config.js');
 *   module.exports = {
 *     content: ['./src/**\/*.{ts,tsx,html}'],
 *     presets: [tsumiwiki],
 *   };
 *
 * Dark mode strategy: `data-theme="dark"` attribute on <html>.
 */

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // theme-invariant accent
        accent: {
          DEFAULT: '#7c6cf0',
          hover:   '#6b5be6',
          soft:    'rgba(124,108,240,0.10)',
          border:  'rgba(124,108,240,0.33)',
        },
        // semantic tokens (map to CSS vars — auto ライト/ダーク切替)
        canvas:      'var(--tw-bg)',
        'panel':     'var(--tw-bg-panel)',
        'panel-2':   'var(--tw-bg-panel-2)',
        'hover':     'var(--tw-bg-hover)',
        'active':    'var(--tw-bg-active)',
        'ink':       'var(--tw-text)',
        'ink-soft':  'var(--tw-text-soft)',
        'ink-faint': 'var(--tw-text-faint)',
        'line':      'var(--tw-border)',
        'line-strong': 'var(--tw-border-strong)',
        'code-text': 'var(--tw-code-text)',
        success: '#22a06b',
        warning: '#d97706',
        danger:  '#dc2626',
        info:    '#2563eb',
      },
      fontFamily: {
        sans: ['Noto Sans JP', 'system-ui', '-apple-system', 'Segoe UI', 'Hiragino Kaku Gothic ProN', '游ゴシック', 'Yu Gothic', 'sans-serif'],
        mono: ['JetBrains Mono', 'SFMono-Regular', 'Consolas', 'Liberation Mono', 'Menlo', 'monospace'],
      },
      fontSize: {
        'xs':   ['11px',   { lineHeight: '1.4' }],
        'sm':   ['12.5px', { lineHeight: '1.5' }],
        'base': ['13.5px', { lineHeight: '1.6' }],
        'body': ['15px',   { lineHeight: '1.85' }],
        'h3':   ['15px',   { lineHeight: '1.4', fontWeight: '600' }],
        'h2':   ['17px',   { lineHeight: '1.3', fontWeight: '700' }],
        'h1':   ['22px',   { lineHeight: '1.25', fontWeight: '700' }],
      },
      borderRadius: {
        sm: '5px', DEFAULT: '7px', md: '7px', lg: '8px', xl: '10px',
      },
      boxShadow: {
        sm: 'var(--tw-shadow-sm)',
        DEFAULT: 'var(--tw-shadow)',
        lg: 'var(--tw-shadow-lg)',
      },
      spacing: {
        'header':  '52px',
        'status':  '28px',
        'sidebar': '250px',
        'content': '760px',
      },
      minWidth: {
        app: '1280px',
      },
      transitionTimingFunction: {
        smooth: 'cubic-bezier(0.2,0.7,0.2,1)',
      },
      transitionDuration: {
        fast: '120ms',
        DEFAULT: '180ms',
      },
      zIndex: {
        sidebar: '10', header: '20', dropdown: '40', toast: '60', modal: '80',
      },
    },
  },
  plugins: [],
};
