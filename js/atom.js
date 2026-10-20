/*
 * atom.js — hydrogenic wavefunctions, probability tables and sampling.
 *
 * Quantum numbers are accepted without the usual n > l ≥ |m| clamping:
 *   n : real, n ≠ 0, |n| ≤ 300   (larger n has more radial nodes than a
 *                                 screen can resolve; that is a rendering
 *                                 limit, not a physics clamp)
 *   l : real ≥ 0 (non-integer → formal Legendre continuation)
 *   m : integer
 *   Z : real > 0
 *
 * Radial function in Bohr units:
 *   R_nl(r) ∝ e^(−x/2) x^l ₁F₁(l+1−n; 2l+2; x),   x = 2Zr/n
 *
 * For physical states the ₁F₁ series terminates and R decays like e^(−r/n).
 * Otherwise it does not terminate: R ~ e^(+r/n) and the state cannot be
 * normalised. We then window [0, rMax] and renormalise, which is all a finite
 * picture can do; the UI says so.
 *
 * Performance notes (the page must stay fluid even without a GPU):
 *   - every distribution is tabulated once and inverted into an O(1) lookup,
 *   - sampling uses precomputed sin/cos/√(1−cos²θ) tables, zero trig calls,
 *   - the 2D slice is built from 1D log-density LUTs, zero logs per pixel.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./special.js'));
  else root.QAtom = factory(root.QSpecial);
})(typeof self !== 'undefined' ? self : this, function (S) {
  'use strict';

  var clamp = function (x, a, b) { return x < a ? a : x > b ? b : x; };
  var TAU = Math.PI * 2;
  var INV_TAU = 1 / TAU;

  /* ------------------------------------------------------------------ *
   * Classification
   * ------------------------------------------------------------------ */
  function classify(n, l, m) {
    var physical =
      Number.isInteger(n) && n >= 1 && n <= 300 &&
      Number.isInteger(l) && l >= 0 && l <= n - 1 &&
      Number.isInteger(m) && Math.abs(m) <= l;

    var reasons = [];
    var warnings = [];

    if (n === 0) reasons.push('n = 0：能量 E ∝ 1/n² 发散，径向方程没有解。');
    if (n < 0) reasons.push('n < 0：能量与 |n| 相同，但取到的是 r→∞ 指数增长的那支解。');
    if (n !== 0 && !Number.isInteger(n)) reasons.push('n 不是整数：₁F₁ 级数不截断，R(r) ~ e^(r/n)，平方不可积。');
    if (Math.abs(n) > 300) reasons.push('|n| > 300：超过可交互渲染的节点数上限（这是渲染限制，不是物理约束）。');
    if (l < 0) reasons.push('l < 0：本工具只画 l ≥ 0（P_(−l−1) = P_l，可改用 −l−1）。');
    if (l > 400) reasons.push('l > 400：超过角向递推的数值上限（渲染限制）。');
    if (!Number.isInteger(l)) warnings.push('l 非整数：Y_lm 不是球面上的单值函数；角向按连带 Legendre 的解析延拓计算，θ→π 附近被截断。');
    if (Number.isInteger(n) && n > 0 && n <= 300 && Number.isInteger(l) && l >= n) {
      reasons.push('l ≥ n：离心项使级数不截断，R(r) ~ e^(r/n) 在无穷远发散，不能归一化。');
    }
    if (Number.isInteger(l) && Math.abs(m) > l) reasons.push('|m| > l：P_l^m ≡ 0，角向波函数恒为零。');
    if (!Number.isInteger(m)) reasons.push('m 必须为整数：否则 e^(imφ) 不是单值函数。');
    if (Math.abs(m) > 400) reasons.push('|m| > 400：超过角向表的数值上限（渲染限制）。');

    if (!physical && reasons.length === 0) reasons.push('该组合不满足束缚态边界条件。');
    return { physical: physical, reasons: reasons, warnings: warnings };
  }

  /* ------------------------------------------------------------------ *
   * Uniform sin/cos table (no trig at sample time)
   * ------------------------------------------------------------------ */
  var UNI_N = 8192;
  var UNI_COS = new Float32Array(UNI_N);
  var UNI_SIN = new Float32Array(UNI_N);
  (function () {
    for (var i = 0; i < UNI_N; i++) {
      var a = (TAU * (i + 0.5)) / UNI_N;
      UNI_COS[i] = Math.cos(a);
      UNI_SIN[i] = Math.sin(a);
    }
  })();

  /* ------------------------------------------------------------------ *
   * Radial table
   * ------------------------------------------------------------------ */
  function computeRadial(n, l, Z, rMax, Mopt) {
    if (!isFinite(n) || n === 0) return { error: 'n 不能为 0' };
    if (!(Z > 0)) return { error: 'Z 必须大于 0' };
    if (!(l >= 0)) return { error: 'l 必须 ≥ 0' };
    if (!(rMax > 0)) return { error: 'rMax 必须大于 0' };

    var M = Mopt || clamp(Math.round(2048 + 80 * Math.abs(n)), 2048, 12000);
    var r = new Float64Array(M);
    var logR = new Float64Array(M);
    var signR = new Int8Array(M);
    var logRho = new Float64Array(M);

    var a = l + 1 - n;
    var b = 2 * l + 2;
    var k2z = (2 * Z) / n;
    var lInt = Number.isInteger(l);
    // a <= 0 integer: 1F1(-k;b;x) is a polynomial; evaluate it as a Laguerre
    // polynomial by stable forward recurrence instead of the 1F1 series.
    var useLag = a <= 0 && Number.isInteger(a);
    var lagK = -a;
    var lagAlpha = b - 1;
    var maxLog = -Infinity;
    var i;

    for (i = 0; i < M; i++) {
      var t = i / (M - 1);
      var ri = rMax * t * t;
      r[i] = ri;

      var lg, sg;
      if (ri === 0) {
        if (l > 0) { lg = -Infinity; sg = 1; }
        else {
          var k0 = useLag ? S.laguerreLog(lagK, lagAlpha, 0) : S.kummerLog(a, b, 0);
          lg = k0.logAbs; sg = k0.sign;
        }
      } else {
        var x = k2z * ri;
        var k = useLag ? S.laguerreLog(lagK, lagAlpha, x) : S.kummerLog(a, b, x);
        lg = -x / 2 + l * Math.log(Math.abs(x)) + k.logAbs;
        sg = k.sign;
        if (x < 0 && lInt && l % 2 === 1) sg = -sg; // x^l for negative x
      }
      logR[i] = lg;
      signR[i] = sg;

      var lr = -Infinity;
      if (ri > 0 && isFinite(lg)) lr = 2 * lg + 2 * Math.log(ri);
      logRho[i] = lr;
      if (lr > maxLog) maxLog = lr;
    }

    if (!isFinite(maxLog)) return { error: '波函数在该范围内恒为零' };

    var rho = new Float64Array(M);
    for (i = 0; i < M; i++) rho[i] = isFinite(logRho[i]) ? Math.exp(logRho[i] - maxLog) : 0;

    var cdf = new Float64Array(M);
    var acc = 0;
    for (i = 1; i < M; i++) {
      acc += 0.5 * (rho[i] + rho[i - 1]) * (r[i] - r[i - 1]);
      cdf[i] = acc;
    }
    if (!(acc > 0)) return { error: '概率密度积分无效' };
    for (i = 0; i < M; i++) cdf[i] /= acc;

    var NU = 8192;
    var rOfU = new Float32Array(NU);
    var signOfU = new Int8Array(NU);
    var j = 0;
    for (i = 0; i < NU; i++) {
      var u = (i + 0.5) / NU;
      while (j < M - 2 && cdf[j + 1] < u) j++;
      var c0 = cdf[j], c1 = cdf[j + 1];
      var f = c1 > c0 ? (u - c0) / (c1 - c0) : 0;
      if (f < 0) f = 0; else if (f > 1) f = 1;
      var rr = r[j] + f * (r[j + 1] - r[j]);
      rOfU[i] = rr;
      var ti = Math.sqrt(Math.max(0, rr / rMax)) * (M - 1);
      var idx = Math.round(ti);
      if (idx < 0) idx = 0; else if (idx > M - 1) idx = M - 1;
      signOfU[i] = signR[idx];
    }

    var nodes = 0, prev = 0;
    for (i = 0; i < M; i++) {
      if (!isFinite(logR[i])) continue;
      var s = signR[i];
      if (prev !== 0 && s !== 0 && s !== prev) nodes++;
      prev = s;
    }

    return {
      rMax: rMax, M: M, r: r, logR: logR, signR: signR, logRho: logRho, rho: rho,
      maxLog: maxLog, cdf: cdf, rOfU: rOfU, signOfU: signOfU, nodes: nodes, a: a, b: b
    };
  }

  /*
   * Display window. Physical states are followed out to where the density has
   * fallen 12 decades below its peak. Non-physical states get a window of a
   * few e-folds around the classical scale, so the divergence is visible
   * without the outermost shell eating the entire picture.
   */
  function chooseRange(n, l, Z, physical) {
    var nAbs = Math.abs(n);
    var zCap = 700;
    var probe = physical ? (14 * n * n + 10) : (6 * nAbs + 2 * l * (l + 1) + 10);
    probe = Math.max(probe, 8 / Z);
    // The x = 2r/n cap protects the 1F1 series for non-polynomial states; the
    // polynomial branch uses the stable Laguerre recurrence and needs the full
    // physical range, otherwise the outer lobe is cut for n >~ 87.
    if (!physical) probe = Math.min(probe, (zCap * nAbs) / (2 * Z));
    probe = Math.min(probe, 1e6);

    if (!physical) {
      var w = (4.2 * nAbs + 1.4 * l * (l + 1) + 8) / Z;
      return Math.max(4 / Z, Math.min(probe, w));
    }

    var t = computeRadial(n, l, Z, probe, 1200);
    if (t.error) return 20 / Z;
    var thr = t.maxLog - 9;
    var last = 0;
    for (var i = t.M - 1; i >= 0; i--) {
      if (t.logRho[i] > thr) { last = i; break; }
    }
    return Math.min(Math.max(t.r[last] * 1.04, 8 / Z), probe);
  }

  /* ------------------------------------------------------------------ *
   * Angular table: density over cosθ ∝ |P_l^m(cosθ)|²
   * ------------------------------------------------------------------ */
  function computeAngular(l, m) {
    var absM = Math.abs(m);
    var lInt = Number.isInteger(l) && l >= 0;
    var K = lInt ? clamp(Math.round(512 + 16 * l), 1024, 4096) : 320;

    var ct = new Float64Array(K);
    var logP = new Float64Array(K);
    var signP = new Int8Array(K);
    var maxLog = -Infinity;
    var i;

    for (i = 0; i < K; i++) {
      var x = -1 + (2 * i) / (K - 1);
      ct[i] = x;
      var p = lInt ? S.assocLegendreInt(l, absM, x) : S.assocLegendreReal(l, absM, x);
      if (p === 0 || !isFinite(p)) {
        logP[i] = -Infinity;
        signP[i] = 0;
      } else {
        logP[i] = Math.log(Math.abs(p));
        signP[i] = p < 0 ? -1 : 1;
        if (logP[i] > maxLog) maxLog = logP[i];
      }
    }

    if (!isFinite(maxLog)) {
      return { zero: true, l: l, m: m, K: K, ct: ct, logP: logP, signP: signP };
    }

    var p2 = new Float64Array(K);
    for (i = 0; i < K; i++) p2[i] = isFinite(logP[i]) ? Math.exp(2 * (logP[i] - maxLog)) : 0;

    var dct = 2 / (K - 1);
    var cdf = new Float64Array(K);
    var acc = 0;
    for (i = 1; i < K; i++) {
      acc += 0.5 * (p2[i] + p2[i - 1]) * dct;
      cdf[i] = acc;
    }
    if (!(acc > 0)) return { zero: true, l: l, m: m, K: K, ct: ct, logP: logP, signP: signP };
    for (i = 0; i < K; i++) cdf[i] /= acc;

    var NV = 4096;
    var ctOfV = new Float32Array(NV);
    var stOfV = new Float32Array(NV);
    var signOfV = new Int8Array(NV);
    var j = 0;
    for (i = 0; i < NV; i++) {
      var u = (i + 0.5) / NV;
      while (j < K - 2 && cdf[j + 1] < u) j++;
      var c0 = cdf[j], c1 = cdf[j + 1];
      var f = c1 > c0 ? (u - c0) / (c1 - c0) : 0;
      if (f < 0) f = 0; else if (f > 1) f = 1;
      var cc = ct[j] + f * (ct[j + 1] - ct[j]);
      ctOfV[i] = cc;
      stOfV[i] = Math.sqrt(Math.max(0, 1 - cc * cc));
      var idx = Math.round(((cc + 1) / 2) * (K - 1));
      if (idx < 0) idx = 0; else if (idx > K - 1) idx = K - 1;
      signOfV[i] = signP[idx];
    }

    return {
      zero: false, l: l, m: m, K: K, ct: ct, logP: logP, p2: p2, signP: signP,
      maxLog: maxLog, cdf: cdf, ctOfV: ctOfV, stOfV: stOfV, signOfV: signOfV
    };
  }

  /* ------------------------------------------------------------------ *
   * φ table for real orbitals: density ∝ cos²(mφ) or sin²(|m|φ).
   * Also stores the cos/sin of every table entry, so sampling never calls
   * a trig function.
   * ------------------------------------------------------------------ */
  function computePhi(m) {
    if (m === 0) return null;
    var absM = Math.abs(m);
    var K = clamp(Math.round(512 + 32 * absM), 512, 4096);
    var phi = new Float64Array(K);
    var p = new Float64Array(K);
    var sg = new Int8Array(K);
    var i;

    for (i = 0; i < K; i++) {
      var ph = (TAU * i) / (K - 1);
      phi[i] = ph;
      var c = m > 0 ? Math.cos(absM * ph) : Math.sin(absM * ph);
      p[i] = c * c;
      sg[i] = c < 0 ? -1 : 1;
    }

    var dph = TAU / (K - 1);
    var cdf = new Float64Array(K);
    var acc = 0;
    for (i = 1; i < K; i++) {
      acc += 0.5 * (p[i] + p[i - 1]) * dph;
      cdf[i] = acc;
    }
    if (!(acc > 0)) return null;
    for (i = 0; i < K; i++) cdf[i] /= acc;

    var NU = 4096;
    var phiOfU = new Float32Array(NU);
    var cosOfU = new Float32Array(NU);
    var sinOfU = new Float32Array(NU);
    var signOfU = new Int8Array(NU);
    var j = 0;
    for (i = 0; i < NU; i++) {
      var u = (i + 0.5) / NU;
      while (j < K - 2 && cdf[j + 1] < u) j++;
      var c0 = cdf[j], c1 = cdf[j + 1];
      var f = c1 > c0 ? (u - c0) / (c1 - c0) : 0;
      var pp = phi[j] + f * (phi[j + 1] - phi[j]);
      phiOfU[i] = pp;
      cosOfU[i] = Math.cos(pp);
      sinOfU[i] = Math.sin(pp);
      var idx = Math.round((pp / TAU) * (K - 1));
      if (idx < 0) idx = 0; else if (idx > K - 1) idx = K - 1;
      signOfU[i] = sg[idx];
    }

    return {
      phiOfU: phiOfU, cosOfU: cosOfU, sinOfU: sinOfU, signOfU: signOfU, N: NU
    };
  }

  /* ------------------------------------------------------------------ *
   * Sampler: a resumable generator of point records [x, y, z, w].
   *   w = sign (±1) for real orbitals, phase ∈ [0,1) for complex ones.
   * Points are normalised to the unit sphere (radius r/rMax).
   * ------------------------------------------------------------------ */
  function createSampler(radial, ang, phiTable, complexMode, seed) {
    var rOfU = radial.rOfU;
    var rSign = radial.signOfU;
    var NU = rOfU.length;
    var ctOfV = ang.ctOfV;
    var stOfV = ang.stOfV;
    var aSign = ang.signOfV;
    var NV = ctOfV.length;
    var phiOfU = phiTable ? phiTable.phiOfU : null;
    var pCos = phiTable ? phiTable.cosOfU : null;
    var pSin = phiTable ? phiTable.sinOfU : null;
    var pSign = phiTable ? phiTable.signOfU : null;
    var NP = phiTable ? phiTable.N : 0;
    var invR = 1 / radial.rMax;
    var m = ang.m;
    var state = (seed >>> 0) || 0x9e3779b9;

    function rnd() {
      state ^= state << 13; state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5; state >>>= 0;
      return state / 4294967296;
    }

    return function fill(out, offset, count) {
      var o = offset * 4;
      var end = o + count * 4;
      var w, ri, r, sR, ai, ct, sT, st, sc, pi, ph, sP, cs, sn, phase;

      if (complexMode) {
        for (; o < end; o += 4) {
          w = rnd();
          ri = (w * NU) | 0;
          if (ri >= NU) ri = NU - 1;
          r = rOfU[ri];
          w = rnd();
          ai = (w * NV) | 0;
          if (ai >= NV) ai = NV - 1;
          ct = ctOfV[ai];
          st = stOfV[ai];
          pi = (rnd() * UNI_N) | 0;
          if (pi >= UNI_N) pi = UNI_N - 1;
          sc = r * invR * st;
          out[o] = sc * UNI_COS[pi];
          out[o + 1] = sc * UNI_SIN[pi];
          out[o + 2] = r * invR * ct;
          phase = m * ((pi + 0.5) / UNI_N);
          phase -= Math.floor(phase);
          out[o + 3] = phase;
        }
      } else if (phiOfU) {
        for (; o < end; o += 4) {
          w = rnd();
          ri = (w * NU) | 0;
          if (ri >= NU) ri = NU - 1;
          r = rOfU[ri];
          sR = rSign[ri];
          w = rnd();
          ai = (w * NV) | 0;
          if (ai >= NV) ai = NV - 1;
          ct = ctOfV[ai];
          st = stOfV[ai];
          sT = aSign[ai];
          w = rnd();
          pi = (w * NP) | 0;
          if (pi >= NP) pi = NP - 1;
          ph = phiOfU[pi];
          sc = r * invR * st;
          out[o] = sc * pCos[pi];
          out[o + 1] = sc * pSin[pi];
          out[o + 2] = r * invR * ct;
          out[o + 3] = sR * sT * pSign[pi];
        }
      } else {
        for (; o < end; o += 4) {
          w = rnd();
          ri = (w * NU) | 0;
          if (ri >= NU) ri = NU - 1;
          r = rOfU[ri];
          sR = rSign[ri];
          w = rnd();
          ai = (w * NV) | 0;
          if (ai >= NV) ai = NV - 1;
          ct = ctOfV[ai];
          st = stOfV[ai];
          sT = aSign[ai];
          pi = (rnd() * UNI_N) | 0;
          if (pi >= UNI_N) pi = UNI_N - 1;
          sc = r * invR * st;
          out[o] = sc * UNI_COS[pi];
          out[o + 1] = sc * UNI_SIN[pi];
          out[o + 2] = r * invR * ct;
          out[o + 3] = sR * sT;
        }
      }
    };
  }

  /* ------------------------------------------------------------------ *
   * Interpolation helpers (used to build the slice LUTs)
   * ------------------------------------------------------------------ */
  function interpLogRho(radial, rr) {
    var M = radial.M;
    var rMax = radial.rMax;
    var t = Math.sqrt(Math.max(0, Math.min(1, rr / rMax))) * (M - 1);
    var i0 = Math.floor(t);
    if (i0 < 0) i0 = 0;
    if (i0 > M - 2) i0 = M - 2;
    var f = t - i0;
    var a = radial.logRho[i0], b = radial.logRho[i0 + 1];
    if (!isFinite(a)) return b;
    if (!isFinite(b)) return a;
    return a + (b - a) * f;
  }

  function interpLogP(ang, ct) {
    var K = ang.K;
    var t = ((ct + 1) * 0.5) * (K - 1);
    var i0 = Math.floor(t);
    if (i0 < 0) i0 = 0;
    if (i0 > K - 2) i0 = K - 2;
    var f = t - i0;
    var a = ang.logP[i0], b = ang.logP[i0 + 1];
    if (!isFinite(a)) return b;
    if (!isFinite(b)) return a;
    return a + (b - a) * f;
  }

  function interpSignR(radial, rr) {
    var M = radial.M;
    var t = Math.sqrt(Math.max(0, Math.min(1, rr / radial.rMax))) * (M - 1);
    var i0 = Math.round(t);
    if (i0 < 0) i0 = 0;
    if (i0 > M - 1) i0 = M - 1;
    return radial.signR[i0];
  }

  function interpSignP(ang, ct) {
    var K = ang.K;
    var i0 = Math.round(((ct + 1) * 0.5) * (K - 1));
    if (i0 < 0) i0 = 0;
    if (i0 > K - 1) i0 = K - 1;
    return ang.signP[i0];
  }

  /*
   * Phase palette for complex orbitals: vermilion → ochre → olive → deep
   * green, interpolated cyclically. No blue or violet anywhere.
   */
  var PHASE_STOPS = [
    [195, 64, 42],
    [176, 122, 30],
    [95, 110, 50],
    [61, 107, 79],
    [195, 64, 42]
  ];

  function phaseRGB(t) {
    t -= Math.floor(t);
    var x = t * 4;
    var i = x | 0;
    if (i > 3) i = 3;
    var f = x - i;
    var a = PHASE_STOPS[i];
    var b = PHASE_STOPS[i + 1];
    return [
      a[0] + (b[0] - a[0]) * f,
      a[1] + (b[1] - a[1]) * f,
      a[2] + (b[2] - a[2]) * f
    ];
  }

  /* ------------------------------------------------------------------ *
   * 2D slice: plane y = sliceY, x,z ∈ [−rMax, rMax], size² RGBA pixels.
   * Built from 1D LUTs; no per-pixel transcendentals.
   * ------------------------------------------------------------------ */
  function buildSlice(radial, ang, m, sliceY, size, complexMode, decades) {
    decades = decades || 9;
    var data = new Uint8Array(size * size * 4);
    if (!radial || radial.error || !ang || ang.zero) return { data: data, size: size };

    var ext = radial.rMax;
    var maxLog = radial.maxLog + 2 * ang.maxLog;
    var lo = maxLog - decades;
    var invDec = 1 / decades;
    var inv = 1 / ext;

    // radial log-density LUT over r ∈ [0, rMax]
    var NL = 2048;
    var radLut = new Float64Array(NL);
    var radSignLut = new Int8Array(NL);
    for (var k = 0; k < NL; k++) {
      var rk = (k / (NL - 1)) * ext;
      radLut[k] = interpLogRho(radial, rk);
      radSignLut[k] = interpSignR(radial, rk);
    }

    var K = ang.K;
    var logP = ang.logP;
    var signP = ang.signP;

    // per-column φ factor (depends only on x for a fixed y)
    var phiLog = new Float64Array(size);
    var phiSign = new Int8Array(size);
    var phiR = new Uint8Array(size);
    var phiG = new Uint8Array(size);
    var phiB = new Uint8Array(size);
    for (var i = 0; i < size; i++) {
      var x = ((2 * (i + 0.5)) / size - 1) * ext;
      phiSign[i] = 1;
      phiLog[i] = 0;
      if (complexMode) {
        var phc = Math.atan2(sliceY, x);
        var pc = m * phc * INV_TAU;
        pc -= Math.floor(pc);
        var rgbc = phaseRGB(pc);
        phiR[i] = Math.round(rgbc[0]);
        phiG[i] = Math.round(rgbc[1]);
        phiB[i] = Math.round(rgbc[2]);
      } else if (m !== 0) {
        var ph = Math.atan2(sliceY, x);
        var c = m > 0 ? Math.cos(Math.abs(m) * ph) : Math.sin(Math.abs(m) * ph);
        if (c === 0) {
          phiLog[i] = -Infinity;
        } else {
          phiLog[i] = 2 * Math.log(Math.abs(c));
          phiSign[i] = c < 0 ? -1 : 1;
        }
      }
    }

    // alpha ramp: 255 · t^0.8
    var ALUT = new Uint8Array(256);
    for (var a = 0; a < 256; a++) ALUT[a] = Math.round(255 * Math.pow(a / 255, 0.8));

    var POS = [20, 20, 20];
    var NEG = [195, 64, 42];
    var j, o;

    for (j = 0; j < size; j++) {
      var z = ((2 * (j + 0.5)) / size - 1) * ext;
      var zz = z * z + sliceY * sliceY;
      for (i = 0; i < size; i++) {
        o = (j * size + i) * 4;
        x = ((2 * (i + 0.5)) / size - 1) * ext;
        var r = Math.sqrt(x * x + zz);
        var rr = r * inv;
        if (rr > 1) { data[o + 3] = 0; continue; }

        var kk = rr * (NL - 1);
        var k0 = kk | 0;
        if (k0 > NL - 2) k0 = NL - 2;
        var fk = kk - k0;
        var lr = radLut[k0] + (radLut[k0 + 1] - radLut[k0]) * fk;
        if (!isFinite(lr)) { data[o + 3] = 0; continue; }

        var ct = z / r;
        if (ct > 1) ct = 1; else if (ct < -1) ct = -1;
        var tt = ((ct + 1) * 0.5) * (K - 1);
        var i0 = tt | 0;
        if (i0 > K - 2) i0 = K - 2;
        var ft = tt - i0;
        var lp = logP[i0] + (logP[i0 + 1] - logP[i0]) * ft;
        if (!isFinite(lp)) { data[o + 3] = 0; continue; }

        var logD = lr + 2 * lp + phiLog[i];
        var t = (logD - lo) * invDec;
        if (!(t > 0)) { data[o + 3] = 0; continue; }
        if (t > 1) t = 1;
        var ai = (t * 255) | 0;
        var alpha = ALUT[ai];

        if (complexMode) {
          data[o] = phiR[i];
          data[o + 1] = phiG[i];
          data[o + 2] = phiB[i];
        } else {
          var s = phiSign[i] * radSignLut[k0 > 0 ? k0 : 0] * signP[i0];
          var col = s >= 0 ? POS : NEG;
          data[o] = col[0];
          data[o + 1] = col[1];
          data[o + 2] = col[2];
        }
        data[o + 3] = alpha;
      }
    }

    return { data: data, size: size, maxLog: maxLog };
  }

  return {
    classify: classify,
    chooseRange: chooseRange,
    computeRadial: computeRadial,
    computeAngular: computeAngular,
    computePhi: computePhi,
    createSampler: createSampler,
    buildSlice: buildSlice,
    mulberry32: function (seed) {
      var a = seed >>> 0;
      return function () {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        var t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    },
    interpLogRho: interpLogRho,
    interpLogP: interpLogP
  };
});
