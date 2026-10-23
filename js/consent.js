/*
 * consent.js — analytics consent banner.
 * Vercel Analytics is only loaded after the visitor clicks "Yes". On "No" (or
 * before any choice) the analytics script is never requested.
 */
(function () {
  'use strict';

  var KEY = 'teslasound.analytics';   // 'yes' | 'no'
  var loaded = false;

  function read() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function write(v) {
    try { localStorage.setItem(KEY, v); } catch (e) { /* private mode: choice lasts for this page view */ }
  }

  function loadAnalytics() {
    if (loaded) return;
    loaded = true;
    window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
    var s = document.createElement('script');
    s.defer = true;
    s.src = '/_vercel/insights/script.js';
    document.head.appendChild(s);
  }

  function closeBanner() {
    var b = document.getElementById('consentBanner');
    if (b) b.remove();
  }

  function choose(v) {
    write(v);
    closeBanner();
    if (v === 'yes') loadAnalytics();
  }

  function openBanner() {
    if (document.getElementById('consentBanner')) return;
    var b = document.createElement('div');
    b.className = 'consent';
    b.id = 'consentBanner';
    b.setAttribute('role', 'region');
    b.setAttribute('aria-label', 'Cookie consent');

    var p = document.createElement('p');
    p.appendChild(document.createTextNode('This site would like to use analytics cookies to see how it is used. Allow? '));
    var a = document.createElement('a');
    a.href = 'privacy.html';
    a.textContent = 'Privacy policy';
    p.appendChild(a);

    var actions = document.createElement('div');
    actions.className = 'consent-actions';
    var no = document.createElement('button');
    no.type = 'button';
    no.className = 'ghost-btn';
    no.textContent = 'No';
    no.addEventListener('click', function () { choose('no'); });
    var yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'ghost-btn consent-yes';
    yes.textContent = 'Yes';
    yes.addEventListener('click', function () { choose('yes'); });
    actions.appendChild(no);
    actions.appendChild(yes);

    b.appendChild(p);
    b.appendChild(actions);
    document.body.appendChild(b);
  }

  function init() {
    var saved = read();
    if (saved === 'yes') loadAnalytics();
    else if (saved !== 'no') openBanner();
    Array.prototype.forEach.call(document.querySelectorAll('[data-cookie-settings]'), function (el) {
      el.addEventListener('click', function (e) { e.preventDefault(); openBanner(); });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
