/*
 * vehicle.js — virtual drivetrain.
 *
 * Turns road speed into what a combustion car would be doing at that speed:
 * gear, engine rpm, combustion load, overrun and ignition cut. Road speed
 * comes either from GPS (with throttle estimated from acceleration) or from a
 * small physics model driven by the on-screen pedals (test-drive mode).
 */
(function (global) {
  'use strict';

  var G = 9.81;
  var RHO = 1.2;
  var TWO_PI = Math.PI * 2;

  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function follow(dt, tau) { return 1 - Math.exp(-dt / tau); }
  function smoothstep(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }

  var START_CRANK_S = 0.9;
  var START_CATCH_S = 1.3;
  var START_DONE_S = 2.6;
  // Test drive: below this speed the Gas pedal's hold zone pulls away gently
  // instead of holding (holding a standstill would just sit there).
  var HOLD_MIN_MPS = 10 / 3.6;
  // Test drive: the drive fades out over the last rpm below the limiter, and
  // an engine held inside this band counts as sitting on it.
  var LIMIT_BAND_RPM = 60;

  function Vehicle(car) {
    this.e = car.engine;
    this.p = car.vehicle;
    // Electric motor: one fixed gear, no idle, no start-up, regen instead of overrun.
    this.electric = car.engine.type === 'electric';
    this.intensity = 0.5;
    this.reset();
    this.running = false;
  }

  Vehicle.prototype.reset = function () {
    this.speed = 0;
    this.accel = 0;
    this.gear = 1;
    this.neutral = true;
    this.rpm = 0;
    this.throttle = 0;
    this.revPedal = 0;
    this.load = 0;
    this.driveLoad = 0;
    this.overrun = 0;
    this.heat = 0;
    this.cut = 0;
    this.shift = null;
    this.sinceShift = 10;
    this.blip = 0;
    this.limiterCut = false;
    this.time = 0;
    this.startT = 0;
    this.clicks = [];      // gear lever clicks (strengths) for the synthesizer; the page drains it
    this.leverT = -10;
    this.clutch = 0;
    this.holdSpeed = 0;    // test drive: the speed being held, 0 when not holding
  };

  Vehicle.prototype.start = function () {
    this.reset();
    this.running = true;
  };

  Vehicle.prototype.stop = function () {
    this.running = false;
  };

  // Bring the car to a standstill in place (used before the demo run).
  Vehicle.prototype.park = function () {
    this.speed = 0;
    this.accel = 0;
    this.gear = 1;
    this.shift = null;
  };

  Vehicle.prototype.gearRpm = function (gear) {
    var p = this.p;
    return this.speed / p.tireCircumferenceM * 60 * p.ratios[gear - 1] * p.finalDrive;
  };

  Vehicle.prototype.torqueAt = function (rpm) {
    var x = (rpm - this.e.peakTorqueRpm) / 4000;
    return this.e.peakTorqueNm * clamp(1 - 0.7 * x * x, 0.45, 1);
  };

  Vehicle.prototype.gearLabel = function () {
    if (this.electric) return 'D';
    return this.neutral ? 'N' : String(this.gear);
  };

  // GPS mode: how hard would the virtual car's driver be pressing the pedal to
  // match the measured acceleration? "intensity" makes it more eager.
  Vehicle.prototype._estimateThrottle = function (v, a) {
    var p = this.p;
    if (a < -0.25) return 0;
    var resist = 0.5 * RHO * p.cdA * v * v / p.massKg + p.crr * G;
    var aMax = Math.min(p.maxAccel, p.peakPowerKw * 1000 * p.drivetrainEff / (p.massKg * Math.max(v, 4)));
    var sensitivity = lerp(1.2, 3.2, this.intensity);
    return clamp((a + resist) / aMax * sensitivity, 0, 1);
  };

  // Test-drive mode: integrate speed from engine torque, drag and brakes.
  Vehicle.prototype._physics = function (dt, brake) {
    var p = this.p, e = this.e, v = this.speed;
    var ratio = p.ratios[this.gear - 1] * p.finalDrive;
    var rWheel = p.tireCircumferenceM / TWO_PI;
    var force = 0;
    if (!this.neutral && this.electric) {
      // Full force from a standstill, then constant power. Off the
      // accelerator the motor regenerates (one-pedal driving).
      force = this.driveLoad * Math.min(p.maxAccel * p.massKg, p.peakPowerKw * 1000 * p.drivetrainEff / Math.max(v, 1));
      if (this.throttle < 0.05 && v > 0.5) force -= p.regenDecel * p.massKg;
    } else if (!this.neutral) {
      // The limiter cuts the drive as the wheels bring the engine up to it,
      // so in top gear the car tops out there instead of the revs staying
      // pinned while the speed keeps climbing.
      var fuel = clamp((e.limiterRpm - this.gearRpm(this.gear)) / LIMIT_BAND_RPM, 0, 1);
      force = this.torqueAt(this.rpm) * this.driveLoad * fuel * ratio * p.drivetrainEff / rWheel;
      if (this.throttle < 0.05 && v > 0.5) {
        force -= e.engineBrakeNm * ratio / rWheel * clamp(this.rpm / e.redlineRpm, 0.2, 1);
      }
    }
    if (v > 0.05) force -= 0.5 * RHO * p.cdA * v * v + p.crr * p.massKg * G;
    force -= brake * p.massKg * 9;
    var a = Math.min(force / p.massKg, p.maxAccel);
    v += a * dt;
    if (v <= 0) { v = 0; a = Math.max(a, 0); }
    if (p.maxSpeedKmh && v >= p.maxSpeedKmh / 3.6) { v = p.maxSpeedKmh / 3.6; a = Math.min(a, 0); }
    this.speed = v;
    this.accel = a;
  };

  Vehicle.prototype._startShift = function (to) {
    var up = to > this.gear;
    if (this.p.gearbox === 'manual') {
      this._startHandShift(to, up);
      return;
    }
    this.shift = {
      up: up,
      t: 0,
      dur: up ? lerp(0.4, 0.2, this.throttle) : 0.3,
      from: this.rpm,
      hard: up && this.throttle > 0.6
    };
    this.gear = to;
    this.sinceShift = 0;
    if (!up) this.blip = 0.18; // rev-matching throttle blip
  };

  // Manual gearbox: lift off, clutch down, move the lever, let the clutch
  // back out. While the clutch is down the engine runs free, so the revs
  // audibly fall away between gears; on the way down the driver blips the
  // throttle (heel-and-toe) to bring the revs up to the lower gear. No
  // ignition cut is involved.
  Vehicle.prototype._startHandShift = function (to, up) {
    var thr = this.throttle;
    var lift = 0.05;                                     // throttle closes, clutch goes down
    var bite = lift + (up ? lerp(0.36, 0.22, thr) : 0.3); // clutch starts to bite
    this.shift = {
      up: up,
      manual: true,
      t: 0,
      dur: bite + (up ? lerp(0.18, 0.1, thr) : 0.2),    // engine caught by the new gear
      from: this.rpm,
      hard: false,
      lift: lift,
      blipEnd: up ? 0 : 0.25,                            // heel-and-toe blip
      bite: bite,
      biteRpm: -1
    };
    this.gear = to;
    this.sinceShift = 0;
  };

  Vehicle.prototype._handShiftRpm = function (dt, rpm, tgt, idle) {
    var sh = this.shift;
    if (sh.t < sh.lift) return rpm;
    if (sh.t < sh.bite) {
      if (sh.t < sh.blipEnd) return rpm + (tgt * 1.04 - rpm) * follow(dt, 0.07);
      return Math.max(idle, rpm - Math.max(1500, rpm * 0.55) * dt);
    }
    // The clutch drags the engine onto the new gear's speed.
    if (sh.biteRpm < 0) sh.biteRpm = rpm;
    return sh.biteRpm + (tgt - sh.biteRpm) * smoothstep((sh.t - sh.bite) / (sh.dur - sh.bite));
  };

  // One click per shift: the lever going into the new gear, early while the
  // clutch is down (after the blip on a downshift).
  Vehicle.prototype._handShiftClicks = function (t0, t1) {
    var sh = this.shift, into = sh.up ? sh.lift + 0.2 * (sh.bite - sh.lift) : sh.blipEnd + 0.03;
    if (t0 < into && t1 >= into) this._lever(1);
  };

  Vehicle.prototype._lever = function (strength) {
    if (this.running && this.startT >= START_DONE_S && this.clicks.length < 8) this.clicks.push(strength);
  };

  Vehicle.prototype._autoShift = function (braking) {
    if (this.shift) return;
    var e = this.e, n = this.p.ratios.length, thr = this.throttle, I = this.intensity;
    var rpm = this.gearRpm(this.gear);
    var upRpm = lerp(e.cruiseUpshiftRpm || 1900 + 700 * I, e.upshiftRpm || e.redlineRpm - 250, Math.pow(thr, 1.3));
    // Normally a shift is followed by a short pause (longer by hand). A
    // hard-capped engine may skip it for an upshift, so the revs can never
    // run into the limiter.
    var pause = this.p.gearbox === 'manual' ? 1.3 : 0.6;
    if (this.sinceShift < pause && !(e.hardCap && this.gear < n && rpm > upRpm)) return;

    if (this.gear < n && this.accel > -0.2 && rpm > upRpm &&
        this.gearRpm(this.gear + 1) > e.idleRpm * 1.3) {
      this._startShift(this.gear + 1);
      return;
    }
    if (this.gear === 1) return;

    // Kickdown: drop as many gears as keep the engine below ~65% of redline.
    if (thr > 0.75 && rpm < e.redlineRpm * 0.55) {
      var g = this.gear;
      while (g > 1 && this.gearRpm(g - 1) < e.redlineRpm * 0.65) g--;
      if (g < this.gear) {
        this._startShift(g);
        return;
      }
    }

    // A high-revving engine can set downshiftRpm, the revs it never drops
    // below before a lower gear goes in; the road-car points sit under its idle.
    var floor = e.downshiftRpm || 0;
    var lower = this.gearRpm(this.gear - 1);
    var coasting = thr < 0.05 && this.accel < -0.3;
    if (coasting) {
      var coastRpm = Math.max(lerp(1300, 2100, I) + 400 * braking, floor);
      if (rpm < coastRpm && lower < e.redlineRpm * 0.7) this._startShift(this.gear - 1);
    } else {
      var downRpm = Math.max(lerp(1050, 3000 + 600 * I, thr), floor);
      if (rpm < downRpm && lower < upRpm - 250) this._startShift(this.gear - 1);
    }
  };

  Vehicle.prototype._updateRpm = function (dt, idle) {
    var e = this.e, rpm = this.rpm;

    if (!this.running) {
      this.rpm = Math.max(0, rpm - Math.max(rpm * 2.5, 300) * dt);
      return;
    }

    if (this.electric) {
      // Geared straight to the wheels.
      this.rpm = rpm + (this.gearRpm(1) - rpm) * follow(dt, 0.06);
      return;
    }

    if (this.startT < START_DONE_S) {
      var t = this.startT;
      if (t < START_CRANK_S) {
        rpm = 230 + 60 * Math.sin(t * TWO_PI * 6);
      } else if (t < START_CATCH_S) {
        rpm = Math.min(1500, rpm + 4500 * dt);
      } else {
        rpm += (idle - rpm) * follow(dt, 0.35);
      }
      this.rpm = rpm;
      return;
    }

    if (this.neutral) {
      // Free revving: unloaded engine, quick to spin up, slower to fall.
      var pedal = this.revPedal;
      // Aim past the limiter so the revs reach it and bounce off the cut (a
      // hard cap still keeps them from going past it).
      var target = idle + pedal * (e.limiterRpm + (e.softLimiter ? 0 : 200) - idle);
      if (this.limiterCut) {
        rpm -= 4500 * dt;
      } else if (rpm < target) {
        rpm = Math.min(target, rpm + (2500 + 9000 * pedal) * dt);
      } else {
        rpm = Math.max(target, rpm - Math.max(1200, rpm * 0.9) * dt);
      }
      if (e.hardCap || e.softLimiter) rpm = Math.min(rpm, e.limiterRpm);
      // A soft limiter holds the revs at the limit instead of bouncing off a cut.
      if (rpm >= e.limiterRpm && !e.softLimiter) this.limiterCut = true;
      else if (rpm < e.limiterRpm - 250) this.limiterCut = false;
      this.rpm = rpm;
      return;
    }

    var wheel = this.gearRpm(this.gear);
    var slip = 0;
    if (this.gear <= 2) slip = idle + this.throttle * (e.launchRpm - idle) * (this.gear === 1 ? 1 : 0.5);
    var tgt = Math.max(wheel, idle, slip);
    if (this.shift && this.shift.manual) {
      rpm = this._handShiftRpm(dt, rpm, tgt, idle);
    } else if (this.shift) {
      rpm = this.shift.from + (tgt - this.shift.from) * smoothstep(this.shift.t / this.shift.dur);
    } else {
      rpm += (tgt - rpm) * follow(dt, 0.06);
    }
    // Top gear flat out holds the engine just under the limiter (the drive
    // fades out there); cap it and bounce off the cut.
    if (rpm >= e.limiterRpm - LIMIT_BAND_RPM) {
      rpm = e.limiterRpm;
      this.limiterCut = !e.softLimiter && (this.time * 12) % 1 < 0.4;
    } else {
      this.limiterCut = false;
    }
    this.rpm = rpm;
  };

  /*
   * input: { source: 'gps' | 'demo', speed, accel   (gps)
   *                                  gas, brake      (demo, 0..1)
   *                                  hold            (demo: keep the current speed)
   *          rev (0..1, free-rev pedal used while stationary) }
   */
  Vehicle.prototype.update = function (dt, input) {
    var e = this.e;
    this.time += dt;
    if (this.running) this.startT += dt;
    this.sinceShift += dt;
    if (this.blip > 0) this.blip -= dt;
    if (this.shift) {
      var t0 = this.shift.t;
      this.shift.t += dt;
      if (this.shift.manual) this._handShiftClicks(t0, this.shift.t);
      if (this.shift.t >= this.shift.dur) this.shift = null;
    }

    var demand, braking, wasNeutral = this.neutral;
    if (input.source === 'demo') {
      braking = input.brake || 0;
      if (input.hold && !braking && (this.holdSpeed || this.speed >= HOLD_MIN_MPS)) {
        // Hold the speed the car had when the hold began, on the light
        // throttle steady cruising takes (the same as on GPS).
        if (!this.holdSpeed) this.holdSpeed = this.speed;
        this.speed = this.holdSpeed;
        this.accel = 0;
        demand = this._estimateThrottle(this.speed, 0);
        this.neutral = false;
      } else {
        this.holdSpeed = 0;
        demand = input.gas || 0;
        this.neutral = this.speed < 0.5 && demand < 0.05;
        this._physics(dt, braking);
      }
    } else {
      this.speed = input.speed;
      this.accel = input.accel;
      demand = this._estimateThrottle(this.speed, this.accel);
      braking = this.accel < -2.5 ? 1 : 0;
      this.neutral = this.speed < 0.5;
    }
    // Manual: into first to pull away, back to neutral at a stop. Rate-limited,
    // so creeping in traffic doesn't rattle the lever.
    if (this.p.gearbox === 'manual' && this.neutral !== wasNeutral && this.time - this.leverT > 1.5) {
      this.leverT = this.time;
      this._lever(this.neutral ? 0.6 : 1);
    }
    this.throttle += (demand - this.throttle) * follow(dt, demand > this.throttle ? 0.12 : 0.25);
    var rev = this.neutral && !this.electric ? (input.rev || 0) : 0;
    this.revPedal += (rev - this.revPedal) * follow(dt, rev > this.revPedal ? 0.06 : 0.1);

    if (this.neutral) {
      this.gear = 1;
      this.shift = null;
    } else {
      this._autoShift(braking);
    }

    var idle = e.idleRpm + 18 * Math.sin(this.time * 4.1) + 10 * Math.sin(this.time * 9.7);
    this._updateRpm(dt, idle);
    if (this.electric) {
      this._electricOutput(input);
      return;
    }

    // What the synthesizer hears.
    var pedal = this.neutral ? this.revPedal : this.throttle;
    var load = pedal, cut = 0, driveLoad = pedal;
    var sh = this.shift;
    if (sh && sh.manual) {
      // Off the throttle while the clutch is down; the throttle comes back in
      // quickly as the clutch bites, so the engine audibly catches.
      var bite = sh.t < sh.bite ? 0 : smoothstep((sh.t - sh.bite) / 0.05);
      load = pedal * bite;
      driveLoad = pedal * bite;
      if (sh.t >= sh.lift && sh.t < sh.blipEnd) load = 0.7; // heel-and-toe blip
    } else if (sh && sh.up && sh.t < sh.dur * 0.75) {
      load = 0;
      driveLoad = 0;
      if (sh.hard) cut = 1; // full-throttle upshift: ignition cut → crack
    }
    // 1 while a hand shift has the clutch down.
    this.clutch = this.running && sh && sh.manual && sh.t >= sh.lift && sh.t < sh.bite ? 1 : 0;
    if (this.blip > 0) load = Math.max(load, 0.55);
    // Soft limiter: ease the combustion off over the last 300 rpm.
    if (e.softLimiter) load *= lerp(1, 0.55, clamp((this.rpm - e.limiterRpm + 300) / 300, 0, 1));
    // Rev limiter: only the ignition cuts. The throttle stays wide open, so
    // the engine screams again the moment it fires between the cuts.
    if (this.limiterCut) cut = 1;
    if (!this.running) {
      load = 0;
      cut = 0;
    } else if (this.startT < START_DONE_S) {
      var t = this.startT;
      load = t < START_CRANK_S ? 0.02 : t < START_CATCH_S ? 0.6 : 0.6 * (1 - (t - START_CATCH_S) / (START_DONE_S - START_CATCH_S));
    }
    var idleLoad = this.running ? 0.12 * clamp(1 - (this.rpm - e.idleRpm) / 1500, 0, 1) : 0;
    this.load = cut && !this.limiterCut ? 0 : Math.max(load, idleLoad);
    this.driveLoad = driveLoad;
    this.cut = cut;
    // Afterfire needs unburnt fuel in a hot exhaust: it is strongest right
    // after lifting off from hard driving and fades within a few seconds as
    // the exhaust cools and the ECU cuts fuel on overrun.
    var rpmN = clamp((this.rpm - e.idleRpm) / (e.redlineRpm - e.idleRpm), 0, 1);
    var fuel = this.running ? (this.blip > 0 ? Math.max(pedal, 0.55) : pedal) * (0.3 + 0.7 * rpmN) : 0;
    this.heat += (fuel - this.heat) * follow(dt, fuel > this.heat ? 1 : 2.5);
    // Holding a steady speed is light throttle, not a closed one.
    var holding = this.holdSpeed > 0 || (input.source === 'gps' && !this.neutral && this.accel > -0.25);
    this.overrun = this.running && pedal < 0.06 && this.blip <= 0 && !holding
      ? clamp((this.rpm - e.idleRpm - 500) / 1500, 0, 1) * clamp(this.heat * 1.5, 0, 1)
      : 0;
  };

  // What the synthesizer hears from an electric motor: load is the
  // accelerator beyond what holding the current speed takes, so a steady
  // speed stays quiet and the buzz only swells while speeding up. overrun (1)
  // means regen: rolling with the foot off, lifting off or braking. On GPS,
  // holding a steady speed is not regen, and the switch has some hysteresis
  // so GPS noise can't make it flutter.
  Vehicle.prototype._electricOutput = function (input) {
    var regen = input.source === 'gps'
      ? this.accel < (this.overrun ? -0.1 : -0.3)
      : this.throttle < 0.06 && !this.holdSpeed;
    var steady = this._estimateThrottle(this.speed, 0);
    this.load = this.running ? clamp((this.throttle - steady) / Math.max(1 - steady, 0.05), 0, 1) : 0;
    this.driveLoad = this.throttle;
    this.cut = 0;
    this.clutch = 0;
    this.overrun = this.running && !this.neutral && regen ? 1 : 0;
  };

  global.Vehicle = Vehicle;
})(window);
