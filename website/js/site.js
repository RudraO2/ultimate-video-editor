/*
  Ultimate Video Editor: website motion and behaviour.
  GSAP + ScrollTrigger drive the motion, Lenis smooths the scroll. Without them (or with reduced
  motion) the page stays still and complete: nothing waits for an animation to become visible.
*/
(function () {
  'use strict';

  var root = document.documentElement;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var gsap = window.gsap;
  var ScrollTrigger = window.ScrollTrigger;
  var motion = !reduce && !!gsap && !!ScrollTrigger;
  root.classList.toggle('motion', motion);
  window.__uveReady = true;

  var $ = function (sel, el) { return (el || document).querySelector(sel); };
  var $$ = function (sel, el) { return Array.prototype.slice.call((el || document).querySelectorAll(sel)); };

  var year = $('#year');
  if (year) year.textContent = String(new Date().getFullYear());

  /* ---------- smooth scroll ---------- */
  var lenis = null;
  if (motion) {
    gsap.registerPlugin(ScrollTrigger);
    if (window.Lenis) {
      lenis = new window.Lenis({ lerp: 0.1, smoothWheel: true });
      lenis.on('scroll', ScrollTrigger.update);
      gsap.ticker.add(function (time) { lenis.raf(time * 1000); });
      gsap.ticker.lagSmoothing(0);
    }
  }

  function scrollToTarget(target, immediate) {
    var offset = -88;
    if (lenis) lenis.scrollTo(target, { offset: offset, duration: 1.4, immediate: !!immediate });
    else {
      var y = target.getBoundingClientRect().top + window.scrollY + offset;
      window.scrollTo({ top: Math.max(0, y), behavior: immediate || reduce ? 'auto' : 'smooth' });
    }
  }

  /* ---------- nav: transparent at the top, a floating pill once you scroll ---------- */
  var nav = $('#nav');
  var sheet = $('.sheet');
  function onScroll() {
    nav.classList.toggle('is-floating', window.scrollY > 50);
    if (sheet) {
      var r = sheet.getBoundingClientRect();
      nav.classList.toggle('is-on-cream', r.top <= 44 && r.bottom >= 44);
    }
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------- mobile menu ---------- */
  var drawer = $('#drawer');
  var menuButton = $('.nav__menu', nav);
  function openMenu() {
    drawer.hidden = false;
    requestAnimationFrame(function () { drawer.classList.add('is-open'); });
    menuButton.setAttribute('aria-expanded', 'true');
    if (lenis) lenis.stop();
    var first = $('.drawer__close', drawer);
    if (first) first.focus();
  }
  function closeMenu(returnFocus) {
    if (drawer.hidden) return;
    drawer.classList.remove('is-open');
    menuButton.setAttribute('aria-expanded', 'false');
    if (lenis) lenis.start();
    setTimeout(function () { drawer.hidden = true; }, 320);
    if (returnFocus) menuButton.focus();
  }
  menuButton.addEventListener('click', openMenu);
  $$('[data-close]', drawer).forEach(function (el) { el.addEventListener('click', function () { closeMenu(true); }); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu(true); });

  /* ---------- in-page links glide (and close the menu) ---------- */
  document.addEventListener('click', function (e) {
    var link = e.target.closest && e.target.closest('a[href^="#"]');
    if (!link || link.classList.contains('skip')) return;
    var id = link.getAttribute('href');
    if (id.length < 2) return;
    var target = document.getElementById(id.slice(1));
    if (!target) return;
    e.preventDefault();
    closeMenu(false);
    if (id === '#main') {
      if (lenis) lenis.scrollTo(0, { duration: 1.4 });
      else window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
    } else {
      scrollToTarget(target);
    }
    try { history.replaceState(null, '', id); } catch (err) { /* the frame may refuse */ }
  });

  /* ---------- copy the build command ---------- */
  $$('[data-copy]').forEach(function (button) {
    var label = $('span', button);
    button.addEventListener('click', function () {
      var source = $(button.getAttribute('data-copy'));
      var text = source ? source.textContent.trim() : '';
      var done = function (msg) { label.textContent = msg; setTimeout(function () { label.textContent = 'Copy'; }, 1800); };
      var select = function () {
        var range = document.createRange();
        range.selectNodeContents(source);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        done('Press Ctrl+C');
      };
      try {
        navigator.clipboard.writeText(text).then(function () { done('Copied'); }, select);
      } catch (err) { select(); }
    });
  });

  /* ---------- Cream / Dark compare ---------- */
  var compare = $('.js-compare');
  var compareRange = compare && $('.compare__range', compare);
  var touchedCompare = false;
  function setCompare(v) { compare.style.setProperty('--pos', v + '%'); }
  if (compare) {
    compareRange.addEventListener('input', function () { touchedCompare = true; setCompare(compareRange.value); });
    setCompare(compareRange.value);
  }

  /* ---------- the hero player: real export, live timecode, playhead on the lanes ---------- */
  var video = $('#hero-video');
  var tc = $('#hero-tc');
  var playhead = $('#hero-playhead');
  var FPS = 30;
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function timecode(t) {
    var frames = Math.floor(t * FPS + 1e-6);
    var ff = frames % FPS;
    var s = Math.floor(frames / FPS);
    return '00:' + pad(Math.floor(s / 60)) + ':' + pad(s % 60) + ':' + pad(ff);
  }
  function drawTime() {
    var t = video.currentTime || 0;
    var d = video.duration || 7;
    playhead.style.setProperty('--p', Math.min(1, t / d).toFixed(4));
    tc.textContent = timecode(t);
  }
  if (video) {
    if (motion) {
      var playing = false;
      var tick = function () {
        drawTime();
        if (!playing) return;
        if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick);
        else requestAnimationFrame(tick);
      };
      video.addEventListener('play', function () { playing = true; tick(); });
      video.addEventListener('pause', function () { playing = false; });
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) { var p = video.play(); if (p && p.catch) p.catch(function () {}); }
          else video.pause();
        });
      }, { threshold: 0.2 });
      io.observe(video);
    } else {
      video.controls = true;
      video.addEventListener('timeupdate', drawTime);
    }
  }

  /* ---------- small live pieces that start when seen ---------- */
  if ('IntersectionObserver' in window) {
    var liveIo = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { entry.target.classList.add('is-live'); liveIo.unobserve(entry.target); }
      });
    }, { threshold: 0.45 });
    $$('.js-live').forEach(function (el) { liveIo.observe(el); });
  } else {
    $$('.js-live').forEach(function (el) { el.classList.add('is-live'); });
  }

  /* ---------- footer: fixed behind the page and uncovered at the end ---------- */
  var footer = $('#footer');
  var curtainQuery = window.matchMedia('(min-width: 761px) and (min-height: 600px)');
  function measureFooter() {
    root.style.setProperty('--footer-h', footer.offsetHeight + 'px');
    root.classList.toggle('curtain', curtainQuery.matches);
  }
  measureFooter();
  if ('ResizeObserver' in window) new ResizeObserver(measureFooter).observe(footer);
  window.addEventListener('resize', measureFooter);

  /* ---------- deep links skip the intro ---------- */
  var hashTarget = null;
  if (location.hash.length > 1) {
    try { hashTarget = document.getElementById(decodeURIComponent(location.hash.slice(1))); } catch (err) { hashTarget = null; }
  }

  var loader = $('.loader');
  if (!motion) {
    if (loader) loader.remove();
    return;
  }

  /* ================= motion from here on ================= */

  /* ---------- intro: cream card, the name rises out of a blur, a dark disc swallows it ---------- */
  var playIntro = !!loader && !hashTarget;
  if (!playIntro && loader) loader.remove();
  if (playIntro) {
    if (lenis) lenis.stop();
    var intro = gsap.timeline({ onComplete: function () { loader.remove(); } });
    intro
      .fromTo('.loader__word', { opacity: 0, y: 100, filter: 'blur(10px)' }, { opacity: 1, y: 0, filter: 'blur(0px)', duration: 2, ease: 'power4.inOut' }, 0)
      .to('.loader__disc', { scale: 5, duration: 2, ease: 'power2.inOut' }, 2)
      .to(loader, { opacity: 0, filter: 'blur(10px)', duration: 2, ease: 'power4.inOut' }, 2)
      .add(function () { if (lenis) lenis.start(); }, 2.6);
    // A click, key or wheel skips ahead.
    var skip = function () {
      intro.timeScale(4);
      if (lenis) lenis.start();
      ['click', 'keydown', 'wheel', 'touchstart'].forEach(function (t) { window.removeEventListener(t, skip); });
    };
    ['click', 'keydown', 'wheel', 'touchstart'].forEach(function (t) { window.addEventListener(t, skip, { passive: true }); });
  }

  /* ---------- hero: each piece arrives in turn, then drifts away as you scroll ---------- */
  var hero = gsap.timeline({ delay: playIntro ? 1 : 0.1, defaults: { duration: 0.55, ease: 'power3.out' } });
  hero
    .from('.hero__glow', { opacity: 0, duration: 0.6, ease: 'power4.inOut' })
    .from('.hero__ring', { opacity: 0, scale: 0, duration: 1, ease: 'power2.out' })
    .from('.badge', { opacity: 0, y: -14 }, '-=0.5')
    .from('.hero__title', { opacity: 0, y: 50 }, '-=0.15')
    .from('.hero__sub', { opacity: 0, x: -50, duration: 0.5 })
    .from('.cta', { opacity: 0, x: 50 })
    .from('.player', { opacity: 0, y: 50 })
    .from('.works', { opacity: 0, y: 50 });

  var heroRange = { trigger: '.hero', start: 'top top', end: 'bottom top' };
  function scrubbed(target, vars, trigger) { return gsap.to(target, Object.assign({ scrollTrigger: trigger }, vars)); }
  scrubbed('.js-ring', { scale: 0.5 }, Object.assign({ scrub: 1.9 }, heroRange));
  scrubbed('.js-title', { yPercent: -150 }, Object.assign({ scrub: 1.9 }, heroRange));
  scrubbed('.js-sub', { scale: 1.2, opacity: 0, yPercent: -100 }, Object.assign({ scrub: 1 }, heroRange));
  scrubbed('.js-cta', { y: 200, opacity: 0 }, Object.assign({ scrub: 1.2 }, heroRange));
  scrubbed('.js-player', { scale: 1.2 }, Object.assign({ scrub: 1.9 }, heroRange));
  scrubbed('.js-works', { y: 150, opacity: 0 }, { trigger: '.js-works', start: 'top center', end: 'bottom center', scrub: 1.9 });

  /* ---------- headings rise line by line (scrubbed) ---------- */
  function riseHeading(container, start, end, distance, stagger) {
    var lines = $$('.eyebrow, .h-section, .lede', container);
    if (!lines.length) return;
    gsap.from(lines, {
      y: distance, scaleY: 1.1, opacity: 0, stagger: stagger, transformOrigin: '50% 100%',
      scrollTrigger: { trigger: container, start: start, end: end, scrub: 1.1 }
    });
  }
  riseHeading($('.statement .js-head'), 'top 80%', 'bottom 80%', '100%', 0.5);
  riseHeading($('.js-voice-copy'), 'top 85%', 'top 35%', 120, 0.3);
  riseHeading($('.js-prompts-head'), 'top 85%', 'bottom 60%', '100%', 0.4);

  $$('.story').forEach(function (card) {
    gsap.from(card, { opacity: 0, y: '60%', scrollTrigger: { trigger: card, start: 'top bottom', end: 'top 55%', scrub: 1.2 } });
  });

  /* ---------- the giant word slides with the page ---------- */
  $$('.giant__track').forEach(function (track) {
    gsap.to(track, { xPercent: -20, ease: 'none', scrollTrigger: { trigger: track, start: 'top bottom', end: 'bottom top', scrub: 4 } });
  });

  /* ---------- made for: one line, six words, each stretches in and out ---------- */
  var words = $$('.madefor__word');
  if (words.length) {
    var swap = gsap.timeline({ scrollTrigger: { trigger: '.madefor', start: 'top center', end: 'bottom-=500 center', scrub: 1.1 } });
    words.forEach(function (word, i) {
      // Word i starts one line below the window and ends in it (the first starts in place).
      swap.fromTo(word,
        { opacity: i === 0 ? 1 : 0, yPercent: i === 0 ? 0 : -100 * (i - 1), '--w': i === 0 ? 100 : 62 },
        { opacity: 1, yPercent: -100 * i, '--w': 100, duration: 1, ease: 'power2.out' });
      swap.to({}, { duration: 2.5 });
      if (i < words.length - 1) {
        swap.to(word, { opacity: 0, yPercent: -100 * (i + 1), '--w': 140, duration: 1, ease: 'power2.in' });
      }
    });
  }

  /* ---------- the product shot tilts back and settles flat ---------- */
  var mm = gsap.matchMedia();
  mm.add('(min-width: 769px)', function () {
    var tiltRange = { trigger: '.tilt', start: 'top 85%', end: 'top 5%', scrub: true };
    gsap.fromTo('.js-tilt', { rotateX: 24, scale: 1.05 }, { rotateX: 0, scale: 1, ease: 'none', scrollTrigger: tiltRange });
    gsap.fromTo('.js-tilt-head', { y: 0 }, { y: -100, ease: 'none', scrollTrigger: tiltRange });
  });
  mm.add('(max-width: 768px)', function () {
    riseHeading($('.js-tilt-head'), 'top 85%', 'top 45%', 80, 0.3);
  });

  /* ---------- voice card ---------- */
  gsap.from('.js-said', { y: 120, opacity: 0, scrollTrigger: { trigger: '.js-said', start: 'top bottom', end: 'top 60%', scrub: 1.1 } });
  gsap.from('.js-said .steps li', { x: 40, opacity: 0, stagger: 0.35, scrollTrigger: { trigger: '.js-said .steps', start: 'top 90%', end: 'bottom 70%', scrub: 1.1 } });

  /* ---------- the cream sheet slides up over the room ---------- */
  gsap.from('.sheet', { scale: 0.94, y: 60, scrollTrigger: { trigger: '.sheet', start: 'top bottom', end: 'top 25%', scrub: 1 } });
  riseHeading($('.js-sheet-head'), 'top-=200 center', 'top+=200 center', window.innerWidth < 700 ? 90 : 200, 0.3);
  if (compare) {
    gsap.from(compare, { y: '30%', scaleY: 1.1, opacity: 0, scrollTrigger: { trigger: compare, start: 'top bottom', end: 'top 45%', scrub: 1.1 } });
    // One gentle sweep the first time it is in view, so the handle reads as draggable.
    ScrollTrigger.create({
      trigger: compare, start: 'top 45%', once: true,
      onEnter: function () {
        if (touchedCompare) return;
        var state = { v: 50 };
        gsap.timeline({ onUpdate: function () { if (!touchedCompare) { setCompare(state.v); compareRange.value = String(Math.round(state.v)); } } })
          .to(state, { v: 34, duration: 0.8, ease: 'power2.inOut' })
          .to(state, { v: 66, duration: 1.1, ease: 'power2.inOut' })
          .to(state, { v: 50, duration: 0.8, ease: 'power2.inOut' });
      }
    });
  }

  /* ---------- the closing lines ---------- */
  gsap.from('.js-psst h2 > span', {
    y: 200, scaleY: 1.1, opacity: 0, stagger: 0.3,
    scrollTrigger: { trigger: '.psst', start: 'top 80%', end: 'center 45%', scrub: 1.1 }
  });
  gsap.from('.js-psst .btn-main', {
    y: 60, opacity: 0,
    scrollTrigger: { trigger: '.js-psst .btn-main', start: 'top bottom', end: 'top 78%', scrub: 1.1 }
  });

  /* ---------- the footer's content settles as it is uncovered ---------- */
  mm.add('(min-width: 761px) and (min-height: 600px)', function () {
    gsap.from('.footer__inner', {
      opacity: 0.1, y: 100, scale: 0.9, ease: 'none',
      scrollTrigger: { trigger: '.page', start: 'bottom bottom', end: function () { return 'bottom bottom-=' + footer.offsetHeight; }, scrub: 1 }
    });
  });

  /* ---------- keep every trigger true to the final layout ---------- */
  var refresh = function () { ScrollTrigger.refresh(); };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(refresh);
  window.addEventListener('load', function () {
    refresh();
    if (hashTarget) scrollToTarget(hashTarget, true);
  });
})();
