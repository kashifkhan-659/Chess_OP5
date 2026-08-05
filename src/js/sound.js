// Every sound is synthesised with the Web Audio API — nothing to download, cache
// or ship, and it all works offline. The palette is deliberately dark: filtered
// noise for the strike, a low pitched body for the weight, nothing bright or
// digital. The ambient bed is built from sustained oscillators plus one
// crossfaded noise loop, so there is no seam to click at.

const SFX_LEVEL = 0.55;
const AMB_LEVEL = 0.12; // ≈22% of the SFX bus
const BLUR_GRACE = 12000; // ms a hidden tab keeps playing before fading out

export function createSound() {
  let ctx = null;
  let sfxBus = null;
  let ambBus = null;
  let amb = null;
  let noiseBuf = null;
  let sfxOn = true;
  let ambOn = true;
  let blurTimer = 0;
  let checkTurn = 0;

  function audio() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      // Two independent buses so muting effects never touches the ambience.
      sfxBus = ctx.createGain();
      sfxBus.gain.value = sfxOn ? SFX_LEVEL : 0;
      sfxBus.connect(ctx.destination);
      ambBus = ctx.createGain();
      ambBus.gain.value = 0;
      ambBus.connect(ctx.destination);
    }
    // Browsers start the context suspended until the first user gesture.
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  /** Brownian noise — darker than white, so it reads as stone and air, not hiss. */
  function noise(c) {
    if (noiseBuf) return noiseBuf;
    const len = Math.floor(c.sampleRate * 6);
    const fade = Math.floor(c.sampleRate * 0.5);
    const raw = new Float32Array(len + fade);
    let last = 0;
    for (let i = 0; i < raw.length; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      raw[i] = last * 3.2;
    }
    noiseBuf = c.createBuffer(1, len, c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    d.set(raw.subarray(0, len));
    // Blend the overrun back over the head: the last sample now runs straight
    // into the first, so looping is continuous instead of stepping.
    for (let i = 0; i < fade; i++) {
      const k = i / fade;
      d[i] = raw[i] * k + raw[len + i] * (1 - k);
    }
    return noiseBuf;
  }

  /** A filtered noise burst — the strike itself. */
  function burst({ at = 0, dur = 0.06, peak = 0.4, freq = 500, q = 1 } = {}) {
    const c = ctx;
    const t0 = c.currentTime + at;
    const src = c.createBufferSource();
    src.buffer = noise(c);
    src.loop = true;
    src.playbackRate.value = 0.85 + Math.random() * 0.3;
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(sfxBus);
    // A random read offset keeps repeated hits from being bit-identical.
    src.start(t0, Math.random() * 4);
    src.stop(t0 + dur + 0.02);
  }

  /** A pitched resonant body — the weight behind the strike. */
  function tone(freq, { at = 0, dur = 0.4, peak = 0.1, type = 'triangle', glide = 0, attack = 0.01, lp = 1400 } = {}) {
    const c = ctx;
    const t0 = c.currentTime + at;
    const osc = c.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glide) osc.frequency.exponentialRampToValueAtTime(glide, t0 + dur);
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = lp;
    const g = c.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(f).connect(g).connect(sfxBus);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  /** Guard every effect in one place: silent context, silent call. */
  const play = (fn) => (opts) => {
    if (sfxOn && audio()) fn(opts || {});
  };

  // ------------------------------------------------------------- ambience

  function startAmbience() {
    const c = audio();
    if (!c || amb) return;

    const out = c.createGain();
    out.gain.value = 1;
    out.connect(ambBus);

    // The drone is continuous oscillators, so it has no loop point at all.
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 320;
    lp.Q.value = 0.8;
    lp.connect(out);

    const started = [];
    // Low root, a slightly detuned twin for slow beating, and a bare fifth —
    // an open interval reads as atmosphere rather than melody.
    for (const [freq, gain, type] of [
      [55, 0.5, 'sine'],
      [55.31, 0.42, 'sine'],
      [82.5, 0.16, 'triangle'],
      [110, 0.07, 'sine'],
    ]) {
      const o = c.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      const g = c.createGain();
      g.gain.value = gain;
      o.connect(g).connect(lp);
      o.start();
      started.push(o);
    }

    // Air: the crossfaded noise loop, filtered right down to a distant wash.
    const air = c.createBufferSource();
    air.buffer = noise(c);
    air.loop = true;
    const airFilter = c.createBiquadFilter();
    airFilter.type = 'lowpass';
    airFilter.frequency.value = 420;
    const airGain = c.createGain();
    airGain.gain.value = 0.5;
    air.connect(airFilter).connect(airGain).connect(out);
    air.start();
    started.push(air);

    // Two very slow LFOs so the bed breathes instead of sitting perfectly still.
    for (const [rate, depth, target] of [
      [0.05, 120, lp.frequency],
      [0.033, 0.22, airGain.gain],
    ]) {
      const o = c.createOscillator();
      o.frequency.value = rate;
      const g = c.createGain();
      g.gain.value = depth;
      o.connect(g).connect(target);
      o.start();
      started.push(o);
    }

    amb = { started };
    fadeAmbience(ambOn ? AMB_LEVEL : 0, 3);
  }

  function fadeAmbience(to, seconds) {
    if (!ctx) return;
    const t = ctx.currentTime;
    ambBus.gain.cancelScheduledValues(t);
    ambBus.gain.setValueAtTime(ambBus.gain.value, t);
    ambBus.gain.linearRampToValueAtTime(to, t + seconds);
  }

  // A tab left in the background for a while drops the bed; a quick alt-tab
  // does not, which would just make it flap.
  document.addEventListener('visibilitychange', () => {
    clearTimeout(blurTimer);
    if (document.hidden) blurTimer = setTimeout(() => fadeAmbience(0, 2), BLUR_GRACE);
    else if (amb && ambOn) fadeAmbience(AMB_LEVEL, 2);
  });

  return {
    get enabled() {
      return sfxOn;
    },
    get ambience() {
      return ambOn;
    },
    setEnabled(v) {
      sfxOn = !!v;
      if (ctx) sfxBus.gain.setTargetAtTime(sfxOn ? SFX_LEVEL : 0, ctx.currentTime, 0.02);
    },
    setAmbience(v) {
      ambOn = !!v;
      if (ambOn && ctx) startAmbience(); // before the first gesture unlock() does it
      fadeAmbience(ambOn ? AMB_LEVEL : 0, ambOn ? 1.5 : 0.6);
    },
    /** Call from the first user gesture, so the context is allowed to start. */
    unlock() {
      if (!audio()) return;
      if (ambOn) startAmbience();
    },

    // `soft` ducks the strike when a check or game-end sound is about to land,
    // so the two never fight for the same moment.
    move: play(({ soft }) => {
      const k = soft ? 0.5 : 1;
      const v = 0.94 + Math.random() * 0.12; // stops repeats sounding stamped out
      burst({ freq: 1500 * v, q: 2.4, dur: 0.022, peak: 0.1 * k });
      burst({ freq: 430 * v, q: 1.1, dur: 0.055, peak: 0.46 * k });
      tone(150 * v, { dur: 0.11, peak: 0.085 * k, glide: 92, lp: 700 });
    }),
    /** Lighter and airier than a move, and it rises rather than lands. */
    pickup: play(() => {
      burst({ freq: 1250, q: 2.6, dur: 0.028, peak: 0.1 });
      tone(320, { dur: 0.05, peak: 0.018, glide: 400, lp: 1800 });
    }),
    capture: play(({ soft }) => {
      const k = soft ? 0.55 : 1;
      burst({ freq: 2300, q: 0.9, dur: 0.055, peak: 0.34 * k }); // edge
      burst({ freq: 610, q: 0.7, dur: 0.14, peak: 0.6 * k }); // mass
      burst({ at: 0.05, freq: 1400, q: 1.6, dur: 0.05, peak: 0.16 * k }); // settle
      tone(110, { dur: 0.24, peak: 0.16 * k, glide: 55, lp: 600 });
    }),
    castle: play(({ soft }) => {
      const k = soft ? 0.5 : 1;
      burst({ freq: 430, q: 1.1, dur: 0.05, peak: 0.4 * k });
      tone(150, { dur: 0.1, peak: 0.07 * k, glide: 95, lp: 700 });
      burst({ at: 0.115, freq: 370, q: 1.1, dur: 0.06, peak: 0.44 * k });
      tone(128, { at: 0.115, dur: 0.12, peak: 0.08 * k, glide: 80, lp: 650 });
    }),
    /** Low resonant hit on an unresolved tritone. The root rotates so a run of
     *  checks never repeats the same pitch twice in a row. */
    check: play(() => {
      const roots = [146.83, 155.56, 138.59, 164.81];
      const f = roots[checkTurn++ % roots.length];
      burst({ freq: 260, q: 0.9, dur: 0.09, peak: 0.34 });
      tone(f / 2, { dur: 0.9, peak: 0.07, type: 'sine', lp: 400 });
      tone(f, { dur: 0.85, peak: 0.11, attack: 0.02, lp: 900 });
      tone(f * Math.SQRT2, { at: 0.015, dur: 0.7, peak: 0.055, attack: 0.03, lp: 800 });
    }),
    promote: play(({ soft }) => {
      burst({ freq: 520, q: 1.2, dur: 0.07, peak: (soft ? 0.18 : 0.3) });
      [82.41, 123.47, 164.81, 246.94].forEach((f, i) =>
        tone(f, { at: i * 0.075, dur: 0.9 - i * 0.1, peak: 0.075, attack: 0.04, lp: 1300 })
      );
    }),
    win: play(() => {
      burst({ freq: 300, q: 0.7, dur: 0.16, peak: 0.5 });
      tone(55, { dur: 1.7, peak: 0.17, type: 'sine', glide: 44, lp: 260 });
      [110, 164.81, 220].forEach((f, i) =>
        tone(f, { at: i * 0.1, dur: 1.6 - i * 0.15, peak: 0.085, attack: 0.02, lp: 1100 })
      );
    }),
    lose: play(() => {
      burst({ freq: 190, q: 0.6, dur: 0.22, peak: 0.5 });
      tone(55, { dur: 2, peak: 0.18, type: 'sine', glide: 32, lp: 220 });
      [110, 130.81, 155.56].forEach((f, i) =>
        tone(f, { at: i * 0.12, dur: 1.8 - i * 0.15, peak: 0.08, attack: 0.03, glide: f * 0.94, lp: 800 })
      );
    }),
    draw: play(() => {
      burst({ freq: 240, q: 0.7, dur: 0.12, peak: 0.34 });
      tone(98, { dur: 1.4, peak: 0.12, type: 'sine', lp: 500 });
      tone(130.81, { at: 0.06, dur: 1.3, peak: 0.075, attack: 0.03, lp: 900 });
    }),
    illegal: play(() => {
      burst({ freq: 175, q: 0.6, dur: 0.1, peak: 0.34 });
      tone(78, { dur: 0.16, peak: 0.1, type: 'sine', glide: 58, lp: 300 });
    }),
    /** Buttons and segmented controls — deliberately far quieter than the board. */
    ui: play(() => {
      burst({ freq: 1700, q: 3.2, dur: 0.018, peak: 0.085 });
      tone(230, { dur: 0.035, peak: 0.022, glide: 180, lp: 900 });
    }),
  };
}
