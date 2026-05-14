export type Mirror = 'none' | 'h' | 'v' | 'both';
export type ScrollMode = 'fixed' | 'timed' | 'voice';
export type Align = 'left' | 'center' | 'right';
export type FontFamily = 'sans' | 'serif' | 'mono' | 'system' | 'rounded';
export type ReadingGuide = 'chevron' | 'line' | 'none';

export type Settings = {
  // Scroll
  mode: ScrollMode;
  speed: number; // px per second (fixed mode)
  durationSec: number; // total duration (timed mode)
  // Display
  fontSize: number; // px
  lineHeight: number; // unitless
  fontFamily: FontFamily;
  textColor: string;
  bgColor: string;
  align: Align;
  readingGuide: ReadingGuide;
  edgeFade: boolean;
  // Mirror
  mirror: Mirror;
  // Recording
  cameraMirror: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  mode: 'fixed',
  speed: 60,
  durationSec: 120,
  fontSize: 56,
  lineHeight: 1.4,
  fontFamily: 'sans',
  textColor: '#ffffff',
  bgColor: '#000000',
  align: 'center',
  readingGuide: 'chevron',
  edgeFade: true,
  mirror: 'none',
  cameraMirror: true,
};

const KEY = 'tp.settings.v1';

export function loadSettings(): Settings {
  if (typeof localStorage === 'undefined') return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    // Migrate prior boolean readingGuide → string mode
    if (typeof parsed.readingGuide === 'boolean') {
      parsed.readingGuide = parsed.readingGuide ? 'line' : 'chevron';
    }
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: Settings) {
  localStorage.setItem(KEY, JSON.stringify(s));
}

export const FONT_STACKS: Record<FontFamily, string> = {
  sans: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  system: 'system-ui, sans-serif',
  rounded: '"SF Pro Rounded", "Nunito", ui-rounded, system-ui, sans-serif',
};

export function nextMirror(m: Mirror): Mirror {
  const order: Mirror[] = ['none', 'h', 'v', 'both'];
  return order[(order.indexOf(m) + 1) % order.length];
}

export function mirrorTransform(m: Mirror): string {
  switch (m) {
    case 'h':
      return 'scaleX(-1)';
    case 'v':
      return 'scaleY(-1)';
    case 'both':
      return 'scale(-1, -1)';
    default:
      return 'none';
  }
}

export function getModeWpm(
  settings: Pick<Settings, 'mode' | 'speed' | 'durationSec'>,
  wordCount: number
): number {
  if (settings.mode === 'timed') {
    if (wordCount <= 0 || settings.durationSec <= 0) return 0;
    return Math.round((wordCount / settings.durationSec) * 60);
  }
  return Math.round((settings.speed / 80) * 60);
}

export function durationFromWpm(wordCount: number, wpm: number): number {
  if (wordCount <= 0 || wpm <= 0) return 15;
  return Math.max(15, Math.round((wordCount / wpm) * 60));
}
