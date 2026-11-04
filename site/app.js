// WavePod web page: effects and the live studio demo. Plain JS, no dependencies.
(() => {
  'use strict';
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = matchMedia('(pointer: fine)').matches;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

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
  const mq = $('.marquee-track');
  if (mq) mq.append(...[...mq.children].map((n) => { const c = n.cloneNode(true); c.setAttribute('aria-hidden', 'true'); return c; }));

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

  // ---------------------------------------------------------- tour tabs + tilt
  const tabs = $$('.tabs button'), shots = $$('.shot'), ink = $('.tab-ink'), cap = $('#tour-caption');
  const captions = [
    'Every speaker on a track of their own, with chapters, edit marks and the soundboard.',
    'Check every input level and create a track per microphone in one click.',
    'Stack filters per track, see what each one does live, and save your own presets.',
    'Export MP3, WAV and chapter files, normalised to your loudness target.',
    'Titles, links and images for every chapter, ready for Podlove and Podcasting 2.0.',
  ];
  let cur = 0, auto = null;
  const moveInk = () => {
    const b = tabs[cur];
    ink.style.width = b.offsetWidth + 'px';
    ink.style.transform = `translateX(${b.offsetLeft}px)`;
  };
  const show = (i) => {
    cur = i;
    tabs.forEach((b, k) => b.setAttribute('aria-selected', String(k === i)));
    shots.forEach((s, k) => s.classList.toggle('active', k === i));
    cap.textContent = captions[i];
    moveInk();
  };
  tabs.forEach((b, i) => b.addEventListener('click', () => { show(i); clearInterval(auto); auto = null; }));
  addEventListener('resize', moveInk);
  document.fonts?.ready.then(moveInk);
  moveInk();
  if (!reduce) {
    whenSeen($('#tilt'), () => {
      auto = setInterval(() => { if (!document.hidden) show((cur + 1) % shots.length); }, 5000);
    });
  }
  const tilt = $('#tilt .tilt-inner');
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

  // ---------------------------------------------------------- live studio demo
  const cv = $('#studio');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const TRACKS = [
    { name: 'Host', input: '3: Combo 1', color: '#4fc3f7' },
    { name: 'Guest', input: '4: Combo 2', color: '#ffb74d' },
    { name: 'Co-host', input: '5: Combo 3', color: '#81c784' },
    { name: 'Soundboard', input: 'Jingles', color: '#ba68c8' },
  ];
  const TITLES = ['Welcome', 'Listener mail', 'News of the week', 'Interview', 'Tools & tips', 'Picks', 'Goodbye'];
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
  markers.push({ t: 0.3, title: 'Welcome', born: -1e9 });
  markers.push({ t: startOffset - 9, title: 'Listener mail', born: -1e9 });
  jingleAt.push(startOffset - 9);

  let inView = false;
  visible(cv, (v) => { inView = v; });
  addEventListener('keydown', (e) => {
    if (!inView || e.target.closest?.('input, textarea')) return;
    if (e.key === 'm' || e.key === 'M') { addMarker(); e.preventDefault(); }
    const n = Number(e.key);
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
      ctx.fillText('48 kHz · 24-bit · 4 armed', W - 16, 24);
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
        if (i < 3) { // armed + cough indicators
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
        if (clipStart > laneX) { ctx.font = '500 10px Inter, sans-serif'; ctx.fillStyle = '#c9cdd8'; ctx.fillText(`${tr.name}-001.wav`, clipStart + 5, y + 14); }
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
})();
