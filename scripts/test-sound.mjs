// Drives sound.js against a fake AudioContext that records what got scheduled.
// It cannot tell you whether the palette sounds good — it tells you the routing,
// the two independent mutes and the ambient loop seam are not broken.
//   node scripts/test-sound.mjs

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) pass++;
  else failures.push(`${name}${detail ? `\n    ${detail}` : ''}`);
}

// ------------------------------------------------------------- fake Web Audio

class Param {
  constructor(v = 0) {
    this.value = v;
  }
  setValueAtTime(v) {
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v) {
    this.value = v;
    return this;
  }
  exponentialRampToValueAtTime(v) {
    if (!(v > 0)) throw new Error('exponential ramp target must be > 0');
    this.value = v;
    return this;
  }
  setTargetAtTime(v) {
    this.value = v;
    return this;
  }
  cancelScheduledValues() {
    return this;
  }
}

let started = []; // every source node that actually got start()ed
const buffers = [];

class Node {
  connect(n) {
    return n;
  }
  disconnect() {}
}
class Source extends Node {
  constructor(kind) {
    super();
    this.kind = kind;
  }
  start() {
    started.push(this);
  }
  stop() {}
}

class FakeContext {
  constructor() {
    this.currentTime = 0;
    this.sampleRate = 44100;
    this.state = 'running';
    this.destination = new Node();
    this.buses = [];
  }
  createGain() {
    const g = new Node();
    g.gain = new Param(1);
    g.connect = (n) => {
      if (n === this.destination) this.buses.push(g);
      return n;
    };
    return g;
  }
  createBiquadFilter() {
    const f = new Node();
    f.frequency = new Param(350);
    f.Q = new Param(1);
    return f;
  }
  createOscillator() {
    const o = new Source('osc');
    o.frequency = new Param(440);
    return o;
  }
  createBufferSource() {
    const s = new Source('buffer');
    s.playbackRate = new Param(1);
    return s;
  }
  createBuffer(_ch, len) {
    const data = new Float32Array(len);
    buffers.push(data);
    return { length: len, getChannelData: () => data };
  }
  resume() {}
}

let lastContext = null;
class TrackedContext extends FakeContext {
  constructor() {
    super();
    lastContext = this;
  }
}

let visibilityHandler = null;
globalThis.window = { AudioContext: TrackedContext };
globalThis.document = {
  hidden: false,
  addEventListener: (type, fn) => {
    if (type === 'visibilitychange') visibilityHandler = fn;
  },
};

const { createSound } = await import('../src/js/sound.js');

const since = (fn) => {
  started = [];
  fn();
  return started.length;
};

// ---------------------------------------------------------------- effects

const EVENTS = ['move', 'pickup', 'capture', 'castle', 'check', 'promote', 'win', 'lose', 'draw', 'illegal', 'ui'];

{
  const s = createSound();
  s.unlock();
  for (const name of EVENTS) {
    check(`${name}() schedules audio`, typeof s[name] === 'function' && since(() => s[name]()) > 0);
  }
  // The brief: nothing is allowed to ignore the mute, not just moves.
  s.setEnabled(false);
  for (const name of EVENTS) {
    check(`${name}() is silent while muted`, since(() => s[name]()) === 0);
  }
  s.setEnabled(true);
  check('unmuting restores playback', since(() => s.move()) > 0);

  // Check has to move off the same pitch when it repeats.
  const pitches = new Set();
  const realOsc = FakeContext.prototype.createOscillator;
  FakeContext.prototype.createOscillator = function () {
    const o = realOsc.call(this);
    const set = o.frequency.setValueAtTime.bind(o.frequency);
    o.frequency.setValueAtTime = (v) => (pitches.add(Math.round(v)), set(v));
    return o;
  };
  for (let i = 0; i < 4; i++) s.check();
  FakeContext.prototype.createOscillator = realOsc;
  check('repeated checks do not reuse one pitch', pitches.size >= 4, `got ${pitches.size} distinct`);
}

// ------------------------------------------------------- the two mute paths

{
  const s = createSound();
  s.setEnabled(false); // effects off before the context ever existed
  s.unlock();
  const [sfxBus, ambBus] = ambBuses();
  check('ambience still starts while effects are muted', ambBus.gain.value > 0);
  check('muted effects bus sits at zero', sfxBus.gain.value === 0);

  s.setEnabled(true);
  check('effects bus opens independently of ambience', sfxBus.gain.value > 0);

  s.setAmbience(false);
  check('ambience mute closes only its own bus', ambBus.gain.value === 0 && sfxBus.gain.value > 0);
  check('effects still play with ambience muted', since(() => s.capture()) > 0);

  s.setAmbience(true);
  check('ambience can be brought back', ambBus.gain.value > 0);
  check('ambience sits well under the effects bus', ambBus.gain.value < sfxBus.gain.value * 0.3,
    `amb ${ambBus.gain.value} vs sfx ${sfxBus.gain.value}`);

  // A backgrounded tab fades out, and comes back when you return.
  document.hidden = true;
  visibilityHandler();
  check('a hidden tab does not cut out immediately', ambBus.gain.value > 0);
  document.hidden = false;
  visibilityHandler();
  check('returning to the tab keeps ambience up', ambBus.gain.value > 0);
}

function ambBuses() {
  // createSound connects the effects bus first, then the ambience bus.
  const ctxBuses = lastContext.buses;
  return [ctxBuses[0], ctxBuses[1]];
}

// ------------------------------------------------- the ambient loop is seamless

{
  const bed = buffers.find((b) => b.length > 44100); // the 6s noise buffer
  check('an ambient noise buffer was built', !!bed);
  if (bed) {
    let maxStep = 0;
    for (let i = 1; i < bed.length; i++) maxStep = Math.max(maxStep, Math.abs(bed[i] - bed[i - 1]));
    const seam = Math.abs(bed[0] - bed[bed.length - 1]);
    // If the loop point clicks, the wrap-around jump stands out against the
    // largest step found anywhere else in the buffer. It must not.
    check('the loop point has no step change', seam <= maxStep,
      `seam ${seam.toFixed(5)} vs largest internal step ${maxStep.toFixed(5)}`);
    check('the buffer is not silent', bed.some((v) => Math.abs(v) > 0.01));
  }
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('\n' + failures.map((f) => '  FAIL ' + f).join('\n'));
  process.exit(1);
}
