/*
 * engine-dsp.js — procedural combustion-engine synthesizer.
 *
 * This file is loaded twice:
 *   1. as an AudioWorklet module, where it registers "engine-processor";
 *   2. as a classic <script> on the page, where it exposes window.EngineDSP
 *      for the ScriptProcessorNode fallback used by older browsers.
 * It therefore must not use import/export and must not touch the DOM.
 *
 * Model (per sample):
 *   crank phase (one 4-stroke cycle = 720°) → firing events from the car's
 *   firing order → each firing drops an exhaust pressure pulse (smooth pulse +
 *   decaying noise burst) into its bank's exhaust → per-bank pipe waveguide
 *   (feedback comb with lossy reflection) → exhaust formants → stereo mix →
 *   intake roar, supercharger whine and afterfire pops → muffler low-pass →
 *   soft saturation. Manual gearboxes add a gear-lever click on top (a "click"
 *   message from the page).
 *
 * Driven by four smoothed parameters sent from the page:
 *   rpm, load (0..1 combustion strength), overrun (0..1 closed-throttle
 *   coasting at elevated rpm) and cut (1 while ignition is cut: rev limiter
 *   or full-throttle upshift), plus the user's "character" and "crackle"
 *   settings. Crackle scales the afterfire pops and the lumpy-cam misfires:
 *   0 is a clean-burning engine, 1 is the car's full tuning.
 *
 * Electric cars (engine.type 'electric') get ElectricDSP instead, a motor
 * buzz driven by the same messages; a car with cold-gas thrusters
 * (engine.type 'thruster') gets ThrusterDSP, air jets fired by the pedal.
 * EngineDSP.create picks the right one.
 */
var EngineDSP = (function () {
  'use strict';

  var TWO_PI = Math.PI * 2;
  var BLOCK = 128;
  var MAX_PULSES = 8;

  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep(x) { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); }
  function onePole(sr, seconds) { return 1 - Math.exp(-1 / (sr * seconds)); }

  // Rational tanh approximation, accurate enough for a saturator.
  function softClip(x) {
    if (x > 3) return 1;
    if (x < -3) return -1;
    var x2 = x * x;
    return x * (27 + x2) / (27 + 9 * x2);
  }

  var HANN_SIZE = 1024;
  var HANN = new Float32Array(HANN_SIZE + 1);
  for (var h = 0; h <= HANN_SIZE; h++) HANN[h] = 0.5 - 0.5 * Math.cos(TWO_PI * h / HANN_SIZE);

  // xorshift32 — deterministic, allocation free.
  function Rng(seed) { this.s = (seed >>> 0) || 0x9e3779b9; }
  Rng.prototype.next = function () {
    var x = this.s;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.s = x >>> 0;
    return this.s / 4294967296;
  };
  Rng.prototype.white = function () { return this.next() * 2 - 1; };
  // Approximately standard normal (Irwin–Hall with 4 terms).
  Rng.prototype.gauss = function () {
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.7320508;
  };

  // RBJ biquad, transposed direct form II.
  function Biquad() {
    this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0;
    this.z1 = 0; this.z2 = 0;
  }
  Biquad.prototype.set = function (type, freq, q, gainDb, sr) {
    var w = TWO_PI * clamp(freq, 10, sr * 0.45) / sr;
    var cw = Math.cos(w), sw = Math.sin(w);
    var alpha = sw / (2 * q);
    var A = Math.pow(10, (gainDb || 0) / 40);
    var b0, b1, b2, a0, a1, a2;
    if (type === 'lowpass') {
      b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
    } else if (type === 'highpass') {
      b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
    } else if (type === 'bandpass') {
      b0 = alpha; b1 = 0; b2 = -alpha;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
    } else { // peaking
      b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = a1 / a0; this.a2 = a2 / a0;
  };
  Biquad.prototype.process = function (x) {
    var y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  };

  // One cylinder bank: pulse pool → exhaust pipe → formants.
  function Bank(sr, bankCfg, sound) {
    this.age = new Float32Array(MAX_PULSES);
    this.len = new Float32Array(MAX_PULSES);
    this.amp = new Float32Array(MAX_PULSES);
    this.noise = new Float32Array(MAX_PULSES);
    this.decay = new Float32Array(MAX_PULSES);
    this.slot = 0;

    this.pipeD = Math.max(2, Math.round(bankCfg.pipeMs * sr / 1000));
    var size = 1;
    while (size <= this.pipeD + 2) size <<= 1;
    this.pipe = new Float32Array(size);
    this.mask = size - 1;
    this.w = 0;
    this.pipeLp = 0;
    this.refl = sound.pipeReflection;
    this.damp = sound.pipeDamping;

    this.formants = [];
    for (var i = 0; i < sound.formants.length; i++) {
      var f = sound.formants[i];
      var bq = new Biquad();
      bq.set('bandpass', f.hz * (bankCfg.tune || 1), f.q, 0, sr);
      this.formants.push({ bq: bq, gain: f.gain });
    }
    this.dry = sound.formantDry;
    this.panL = Math.sqrt(0.5 * (1 - bankCfg.pan));
    this.panR = Math.sqrt(0.5 * (1 + bankCfg.pan));
    this.exc = 0;
  }
  Bank.prototype.add = function (lenSamples, amp, noiseAmp, noiseDecay) {
    var k = this.slot;
    this.slot = (k + 1) % MAX_PULSES;
    this.age[k] = 0;
    this.len[k] = Math.max(4, lenSamples);
    this.amp[k] = amp;
    this.noise[k] = noiseAmp;
    this.decay[k] = noiseDecay;
  };
  Bank.prototype.tick = function (rng) {
    var exc = 0;
    var age = this.age, len = this.len, amp = this.amp, noise = this.noise;
    for (var k = 0; k < MAX_PULSES; k++) {
      var l = len[k];
      if (l === 0) continue;
      var a = age[k];
      if (a < l) exc += amp[k] * HANN[(a / l * HANN_SIZE) | 0];
      var n = noise[k];
      if (n > 1e-4) {
        exc += n * rng.white();
        noise[k] = n * this.decay[k];
      }
      age[k] = a + 1;
      if (a + 1 >= l && n <= 1e-4) len[k] = 0;
    }
    this.exc = exc;

    // Pipe: feedback comb with a lossy (low-passed), inverting open-end reflection.
    var fb = this.pipe[(this.w - this.pipeD) & this.mask];
    this.pipeLp += this.damp * (fb - this.pipeLp);
    var y = exc + this.refl * this.pipeLp;
    this.pipe[this.w] = y;
    this.w = (this.w + 1) & this.mask;

    var out = y * this.dry;
    for (var i = 0; i < this.formants.length; i++) {
      var f = this.formants[i];
      out += f.bq.process(y) * f.gain;
    }
    return out;
  };

  // Gear lever going into a gear (manual gearbox): a very short, bright tick,
  // mostly above 4 kHz: a high-passed noise snap with a touch of
  // metallic ring. [Hz, decay seconds, gain]
  var CLICK_MODES = [[4800, 0.0015, 0.3], [7600, 0.0012, 0.25]];

  function GearClick(sr, gain) {
    this.gain = gain;
    this.modes = [];
    for (var i = 0; i < CLICK_MODES.length; i++) {
      var m = CLICK_MODES[i], w = TWO_PI * m[0] / sr, r = Math.exp(-1 / (sr * m[1]));
      if (m[0] > sr * 0.45) continue;    // above what this sample rate can play
      this.modes.push({ c1: 2 * r * Math.cos(w), c2: -r * r, sw: Math.sin(w), g: m[2], kick: 0, y1: 0, y2: 0 });
    }
    this.snap = 0;
    this.snapDecay = Math.exp(-1 / (sr * 0.0015));
    this.hpK = 1 - Math.exp(-TWO_PI * 2500 / sr);   // two one-pole high-pass stages
    this.lp1 = 0; this.lp2 = 0;
    this.left = 0;                     // samples until the ringing has died away
    this.tail = Math.round(sr * 0.04);
  }
  // strength: 1 into a gear, about 0.6 into neutral.
  GearClick.prototype.trigger = function (strength, rng) {
    if (!this.gain) return;
    var a = strength * this.gain;
    for (var i = 0; i < this.modes.length; i++) {
      var m = this.modes[i];
      m.kick = a * m.g * (0.85 + 0.3 * rng.next());
    }
    this.snap = a;
    this.left = this.tail;
  };
  GearClick.prototype.next = function (rng) {
    if (this.left <= 0) return 0;
    this.left--;
    var w = this.snap * rng.white();
    this.snap *= this.snapDecay;
    this.lp1 += this.hpK * (w - this.lp1);
    var h = w - this.lp1;
    this.lp2 += this.hpK * (h - this.lp2);
    var out = h - this.lp2;
    for (var i = 0; i < this.modes.length; i++) {
      var m = this.modes[i];
      var y = m.c1 * m.y1 + m.c2 * m.y2 + m.kick * m.sw;
      m.kick = 0;
      m.y2 = m.y1; m.y1 = y;
      out += y;
    }
    return out;
  };

  /*
   * Haunted car (engine.type 'haunted'): no engine sound at all, only
   * Halloween sounds. A heartbeat at a standstill that races when the
   * accelerator (or REV) is pressed, cold wind that grows and whistles higher
   * with speed, a ghost choir whose higher voices join as the car speeds up,
   * a moan sliding down on lift-off, a distant church bell when the car comes
   * to a stop, a monster growl at full throttle and a scream on REV, all with
   * a reverb of their own. Nothing rises and falls like a siren: the choir holds one
   * chord and the moan only slides down. The drivetrain is still simulated
   * (for the tach and how the car pulls), but its gears aren't heard.
   */

  // The choir's chord on sound.rootHz: a low drone, then a minor chord with
  // a tritone, climbing an octave. [pitch ratio, pace where the voice comes
  // in (0..1 of 180 km/h), pan]
  var CHOIR = [[0.5, 0, 0], [1, 0, -0.3], [1.1892, 0.1, 0.35], [1.4142, 0.25, -0.5], [2, 0.4, 0.5], [2.3784, 0.55, -0.2]];
  // Church bell partials on sound.rootHz, [pitch ratio, gain, decay seconds]:
  // the hum on the root, the strike note an octave up with its minor-third
  // tierce, quint and nominal, and the bright partials that make it clang
  // (without them it is a dull bong that the heartbeat and wind cover).
  var BELL = [[1, 0.5, 5.5], [2, 0.55, 3.8], [2.4, 0.45, 3.2], [3, 0.22, 2.2], [4, 0.4, 2.6],
    [5, 0.18, 1.6], [5.32, 0.14, 1.3], [6, 0.1, 1.1], [8.14, 0.07, 0.8], [10.9, 0.05, 0.5], [13.6, 0.035, 0.35]];
  // It tolls BELL_TOLLS times, BELL_GAP_S apart.
  var BELL_TOLLS = 3, BELL_GAP_S = 2.4;
  // Vowel formants, [Hz, Q, gain]: a closed "oo" and an open "ah".
  var VOWEL_OO = [[320, 5, 1], [800, 8, 0.5], [2500, 12, 0.2]];
  var VOWEL_AH = [[700, 5, 1], [1150, 8, 0.6], [2600, 12, 0.25]];
  // A shriek's vowels, wide open for a voice pitched about 1 kHz: "eh" and "aah".
  var SHRIEK_EH = [[650, 3, 0.8], [1900, 5, 0.9], [2900, 7, 0.5]];
  var SHRIEK_AH = [[1000, 3, 1], [1550, 4, 0.8], [3000, 6, 0.5]];
  var MOAN_S = 2.6;
  // A scream lasts at least SCREAM_MIN_S (a quick tap of REV), at most
  // SCREAM_MAX_S (out of breath), then dies away over SCREAM_FADE_S.
  var SCREAM_MIN_S = 1.1, SCREAM_MAX_S = 2.6, SCREAM_FADE_S = 0.5;

  // A voice's vowel: three band-passes in parallel, moving from one vowel to
  // another (by default open: 0 "oo" .. 1 "ah").
  function Vowel(closed, open) {
    this.from = closed || VOWEL_OO;
    this.to = open || VOWEL_AH;
    this.bq = [new Biquad(), new Biquad(), new Biquad()];
    this.g = [0, 0, 0];
  }
  Vowel.prototype.set = function (open, sr) {
    for (var k = 0; k < 3; k++) {
      var a = this.from[k], b = this.to[k];
      this.bq[k].set('bandpass', lerp(a[0], b[0], open), lerp(a[1], b[1], open), 0, sr);
      this.g[k] = lerp(a[2], b[2], open);
    }
  };
  Vowel.prototype.process = function (x) {
    return this.bq[0].process(x) * this.g[0] + this.bq[1].process(x) * this.g[1] + this.bq[2].process(x) * this.g[2];
  };

  // Small stereo reverb (Schroeder/Freeverb style): four damped feedback
  // combs into two all-passes per side, about two seconds long.
  function Reverb(sr) {
    var s = sr / 44100;
    function line(n) { return { buf: new Float32Array(Math.round(n * s)), pos: 0, lp: 0 }; }
    this.cL = [1116, 1188, 1277, 1356].map(line);
    this.cR = [1139, 1211, 1300, 1379].map(line);
    this.aL = [556, 441].map(line);
    this.aR = [579, 464].map(line);
    this.l = this.r = 0;
  }
  function reverbSide(x, combs, aps) {
    var out = 0, k, d, y;
    for (k = 0; k < 4; k++) {
      d = combs[k]; y = d.buf[d.pos];
      d.lp += 0.7 * (y - d.lp);              // damping: the tail darkens as it dies away
      d.buf[d.pos] = x + d.lp * 0.82;
      if (++d.pos === d.buf.length) d.pos = 0;
      out += y;
    }
    out *= 0.25;
    for (k = 0; k < 2; k++) {
      d = aps[k]; y = d.buf[d.pos];
      d.buf[d.pos] = out + y * 0.5;
      if (++d.pos === d.buf.length) d.pos = 0;
      out = y - out;
    }
    return out;
  }
  Reverb.prototype.process = function (x) {
    this.l = reverbSide(x, this.cL, this.aL);
    this.r = reverbSide(x, this.cR, this.aR);
  };

  function GhostLayer(sr, cfg, rng) {
    var k;
    this.sr = sr;
    this.c = cfg;
    this.rng = rng;
    this.l = this.r = 0;
    this.kGain = onePole(sr, 0.03);
    this.rev = new Reverb(sr);

    // Heartbeat: a "lub" at the start of each beat, a softer, higher "dub" after it.
    this.bpm = cfg.heartBpm[0];
    this.kRace = 1 - Math.exp(-BLOCK / (sr * 0.8));   // races quickly …
    this.kCalm = 1 - Math.exp(-BLOCK / (sr * 4));     // … and calms down slowly
    this.hbPh = 0.7;
    this.thPh = 0; this.thHz = 0; this.thAmp = 0;
    this.thEnv = 0; this.thAtt = 1; this.thSweep = 0;
    this.thDecay = Math.exp(-1 / (sr * 0.08));
    this.thSweepDecay = Math.exp(-1 / (sr * 0.025));
    this.kThAtt = onePole(sr, 0.004);

    // Wind: two band-passed noises, one per side, drifting slowly.
    this.windL = new Biquad(); this.windR = new Biquad();
    this.wPh = [0, 0.3, 0.6];

    // Choir: two slightly detuned saws per voice, with a slow vibrato.
    this.voices = [];
    for (k = 0; k < CHOIR.length; k++) {
      var pan = CHOIR[k][2];
      this.voices.push({
        ratio: CHOIR[k][0], at: CHOIR[k][1], g: CHOIR[k][1] ? 0 : 1,
        pl: Math.sqrt(0.5 * (1 - pan)), pr: Math.sqrt(0.5 * (1 + pan)),
        p1: rng.next(), p2: rng.next(), dt1: 0, dt2: 0,
        vib: rng.next(), vibRate: 4.6 + rng.next()
      });
    }
    this.vowL = new Vowel(); this.vowR = new Vowel();

    // Moan: one voice sliding down an octave, drifting from left to right.
    this.moanT = -1; this.moanCool = 0; this.onFor = 0; this.offFor = 0;
    this.moanP1 = 0; this.moanP2 = 0.5; this.moanDt = 0; this.moanPan = 0;
    this.moanVow = new Vowel();

    // Church bell: one decaying resonator per partial, heard from afar.
    this.bellModes = [];
    for (k = 0; k < BELL.length; k++) {
      var w = TWO_PI * cfg.rootHz * BELL[k][0] / sr, rr = Math.exp(-1 / (sr * BELL[k][2]));
      this.bellModes.push({ c1: 2 * rr * Math.cos(w), c2: -rr * rr, sw: Math.sin(w), g: BELL[k][1], kick: 0, y1: 0, y2: 0 });
    }
    this.bellOn = false; this.armed = false; this.bellCool = 0;
    this.tolls = 0; this.tollIn = 0;
    this.bellLp = new Biquad();
    this.bellLp.set('lowpass', 4500, 0.7, 0, sr);
    // The clapper: a short, bright clang of noise at each strike.
    this.bellHit = 0;
    this.bellHitDecay = Math.exp(-1 / (sr * 0.012));
    this.bellBp = new Biquad();
    this.bellBp.set('bandpass', 2400, 1.5, 0, sr);

    // Growl: a low, rough "aaah" from a monster's throat.
    this.gPh = 0; this.growlDt = 0; this.rPh = 0; this.rDt = 0;
    this.growlVow = new Vowel();
    this.growlVow.set(0.85, sr);

    // Scream: a shriek from somewhere in the dark, one for each press of REV.
    this.scrT = -1; this.scrEnd = 0; this.lastRev = 0;
    this.scrPeak = 0; this.scrJit = 0; this.scrDt = 0; this.scrP1 = 0; this.scrP2 = 0.5;
    this.scrRPh = 0; this.scrRDt = 0; this.scrPl = this.scrPr = Math.SQRT1_2;
    this.scrVow = new Vowel(SHRIEK_EH, SHRIEK_AH);

    this.wet = cfg.reverb;
    this.heart = this.wind = this.choir = this.moan = this.growl = this.scream = 0;
    this.tHeart = this.tWind = this.tChoir = this.tMoan = this.tGrowl = this.tScream = 0;
  }

  // speed: road speed in m/s; load: the accelerator (0..1); character: the
  // user's setting, more of it is scarier (more growl and reverb); rev: the
  // REV pedal at a standstill (0..1).
  GhostLayer.prototype.block = function (speed, load, character, rev) {
    var c = this.c, sr = this.sr, dt = BLOCK / sr, k;
    var still = 1 - smoothstep((speed - 0.8) / 4);   // 1 standing still, 0 from about 17 km/h
    var moving = 1 - still;
    var pace = clamp(speed / 50, 0, 1);              // 1 at 180 km/h
    var scare = 0.5 + 0.67 * character;              // 1 at the default 0.75
    this.wet = c.reverb * scare;

    // Heartbeat: resting at a standstill, racing as the accelerator is
    // pressed (a little softer then, under the growl).
    var race = clamp((load - 0.12) / 0.6, 0, 1);
    var bpm = lerp(c.heartBpm[0], c.heartBpm[1], race);
    this.bpm += (bpm - this.bpm) * (bpm > this.bpm ? this.kRace : this.kCalm);
    this.tHeart = c.heart * still * (1 - 0.35 * race);

    // Wind: gusting, its howl drifting slowly; stronger and whistling higher
    // the faster the car goes.
    var wp = this.wPh;
    wp[0] = (wp[0] + 0.043 * dt) % 1; wp[1] = (wp[1] + 0.11 * dt) % 1; wp[2] = (wp[2] + 0.07 * dt) % 1;
    var lfoL = 0.6 * Math.sin(TWO_PI * wp[0]) + 0.4 * Math.sin(TWO_PI * wp[1]);
    var lfoR = 0.6 * Math.sin(TWO_PI * (wp[0] + 0.37)) + 0.4 * Math.sin(TWO_PI * (wp[1] + 0.61));
    var windHz = 330 + 450 * pace;
    this.windL.set('bandpass', windHz * Math.pow(2, 0.9 * lfoL), 4, 0, sr);
    this.windR.set('bandpass', windHz * Math.pow(2, 0.9 * lfoR), 4, 0, sr);
    var gust = 0.55 + 0.45 * Math.sin(TWO_PI * wp[2]);
    this.tWind = c.wind * gust * (0.35 + 0.65 * clamp(speed / 30, 0, 1));

    // Choir: comes in as the car drives off, louder with the accelerator and
    // its vowel opening up; higher voices join as the car speeds up.
    this.tChoir = c.choir * moving * (0.35 + 0.65 * load);
    for (k = 0; k < this.voices.length; k++) {
      var v = this.voices[k];
      var on = v.at ? smoothstep((pace - v.at) / 0.1) : 1;
      v.g += (on - v.g) * 0.02;
      v.vib = (v.vib + v.vibRate * dt) % 1;
      var hz = c.rootHz * v.ratio * (1 + 0.004 * Math.sin(TWO_PI * v.vib));
      v.dt1 = hz * 1.0025 / sr;
      v.dt2 = hz * 0.9975 / sr;
    }
    this.vowL.set(0.15 + 0.6 * load, sr);
    this.vowR.set(0.2 + 0.6 * load, sr);

    // Moan: lifting off above 30 km/h after driving on the accelerator
    // (cruising counts). It takes half a second off it, so a gear change
    // doesn't count; three seconds off and the driving is forgotten.
    if (load > 0.03) {
      this.onFor += dt;
      this.offFor = 0;
    } else {
      this.offFor += dt;
      if (this.offFor > 3) this.onFor = 0;
    }
    this.moanCool -= dt;
    if (this.offFor >= 0.5 && this.offFor - dt < 0.5 && this.onFor > 1 && speed > 8.3 && this.moanCool <= 0) {
      this.moanT = 0;
      this.moanCool = 7;
    }
    if (this.moanT >= 0) {
      var t = this.moanT, x = t / MOAN_S;
      var glide = 0.5 - 0.5 * Math.cos(Math.PI * clamp(t / 1.8, 0, 1));
      var mhz = c.rootHz * lerp(2, 1, glide) * (1 + 0.012 * smoothstep(t / 0.8) * Math.sin(TWO_PI * 5.3 * t));
      this.moanDt = mhz / sr;
      this.tMoan = c.moan * smoothstep(t / 0.35) * (1 - smoothstep((t - 1.7) / 0.9));
      this.moanPan = lerp(-0.6, 0.6, x);
      this.moanVow.set(lerp(0.55, 0, x), sr);           // "oh" closing to "oo"
      this.moanT += dt;
      if (this.moanT > MOAN_S) this.moanT = -1;
    } else {
      this.tMoan = 0;
    }

    // Church bell: coming to a stop, it tolls (at most every 15 s); driving
    // off again stops it.
    if (speed > 4) {
      this.armed = true;
      this.tolls = 0;
    }
    this.bellCool -= dt;
    if (this.armed && speed < 0.3) {
      this.armed = false;
      if (this.bellCool <= 0) {
        this.bellCool = 15;
        this.tolls = BELL_TOLLS;
        this.tollIn = 0;
      }
    }
    if (this.tolls > 0) {
      this.tollIn -= dt;
      if (this.tollIn <= 0) {
        this.tolls--;
        this.tollIn = BELL_GAP_S;
        this.bellOn = true;
        this.bellHit = c.bell;
        for (k = 0; k < this.bellModes.length; k++) this.bellModes[k].kick += this.bellModes[k].g * c.bell * (0.9 + 0.2 * this.rng.next());
      }
    }
    if (this.bellOn) {
      var ring = 0;
      for (k = 0; k < this.bellModes.length; k++) ring += Math.abs(this.bellModes[k].y1) + Math.abs(this.bellModes[k].y2);
      if (ring < 1e-5 && this.bellHit < 1e-4 && !this.tolls) this.bellOn = false;
    }

    // Growl: hard on the accelerator, or REV at a standstill.
    this.tGrowl = c.growl * scare * smoothstep((load - 0.55) / 0.35);
    this.growlDt = (55 + 40 * pace) / sr;
    this.rDt = 27 * (0.75 + 0.5 * this.rng.next()) / sr;   // the throat's flutter, never quite even

    // Scream: each press of REV lets out one. It swoops up to its peak,
    // holds while REV is held (until the breath runs out) and dies away
    // sliding down once REV is let go; even a quick tap gets a short one.
    if (rev > 0.25 && this.lastRev <= 0.25) {
      this.scrT = 0;
      this.scrEnd = SCREAM_MAX_S;
      this.scrPeak = 980 + 220 * this.rng.next();
      var sPan = 1.2 * (this.rng.next() - 0.5);
      this.scrPl = Math.sqrt(0.5 * (1 - sPan));
      this.scrPr = Math.sqrt(0.5 * (1 + sPan));
    }
    this.lastRev = rev;
    if (this.scrT >= 0) {
      var st = this.scrT;
      if (rev <= 0.25 && this.scrEnd > Math.max(st, SCREAM_MIN_S)) this.scrEnd = Math.max(st, SCREAM_MIN_S);
      var swoop = 1 - Math.pow(1 - clamp(st / 0.22, 0, 1), 3);
      var fall = smoothstep((st - this.scrEnd) / SCREAM_FADE_S);
      var vib = 0.025 * smoothstep((st - 0.25) / 0.4) * Math.sin(TWO_PI * 6.3 * st);
      this.scrJit += (0.015 * this.rng.gauss() - this.scrJit) * 0.25;
      var shz = this.scrPeak * lerp(0.55, 1, swoop) * (1 + 0.05 * clamp(st / 2, 0, 1)) * lerp(1, 0.62, fall);
      this.scrDt = shz * (1 + vib + this.scrJit) / sr;
      this.tScream = c.scream * scare * smoothstep(st / 0.05) * (1 - fall);
      this.scrVow.set(lerp(1, 0.4, fall), sr);           // "aah" closing to "eh" as it dies
      this.scrT += dt;
      if (this.scrT > this.scrEnd + SCREAM_FADE_S) this.scrT = -1;
    } else {
      this.tScream = 0;
    }
    this.scrRDt = (70 + 30 * this.rng.next()) / sr;       // rasp
  };

  GhostLayer.prototype.next = function () {
    var sr = this.sr, r = this.rng, kg = this.kGain, k;
    this.heart += (this.tHeart - this.heart) * kg;
    this.wind += (this.tWind - this.wind) * kg;
    this.choir += (this.tChoir - this.choir) * kg;
    this.moan += (this.tMoan - this.moan) * kg;
    this.growl += (this.tGrowl - this.growl) * kg;
    this.scream += (this.tScream - this.scream) * kg;
    var L = 0, R = 0, send = 0, y;

    // Heartbeat
    var hb = this.hbPh;
    this.hbPh += this.bpm / 60 / sr;
    if (this.hbPh >= 1) { this.hbPh -= 1; this._thump(1, 46); }
    else if (hb < 0.3 && this.hbPh >= 0.3) this._thump(0.7, 58);
    if (this.heart > 1e-5 && this.thEnv > 1e-4) {
      this.thAtt += (1 - this.thAtt) * this.kThAtt;
      this.thEnv *= this.thDecay;
      this.thSweep *= this.thSweepDecay;
      this.thPh += this.thHz * (1 + 0.9 * this.thSweep) / sr;
      if (this.thPh >= 1) this.thPh -= 1;
      // A little grit, so small speakers carry the thump too.
      y = softClip(Math.sin(TWO_PI * this.thPh) * this.thAtt * this.thEnv * this.thAmp * 2.5) * this.heart;
      L += y; R += y; send += 0.15 * y;
    }

    // Wind
    if (this.wind > 1e-5) {
      var wl = this.windL.process(r.white()) * this.wind, wr = this.windR.process(r.white()) * this.wind;
      L += wl; R += wr; send += 0.1 * (wl + wr);
    }

    // Choir
    if (this.choir > 1e-5) {
      var cl = 0, cr = 0;
      for (k = 0; k < this.voices.length; k++) {
        var v = this.voices[k];
        if (v.g < 1e-4) continue;
        var p1 = v.p1 += v.dt1, p2 = v.p2 += v.dt2;
        if (p1 >= 1) p1 = v.p1 -= 1;
        if (p2 >= 1) p2 = v.p2 -= 1;
        var o = (saw(p1, v.dt1) + saw(p2, v.dt2)) * v.g;
        cl += o * v.pl; cr += o * v.pr;
      }
      cl = this.vowL.process(cl + 0.3 * r.white()) * this.choir;   // with a breath of air
      cr = this.vowR.process(cr + 0.3 * r.white()) * this.choir;
      L += 0.8 * cl; R += 0.8 * cr; send += 0.25 * (cl + cr);
    }

    // Moan
    if (this.moan > 1e-5) {
      var mp1 = this.moanP1 += this.moanDt, mp2 = this.moanP2 += this.moanDt * 1.004;
      if (mp1 >= 1) mp1 = this.moanP1 -= 1;
      if (mp2 >= 1) mp2 = this.moanP2 -= 1;
      var m = this.moanVow.process(saw(mp1, this.moanDt) + saw(mp2, this.moanDt * 1.004)) * this.moan;
      L += 0.5 * m * Math.sqrt(0.5 * (1 - this.moanPan));
      R += 0.5 * m * Math.sqrt(0.5 * (1 + this.moanPan));
      send += 0.9 * m;
    }

    // Church bell: its partials ringing, and the clang of the clapper.
    if (this.bellOn) {
      var b = 0;
      for (k = 0; k < this.bellModes.length; k++) {
        var md = this.bellModes[k];
        y = md.c1 * md.y1 + md.c2 * md.y2 + md.kick * md.sw;
        md.kick = 0;
        md.y2 = md.y1; md.y1 = y;
        b += y;
      }
      if (this.bellHit > 1e-4) {
        b += this.bellBp.process(r.white()) * this.bellHit;
        this.bellHit *= this.bellHitDecay;
      }
      b = this.bellLp.process(b);
      L += 0.6 * b; R += 0.6 * b; send += 0.8 * b;
    }

    // Growl
    if (this.growl > 1e-5) {
      this.gPh += this.growlDt;
      if (this.gPh >= 1) this.gPh -= 1;
      this.rPh += this.rDt;
      if (this.rPh >= 1) this.rPh -= 1;
      var src = (0.7 * saw(this.gPh, this.growlDt) + 0.3 * r.white()) * (0.55 + 0.45 * Math.sin(TWO_PI * this.rPh));
      var g = softClip(this.growlVow.process(src) * 3) * this.growl;
      L += g; R += g; send += 0.15 * g;
    }

    // Scream: two voices a little apart, a breath of air and a raspy
    // flutter, a throat at its limit rather than a clean whistle.
    if (this.scream > 1e-5) {
      var sp1 = this.scrP1 += this.scrDt, sp2 = this.scrP2 += this.scrDt * 1.006;
      if (sp1 >= 1) sp1 = this.scrP1 -= 1;
      if (sp2 >= 1) sp2 = this.scrP2 -= 1;
      this.scrRPh += this.scrRDt;
      if (this.scrRPh >= 1) this.scrRPh -= 1;
      var ss = (saw(sp1, this.scrDt) + 0.7 * saw(sp2, this.scrDt * 1.006) + 0.35 * r.white()) *
        (0.7 + 0.3 * Math.sin(TWO_PI * this.scrRPh));
      var sc = softClip(this.scrVow.process(ss) * 2) * this.scream;
      L += sc * this.scrPl; R += sc * this.scrPr; send += 0.6 * sc;
    }

    this.rev.process(send);
    this.l = L + this.rev.l * this.wet;
    this.r = R + this.rev.r * this.wet;
  };

  GhostLayer.prototype._thump = function (amp, hz) {
    this.thAmp = amp;
    this.thHz = hz;
    this.thPh = 0;
    this.thAtt = 0;
    this.thEnv = 1;
    this.thSweep = 1;
  };

  function HauntedDSP(sampleRate, engineCfg, seed) {
    this.sr = sampleRate;
    this.rng = new Rng(seed || 0x2545f491);
    this.target = { load: 0, speed: 0, character: 0.6, rev: 0 };
    this.load = 0;
    this.character = 0.6;
    // Slower than an engine's: the gear changes' moments off the throttle
    // don't come through.
    this.kLoad = onePole(sampleRate, 0.2);
    this.blockPos = 0;
    this.configure(engineCfg);
  }

  HauntedDSP.prototype.configure = function (cfg) {
    this.cfg = cfg;
    this.ghost = new GhostLayer(this.sr, cfg.sound, this.rng);
  };

  HauntedDSP.prototype.message = function (msg) {
    if (!msg) return;
    if (msg.type === 'params') {
      var t = this.target;
      if (typeof msg.load === 'number') t.load = msg.load;
      if (typeof msg.speed === 'number') t.speed = msg.speed;
      if (typeof msg.character === 'number') t.character = msg.character;
      if (typeof msg.rev === 'number') t.rev = msg.rev;
    } else if (msg.type === 'config') {
      this.configure(msg.config);
    }
  };

  HauntedDSP.prototype.process = function (outL, outR, n) {
    var t = this.target, ghost = this.ghost;
    for (var i = 0; i < n; i++) {
      this.load += (t.load - this.load) * this.kLoad;
      if (this.blockPos === 0) {
        this.character += (t.character - this.character) * 0.05;
        ghost.block(t.speed, this.load, this.character, t.rev);
      }
      this.blockPos = (this.blockPos + 1) % BLOCK;
      ghost.next();
      outL[i] = ghost.l;
      outR[i] = ghost.r;
    }
  };

  function EngineDSP(sampleRate, engineCfg, seed) {
    this.sr = sampleRate;
    this.rng = new Rng(seed || 0x2545f491);
    // whinePitch / whineLevel: multipliers on the car's whine from the local
    // tuning sliders (1 = the car's own).
    this.target = { rpm: 0, load: 0, overrun: 0, cut: 0, character: 0.6, crackle: 1, whinePitch: 1, whineLevel: 1 };
    this.rpm = 0;
    this.load = 0;
    this.overrun = 0;
    this.cut = 0;
    this.character = 0.6;
    this.crackleAmt = 1;
    this.kRpm = onePole(sampleRate, 0.03);
    this.kLoad = onePole(sampleRate, 0.05);
    this.blockPos = 0;
    this.configure(engineCfg);
  }

  EngineDSP.prototype.configure = function (cfg) {
    var sr = this.sr, s = cfg.sound, i;
    this.cfg = cfg;
    this.s = s;

    var ev = cfg.firing.slice().sort(function (a, b) { return a[0] - b[0]; });
    this.nEv = ev.length;
    this.evPos = new Float64Array(ev.length + 1);
    this.evCyl = new Int32Array(ev.length);
    this.evBank = new Int32Array(ev.length);
    var maxCyl = 0;
    for (i = 0; i < ev.length; i++) {
      this.evPos[i] = (ev[i][0] % 720) / 720;
      this.evCyl[i] = ev[i][1];
      this.evBank[i] = ev[i][2];
      if (ev[i][1] > maxCyl) maxCyl = ev[i][1];
    }
    this.evPos[ev.length] = 1; // wrap sentinel
    this.ne = 0;
    this.phase = 0;

    // Fixed per-cylinder strength differences: part of what makes an engine
    // sound "mechanical" instead of like an oscillator.
    this.trim = new Float32Array(maxCyl + 1);
    for (i = 0; i <= maxCyl; i++) this.trim[i] = 1 + s.cylinderTrim * this.rng.gauss();

    this.banks = [];
    for (i = 0; i < s.banks.length; i++) this.banks.push(new Bank(sr, s.banks[i], s));

    this.hpL = new Biquad(); this.hpR = new Biquad();
    this.hpL.set('highpass', 26, 0.707, 0, sr); this.hpR.set('highpass', 26, 0.707, 0, sr);
    this.mufL = new Biquad(); this.mufR = new Biquad();
    // Second muffler stage (4th-order overall) — real exhausts roll off steeply
    // above a few kHz; a single 2nd-order low-pass leaves the top end hissy.
    this.muf2L = new Biquad(); this.muf2R = new Biquad();
    // Short cabin/room reflections: two lossy feedback delays per channel.
    var rd = [0.0073, 0.0111, 0.0097, 0.0137];
    this.room = [];
    for (i = 0; i < 4; i++) {
      var len = Math.round(rd[i] * sr);
      this.room.push({ buf: new Float32Array(len), pos: 0, lp: 0 });
    }
    this.bodyL = new Biquad(); this.bodyR = new Biquad();
    this.bodyL.set('peaking', s.bodyHz, 0.9, s.bodyDb, sr);
    this.bodyR.set('peaking', s.bodyHz, 0.9, s.bodyDb, sr);
    this.intakeBp = new Biquad();
    this.intakeBp.set('bandpass', s.intakeHz, 1.1, 0, sr);
    this.intakeEnv = 0;
    this.kIntakeEnv = onePole(sr, 0.004);
    this.popBp = new Biquad();
    this.popBp.set('bandpass', 1400, 0.9, 0, sr);
    this.popEnv = 0;
    this.popDecay = Math.exp(-1 / (sr * 0.012));
    this.whinePh = 0;
    this.whinePhs = new Float64Array(s.blower ? s.blower.voices.length : 0);
    this.crackleOn = false;
    this.crackleTimer = 0;
    this.click = new GearClick(sr, s.shiftClick || 0);
    this.clutchDown = 0;
    this.clutchAmt = 0;
  };

  EngineDSP.prototype.message = function (msg) {
    if (!msg) return;
    if (msg.type === 'params') {
      var t = this.target;
      if (typeof msg.rpm === 'number') t.rpm = msg.rpm;
      if (typeof msg.load === 'number') t.load = msg.load;
      if (typeof msg.overrun === 'number') t.overrun = msg.overrun;
      if (typeof msg.cut === 'number') t.cut = msg.cut;
      if (typeof msg.character === 'number') t.character = msg.character;
      if (typeof msg.crackle === 'number') t.crackle = clamp(msg.crackle, 0, 1);
      if (typeof msg.whinePitch === 'number') t.whinePitch = msg.whinePitch;
      if (typeof msg.whineLevel === 'number') t.whineLevel = msg.whineLevel;
    } else if (msg.type === 'config') {
      this.configure(msg.config);
    } else if (msg.type === 'click') {
      this.click.trigger(msg.strength || 1, this.rng);
    } else if (msg.type === 'clutch') {
      this.clutchDown = msg.down ? 1 : 0;
    }
  };

  // Block-rate parameter derivation (every 128 samples).
  EngineDSP.prototype._updateBlock = function () {
    var cfg = this.cfg, s = this.s, sr = this.sr, t = this.target, r = this.rng;
    this.overrun = t.overrun;
    this.cut = t.cut;
    this.character += (t.character - this.character) * 0.05;
    this.crackleAmt = t.crackle;

    var ch = this.character, load = this.load;
    var rpmN = clamp((this.rpm - cfg.idleRpm) / (cfg.redlineRpm - cfg.idleRpm), 0, 1);
    this.rpmN = rpmN;
    // Clutch down between gears (manual): with the throttle shut, combustion
    // turns weak and uneven, a rough unpitched burble. Only between gears, and
    // nothing ignites in the exhaust, so no pops.
    this.clutchAmt += (this.clutchDown - this.clutchAmt) * 0.2;
    this.burble = (s.burble || 0) * this.clutchAmt * (1 - clamp(load * 3, 0, 1)) * clamp(rpmN * 6, 0, 1);

    this.ampBase = s.gain * (0.28 + 0.72 * Math.pow(load, 0.8)) * (0.8 + 0.35 * rpmN);
    this.pulseLen = sr / 1000 * lerp(s.pulseMsIdle, s.pulseMsRedline, Math.sqrt(rpmN)) * (1.12 - 0.3 * load);
    this.noiseAmt = s.noise * (0.3 + 0.7 * load + 1.2 * this.burble) * (0.55 + 0.9 * ch);
    this.noiseDecay = Math.exp(-1 / (sr * lerp(0.0045, 0.0012, rpmN)));
    this.jitter = s.jitter * (1 + 1.5 * ch * (1 - rpmN));
    // Lumpy cam: at idle, random cylinders burn weakly → the classic lope.
    this.lope = s.lope * ch * (1 - clamp(rpmN * 5, 0, 1)) * (1 - load) * this.crackleAmt;

    var open = clamp(0.2 * ch + load * (0.55 + 0.45 * ch) + 0.25 * rpmN, 0, 1);
    var mufHz = lerp(s.mufflerHz[0], s.mufflerHz[1], open);
    this.mufL.set('lowpass', mufHz, 0.75, 0, sr);
    this.mufR.set('lowpass', mufHz, 0.75, 0, sr);
    this.muf2L.set('lowpass', mufHz * 1.15, 0.6, 0, sr);
    this.muf2R.set('lowpass', mufHz * 1.15, 0.6, 0, sr);
    this.drive = 1 + (s.drive - 1) * (0.25 + 0.75 * load) * (0.4 + 0.6 * ch);
    this.driveNorm = 1 / softClip(this.drive * 0.6) * 0.6;

    this.intakeAmp = s.intake * load * (0.25 + 0.75 * rpmN);
    // Belt-driven supercharger (s.blower): whines only under boost, coming in
    // as the throttle opens from blower.boostLoad[0] to [1] (the bypass valve
    // is open at idle, cruising and coasting), and rises steadily with revs.
    // Otherwise just a faint whine at high load and revs.
    var b = s.blower;
    this.whineAmp = t.whineLevel * (b
      ? s.whine * smoothstep((load - b.boostLoad[0]) / (b.boostLoad[1] - b.boostLoad[0])) *
        (0.1 + 0.9 * clamp(this.rpm / cfg.redlineRpm, 0, 1))
      : s.whine * load * rpmN * rpmN);

    // Afterfire crackle comes in irregular bursts, not a steady stream.
    this.crackleTimer -= BLOCK;
    if (this.crackleTimer <= 0) {
      this.crackleOn = !this.crackleOn;
      this.crackleTimer = sr * (this.crackleOn ? 0.04 + 0.16 * r.next() : 0.08 + 0.45 * r.next());
    }
    var crackleBase = s.crackle * this.overrun * (0.3 + 0.7 * ch) * this.crackleAmt;
    this.crackleProb = crackleBase * (this.crackleOn ? 0.35 : 0.03);
  };

  EngineDSP.prototype._pop = function (bank, strength) {
    var sr = this.sr, r = this.rng;
    bank.add(sr * 0.0012, strength * this.s.gain * 1.6, strength * this.s.gain * 1.2,
      Math.exp(-1 / (sr * (0.002 + 0.004 * r.next()))));
    if (strength * 0.9 > this.popEnv) {
      this.popEnv = strength * 0.9;
      this.popBp.set('bandpass', 700 + 1800 * r.next(), 0.8, 0, sr);
      this.popDecay = Math.exp(-1 / (sr * (0.006 + 0.012 * r.next())));
    }
  };

  EngineDSP.prototype._fire = function (e) {
    var r = this.rng;
    var bank = this.banks[this.evBank[e]];
    if (this.cut > 0.5) {
      // Ignition cut: just pumping air, plus unburnt fuel igniting in the hot exhaust.
      bank.add(this.pulseLen, this.ampBase * 0.18, 0, 0);
      if (r.next() < 0.12 * this.s.crackle * (0.4 + this.character) * this.crackleAmt) this._pop(bank, 0.5 + 0.5 * r.next());
      return;
    }
    var amp = this.ampBase * this.trim[this.evCyl[e]] * (1 + this.jitter * r.gauss());
    if (this.lope > 0 && r.next() < this.lope) amp *= 0.35 + 0.3 * r.next();
    if (this.burble > 0) {
      amp *= clamp(1 + 0.6 * this.burble * r.gauss(), 0.1, 1.5);   // capped: uneven, never a bang
      if (r.next() < 0.35 * this.burble) amp *= 0.2 + 0.3 * r.next();
    }
    if (amp < 0) amp = 0;
    var len = this.pulseLen * (0.85 + 0.3 * r.next());
    bank.add(len, amp, amp * this.noiseAmt, this.noiseDecay);
    if (this.crackleProb > 0 && r.next() < this.crackleProb) this._pop(bank, 0.25 + 0.75 * r.next());
  };

  // One blower voice at phase p (0..1) advancing dp per sample: the harmonics
  // in blower.harmonics (amplitudes of 1×, 2×, 3×, …), leaving out any above
  // 0.45 × the sample rate. sin(kθ) by recursion, so only one sin and cos.
  EngineDSP.prototype._blowerWave = function (p, dp) {
    var h = this.s.blower.harmonics, th = TWO_PI * p;
    var c2 = 2 * Math.cos(th), sPrev = 0, sk = Math.sin(th), out = 0;
    for (var k = 0; k < h.length && (k + 1) * dp < 0.45; k++) {
      out += h[k] * sk;
      var next = c2 * sk - sPrev;
      sPrev = sk; sk = next;
    }
    return out;
  };

  EngineDSP.prototype.process = function (outL, outR, n) {
    var sr = this.sr, t = this.target, r = this.rng, banks = this.banks, nb = banks.length;
    var cycPerSample = 1 / (120 * sr); // 4-stroke: one cycle per two revolutions
    for (var i = 0; i < n; i++) {
      if (this.blockPos === 0) this._updateBlock();
      this.blockPos = (this.blockPos + 1) % BLOCK;

      this.rpm += (t.rpm - this.rpm) * this.kRpm;
      this.load += (t.load - this.load) * this.kLoad;

      this.phase += this.rpm * cycPerSample;
      while (this.phase >= this.evPos[this.ne]) {
        if (this.ne === this.nEv) {
          this.phase -= 1;
          this.ne = 0;
        } else {
          this._fire(this.ne);
          this.ne++;
        }
      }

      var L = 0, R = 0, excSum = 0;
      for (var b = 0; b < nb; b++) {
        var bank = banks[b];
        var y = bank.tick(r);
        L += y * bank.panL;
        R += y * bank.panR;
        excSum += bank.exc;
      }

      // Intake roar: band-limited noise that breathes with the firing pulses.
      this.intakeEnv += (Math.abs(excSum) - this.intakeEnv) * this.kIntakeEnv;
      if (this.intakeAmp > 1e-4) {
        var intake = this.intakeBp.process(r.white() * this.intakeAmp * (0.35 + 2.5 * this.intakeEnv));
        L += intake; R += intake;
      }

      // Supercharger whine, locked to crank speed. A belt-driven blower whines
      // from the engine bay, not the tailpipe, so it skips the muffler and
      // saturation; any other whine goes through the exhaust.
      var blower = 0;
      if (this.whineAmp > 1e-4) {
        var dp = this.rpm / 60 * this.s.whineRatio * t.whinePitch / sr;
        this.whinePh += dp;
        if (this.whinePh >= 1) this.whinePh -= 1;
        if (this.s.blower) {
          // A few voices a little apart in pitch (blower.voices: [pitch, gain])
          // beat against each other: the uneven warble of a real blower
          // instead of a steady beep.
          var vs = this.s.blower.voices, w = 0;
          for (var j = 0; j < vs.length; j++) {
            var vdp = dp * vs[j][0], ph = this.whinePhs[j] + vdp;
            if (ph >= 1) ph -= 1;
            this.whinePhs[j] = ph;
            w += vs[j][1] * this._blowerWave(ph, vdp);
          }
          blower = this.whineAmp * w;
        } else {
          var wv = this.whineAmp * (Math.sin(TWO_PI * this.whinePh) + 0.35 * Math.sin(2 * TWO_PI * this.whinePh));
          L += wv; R += wv;
        }
      }

      L = this.bodyL.process(this.muf2L.process(this.mufL.process(this.hpL.process(L))));
      R = this.bodyR.process(this.muf2R.process(this.mufR.process(this.hpR.process(R))));

      // Cabin reflections (parallel, damped): adds body and removes the
      // "dry oscillator" feel. Each delay feeds back through a one-pole LP.
      var rm = this.room, rl = 0, rr = 0;
      for (var q = 0; q < 4; q++) {
        var d = rm[q], inp = (q & 1 ? R : L);
        var o = d.buf[d.pos];
        d.lp += 0.35 * (o - d.lp);
        d.buf[d.pos] = inp + d.lp * 0.42;
        d.pos = (d.pos + 1) % d.buf.length;
        if (q < 2) rl += d.lp; else rr += d.lp;
      }
      L += rl * 0.22; R += rr * 0.22;

      // Afterfire crack bypasses the muffler low-pass — it should be sharp.
      if (this.popEnv > 1e-4) {
        var pop = this.popBp.process(r.white() * this.popEnv) * this.s.popGain;
        this.popEnv *= this.popDecay;
        L += pop; R += pop;
      }

      // Gear lever click: a cabin sound, so it skips the exhaust and saturation.
      var click = this.click.next(r);
      outL[i] = softClip(L * this.drive) * this.driveNorm + click + blower;
      outR[i] = softClip(R * this.drive) * this.driveNorm + click + blower;
    }
  };

  /*
   * Electric motor (engine.type 'electric'): a buzz instead of combustion.
   * The note follows motor speed, so road speed: deep and bass-heavy pulling
   * away, higher and thinner the faster the car goes. Two square/saw
   * oscillators a little apart in pitch beat slowly against each other; the
   * accelerator (load) makes the buzz louder and brighter. At a steady speed,
   * on regen (overrun: lifting off or braking) and at a standstill the buzz
   * fades into a smooth, almost silent hum on the same note.
   */

  // PolyBLEP correction: removes the aliasing of a sawtooth's hard reset.
  function polyBlep(t, dt) {
    if (t < dt) { t /= dt; return t + t - t * t - 1; }
    if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
    return 0;
  }

  // Band-limited sawtooth (-1..1) at phase p (0..1) that advances dt per sample.
  function saw(p, dt) { return 2 * p - 1 - polyBlep(p, dt); }

  function ElectricDSP(sampleRate, engineCfg, seed) {
    this.sr = sampleRate;
    this.rng = new Rng(seed || 0x2545f491);
    this.target = { rpm: 0, load: 0, overrun: 0, character: 0.6 };
    this.rpm = 0;
    this.load = 0;
    this.regen = 0;
    this.character = 0.6;
    this.kRpm = onePole(sampleRate, 0.05);
    this.kLoad = onePole(sampleRate, 0.08);
    this.kRegenIn = onePole(sampleRate, 0.3);    // buzz fading into the hum
    this.kRegenOut = onePole(sampleRate, 0.12);  // back on the accelerator
    this.kHz = onePole(sampleRate, 0.01);
    this.kGain = onePole(sampleRate, 0.004);     // de-zippers the block-rate gains
    this.blockPos = 0;
    this.configure(engineCfg);
  }

  ElectricDSP.prototype.configure = function (cfg) {
    var sr = this.sr, i;
    this.cfg = cfg;
    this.s = cfg.sound;
    this.ph1 = 0;
    this.ph2 = this.rng.next();
    this.whinePh = 0;
    this.hz = this.hzTarget = this.s.baseHz;
    this.buzz = this.bass = this.whine = this.hum = 0;
    this.tBuzz = this.tBass = this.tWhine = this.tHum = 0;
    this.sq = 0.5;
    this.drive = 1;
    this.hpL = new Biquad(); this.hpR = new Biquad();
    this.lpL = new Biquad(); this.lpR = new Biquad();
    var rd = [0.0073, 0.0111, 0.0097, 0.0137];
    this.room = [];
    for (i = 0; i < 4; i++) this.room.push({ buf: new Float32Array(Math.round(rd[i] * sr)), pos: 0, lp: 0 });
  };

  ElectricDSP.prototype.message = function (msg) {
    if (!msg) return;
    if (msg.type === 'params') {
      var t = this.target;
      if (typeof msg.rpm === 'number') t.rpm = msg.rpm;
      if (typeof msg.load === 'number') t.load = msg.load;
      if (typeof msg.overrun === 'number') t.overrun = msg.overrun;
      if (typeof msg.character === 'number') t.character = msg.character;
    } else if (msg.type === 'config') {
      this.configure(msg.config);
    }
    // No ignition, exhaust, gear lever or clutch: cut, crackle, click and clutch don't apply.
  };

  ElectricDSP.prototype._updateBlock = function () {
    var cfg = this.cfg, s = this.s, sr = this.sr;
    this.character += (this.target.character - this.character) * 0.05;
    var ch = this.character, load = this.load;
    var spd = clamp(this.rpm / cfg.redlineRpm, 0, 1);    // 0 standing still, 1 flat out
    var rolling = clamp(this.rpm / 400, 0, 1);
    this.hzTarget = s.baseHz * Math.pow(1 + this.rpm / s.kneeRpm, s.curve);

    // Buzz while driving, louder with the accelerator; gone on regen.
    var on = (1 - this.regen) * clamp(s.cruise * rolling + (1 - s.cruise) * load, 0, 1);
    this.tBuzz = s.gain * on * (1 - 0.3 * spd);
    this.tBass = s.bass * on * (1 - spd) * (1 - spd);
    this.tWhine = s.whine * on * spd;
    // The hum gets easier to hear as its note rises, so off regen it is turned
    // down with the note: a steady speed sounds as quiet as standing still.
    this.tHum = s.hum * (1 - on) * lerp(Math.min(1, s.baseHz / this.hzTarget), 1, this.regen);

    // More character: squarer, brighter and grittier.
    this.sq = lerp(0.35, 0.85, ch);
    this.drive = lerp(1.1, 2.4, ch);
    var bright = clamp(this.hz * lerp(4, 14, ch) * (0.6 + 0.6 * load), 300, 7000);
    this.lpL.set('lowpass', bright, 0.8, 0, sr);
    this.lpR.set('lowpass', bright, 0.8, 0, sr);
    // Thinner as it speeds up.
    var hp = lerp(25, 150, spd);
    this.hpL.set('highpass', hp, 0.707, 0, sr);
    this.hpR.set('highpass', hp, 0.707, 0, sr);
  };

  ElectricDSP.prototype.process = function (outL, outR, n) {
    var sr = this.sr, t = this.target, s = this.s;
    for (var i = 0; i < n; i++) {
      this.rpm += (t.rpm - this.rpm) * this.kRpm;
      this.load += (t.load - this.load) * this.kLoad;
      this.regen += (t.overrun - this.regen) * (t.overrun > this.regen ? this.kRegenIn : this.kRegenOut);
      if (this.blockPos === 0) this._updateBlock();
      this.blockPos = (this.blockPos + 1) % BLOCK;

      var kg = this.kGain;
      this.hz += (this.hzTarget - this.hz) * this.kHz;
      this.buzz += (this.tBuzz - this.buzz) * kg;
      this.bass += (this.tBass - this.bass) * kg;
      this.whine += (this.tWhine - this.whine) * kg;
      this.hum += (this.tHum - this.hum) * kg;

      var dt1 = this.hz / sr, dt2 = (this.hz + s.beatHz) / sr;
      var p1 = this.ph1 += dt1, p2 = this.ph2 += dt2;
      if (p1 >= 1) p1 = this.ph1 -= 1;
      if (p2 >= 1) p2 = this.ph2 -= 1;
      var h1 = p1 + 0.5, h2 = p2 + 0.5;
      if (h1 >= 1) h1 -= 1;
      if (h2 >= 1) h2 -= 1;
      // Each oscillator: a square (saw minus a half-cycle-shifted saw) mixed with a saw.
      var s1 = saw(p1, dt1), s2 = saw(p2, dt2), sq = this.sq;
      var o1 = sq * (s1 - saw(h1, dt1)) + (1 - sq) * s1;
      var o2 = sq * (s2 - saw(h2, dt2)) + (1 - sq) * s2;
      var sine = Math.sin(TWO_PI * p1), cosine = Math.cos(TWO_PI * p1);

      var L = this.buzz * (o1 + 0.6 * o2) + this.bass * sine;
      var R = this.buzz * (0.6 * o1 + o2) + this.bass * sine;
      L = this.lpL.process(this.hpL.process(L));
      R = this.lpR.process(this.hpR.process(R));
      L = softClip(L * this.drive) / this.drive;
      R = softClip(R * this.drive) / this.drive;

      // Motor whine two octaves up, rising in with speed.
      if (this.whine > 1e-5) {
        this.whinePh += this.hz * s.whineRatio / sr;
        if (this.whinePh >= 1) this.whinePh -= 1;
        var w = this.whine * Math.sin(TWO_PI * this.whinePh);
        L += w; R += w;
      }
      // Regen / standstill hum: the same note, nearly pure (2nd and 3rd harmonic
      // only so small speakers can still carry it), kept clear of the saturation.
      var hum = this.hum * (sine + 0.35 * 2 * sine * cosine + 0.12 * sine * (3 - 4 * sine * sine));
      L += hum; R += hum;

      // Cabin reflections, as for the engines.
      var rm = this.room, rl = 0, rr = 0;
      for (var q = 0; q < 4; q++) {
        var d = rm[q], inp = (q & 1 ? R : L);
        var o = d.buf[d.pos];
        d.lp += 0.35 * (o - d.lp);
        d.buf[d.pos] = inp + d.lp * 0.42;
        d.pos = (d.pos + 1) % d.buf.length;
        if (q < 2) rl += d.lp; else rr += d.lp;
      }
      outL[i] = L + rl * 0.22;
      outR[i] = R + rr * 0.22;
    }
  };

  /*
   * Cold-gas thrusters (engine.type 'thruster'): no engine and no motor
   * sound, only a row of supersonic compressed-air jets out of the back,
   * fired by a heavy foot on the accelerator (or REV at a standstill; how
   * heavy is the car's onset) and silent otherwise.
   * Each jet, heard from the cabin ahead of the nozzles, is noise of three
   * kinds: the roar of its turbulent mixing (deeper as more pressure swells
   * the jet), the hiss of its shock cells (the "Mach diamonds"; this
   * broadband shock-associated noise is strongest forwards, towards the
   * cabin) and a low rumble through the body. The jets surge and flutter at
   * random (turbulence) and crackle at high thrust (the Crackle setting). There
   * are no screech tones: they are whistles. More pedal is more pressure:
   * louder, deeper and more crackly, with a soft thump as the valves open
   * from rest. Lifting off shuts the valves in a fraction of a second,
   * leaving a short hiss as the lines vent.
   *
   * The drivetrain is still simulated as for an engine (the tach and how the
   * car pulls), but nothing here follows rpm.
   */

  // vehicle.js holds the load at up to 0.12 near idle (an engine keeps
  // burning there); below it the valves stay shut.
  var THRUST_IDLE_LOAD = 0.12;
  // vehicle.js plays an engine start-up, with a load of its own, for the
  // first 2.6 s; the jets ignore the load until it is over.
  var THRUST_START_S = 2.6;

  // How hard the jets fire (0..1) for vehicle.js's load and REV pedal: REV at
  // a standstill as it is, the accelerator beyond what the drivetrain keeps
  // at idle, and only a heavy foot (past onset) opens the valves. The
  // picture's thruster effect (thruster-fx.js) follows the same.
  function thrustDemand(load, rev, onset) {
    var on = onset || 0;
    load = clamp((load - THRUST_IDLE_LOAD) / (1 - THRUST_IDLE_LOAD), 0, 1);
    return clamp((Math.max(clamp(rev, 0, 1), load) - on) / (1 - on), 0, 1);
  }

  function ThrusterDSP(sampleRate, engineCfg, seed) {
    this.sr = sampleRate;
    this.rng = new Rng(seed || 0x2545f491);
    this.target = { load: 0, rev: 0, character: 0.6, crackle: 1 };
    this.character = 0.6;
    this.blockPos = 0;
    this.configure(engineCfg);
  }

  ThrusterDSP.prototype.configure = function (cfg) {
    var sr = this.sr, s = cfg.sound, i;
    this.cfg = cfg;
    this.s = s;
    this.age = 0;           // samples since the start
    this.want = 0;          // level the valves are heading for
    this.slow = 0;          // the same, slowly: how fast it is opening
    this.lvl = 0;           // level of the jets
    this.hiss = 0;          // level of the shock hiss (lingers as the lines vent)
    this.press = 0;         // pressure, which sets the tone (0..1)
    this.demand = 0;
    this.kAtt = onePole(sr, s.attackMs / 1000);
    this.kRel = onePole(sr, s.releaseMs / 1000);
    this.kVent = onePole(sr, s.ventMs / 1000);
    this.jets = [];
    for (i = 0; i < s.jets.length; i++) {
      var j = s.jets[i];
      this.jets.push({
        tune: j.tune || 1, pl: Math.sqrt(0.5 * (1 - j.pan)), pr: Math.sqrt(0.5 * (1 + j.pan)),
        roar: new Biquad(), shock: new Biquad(), fl: 0, g: 1
      });
    }
    this.rumbleLp = new Biquad();
    this.rumbleLp.set('lowpass', s.rumbleHz, 0.8, 0, sr);
    this.hpL = new Biquad(); this.hpR = new Biquad();
    this.hpL.set('highpass', 26, 0.707, 0, sr); this.hpR.set('highpass', 26, 0.707, 0, sr);
    this.cabL = new Biquad(); this.cabR = new Biquad();
    this.shockAmt = 0;
    this.drive = 1;
    this.driveNorm = 1;
    // The whole row surges together (big eddies, the pressure regulator).
    this.sSlow = 0; this.sFast = 0; this.surge = 1;
    // Crackle: sharp positive pressure jumps that die away in a millisecond
    // or two, coming in clusters (a tearing sound, not a patter).
    this.crk = 0; this.crkP = 0; this.crkLp = 0; this.crkI = 0;
    this.crkPl = this.crkPr = Math.SQRT1_2;
    this.crkDecay = Math.exp(-1 / (sr * 0.0012));
    this.crkHpK = 1 - Math.exp(-TWO_PI * 250 / sr);
    // Thump as the valves open from rest: a short, low "whump".
    this.thPh = 0; this.thEnv = 0; this.thAtt = 0; this.armed = true;
    this.thDecay = Math.exp(-1 / (sr * 0.06));
    this.kThAtt = onePole(sr, 0.004);
    var rd = [0.0073, 0.0111, 0.0097, 0.0137];
    this.room = [];
    for (i = 0; i < 4; i++) this.room.push({ buf: new Float32Array(Math.round(rd[i] * sr)), pos: 0, lp: 0 });
  };

  ThrusterDSP.prototype.message = function (msg) {
    if (!msg) return;
    if (msg.type === 'params') {
      var t = this.target;
      if (typeof msg.load === 'number') t.load = msg.load;
      if (typeof msg.rev === 'number') t.rev = msg.rev;
      if (typeof msg.character === 'number') t.character = msg.character;
      if (typeof msg.crackle === 'number') t.crackle = clamp(msg.crackle, 0, 1);
    } else if (msg.type === 'config') {
      this.configure(msg.config);
    }
    // No ignition, exhaust, gear lever or clutch: cut, click and clutch don't apply.
  };

  ThrusterDSP.prototype._updateBlock = function () {
    var s = this.s, sr = this.sr, t = this.target, r = this.rng, k;
    this.character += (t.character - this.character) * 0.05;
    var ch = this.character;
    // The pedal; the accelerator is ignored through the start-up.
    this.demand = thrustDemand(this.age < THRUST_START_S * sr ? 0 : t.load, t.rev, s.onset);
    this.want = Math.pow(this.demand, s.curve);

    // Opening hard from rest: one soft thump.
    this.slow += (this.want - this.slow) * 0.017;   // about 0.15 s
    if (this.armed && this.want - this.slow > 0.2) {
      this.thEnv = s.thump * Math.min(1, (this.want - this.slow) * 1.5);
      this.thAtt = 0;
      this.thPh = 0;
      this.armed = false;
    }
    if (this.lvl < 0.02 && this.want < 0.02) this.armed = true;

    var p = this.press, rough = 0.5 + ch;
    var roarHz = lerp(s.roarHz[0], s.roarHz[1], p), shockHz = lerp(s.shockHz[0], s.shockHz[1], p);
    for (k = 0; k < this.jets.length; k++) {
      var j = this.jets[k];
      j.roar.set('bandpass', roarHz * j.tune, s.roarQ, 0, sr);
      j.shock.set('bandpass', shockHz * j.tune, s.shockQ, 0, sr);
      // Turbulence: each jet's strength wanders at random (about 4 Hz);
      // the one-pole leaves it a spread of about 0.19.
      j.fl += 0.065 * (r.gauss() - j.fl);
      j.g = Math.max(0.2, 1 + s.flutter * rough * j.fl / 0.19);
    }
    // The whole row surges together, slowly (about 1.5 Hz) and quicker
    // (about 9 Hz), at random: never a regular beat.
    this.sSlow += 0.025 * (r.gauss() - this.sSlow);
    this.sFast += 0.15 * (r.gauss() - this.sFast);
    this.surge = Math.max(0.15, 1 + s.surge * rough * (0.8 * this.sSlow / 0.112 + 0.6 * this.sFast / 0.29));
    // More character: more shock hiss, more bite, a brighter cabin.
    this.shockAmt = s.shock * (0.6 + 0.6 * ch);
    var cab = lerp(s.cabinHz[0], s.cabinHz[1], ch);
    this.cabL.set('lowpass', cab, 0.7, 0, sr);
    this.cabR.set('lowpass', cab, 0.7, 0, sr);
    this.drive = 1 + (s.drive - 1) * (0.4 + 0.6 * ch);
    this.driveNorm = 1 / softClip(this.drive * 0.6) * 0.6;
    // Cracks per sample: grows with the thrust and with Crackle, and comes
    // in clusters (a random intensity, squared; it averages out to 1).
    this.crkI += 0.04 * (r.gauss() - this.crkI);
    var burst = Math.max(0, this.crkI / 0.143);
    this.crkP = s.crackle * t.crackle * this.lvl * this.lvl * 2 * burst * burst / sr;
  };

  ThrusterDSP.prototype.process = function (outL, outR, n) {
    var sr = this.sr, s = this.s, r = this.rng, jets = this.jets, nj = jets.length;
    var startN = THRUST_START_S * sr;
    for (var i = 0; i < n; i++) {
      if (this.age < startN) this.age++;
      if (this.blockPos === 0) this._updateBlock();
      this.blockPos = (this.blockPos + 1) % BLOCK;

      var w = this.want, d = this.demand;
      this.lvl += (w - this.lvl) * (w > this.lvl ? this.kAtt : this.kRel);
      this.hiss += (w - this.hiss) * (w > this.hiss ? this.kAtt : this.kVent);
      this.press += (d - this.press) * (d > this.press ? this.kAtt : this.kRel);

      // s.floor: a soft, barely there hiss while the valves are shut.
      var aRoar = this.lvl * this.surge, aShock = this.hiss * this.surge * this.shockAmt, aFloor = aRoar + s.floor;
      var L = 0, R = 0;
      for (var k = 0; k < nj; k++) {
        var j = jets[k];
        var y = (j.roar.process(r.white()) * aFloor + j.shock.process(r.white()) * aShock) * j.g;
        L += y * j.pl; R += y * j.pr;
      }
      // The body's rumble, from all four at once.
      var rb = this.rumbleLp.process(r.white()) * s.rumble * aRoar;
      L += rb; R += rb;

      // Thump: a low sine that starts softly (no click) and dies away.
      if (this.thEnv > 1e-4) {
        this.thAtt += (1 - this.thAtt) * this.kThAtt;
        this.thPh += 52 / sr;
        if (this.thPh >= 1) this.thPh -= 1;
        var th = Math.sin(TWO_PI * this.thPh) * this.thEnv * this.thAtt;
        this.thEnv *= this.thDecay;
        L += th; R += th;
      }

      // Crackle: now and then a sharp jump, somewhere along the row; mostly
      // small, now and then a bigger one.
      if (this.crkP > 0 && r.next() < this.crkP) {
        var u = r.next();
        this.crk = s.crackGain * this.lvl * (0.25 + 0.75 * u * u * u);
        var cp = 1.4 * (r.next() - 0.5);
        this.crkPl = Math.sqrt(0.5 * (1 - cp));
        this.crkPr = Math.sqrt(0.5 * (1 + cp));
      }
      if (this.crk > 1e-5) {
        var cx = this.crk * (0.6 + 0.4 * r.next());
        this.crk *= this.crkDecay;
        this.crkLp += this.crkHpK * (cx - this.crkLp);
        var c = cx - this.crkLp;
        L += c * this.crkPl; R += c * this.crkPr;
      }

      L = this.cabL.process(this.hpL.process(L));
      R = this.cabR.process(this.hpR.process(R));
      L = softClip(L * this.drive) * this.driveNorm;
      R = softClip(R * this.drive) * this.driveNorm;

      // Cabin reflections, as for the engines.
      var rm = this.room, rl = 0, rr = 0;
      for (var q = 0; q < 4; q++) {
        var dl = rm[q], inp = (q & 1 ? R : L);
        var o = dl.buf[dl.pos];
        dl.lp += 0.35 * (o - dl.lp);
        dl.buf[dl.pos] = inp + dl.lp * 0.42;
        dl.pos = (dl.pos + 1) % dl.buf.length;
        if (q < 2) rl += dl.lp; else rr += dl.lp;
      }
      outL[i] = (L + rl * 0.22) * s.gain;
      outR[i] = (R + rr * 0.22) * s.gain;
    }
  };

  // The synthesizer for a car's engine block.
  EngineDSP.create = function (sampleRate, engineCfg, seed) {
    if (engineCfg.type === 'thruster') return new ThrusterDSP(sampleRate, engineCfg, seed);
    if (engineCfg.type === 'electric') return new ElectricDSP(sampleRate, engineCfg, seed);
    if (engineCfg.type === 'haunted') return new HauntedDSP(sampleRate, engineCfg, seed);
    return new EngineDSP(sampleRate, engineCfg, seed);
  };
  EngineDSP.thrust = thrustDemand;
  EngineDSP.thrustStartS = THRUST_START_S;

  return EngineDSP;
})();

if (typeof registerProcessor === 'function') {
  registerProcessor('engine-processor', class extends AudioWorkletProcessor {
    constructor(options) {
      super();
      var o = options.processorOptions;
      this.dsp = EngineDSP.create(sampleRate, o.config, o.seed);
      this.port.onmessage = (e) => this.dsp.message(e.data);
    }
    process(inputs, outputs) {
      var out = outputs[0];
      this.dsp.process(out[0], out[1] || out[0], out[0].length);
      return true;
    }
  });
} else if (typeof window !== 'undefined') {
  window.EngineDSP = EngineDSP;
}
