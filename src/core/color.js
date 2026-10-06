// Themes, colour scales and colour helpers.
//
// A theme is a flat bag of tokens. Pass a preset name, or an object that
// `extends` a preset and overrides any tokens:
//
//   theme: 'midnight'
//   theme: { extends: 'midnight', series: ['#ff5c8a', ...], glow: 0.4 }
//
// The categorical palette is CVD-validated in its listed order: assign it in
// that order and colour follows the entity, never its rank.

// Sequential scales, light -> deep, single hue, validated for monotone
// lightness and >= 2:1 contrast at the light end. Dark themes read them
// reversed so low values recede into the background and high values glow.
export const scales = {
  violet: ['#b4a2fb', '#9a78f8', '#8150f0', '#6a32d8', '#5222b0', '#3b1d8f'],
  blue: ['#82b1ec', '#6198e2', '#4280d8', '#2a6bc9', '#1d539d', '#103b70'],
  emerald: ['#4cc794', '#2bb07e', '#12976a', '#0a7f58', '#066a49', '#064e3b'],
  orange: ['#fa9a52', '#f2741f', '#d95c0a', '#b54a0a', '#8f3a0c', '#6a2610'],
  magenta: ['#f08cbb', '#e862a2', '#d63f87', '#b8276f', '#8d1855', '#5b0b2f'],
  teal: ['#45c4b1', '#22ae9a', '#0f9887', '#0b8073', '#0d675e', '#134e4a'],
};

const base = {
  mode: 'dark',
  // The canvas is transparent by default; the page owns the background.
  // Set a colour here only if you want the chart to paint its own.
  background: 'transparent',
  font: 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
  fontMono: '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace',
  // Lighting: brightness = ambient + diffuse * lambert.
  ambient: 0.62,
  diffuse: 0.5,
  // Vertical gradient on side faces (0 = flat colour).
  gradient: 0.35,
  // Highlight stroke along top faces (0 = none).
  edge: 0.35,
  // Bloom around marks, scaled by value (0 = none).
  glow: 0,
  // Coloured light pooled on the floor beneath marks (0 = none).
  pool: 0.25,
  floorThickness: 0.12,
  gridStyle: 'lines', // 'lines' | 'dots' | 'none'
  scale: 'violet',
};

export const themes = {
  midnight: {
    ...base,
    surface: '#07070b', // what the chart sits on; used for gaps and rings
    floor: '#0c0c14',
    grid: '#262640',
    land: '#1b1a33',
    wall: 'rgba(22, 22, 40, 0.55)',
    highlight: '#17172b',
    text: '#f4f3ff',
    textMuted: '#9897b8',
    tooltip: 'rgba(16,16,28,0.92)',
    tooltipBorder: '#2e2e4d',
    series: ['#8b5cf6', '#ec4899', '#3b82f6', '#e11d48', '#0891b2', '#d97706', '#c026d3', '#16a34a'],
    ambient: 0.55,
    diffuse: 0.6,
    gradient: 0.7,
    edge: 0.7,
    glow: 0.9,
    pool: 0.65,
    gridStyle: 'dots',
  },
  dark: {
    ...base,
    surface: '#131319',
    floor: '#1b1b24',
    grid: '#2b2b38',
    land: '#2a2a3a',
    wall: 'rgba(34, 34, 46, 0.6)',
    highlight: '#262636',
    text: '#f4f4f8',
    textMuted: '#a3a3b8',
    tooltip: 'rgba(28,28,38,0.94)',
    tooltipBorder: '#33334a',
    series: ['#8b5cf6', '#ec4899', '#3b82f6', '#e11d48', '#0891b2', '#d97706', '#c026d3', '#16a34a'],
    glow: 0.3,
    pool: 0.3,
  },
};

export function registerTheme(name, theme) {
  themes[name] = resolveTheme(theme);
  return themes[name];
}

export function resolveTheme(theme = 'midnight') {
  if (typeof theme === 'string') {
    if (!themes[theme]) throw new Error(`plottwist: unknown theme "${theme}"`);
    return themes[theme];
  }
  const { extends: parent = 'midnight', ...tokens } = theme;
  return { ...resolveTheme(parent), ...tokens };
}

export function sequentialStops(theme, scale = theme.scale) {
  const stops = Array.isArray(scale) ? scale : scales[scale] ?? scales.violet;
  return theme.mode === 'dark' && !Array.isArray(scale) ? [...stops].reverse() : stops;
}

export function parseHex(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Scale an RGB colour's brightness: k < 1 darkens, k > 1 lightens toward white.
export function shade(rgb, k, alpha = 1) {
  const out =
    k <= 1 ? rgb.map((c) => c * k) : rgb.map((c) => c + (255 - c) * Math.min(1, k - 1));
  const [r, g, b] = out.map((c) => Math.round(Math.max(0, Math.min(255, c))));
  return alpha < 1 ? `rgba(${r},${g},${b},${alpha})` : `rgb(${r},${g},${b})`;
}

// Sample a list of hex stops at t in [0, 1]; returns [r, g, b].
export function rampAt(stops, t) {
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const a = parseHex(stops[i]);
  const b = parseHex(stops[i + 1]);
  const f = x - i;
  return a.map((c, k) => c + (b[k] - c) * f);
}

export const rgbString = (rgb, alpha = 1) =>
  alpha < 1 ? `rgba(${rgb.map(Math.round).join(',')},${alpha})` : `rgb(${rgb.map(Math.round).join(',')})`;
