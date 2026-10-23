/*
 * The thruster effect for a car with cold-gas thrusters (engine.type
 * 'thruster'): while the jets fire, the car's picture blasts them out of its
 * tail, a pale core with shock diamonds ("Mach diamonds") inside a billowing
 * vapour plume that the car leaves behind as it speeds up. Each time the
 * valves open, gas rolls out from the car over the whole screen, swirls and
 * hangs there for a few seconds before it thins out into wisps; while the
 * jets keep firing, more keeps rolling out.
 *
 * It follows the sound: EngineDSP.thrust turns the same load and REV pedal
 * into how hard the jets fire, so the picture blasts exactly when they roar.
 * The car says where its nozzles are on its picture (`nozzle`).
 *
 * Picking the car shows off (flip, smokeBurst): its button blows out a
 * cloud of smoke, and the car squats, fires its jets, lifts off, backflips
 * once on them (the jets turn with it and leave a ring of vapour in the
 * air) and lands with a bounce and a puff of dust.
 *
 * Drawn on one canvas over the page, which does nothing (and is cleared)
 * while there is nothing to draw.
 */
(function (global) {
  'use strict';

  var MAX_PUFFS = 320;        // plume particles at once
  var BURST_GAP_S = 0.9;      // at least this long between two bursts of gas
  var FOG_MAX = 90;           // billows of gas over the screen at once
  var FOG_COVER = 70;         // ...of them while REV is held: the screen covered
  var FOG_IN_S = 0.15;        // a billow rolls in this fast...
  var FOG_LIFE_S = [2.2, 3.8]; // ...and lives this long (new ones take its place)
  var FOG_SCALE = 3;          // the gas is drawn this many times smaller (it is soft)
  var RELEASE_S = 0.4;        // the jets shut: all the gas is gone this fast
  var MAX_FX = 480;           // smoke of the flip and the button at once
  var FLIP_S = 1.45;          // the whole flip, squat to settled
  var FLIP_LAND_S = 1.22;     // ...touching down here
  var FLIP_WAIT_S = 2;        // the car's picture has this long to load

  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function smooth(x) { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); }
  function easeInOut(x) { x = clamp(x, 0, 1); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(2 - 2 * x, 3) / 2; }

  // The flip, u seconds in: lift (car heights), turn (0..1 of a full turn),
  // squash (sx, sy) and how hard the jets fire (lv).
  function flipPose(u) {
    var lift = 0, sy = 1, lv = 0, k;
    if (u > 0.15 && u < FLIP_LAND_S) {
      if (u < 0.45) lift = 1 - Math.pow(1 - (u - 0.15) / 0.3, 3);          // blasts up
      else if (u < 1) lift = 1 + 0.12 * Math.sin(Math.PI * (u - 0.45) / 0.55); // floats over the top
      else lift = 1 - Math.pow((u - 1) / (FLIP_LAND_S - 1), 2);             // drops
      lift *= 1.15;
    }
    if (u < 0.15) sy = 1 - 0.08 * smooth(u / 0.15);                         // squats
    else if (u < 0.3) sy = 0.92 + 0.14 * smooth((u - 0.15) / 0.15);         // springs up, stretched
    else if (u < 0.45) sy = 1.06 - 0.06 * smooth((u - 0.3) / 0.15);
    else if (u > FLIP_LAND_S) {                                              // lands and bounces back
      k = (u - FLIP_LAND_S) / (FLIP_S - FLIP_LAND_S);
      sy = 1 - 0.1 * Math.sin(Math.PI * Math.min(1, k * 1.5)) * (1 - k);
    }
    if (u < 0.15) lv = 0.2 + 0.25 * Math.random();                          // the valves crack open
    else if (u < 0.98) lv = smooth((u - 0.15) / 0.07);
    else lv = 1 - smooth((u - 0.98) / 0.14);
    return { lift: lift, turn: easeInOut((u - 0.38) / 0.64), sx: 1 + (1 - sy) * 0.5, sy: sy, lv: lv, land: u >= FLIP_LAND_S };
  }

  // Soft, uneven puffs of vapour, white on transparent, drawn once: a cloud
  // of overlapping blobs inside a round falloff, so no two look alike.
  function makePuff(size) {
    var c = document.createElement('canvas');
    c.width = c.height = size;
    var g = c.getContext('2d'), h = size / 2, i;
    for (i = 0; i < 26; i++) {
      var a = Math.random() * Math.PI * 2, d = Math.pow(Math.random(), 0.7) * h * 0.5;
      var x = h + Math.cos(a) * d, y = h + Math.sin(a) * d, r = rand(0.18, 0.42) * size;
      var gr = g.createRadialGradient(x, y, 0, x, y, r);
      var o = rand(0.05, 0.16);
      gr.addColorStop(0, 'rgba(222,228,236,' + o + ')');
      gr.addColorStop(0.55, 'rgba(222,228,236,' + o * 0.45 + ')');
      gr.addColorStop(1, 'rgba(222,228,236,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, size, size);
    }
    // Round off the edges.
    g.globalCompositeOperation = 'destination-in';
    var m = g.createRadialGradient(h, h, 0, h, h, h);
    m.addColorStop(0, 'rgba(0,0,0,1)');
    m.addColorStop(0.6, 'rgba(0,0,0,0.7)');
    m.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = m;
    g.fillRect(0, 0, size, size);
    return c;
  }

  function ThrusterFx() {
    this.canvas = null;
    this.puffs = [];
    this.sprites = null;
    this.level = 0;           // how hard the jets fire, smoothed (0..1)
    this.fog = [];            // billows of gas over the screen
    this.fogCarry = 0;
    this.vis = 0;             // how much of the gas is showing (0..1)
    this.cover = 0;           // REV held: the gas covers the screen (0..1)
    this.lastBurst = -1e9;
    this.armed = true;
    this.offSince = 0;
    this.last = 0;
    this.clear = true;        // nothing on the canvas
    this.flicker = 0;
    this.fx = [];             // smoke not tied to the pedal: the flip's ring, dust, the button's cloud
    this.sparks = [];
    this.rings = [];          // the button's flash and shock rings
    this.flipping = null;     // { img, asked, t0, dusted }
    this.flipLv = 0;          // how hard the jets fire in the flip right now (0..1)
    this.calm =!!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  ThrusterFx.prototype._setup = function () {
    var c = document.createElement('canvas');
    c.setAttribute('aria-hidden', 'true');
    c.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:60';
    document.body.appendChild(c);
    this.canvas = c;
    this.g = c.getContext('2d');
    this.sprites = [makePuff(128), makePuff(128), makePuff(128), makePuff(192)];
  };

  ThrusterFx.prototype._size = function () {
    var dpr = Math.min(global.devicePixelRatio || 1, 1.5);
    var w = Math.round(global.innerWidth * dpr), h = Math.round(global.innerHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.dpr = dpr;
  };

  // Where the jets leave the picture, in canvas pixels: the picture is drawn
  // contained in its box, on the bottom edge (see .car-hero img). ang: the
  // way the jets point. During a flip (pose) this also lifts, turns and
  // squashes the picture round the middle of the car, and the nozzles and
  // jets turn with it.
  ThrusterFx.prototype._nozzle = function (img, nz, pose) {
    if (!img || !img.naturalWidth || !img.isConnected) return null;
    if (pose) img.style.transform = '';   // where the picture sits, unflipped
    var r = img.getBoundingClientRect();
    if (!r.width) return null;
    var s = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
    var w = img.naturalWidth * s, h = img.naturalHeight * s;
    var left = r.left + (r.width - w) / 2, top = r.top + r.height - h, d = this.dpr;
    var dir = nz.dir || 1, x = (left + nz.x * w) * d, y = (top + nz.y * h) * d;
    var out = { x: x, y: y, h: nz.h * h * d, carW: w * d, dir: dir, ang: dir > 0 ? 0 : Math.PI, turned: false,
      ground: { x: left * d, w: w * d, y: (top + h) * d } };
    if (pose) {
      // A backflip: the nose comes up, away from the jets.
      var rot = pose.turn * Math.PI * 2 * (dir > 0 ? 1 : -1);
      // Squashed round its middle, so lowered to keep its tyres down.
      var lift = pose.lift * h - (1 - pose.sy) * h / 2;
      img.style.transformOrigin = (left + w / 2 - r.left) + 'px ' + (top + h / 2 - r.top) + 'px';
      img.style.transform = 'translateY(' + (-lift).toFixed(2) + 'px) rotate(' + rot.toFixed(4) + 'rad) scale(' +
        pose.sx.toFixed(3) + ',' + pose.sy.toFixed(3) + ')';
      var cx = (left + w / 2) * d, cy = (top + h / 2) * d;
      var px = (x - cx) * pose.sx, py = (y - cy) * pose.sy, c = Math.cos(rot), sn = Math.sin(rot);
      out.x = cx + px * c - py * sn;
      out.y = cy - lift * d + px * sn + py * c;
      out.h *= pose.sy;
      out.ang += rot;
      out.turned = true;
    }
    return out;
  };

  // Show off: the car backflips on its thrusters (img: its picture). Waits
  // for the picture to load; a new flip starts over.
  ThrusterFx.prototype.flip = function (img) {
    this.stopFlip();
    if (this.calm || !img) return;
    this.flipping = { img: img, asked: performance.now() / 1000, t0: 0, dusted: false };
    // Over the rest of the page while it flips (the Start button sits over
    // the picture), under the dialogs and this canvas.
    if (img.parentNode) img.parentNode.style.zIndex = '40';
  };

  // Stop a flip (another car was picked) and put the picture back.
  ThrusterFx.prototype.stopFlip = function () {
    var f = this.flipping;
    if (!f) return;
    f.img.style.transform = '';
    f.img.style.transformOrigin = '';
    if (f.img.parentNode) f.img.parentNode.style.zIndex = '';
    this.flipping = null;
  };

  // Where the flip is at t (seconds), or null when there is none (yet).
  ThrusterFx.prototype._flipStep = function (t, img, nozzle) {
    var f = this.flipping;
    if (!f) return null;
    if (f.img !== img || !nozzle) { this.stopFlip(); return null; }
    if (!f.t0) {
      if (!img.complete || !img.naturalWidth) {
        if (t - f.asked > FLIP_WAIT_S) this.stopFlip();
        return null;
      }
      f.t0 = t;
    }
    var u = t - f.t0;
    if (u >= FLIP_S) { this.stopFlip(); return null; }
    return flipPose(u);
  };

  // One frame. thrust: how hard the jets fire (0..1); rev: true while that is
  // REV being held (the gas then covers the screen); speed: m/s (the car
  // leaves its vapour behind); img: the car's picture; nozzle: where its
  // jets leave it ({ x, y, h } as fractions of the picture, dir 1 = to the
  // right).
  ThrusterFx.prototype.frame = function (now, thrust, rev, speed, img, nozzle) {
    var dt = clamp((now - (this.last || now)) / 1000, 0, 0.05);
    this.last = now;
    // The valves open fast and shut a little slower.
    this.level += (thrust - this.level) * (1 - Math.exp(-dt / (thrust > this.level ? 0.04 : 0.12)));
    if (this.level < 0.003 && thrust === 0) this.level = 0;
    var t = now / 1000;
    // The gas stays as long as the jets fire; once they shut it is all gone
    // within RELEASE_S (and comes straight back if they fire again).
    this.vis = thrust > 0 ? Math.min(1, this.vis + dt / 0.08) : Math.max(0, this.vis - dt / RELEASE_S);
    if (!this.vis) { this.fog = []; this.puffs = []; this.level = 0; }
    this.cover += ((thrust > 0 && rev ? 1 : 0) - this.cover) * (1 - Math.exp(-dt / 0.2));

    // A burst of vapour over the screen each time the valves open (again).
    if (thrust < 0.01) {
      if (!this.offSince) this.offSince = t;
      if (t - this.offSince > 0.25) this.armed = true;
    } else {
      this.offSince = 0;
    }
    var fire = thrust > 0.06 && this.armed && t - this.lastBurst > BURST_GAP_S;
    if (fire) { this.armed = false; this.lastBurst = t; }

    var pose = this._flipStep(t, img, nozzle);
    this.flipLv = pose ? pose.lv : 0;
    if (!this.level && !this.puffs.length && !this.fog.length && !fire && !pose &&
        !this.fx.length && !this.sparks.length && !this.rings.length) {
      if (!this.clear) {
        this.g.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.clear = true;
      }
      return;
    }
    if (!this.canvas) this._setup();
    this._size();
    var g = this.g, W = this.canvas.width, H = this.canvas.height;
    g.clearRect(0, 0, W, H);
    this.clear = false;

    var nz = nozzle ? this._nozzle(img, nozzle, pose) : null;
    // The jets as the flip fires them, or the pedal, whichever is harder.
    var lv = Math.max(this.level, pose ? pose.lv : 0);
    if (pose && nz) {
      this._emit(dt, nz, pose.lv, true);
      if (pose.land && !this.flipping.dusted) {
        this.flipping.dusted = true;
        this._dust(nz.ground);
      }
    }
    if (!this.calm && thrust > 0) {
      if (fire) this._addFog(t, nz, W, H, 30, 0.45, false);
      if (rev) {
        // REV held: the gas fills the whole screen, rolling in within about
        // half a second, and new billows keep taking the old ones' place.
        var want = FOG_COVER - this.fog.length;
        if (want > 0) this._addFog(t, nz, W, H, Math.min(want, Math.ceil(160 * dt)), 0.3, true);
      } else {
        // While the jets keep firing, more gas keeps rolling out.
        this.fogCarry += this.level > 0.3 ? this.level * 7 * dt : 0;
        if (this.fogCarry >= 1) {
          this._addFog(t, nz, W, H, Math.floor(this.fogCarry), 0, false);
          this.fogCarry %= 1;
        }
      }
    }
    if (nz) this._emit(dt, nz, this.level, false);
    this._drawPlume(g, dt, nz, speed);
    if (this.fx.length) this._drawFx(g, dt);
    if (nz && lv > 0.01) this._drawJet(g, nz, lv);
    if (this.fog.length) this._drawFog(g, t, dt, W, H);
    if (this.sparks.length || this.rings.length) this._drawBlast(g, dt);
  };

  // How long the jet is (canvas px) at level lv, kept within the room beside
  // the car so its cloud still forms on the screen (not while it flips).
  ThrusterFx.prototype._jetLen = function (nz, lv) {
    var full = nz.h * (7 + 13 * lv);
    if (nz.turned) return Math.min(full, nz.carW * 0.9);
    var room = nz.dir > 0 ? this.canvas.width - nz.x : nz.x;
    return Math.min(full, Math.max(nz.h * 4, room * 0.6));
  };

  // New vapour, as much as the jets push out at level lv: a little along the
  // jet and most where it ends and blooms into a cloud. free: the flip's,
  // which hangs in the air as a ring after the jets shut.
  ThrusterFx.prototype._emit = function (dt, nz, lv, free) {
    if (lv < 0.02) return;
    var key = free ? '_carryFx' : '_carry', list = free ? this.fx : this.puffs, max = free ? MAX_FX : MAX_PUFFS;
    var n = lv * (this.calm ? 30 : free ? 130 : 80) * dt, len = this._jetLen(nz, lv), i;
    var cx = Math.cos(nz.ang), cy = Math.sin(nz.ang);
    this[key] = (this[key] || 0) + n;
    for (i = 0; i < Math.floor(this[key]) && list.length < max; i++) {
      var along = Math.pow(Math.random(), 0.8);          // 0 nozzle .. 1 tip
      var v = nz.carW * rand(0.2, 0.6) * (0.5 + lv);    // px/s, soon lost in the air
      var a = rand(-0.35, 0.35) * (0.3 + along);
      var off = rand(-0.4, 0.4) * nz.h * (0.5 + along);
      var ux = Math.cos(a) * v, uy = Math.sin(a) * v;    // along the jet, across it
      var q = {
        x: nz.x + cx * along * len - cy * off, y: nz.y + cy * along * len + cx * off,
        vx: cx * ux - cy * uy, vy: cy * ux + cx * uy,
        r: nz.h * (0.5 + 1.6 * along) * rand(0.7, 1.2), grow: nz.carW * rand(0.1, 0.22) * (0.6 + lv),
        a: rand(0.12, 0.26) * (0.5 + 0.5 * lv) * (0.35 + 0.65 * along), age: 0, life: rand(1, 2),
        sp: (Math.random() * 3) | 0, spin: rand(0, Math.PI * 2), wob: rand(0.5, 1.5)
      };
      if (free) {
        q.life = rand(1.3, 2.3);
        q.a *= 1.6;
        q.drag = 3;
        q.rise = nz.carW * 0.05;
      }
      list.push(q);
    }
    this[key] -= Math.floor(this[key]);
  };

  // Touching down: dust rolls out from under the tyres both ways.
  ThrusterFx.prototype._dust = function (gr) {
    var i, j;
    for (j = 0; j < 2; j++) {
      var x = gr.x + gr.w * (j ? 0.8 : 0.2), out = j ? 1 : -1;
      for (i = 0; i < 12 && this.fx.length < MAX_FX; i++) {
        var side = Math.random() < 0.75 ? out : -out;
        this.fx.push({
          x: x + rand(-0.05, 0.05) * gr.w, y: gr.y - rand(0, 0.03) * gr.w,
          vx: side * gr.w * rand(0.4, 1.4), vy: -gr.w * rand(0, 0.15),
          r: gr.w * rand(0.03, 0.06), grow: gr.w * rand(0.12, 0.25),
          a: rand(0.14, 0.26), age: 0, life: rand(0.8, 1.4), drag: 3.5, rise: gr.w * 0.04,
          sp: (Math.random() * 3) | 0
        });
      }
    }
  };

  // Smoke that is not the pedal's: slows down in the air, rises, swells and
  // fades on its own clock (the jets shutting does not clear it).
  ThrusterFx.prototype._drawFx = function (g, dt) {
    var p = this.fx, sp = this.sprites, keep = [], i;
    g.save();
    for (i = 0; i < p.length; i++) {
      var q = p[i];
      q.age += dt;
      if (q.age >= q.life) continue;
      var drag = Math.exp(-dt * q.drag);
      q.vx *= drag;
      q.vy = q.vy * drag - q.rise * dt;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      q.r += q.grow * dt;
      var al = q.a * smooth(q.age / 0.05) * Math.pow(1 - q.age / q.life, 1.4);
      keep.push(q);
      if (al < 0.004) continue;
      g.globalAlpha = al;
      g.drawImage(sp[q.sp], q.x - q.r, q.y - q.r, q.r * 2, q.r * 2);
    }
    g.restore();
    this.fx = keep;
  };

  // The car is picked: an explosion of smoke out of its button (el). A flash
  // and a shock ring, fast wisps and sparks shooting out, a cloud that
  // swells and rolls out, and slow billows that hang around and rise.
  ThrusterFx.prototype.smokeBurst = function (el) {
    if (!el || !el.getBoundingClientRect) return;
    if (!this.canvas) this._setup();
    this._size();
    var r = el.getBoundingClientRect(), d = this.dpr;
    if (!r.width) return;
    var x = (r.left + r.width / 2) * d, y = (r.top + r.height / 2) * d;
    var S = Math.max(r.width, r.height) * d * 0.5, bw = r.width * d * 0.4, bh = r.height * d * 0.3;
    var self = this, i;
    function puff(n, v, drag, rad, grow, a, life, rise) {
      for (i = 0; i < n && self.fx.length < MAX_FX; i++) {
        var ang = Math.random() * Math.PI * 2, sp = S * rand(v[0], v[1]);
        self.fx.push({
          x: x + rand(-1, 1) * bw, y: y + rand(-1, 1) * bh,
          vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp * 0.8,
          r: S * rand(rad[0], rad[1]), grow: S * rand(grow[0], grow[1]),
          a: rand(a[0], a[1]), age: 0, life: rand(life[0], life[1]), drag: drag, rise: S * rise,
          sp: (Math.random() * 4) | 0
        });
      }
    }
    if (this.calm) {
      puff(8, [0.3, 0.8], 2, [0.3, 0.5], [0.2, 0.4], [0.12, 0.2], [1, 1.5], 0.2);
      return;
    }
    this.rings.push({ x: x, y: y, age: 0, life: 0.22, r: S * 1.6, flash: true });
    this.rings.push({ x: x, y: y, age: 0, life: 0.5, r0: S * 0.4, r1: S * 3.4, w: S * 0.2 });
    this.rings.push({ x: x, y: y, age: -0.07, life: 0.6, r0: S * 0.3, r1: S * 2.6, w: S * 0.08 });
    puff(22, [8, 14], 5, [0.1, 0.2], [0.5, 0.9], [0.45, 0.7], [0.5, 0.9], 0.1);      // wisps
    puff(50, [3, 7], 3, [0.28, 0.42], [0.7, 1.3], [0.7, 1], [1.2, 2.0], 0.3);        // the cloud
    puff(16, [0.5, 1.5], 1.5, [0.55, 0.85], [0.5, 0.9], [0.45, 0.65], [1.8, 2.7], 0.45); // billows
    for (i = 0; i < 16; i++) {
      var a = Math.random() * Math.PI * 2, v = S * rand(9, 16);
      this.sparks.push({ x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, age: 0, life: rand(0.35, 0.6), g: S * 3 });
    }
  };

  // The button's flash, shock rings and sparks, added on as light.
  ThrusterFx.prototype._drawBlast = function (g, dt) {
    var d = this.dpr, keep = [], i, q, k;
    g.save();
    g.globalCompositeOperation = 'lighter';
    for (i = 0; i < this.rings.length; i++) {
      q = this.rings[i];
      q.age += dt;
      if (q.age >= q.life) continue;
      keep.push(q);
      if (q.age < 0) continue;
      k = q.age / q.life;
      if (q.flash) {
        var fl = g.createRadialGradient(q.x, q.y, 0, q.x, q.y, q.r);
        fl.addColorStop(0, 'rgba(255,255,255,' + 0.85 * (1 - k) * (1 - k) + ')');
        fl.addColorStop(0.4, 'rgba(190,215,255,' + 0.35 * (1 - k) * (1 - k) + ')');
        fl.addColorStop(1, 'rgba(190,215,255,0)');
        g.fillStyle = fl;
        g.fillRect(q.x - q.r, q.y - q.r, q.r * 2, q.r * 2);
      } else {
        g.globalAlpha = 0.55 * Math.pow(1 - k, 1.5);
        g.strokeStyle = 'rgb(215,232,255)';
        g.lineWidth = q.w * (1 - k) + d;
        g.beginPath();
        g.arc(q.x, q.y, q.r0 + (q.r1 - q.r0) * (1 - Math.pow(1 - k, 3)), 0, Math.PI * 2);
        g.stroke();
        g.globalAlpha = 1;
      }
    }
    this.rings = keep;
    keep = [];
    g.strokeStyle = 'rgb(205,228,255)';
    g.lineCap = 'round';
    g.lineWidth = 1.6 * d;
    for (i = 0; i < this.sparks.length; i++) {
      q = this.sparks[i];
      q.age += dt;
      if (q.age >= q.life) continue;
      keep.push(q);
      var drag = Math.exp(-dt * 3.5);
      q.vx *= drag;
      q.vy = q.vy * drag + q.g * dt;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      g.globalAlpha = 0.9 * (1 - q.age / q.life);
      g.beginPath();
      g.moveTo(q.x - q.vx * 0.035, q.y - q.vy * 0.035);
      g.lineTo(q.x, q.y);
      g.stroke();
    }
    g.restore();
    this.sparks = keep;
  };

  // The plume: puffs slow down in the air, swell, drift up a little, wander
  // and fade; a moving car leaves them behind.
  ThrusterFx.prototype._drawPlume = function (g, dt, nz, speed) {
    var p = this.puffs, sp = this.sprites, keep = [], i;
    var wind = nz ? nz.dir * nz.carW * clamp(speed / 25, 0, 1.2) : 0;
    var drag = Math.exp(-dt * 3);
    g.save();
    for (i = 0; i < p.length; i++) {
      var q = p[i];
      q.age += dt;
      if (q.age >= q.life) continue;
      q.vx = q.vx * drag + wind * (1 - drag);
      q.vy = q.vy * drag - (nz ? nz.carW : 400) * 0.03 * dt;
      q.vy += Math.sin(q.age * 6 * q.wob + q.spin) * (nz ? nz.h : 10) * 6 * dt;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      q.r += q.grow * dt;
      var u = q.age / q.life;
      var al = q.a * smooth(q.age / 0.06) * Math.pow(1 - u, 1.6) * this.vis;
      if (al < 0.004) { keep.push(q); continue; }
      g.globalAlpha = al;
      var s = q.r * 2;
      g.drawImage(sp[q.sp], q.x - q.r, q.y - q.r, s, s);
      keep.push(q);
    }
    g.restore();
    this.puffs = keep;
  };

  // The jet itself: a pale blue core that tapers away from the nozzle, a
  // glow around it, and a row of bright shock diamonds that flicker. More
  // pressure: a longer jet with longer shock cells. Drawn along the jet (it
  // points nz.ang), at level lv.
  ThrusterFx.prototype._drawJet = function (g, nz, lv) {
    var h = nz.h, d = 1;
    this.flicker = 0.85 + Math.random() * 0.15;
    var len = this._jetLen(nz, lv) * (0.95 + Math.random() * 0.06);
    var x0 = 0, y0 = 0, x1 = len, i;
    g.save();
    g.translate(nz.x, nz.y);
    g.rotate(nz.ang);
    g.globalCompositeOperation = 'lighter';

    // Glow around the jet, widening as it goes.
    var glow = g.createLinearGradient(x0, 0, x1, 0);
    glow.addColorStop(0, 'rgba(140,185,255,' + 0.4 * lv + ')');
    glow.addColorStop(0.6, 'rgba(140,185,255,' + 0.18 * lv + ')');
    glow.addColorStop(1, 'rgba(140,185,255,0)');
    g.fillStyle = glow;
    g.beginPath();
    g.moveTo(x0, y0 - h * 0.7);
    g.quadraticCurveTo(x0 + d * len * 0.55, y0 - h * 1.5, x1, y0 - h * 0.5);
    g.lineTo(x1, y0 + h * 0.5);
    g.quadraticCurveTo(x0 + d * len * 0.55, y0 + h * 1.5, x0, y0 + h * 0.7);
    g.closePath();
    g.fill();

    // The core, bright at the nozzle.
    var core = g.createLinearGradient(x0, 0, x1, 0);
    core.addColorStop(0, 'rgba(240,248,255,' + 0.95 * lv * this.flicker + ')');
    core.addColorStop(0.3, 'rgba(200,225,255,' + 0.55 * lv + ')');
    core.addColorStop(1, 'rgba(160,200,255,0)');
    g.fillStyle = core;
    g.beginPath();
    g.moveTo(x0, y0 - h * 0.45);
    g.quadraticCurveTo(x0 + d * len * 0.5, y0 - h * 0.42, x1, y0 - h * 0.15);
    g.lineTo(x1, y0 + h * 0.15);
    g.quadraticCurveTo(x0 + d * len * 0.5, y0 + h * 0.42, x0, y0 + h * 0.45);
    g.closePath();
    g.fill();

    // Shock diamonds: bright where the jet's shock cells cross, each a
    // little further apart and fainter down the jet.
    var cell = h * (1.1 + 0.9 * lv), x = x0 + d * cell * 0.75;
    for (i = 0; i < 9; i++) {
      var f = 1 - i / 9;
      var a = 0.95 * f * f * lv * (0.75 + Math.random() * 0.25);
      if (Math.abs(x - x0) > len * 0.9 || a < 0.02) break;
      var rx = h * (0.55 - 0.03 * i), ry = h * (0.4 - 0.025 * i);
      var jx = x + (Math.random() - 0.5) * h * 0.08;
      g.fillStyle = 'rgba(255,250,225,' + a + ')';
      g.beginPath();
      g.moveTo(jx - rx, y0);
      g.lineTo(jx, y0 - ry);
      g.lineTo(jx + rx, y0);
      g.lineTo(jx, y0 + ry);
      g.closePath();
      g.fill();
      var dg = g.createRadialGradient(jx, y0, 0, jx, y0, rx * 1.8);
      dg.addColorStop(0, 'rgba(255,245,210,' + a * 0.6 + ')');
      dg.addColorStop(1, 'rgba(255,245,210,0)');
      g.fillStyle = dg;
      g.fillRect(jx - rx * 1.8, y0 - rx * 1.8, rx * 3.6, rx * 3.6);
      x += d * cell * (1 + 0.1 * i);
    }
    g.restore();
  };

  // Gas over the whole screen: n billows that roll out from the car towards
  // where they settle, the nearer ones first (spread: how long the farthest
  // waits, in seconds; 0 rolls them all out of the car now). cover: thick
  // billows that settle all over, to cover the screen.
  ThrusterFx.prototype._addFog = function (t, nz, W, H, n, spread, cover) {
    var big = Math.max(W, H), ox = nz ? nz.x : W * 0.5, oy = nz ? nz.y : H * 0.4, i;
    for (i = 0; i < n && this.fog.length < FOG_MAX; i++) {
      var tx = rand(-0.15, 1.15) * W, ty = rand(-0.15, 1.15) * H;
      var dx = tx - ox, dy = ty - oy, dl = Math.sqrt(dx * dx + dy * dy) || 1;
      // How far out it starts.
      var from = cover ? rand(0.45, 0.9) : spread ? rand(0.35, 0.75) : rand(0, 0.15);
      this.fog.push({
        t0: t + spread * Math.min(1, dl / big) + rand(0, 0.06),
        life: rand(FOG_LIFE_S[0], FOG_LIFE_S[1]),
        x: ox + dx * from, y: oy + dy * from,
        // Slowing in the air (drag 1.4/s), it comes to rest near its spot.
        vx: dx * (1 - from) * 1.4, vy: dy * (1 - from) * 1.4,
        r: big * (cover ? rand(0.16, 0.32) : rand(0.1, 0.26) * (spread ? 1 : 0.7)), grow: rand(0.12, 0.3),
        a: cover ? rand(0.45, 0.7) : spread ? rand(0.3, 0.52) : rand(0.18, 0.34),
        sp: (Math.random() * 4) | 0, rot: rand(0, Math.PI * 2), spin: rand(-0.6, 0.6),
        swirl: rand(-0.9, 0.9), ph: rand(0, Math.PI * 2)
      });
    }
  };

  // The billows slow down, turn and curl as they go, wander, swell and thin
  // out into wisps; under them a haze as thick as they are together (and
  // thick while REV covers the screen). Drawn small and stretched over the
  // screen: the gas is soft, and it saves the car's graphics a lot of work.
  ThrusterFx.prototype._drawFog = function (main, t, dt, W, H) {
    var k = 1 / FOG_SCALE, fw = Math.ceil(W * k), fh = Math.ceil(H * k);
    if (!this.fogCanvas) this.fogCanvas = document.createElement('canvas');
    var fc = this.fogCanvas;
    if (fc.width !== fw || fc.height !== fh) { fc.width = fw; fc.height = fh; }
    var g = fc.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, fw, fh);
    var big = Math.max(W, H), drag = Math.exp(-dt * 1.4), keep = [], dens = 0, i;
    var haze = Math.max(0.16 * clamp((this.fogDens || 0) / 5, 0, 1), 0.5 * this.cover) * this.vis;
    g.save();
    g.fillStyle = 'rgba(205,210,218,' + haze + ')';
    g.fillRect(0, 0, fw, fh);
    for (i = 0; i < this.fog.length; i++) {
      var q = this.fog[i], u = t - q.t0;
      if (u >= q.life) continue;
      keep.push(q);
      if (u < 0) continue;
      var c = Math.cos(q.swirl * dt), s = Math.sin(q.swirl * dt);
      var vx = q.vx * c - q.vy * s, vy = q.vx * s + q.vy * c;
      vx += Math.sin(t * 0.9 + q.ph) * big * 0.025 * dt;
      vy += Math.cos(t * 0.7 + q.ph) * big * 0.025 * dt - big * 0.012 * dt;
      q.vx = vx * drag;
      q.vy = vy * drag;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      q.r *= 1 + q.grow * dt;
      q.rot += q.spin * dt;
      var env = smooth(u / FOG_IN_S) * Math.pow(1 - u / q.life, 1.5);
      dens += q.a * env;
      g.globalAlpha = q.a * env * this.vis;
      var c2 = Math.cos(q.rot) * k, s2 = Math.sin(q.rot) * k;
      g.setTransform(c2, s2, -s2, c2, q.x * k, q.y * k);
      g.drawImage(this.sprites[q.sp], -q.r, -q.r, q.r * 2, q.r * 2);
    }
    g.restore();
    this.fog = keep;
    this.fogDens = dens;
    main.drawImage(fc, 0, 0, W, H);
  };

  global.ThrusterFx = ThrusterFx;
})(window);
