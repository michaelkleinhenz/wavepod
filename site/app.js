// WavePod web page: effects and the live studio demo. Plain JS, no dependencies.
(() => {
  'use strict';
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = matchMedia('(pointer: fine)').matches;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  // ---------------------------------------------------------- podcast / audio drama
  // The inline script in <head> sets html[data-mode] before first paint; this keeps it in sync.
  const root = document.documentElement;
  const DRAMA_HASH = /^(audio-?drama|drama|audio-?play|hoerspiel|hörspiel|fiction)$/i;
  const modeNow = () => (root.dataset.mode === 'drama' ? 'drama' : 'podcast');
  const modeHooks = [];
  const onMode = (fn) => modeHooks.push(fn);
  const syncMode = () => {
    const m = modeNow();
    $$('[data-set-mode]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.setMode === m)));
    modeHooks.forEach((fn) => fn(m));
  };
  const setMode = (m, from) => {
    if (m === modeNow()) return;
    try { localStorage.setItem('wavepod-mode', m); } catch { /* private mode */ }
    root.removeAttribute('data-first-visit');
    // Keep the section the visitor is reading in view; its content above may change height.
    const anchor = scrollY > innerHeight * 0.6
      ? $$('main > section').find((sec) => sec.offsetParent !== null && sec.getBoundingClientRect().bottom > 120)
      : null;
    const apply = () => {
      root.dataset.mode = m;
      history.replaceState(null, '', location.pathname + location.search + (m === 'drama' ? '#audio-drama' : '#podcast'));
      if (anchor) anchor.scrollIntoView({ block: 'start', behavior: 'instant' });
      // What is now on screen shows at once instead of fading in under the wipe.
      $$('.reveal:not(.in)').forEach((el) => {
        if (el.offsetParent === null) return;
        const r = el.getBoundingClientRect();
        if (r.top < innerHeight && r.bottom > 0) el.classList.add('in', 'instant');
      });
      syncMode();
    };
    if (reduce || !document.startViewTransition) { apply(); return; }
    const r = from?.getBoundingClientRect?.();
    const x = r ? r.left + r.width / 2 : innerWidth / 2, y = r ? r.top + r.height / 2 : 0;
    const vt = document.startViewTransition(apply);
    vt.ready.then(() => {
      const rad = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${rad}px at ${x}px ${y}px)`] },
        { duration: 800, easing: 'cubic-bezier(.65, 0, .25, 1)', pseudoElement: '::view-transition-new(root)' },
      );
    }).catch(() => {});
  };
  $$('[data-set-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.setMode, b)));
  // Arrow keys move between the two options, as in any radio group.
  $$('[role="radiogroup"]').forEach((g) => g.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const next = modeNow() === 'drama' ? 'podcast' : 'drama';
    const btn = $(`[data-set-mode="${next}"]`, g);
    setMode(next, btn); btn.focus();
  }));
  addEventListener('hashchange', () => {
    const h = decodeURIComponent(location.hash.slice(1));
    if (DRAMA_HASH.test(h)) setMode('drama');
    else if (/^podcasts?$/i.test(h)) setMode('podcast');
  });
  syncMode();

  // ---------------------------------------------------------- header + cursor glow
  const top = $('.top');
  const onScroll = () => top.classList.toggle('scrolled', scrollY > 12);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  if (fine && !reduce) {
    const glow = $('.cursor-glow');
    addEventListener('pointermove', (e) => {
      glow.style.setProperty('--cx', e.clientX + 'px');
      glow.style.setProperty('--cy', e.clientY + 'px');
    }, { passive: true });
  }

  // ---------------------------------------------------------- scroll reveal
  const reveals = $$('.reveal');
  // Stagger siblings that reveal together.
  reveals.forEach((el) => {
    const sibs = [...el.parentElement.children].filter((c) => c.classList.contains('reveal'));
    el.style.setProperty('--d', Math.min(sibs.indexOf(el), 6) * 0.07 + 's');
  });
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  reveals.forEach((el) => io.observe(el));

  // Run a callback once an element first scrolls into view.
  const whenSeen = (el, fn) => {
    const o = new IntersectionObserver(([e]) => { if (e.isIntersecting) { o.disconnect(); fn(); } }, { threshold: 0.3 });
    o.observe(el);
  };
  // Track visibility to pause work while offscreen.
  const visible = (el, fn) => new IntersectionObserver(([e]) => fn(e.isIntersecting)).observe(el);

  // ---------------------------------------------------------- spotlight cards
  $$('.card, .platform').forEach((card) => {
    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--x', e.clientX - r.left + 'px');
      card.style.setProperty('--y', e.clientY - r.top + 'px');
    });
  });

  // ---------------------------------------------------------- magnetic buttons
  if (fine && !reduce) {
    $$('.magnetic').forEach((b) => {
      b.addEventListener('pointermove', (e) => {
        const r = b.getBoundingClientRect();
        b.style.setProperty('--mx', (e.clientX - r.left - r.width / 2) * 0.25 + 'px');
        b.style.setProperty('--my', (e.clientY - r.top - r.height / 2) * 0.35 + 'px');
      });
      b.addEventListener('pointerleave', () => { b.style.setProperty('--mx', '0px'); b.style.setProperty('--my', '0px'); });
    });
  }

  // ---------------------------------------------------------- marquee (seamless loop)
  $$('.marquee-track').forEach((mq) => mq.append(...[...mq.children].map((n) => { const c = n.cloneNode(true); c.setAttribute('aria-hidden', 'true'); return c; })));

  // ---------------------------------------------------------- count-up stats
  const fmt = (n) => (n < 0 ? '−' : '') + Math.abs(n);
  $$('[data-count]').forEach((el) => {
    const end = Number(el.dataset.count), pre = el.dataset.prefix || '', suf = el.dataset.suffix || '';
    if (reduce) return;
    const from = end === 0 ? 99 : 0;
    el.textContent = pre + fmt(from) + suf;
    whenSeen(el, () => {
      const t0 = performance.now(), dur = 1600;
      const step = (t) => {
        const p = Math.min(1, (t - t0) / dur), k = 1 - Math.pow(1 - p, 4);
        el.textContent = pre + fmt(Math.round(from + (end - from) * k)) + suf;
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  });

  // ---------------------------------------------------------- EQ curve morph
  const eqLine = $('#eq-line'), eqFill = $('#eq-fill');
  if (eqLine) {
    const bands = [{ f: 0.08, g: -26, q: 0.05 }, { f: 0.3, g: 10, q: 0.08 }, { f: 0.62, g: -8, q: 0.07 }, { f: 0.85, g: 12, q: 0.1 }];
    const draw = (t) => {
      let d = '';
      for (let i = 0; i <= 80; i++) {
        const x = i / 80;
        let y = 40;
        bands.forEach((b, k) => {
          const g = b.g * (0.6 + 0.4 * Math.sin(t / 1400 + k * 1.7));
          y -= g * Math.exp(-((x - b.f) ** 2) / (2 * b.q * b.q)) * 0.9;
        });
        if (x < 0.12) y += (0.12 - x) * 200 * (0.7 + 0.3 * Math.sin(t / 2000));
        d += (i ? 'L' : 'M') + (x * 200).toFixed(1) + ' ' + Math.max(4, Math.min(76, y)).toFixed(1);
      }
      eqLine.setAttribute('d', d);
      eqFill.setAttribute('d', d + 'L200 80L0 80Z');
    };
    if (reduce) draw(0);
    else {
      let on = false;
      visible(eqLine.closest('.card'), (v) => { on = v; if (v) requestAnimationFrame(loop); });
      const loop = (t) => { draw(t); if (on) requestAnimationFrame(loop); };
      draw(0);
    }
  }

  // ---------------------------------------------------------- LUFS gauge
  const arc = $('#lufs-arc'), num = $('#lufs-num');
  if (arc) {
    // Gauge spans −30 … −6 LUFS; target −16.
    const set = (v) => {
      const p = (v + 30) / 24;
      arc.style.strokeDashoffset = String(158 * (1 - p));
      num.textContent = (v < 0 ? '−' : '') + Math.abs(v).toFixed(1);
    };
    set(-16);
    if (!reduce) {
      whenSeen(arc, () => {
        const run = () => {
          const t0 = performance.now(), start = -27 + Math.random() * 3;
          const step = (t) => {
            const p = Math.min(1, (t - t0) / 2200), k = 1 - Math.pow(1 - p, 3);
            set(start + (-16 - start) * k + (p < 1 ? (Math.random() - 0.5) * 0.6 * (1 - p) : 0));
            if (p < 1) requestAnimationFrame(step); else setTimeout(run, 4200);
          };
          requestAnimationFrame(step);
        };
        run();
      });
    }
  }

  // ---------------------------------------------------------- before/after enhancement
  const eb = $('#enhance-bars');
  if (eb) {
    const box = eb.parentElement;
    const N = eb.clientWidth < 500 ? 40 : 72, raw = [], clean = [];
    for (let i = 0; i < N; i++) {
      // Two speakers: one loud, one quiet, plus a noise floor in the pauses.
      const talk = Math.sin(i * 0.9) * 0.5 + 0.5;
      const seg = Math.round(N / 4), loudSpeaker = Math.floor(i / seg) % 2 === 0;
      const pause = (i % seg) > seg * 0.8;
      const level = pause ? 0.1 + Math.random() * 0.05 : (loudSpeaker ? 0.7 + talk * 0.3 : 0.22 + talk * 0.12);
      raw.push(Math.min(1, level * (0.75 + Math.random() * 0.25)));
      clean.push(pause ? 0.02 : 0.5 + talk * 0.22 + Math.random() * 0.06);
    }
    const bars = raw.map(() => { const b = document.createElement('i'); eb.appendChild(b); return b; });
    const set = (isRaw) => {
      box.classList.toggle('raw', isRaw);
      bars.forEach((b, i) => b.style.setProperty('--h', ((isRaw ? raw : clean)[i] * 100).toFixed(1) + '%'));
    };
    set(true);
    if (reduce) set(false);
    else {
      let isRaw = true, timer = null;
      visible(box, (v) => {
        clearInterval(timer);
        if (v) timer = setInterval(() => { isRaw = !isRaw; set(isRaw); }, 2600);
      });
    }
  }

  // ---------------------------------------------------------- typing terminals
  const type = (el, text, speed, done) => {
    let i = 0;
    const tick = () => { el.textContent = text.slice(0, ++i); if (i < text.length) setTimeout(tick, speed + Math.random() * speed); else if (done) done(); };
    tick();
  };
  const ai = $('.viz-term');
  if (ai) {
    const typed = $('.typed', ai), out = $('.ai-out', ai), aiLabel = $('.ai', ai);
    const full = out.textContent;
    typed.textContent = typed.dataset.text;
    if (!reduce) {
      const cycle = () => {
        typed.textContent = ''; out.textContent = ''; aiLabel.style.opacity = 0;
        type(typed, typed.dataset.text, 28, () => setTimeout(() => {
          aiLabel.style.opacity = 1;
          type(out, full, 12, () => setTimeout(cycle, 5000));
        }, 500));
      };
      whenSeen(ai, cycle);
    }
  }
  const term = $('#term');
  if (term && !reduce) {
    const lines = [...term.childNodes];
    const html = term.innerHTML;
    term.innerHTML = '';
    whenSeen(term, () => {
      // Type the commands line by line, keeping the prompt markup.
      const parts = html.split('\n');
      let li = 0;
      const next = () => {
        if (li >= parts.length) return;
        const line = parts[li++];
        const tmp = document.createElement('span'); tmp.innerHTML = line;
        const prompt = tmp.querySelector('.p');
        const row = document.createElement('span');
        term.appendChild(row);
        if (prompt) {
          const rest = tmp.textContent.slice(prompt.textContent.length);
          row.appendChild(prompt.cloneNode(true));
          const txt = document.createTextNode(''); row.appendChild(txt);
          let i = 0;
          const tick = () => { txt.data = rest.slice(0, ++i); if (i < rest.length) setTimeout(tick, 18 + Math.random() * 30); else { term.appendChild(document.createTextNode('\n')); setTimeout(next, 380); } };
          tick();
        } else {
          row.innerHTML = line; term.appendChild(document.createTextNode('\n')); setTimeout(next, 300);
        }
      };
      next();
    });
    void lines;
  }

  // ---------------------------------------------------------- tour tabs + tilt (one set per audience)
  $$('.tour-set').forEach((set) => {
    const tabs = $$('[role="tab"]', set), shots = $$('.shot', set), ink = $('.tab-ink', set), cap = $('.tour-caption', set);
    let cur = 0, auto = null, started = false;
    const moveInk = () => {
      const b = tabs[cur];
      if (!b.offsetWidth) return;
      ink.style.width = b.offsetWidth + 'px';
      ink.style.transform = `translateX(${b.offsetLeft}px)`;
    };
    const show = (i) => {
      cur = i;
      tabs.forEach((b, k) => b.setAttribute('aria-selected', String(k === i)));
      shots.forEach((sh, k) => sh.classList.toggle('active', k === i));
      cap.textContent = shots[i].dataset.caption;
      moveInk();
    };
    tabs.forEach((b, i) => b.addEventListener('click', () => { show(i); clearInterval(auto); auto = null; started = true; }));
    addEventListener('resize', moveInk);
    document.fonts?.ready.then(moveInk);
    onMode(() => requestAnimationFrame(moveInk));
    moveInk();
    if (!reduce) {
      new IntersectionObserver(([e]) => {
        if (!e.isIntersecting || started) return;
        started = true;
        auto = setInterval(() => { if (!document.hidden && set.offsetParent !== null) show((cur + 1) % shots.length); }, 5000);
      }, { threshold: 0.3 }).observe($('.tilt', set));
    }
    const tilt = $('.tilt-inner', set);
    if (tilt && fine && !reduce) {
      tilt.addEventListener('pointermove', (e) => {
        const r = tilt.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
        tilt.style.setProperty('--ry', (x - 0.5) * 8 + 'deg');
        tilt.style.setProperty('--rx', (0.5 - y) * 6 + 'deg');
        tilt.style.setProperty('--gx', x * 100 + '%');
        tilt.style.setProperty('--gy', y * 100 + '%');
      });
      tilt.addEventListener('pointerleave', () => { tilt.style.setProperty('--rx', '0deg'); tilt.style.setProperty('--ry', '0deg'); });
    }
  });

  // ---------------------------------------------------------- hero frame tilt on scroll
  const frame = $('.studio-frame');
  if (frame && !reduce) {
    const upd = () => {
      const r = frame.getBoundingClientRect();
      const p = Math.max(0, Math.min(1, 1 - (r.top - innerHeight * 0.15) / (innerHeight * 0.6)));
      frame.style.setProperty('--tilt', (14 * (1 - p)).toFixed(2) + 'deg');
      frame.style.setProperty('--scale', (0.96 + 0.04 * p).toFixed(3));
    };
    addEventListener('scroll', upd, { passive: true });
    addEventListener('resize', upd);
    upd();
  }

  // ---------------------------------------------------------- downloads
  const ua = (navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '').toLowerCase();
  const os = /mac|iphone|ipad/.test(ua) ? 'mac' : /win/.test(ua) ? 'windows' : /linux|x11|cros/.test(ua) && !/android/.test(ua) ? 'linux' : null;
  if (os) $(`.platform[data-os="${os}"]`)?.classList.add('mine');

  fetch('https://api.github.com/repos/michaelkleinhenz/wavepod/releases/latest')
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((release) => {
      const assets = release.assets || [];
      $$('.platform[data-ext]').forEach((link) => {
        const a = assets.find((x) => x.name.endsWith(link.dataset.ext));
        if (a) link.href = a.browser_download_url;
      });
      const v = release.tag_name.replace(/^v/, '');
      const date = new Date(release.published_at).toLocaleDateString('en', { year: 'numeric', month: 'long', day: 'numeric' });
      $('#release-line').textContent = `Latest version ${v}, released ${date}.`;
      $('#pill-text').textContent = `Version ${v} is out · Free & Open Source`;
    })
    .catch(() => {});

  // ---------------------------------------------------------- confetti on download
  const cf = $('#confetti');
  const cctx = cf.getContext('2d');
  let parts = [], cfRun = false;
  const colors = ['#4fc3f7', '#5c8dff', '#ba68c8', '#f06292', '#ffb74d', '#81c784'];
  const burst = (x, y) => {
    const dpr = Math.min(2, devicePixelRatio || 1);
    cf.width = innerWidth * dpr; cf.height = innerHeight * dpr; cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (let i = 0; i < 90; i++) {
      const a = Math.random() * Math.PI * 2, s = 3 + Math.random() * 7;
      parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 5, r: 3 + Math.random() * 4, c: colors[i % colors.length], life: 1, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4, w: Math.random() < 0.5 });
    }
    if (!cfRun) { cfRun = true; requestAnimationFrame(cfLoop); }
  };
  const cfLoop = () => {
    cctx.clearRect(0, 0, innerWidth, innerHeight);
    parts = parts.filter((p) => p.life > 0);
    for (const p of parts) {
      p.vy += 0.22; p.vx *= 0.985; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.life -= 0.012;
      cctx.save(); cctx.globalAlpha = Math.max(0, p.life); cctx.translate(p.x, p.y); cctx.rotate(p.rot); cctx.fillStyle = p.c;
      if (p.w) cctx.fillRect(-p.r, -p.r / 3, p.r * 2, p.r / 1.5); else { cctx.beginPath(); cctx.arc(0, 0, p.r / 1.4, 0, 7); cctx.fill(); }
      cctx.restore();
    }
    if (parts.length) requestAnimationFrame(cfLoop); else cfRun = false;
  };
  if (!reduce) $$('.platform').forEach((p) => p.addEventListener('click', (e) => burst(e.clientX, e.clientY)));

  // ---------------------------------------------------------- audio drama: voice effects
  // A stylised waveform of one spoken phrase, reshaped the way each effect changes it.
  // The chains are the app's own (src/core/fx/voiceEffects.ts).
  (() => {
    const cvx = $('#vfx-wave'), chips = $('#vfx-chips'), chain = $('#vfx-chain');
    if (!cvx) return;
    const EFFECTS = [
      ['Dry voice', '', 'Your actor, straight from the mic.'],
      ['Telephone', 'Band-pass › Distortion › Compressor', 'tel'],
      ['Old radio', 'Band-pass › Distortion › Compressor', 'radio'],
      ['Walkie-talkie', 'Band-pass › Distortion › Compressor', 'walkie'],
      ['Next room', 'Band-pass › Reverb', 'room'],
      ['Underwater', 'Band-pass › Reverb', 'water'],
      ['Robot', 'Ring modulator › Band-pass › Compressor', 'robot'],
      ['Giant', 'Pitch −7 › EQ › Reverb', 'giant'],
      ['Chipmunk', 'Pitch +12', 'chip'],
      ['Ghost', 'Chorus › Band-pass › Reverb', 'ghost'],
      ['Church', 'Reverb', 'church'],
      ['Far away', 'Band-pass › Echo', 'far'],
    ];
    const N = 220;
    const h = (n) => { n = (n ^ 61) ^ (n >>> 16); n = Math.imul(n, 0x27d4eb2d); n ^= n >>> 15; return (n >>> 0) / 4294967296; };
    // The dry phrase: syllables with gaps.
    const dry = Array.from({ length: N }, (_, i) => {
      const syl = Math.floor(i / 9), ph = (i % 9) / 9;
      const gap = h(syl * 7 + 3) < 0.16 || i > N - 26;
      return gap ? 0.02 : (0.3 + 0.7 * h(syl * 13 + 1)) * Math.sin(ph * Math.PI) ** 0.8;
    });
    const tail = (a, len, amt) => { const o = a.slice(); for (let i = 1; i < N; i++) o[i] = Math.max(o[i], o[i - 1] * (1 - 1 / len) * amt + o[i] * (1 - amt)); return o; };
    const smooth = (a, k) => a.map((_, i) => { let t = 0, c = 0; for (let j = -k; j <= k; j++) { const v = a[i + j]; if (v !== undefined) { t += v; c++; } } return t / c; });
    const shape = (kind) => {
      let a = dry.slice();
      switch (kind) {
        case 'tel': return a.map((v, i) => Math.min(0.5, v * 1.4) * (0.85 + 0.15 * h(i)) + 0.03 * h(i * 3));
        case 'radio': return a.map((v, i) => Math.min(0.55, v * 1.3) * (0.8 + 0.2 * Math.sin(i * 0.9)) + 0.07 * h(i * 5));
        case 'walkie': return a.map((v, i) => (v > 0.08 ? 0.5 : 0.02) * (0.9 + 0.1 * h(i)) + (i > N - 30 && i < N - 22 ? 0.4 * h(i) : 0));
        case 'room': return tail(smooth(a, 2).map((v) => v * 0.55), 8, 0.6);
        case 'water': return smooth(a, 5).map((v, i) => v * 0.75 * (0.8 + 0.2 * Math.sin(i * 0.15)));
        case 'robot': return a.map((v, i) => v * (0.55 + 0.45 * Math.sign(Math.sin(i * 1.3))));
        case 'giant': { const o = []; for (let i = 0; i < N; i++) o.push(dry[Math.floor(i * 0.7)] * 1.1); return tail(o, 10, 0.5).map((v) => Math.min(1, v)); }
        case 'chip': { const o = []; for (let i = 0; i < N; i++) o.push(dry[Math.floor((i * 1.9) % (N - 26))] * (i < N * 0.52 ? 1 : 0.02) * 0.8); return o; }
        case 'ghost': return tail(a.map((v, i) => v * 0.6 * (0.7 + 0.3 * Math.sin(i * 0.25))), 18, 0.75);
        case 'church': return tail(a.map((v) => v * 0.8), 26, 0.85);
        case 'far': { const o = a.map((v) => v * 0.35); for (let i = 26; i < N; i++) o[i] = Math.max(o[i], o[i - 26] * 0.45); return o; }
        default: return a;
      }
    };
    const targets = EFFECTS.map((e) => shape(e[2]));
    let cur = dry.slice(), pick = 1, user = false, W = 0, H = 0;
    const ctx = cvx.getContext('2d');
    const size = () => {
      const dpr = Math.min(2, devicePixelRatio || 1);
      W = cvx.clientWidth; H = cvx.clientHeight;
      cvx.width = W * dpr; cvx.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const draw = () => {
      ctx.clearRect(0, 0, W, H);
      const mid = H / 2 + 6, half = H / 2 - 14, n = W < 500 ? 110 : N, step = N / n, bw = W / n;
      const g = ctx.createLinearGradient(0, 0, W, 0);
      const st = getComputedStyle(root);
      g.addColorStop(0, '#ffd27a'); g.addColorStop(0.5, pick ? '#ff5a6a' : '#4fc3f7'); g.addColorStop(1, '#c04dff');
      ctx.fillStyle = g;
      ctx.shadowColor = `rgb(${st.getPropertyValue('--glow').trim().replace(/\s+/g, ',')})`; ctx.shadowBlur = 10;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const v = cur[Math.floor(i * step)], a = Math.max(1, v * half);
        ctx.rect(i * bw + 1, mid - a, Math.max(1, bw - 1.5), a * 2);
      }
      ctx.fill();
      ctx.shadowBlur = 0;
    };
    const select = (i) => {
      pick = i;
      $$('button', chips).forEach((b, k) => b.setAttribute('aria-pressed', String(k === i)));
      const e = EFFECTS[i];
      chain.innerHTML = e[1] ? `<b>${e[0]}</b> = ${e[1]}` : e[2];
      if (reduce) { cur = targets[i].slice(); draw(); }
    };
    EFFECTS.forEach((e, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = e[0]; b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => { user = true; select(i); });
      if (fine) b.addEventListener('pointerenter', () => { user = true; select(i); });
      chips.appendChild(b);
    });
    size(); select(1);
    addEventListener('resize', () => { size(); draw(); });
    onMode(() => requestAnimationFrame(() => { size(); draw(); }));
    if (reduce) { cur = targets[1].slice(); draw(); return; }
    let on = false;
    const loop = () => {
      const t = targets[pick];
      for (let i = 0; i < N; i++) cur[i] += (t[i] - cur[i]) * 0.14;
      draw();
      if (on) requestAnimationFrame(loop);
    };
    visible(cvx, (v) => { on = v; if (v) { size(); requestAnimationFrame(loop); } });
    setInterval(() => { if (on && !user && !document.hidden) select(pick % (EFFECTS.length - 1) + 1); }, 2400);
  })();

  // ---------------------------------------------------------- audio drama: room & distance
  (() => {
    const c = $('#room-cv');
    if (!c) return;
    const ctx = c.getContext('2d');
    const PLACES = [['Stairwell', 0.7], ['Living room', 0.35], ['Cave', 1], ['Forest', 0.15], ['Church', 0.95], ['Car', 0.1]];
    let W = 0, H = 0;
    const size = () => {
      const dpr = Math.min(2, devicePixelRatio || 1);
      W = c.clientWidth; H = c.clientHeight;
      c.width = W * dpr; c.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const draw = (t) => {
      ctx.clearRect(0, 0, W, H);
      const cyc = 7000, k = Math.floor(t / cyc), p = (t % cyc) / cyc;
      const [place, size_] = PLACES[k % PLACES.length];
      // distance: walks away and back, 0.5 … 12 m
      const walk = p < 0.45 ? p / 0.45 : p < 0.6 ? 1 : 1 - (p - 0.6) / 0.4;
      const ease = walk * walk * (3 - 2 * walk);
      const dist = 0.5 + ease * 11.5;
      const micX = 40, y = H / 2, far = W - 70;
      const sx = micX + 30 + ease * (far - micX - 30);
      // room walls
      const pad = 10 + (1 - size_) * 22;
      ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 1;
      ctx.setLineDash([4, 5]); ctx.strokeRect(pad, pad, W - pad * 2, H - pad * 2); ctx.setLineDash([]);
      // reflections: rings from the speaker, more and stronger with distance and room size
      const rings = 3 + Math.round(size_ * 3);
      for (let r = 0; r < rings; r++) {
        const ph = ((t / 900) + r / rings) % 1;
        const rad = 8 + ph * (60 + size_ * 140);
        ctx.strokeStyle = `rgba(255,160,110,${(1 - ph) * (0.15 + 0.5 * ease) * (0.5 + size_ * 0.5)})`;
        ctx.beginPath(); ctx.arc(sx, y, rad, 0, Math.PI * 2); ctx.stroke();
      }
      // direct sound: line from speaker to mic, fading with distance
      const gl = ctx.createLinearGradient(micX, 0, sx, 0);
      gl.addColorStop(0, `rgba(255,210,122,${0.9 - ease * 0.6})`); gl.addColorStop(1, 'rgba(255,210,122,0.1)');
      ctx.strokeStyle = gl; ctx.lineWidth = 2 - ease; ctx.beginPath(); ctx.moveTo(micX + 10, y); ctx.lineTo(sx - 8, y); ctx.stroke();
      // mic
      ctx.fillStyle = '#eef0f6';
      ctx.beginPath(); ctx.roundRect ? ctx.roundRect(micX - 6, y - 14, 12, 20, 6) : ctx.rect(micX - 6, y - 14, 12, 20); ctx.fill();
      ctx.fillRect(micX - 1, y + 6, 2, 8); ctx.fillRect(micX - 6, y + 14, 12, 2);
      // speaker
      ctx.fillStyle = '#ffb347'; ctx.shadowColor = '#ff7a3d'; ctx.shadowBlur = 16;
      ctx.beginPath(); ctx.arc(sx, y, 7, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
      // labels
      ctx.font = '600 11px "JetBrains Mono", monospace'; ctx.fillStyle = '#9aa1b4'; ctx.textBaseline = 'top';
      ctx.fillText(`ROOM & DISTANCE · ${place.toUpperCase()}`, pad + 8, pad + 7);
      ctx.textAlign = 'right'; ctx.fillStyle = '#ffd27a'; ctx.font = '700 20px "Space Grotesk", sans-serif';
      ctx.fillText(`${dist.toFixed(1)} m`, W - pad - 8, H - pad - 28);
      ctx.textAlign = 'left';
    };
    size();
    addEventListener('resize', () => { size(); draw(reduce ? 2500 : performance.now()); });
    onMode(() => requestAnimationFrame(() => { size(); draw(reduce ? 2500 : performance.now()); }));
    if (reduce) { draw(2500); return; }
    let on = false;
    const loop = (t) => { draw(t); if (on) requestAnimationFrame(loop); };
    visible(c, (v) => { on = v; if (v) { size(); requestAnimationFrame(loop); } });
  })();

  // ---------------------------------------------------------- audio drama: sound library search
  (() => {
    const q = $('#lib-q'), list = $('#lib-list');
    if (!q) return;
    const SOUNDS = [
      ['door-creak-old-wood', 'Doors', '3.1 s'], ['door-slam-heavy', 'Doors', '1.4 s'], ['door-knock-three-times', 'Doors', '1.8 s'],
      ['footsteps-gravel', 'Footsteps', '11.5 s'], ['footsteps-wooden-floor', 'Footsteps', '7.6 s'],
      ['rain-on-window', 'Atmo', '14 s'], ['forest-wind-birds', 'Atmo', '14 s'], ['thunder-distant', 'Atmo', '6 s'],
      ['phone-ring-old', 'Props', '5 s'], ['clock-ticking', 'Props', '10 s'],
    ];
    const QUERIES = ['door creak', 'rain', 'footsteps', 'thunder', 'door'];
    const render = (text, on) => {
      q.textContent = text;
      const words = text.toLowerCase().split(/\s+/).filter(Boolean);
      const hits = SOUNDS.filter(([n]) => words.every((w) => n.split('-').some((p) => p.startsWith(w)))).slice(0, 3);
      list.innerHTML = '';
      hits.forEach(([n, f, d], i) => {
        const li = document.createElement('li');
        if (i === on) li.className = 'on';
        const name = n.split('-').map((p) => (words.some((w) => p.startsWith(w)) ? `<b>${p}</b>` : p)).join('-');
        li.innerHTML = `<i class="play"></i><span>${name}</span><small>${f} · ${d}</small>`;
        list.appendChild(li);
      });
    };
    if (reduce) { render('door creak', 0); return; }
    let qi = 0, started = false;
    const run = async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      for (;;) {
        const text = QUERIES[qi++ % QUERIES.length];
        for (let i = 1; i <= text.length; i++) { render(text.slice(0, i), -1); await wait(90 + Math.random() * 70); }
        await wait(350); render(text, 0); await wait(1100); render(text, 1); await wait(1100);
        for (let i = text.length; i >= 0; i--) { render(text.slice(0, i), -1); await wait(30); }
        await wait(300);
      }
    };
    render('', -1);
    whenSeen(list.parentElement, () => { if (!started) { started = true; run(); } });
  })();

  // ---------------------------------------------------------- live studio demo
  const cv = $('#studio');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const MODES = {
    podcast: {
      tracks: [
        { name: 'Host', input: '3: Combo 1', color: '#4fc3f7' },
        { name: 'Guest', input: '4: Combo 2', color: '#ffb74d' },
        { name: 'Co-host', input: '5: Combo 3', color: '#81c784' },
        { name: 'Soundboard', input: 'Jingles', color: '#ba68c8' },
      ],
      titles: ['Welcome', 'Listener mail', 'News of the week', 'Interview', 'Tools & tips', 'Picks', 'Goodbye'],
      armed: 3, info: '48 kHz · 24-bit · 4 armed', file: (tr) => `${tr.name}-001.wav`,
    },
    drama: {
      tracks: [
        { name: 'Narrator', input: '3: Combo 1', color: '#4fc3f7', fx: 'Close to the mic' },
        { name: 'Mara', input: '4: Combo 2', color: '#ba68c8', fx: 'Telephone' },
        { name: 'Rain', input: 'Atmo', color: '#81c784', fx: 'Loop' },
        { name: 'Footsteps', input: 'SFX', color: '#ffb74d', fx: 'Pan automation' },
      ],
      titles: ['Scene 1 · Night train', 'Scene 2 · The call', 'Scene 3 · Platform', 'Scene 4 · The tunnel', 'Scene 5 · Back on board', 'Scene 6 · Morning'],
      armed: 2, info: '48 kHz · 24-bit · 2 armed', file: (tr, i) => ['Narrator-001.wav', 'Mara-001.wav', 'rain-on-window.wav', 'footsteps-gravel.wav'][i],
    },
  };
  let MODE = MODES[modeNow()];
  let TRACKS = MODE.tracks, TITLES = MODE.titles;
  // Footsteps walk past in bursts; pan follows them from left to right.
  const stepBurst = (s) => { const k = Math.floor(s / 13), p = s - k * 13; return p < 6 ? p / 6 : -1; };
  const panAt = (s) => {
    const b = stepBurst(s);
    if (b >= 0) return -0.9 + 1.8 * (b * b * (3 - 2 * b));
    const k = Math.floor(s / 13);
    return k % 2 ? -0.9 : 0.9;
  };
  const COLS_PER_SEC = 24;   // waveform columns per second of audio
  const PX_PER_SEC = 64;     // timeline zoom
  const hash = (n) => { n = (n ^ 61) ^ (n >>> 16); n = Math.imul(n, 0x27d4eb2d); n ^= n >>> 15; return (n >>> 0) / 4294967296; };

  // Who is talking at second s: turns of 3–8 s between the three speakers.
  const turnAt = (() => {
    const starts = [0], who = [0];
    return (s) => {
      while (starts[starts.length - 1] <= s + 20) {
        const k = starts.length;
        starts.push(starts[k - 1] + 3 + hash(k * 7 + 1) * 5);
        let w = Math.floor(hash(k * 13 + 5) * 3);
        if (w === who[k - 1]) w = (w + 1) % 3;
        who.push(w);
      }
      let lo = 0, hi = starts.length - 1;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= s) lo = m; else hi = m - 1; }
      return { who: who[lo], start: starts[lo], end: starts[lo + 1] };
    };
  })();

  const markers = []; // { t, title, born }
  const mutes = [[], [], []]; // per track [start, end|null]
  let jingleAt = [0.3];
  const amp = (track, col) => {
    const s = col / COLS_PER_SEC;
    if (s < 0) return 0;
    if (track === 3) {
      for (const j of jingleAt) if (s >= j && s < j + 3.2) {
        const p = (s - j) / 3.2;
        return (0.55 + 0.25 * Math.sin(s * 12)) * Math.min(1, p * 8) * Math.min(1, (1 - p) * 3);
      }
      return 0.01 * hash(col);
    }
    if (MODE === MODES.drama) {
      if (track === 2) return (0.2 + 0.13 * hash(col * 5 + 9)) * (0.85 + 0.15 * Math.sin(s * 0.8));
      if (track === 3) {
        if (stepBurst(s) < 0) return 0.008 * hash(col);
        const ph = (s * 1.9) % 1;
        return ph < 0.14 ? (0.75 - ph * 4) * (0.8 + 0.2 * hash(Math.floor(s * 1.9))) : 0.01 * hash(col);
      }
      const t = turnAt(s);
      const who = t.who === 2 ? 0 : t.who;
      const syl = Math.floor(col / 4);
      const env = Math.sin(((col % 4) + 0.5) / 4 * Math.PI);
      const edge = Math.min(1, (s - t.start) * 4, (t.end - s) * 4);
      if (who !== track) return 0.02 * hash(col * 3 + track);
      const gap = hash(syl * 31 + track * 101) < 0.13;
      const v = (gap ? 0.05 : 0.35 + 0.6 * hash(syl * 17 + track)) * env * edge;
      return track === 1 ? Math.min(0.42, v * 1.2) + 0.04 : v; // the phone: narrow and squashed
    }
    for (const [a, b] of mutes[track]) if (s >= a && (b === null || s < b)) return 0;
    const t = turnAt(s);
    const own = t.who === track;
    const syl = Math.floor(col / 4);
    const gap = hash(syl * 31 + track * 101) < 0.13;
    const env = Math.sin(((col % 4) + 0.5) / 4 * Math.PI);
    const edge = Math.min(1, (s - t.start) * 4, (t.end - s) * 4);
    const base = own ? (gap ? 0.05 : 0.35 + 0.6 * hash(syl * 17 + track)) * env * edge : 0.03 * hash(col * 3 + track);
    return base * (0.85 + 0.3 * hash(col * 7 + track * 3));
  };

  let W = 0, H = 0, dpr = 1, headW = 170, rulerH = 34, trackH = 90, topH = 50;
  const resize = () => {
    dpr = Math.min(2, devicePixelRatio || 1);
    W = cv.clientWidth; H = cv.clientHeight; // layout size, unaffected by the 3D tilt
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    headW = W < 560 ? 104 : 170;
    topH = 46;
    trackH = (H - topH - rulerH) / TRACKS.length;
  };
  resize();
  addEventListener('resize', () => { resize(); frameDraw(performance.now()); });

  let hover = null; // x in canvas px
  cv.addEventListener('pointermove', (e) => { const r = cv.getBoundingClientRect(); hover = e.clientX - r.left; });
  cv.addEventListener('pointerleave', () => { hover = null; });
  // A click or tap drops a chapter marker too, so touch screens can play along.
  cv.addEventListener('click', () => { addMarker(); if (reduce) frameDraw(0); });
  if (!fine) $('.studio-hint').textContent = 'This is a live demo. Tap the tracks to drop a chapter marker, and drag across them to scrub.';

  const t0 = performance.now();
  // Start far enough into the show that the visible timeline is already full.
  const startOffset = Math.max(20, Math.ceil(((W - headW) * 0.8) / PX_PER_SEC) + 4);
  let now = startOffset;
  const addMarker = (title) => {
    markers.push({ t: now, title: title || TITLES[markers.length % TITLES.length], born: performance.now() });
    jingleAt.push(now);
  };
  const seedMarkers = () => {
    markers.length = 0;
    markers.push({ t: 0.3, title: TITLES[0], born: -1e9 });
    markers.push({ t: now - 9, title: TITLES[1], born: -1e9 });
    jingleAt.push(now - 9);
  };
  seedMarkers();
  onMode((m) => {
    MODE = MODES[m]; TRACKS = MODE.tracks; TITLES = MODE.titles;
    mutes.forEach((x) => (x.length = 0));
    seedMarkers();
    if (reduce) frameDraw(0);
  });

  let inView = false;
  visible(cv, (v) => { inView = v; });
  addEventListener('keydown', (e) => {
    if (!inView || e.target.closest?.('input, textarea')) return;
    if (e.key === 'm' || e.key === 'M') { addMarker(); e.preventDefault(); }
    const n = Number(e.key);
    if (MODE !== MODES.podcast) return;
    if (n >= 1 && n <= 3 && !e.repeat) { const m = mutes[n - 1]; if (!m.length || m[m.length - 1][1] !== null) m.push([now, null]); }
  });
  addEventListener('keyup', (e) => {
    const n = Number(e.key);
    if (n >= 1 && n <= 3) { const m = mutes[n - 1]; if (m.length && m[m.length - 1][1] === null) m[m.length - 1][1] = now; }
  });

  const meters = TRACKS.map(() => ({ v: 0, peak: 0, hold: 0 }));
  const fmtTime = (s) => {
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec.toFixed(3).padStart(6, '0')}`;
  };
  const roundRect = (x, y, w, h, r) => { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); };

  let nextAuto = startOffset + 5;
  const frameDraw = (tms) => {
    if (!reduce) now = startOffset + (tms - t0) / 1000;
    if (!reduce && now > nextAuto) { addMarker(); nextAuto = now + 14 + Math.random() * 8; }

    const laneX = headW, laneW = W - headW;
    const headPos = laneX + laneW * 0.8;           // where the record head sits
    const viewStart = now - (headPos - laneX) / PX_PER_SEC;
    const xOf = (s) => laneX + (s - viewStart) * PX_PER_SEC;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#14161d'; ctx.fillRect(0, 0, W, H);

    // transport bar
    ctx.fillStyle = '#101218'; ctx.fillRect(0, 0, W, topH);
    ctx.fillStyle = '#1d2029'; ctx.fillRect(0, topH - 1, W, 1);
    const cx = W < 560 ? 12 : headW - 150;
    ctx.font = '600 20px "JetBrains Mono", monospace';
    roundRect(cx, 8, W < 560 ? 168 : 196, 30, 6); ctx.fillStyle = '#07080c'; ctx.fill();
    ctx.fillStyle = '#f1f3f8'; ctx.textBaseline = 'middle';
    ctx.font = `600 ${W < 560 ? 15 : 17}px "JetBrains Mono", monospace`;
    ctx.fillText(fmtTime(now), cx + 12, 24);
    if (W >= 560) {
      const bx = cx + 214;
      [['⏮', '#2a2e3b'], ['■', '#2a2e3b'], ['▶', '#2a2e3b'], ['●', '#3a1820']].forEach(([g, bg], i) => {
        roundRect(bx + i * 40, 9, 32, 28, 6); ctx.fillStyle = bg; ctx.fill();
        ctx.fillStyle = i === 3 ? '#ff4d5e' : '#c9cdd8'; ctx.font = '14px Inter, sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(g, bx + i * 40 + 16, 24);
      });
      ctx.textAlign = 'right'; ctx.fillStyle = '#7d8496'; ctx.font = '500 12px Inter, sans-serif';
      ctx.fillText(MODE.info, W - 16, 24);
      ctx.textAlign = 'left';
    }

    // ruler
    const ry = topH;
    ctx.fillStyle = '#111319'; ctx.fillRect(laneX, ry, laneW, rulerH);
    ctx.font = '500 11px Inter, sans-serif'; ctx.fillStyle = '#7d8496';
    const step = PX_PER_SEC < 40 ? 10 : 5;
    for (let s = Math.ceil(viewStart / step) * step; s < now + 10; s += step) {
      const x = xOf(s); if (x < laneX) continue;
      ctx.fillRect(x, ry + rulerH - 8, 1, 8);
      const m = Math.floor(s / 60), sec = s % 60;
      ctx.fillText(`${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`, x + 4, ry + 12);
    }
    for (let s = Math.ceil(viewStart); s < now + 10; s++) { const x = xOf(s); if (x >= laneX) ctx.fillRect(x, ry + rulerH - 4, 1, 4); }

    // tracks
    const ty0 = topH + rulerH;
    TRACKS.forEach((tr, i) => {
      const y = ty0 + i * trackH;
      // header
      const g = ctx.createLinearGradient(0, y, headW, y);
      g.addColorStop(0, tr.color + '40'); g.addColorStop(1, tr.color + '14');
      ctx.fillStyle = '#181b23'; ctx.fillRect(0, y, headW, trackH - 2);
      ctx.fillStyle = g; ctx.fillRect(0, y, headW, trackH - 2);
      ctx.fillStyle = tr.color; ctx.fillRect(0, y, 4, trackH - 2);
      ctx.fillStyle = '#eef0f6'; ctx.font = '700 14px Inter, sans-serif';
      ctx.fillText(tr.name, 14, y + 18);
      if (headW > 120) {
        ctx.fillStyle = '#8b92a4'; ctx.font = '500 11px Inter, sans-serif';
        ctx.fillText(tr.input, 14, y + 36);
        if (tr.fx && trackH > 70) { // the track's effect
          ctx.font = '600 10px Inter, sans-serif';
          const tw = Math.min(headW - 28, ctx.measureText(tr.fx).width + 12);
          roundRect(14, y + 44, tw, 16, 4); ctx.fillStyle = tr.color + '30'; ctx.fill();
          ctx.fillStyle = tr.color; ctx.fillText(tr.fx, 20, y + 52.5, tw - 12);
        }
        if (i < MODE.armed) { // armed + cough indicators
          roundRect(headW - 34, y + 8, 22, 20, 5); ctx.fillStyle = '#e5394a'; ctx.fill();
          ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(headW - 23, y + 18, 4, 0, 7); ctx.fill();
          const coughing = mutes[i].length && mutes[i][mutes[i].length - 1][1] === null;
          roundRect(headW - 60, y + 8, 22, 20, 5); ctx.fillStyle = coughing ? '#ff6b6b' : '#262a35'; ctx.fill();
          ctx.fillStyle = coughing ? '#fff' : '#ff6b6b'; ctx.font = '700 11px Inter, sans-serif'; ctx.textAlign = 'center';
          ctx.fillText('C', headW - 49, y + 18.5); ctx.textAlign = 'left';
        }
      }
      // meter
      const live = Math.max(amp(i, Math.floor(now * COLS_PER_SEC)), amp(i, Math.floor(now * COLS_PER_SEC) - 1));
      const m = meters[i];
      m.v = Math.max(live, m.v * 0.9);
      if (m.v > m.peak) { m.peak = m.v; m.hold = 40; } else if (--m.hold < 0) m.peak *= 0.97;
      const mw = headW - 28, my = y + trackH - 22;
      roundRect(14, my, mw, 7, 3); ctx.fillStyle = '#0a0b10'; ctx.fill();
      const mg = ctx.createLinearGradient(14, 0, 14 + mw, 0);
      mg.addColorStop(0, '#2fbf71'); mg.addColorStop(0.7, '#a9d64a'); mg.addColorStop(0.86, '#e8d04a'); mg.addColorStop(1, '#ff5d6c');
      ctx.save(); roundRect(14, my, mw * Math.min(1, m.v * 1.1), 7, 3); ctx.clip(); ctx.fillStyle = mg; ctx.fillRect(14, my, mw, 7); ctx.restore();
      ctx.fillStyle = '#fff'; ctx.fillRect(14 + mw * Math.min(1, m.peak * 1.1), my - 1, 2, 9);

      // lane
      ctx.fillStyle = i % 2 ? '#171920' : '#15171e'; ctx.fillRect(laneX, y, laneW, trackH - 2);
      const clipStart = Math.max(laneX, xOf(0)), clipEnd = xOf(now);
      if (clipEnd > laneX) {
        ctx.fillStyle = tr.color + '1c'; ctx.fillRect(clipStart, y + 2, clipEnd - clipStart, trackH - 6);
        ctx.fillStyle = tr.color; ctx.fillRect(clipStart, y + 2, clipEnd - clipStart, 2);
        if (clipStart > laneX) { ctx.font = '500 10px Inter, sans-serif'; ctx.fillStyle = '#c9cdd8'; ctx.fillText(MODE.file(tr, i), clipStart + 5, y + 14); }
      }
      // waveform
      const mid = y + trackH / 2 + 4, half = trackH / 2 - 12;
      ctx.fillStyle = tr.color;
      const c0 = Math.max(0, Math.floor(viewStart * COLS_PER_SEC)), c1 = Math.floor(now * COLS_PER_SEC);
      const colW = PX_PER_SEC / COLS_PER_SEC;
      ctx.beginPath();
      for (let c = c0; c <= c1; c++) {
        const x = xOf(c / COLS_PER_SEC);
        if (x < laneX - colW) continue;
        const a = amp(i, c) * half;
        ctx.rect(x, mid - a, colW * 0.72, Math.max(1, a * 2));
      }
      ctx.fill();
      // hover highlight (scrub)
      if (hover !== null && hover > laneX && hover < headPos) {
        ctx.save(); ctx.beginPath(); ctx.rect(hover - 40, y, 80, trackH); ctx.clip();
        ctx.shadowColor = tr.color; ctx.shadowBlur = 14; ctx.fillStyle = '#fff'; ctx.globalAlpha = 0.5;
        ctx.beginPath();
        for (let c = c0; c <= c1; c++) { const x = xOf(c / COLS_PER_SEC); if (x < hover - 40 || x > hover + 40) continue; const a = amp(i, c) * half; ctx.rect(x, mid - a, colW * 0.72, Math.max(1, a * 2)); }
        ctx.fill(); ctx.restore();
      }
      // pan automation lane on the footsteps
      if (MODE === MODES.drama && i === 3) {
        const top = y + 12, span = trackH - 26, yOf = (v) => top + (v + 1) / 2 * span;
        ctx.save();
        ctx.beginPath(); ctx.rect(laneX, y, laneW, trackH); ctx.clip();
        ctx.strokeStyle = '#ffd27a'; ctx.lineWidth = 1.6; ctx.shadowColor = '#ffb74d'; ctx.shadowBlur = 6;
        ctx.beginPath();
        for (let x = laneX; x <= xOf(now); x += 3) { const v = panAt(viewStart + (x - laneX) / PX_PER_SEC); x === laneX ? ctx.moveTo(x, yOf(v)) : ctx.lineTo(x, yOf(v)); }
        ctx.stroke(); ctx.shadowBlur = 0;
        ctx.fillStyle = '#ffd27a';
        for (let k = Math.floor(viewStart / 13); k <= Math.floor(now / 13); k++) for (const ts of [k * 13, k * 13 + 6]) {
          if (ts > now) continue; const x = xOf(ts); if (x < laneX) continue;
          ctx.beginPath(); ctx.arc(x, yOf(panAt(ts + (ts === k * 13 ? 0.001 : -0.001))), 3, 0, 7); ctx.fill();
        }
        ctx.font = '600 9px "JetBrains Mono", monospace'; ctx.fillStyle = '#8b92a4';
        ctx.fillText('L', laneX + 4, top + 3); ctx.fillText('R', laneX + 4, top + span - 1);
        ctx.restore();
      }
      // the rain is a looped clip: dashed lines where each repeat starts
      if (MODE === MODES.drama && i === 2) {
        ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.setLineDash([3, 3]);
        for (let k = Math.max(1, Math.ceil(viewStart / 14)); k * 14 < now; k++) {
          const x = Math.round(xOf(k * 14)) + 0.5;
          if (x > laneX + 4) { ctx.beginPath(); ctx.moveTo(x, y + 16); ctx.lineTo(x, y + trackH - 6); ctx.stroke(); }
        }
        ctx.restore();
      }
      // cough-muted regions
      if (i < 3) for (const [a, b] of mutes[i]) {
        const x0 = Math.max(laneX, xOf(a)), x1 = xOf(b === null ? now : b);
        if (x1 <= laneX) continue;
        ctx.fillStyle = 'rgba(255,90,90,0.16)'; ctx.fillRect(x0, y + 4, x1 - x0, trackH - 10);
        ctx.fillStyle = 'rgba(255,107,107,0.9)'; ctx.fillRect(x0, y + trackH - 8, x1 - x0, 2);
      }
      ctx.fillStyle = '#0d0f14'; ctx.fillRect(0, y + trackH - 2, W, 2);
    });

    // header column separator
    ctx.fillStyle = '#262a35'; ctx.fillRect(laneX - 1, topH, 1, H - topH);

    // markers
    const tnow = performance.now();
    for (const mk of markers) {
      const x = xOf(mk.t);
      if (x < laneX - 200 || x > W) continue;
      const age = (tnow - mk.born) / 600;
      const drop = reduce ? 1 : Math.min(1, age);
      const bounce = 1 - Math.pow(1 - drop, 3) + (drop < 1 ? 0 : 0);
      const fy = topH + 6 - (1 - bounce) * 30;
      ctx.save();
      ctx.beginPath(); ctx.rect(laneX, topH, laneW, H - topH); ctx.clip();
      ctx.strokeStyle = 'rgba(255,200,60,0.45)'; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(x + 0.5, topH + rulerH); ctx.lineTo(x + 0.5, H); ctx.stroke(); ctx.setLineDash([]);
      ctx.globalAlpha = drop;
      ctx.fillStyle = '#ffc83c'; roundRect(x, fy + 12, 7, 16, 2); ctx.fill();
      ctx.font = '600 11px Inter, sans-serif'; ctx.fillStyle = '#f3e6c0'; ctx.fillText(mk.title, x + 11, fy + 21);
      if (age < 1.6 && !reduce) { // ripple
        const rr = age * 40; ctx.globalAlpha = Math.max(0, 1 - age / 1.6) * 0.8;
        ctx.strokeStyle = '#ffc83c'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x + 3, fy + 20, rr, 0, 7); ctx.stroke();
      }
      ctx.restore();
    }

    // record head with glow
    const hg = ctx.createLinearGradient(headPos - 90, 0, headPos, 0);
    hg.addColorStop(0, 'rgba(255,77,94,0)'); hg.addColorStop(1, 'rgba(255,77,94,0.16)');
    ctx.fillStyle = hg; ctx.fillRect(headPos - 90, topH + rulerH, 90, H - topH - rulerH);
    ctx.fillStyle = '#ff4d5e'; ctx.fillRect(headPos - 1, topH, 2, H - topH);
    ctx.beginPath(); ctx.moveTo(headPos - 6, topH); ctx.lineTo(headPos + 6, topH); ctx.lineTo(headPos, topH + 8); ctx.fill();

    // scrub line
    if (hover !== null && hover > laneX && hover < headPos) {
      ctx.fillStyle = '#ffffff'; ctx.fillRect(hover, topH, 1, H - topH);
      const s = viewStart + (hover - laneX) / PX_PER_SEC;
      const label = fmtTime(Math.max(0, s));
      ctx.font = '600 11px "JetBrains Mono", monospace';
      const tw = ctx.measureText(label).width + 12;
      roundRect(Math.min(hover + 6, W - tw - 4), topH + 6, tw, 20, 5); ctx.fillStyle = '#fff'; ctx.fill();
      ctx.fillStyle = '#0b0d13'; ctx.fillText(label, Math.min(hover + 12, W - tw + 2), topH + 16.5);
    }

    // fade the left edge so the history scrolls off softly
    const fg = ctx.createLinearGradient(laneX, 0, laneX + 40, 0);
    fg.addColorStop(0, 'rgba(20,22,29,0.9)'); fg.addColorStop(1, 'rgba(20,22,29,0)');
    ctx.fillStyle = fg; ctx.fillRect(laneX, topH + rulerH, 40, H - topH - rulerH);
  };

  if (reduce) {
    // One still frame, a little into the show, redrawn on resize and hover.
    const still = () => frameDraw(0);
    document.fonts?.ready.then(still); still();
    addEventListener('resize', still);
    cv.addEventListener('pointermove', still); cv.addEventListener('pointerleave', still);
    addEventListener('keydown', () => setTimeout(still));
    addEventListener('keyup', () => setTimeout(still));
  } else {
    let running = false;
    const loop = (t) => { if (!inView || document.hidden) { running = false; return; } frameDraw(t); requestAnimationFrame(loop); };
    const kick = () => { if (!running && inView && !document.hidden) { running = true; requestAnimationFrame(loop); } };
    visible(cv, (v) => { inView = v; kick(); });
    document.addEventListener('visibilitychange', kick);
    frameDraw(t0);
  }
  // ---------------------------------------------------------- text-based editing demo
  (() => {
    const demo = $('#te-demo');
    if (!demo) return;
    const textEl = $('#te-text'), waveEl = $('#te-wave'), statusEl = $('#te-status');
    const SCRIPTS = {
      podcast: {
        spk: { Anna: 'var(--cyan)', Ben: 'var(--amber)' },
        lines: [
          ['Anna', 'Welcome back! Today we edit a podcast like a document.'],
          ['Ben', 'Um, that sounds, uh, too good to be true.'],
          ['Anna', 'Delete a sentence in the text, you know, like this one, and it is cut from every track.', 4.3],
          ['Ben', 'And the, um, hesitations?'],
          ['Anna', 'One click. And if I misspeak, I type the fix. It is a lot of fun.'],
        ],
        cut: ['you', 'one,'], target: 'fun.', fix: 'fun to work with.', voice: 'Anna', what: 'episode',
      },
      drama: {
        spk: { Hale: 'var(--cyan)', Mara: 'var(--pink)' },
        lines: [
          ['Hale', 'Where were you last night, Mara?'],
          ['Mara', 'Um, on the train. The, uh, night train to the coast.'],
          ['Hale', 'The conductor says, and I quote, sorry, let me take that again, you were never on it.', 4.3],
          ['Mara', 'Then he, um, is lying.'],
          ['Hale', 'One of you is lying. And I will find out who tonight.'],
        ],
        cut: ['sorry,', 'again,'], target: 'tonight.', fix: 'before we reach the coast.', voice: 'Hale', what: 'scene',
      },
    };
    let SC = SCRIPTS[modeNow()], SPK = SC.spk;
    const FILLER = /^(um|uh|ähm|äh)\W*$/i;
    let words = [], pxPerSec = 10, busy = false, user = false, timers = [];

    const fmt = (s) => { s = Math.max(0, Math.round(s)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
    const later = (ms) => new Promise((r) => timers.push(setTimeout(r, reduce ? 0 : ms)));
    const length = () => words.reduce((a, w) => a + (w.cut ? 0 : w.dur), 0);
    const say = (html) => { statusEl.innerHTML = html; };
    // paragraph start times follow the edits, like in the app
    const times = () => {
      let t = 0; const seen = new Set();
      for (const w of words) {
        if (!seen.has(w.para)) { seen.add(w.para); w.para.querySelector('time').textContent = fmt(t); }
        if (!w.cut) t += w.dur;
      }
    };
    const lengthLine = () => { times(); return `${SC.what === 'scene' ? 'Scene' : 'Episode'} length <b>${fmt(length())}</b>`; };

    const segFor = (w) => {
      const seg = document.createElement('span');
      seg.className = 'seg' + (w.pause ? ' pause' : '') + (w.isNew ? ' new' : '');
      seg.style.setProperty('--c', SPK[w.who]);
      const n = Math.max(1, Math.round((w.dur * pxPerSec) / 4));
      for (let i = 0; i < n; i++) {
        const b = document.createElement('i');
        const env = Math.sin(Math.PI * (i + 0.5) / n) ** 0.6;
        b.style.setProperty('--h', (w.pause ? 4 + Math.random() * 3 : 12 + env * (30 + Math.random() * 55)).toFixed(0) + '%');
        seg.appendChild(b);
      }
      return seg;
    };
    const sizeSeg = (w) => { w.seg.style.width = (w.cut ? 0 : w.dur * pxPerSec) + 'px'; };

    const layout = () => {
      const total = words.reduce((a, w) => a + w.dur, 0);
      pxPerSec = (waveEl.clientWidth - 6) / total;
      waveEl.innerHTML = '';
      for (const w of words) { w.seg = segFor(w); if (w.cut) w.seg.classList.add('cut'); sizeSeg(w); waveEl.appendChild(w.seg); }
    };
    const build = () => {
      textEl.innerHTML = ''; words = [];
      let t = 0;
      for (const [who, line, pause] of SC.lines) {
        const para = document.createElement('div');
        para.className = 'te-para'; para.style.setProperty('--c', SPK[who]);
        para.innerHTML = `<small>${who}<time></time></small>`;
        const p = document.createElement('p');
        for (const text of line.split(' ')) {
          const filler = FILLER.test(text);
          const dur = filler ? 0.7 : 0.12 + text.replace(/\W/g, '').length * 0.06;
          const el = document.createElement('span');
          el.className = 'tw' + (filler ? ' filler' : '');
          el.textContent = text + ' ';
          p.appendChild(el);
          words.push({ el, text, who, dur, filler, cut: false, para });
          t += dur;
        }
        if (pause) {
          const el = document.createElement('span');
          el.className = 'tw pause'; el.textContent = `··· ${pause.toFixed(1)} s `;
          p.appendChild(el);
          words.push({ el, text: '', who, dur: pause, pause, cut: false, para });
          t += pause;
        }
        para.appendChild(p); textEl.appendChild(para);
      }
      words.forEach((w, i) => { w.el.dataset.i = i; });
      layout();
      say('Click a word to cut it, or drag across words. ' + lengthLine());
    };
    let lastW = 0;
    addEventListener('resize', () => { if (waveEl.clientWidth !== lastW) { lastW = waveEl.clientWidth; layout(); } });

    const select = (a, b) => {
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      words.forEach((w, i) => { const on = i >= lo && i <= hi && !w.cut; w.el.classList.toggle('sel', on); w.seg.classList.toggle('sel', on); });
    };
    const cut = (list) => {
      let s = 0;
      for (const w of list) {
        if (w.cut) continue;
        w.cut = true; s += w.dur;
        w.el.classList.remove('sel'); w.seg.classList.remove('sel');
        w.el.classList.add('cut'); w.seg.classList.add('cut'); sizeSeg(w);
      }
      return s;
    };
    const cutSelection = async () => {
      const sel = words.filter((w) => w.el.classList.contains('sel'));
      if (!sel.length) return;
      busy = true;
      await later(380);
      const quote = sel.map((w) => w.text).join(' ').trim();
      const s = cut(sel);
      say(`Cut “${quote.length > 34 ? quote.slice(0, 32) + '…' : quote}” from both tracks · −${s.toFixed(1)} s · ${lengthLine()}`);
      busy = false;
    };

    // autoplay control (declared before the handlers that stop it)
    let playing = false, gen = 0;
    const halt = () => { gen++; timers.forEach(clearTimeout); timers = []; busy = false; };
    const stopAuto = () => { if (!user) { user = true; halt(); } };

    // pointer: click or drag across words
    let anchor = null;
    const idx = (e) => { const el = e.target.closest('.tw'); return el && !el.classList.contains('cut') ? Number(el.dataset.i) : null; };
    textEl.addEventListener('pointerdown', (e) => {
      if (busy && user) return;
      stopAuto();
      const i = idx(e); if (i === null) return;
      e.preventDefault(); anchor = i; select(i, i);
    });
    textEl.addEventListener('pointerover', (e) => { if (anchor === null) return; const i = idx(e); if (i !== null) select(anchor, i); });
    addEventListener('pointerup', () => { if (anchor === null) return; anchor = null; void cutSelection(); });

    const clean = async () => {
      if (busy) return; busy = true;
      const fillers = words.filter((w) => w.filler && !w.cut);
      const pauses = words.filter((w) => w.pause && !w.cut && w.dur > 0.7);
      if (!fillers.length && !pauses.length) { say('Nothing left to clean up. ' + lengthLine()); busy = false; return; }
      fillers.forEach((w) => { w.el.classList.add('sel'); w.seg.classList.add('sel'); });
      await later(500);
      let s = cut(fillers);
      for (const w of pauses) { s += w.dur - 0.7; w.dur = 0.7; w.el.textContent = '··· 0.7 s '; sizeSeg(w); }
      say(`Removed ${fillers.length} hesitation${fillers.length === 1 ? '' : 's'}${pauses.length ? ', shortened the long pause' : ''} · −${s.toFixed(1)} s · ${lengthLine()}`);
      busy = false;
    };
    const speak = async () => {
      if (busy) return;
      const target = words.find((w) => w.text === SC.target && !w.cut && !w.isNew);
      if (!target) { say('Already changed. Press ↺ to start over.'); return; }
      busy = true;
      target.el.classList.add('sel'); target.seg.classList.add('sel');
      say(`Double-click “${SC.target}”, type the new words…`);
      await later(450);
      cut([target]);
      const el = document.createElement('span');
      el.className = 'tw new typing';
      target.el.after(el);
      const text = SC.fix;
      for (let k = 1; k <= text.length; k++) { el.textContent = text.slice(0, k); await later(45); }
      el.textContent = text + ' '; el.classList.remove('typing');
      say(`Saying it in ${SC.voice}’s cloned voice…`);
      await later(700);
      const w = { el, text, who: SC.voice, dur: 1.1, isNew: true, cut: false, para: target.para };
      w.seg = segFor(w); w.seg.style.width = '0px';
      target.seg.after(w.seg);
      words.splice(words.indexOf(target) + 1, 0, w);
      words.forEach((x, i) => { x.el.dataset.i = i; });
      requestAnimationFrame(() => requestAnimationFrame(() => sizeSeg(w)));
      say(`Replaced “${SC.target}” in ${SC.voice}’s voice <span class="badge-exp">Experimental</span> ${lengthLine()}`);
      busy = false;
    };
    const acts = { clean, speak, reset: () => { busy = false; build(); } };
    $$('.te-actions button', demo).forEach((b) => b.addEventListener('click', () => {
      const wasAuto = !user;
      stopAuto();
      // the first click takes over from the autoplay: start from a fresh transcript
      if (wasAuto && b.dataset.act !== 'reset') build();
      void acts[b.dataset.act]();
    }));

    // autoplay: a short edit session, on a loop, until the visitor takes over
    const auto = async () => {
      const my = ++gen;
      const alive = () => my === gen && !user;
      while (alive()) {
        build();
        await later(1600); if (!alive()) return;
        const from = words.findIndex((w) => w.text === SC.cut[0]), to = words.findIndex((w) => w.text === SC.cut[1]);
        for (let i = from; i <= to; i++) { select(from, i); await later(140); if (!alive()) return; }
        await cutSelection(); await later(2200); if (!alive()) return;
        await clean(); await later(2600); if (!alive()) return;
        await speak(); await later(4200); if (!alive()) return;
      }
    };
    build(); lastW = waveEl.clientWidth;
    document.fonts?.ready.then(() => { if (!user && !playing) layout(); });
    let inView = false;
    if (!reduce) visible(demo, (v) => {
      inView = v;
      if (user) return;
      if (v && !playing) { playing = true; void auto(); }
      else if (!v && playing) { playing = false; halt(); }
    });
    // A podcast conversation or a scene from the drama, whichever the visitor is here for.
    onMode((m) => {
      SC = SCRIPTS[m]; SPK = SC.spk;
      halt(); playing = false;
      requestAnimationFrame(() => {
        build(); lastW = waveEl.clientWidth;
        if (!reduce && !user && inView) { playing = true; void auto(); }
      });
    });
  })();
})();
