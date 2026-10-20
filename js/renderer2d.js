/*
 * renderer2d.js — Canvas2D fallback renderer.
 *
 * Same public surface as renderer.js, used when WebGL2 is unavailable or the
 * GL context is lost. The point cloud is splatted into a Float32 accumulator
 * (colour + coverage), then composited onto paper in an ImageData. Slower than
 * the GPU path, but it works on machines with broken drivers and needs no GL.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QRenderer2D = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FOV = (42 * Math.PI) / 180;

  var PHASE_STOPS = [
    [0.7647, 0.2510, 0.1647],
    [0.6902, 0.4784, 0.1176],
    [0.3725, 0.4314, 0.1961],
    [0.2392, 0.4196, 0.3098],
    [0.7647, 0.2510, 0.1647]
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

  // Precomputed separable splat kernels, indexed by pixel radius 0..3.
  var KERNELS = (function () {
    var out = [];
    for (var r = 0; r <= 3; r++) {
      var n = 2 * r + 1;
      var w = new Float32Array(n * n);
      var sig = Math.max(0.55, r * 0.62);
      var sum = 0;
      for (var y = -r; y <= r; y++) {
        for (var x = -r; x <= r; x++) {
          var v = Math.exp(-(x * x + y * y) / (2 * sig * sig));
          w[(y + r) * n + (x + r)] = v;
          sum += v;
        }
      }
      for (var k = 0; k < w.length; k++) w[k] /= sum;
      out.push({ r: r, n: n, w: w });
    }
    return out;
  })();

  function lookAt(out, eye, center, up) {
    var zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
    var zl = Math.hypot(zx, zy, zz) || 1;
    zx /= zl; zy /= zl; zz /= zl;
    var xx = up[1] * zz - up[2] * zy;
    var xy = up[2] * zx - up[0] * zz;
    var xz = up[0] * zy - up[1] * zx;
    var xl = Math.hypot(xx, xy, xz) || 1;
    xx /= xl; xy /= xl; xz /= xl;
    var yx = zy * xz - zz * xy;
    var yy = zz * xx - zx * xz;
    var yz = zx * xy - zy * xx;
    out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
    out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
    out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
    out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
    out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
    out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
    out[15] = 1;
    return out;
  }

  function Renderer2D(canvas) {
    var ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas2D 不可用');
    this.canvas = canvas;
    this.ctx = ctx;
    this.dpr = 1;
    this.aspect = 1;
    this.view = new Float32Array(16);

    this.cloudData = new Float32Array(0);
    this.cloudCount = 0;
    this.capacity = 0;

    this.mode = 'cloud';
    this.pointSize = 3.5;
    this.alpha = 0.3;
    this.colorMode = 0;
    this.showAxes = false;

    this.acc = null;
    this.img = null;
    this.accW = 0;
    this.accH = 0;

    this.sliceCanvas = null;
    this.sliceCtx = null;
    this.sliceSize = 0;
    this.sliceY = 0;
    this.sliceReady = false;

    // coverage curve: 1 − exp(−x · k), index = coverage · 400
    this.covLut = new Float32Array(1024);
    for (var i = 0; i < 1024; i++) {
      this.covLut[i] = 1 - Math.exp(-(i / 400) * 7.0);
    }
  }

  Renderer2D.prototype.resize = function () {
    var c = this.canvas;
    var dpr = 1; // CPU path: never supersample
    var w = Math.max(1, Math.round(c.clientWidth || 1));
    var h = Math.max(1, Math.round(c.clientHeight || 1));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    this.dpr = dpr;
    this.aspect = w / h;
  };

  Renderer2D.prototype.setCloudCapacity = function (n) {
    if (n === this.capacity) { this.cloudCount = 0; return; }
    this.cloudData = new Float32Array(n * 4);
    this.capacity = n;
    this.cloudCount = 0;
  };

  Renderer2D.prototype.uploadCloud = function (data, start, count) {
    if (count <= 0) return;
    this.cloudData.set(data.subarray(start * 4, (start + count) * 4), start * 4);
    this.cloudCount = Math.max(this.cloudCount, start + count);
  };

  Renderer2D.prototype.setCloudCount = function (n) { this.cloudCount = n; };

  Renderer2D.prototype.setSlice = function (data, size, yOffset) {
    if (!this.sliceCanvas || this.sliceSize !== size) {
      this.sliceCanvas = document.createElement('canvas');
      this.sliceCanvas.width = size;
      this.sliceCanvas.height = size;
      this.sliceCtx = this.sliceCanvas.getContext('2d');
      this.sliceSize = size;
    }
    var img = this.sliceCtx.createImageData(size, size);
    img.data.set(data);
    this.sliceCtx.putImageData(img, 0, 0);
    this.sliceY = yOffset;
    this.sliceReady = true;
  };

  Renderer2D.prototype.draw = function (yaw, pitch, dist, pointSize, alpha, colorMode) {
    var c = this.canvas;
    var ctx = this.ctx;
    var w = c.width, h = c.height;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#f6f4ee';
    ctx.fillRect(0, 0, w, h);

    var cp = Math.cos(pitch), sp = Math.sin(pitch);
    var eye = [dist * cp * Math.cos(yaw), dist * cp * Math.sin(yaw), dist * sp];
    lookAt(this.view, eye, [0, 0, 0], [0, 0, 1]);
    var m = this.view;

    if (this.mode === 'slice' && this.sliceReady) {
      var half = (h / 2) / (dist * Math.tan(FOV / 2));
      ctx.imageSmoothingEnabled = true;
      // texture row 0 is z = -rMax (bottom); flip so +z points up on screen
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.scale(1, -1);
      ctx.drawImage(this.sliceCanvas, -half, -half, half * 2, half * 2);
      ctx.restore();
      if (this.showAxes) this.drawAxes(ctx, m, w, h, dist);
      return;
    }
    if (!this.cloudCount) return;

    if (!this.acc || this.accW !== w || this.accH !== h) {
      this.acc = new Float32Array(w * h * 4);
      this.img = ctx.createImageData(w, h);
      var d = this.img.data;
      for (var q = 0; q < d.length; q += 4) d[q + 3] = 255;
      this.accW = w;
      this.accH = h;
    }
    var acc = this.acc;
    acc.fill(0);

    var focal = (h / 2) / Math.tan(FOV / 2);
    var cx = w / 2, cy = h / 2;
    var data = this.cloudData;
    var n = this.cloudCount;
    var pos = [0.0784, 0.0784, 0.0784];
    var neg = [0.7647, 0.2510, 0.1647];
    var m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3];
    var m4 = m[4], m5 = m[5], m6 = m[6], m7 = m[7];
    var m8 = m[8], m9 = m[9], m10 = m[10], m11 = m[11];
    var m12 = m[12], m13 = m[13], m14 = m[14], m15 = m[15];
    var i, o, x, y, z, vx, vy, vz, d, sx, sy, col, cr, cg, cb;
    var wgt = alpha * 2.4;
    var rad = Math.max(0, Math.min(3, Math.round(pointSize * 0.4)));
    var kern = (KERNELS[rad] || KERNELS[3]).w;
    var kn = (KERNELS[rad] || KERNELS[3]).n;

    for (i = 0; i < n; i++) {
      o = i * 4;
      x = data[o]; y = data[o + 1]; z = data[o + 2];
      vx = m0 * x + m4 * y + m8 * z + m12;
      vy = m1 * x + m5 * y + m9 * z + m13;
      vz = m2 * x + m6 * y + m10 * z + m14;
      d = -vz;
      if (d < 0.05) continue;
      sx = (vx / d) * focal + cx;
      sy = cy - (vy / d) * focal;
      if (sx < -2 || sy < -2 || sx > w + 2 || sy > h + 2) continue;

      if (colorMode === 0) {
        col = data[o + 3] >= 0 ? pos : neg;
        cr = col[0]; cg = col[1]; cb = col[2];
      } else {
        var ph = data[o + 3];
        ph -= Math.floor(ph);
        col = phaseRGB(ph);
        cr = col[0]; cg = col[1]; cb = col[2];
      }

      var x0 = Math.round(sx), y0 = Math.round(sy);
      var dt = (d - dist * 0.55) / (dist * 0.9);
      if (dt < 0) dt = 0; else if (dt > 1) dt = 1;
      var wt = wgt * (1 - 0.62 * dt);
      var py, px, pp, wy, wx, ww;
      for (var ky = -rad; ky <= rad; ky++) {
        py = y0 + ky;
        if (py < 0 || py >= h) continue;
        wy = (ky + rad) * kn;
        for (var kx = -rad; kx <= rad; kx++) {
          px = x0 + kx;
          if (px < 0 || px >= w) continue;
          ww = wt * kern[wy + kx + rad];
          pp = (py * w + px) * 4;
          acc[pp] += cr * ww;
          acc[pp + 1] += cg * ww;
          acc[pp + 2] += cb * ww;
          acc[pp + 3] += ww;
        }
      }
    }

    var img = this.img, out = img.data, covLut = this.covLut;
    var np = w * h;
    var PR = 246, PG = 244, PB = 238;
    for (i = 0, o = 0; i < np; i++, o += 4) {
      var p4 = i * 4;
      var cov = acc[p4 + 3];
      if (cov <= 0) {
        out[o] = PR; out[o + 1] = PG; out[o + 2] = PB;
        continue;
      }
      var a = cov >= 2.55 ? 1 : covLut[(cov * 400) | 0];
      var inv = 1 / cov;
      var rr = acc[p4] * inv * 255;
      var gg = acc[p4 + 1] * inv * 255;
      var bb = acc[p4 + 2] * inv * 255;
      out[o] = PR + (rr - PR) * a;
      out[o + 1] = PG + (gg - PG) * a;
      out[o + 2] = PB + (bb - PB) * a;
    }
    ctx.putImageData(img, 0, 0);

    if (this.showAxes) this.drawAxes(ctx, m, w, h, dist);
  };

  Renderer2D.prototype.drawAxes = function (ctx, m, w, h, dist) {
    var focal = (h / 2) / Math.tan(FOV / 2);
    var pts = [
      [-1.25, 0, 0, 1.25, 0, 0, 'rgba(120,114,104,0.55)'],
      [0, -1.25, 0, 0, 1.25, 0, 'rgba(96,91,83,0.5)'],
      [0, 0, -1.25, 0, 0, 1.25, 'rgba(64,61,55,0.45)']
    ];
    ctx.lineWidth = 1;
    for (var k = 0; k < pts.length; k++) {
      var p = pts[k];
      var ax = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
      var ay = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
      var az = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
      var bx = m[0] * p[3] + m[4] * p[4] + m[8] * p[5] + m[12];
      var by = m[1] * p[3] + m[5] * p[4] + m[9] * p[5] + m[13];
      var bz = m[2] * p[3] + m[6] * p[4] + m[10] * p[5] + m[14];
      if (-az < 0.05 || -bz < 0.05) continue;
      ctx.strokeStyle = p[6];
      ctx.beginPath();
      ctx.moveTo((ax / -az) * focal + w / 2, h / 2 - (ay / -az) * focal);
      ctx.lineTo((bx / -bz) * focal + w / 2, h / 2 - (by / -bz) * focal);
      ctx.stroke();
    }
  };

  return { Renderer2D: Renderer2D };
});
