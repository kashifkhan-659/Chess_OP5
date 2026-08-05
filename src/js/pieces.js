// Hand-built Staunton-profile piece set. Everything is drawn on a 45x45 grid
// and mirrored about x=22.5, so the silhouettes stay symmetric at any size.
// Colours come from CSS (fill/stroke are inherited), so theming is free.

const FOOT = '<rect x="11.6" y="37" width="21.8" height="3.6" rx="1.6"/>';
const FOOT_WIDE = '<rect x="10.2" y="37" width="24.6" height="3.6" rx="1.6"/>';
const FLARE =
  '<path d="M15.2 37.2C15.2 33.8 17.6 32.6 18.4 30.4L26.6 30.4C27.4 32.6 29.8 33.8 29.8 37.2Z"/>';
const FLARE_WIDE =
  '<path d="M13.6 37.2C13.6 33.8 15.6 32.4 16.4 30.4L28.6 30.4C29.4 32.4 31.4 33.8 31.4 37.2Z"/>';

const BODIES = {
  p: `<circle cx="22.5" cy="12.6" r="4.9"/>
      <path d="M20 17.2C20 21.5 17.6 24 16.2 27.4L28.8 27.4C27.4 24 25 21.5 25 17.2Z"/>
      <rect x="15" y="27.2" width="15" height="3.2" rx="1.4"/>
      ${FLARE}${FOOT}`,

  r: `<path d="M12.6 8.4h4.6v3.2h3.4V8.4h3.8v3.2h3.4V8.4h4.6v6.6H12.6Z"/>
      <path d="M15 15v1.4C15 20.4 16.6 24 16.6 28L28.4 28C28.4 24 30 20.4 30 16.4V15Z"/>
      <rect x="14.6" y="27.4" width="15.8" height="3.2" rx="1.4"/>
      ${FLARE}${FOOT}`,

  n: `<path d="M10.6 18.6C12.4 14.6 15.2 11.4 17.4 9C17 7.2 17.6 5.2 18.6 4.4C19.6 5.4 20 7 20.2 8.4
             C21.4 6.6 22.8 5.4 24.2 5C25 7 24.8 9 24.4 10.4C27.4 13 29.6 16.6 30 21.4
             C30.4 25 30 27.2 29.6 29.6L15.4 29.6C15 26.4 15.6 24 16.6 22
             C15 22.6 13.4 22.4 12.4 21.6C11.6 21 10.8 20 10.6 18.6Z"/>
      <circle class="eye" cx="16.9" cy="13.5" r="1.15"/>
      <path class="detail" d="M21.6 10.6C24.2 13.4 25.8 17.4 26 21.6"/>
      <rect x="14.6" y="28.6" width="15.8" height="2.8" rx="1.2"/>
      ${FLARE}${FOOT}`,

  b: `<circle cx="22.5" cy="7" r="2.1"/>
      <path d="M22.5 9.4C26.9 11.9 28.6 16.3 28.6 19.6C28.6 23.4 25.8 25.8 22.5 25.8
             C19.2 25.8 16.4 23.4 16.4 19.6C16.4 16.3 18.1 11.9 22.5 9.4Z"/>
      <path class="detail" d="M19.4 17.9L26 12.1"/>
      <rect x="15.6" y="25.4" width="13.8" height="3" rx="1.3"/>
      <rect x="18.8" y="28.2" width="7.4" height="2.4" rx="0.8"/>
      ${FLARE}${FOOT}`,

  q: `<circle cx="22.5" cy="5.6" r="2.4"/>
      <circle cx="16" cy="7" r="2.1"/><circle cx="29" cy="7" r="2.1"/>
      <circle cx="9.6" cy="10.4" r="2.1"/><circle cx="35.4" cy="10.4" r="2.1"/>
      <path d="M9.6 12.4L12.4 24.4L32.6 24.4L35.4 12.4L30.6 20.2L29 9L25.4 20.2L22.5 7.8
             L19.6 20.2L16 9L14.4 20.2Z"/>
      <rect x="11.8" y="24.2" width="21.4" height="3.4" rx="1.5"/>
      <rect x="13.2" y="28" width="18.6" height="2.6" rx="1.2"/>
      ${FLARE_WIDE}${FOOT_WIDE}`,

  k: `<path d="M21.2 3.4h2.6V6.2h2.8v2.6h-2.8v3h-2.6v-3h-2.8V6.2h2.8Z"/>
      <path d="M22.5 11.8C27 11.8 31 14.8 31 18.6C31 22 28.4 24.4 27.4 26.6L17.6 26.6
             C16.6 24.4 14 22 14 18.6C14 14.8 18 11.8 22.5 11.8Z"/>
      <path class="detail" d="M18.2 20.4C20.6 18.8 24.4 18.8 26.8 20.4"/>
      <rect x="12.6" y="26.4" width="19.8" height="4" rx="1.6"/>
      ${FLARE_WIDE}${FOOT_WIDE}`,
};

const cache = new Map();

/** @param {string} ch a FEN piece letter — uppercase is White. */
export function pieceSVG(ch) {
  if (cache.has(ch)) return cache.get(ch);
  const body = BODIES[ch.toLowerCase()];
  if (!body) return '';
  const svg =
    `<svg viewBox="0 0 45 45" aria-hidden="true" focusable="false">` +
    `<g stroke-linejoin="round" stroke-linecap="round">${body}</g></svg>`;
  cache.set(ch, svg);
  return svg;
}

export const colorOf = (ch) => (ch === ch.toUpperCase() ? 'w' : 'b');

export const PIECE_NAMES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

export function pieceLabel(ch) {
  return `${colorOf(ch) === 'w' ? 'White' : 'Black'} ${PIECE_NAMES[ch.toLowerCase()]}`;
}
