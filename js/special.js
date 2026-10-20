/*
 * special.js — special functions used by the hydrogenic solver.
 *
 * Everything here is deliberately dependency-free ES5-ish JavaScript so the
 * page can run from a file:// URL with a plain <script> tag.
 *
 * Exposed as QSpecial (browser) or module.exports (node, for tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QSpecial = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LN_PI = Math.log(Math.PI);

  /* ------------------------------------------------------------------ *
   * ln Γ(x) — Lanczos, g = 7, n = 9. Accurate to ~1e-13 for x > 0.
   * ------------------------------------------------------------------ */
  var LANCZOS = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7
  ];

  function lgamma(x) {
    if (!isFinite(x)) return Infinity;
    if (x < 0.5) {
      // reflection: Γ(x)Γ(1−x) = π / sin(πx)
      var s = Math.sin(Math.PI * x);
      if (s === 0) return Infinity; // pole at non-positive integers
      return LN_PI - Math.log(Math.abs(s)) - lgamma(1 - x);
    }
    x -= 1;
    var a = LANCZOS[0];
    var t = x + 7.5;
    for (var i = 1; i < 9; i++) a += LANCZOS[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  }

  /*
   * {logAbs, sign} for Γ(x), real x.
   * Poles (x = 0, −1, −2, …) come back as {logAbs: Infinity, sign: 0}.
   */
  function gammaLogSign(x) {
    if (!isFinite(x)) return { logAbs: Infinity, sign: 0 };
    if (x <= 0 && Number.isInteger(x)) return { logAbs: Infinity, sign: 0 };
    if (x < 0.5) {
      var s = Math.sin(Math.PI * x);
      if (s === 0) return { logAbs: Infinity, sign: 0 };
      var r = gammaLogSign(1 - x);
      return {
        logAbs: LN_PI - Math.log(Math.abs(s)) - r.logAbs,
        sign: (s < 0 ? -1 : 1) * r.sign
      };
    }
    return { logAbs: lgamma(x), sign: 1 };
  }

  /* ------------------------------------------------------------------ *
   * Kummer's confluent hypergeometric  M(a, b, x),  real arguments.
   *
   * Returns {logAbs, sign} rather than the value itself: for non-physical
   * quantum numbers the function grows like e^x and overflows a double long
   * before the interesting range. The series is rescaled by 1e100 whenever a
   * partial sum gets too big, and the accumulated log is added back at the
   * end. This also keeps the sign information intact.
   *
   * a ≤ 0 integer  → the series terminates (polynomial, the physical case).
   * ------------------------------------------------------------------ */
  var K_SCALE = 1e100;
  var K_LOG_SCALE = Math.log(K_SCALE);

  function kummerLog(a, b, x) {
    if (x === 0) return { logAbs: 0, sign: 1 };

    var isPoly = a <= 0 && Number.isInteger(a);
    var kMax;
    if (isPoly) {
      kMax = Math.min(20000, -a);
    } else {
      kMax = Math.min(
        20000,
        Math.ceil(2 * Math.abs(x) + 12 * Math.sqrt(Math.abs(x)) + Math.abs(a) + 120)
      );
    }

    var term = 1.0;
    var sum = 1.0;
    var logScale = 0.0;
    var k;

    for (k = 0; k < kMax; k++) {
      term *= ((a + k) / (b + k)) * (x / (k + 1));
      if (!isFinite(term)) return { logAbs: Infinity, sign: 0 };
      sum += term;

      if (Math.abs(term) > K_SCALE || Math.abs(sum) > K_SCALE) {
        term /= K_SCALE;
        sum /= K_SCALE;
        logScale += K_LOG_SCALE;
      }

      if (isPoly) {
        if (k + 1 >= -a) break;
      } else if (
        k > Math.abs(x) + Math.abs(a) &&
        Math.abs(term) < 1e-15 * Math.abs(sum)
      ) {
        break;
      }
    }

    if (sum === 0) return { logAbs: -Infinity, sign: 0 };
    return {
      logAbs: Math.log(Math.abs(sum)) + logScale,
      sign: sum < 0 ? -1 : 1
    };
  }

  /* ------------------------------------------------------------------ *
   * Gauss hypergeometric ₂F₁(a, b; c; z), real, |z| ≤ 1.
   * Terminates when a or b is a non-positive integer.
   * ------------------------------------------------------------------ */
  function hyp2f1(a, b, c, z) {
    if (z === 0) return 1;
    var terminating = (a <= 0 && Number.isInteger(a)) || (b <= 0 && Number.isInteger(b));
    var kMax = terminating
      ? (a <= 0 && Number.isInteger(a) ? -a : -b)
      : 4000;

    var term = 1;
    var sum = 1;
    for (var k = 1; k <= kMax; k++) {
      term *= ((a + k - 1) * (b + k - 1)) / ((c + k - 1) * k) * z;
      sum += term;
      if (!terminating && k > 8 && Math.abs(term) < 1e-15 * Math.abs(sum)) break;
      if (!isFinite(sum)) break;
    }
    return sum;
  }

  /*
   * Laguerre L_k^alpha(x) via the three-term recurrence:
   *   L_0 = 1, L_1 = 1 + alpha - x,
   *   (j+1) L_{j+1} = (2j+1+alpha-x) L_j - (j+alpha) L_{j-1}.
   * Forward recurrence is stable for x >= 0 and avoids the catastrophic
   * cancellation of the 1F1 series when x ~ k^2. Values are rescaled when
   * they exceed 1e100 so high-n states do not overflow.
   */
  function laguerreLog(k, alpha, x) {
    if (k < 0) return { logAbs: 0, sign: 1 };
    if (k === 0) return { logAbs: 0, sign: 1 };
    var scale = 0;
    var L0 = 1;
    var L1 = 1 + alpha - x;
    var j, c;
    for (j = 1; j < k; j++) {
      c = ((2 * j + 1 + alpha - x) * L1 - (j + alpha) * L0) / (j + 1);
      L0 = L1;
      L1 = c;
      if (Math.abs(L1) > 1e100) {
        L0 /= 1e100;
        L1 /= 1e100;
        scale += 230.25850929940458; // ln(1e100)
      }
    }
    if (L1 === 0) return { logAbs: -Infinity, sign: 0 };
    return { logAbs: Math.log(Math.abs(L1)) + scale, sign: L1 < 0 ? -1 : 1 };
  }

  /* ------------------------------------------------------------------ *
   * Associated Legendre P_l^m(x), l and m non-negative integers.
   * Standard upward recurrence (same scheme as numpy), stable for the
   * degrees this tool cares about.
   * ------------------------------------------------------------------ */
  function assocLegendreInt(l, m, x) {
    if (m > l) return 0;
    if (m < 0) return 0;
    var pmm = 1;
    if (m > 0) {
      var somx2 = Math.sqrt(Math.max(0, 1 - x * x));
      var fact = 1;
      for (var i = 1; i <= m; i++) {
        pmm *= -fact * somx2;
        fact += 2;
      }
    }
    if (l === m) return pmm;
    var pmmp1 = x * (2 * m + 1) * pmm;
    if (l === m + 1) return pmmp1;
    var pll = 0;
    for (var ll = m + 2; ll <= l; ll++) {
      pll = ((2 * ll - 1) * x * pmmp1 - (ll + m - 1) * pmm) / (ll - m);
      pmm = pmmp1;
      pmmp1 = pll;
    }
    return pll;
  }

  /* ------------------------------------------------------------------ *
   * Associated Legendre with real degree ν (formal continuation).
   *
   *   P_ν^m(x) = (−1)^m Γ(ν+m+1)/Γ(ν−m+1) · (1−x²)^{m/2}/(2^m m!)
   *              · ₂F₁(m−ν, m+ν+1; m+1; (1−x)/2)
   *
   * m is still an integer (a non-integer m makes e^{imφ} multi-valued and the
   * formula needs a different regularisation).
   *
   * The ₂F₁ series converges slowly as x → −1, so x is clamped just short of
   * the south pole; the affected cap is a fraction of a degree wide.
   * ------------------------------------------------------------------ */
  var X_CLAMP = 0.995;

  function assocLegendreReal(nu, m, x) {
    if (x < -X_CLAMP) x = -X_CLAMP;
    if (x > 1) x = 1;
    if (m === 0) {
      return hyp2f1(-nu, nu + 1, 1, (1 - x) / 2);
    }
    if (x === 1) return 0;
    if (x === -1) return 0;

    var z = (1 - x) / 2;
    var F = hyp2f1(m - nu, m + nu + 1, m + 1, z);

    var g1 = gammaLogSign(nu + m + 1);
    var g2 = gammaLogSign(nu - m + 1);
    if (!isFinite(g1.logAbs) || !isFinite(g2.logAbs)) return 0;

    var logPref = g1.logAbs - g2.logAbs - m * Math.LN2 - lgamma(m + 1);
    if (logPref > 690) return Infinity;
    if (logPref < -690) return 0;

    var sgn = (m % 2 === 0 ? 1 : -1) * g1.sign * g2.sign;
    var val = sgn * Math.exp(logPref) * Math.pow(Math.max(0, 1 - x * x), m / 2) * F;
    return val;
  }

  /*
   * Unified accessor: integer degree uses the recurrence, everything else the
   * hypergeometric continuation. ν here is l (already normalised to ≥ 0).
   */
  function assocLegendre(l, m, x) {
    if (Number.isInteger(l) && l >= 0 && Number.isInteger(m)) {
      return assocLegendreInt(l, m, x);
    }
    return assocLegendreReal(l, Math.abs(m), x);
  }

  return {
    lgamma: lgamma,
    gammaLogSign: gammaLogSign,
    kummerLog: kummerLog,
    hyp2f1: hyp2f1,
    assocLegendreInt: assocLegendreInt,
    assocLegendreReal: assocLegendreReal,
    assocLegendre: assocLegendre,
    laguerreLog: laguerreLog
  };
});
