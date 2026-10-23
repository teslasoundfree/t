/*
 * paywall.js — free daily trial, QR-code checkout and the Pro entitlement.
 *
 * Flow: the car asks /api/checkout for a Stripe Checkout Session, shows its
 * short link as a QR code, and polls /api/status until the phone has paid.
 * The session id is the "license": it is kept in localStorage and re-checked
 * with Stripe on every load, so there are no accounts and no database.
 */
(function () {
  'use strict';

  var PRO_KEY = 'motorsound.pro.v1';
  var DEVICE_KEY = 'motorsound.device.v1';
  var TRIAL_KEY = 'motorsound.trial.v1';
  var TRIAL_SECONDS = 9000000  * 900000000;   // free engine time per day
  var POLL_MS = 3000;
  var BONUS_TAPS = 30;          // secret: taps on the QR code ...
  var BONUS_SECONDS = 5 * 60;   // ... earn this much extra time ...
  var BONUS_MAX = 20;           // ... up to this many times per day
  var BONUS_GAP_MS = 2000;      // taps further apart than this start over
  var SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;
  var CUSTOMER_ID = /^cus_[A-Za-z0-9]{8,64}$/;
  var RETRY_MS = 5 * 60 * 1000;      // once the paid period is over: how often to re-ask Stripe

  var device = loadDevice();        // this car's random id, the same on every visit
  var pro = read(PRO_KEY);          // { sid, url, until, cus }
  var trial = loadTrial();          // { day, secs }
  var listeners = [];
  var lastWholeSecond = -1;
  var lastRecheck = 0;
  var pollTimer = 0;
  var closeTimer = 0;
  var busy = false;
  var qrTaps = 0;
  var lastQrTap = 0;

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    modal: $('payModal'), lead: $('payLead'), qr: $('payQr'), hint: $('payHint'),
    retry: $('payRetry'), close: $('payClose'),
    form: $('redeemForm'), code: $('redeemCode'), shown: $('transferCode'),
    alt: $('payAlt'), link: $('payLink')
  };

  // ---------- storage ----------

  function read(key) {
    try { return JSON.parse(localStorage.getItem(key)) || {}; } catch (e) { return {}; }
  }

  function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ }
  }

  function loadDevice() {
    var id = '';
    try { id = localStorage.getItem(DEVICE_KEY) || ''; } catch (e) { /* private mode */ }
    if (/^[a-f0-9]{32}$/.test(id)) return id;
    var bytes = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    id = Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    try { localStorage.setItem(DEVICE_KEY, id); } catch (e) { /* private mode */ }
    return id;
  }

  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  function loadTrial() {
    var t = read(TRIAL_KEY);
    return t.day === today()
      ? { day: t.day, secs: +t.secs || 0, bonus: +t.bonus || 0, grants: +t.grants || 0 }
      : { day: today(), secs: 0, bonus: 0, grants: 0 };
  }

  // ---------- state ----------

  function isPro() {
    return !!pro.until && pro.until > Date.now();
  }

  function trialLeft() {
    if (trial.day !== today()) trial = { day: today(), secs: 0, bonus: 0, grants: 0 };
    return Math.max(0, TRIAL_SECONDS + trial.bonus - trial.secs);
  }

  function changed() {
    for (var i = 0; i < listeners.length; i++) listeners[i]();
  }

  function addUsage(seconds) {
    trialLeft(); // rolls over to a new day when needed
    trial.secs += seconds;
    var whole = Math.floor(trial.secs);
    if (whole !== lastWholeSecond) {
      lastWholeSecond = whole;
      write(TRIAL_KEY, trial);
      changed();
    }
  }

  // Secret: BONUS_TAPS quick taps on the QR code add BONUS_SECONDS, BONUS_MAX times a day.
  function qrTap() {
    var now = Date.now();
    qrTaps = now - lastQrTap > BONUS_GAP_MS ? 1 : qrTaps + 1;
    lastQrTap = now;
    if (qrTaps < BONUS_TAPS) return;
    qrTaps = 0;
    trialLeft(); // rolls over to a new day when needed
    if (trial.grants >= BONUS_MAX) return;
    trial.grants++;
    trial.bonus += BONUS_SECONDS;
    write(TRIAL_KEY, trial);
    changed();
    close();
  }

  function clearPro() {
    pro = {};
    write(PRO_KEY, pro);
  }

  // ---------- server calls ----------

  function api(path, opts) {
    opts = opts || {};
    opts.cache = 'no-store';
    return fetch(path, opts).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) { var err = new Error(body.error || 'http_' + res.status); err.code = body.error; throw err; }
        return body;
      });
    });
  }

  // Asks the server whether this car is paid up. Resolves true when it is.
  // A paired car asks by customer; a car still waiting for a pairing asks by checkout session.
  function check() {
    var q;
    if (CUSTOMER_ID.test(pro.cus || '')) q = 'cus=' + encodeURIComponent(pro.cus);
    else if (SESSION_ID.test(pro.sid || '')) q = 'sid=' + encodeURIComponent(pro.sid);
    else return Promise.resolve(false);
    return api('/api/status?dev=' + device + '&' + q).then(function (r) {
      if (r.active) {
        pro.until = r.until;
        pro.cus = r.cus;
        write(PRO_KEY, pro);
        changed();
        return true;
      }
      // Not active: still waiting for payment, or the subscription ended / this car was replaced.
      if (r.state !== 'open') { clearPro(); changed(); }
      return false;
    });
  }

  // Paid access runs until Stripe's current_period_end. Only after that moment
  // does the car ask again (renewed -> a new end date, cancelled -> locked).
  function periodOver() {
    return !!pro.until && pro.until <= Date.now();
  }

  function recheckIfDue() {
    if (!periodOver() || Date.now() - lastRecheck < RETRY_MS) return;
    lastRecheck = Date.now();
    refresh();
  }

  function refresh() {
    return check().catch(function () { /* offline: keep what we have until it runs out */ });
  }

  // ---------- modal ----------

  function setHint(text, kind) {
    el.hint.textContent = text;
    el.modal.dataset.state = kind || 'wait';
    el.retry.hidden = kind !== 'error' || (el.modal.dataset.mode || 'pay') !== 'pay';
  }

  // The modal is shared by paying, redeeming and handing over a code.
  function setMode(mode) {
    el.modal.dataset.mode = mode;
    $('payTitle').textContent = mode === 'redeem' ? 'Redeem subscription' : mode === 'transfer' ? 'Add another device' : 'Unlock TeslaSound';
    el.form.hidden = true;
    el.shown.hidden = true;
    el.shown.textContent = '';
    el.alt.hidden = true;
    el.qr.innerHTML = '';
  }

  function failText(err) {
    return err.code === 'not_configured' ? 'Payments are not set up yet.' : 'Could not reach the payment server. Check the connection and try again.';
  }

  function postJson(path, body) {
    return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  function drawQr(url) {
    if (typeof qrcode !== 'function') { el.qr.textContent = url; return; }
    var qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    el.qr.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
  }

  function startCheckout() {
    if (busy) return;
    busy = true;
    setMode('pay');
    setHint('Preparing your code…', 'wait');
    api('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: device })
    }).then(function (r) {
      pro = { sid: r.id, url: r.url, until: 0 };
      write(PRO_KEY, pro);
      showCode();
    }, function (err) {
      var msg = err.code === 'not_configured' ? 'Payments are not set up yet.' : 'Could not reach the payment server. Check the connection and try again.';
      setHint(msg, 'error');
    }).then(function () { busy = false; });
  }

  function showCode() {
    drawQr(pro.url);
    // Same short link as the QR code, for someone who cannot scan this screen
    // (it opens in a new tab; this tab keeps polling and unlocks by itself).
    el.link.href = pro.url;
    el.alt.hidden = false;
    setHint('Scan with your phone camera and pay. This screen unlocks by itself.', 'wait');
    startPolling();
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(function () {
      check().then(function (active) {
        if (active) return unlocked();
        if (!pro.sid) { stopPolling(); startCheckout(); } // the code expired: make a new one
      }, function () { /* transient network error: keep polling */ });
    }, POLL_MS);
  }

  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = 0;
  }

  function unlocked() {
    stopPolling();
    el.qr.innerHTML = '';
    setHint('Unlocked. Thank you!', 'ok');
    clearTimeout(closeTimer);
    closeTimer = setTimeout(close, 1800);
  }

  // "Redeem subscription": this device already has a subscription, so link it
  // instead of paying again. The server recognises the browser that paid by its
  // cookie; any other device types a code from a Pro device. Ends like a payment.
  function redeemWith(code) {
    var body = { device: device };
    if (code) body.code = code;
    setHint(code ? 'Checking the code…' : 'Looking for your subscription…', 'wait');
    return postJson('/api/redeem', body).then(function (r) {
      if (r.active) {
        pro = { cus: r.cus, until: r.until };
        write(PRO_KEY, pro);
        changed();
        el.form.hidden = true;
        return unlocked();
      }
      if (r.state === 'ended') return setHint('Your subscription has ended. Close this and tap Unlock to subscribe again.', 'error');
      el.form.hidden = false;
      el.code.focus();
      if (r.state === 'bad_code') return setHint('That code did not work. A code lasts 10 minutes and works once. Make a new one on the other device.', 'error');
      el.lead.textContent = 'Enter the code from a device that already has TeslaSound Pro. On that device tap "Add another device".';
      setHint('', 'wait');
    });
  }

  function redeem() {
    if (busy) return;
    busy = true;
    stopPolling();
    clearTimeout(closeTimer);
    setMode('redeem');
    el.lead.textContent = 'Use the subscription you already paid for.';
    el.modal.hidden = false;
    redeemWith('').catch(function (err) { setHint(failText(err), 'error'); }).then(function () { busy = false; });
  }

  function submitCode(e) {
    e.preventDefault();
    var code = el.code.value.trim();
    if (busy || !code) return;
    busy = true;
    redeemWith(code).catch(function (err) { setHint(failText(err), 'error'); }).then(function () { busy = false; });
  }

  // "Add another device": a Pro device shows a one-time code for another device to redeem.
  function transfer() {
    if (busy || !isPro()) return;
    busy = true;
    stopPolling();
    clearTimeout(closeTimer);
    setMode('transfer');
    el.lead.textContent = 'Add another device to your subscription.';
    el.modal.hidden = false;
    setHint('Making a code…', 'wait');
    // An older record may know the checkout session but not the customer yet: ask Stripe once.
    var known = CUSTOMER_ID.test(pro.cus || '') ? Promise.resolve() : SESSION_ID.test(pro.sid || '') ? refresh() : Promise.resolve();
    known.then(function () {
      if (!CUSTOMER_ID.test(pro.cus || '')) {
        // Pro without a real subscription behind it (the testing page's Pro switch).
        return setHint('This device has no linked subscription, so it cannot make a code.', 'error');
      }
      return postJson('/api/transfer', { device: device, cus: pro.cus }).then(function (r) {
        el.shown.textContent = r.code.slice(0, 4) + '-' + r.code.slice(4);
        el.shown.hidden = false;
        setHint('On the other device, open TeslaSound and tap "Redeem subscription", then enter this code. It works once, for 10 minutes.', 'wait');
      }, function (err) {
        setHint(err.code === 'not_pro' ? 'This device is not part of an active subscription.' : failText(err), 'error');
      });
    }).then(function () { busy = false; });
  }

  function open(reason) {
    clearTimeout(closeTimer);
    setMode('pay');
    el.lead.textContent = reason === 'trial'
      ? 'Your free engine time for today is used up. Unlock TeslaSound to keep driving.'
      : reason === 'pin'
        ? 'Choosing your cars is only available in TeslaSound Pro. Upgrade for every car and unlimited driving time.'
        : 'All engines and unlimited driving time.';
    el.modal.hidden = false;
    if (isPro()) return unlocked();
    // Reuse the code from last time if it is still waiting for payment.
    if (CUSTOMER_ID.test(pro.cus || '')) {
      // A paired car asks Stripe first: the subscription may have renewed, or it may be over.
      check().then(function (active) {
        if (active) unlocked();
        else startCheckout();
      }, function () { setHint('Could not reach the payment server. Check the connection and try again.', 'error'); });
    } else if (SESSION_ID.test(pro.sid || '') && pro.url) {
      check().then(function (active) {
        if (active) unlocked();
        else if (pro.sid) showCode();
        else startCheckout();
      }, function () { showCode(); });
    } else {
      startCheckout();
    }
  }

  function close() {
    stopPolling();
    clearTimeout(closeTimer);
    el.modal.hidden = true;
  }

  function init() {
    el.close.addEventListener('click', close);
    el.retry.addEventListener('click', startCheckout);
    if ($('redeemBtn')) $('redeemBtn').addEventListener('click', redeem);
    if ($('transferBtn')) $('transferBtn').addEventListener('click', transfer);
    el.form.addEventListener('submit', submitCode);
    el.qr.addEventListener('click', qrTap);
    el.modal.addEventListener('pointerdown', function (e) { if (e.target === el.modal) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !el.modal.hidden) close(); });
    recheckIfDue();
    setInterval(recheckIfDue, 60 * 1000);
  }

  window.Paywall = {
    TRIAL_SECONDS: TRIAL_SECONDS,
    isPro: isPro,
    proUntil: function () { return pro.until || 0; },
    trialLeft: trialLeft,
    addUsage: addUsage,
    onChange: function (fn) { listeners.push(fn); },
    open: open,
    redeem: redeem,
    transfer: transfer
  };

  init();
})();
