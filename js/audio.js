/*
 * audio.js — Web Audio plumbing around the engine synthesizer.
 *
 *   engine (AudioWorklet, or ScriptProcessor fallback)
 *     → compressor (keeps peaks in check on small car speakers)
 *     → master gain (volume + fades)
 *     → safety clipper (rounds off peaks instead of hard clipping)
 *     → speakers
 */
(function (global) {
  'use strict';

  var DSP_URL = 'js/engine-dsp.js';
  var FADE_S = 0.35;

  // Safety clipper: a waveshaper that leaves the signal untouched up to
  // CLIP_KNEE of full scale and bends anything louder smoothly towards
  // CLIP_CEIL. No oversampling: its filters ring past the ceiling on bright
  // sounds like the supercharger whine. The curve covers ±CLIP_RANGE (behind a
  // 1/CLIP_RANGE gain), since a waveshaper clamps input outside ±1.
  var CLIP_KNEE = 0.9, CLIP_CEIL = 0.98, CLIP_RANGE = 4;
  function clipCurve() {
    var n = 4097, curve = new Float32Array(n), k = CLIP_CEIL - CLIP_KNEE;
    for (var i = 0; i < n; i++) {
      var x = (i / (n - 1) * 2 - 1) * CLIP_RANGE, a = Math.abs(x);
      var y = a <= CLIP_KNEE ? a : CLIP_KNEE + k * Math.tanh((a - CLIP_KNEE) / k);
      curve[i] = x < 0 ? -y : y;
    }
    return curve;
  }

  function EngineAudio() {
    this.ctx = null;
    this.node = null;
    this.fader = null;     // the synthesizer's own gain, to fade it out on a car change
    this.ready = null;     // promise: the current car's synthesizer is built and connected
    this.engineGen = 0;    // bumped on each car change
    this.master = null;
    this.kind = '';
    this.volume = 0.8;
    this.workletLoad = null;
    this.suspendTimer = 0;
    this.post = function () {};
  }

  EngineAudio.supported = function () {
    return !!(global.AudioContext || global.webkitAudioContext);
  };

  EngineAudio.prototype._gainFor = function (v) {
    return Math.pow(Math.max(0, Math.min(1, v)), 1.6) * 1.4;
  };

  // The audio context and everything after the synthesizer, built once.
  EngineAudio.prototype._context = function () {
    if (!this.ctx) {
      var AC = global.AudioContext || global.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
      var comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.knee.value = 8;
      comp.ratio.value = 5;
      comp.attack.value = 0.003;
      comp.release.value = 0.2;
      this.master = this.ctx.createGain();
      this.master.gain.value = 0;
      comp.connect(this.master);
      var clipIn = this.ctx.createGain();
      clipIn.gain.value = 1 / CLIP_RANGE;
      var clip = this.ctx.createWaveShaper();
      clip.curve = clipCurve();
      clip.oversample = 'none';
      this.master.connect(clipIn);
      clipIn.connect(clip);
      clip.connect(this.ctx.destination);
      this.comp = comp;
    }
    return this.ctx;
  };

  // Must be called from a user gesture (click/tap) the first time.
  EngineAudio.prototype.start = function (engineCfg) {
    if (!EngineAudio.supported()) return Promise.reject(new Error('Web Audio is not supported by this browser.'));
    // iOS: play through the media channel so the ringer/silent switch doesn't mute us.
    try { if (global.navigator.audioSession) global.navigator.audioSession.type = 'playback'; } catch (e) { /* ignore */ }
    var ctx = this._context(), self = this;
    clearTimeout(this.suspendTimer);
    var resumed = ctx.state === 'running' ? Promise.resolve() : ctx.resume();
    if (!this.ready) {
      // Built once per car; a car change while it's being built discards it.
      var gen = this.engineGen;
      var ready = this.ready = this._createNode(engineCfg).then(function (synth) {
        if (gen !== self.engineGen) {
          synth.node.disconnect();
          return;
        }
        var fader = ctx.createGain();
        synth.node.connect(fader);
        fader.connect(self.comp);
        self.node = synth.node;
        self.fader = fader;
        self.post = synth.post;
      }, function (err) {
        if (self.ready === ready) self.ready = null;
        throw err;
      });
    }
    return Promise.all([resumed, this.ready]).then(function () {
      var g = self.master.gain, now = ctx.currentTime;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(self._gainFor(self.volume), now + FADE_S);
    });
  };

  // Another car: fade out its synthesizer (if any) and let the next start()
  // build one for the new car's engine block.
  EngineAudio.prototype.setEngine = function () {
    var node = this.node, fader = this.fader;
    this.engineGen++;
    this.ready = null;
    this.node = this.fader = null;
    this.post = function () {};
    if (!node) return;
    var g = fader.gain, now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + FADE_S);
    setTimeout(function () { node.disconnect(); fader.disconnect(); }, FADE_S * 1000 + 100);
  };

  // Resolves to { node, post }: the synthesizer node and how to message it.
  EngineAudio.prototype._createNode = function (engineCfg) {
    var ctx = this.ctx, self = this;
    var seed = (Math.random() * 4294967295) >>> 0;
    if (ctx.audioWorklet && global.AudioWorkletNode) {
      if (!this.workletLoad) this.workletLoad = ctx.audioWorklet.addModule(DSP_URL);
      return this.workletLoad.then(function () {
        var node = new AudioWorkletNode(ctx, 'engine-processor', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          processorOptions: { config: engineCfg, seed: seed }
        });
        self.kind = 'AudioWorklet';
        return { node: node, post: function (msg) { node.port.postMessage(msg); } };
      }).catch(function (err) {
        console.warn('AudioWorklet unavailable, using ScriptProcessor fallback:', err);
        return self._createScriptNode(engineCfg, seed);
      });
    }
    return Promise.resolve(this._createScriptNode(engineCfg, seed));
  };

  EngineAudio.prototype._createScriptNode = function (engineCfg, seed) {
    var dsp = global.EngineDSP.create(this.ctx.sampleRate, engineCfg, seed);
    var node = this.ctx.createScriptProcessor(1024, 1, 2);
    node.onaudioprocess = function (e) {
      var out = e.outputBuffer;
      dsp.process(out.getChannelData(0), out.getChannelData(1), out.length);
    };
    this.kind = 'ScriptProcessor';
    return { node: node, post: function (msg) { dsp.message(msg); } };
  };

  EngineAudio.prototype.setParams = function (p) {
    this.post({ type: 'params', rpm: p.rpm, load: p.load, overrun: p.overrun, cut: p.cut, character: p.character, crackle: p.crackle,
      whinePitch: p.whinePitch, whineLevel: p.whineLevel, speed: p.speed, rev: p.rev });
  };

  EngineAudio.prototype.setVolume = function (v) {
    this.volume = v;
    if (!this.ctx || !this.running()) return;
    this.master.gain.setTargetAtTime(this._gainFor(v), this.ctx.currentTime, 0.05);
  };

  // Gear lever click (manual gearbox); strength 1 into a gear, about 0.6 into neutral.
  EngineAudio.prototype.click = function (strength) {
    this.post({ type: 'click', strength: strength });
  };

  // Clutch down during a manual gear change (1) or not (0).
  EngineAudio.prototype.clutch = function (down) {
    this.post({ type: 'clutch', down: down });
  };

  EngineAudio.prototype.running = function () {
    return !!(this.ctx && this.node && this.ctx.state === 'running');
  };

  // Autoplay: whether the browser lets sound start now, before any tap.
  // Browsers mostly allow it only on a site that has played sound to this
  // person before. Resolves true or false; a blocked context stays suspended
  // until start() runs from a tap.
  EngineAudio.prototype.canStart = function () {
    var ctx;
    try { ctx = this._context(); } catch (e) { return Promise.resolve(false); }
    if (ctx.state === 'running') return Promise.resolve(true);
    return new Promise(function (resolve) {
      ctx.resume().then(function () { resolve(true); }, function () { resolve(false); });
      // A blocked resume() may never settle.
      setTimeout(function () { resolve(ctx.state === 'running'); }, 1000);
    });
  };

  // Fade out, then suspend the context so nothing runs in the background.
  EngineAudio.prototype.stop = function (delayS) {
    if (!this.ctx) return;
    var ctx = this.ctx, g = this.master.gain, now = ctx.currentTime, start = now + (delayS || 0);
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, start);
    g.linearRampToValueAtTime(0, start + FADE_S);
    clearTimeout(this.suspendTimer);
    this.suspendTimer = setTimeout(function () { ctx.suspend(); }, ((delayS || 0) + FADE_S) * 1000 + 50);
  };

  // Browsers may suspend audio (e.g. after the screen sleeps); a tap resumes it.
  EngineAudio.prototype.resumeIfNeeded = function () {
    if (!this.ctx || this.ctx.state === 'running') return Promise.resolve();
    // iOS only unlocks audio inside touchend/click, so also play a silent buffer then.
    try {
      var src = this.ctx.createBufferSource();
      src.buffer = this.ctx.createBuffer(1, 1, 22050);
      src.connect(this.ctx.destination);
      src.start(0);
    } catch (e) { /* ignore */ }
    return this.ctx.resume();
  };

  global.EngineAudio = EngineAudio;
})(window);
