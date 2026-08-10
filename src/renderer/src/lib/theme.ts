export type ThemeMode = 'light' | 'dark' | 'system'
export type Accent = 'neutral' | 'blue' | 'violet' | 'green' | 'red'

export const ACCENTS: Record<Accent, { light: string; dark: string }> = {
  neutral: { light: '#171717', dark: '#e8e8e8' },
  blue: { light: '#0f6cbd', dark: '#4cc2ff' },
  violet: { light: '#7c3aed', dark: '#b794f6' },
  green: { light: '#0e8a5f', dark: '#4caf82' },
  red: { light: '#c9302c', dark: '#ff8a80' },
}

export const ACCENT_LABELS: Record<Accent, string> = {
  neutral: 'Neutral',
  blue: 'Blue',
  violet: 'Violet',
  green: 'Green',
  red: 'Red',
}

function hexToRgba(hex: string, a: number) {
  const h = hex.replace('#', '')
  const r = parseInt(h.substring(0, 2), 16)
  const g = parseInt(h.substring(2, 4), 16)
  const b = parseInt(h.substring(4, 6), 16)
  return `rgba(${r},${g},${b},${a})`
}

/** Computes the full set of CSS custom properties for a given mode/accent, matching new-ui/Mod Manager.dc.html's applyTheme(). */
export function computeThemeVars(dark: boolean, accent: Accent): Record<string, string> {
  const vars: Record<string, string> = dark
    ? {
        '--app-bg': '#202020',
        '--surface': '#2c2c2c',
        '--surface-2': '#262626',
        '--surface-hover': 'rgba(255,255,255,.06)',
        '--border': 'rgba(255,255,255,.10)',
        '--text': '#f2f2f2',
        '--text-2': '#b0b0b0',
        '--text-3': '#7a7a7a',
        '--danger': '#ff8a80',
        '--warning': '#e3a008',
        '--success': '#4caf82',
        '--app-shadow-sm': '0 1px 2px rgba(0,0,0,.35)',
        '--app-shadow-md': '0 8px 28px rgba(0,0,0,.55)',
      }
    : {
        '--app-bg': '#f3f3f3',
        '--surface': '#ffffff',
        '--surface-2': '#f7f7f7',
        '--surface-hover': 'rgba(0,0,0,.04)',
        '--border': 'rgba(0,0,0,.09)',
        '--text': '#1a1a1a',
        '--text-2': '#5f5f5f',
        '--text-3': '#8a8a8a',
        '--danger': '#c42b1c',
        '--warning': '#9d5d00',
        '--success': '#0e8a5f',
        '--app-shadow-sm': '0 1px 2px rgba(0,0,0,.06)',
        '--app-shadow-md': '0 8px 24px rgba(0,0,0,.16)',
      }

  const accentHex = ACCENTS[accent][dark ? 'dark' : 'light']
  const accentFg =
    accent === 'neutral' ? (dark ? '#171717' : '#ffffff') : dark ? '#1a1a1a' : '#ffffff'

  vars['--accent'] = accentHex
  vars['--accent-hover'] = accentHex
  vars['--accent-fg'] = accentFg
  vars['--accent-soft'] = hexToRgba(accentHex, dark ? 0.22 : 0.1)
  vars['--warning-soft'] = hexToRgba(vars['--warning'], dark ? 0.2 : 0.14)

  return vars
}

export function resolveDark(mode: ThemeMode, systemDark: boolean) {
  return mode === 'dark' || (mode === 'system' && systemDark)
}
