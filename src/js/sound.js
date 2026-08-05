// Synthesised with the Web Audio API — no audio files to ship, load or cache.
export function createSound() {
  let ctx = null;
  let master = null;
  let enabled = true;

  function audio() {
    if (!enabled) return null;
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.55;
      master.connect(ctx.destination);
    }
    // Browsers start the context suspended until the first user gesture.
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(freq, { at = 0, dur = 0.12, type = 'triangle', peak = 0.16, glideTo = 0 } = {}) {
    const c = audio();
    if (!c) return;
    const t0 = c.currentTime + at;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.04);
  }

  // A short band-passed noise burst reads as wood on wood.
  function knock({ at = 0, dur = 0.06, peak = 0.4, freq = 900, q = 1.2 } = {}) {
    const c = audio();
    if (!c) return;
    const t0 = c.currentTime + at;
    const len = Math.max(1, Math.ceil(c.sampleRate * dur));
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const decay = (1 - i / len) ** 2;
      data[i] = (Math.random() * 2 - 1) * decay;
    }
    const src = c.createBufferSource();
    src.buffer = buf;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = q;
    const g = c.createGain();
    g.gain.value = peak;
    src.connect(bp).connect(g).connect(master);
    src.start(t0);
  }

  return {
    get enabled() {
      return enabled;
    },
    setEnabled(v) {
      enabled = !!v;
      if (enabled) audio();
    },
    /** Call from a click handler so the context is allowed to start. */
    unlock() {
      audio();
    },
    move() {
      knock({ freq: 950, peak: 0.32, dur: 0.05 });
      tone(190, { dur: 0.07, peak: 0.05 });
    },
    capture() {
      knock({ freq: 480, peak: 0.5, dur: 0.09, q: 0.8 });
      tone(120, { dur: 0.14, peak: 0.1, type: 'sawtooth', glideTo: 70 });
    },
    castle() {
      knock({ freq: 900, peak: 0.28, dur: 0.05 });
      knock({ at: 0.1, freq: 780, peak: 0.32, dur: 0.06 });
    },
    check() {
      tone(740, { dur: 0.1, peak: 0.13, type: 'triangle' });
      tone(1108, { at: 0.09, dur: 0.16, peak: 0.11, type: 'triangle' });
    },
    promote() {
      [523, 659, 784, 1046].forEach((f, i) =>
        tone(f, { at: i * 0.07, dur: 0.16, peak: 0.1, type: 'triangle' })
      );
    },
    win() {
      [523, 659, 784].forEach((f, i) => tone(f, { at: i * 0.1, dur: 0.5, peak: 0.11 }));
    },
    lose() {
      [440, 349, 262].forEach((f, i) => tone(f, { at: i * 0.13, dur: 0.55, peak: 0.11 }));
    },
    draw() {
      [440, 466].forEach((f, i) => tone(f, { at: i * 0.14, dur: 0.5, peak: 0.09 }));
    },
    illegal() {
      tone(150, { dur: 0.09, peak: 0.07, type: 'square' });
    },
  };
}
