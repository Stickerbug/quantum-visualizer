/* Hydrogen wavefunction viewer — UI, camera and scheduling.
 * Depends on: js/special.js, js/atom.js, js/renderer.js (classic scripts, no modules)
 */
(function () {
  'use strict';

  var A = window.QAtom;
  var R = window.QRenderer;

  var R2 = window.QRenderer2D;
  var stage = document.getElementById('stage');
  var canvas = document.getElementById('gl');
  var using2D = false;
  var renderer;

  function force2DRequested() {
    return /(^|[?&])force2d=1/.test(location.search);
  }

  function makeRenderer() {
    if (!force2DRequested()) {
      try {
        var r = new R.Renderer(canvas);
        canvas.addEventListener('webglcontextlost', function (ev) {
          ev.preventDefault();
          switchTo2D();
        }, false);
        return r;
      } catch (e) { /* fall through */ }
    }
    using2D = true;
    return new R2.Renderer2D(canvas);
  }

  try {
    renderer = makeRenderer();
  } catch (err) {
    document.getElementById('fatal').hidden = false;
    document.getElementById('fatal-msg').textContent = (err && err.message) || String(err);
    return;
  }

  /* ------------------------------------------------------------------ */
  var els = {
    n: document.getElementById('in-n'),
    l: document.getElementById('in-l'),
    m: document.getElementById('in-m'),
    z: document.getElementById('in-z'),
    points: document.getElementById('in-points'),
    size: document.getElementById('in-size'),
    complex: document.getElementById('in-complex'),
    rotate: document.getElementById('in-rotate'),
    axes: document.getElementById('in-axes'),
    y: document.getElementById('in-y'),
    decades: document.getElementById('in-decades'),
    rmax: document.getElementById('in-rmax'),
    vSize: document.getElementById('v-size'),
    vY: document.getElementById('v-y'),
    vR: document.getElementById('v-r'),
    modeSeg: document.getElementById('mode-seg'),
    cloudOpts: document.getElementById('cloud-opts'),
    sliceOpts: document.getElementById('slice-opts'),
    presets: document.getElementById('presets'),
    badge: document.getElementById('badge'),
    statusTitle: document.getElementById('status-title'),
    statusCard: document.getElementById('status-card'),
    reasons: document.getElementById('reasons'),
    warnings: document.getElementById('warnings'),
    meta: document.getElementById('meta'),
    hudTitle: document.getElementById('hud-title'),
    hudSub: document.getElementById('hud-sub'),
    hudWarn: document.getElementById('hud-warn'),
    stBuild: document.getElementById('st-build'),
    stSample: document.getElementById('st-sample'),
    stFps: document.getElementById('st-fps'),
    stView: document.getElementById('st-view'),
    toast: document.getElementById('toast'),
    hintline: document.getElementById('hintline'),
    panelBtn: document.getElementById('btn-panel')
  };

  var state = {
    n: 2, l: 1, m: 0, z: 1,
    mode: 'cloud',
    points: 250000,
    size: 2.6,
    complex: false,
    rotate: true,
    axes: false,
    sliceY: 0,
    decades: 6,
    rMul: 1
  };

  // Dev overrides, e.g. index.html?points=50000&size=4&alpha=0.02
  try {
    var qs = new URLSearchParams(location.search);
    if (qs.get('points')) state.points = Math.max(100, parseInt(qs.get('points'), 10) || state.points);
    if (qs.get('size')) state.size = parseFloat(qs.get('size')) || state.size;
    if (qs.get('alpha')) state.alphaOverride = parseFloat(qs.get('alpha'));
    if (qs.get('n')) { state.n = parseFloat(qs.get('n')); els.n.value = state.n; }
    if (qs.get('l')) { state.l = parseFloat(qs.get('l')); els.l.value = state.l; }
    if (qs.get('m')) { state.m = parseFloat(qs.get('m')); els.m.value = state.m; }
    if (qs.get('mode') === 'slice') state.mode = 'slice';
    if (qs.get('complex') === '1') state.complex = true;
    if (qs.get('rotate') === '0') { state.rotate = false; els.rotate.checked = false; }
  } catch (_) {}

  var cur = { rMax: 1, M: 0, rad: null, ang: null, phi: null };
  var pump = { gen: 0 };
  var lastCloud = null, lastCloudCount = 0, lastSlice = null;
  var fitKey = '';

  function radiusAtFraction(rad, frac) {
    var lo = 0, hi = rad.M - 1;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (rad.cdf[mid] < frac) lo = mid + 1; else hi = mid;
    }
    return rad.r[lo];
  }

  function fitDistance(rad) {
    var r95 = radiusAtFraction(rad, 0.95);
    var world = r95 / rad.rMax;
    var d = world / (0.62 * Math.tan(21 * Math.PI / 180));
    return clamp(d, 1.1, 9);
  }

  /*
   * If the GL context dies (broken driver, GPU reset, tab restored), rebuild
   * the scene on a fresh Canvas2D canvas instead of leaving a blank page.
   */
  function switchTo2D() {
    if (using2D) return;
    using2D = true;
    var old = canvas;
    var c2 = document.createElement('canvas');
    c2.id = 'gl2';
    c2.setAttribute('aria-label', 'wavefunction');
    c2.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;';
    old.style.display = 'none';
    stage.insertBefore(c2, old.nextSibling);
    renderer = new R2.Renderer2D(c2);
    canvas = c2;
    renderer.resize();
    renderer.mode = state.mode;
    renderer.showAxes = state.axes;
    if (lastSlice) renderer.setSlice(lastSlice.data, lastSlice.size, state.sliceY);
    if (lastCloud) {
      renderer.setCloudCapacity(state.points);
      renderer.uploadCloud(lastCloud, 0, lastCloudCount);
    }
    showToast('WebGL 上下文丢失，已切换到 Canvas2D 兼容渲染。', 5000);
    requestDraw();
  }

  var cam = { yaw: -0.72, pitch: 0.30, dist: 3.1 };
  var dirty = true;
  var toastTimer = 0;
  var rebuildTimer = 0;
  var sliceTimer = 0;

  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function fmt2(x) { return (Math.round(x * 100) / 100).toFixed(2); }
  function fmtInt(x) { return String(Math.round(x)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }

  /* ---------------- toast ---------------- */
  function showToast(msg, ms) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.classList.remove('show'); }, ms || 3600);
  }

  /* ---------------- status ---------------- */
  function fillList(ul, items) {
    ul.textContent = '';
    for (var i = 0; i < items.length; i++) {
      var li = document.createElement('li');
      li.textContent = items[i];
      ul.appendChild(li);
    }
    ul.hidden = items.length === 0;
  }

  function updateStatus(info) {
    els.badge.textContent = info.physical ? '物理束缚态' : '非物理 · 解析延拓';
    els.badge.className = 'badge' + (info.physical ? '' : ' nonphysical');
    els.statusCard.classList.toggle('nonphysical', !info.physical);
    els.statusTitle.textContent = 'n=' + state.n + ', l=' + state.l + ', m=' + state.m + ' · Z=' + state.z;
    fillList(els.reasons, info.reasons);
    fillList(els.warnings, info.warnings);
  }

  function meanRadius(rad) {
    var num = 0, den = 0;
    for (var i = 1; i < rad.M; i++) {
      var dr = rad.r[i] - rad.r[i - 1];
      var w = rad.rho[i];
      num += rad.r[i] * w * dr;
      den += w * dr;
    }
    return den > 0 ? num / den : NaN;
  }

  function updateMeta(info) {
    var parts = [];
    parts.push('r_max = ' + fmt2(cur.rMax) + ' a₀');
    parts.push('M = ' + fmtInt(cur.M));
    var mr = meanRadius(cur.rad);
    if (isFinite(mr)) parts.push('⟨r⟩ ≈ ' + fmt2(mr) + ' a₀');
    if (info.physical) {
      var nodes = Math.round(state.n - state.l - 1);
      parts.push('径向节点 = ' + nodes);
      if (state.l > 0 && state.z === 1) parts.push('⟨r⟩解析 = ' + fmt2(0.5 * (3 * state.n * state.n - state.l * (state.l + 1))));
    }
    els.meta.textContent = parts.join(' · ');
  }

  function updateHud(info) {
    var sub = info.physical ? '物理束缚态' : '非物理（截断归一）';
    if (state.mode === 'slice') {
      sub += ' · x–z 截面 · y = ' + fmt2(state.sliceY * cur.rMax) + ' a₀';
    } else {
      sub += ' · ' + (state.complex ? '复轨道 · 相位着色' : '实轨道 · 按符号着色');
    }
    els.hudTitle.innerHTML = 'ψ<sub>' + state.n + ',' + state.l + ',' + state.m + '</sub>';
    els.hudSub.textContent = sub;
    if (!info.physical && info.reasons.length) {
      els.hudWarn.hidden = false;
      els.hudWarn.textContent = info.reasons[0];
    } else if (info.warnings.length) {
      els.hudWarn.hidden = false;
      els.hudWarn.textContent = info.warnings[0];
    } else {
      els.hudWarn.hidden = true;
      els.hudWarn.textContent = '';
    }
  }

  function updateViewStat() {
    els.stView.textContent = fmt2(cur.rMax * cam.dist * Math.tan(21 * Math.PI / 180)) + ' a₀';
  }

  /* ---------------- sampling ---------------- */
  function alphaFor(n) {
    if (isFinite(state.alphaOverride)) return state.alphaOverride;
    // Additive accumulation: brightness ~ alpha * overlaps, so alpha must fall
    // roughly like 1/count to keep the same exposure when the point count changes.
    var a = 0.02 * (250000 / n);
    return clamp(a, 0.004, 0.12);
  }

  function startCloud() {
    var gen = ++pump.gen;
    renderer.mode = 'cloud';
    renderer.setCloudCapacity(state.points);
    var data = new Float32Array(state.points * 4);
    var sampler = A.createSampler(cur.rad, cur.ang, cur.phi, state.complex, (0x9e3779b9 ^ (gen * 2654435761)) >>> 0);
    var at = 0;
    var chunk = 60000;
    var sampleMs = 0;
    lastCloud = data;
    lastCloudCount = 0;
    els.stSample.textContent = '…';

    function step() {
      if (gen !== pump.gen) return;
      var cnt = Math.min(chunk, state.points - at);
      var ts = performance.now();
      sampler(data, at, cnt);
      sampleMs += performance.now() - ts;
      renderer.uploadCloud(data, at, cnt);
      at += cnt;
      lastCloudCount = at;
      if (at >= state.points) els.stSample.textContent = Math.round(sampleMs) + ' ms';
      requestDraw();
      if (at < state.points) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function startSlice() {
    ++pump.gen;
    var t0 = performance.now();
    var sl = A.buildSlice(cur.rad, cur.ang, state.m, state.sliceY, 512, state.complex, state.decades);
    lastSlice = sl;
    renderer.mode = 'slice';
    renderer.setSlice(sl.data, sl.size, state.sliceY);
    els.stSample.textContent = Math.round(performance.now() - t0) + ' ms';
  }

  /* ---------------- rebuild ---------------- */
  function readQuantum() {
    var n = parseFloat(els.n.value);
    var l = parseFloat(els.l.value);
    var m = parseFloat(els.m.value);
    var z = parseFloat(els.z.value);
    if (!isFinite(n) || n === 0) return { error: 'n 必须是 ≠ 0 的实数（n=0 时径向方程无解）' };
    if (!isFinite(l) || l < 0) return { error: 'l 必须是 ≥ 0 的实数' };
    if (!isFinite(m) || !Number.isInteger(m)) return { error: 'm 必须是整数（否则 e^{imφ} 不是单值函数）' };
    if (!isFinite(z) || z <= 0) return { error: 'Z 必须大于 0' };
    if (Math.abs(n) > 300) return { error: '|n| ≤ 300：这是渲染节点数上限，不是物理约束' };
    if (l > 400) return { error: 'l ≤ 400：角向递推的数值上限' };
    if (Math.abs(m) > 400) return { error: '|m| ≤ 400：角向表的数值上限' };
    return { n: n, l: l, m: m, z: z };
  }

  function rebuild() {
    var q = readQuantum();
    if (q.error) { showToast(q.error); return; }
    state.n = q.n; state.l = q.l; state.m = q.m; state.z = q.z;

    var t0 = performance.now();
    var info = A.classify(state.n, state.l, state.m);
    updateStatus(info);

    var base = A.chooseRange(state.n, state.l, state.z, info.physical);
    var rMax = base * state.rMul;
    var M = clamp(Math.round(2048 + 80 * Math.abs(state.n)), 2048, 12000);
    var rad = A.computeRadial(state.n, state.l, state.z, rMax, M);
    if (rad.error) { showToast(rad.error); return; }

    var ang = A.computeAngular(state.l, state.m);
    if (ang.zero) {
      showToast('P_' + state.l + '^' + state.m + ' ≡ 0：角向函数恒为零，没有可显示的概率密度。可试试非整数 l（如 l=0.5, m=1）。', 5200);
      return;
    }
    var phi = state.complex ? null : A.computePhi(state.m);

    cur = { rMax: rMax, M: M, rad: rad, ang: ang, phi: phi };
    var key = state.n + '|' + state.l + '|' + state.m + '|' + state.z;
    if (key !== fitKey) {
      fitKey = key;
      cam.dist = state.mode === 'slice' ? 2.8 : fitDistance(rad);
    }
    els.stBuild.textContent = Math.round(performance.now() - t0) + ' ms';
    updateMeta(info);
    updateHud(info);
    updateViewStat();

    if (state.mode === 'cloud') startCloud(); else startSlice();
    requestDraw();
    els.hintline.textContent = state.mode === 'slice' ? '滚轮缩放 · 双击复位' : '拖拽旋转 · 滚轮缩放 · 双击复位';
  }

  function scheduleRebuild(delay) {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(rebuild, delay == null ? 220 : delay);
  }

  function scheduleSlice(delay) {
    clearTimeout(sliceTimer);
    sliceTimer = setTimeout(function () {
      if (state.mode !== 'slice' || !cur.rad) return;
      updateHud(A.classify(state.n, state.l, state.m));
      updateViewStat();
      startSlice();
      requestDraw();
    }, delay == null ? 70 : delay);
  }

  /* ---------------- draw loop ---------------- */
  function requestDraw() { dirty = true; }

  var last = 0, frames = 0, fpsAt = 0;

  function loop(now) {
    requestAnimationFrame(loop);
    var dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;

    if (state.rotate && state.mode === 'cloud' && !document.hidden) {
      cam.yaw += dt * 0.26;
      dirty = true;
    }

    if (dirty) {
      var yaw = state.mode === 'slice' ? -Math.PI / 2 : cam.yaw;
      var pitch = state.mode === 'slice' ? 0 : cam.pitch;
      renderer.draw(yaw, pitch, cam.dist, state.size, alphaFor(state.points), state.complex ? 1 : 0);
      dirty = false;
      frames++;
    }

    if (now - fpsAt > 500) {
      els.stFps.textContent = frames ? Math.round(frames * 1000 / Math.max(1, now - fpsAt)) : '—';
      frames = 0;
      fpsAt = now;
    }
  }

  /* ---------------- interaction ---------------- */
  var drag = null;
  var pointers = new Map();
  var pinchDist = 0;

  stage.addEventListener('pointerdown', function (e) {
    try { stage.setPointerCapture(e.pointerId); } catch (_) {}
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
    else { drag = null; pinchDist = 0; }
  });

  stage.addEventListener('pointermove', function (e) {
    var p = pointers.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX; p.y = e.clientY;

    if (pointers.size >= 2) {
      var it = pointers.values();
      var a = it.next().value, b = it.next().value;
      var d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0 && d > 0) {
        cam.dist = clamp(cam.dist * (pinchDist / d), 0.03, 30);
        updateViewStat();
        requestDraw();
      }
      pinchDist = d;
      return;
    }
    if (state.mode === 'slice' || !drag || e.pointerId !== drag.id) return;
    cam.yaw -= (e.clientX - drag.x) * 0.0062;
    cam.pitch = clamp(cam.pitch + (e.clientY - drag.y) * 0.0062, -1.45, 1.45);
    drag.x = e.clientX; drag.y = e.clientY;
    updateViewStat();
    requestDraw();
  });

  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (pointers.size === 0) drag = null;
  }
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);

  stage.addEventListener('wheel', function (e) {
    e.preventDefault();
    var dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    cam.dist = clamp(cam.dist * Math.exp(dy * 0.0011), 0.03, 30);
    updateViewStat();
    requestDraw();
  }, { passive: false });

  stage.addEventListener('dblclick', function () {
    cam.yaw = -0.72; cam.pitch = 0.30; cam.dist = state.mode === 'slice' ? 2.8 : 3.1;
    updateViewStat();
    requestDraw();
  });

  /* ---------------- controls ---------------- */
  var PRESETS = [
    { label: '1s', n: 1, l: 0, m: 0 },
    { label: '2p', n: 2, l: 1, m: 0 },
    { label: '3d', n: 3, l: 2, m: -1 },
    { label: '4f', n: 4, l: 3, m: 2 },
    { label: 'l = n', n: 1, l: 1, m: 0, weird: true },
    { label: 'n = 1.5', n: 1.5, l: 0, m: 0, weird: true },
    { label: 'n = −2', n: -2, l: 1, m: 0, weird: true },
    { label: 'l = ½, m = 1', n: 2, l: 0.5, m: 1, weird: true }
  ];

  (function buildPresets() {
    PRESETS.forEach(function (p) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = p.label;
      if (p.weird) b.className = 'weird';
      b.addEventListener('click', function () {
        els.n.value = p.n; els.l.value = p.l; els.m.value = p.m;
        rebuild();
        if (window.innerWidth <= 920) document.body.classList.remove('panel-open');
      });
      els.presets.appendChild(b);
    });
  })();

  els.n.addEventListener('input', function () { scheduleRebuild(); });
  els.l.addEventListener('input', function () { scheduleRebuild(); });
  els.m.addEventListener('input', function () { scheduleRebuild(); });
  els.z.addEventListener('input', function () { scheduleRebuild(); });
  els.z.addEventListener('change', function () { rebuild(); });

  els.points.addEventListener('change', function () {
    state.points = parseInt(els.points.value, 10) || 250000;
    if (state.mode === 'cloud') rebuild();
  });

  els.size.addEventListener('input', function () {
    state.size = parseFloat(els.size.value);
    els.vSize.textContent = state.size;
    requestDraw();
  });

  els.complex.addEventListener('change', function () {
    state.complex = els.complex.checked;
    rebuild();
  });

  els.rotate.addEventListener('change', function () {
    state.rotate = els.rotate.checked;
    requestDraw();
  });

  els.axes.addEventListener('change', function () {
    state.axes = els.axes.checked;
    renderer.showAxes = state.axes;
    requestDraw();
  });

  els.y.addEventListener('input', function () {
    state.sliceY = parseFloat(els.y.value);
    els.vY.textContent = state.sliceY.toFixed(2);
    scheduleSlice(40);
  });

  els.decades.addEventListener('change', function () {
    state.decades = parseInt(els.decades.value, 10) || 6;
    if (state.mode === 'slice') { startSlice(); requestDraw(); }
  });

  els.rmax.addEventListener('input', function () {
    state.rMul = parseFloat(els.rmax.value);
    els.vR.textContent = state.rMul.toFixed(2) + '×';
    scheduleRebuild(180);
  });

  els.modeSeg.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    var mode = btn.getAttribute('data-mode');
    if (mode === state.mode) return;
    state.mode = mode;
    Array.prototype.forEach.call(els.modeSeg.children, function (b) {
      b.classList.toggle('on', b.getAttribute('data-mode') === mode);
    });
    els.cloudOpts.hidden = mode !== 'cloud';
    els.sliceOpts.hidden = mode !== 'slice';
    els.hintline.textContent = mode === 'slice' ? '滚轮缩放 · 双击复位' : '拖拽旋转 · 滚轮缩放 · 双击复位';
    if (mode === 'slice') cam.dist = 2.8;
    rebuild();
  });

  els.panelBtn.addEventListener('click', function () {
    document.body.classList.toggle('panel-open');
  });

  /* ---------------- boot ---------------- */
  function resize() {
    renderer.resize();
    requestDraw();
  }
  if (window.ResizeObserver) {
    new ResizeObserver(resize).observe(document.getElementById('stage'));
  } else {
    window.addEventListener('resize', resize);
  }
  window.addEventListener('resize', resize);

  if (window.matchMedia && window.matchMedia('(max-width: 920px)').matches) {
    document.body.classList.remove('panel-open');
  }

  renderer.resize();
  if (state.mode === 'slice') {
    els.cloudOpts.hidden = true;
    els.sliceOpts.hidden = false;
    Array.prototype.forEach.call(els.modeSeg.children, function (b) {
      b.classList.toggle('on', b.getAttribute('data-mode') === 'slice');
    });
    cam.dist = 2.8;
  }
  if (state.complex) els.complex.checked = true;
  els.vSize.textContent = state.size;
  els.vY.textContent = state.sliceY;
  els.vR.textContent = state.rMul.toFixed(2) + '×';
  rebuild();
  requestAnimationFrame(loop);
})();
