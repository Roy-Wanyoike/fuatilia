import type { Config } from 'tailwindcss';

/**
 * Tailwind v3 is pinned (3.4.x) rather than v4: v3 has the most stable
 * PostCSS integration with Next 15 and needs no extra tooling. Documented
 * in frontend/README.md ("Version pins").
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Fintech-operations palette: slate base + teal action color.
        surface: {
          DEFAULT: '#f8fafc',
          raised: '#ffffff',
          sunk: '#f1f5f9',
        },
        ink: {
          DEFAULT: '#0f172a',
          soft: '#475569',
          faint: '#94a3b8',
        },
        accent: {
          DEFAULT: '#0f766e',
          soft: '#ccfbf1',
        },
        danger: {
          DEFAULT: '#b91c1c',
          soft: '#fee2e2',
        },
        warn: {
          DEFAULT: '#b45309',
          soft: '#fef3c7',
        },
        ok: {
          DEFAULT: '#15803d',
          soft: '#dcfce7',
        },
      },
      fontFamily: {
        sans: [
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
        mono: [
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Consolas',
          'Liberation Mono',
          'monospace',
        ],
      },
    },
  },
  plugins: [],
};

export default config;
