// src/utils/monoFonts.ts
// 잘 알려진 고정폭(monospace) 폰트 목록

const MONO_FONT_CANDIDATES = [
  'Consolas',
  'Courier New',
  'Lucida Console',
  'Monaco',
  'Menlo',
  'DejaVu Sans Mono',
  'Liberation Mono',
  'Ubuntu Mono',
  'Droid Sans Mono',
  'Source Code Pro',
  'Fira Code',
  'Fira Mono',
  'JetBrains Mono',
  'Cascadia Code',
  'Cascadia Mono',
  'IBM Plex Mono',
  'Hack',
  'Inconsolata',
  'Anonymous Pro',
  'PT Mono',
  'Noto Sans Mono',
  'Roboto Mono',
  'Space Mono',
  'Victor Mono',
  'D2Coding',
  'D2Coding ligature',
  'D2CodingBold',
  'NanumGothicCoding',
  'NanumGothic',
  'Malgun Gothic',
  'MS Gothic',
  'Nanum Gothic',
  'Bitstream Vera Sans Mono',
  'Input Mono',
  'Iosevka',
  'Fantasque Sans Mono',
  'Sarasa Mono K',
  'Sarasa Fixed K',
];

let cachedFonts: string[] | null = null;

export function clearFontCache() { cachedFonts = null; }

function isFontAvailable(fontName: string): boolean {
  const testStr = 'mmmmmmmmmmlli1234567890';
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  // 두 가지 기준 폰트와 비교 — 둘 중 하나라도 다르면 존재
  for (const base of ['monospace', 'serif', 'sans-serif']) {
    ctx.font = `72px ${base}`;
    const baseWidth = ctx.measureText(testStr).width;
    ctx.font = `72px "${fontName}", ${base}`;
    const testWidth = ctx.measureText(testStr).width;
    if (testWidth !== baseWidth) return true;
  }
  return false;
}

export function getAvailableMonoFonts(): string[] {
  if (cachedFonts) return cachedFonts;
  cachedFonts = MONO_FONT_CANDIDATES.filter(isFontAvailable);
  return cachedFonts;
}
