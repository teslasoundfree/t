/*
 * help.js — small extras on the front page (index.html): in the help bar at
 * the fold, "How to use it" and "Questions" open their panel in place, one
 * at a time; under the gauge, "Explore more" shows for people without Pro.
 */
(function () {
  'use strict';

  var tabs = Array.prototype.slice.call(document.querySelectorAll('.help-tab'));

  // id: the panel to show, or '' to close them all.
  function show(id) {
    tabs.forEach(function (t) {
      var panel = t.getAttribute('aria-controls'), on = panel === id;
      t.setAttribute('aria-expanded', String(on));
      document.getElementById(panel).hidden = !on;
    });
  }

  tabs.forEach(function (t) {
    t.addEventListener('click', function () {
      show(t.getAttribute('aria-expanded') === 'true' ? '' : t.getAttribute('aria-controls'));
    });
  });

  // teslasound.io/#faq or /#howto opens that panel, for links in support replies.
  function fromHash() {
    var id = location.hash.slice(1);
    if (!id || !tabs.some(function (t) { return t.getAttribute('aria-controls') === id; })) return;
    show(id);
    document.getElementById(id).parentNode.scrollIntoView({ block: 'start' });
  }
  fromHash();
  window.addEventListener('hashchange', fromHash);

  // The story page sells Pro, so Pro users don't need the way there.
  // Hidden in the page until this knows, so a Pro car never sees it flash;
  // while it shows, the gauge shrinks to make room (show-explore, style.css).
  var explore = document.querySelector('.explore-link');
  function renderExplore() {
    var show = !!explore && !(window.Paywall && Paywall.isPro());
    if (explore) explore.hidden = !show;
    document.body.classList.toggle('show-explore', show);
  }
  if (window.Paywall) Paywall.onChange(renderExplore);
  renderExplore();
})();
