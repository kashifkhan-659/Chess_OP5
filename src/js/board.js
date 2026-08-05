import { colorOf, pieceLabel, pieceSVG } from './pieces.js';

const FILES = 'abcdefgh';

/**
 * Renders the board and turns pointer gestures into move intents.
 * It owns no chess rules — it asks `onPickup(square)` for legal targets and
 * reports completed gestures through `onMove(from, to)`.
 */
export class Board {
  #onPointerMove = (ev) => this.#pointerMove(ev);
  #onPointerUp = (ev) => this.#pointerUp(ev);

  constructor(root, { onMove, onPickup } = {}) {
    this.root = root;
    this.squaresEl = root.querySelector('.squares');
    this.markersEl = root.querySelector('.markers');
    this.piecesEl = root.querySelector('.pieces');
    this.coordsEl = root.querySelector('.coords');
    this.onMove = onMove || (() => {});
    this.onPickup = onPickup || (() => []);

    this.flipped = false;
    this.piecesBySq = new Map(); // square -> { el, piece }
    this.selected = -1;
    this.targets = [];
    this.lastMove = null;
    this.checkSq = -1;
    this.interactive = true;
    this.drag = null;

    this.#buildSquares();
    this.#buildCoords();
    root.addEventListener('pointerdown', (ev) => this.#pointerDown(ev));
    root.addEventListener('contextmenu', (ev) => {
      if (this.selected >= 0) {
        ev.preventDefault();
        this.clearSelection();
      }
    });
  }

  // Rotating the board 180 degrees leaves the light/dark pattern unchanged,
  // so squares are built once and only the coordinates are relabelled.
  #buildSquares() {
    const frag = document.createDocumentFragment();
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const d = document.createElement('div');
        d.className = `sq ${(row + col) % 2 === 0 ? 'light' : 'dark'}`;
        frag.appendChild(d);
      }
    }
    this.squaresEl.replaceChildren(frag);
  }

  #buildCoords() {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 8; i++) {
      const f = document.createElement('span');
      f.className = 'coord file';
      f.style.setProperty('--c', i);
      f.textContent = this.flipped ? FILES[7 - i] : FILES[i];
      const r = document.createElement('span');
      r.className = 'coord rank';
      r.style.setProperty('--r', i);
      r.textContent = this.flipped ? i + 1 : 8 - i;
      frag.append(f, r);
    }
    this.coordsEl.replaceChildren(frag);
  }

  /** Board square (a1 = 0) -> visual [row, col], row 0 being the top. */
  #cell(sq) {
    const file = sq & 7;
    const rank = sq >> 3;
    return this.flipped ? [rank, 7 - file] : [7 - rank, file];
  }

  squareFromEvent(ev) {
    const rect = this.root.getBoundingClientRect();
    const col = Math.floor(((ev.clientX - rect.left) / rect.width) * 8);
    const row = Math.floor(((ev.clientY - rect.top) / rect.height) * 8);
    if (col < 0 || col > 7 || row < 0 || row > 7) return -1;
    return this.flipped ? row * 8 + (7 - col) : (7 - row) * 8 + col;
  }

  #place(el, sq, animate = true, settle = true) {
    const [row, col] = this.#cell(sq);
    if (!animate) {
      el.classList.add('no-anim');
      void el.offsetWidth; // flush the class before the transform changes
    } else {
      // Weight: a queen crossing the board takes longer than a pawn stepping
      // one square, but the range stays tight enough to never feel sluggish.
      const dist = Math.max(
        Math.abs(row - (Number(el.style.getPropertyValue('--r')) || 0)),
        Math.abs(col - (Number(el.style.getPropertyValue('--c')) || 0))
      );
      el.style.setProperty('--dur', `${180 + dist * 20}ms`);
      if (dist && settle) this.#settle(el);
    }
    el.style.setProperty('--r', row);
    el.style.setProperty('--c', col);
    if (!animate) requestAnimationFrame(() => el.classList.remove('no-anim'));
  }

  /** Plays the landing squash once the slide finishes. */
  #settle(el) {
    el.addEventListener(
      'transitionend',
      () => {
        el.classList.add('land');
        setTimeout(() => el.classList.remove('land'), 130);
      },
      { once: true } // `transform` is the only transitioned property on .piece
    );
  }

  #create(ch, sq) {
    const el = document.createElement('div');
    el.className = `piece ${colorOf(ch)} appear`;
    el.innerHTML = pieceSVG(ch);
    el.setAttribute('aria-label', pieceLabel(ch));
    this.#place(el, sq, false);
    this.piecesEl.appendChild(el);
    requestAnimationFrame(() => el.classList.remove('appear'));
    return { el, piece: ch };
  }

  setOrientation(flipped) {
    if (this.flipped === flipped) return;
    this.flipped = flipped;
    this.#buildCoords();
    // Re-placing every piece makes the flip a single smooth transition — same
    // easing as a move, but no landing squash: 32 of them at once is noise.
    for (const [sq, rec] of this.piecesBySq) this.#place(rec.el, sq, true, false);
    this.#renderMarkers();
  }

  setInteractive(on) {
    this.interactive = on;
    this.root.classList.toggle('locked', !on);
    if (!on) this.clearSelection();
  }

  /**
   * Reconciles the DOM against a board string (64 chars, a1 first, '.' empty).
   * Elements are reused wherever possible so CSS transitions do the animating.
   * @param hint {from,to,promo} lets a promotion slide instead of popping in.
   */
  render(board, { hint = null, animate = true } = {}) {
    if (hint?.promo) {
      const rec = this.piecesBySq.get(hint.from);
      if (rec) {
        const ch = colorOf(rec.piece) === 'w' ? hint.promo.toUpperCase() : hint.promo.toLowerCase();
        rec.piece = ch;
        rec.el.innerHTML = pieceSVG(ch);
        rec.el.setAttribute('aria-label', pieceLabel(ch));
      }
    }

    const want = new Map();
    for (let sq = 0; sq < 64; sq++) if (board[sq] !== '.') want.set(sq, board[sq]);

    const next = new Map();
    const spare = [];
    for (const [sq, rec] of this.piecesBySq) {
      if (want.get(sq) === rec.piece) {
        next.set(sq, rec);
        want.delete(sq);
      } else {
        spare.push({ sq, rec });
      }
    }

    for (const [sq, ch] of want) {
      let pick = -1;
      // Prefer the piece the hint says actually moved; otherwise the nearest
      // identical piece, which keeps undo and flip animations sensible.
      if (hint && sq === hint.to) {
        pick = spare.findIndex((s) => s.sq === hint.from && s.rec.piece === ch);
      }
      if (pick < 0) {
        let bestDist = Infinity;
        spare.forEach((s, i) => {
          if (s.rec.piece !== ch) return;
          const d = (((s.sq & 7) - (sq & 7)) ** 2) + (((s.sq >> 3) - (sq >> 3)) ** 2);
          if (d < bestDist) {
            bestDist = d;
            pick = i;
          }
        });
      }
      if (pick >= 0) {
        const { rec } = spare.splice(pick, 1)[0];
        this.#place(rec.el, sq, animate);
        next.set(sq, rec);
      } else {
        next.set(sq, this.#create(ch, sq));
      }
    }

    for (const { rec } of spare) {
      rec.el.classList.add('gone');
      const el = rec.el;
      setTimeout(() => el.remove(), 260);
    }
    this.piecesBySq = next;
  }

  setLastMove(move) {
    this.lastMove = move;
    this.#renderMarkers();
  }

  setCheck(sq) {
    this.checkSq = sq ?? -1;
    this.#renderMarkers();
  }

  select(sq, targets) {
    this.#lift(false);
    this.selected = sq;
    this.targets = targets;
    this.#lift(true);
    this.#renderMarkers();
  }

  clearSelection() {
    if (this.selected < 0 && this.targets.length === 0) return;
    this.#lift(false);
    this.selected = -1;
    this.targets = [];
    this.#renderMarkers();
  }

  /** Visually raises the selected piece off the board. */
  #lift(on) {
    this.piecesBySq.get(this.selected)?.el.classList.toggle('lifted', on);
  }

  /** 'w' | 'b' | '' — the faction that owns the piece standing on `sq`. */
  #sideAt(sq) {
    const rec = this.piecesBySq.get(sq);
    return rec ? colorOf(rec.piece) : '';
  }

  #marker(sq, className) {
    const [row, col] = this.#cell(sq);
    const d = document.createElement('div');
    d.className = `marker ${className}`;
    d.style.setProperty('--r', row);
    d.style.setProperty('--c', col);
    return d;
  }

  #renderMarkers() {
    const frag = document.createDocumentFragment();
    if (this.lastMove) {
      // The mover is whoever now stands on the destination square.
      const side = this.#sideAt(this.lastMove.to);
      frag.appendChild(this.#marker(this.lastMove.from, `last ${side}`));
      frag.appendChild(this.#marker(this.lastMove.to, `last ${side}`));
    }
    if (this.checkSq >= 0) frag.appendChild(this.#marker(this.checkSq, 'check'));
    const side = this.#sideAt(this.selected);
    if (this.selected >= 0) frag.appendChild(this.#marker(this.selected, `selected ${side}`));
    for (const t of this.targets) {
      frag.appendChild(this.#marker(t.to, `${t.capture ? 'target-capture' : 'target'} ${side}`));
    }
    this.markersEl.replaceChildren(frag);
  }

  // ------------------------------------------------------------- pointer

  #pointerDown(ev) {
    if (!this.interactive || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
    const sq = this.squareFromEvent(ev);
    if (sq < 0) return;

    // Click-to-move: a second click on a highlighted square completes it.
    if (this.selected >= 0 && this.targets.some((t) => t.to === sq)) {
      ev.preventDefault();
      const from = this.selected;
      this.clearSelection();
      this.onMove(from, sq);
      return;
    }

    const rec = this.piecesBySq.get(sq);
    const targets = rec ? this.onPickup(sq) : [];
    if (!rec || targets.length === 0) {
      this.clearSelection();
      return;
    }

    ev.preventDefault();
    const prevSelected = this.selected;
    this.select(sq, targets);

    this.drag = {
      sq,
      rec,
      prevSelected,
      pointerId: ev.pointerId,
      startX: ev.clientX,
      startY: ev.clientY,
      rect: this.root.getBoundingClientRect(),
      moved: false,
    };
    try {
      this.root.setPointerCapture(ev.pointerId);
    } catch {
      /* capture is best-effort */
    }
    this.root.addEventListener('pointermove', this.#onPointerMove);
    this.root.addEventListener('pointerup', this.#onPointerUp);
    this.root.addEventListener('pointercancel', this.#onPointerUp);
  }

  #pointerMove(ev) {
    const d = this.drag;
    if (!d || ev.pointerId !== d.pointerId) return;
    const dx = ev.clientX - d.startX;
    const dy = ev.clientY - d.startY;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 5) return;
      d.moved = true;
      d.rec.el.classList.add('dragging');
    }
    const size = d.rect.width / 8;
    d.rec.el.style.setProperty('--dx', `${ev.clientX - d.rect.left - size / 2}px`);
    d.rec.el.style.setProperty('--dy', `${ev.clientY - d.rect.top - size / 2}px`);
  }

  #pointerUp(ev) {
    const d = this.drag;
    if (!d || ev.pointerId !== d.pointerId) return;
    this.drag = null;
    this.root.removeEventListener('pointermove', this.#onPointerMove);
    this.root.removeEventListener('pointerup', this.#onPointerUp);
    this.root.removeEventListener('pointercancel', this.#onPointerUp);
    try {
      this.root.releasePointerCapture(d.pointerId);
    } catch {
      /* already released */
    }

    d.rec.el.classList.remove('dragging');
    d.rec.el.style.removeProperty('--dx');
    d.rec.el.style.removeProperty('--dy');

    if (!d.moved) {
      // A plain click on an already-selected piece deselects it.
      if (d.prevSelected === d.sq) this.clearSelection();
      return;
    }

    const to = this.squareFromEvent(ev);
    if (this.targets.some((t) => t.to === to)) {
      // Drop it exactly where the pointer let go, then let render() reconcile.
      this.#place(d.rec.el, to, false);
      this.clearSelection();
      this.onMove(d.sq, to);
    } else {
      this.#place(d.rec.el, d.sq, true); // snap home
    }
  }
}
