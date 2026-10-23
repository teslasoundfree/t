/*
 * gps.js — speed and acceleration from the browser's Geolocation API.
 *
 * Fixes arrive about once per second on phones and about ten times per
 * second in the Tesla browser. Acceleration is fitted over the last ~8 fixes,
 * so the window is short when fixes are frequent (quick throttle response)
 * and long when they are sparse (steady). Between fixes the speed is
 * extrapolated with the fitted acceleration so the engine sound moves
 * smoothly instead of in steps.
 */
(function (global) {
  'use strict';

  var MIN_WINDOW_MS = 800;   // acceleration fit window: about FIXES_PER_WINDOW
  var MAX_WINDOW_MS = 2000;  // fixes, kept between these bounds
  var FIXES_PER_WINDOW = 8;
  var MIN_SPAN = 0.4;        // the fit needs samples covering this share of the window
  var MERGE_MS = 50;         // fixes closer together than this are one burst
  var MAX_EXTRAPOLATE_S = 1.2;
  var STALE_MS = 5000;
  var STANDSTILL_MPS = 0.45;

  function haversine(lat1, lon1, lat2, lon2) {
    var R = 6371000, toRad = Math.PI / 180;
    var dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function GpsSpeed(onStatus) {
    this.onStatus = onStatus || function () {};
    this.watchId = null;
    this.reset();
  }

  GpsSpeed.prototype.reset = function () {
    this.samples = [];   // { t: arrival time (performance.now ms), first: burst start, v: m/s }
    this.lastPos = null;
    this.fixV = 0;
    this.fixA = 0;
    this.fixAt = 0;      // performance.now() when the last fix arrived
    this.accuracy = null;
    this.method = null;  // 'doppler' (coords.speed) or 'position' (distance / time)
    this.rateHz = 0;
    this.intervalMs = 0;       // smoothed time between fixes
    this.lastArrival = 0;
    this.windowMs = MAX_WINDOW_MS;
    this.lastRaw = null;       // the previous fix as delivered
    this.repeats = 0;          // re-sent fixes skipped
    this.status = 'off';
    this.error = '';
  };

  GpsSpeed.supported = function () {
    return typeof navigator !== 'undefined' && 'geolocation' in navigator;
  };

  GpsSpeed.prototype.start = function () {
    if (this.watchId !== null) return;
    this.reset();
    if (!GpsSpeed.supported()) {
      this._setStatus('unsupported', 'This browser has no location support.');
      return;
    }
    this._setStatus('waiting');
    var self = this;
    this.watchId = navigator.geolocation.watchPosition(
      function (pos) { self._onPosition(pos); },
      function (err) { self._onError(err); },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
    );
  };

  GpsSpeed.prototype.stop = function () {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    this._setStatus('off');
  };

  GpsSpeed.prototype._setStatus = function (status, error) {
    this.status = status;
    this.error = error || '';
    this.onStatus(this);
  };

  GpsSpeed.prototype._onError = function (err) {
    if (err.code === 1) {
      if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
      this._setStatus('denied', 'Location permission was denied. Allow location for this site and press Start again.');
    } else if (err.code === 3) {
      // Timeout: keep watching, the next fix may still come.
      if (this.status !== 'ok') this._setStatus('waiting', 'Still waiting for a GPS fix…');
    } else if (this.status !== 'ok') {
      // Transient failures are common in cars; watchPosition keeps trying.
      this._setStatus('error', err.message || 'Location unavailable.');
    }
  };

  GpsSpeed.prototype._onPosition = function (pos) {
    // Sample times use arrival time: it is monotonic, while pos.timestamp may
    // repeat or jump when a browser hands out cached fixes.
    var now = performance.now();
    var c = pos.coords, prev = this.lastRaw;
    this.lastRaw = { speed: c.speed, lat: c.latitude, lon: c.longitude };
    // While moving, every new measurement has a new position. The same speed
    // at the same spot is the browser re-sending an old fix: skip it, so it
    // neither shrinks the window nor makes speed look like a staircase.
    if (prev && typeof c.speed === 'number' && c.speed > 0 &&
        c.speed === prev.speed && c.latitude === prev.lat && c.longitude === prev.lon) {
      this.repeats++;
      return;
    }
    if (this.lastArrival) {
      var gap = now - this.lastArrival;
      this.intervalMs = this.intervalMs ? this.intervalMs + (gap - this.intervalMs) * 0.2 : gap;
    }
    this.lastArrival = now;
    this.windowMs = Math.min(MAX_WINDOW_MS, Math.max(MIN_WINDOW_MS, FIXES_PER_WINDOW * (this.intervalMs || 1000)));

    var v = null;

    if (typeof c.speed === 'number' && isFinite(c.speed) && c.speed >= 0) {
      v = c.speed;
      this.method = 'doppler';
    } else if (this.lastPos) {
      var dts = pos.timestamp - this.lastPos.stamp;
      var dt = (dts > 0 && dts < 10000 ? dts : now - this.lastPos.t) / 1000;
      if (dt >= 0.4 && dt < 10) {
        var d = haversine(this.lastPos.lat, this.lastPos.lon, c.latitude, c.longitude);
        // Movement inside the accuracy circle at walking pace is just noise.
        if (d < c.accuracy * 0.5 && d / dt < 3) d = 0;
        v = d / dt;
        this.method = 'position';
      }
    }
    if (!this.lastPos || now - this.lastPos.t >= 400) {
      this.lastPos = { lat: c.latitude, lon: c.longitude, t: now, stamp: pos.timestamp };
    }
    this.accuracy = c.accuracy;
    if (v === null) {
      // No speed field and only one position so far: assume standing still
      // until a second position arrives (it may not while parked).
      if (this.samples.length) return;
      v = 0;
    }

    if (v < STANDSTILL_MPS) v = 0;
    v = Math.min(v, 120);

    // Burst of fixes: keep the newest rather than fitting over tiny intervals.
    // A burst is measured from its first fix, so a steady fast stream can
    // never chain into one endless sample.
    var samples = this.samples, last = samples[samples.length - 1];
    if (last && now - last.first < MERGE_MS) {
      last.v = v;
      last.t = now;
    } else {
      samples.push({ t: now, first: now, v: v });
    }
    while (samples.length > 2 && now - samples[0].t > this.windowMs) samples.shift();

    if (samples.length >= 2 && now > samples[0].t) {
      this.rateHz = (samples.length - 1) * 1000 / (now - samples[0].t);
    }
    this.fixA = this._fitAccel();
    this.fixV = v;
    this.fixAt = now;
    if (this.status !== 'ok') this._setStatus('ok');
  };

  // Least-squares slope of speed over time across the recent window.
  GpsSpeed.prototype._fitAccel = function () {
    var s = this.samples, n = s.length;
    if (n < 2 || s[n - 1].t - s[0].t < this.windowMs * MIN_SPAN) return 0;
    var t0 = s[0].t, mt = 0, mv = 0, i;
    for (i = 0; i < n; i++) { mt += (s[i].t - t0) / 1000; mv += s[i].v; }
    mt /= n; mv /= n;
    var num = 0, den = 0;
    for (i = 0; i < n; i++) {
      var dt = (s[i].t - t0) / 1000 - mt;
      num += dt * (s[i].v - mv);
      den += dt * dt;
    }
    if (den < 1e-6) return 0;
    var a = num / den;
    return a < -10 ? -10 : a > 8 ? 8 : a;
  };

  // Current best estimate: { speed (m/s), accel (m/s²), fresh (bool) }.
  GpsSpeed.prototype.read = function () {
    if (this.status !== 'ok' && this.status !== 'stale') return { speed: 0, accel: 0, fresh: false };
    var age = (performance.now() - this.fixAt) / 1000;
    if (age * 1000 > STALE_MS) {
      if (this.status !== 'stale') this._setStatus('stale', 'GPS signal lost — holding last speed.');
      return { speed: this.fixV, accel: 0, fresh: false };
    }
    var v = this.fixV + this.fixA * Math.min(age, MAX_EXTRAPOLATE_S);
    if (this.fixV === 0 && this.fixA <= 0) v = 0;
    return { speed: Math.max(0, v), accel: this.fixA, fresh: true };
  };

  global.GpsSpeed = GpsSpeed;
})(window);
