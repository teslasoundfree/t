/*
 * story.js — the scroll-driven story page (explore.html, css/story.css).
 *
 * Scenes are tall sections with a sticky frame: how far the page has
 * scrolled through one is its progress, 0..1, and each frame is drawn from
 * that. The drive scene is a V8 driven by the scroll; "Sound on" plays it
 * through the real synthesizer (audio.js, engine-dsp.js) on its own audio
 * context, apart from the engine in the dash. Blocks fade in as they come
 * into view.
 */
(function () {
  'use strict';

  var root = document.getElementById('story');
  if (!root) return;
  root.classList.add('js-story');

  var reduced = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  var cars = (window.MOTORSOUND_CARS || []).filter(function (c) { return !c.soon; });
  var vw = window.innerWidth, vh = window.innerHeight;

  function $(sel, el) { return (el || root).querySelector(sel); }
  function $$(sel, el) { return Array.prototype.slice.call((el || root).querySelectorAll(sel)); }
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function smooth(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  function follow(dt, tau) { return 1 - Math.exp(-dt / tau); }
  function isPro() { return !!(window.Paywall && Paywall.isPro()); }
  function px(n) { return n.toFixed(1) + 'px'; }

  // The speed units picked in the dash (app.js keeps them in its settings).
  function mph() {
    try { return (JSON.parse(localStorage.getItem('motorsound.settings.v2')) || {}).units === 'mph'; } catch (e) { return false; }
  }

  // ---------- scenes ----------

  var scenes = [];

  // [data-fade="a b c d"] in a scene: fades in from progress a to b and out
  // from c to d, rising as it comes and goes.
  function fadesIn(el) {
    return $$('[data-fade]', el).map(function (n) {
      return { el: n, k: n.getAttribute('data-fade').split(' ').map(Number), f: -1 };
    });
  }

  function applyFades(list, p) {
    list.forEach(function (o) {
      var k = o.k, f = Math.min(smooth(k[0], k[1], p), 1 - smooth(k[2], k[3], p));
      f = Math.round(f * 500) / 500;
      if (f === o.f) return;
      o.f = f;
      o.el.style.opacity = f;
      o.el.style.transform = f >= 1 ? 'none' : 'translate3d(0,' + px((1 - f) * (p < k[1] ? 44 : -44)) + ',0)';
    });
  }

  // update(p, dt, now) draws the scene and returns true while it still moves
  // on its own (another frame wanted); toggle(on) when it enters or leaves.
  function addScene(name, opts) {
    var el = $('[data-scene="' + name + '"]');
    if (!el) return null;
    var s = { el: el, fades: fadesIn(el), on: false, update: opts.update, toggle: opts.toggle, measure: opts.measure };
    scenes.push(s);
    return s;
  }

  // ---------- 1 · silence: a flat line comes alive ----------

  var wave = $('.wave'), wctx = wave && wave.getContext ? wave.getContext('2d') : null;
  var LOPE = [1, .62, .92, .55, 1, .7, .86, .6];   // a crossplane V8's uneven beat

  function drawWave(p, t) {
    if (!wctx) return;
    var dpr = Math.min(2, window.devicePixelRatio || 1), w = wave.clientWidth, h = wave.clientHeight;
    var cw = Math.round(w * dpr), ch = Math.round(h * dpr);
    if (wave.width !== cw || wave.height !== ch) { wave.width = cw; wave.height = ch; }
    var c = wctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    var grow = smooth(.55, .72, p), settle = smooth(.76, .9, p);
    var amp = h * .17 * grow * (1 - .6 * settle);
    var y0 = h * (.62 + .28 * settle);
    var per = Math.max(44, w / 26);
    var shift = reduced ? 0 : t * per * 7;
    var r = Math.round(80 + 175 * grow), g = Math.round(86 + 30 * grow), b = Math.round(98 - 50 * grow);
    var a = (.4 + .6 * grow) * (1 - .45 * settle);
    var grad = c.createLinearGradient(0, 0, w, 0), col = 'rgba(' + r + ',' + g + ',' + b + ',';
    grad.addColorStop(0, col + '0)');
    grad.addColorStop(.18, col + a + ')');
    grad.addColorStop(.82, col + a + ')');
    grad.addColorStop(1, col + '0)');
    c.beginPath();
    for (var x = 0; x <= w + 2; x += 2) {
      var u = (x + shift) / per, k = Math.floor(u), s = u - k;
      var y = Math.exp(-s * 3.2) * Math.sin(s * Math.PI * 4.4) * LOPE[((k % 8) + 8) % 8];
      if (x === 0) c.moveTo(x, y0 - y * amp); else c.lineTo(x, y0 - y * amp);
    }
    c.strokeStyle = grad;
    c.lineJoin = 'round';
    if (grow > 0) {
      c.globalAlpha = .22 * grow;
      c.lineWidth = 9;
      c.stroke();
      c.globalAlpha = 1;
    }
    c.lineWidth = 2;
    c.stroke();
  }

  addScene('silence', {
    update: function (p, dt, now) {
      drawWave(p, now / 1000);
      return !reduced;
    }
  });

  // ---------- 2 · scroll to drive ----------

  (function () {
    var el = $('[data-scene="drive"]');
    if (!el) return;
    var v8 = cars.filter(function (c) { return c.id === 'v8-muscle'; })[0];
    var E = v8 ? v8.engine : { idleRpm: 760, redlineRpm: 6500, limiterRpm: 6600, launchRpm: 2600 };
    var G = v8 ? v8.vehicle : { ratios: [2.66, 1.78, 1.3, 1, .74, .5], finalDrive: 3.73, tireCircumferenceM: 2.15 };
    var TOP = G.ratios.length;
    var SHIFT_RPM = E.redlineRpm - 300;
    var TACH_MAX = Math.ceil(E.limiterRpm / 1000) * 1000;
    var VMAX = 195 / 3.6, VCRUISE = 140 / 3.6;

    function wheelRpm(gear, v) { return v / G.tireCircumferenceM * 60 * G.ratios[gear - 1] * G.finalDrive; }
    function gearFor(v) {
      for (var g = 1; g < TOP; g++) if (wheelRpm(g, v) <= SHIFT_RPM) return g;
      return TOP;
    }
    var FAST = gearFor(VMAX);

    // The drive by scroll position q (0..1): idle with a blip, full throttle
    // up through the gears, lift off, then a relaxed cruise in top gear.
    function script(q) {
      var idle = E.idleRpm;
      if (q < .12) {
        var b = Math.max(0, 1 - Math.abs(q - .065) / .03);
        return { v: 0, gear: 0, rpm: idle + b * b * (3 - 2 * b) * 3400 };
      }
      if (q < .74) {
        var t = (q - .12) / .62, v = VMAX * (1 - Math.pow(1 - t, 1.7)), g = gearFor(v);
        var launch = (E.launchRpm - idle) * smooth(0, .03, t) * (1 - smooth(0, 9, v));
        return { v: v, gear: g, rpm: Math.max(wheelRpm(g, v), idle + launch) };
      }
      if (q < .9) {
        var v2 = VMAX + (VCRUISE - VMAX) * smooth(.74, .9, q);
        return { v: v2, gear: FAST, rpm: Math.max(idle, wheelRpm(FAST, v2)) };
      }
      return { v: VCRUISE, gear: TOP, rpm: Math.max(idle, wheelRpm(TOP, VCRUISE)) };
    }

    // Tach: a 270° arc from 0 to TACH_MAX rpm, open at the bottom.
    function pt(rpm, r) {
      var a = (135 + 270 * rpm / TACH_MAX) * Math.PI / 180;
      return [200 + r * Math.cos(a), 200 + r * Math.sin(a)];
    }
    function arc(r, from, to) {
      var a = pt(from, r), b = pt(to, r), large = (to - from) / TACH_MAX * 270 > 180 ? 1 : 0;
      return 'M' + a[0].toFixed(1) + ' ' + a[1].toFixed(1) + 'A' + r + ' ' + r + ' 0 ' + large + ' 1 ' + b[0].toFixed(1) + ' ' + b[1].toFixed(1);
    }
    var full = arc(180, 0, TACH_MAX);
    $('.dt-track', el).setAttribute('d', full);
    $('.dt-value', el).setAttribute('d', full);
    $('.dt-glow', el).setAttribute('d', full);
    $('.dt-red', el).setAttribute('d', arc(180, E.redlineRpm, TACH_MAX));
    var ticks = '';
    for (var rpm = 0; rpm <= TACH_MAX; rpm += 500) {
      var major = rpm % 1000 === 0, p0 = pt(rpm, major ? 150 : 158), p1 = pt(rpm, 168);
      ticks += '<line class="dt-tick' + (major ? ' major' : '') + (rpm >= E.redlineRpm ? ' red' : '') + '" x1="' + p0[0].toFixed(1) + '" y1="' + p0[1].toFixed(1) + '" x2="' + p1[0].toFixed(1) + '" y2="' + p1[1].toFixed(1) + '"/>';
      if (major) {
        var lp = pt(rpm, 126);
        ticks += '<text class="dt-label" x="' + lp[0].toFixed(1) + '" y="' + lp[1].toFixed(1) + '">' + rpm / 1000 + '</text>';
      }
    }
    $('.dt-ticks', el).innerHTML = ticks;

    var ui = {
      glow: $('.d-glow', el), value: $('.dt-value', el), vglow: $('.dt-glow', el), tip: $('.dt-tip', el),
      speed: $('.d-speed', el), unit: $('.d-unit', el), gear: $('.d-gear', el), rpm: $('.d-rpm i', el),
      body: $('.d-body', el), wheels: $$('.d-wheel', el), flame: $('.d-flame', el), streaks: $('.d-streaks', el),
      btn: $('.sound-btn', el), label: $('.sound-label', el), note: $('.sound-note', el)
    };
    // Scenery layers and how many px each slides per metre driven.
    var layers = [['.d-far', 2], ['.d-hills', 5], ['.d-lights', 16], ['.d-dash', 34], ['.d-streaks', 52]].map(function (l) {
      var n = $(l[0], el);
      return { el: n, k: l[1], tile: parseFloat(getComputedStyle(n).getPropertyValue('--tile')) || 1000 };
    });

    var D = {
      q: 0, sv: 0, srpm: E.idleRpm, v: 0, rpm: E.idleRpm, gear: 0, dist: 0, push: 0, load: 0, over: 0,
      cut: 0, dip: 0, lag: 0, flame: 0, startT: -1, mph: false, txt: { speed: '', gear: '', rpm: '' }
    };

    // ----- sound -----
    var audio = null, want = false, playing = false;

    function appEngineOn() {
      var b = document.getElementById('startBtn');
      return !!(b && b.classList.contains('on'));
    }
    function say(msg) { ui.note.textContent = msg; }
    function renderBtn() {
      ui.btn.setAttribute('aria-pressed', String(want));
      ui.label.textContent = want ? 'Sound on' : 'Turn the sound on';
    }
    function play() {
      if (!v8 || !window.EngineAudio || !EngineAudio.supported()) { say('This browser cannot play generated audio.'); return false; }
      if (appEngineOn()) { say('Your engine is running up top. Stop it there to rev this one.'); return false; }
      if (!audio) {
        audio = new EngineAudio();
        audio.volume = .8;
      }
      var started;
      try { started = audio.start(v8.engine); } catch (err) { started = Promise.reject(err); }
      started.catch(function () {
        want = playing = false;
        renderBtn();
        say('Could not start the sound in this browser.');
      });
      playing = true;
      return true;
    }
    function pause() {
      if (audio && playing) audio.stop(0);
      playing = false;
    }

    ui.btn.addEventListener('click', function () {
      if (want) {
        want = false;
        pause();
        say('Sound off. Turn it on again any time.');
      } else if (play()) {
        want = true;
        // From a standstill it starts like the dash does: crank, catch, settle.
        if (D.q < .12) D.startT = 0;
        say('Scroll down to accelerate, up to lift off.');
      }
      renderBtn();
      kick();
    });
    // Starting the real engine up top takes over the speakers.
    var startBtn = document.getElementById('startBtn');
    if (startBtn) startBtn.addEventListener('click', function () {
      if (!want) return;
      want = false;
      pause();
      renderBtn();
      say('Sound off: the engine up top is running.');
    }, true);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) pause();
      else if (want && drive.on) play();
    });

    var drive = addScene('drive', {
      toggle: function (on) {
        if (on) {
          D.mph = mph();
          ui.unit.textContent = D.mph ? 'mph' : 'km/h';
          var s = script(D.q);
          D.sv = s.v;
          D.srpm = s.rpm;
          if (want && !playing && !document.hidden) play();
        } else {
          pause();
        }
      },
      update: function (p, dt) {
        D.q += (p - D.q) * follow(dt, reduced ? .03 : .14);
        if (Math.abs(p - D.q) < .0002) D.q = p;
        var s = script(D.q);

        // Throttle from how the drive changes: speeding up (or revs rising
        // at a standstill) is load, slowing down is the overrun.
        var push = s.v > .3 ? (s.v - D.sv) / dt / 3 : (s.rpm - D.srpm) / dt / 6000;
        D.sv = s.v;
        D.srpm = s.rpm;
        D.push += (push - D.push) * follow(dt, .08);
        var loadT, overT = 0;
        if (D.push > .04) loadT = clamp(.4 + D.push * .8, 0, 1);
        else if (D.push < -.04 && s.rpm > 1500) { loadT = 0; overT = clamp(-D.push * 1.6, 0, 1); }
        else loadT = s.v > .3 ? .2 : .04;
        D.load += (loadT - D.load) * follow(dt, loadT > D.load ? .06 : .12);
        // The crackle lingers after a lift-off, but stops as soon as you're back on the gas.
        D.over += (overT - D.over) * follow(dt, overT > D.over ? .04 : loadT > .3 ? .05 : .3);
        if (s.gear > D.gear && D.gear > 0 && D.load > .4) {
          D.cut = .09;
          D.dip = 1;
        }
        D.gear = s.gear;
        D.cut = Math.max(0, D.cut - dt);
        D.dip = Math.max(0, D.dip - dt * 4);

        var rpm = s.rpm;
        if (D.startT >= 0) {
          var t = D.startT += dt;
          if (t < .9) rpm = 230 + 60 * Math.sin(t * Math.PI * 12);
          else if (t < 1.25) rpm = 290 + (t - .9) / .35 * 1210;
          else if (t < 2.6) rpm += (1500 - rpm) * Math.exp(-(t - 1.25) / .35);
          else D.startT = -1;
          if (D.q >= .12) D.startT = -1;
        }
        D.rpm += (rpm - D.rpm) * follow(dt, .05);
        D.v = s.v;
        D.dist += s.v * dt;
        D.lag += ((D.push > 0 ? D.push : 0) - D.lag) * follow(dt, .3);

        if (playing && audio) {
          audio.setParams({
            rpm: D.rpm, load: D.load, overrun: D.over, cut: D.cut > 0 ? 1 : 0, character: .75, crackle: .55,
            whinePitch: 1, whineLevel: 1, speed: D.v, rev: 0
          });
        }
        draw(dt);
        return D.v > .2 || D.q !== p || playing || D.startT >= 0 || D.flame > 0 || D.over > .01;
      }
    });

    function draw(dt) {
      var heat = clamp((D.rpm - E.idleRpm) / (E.limiterRpm - E.idleRpm), 0, 1);
      ui.glow.style.opacity = ((.12 + heat * .88) * (.45 + D.load * .55)).toFixed(3);

      layers.forEach(function (l) {
        l.el.style.transform = 'translate3d(' + px(-((D.dist * l.k) % l.tile)) + ',0,0)';
      });
      ui.streaks.style.opacity = smooth(18, 44, D.v).toFixed(3);

      // The car: engine shake, squat under power, a nose dip on each shift.
      var running = D.rpm > 100, shake = reduced || !running ? 0 : (.35 + D.load * 1.3);
      var jy = shake ? (Math.random() - .5) * shake : 0, jx = shake ? (Math.random() - .5) * shake * .6 : 0;
      var tilt = -D.load * .55 * smooth(0, 3, D.v + D.load * 3) + D.dip * .45;
      ui.body.style.transform = 'translate3d(' + px(jx - D.lag * 14) + ',' + px(jy) + ',0) rotate(' + tilt.toFixed(3) + 'deg)';
      var spin = smooth(.5, 8, D.v) * .85, turn = (D.dist / .68 * 360 * .37) % 360;
      ui.wheels.forEach(function (w) {
        w.style.opacity = spin.toFixed(3);
        w.style.transform = 'translate(-50%,-50%) rotate(' + turn.toFixed(1) + 'deg)';
      });

      // Backfires on the overrun.
      if (D.flame > 0) D.flame = Math.max(0, D.flame - dt);
      else if (!reduced && D.over > .25 && Math.random() < D.over * .12) D.flame = .05 + Math.random() * .08;
      if (D.cut > 0 && D.flame <= 0 && !reduced) D.flame = .05;
      ui.flame.style.opacity = D.flame > 0 ? (.6 + Math.random() * .4).toFixed(2) : '0';
      if (D.flame > 0) ui.flame.style.transform = 'translate(-100%,-50%) scale(' + (.7 + Math.random() * .6).toFixed(2) + ',' + (.8 + Math.random() * .4).toFixed(2) + ')';

      var f = clamp(D.rpm / TACH_MAX, 0, 1) * 100, tip = pt(clamp(D.rpm, 0, TACH_MAX), 180);
      ui.value.setAttribute('stroke-dasharray', f.toFixed(2) + ' 100');
      ui.vglow.setAttribute('stroke-dasharray', f.toFixed(2) + ' 100');
      ui.tip.setAttribute('cx', tip[0].toFixed(1));
      ui.tip.setAttribute('cy', tip[1].toFixed(1));

      var speed = String(Math.round(D.v * (D.mph ? 2.23694 : 3.6)));
      var gear = D.gear ? String(D.gear) : 'N';
      var rpmTxt = String(Math.round(D.rpm / 10) * 10);
      if (speed !== D.txt.speed) ui.speed.textContent = D.txt.speed = speed;
      if (gear !== D.txt.gear) ui.gear.textContent = D.txt.gear = gear;
      if (rpmTxt !== D.txt.rpm) ui.rpm.textContent = D.txt.rpm = rpmTxt;
    }
  })();

  // ---------- horizontal tracks: the pipeline and the garage ----------

  // A row of cards that slides sideways while the page scrolls through the
  // scene; the card nearest the middle is "on". dwell: progress held still
  // at each end. speed: sideways px per px scrolled.
  function trackScene(name, dwell, speed, each) {
    var el = $('[data-scene="' + name + '"]');
    if (!el) return;
    var track = $('.track', el), fill = $('.track-fill', el), items = [], over = 0, lastOn = -1;
    addScene(name, {
      measure: function () {
        items = Array.prototype.slice.call(track.children).map(function (n) {
          return { el: n, c: n.offsetLeft + n.offsetWidth / 2, img: n.querySelector('.gcar-art img') };
        });
        over = Math.max(0, track.offsetWidth - vw);
        el.style.height = Math.round(over / speed / (1 - 2 * dwell) + vh) + 'px';
        lastOn = -1;
      },
      update: function (p) {
        var t = clamp((p - dwell) / (1 - 2 * dwell), 0, 1), x = -over * t;
        track.style.transform = 'translate3d(' + px(x) + ',0,0)';
        if (fill) fill.style.transform = 'scaleX(' + t.toFixed(4) + ')';
        var best = 0, bd = Infinity;
        items.forEach(function (it, i) {
          var d = it.c + x - vw / 2;
          if (Math.abs(d) < bd) { bd = Math.abs(d); best = i; }
          if (each) each(it, d);
        });
        if (best !== lastOn) {
          items.forEach(function (it, i) { it.el.classList.toggle('on', i === best); });
          lastOn = best;
        }
        return false;
      }
    });
  }

  // Garage cards, from the car list (newest cars show up by themselves).
  (function () {
    var track = $('.garage-track');
    if (!track) return;
    var soon = $('.gcar-soon', track);
    cars.forEach(function (c, i) {
      var a = document.createElement('article');
      a.className = 'gcar' + (c.pro ? ' gcar-pro' : '');
      a.innerHTML = '<span class="gcar-n" aria-hidden="true"></span><div class="gcar-art"><img alt="" loading="lazy" decoding="async"></div>' +
        '<div class="gcar-body"><span class="badge"></span><h3></h3><p></p><button type="button" class="gcar-btn"></button></div>';
      a.querySelector('.gcar-n').textContent = (i < 9 ? '0' : '') + (i + 1);
      var img = a.querySelector('img');
      img.onerror = function () { img.style.visibility = 'hidden'; };
      img.src = c.photo || 'img/' + c.id + '.png';
      img.alt = c.name;
      a.querySelector('.badge').textContent = c.pro ? 'Pro' : 'Free';
      a.querySelector('h3').textContent = c.name;
      a.querySelector('p').textContent = c.tagline || '';
      var btn = a.querySelector('.gcar-btn');
      btn.textContent = c.pro && !isPro() ? 'Unlock with Pro' : '▶ Drive it';
      btn.addEventListener('click', function () { driveCar(c); });
      track.insertBefore(a, soon);
    });
  })();

  trackScene('pipe', .1, 1, null);
  trackScene('garage', .06, 1.25, reduced ? null : function (it, d) {
    if (it.img && Math.abs(d) < vw * 1.2) it.img.style.transform = 'translate3d(' + px(-d * .09) + ',0,0)';
  });

  // ---------- manifesto: words light up as you read down ----------

  var words = [], wordsEl = $('.words'), lit = 0;
  if (wordsEl) {
    var walker = document.createTreeWalker(wordsEl, NodeFilter.SHOW_TEXT), nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(function (n) {
      var frag = document.createDocumentFragment();
      n.nodeValue.split(/(\s+)/).forEach(function (part) {
        if (!part) return;
        if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(part)); return; }
        var w = document.createElement('span');
        w.className = 'w';
        w.textContent = part;
        frag.appendChild(w);
        words.push(w);
      });
      n.parentNode.replaceChild(frag, n);
    });
  }

  function lightWords(r) {
    var prog = clamp((vh * .82 - r.top) / (r.height + vh * .2), 0, 1), n = Math.round(prog * words.length);
    if (n === lit) return;
    for (var i = Math.min(n, lit); i < Math.max(n, lit); i++) words[i].classList.toggle('lit', i < n);
    lit = n;
  }

  // ---------- in the car: the step in the middle drives the screen ----------

  var stepEls = $$('.step'), screen = $('.screen'), curStep = '';

  function pickStep(rects) {
    var best = null, bd = Infinity;
    rects.forEach(function (r, i) {
      var d = Math.abs(r.top + r.height / 2 - vh * .55);
      if (d < bd) { bd = d; best = stepEls[i]; }
    });
    if (!best || best.dataset.step === curStep) return;
    curStep = best.dataset.step;
    stepEls.forEach(function (s) { s.classList.toggle('on', s === best); });
    if (screen) screen.dataset.step = curStep;
  }

  // ---------- the frame loop ----------

  var queued = false, lastT = 0;

  function kick() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(frame);
  }

  function frame(now) {
    queued = false;
    var dt = lastT ? clamp((now - lastT) / 1000, .008, .05) : .016;
    lastT = now;
    // Read every position first, then write, so the frame lays out once.
    var rects = scenes.map(function (s) { return s.el.getBoundingClientRect(); });
    var wr = wordsEl ? wordsEl.getBoundingClientRect() : null;
    var sr = stepEls.length ? stepEls.map(function (s) { return s.getBoundingClientRect(); }) : null;
    var more = false;
    scenes.forEach(function (s, i) {
      var r = rects[i], on = r.bottom > -40 && r.top < vh + 40;
      if (on !== s.on) {
        s.on = on;
        if (s.toggle) s.toggle(on);
      }
      if (!on) return;
      var p = clamp(-r.top / Math.max(1, r.height - vh), 0, 1);
      applyFades(s.fades, p);
      if (s.update(p, dt, now)) more = true;
    });
    if (wr && wr.bottom > 0 && wr.top < vh) lightWords(wr);
    if (sr && sr[0].top < vh && sr[sr.length - 1].bottom > 0) pickStep(sr);
    if (more) kick(); else lastT = 0;
  }

  function measure() {
    vw = window.innerWidth;
    vh = window.innerHeight;
    scenes.forEach(function (s) { if (s.measure) s.measure(); });
  }

  measure();
  window.addEventListener('scroll', kick, { passive: true });
  // Phone toolbars change the height while scrolling: only a real resize
  // (width, or a big height change) re-measures the scene heights.
  window.addEventListener('resize', function () {
    if (window.innerWidth !== vw || Math.abs(window.innerHeight - vh) > 140) measure();
    kick();
  });
  kick();

  // ---------- fade-ins ----------

  var rv = $$('.rv');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.classList.add('in');
        io.unobserve(e.target);
      });
    }, { rootMargin: '0px 0px -12% 0px' });
    rv.forEach(function (n) { io.observe(n); });
  } else {
    rv.forEach(function (n) { n.classList.add('in'); });
  }

  // Feature tiles: a soft light follows the pointer.
  $$('.tile').forEach(function (t) {
    t.addEventListener('pointermove', function (e) {
      var r = t.getBoundingClientRect();
      t.style.setProperty('--mx', (e.clientX - r.left) + 'px');
      t.style.setProperty('--my', (e.clientY - r.top) + 'px');
    });
  });

  // ---------- car names: marquee and counts ----------

  var names = cars.map(function (c) { return c.name; }).concat(['More sounds coming']);
  $$('.mq-move').forEach(function (m, i) {
    var list = i % 2 ? names.slice().reverse() : names;
    var text = list.join(' ● ') + ' ● ';
    for (var k = 0; k < 2; k++) {
      var s = document.createElement('span');
      s.textContent = text;
      m.appendChild(s);
    }
  });
  if (cars.length) $$('[data-car-count]').forEach(function (n) { n.textContent = cars.length; });

  // ---------- calls to action ----------

  // Up to the dash on a page that has one, else over to the app.
  function toDash(nudge) {
    var b = document.getElementById('startBtn');
    if (!b) {
      location.href = './';
      return;
    }
    window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
    if (!nudge) return;
    b.classList.remove('nudge');
    setTimeout(function () {
      b.classList.add('nudge');
      setTimeout(function () { b.classList.remove('nudge'); }, 2400);
    }, reduced ? 0 : 700);
  }

  function toPricing() {
    var p = document.getElementById('pricing');
    if (p) p.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
  }

  // A garage card's button: pick that car in the dash and go up to it.
  function driveCar(c) {
    if (c.pro && !isPro()) { toPricing(); return; }
    var b = document.querySelector('#carPicker [data-car="' + c.id + '"]');
    if (!document.getElementById('carPicker')) {
      toDash(false);
      return;
    }
    if (b) {
      b.click();
      toDash(true);
      return;
    }
    toDash(false);
    var all = document.querySelector('#carPicker .pick-all');
    if (all) all.click();
  }

  $$('[data-go]').forEach(function (n) {
    n.addEventListener('click', function (e) {
      e.preventDefault();
      if (n.dataset.go === 'pro' && !isPro() && window.Paywall) Paywall.open();
      else toDash(true);
    });
  });
  if (isPro()) $$('[data-go="pro"]').forEach(function (n) { n.textContent = 'You have Pro · start the engine'; });
})();
