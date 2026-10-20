/*
 * renderer.js — dependency-free WebGL2 renderer.
 *
 * Passes:
 *   1. orbital point cloud as instanced quads (TRIANGLE_STRIP, 4 verts/point)
 *   2. 2D probability slice as one textured quad at y = sliceY
 *   3. optional axis lines
 *
 * Why instanced quads instead of gl.POINTS: point sprites are capped by
 * ALIASED_POINT_SIZE_RANGE (often 64 px) and are notoriously slow / buggy on
 * software rasterisers. Quads give a predictable pixel size and work
 * everywhere. One draw call per pass, no depth buffer, no framebuffers.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QRenderer = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FOV = (42 * Math.PI) / 180;

  /* ----------------------------- mat4 ------------------------------ */
  function perspective(out, fovy, aspect, near, far) {
    var f = 1 / Math.tan(fovy / 2);
    var nf = 1 / (near - far);
    out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
    out[8] = 0; out[9] = 0; out[10] = (far + near) * nf; out[11] = -1;
    out[12] = 0; out[13] = 0; out[14] = 2 * far * near * nf; out[15] = 0;
    return out;
  }

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

  /* ---------------------------- shaders ---------------------------- */
  var POINT_VS = [
    '#version 300 es',
    'precision highp float;',
    'layout(location=0) in vec2 aCorner;',
    'layout(location=1) in vec4 aData;',
    'uniform mat4 uProj;',
    'uniform mat4 uView;',
    'uniform float uSize;',
    'uniform float uDpr;',
    'uniform float uPix;',
    'uniform float uAlpha;',
    'uniform float uDist;',
    'uniform int uColorMode;',
    'uniform vec3 uPos;',
    'uniform vec3 uNeg;',
    'out vec3 vCol;',
    'out float vA;',
    'out vec2 vUv;',
    'vec3 phaseColor(float t){',
    '  float x = fract(t) * 4.0;',
    '  vec3 a = vec3(0.7647, 0.2510, 0.1647);',
    '  vec3 b = vec3(0.6902, 0.4784, 0.1176);',
    '  vec3 c = vec3(0.3725, 0.4314, 0.1961);',
    '  vec3 d = vec3(0.2392, 0.4196, 0.3098);',
    '  if (x < 1.0) return mix(a, b, x);',
    '  if (x < 2.0) return mix(b, c, x - 1.0);',
    '  if (x < 3.0) return mix(c, d, x - 2.0);',
    '  return mix(d, a, x - 3.0);',
    '}',
    'void main(){',
    '  vec4 vp = uView * vec4(aData.xyz, 1.0);',
    '  float d = max(0.05, -vp.z);',
    '  float t = clamp((d - uDist * 0.55) / (uDist * 0.9), 0.0, 1.0);',
    '  float s = uSize * uDpr * uPix * d * mix(1.0, 0.72, t);',
    '  vp.xy += aCorner * s;',
    '  gl_Position = uProj * vp;',
    '  vUv = aCorner;',
    '  if (uColorMode == 0) vCol = aData.w >= 0.0 ? uPos : uNeg;',
    '  else vCol = phaseColor(aData.w);',
    '  vA = uAlpha * mix(1.0, 0.38, t);',
    '}'
  ].join('\n');

  var POINT_FS = [
    '#version 300 es',
    'precision highp float;',
    'in vec3 vCol;',
    'in float vA;',
    'in vec2 vUv;',
    'out vec4 o;',
    'void main(){',
    '  float r2 = dot(vUv, vUv);',
    '  if (r2 > 0.25) discard;',
    '  float a = exp(-r2 * 18.0) * vA;',
    '  o = vec4(vCol, a);',
    '}'
  ].join('\n');

  var SLICE_VS = [
    '#version 300 es',
    'precision highp float;',
    'layout(location=0) in vec3 aPos;',
    'layout(location=1) in vec2 aUv;',
    'uniform mat4 uProj;',
    'uniform mat4 uView;',
    'out vec2 vUv;',
    'void main(){',
    '  vUv = aUv;',
    '  gl_Position = uProj * uView * vec4(aPos, 1.0);',
    '}'
  ].join('\n');

  var SLICE_FS = [
    '#version 300 es',
    'precision highp float;',
    'uniform sampler2D uTex;',
    'in vec2 vUv;',
    'out vec4 o;',
    'void main(){ o = texture(uTex, vUv); }'
  ].join('\n');

  var AXIS_VS = [
    '#version 300 es',
    'precision highp float;',
    'layout(location=0) in vec3 aPos;',
    'layout(location=1) in vec3 aCol;',
    'uniform mat4 uProj;',
    'uniform mat4 uView;',
    'out vec3 vC;',
    'void main(){',
    '  vC = aCol;',
    '  gl_Position = uProj * uView * vec4(aPos, 1.0);',
    '}'
  ].join('\n');

  var AXIS_FS = [
    '#version 300 es',
    'precision highp float;',
    'in vec3 vC;',
    'out vec4 o;',
    'void main(){ o = vec4(vC, 0.28); }'
  ].join('\n');

  function compile(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error('shader: ' + gl.getShaderInfoLog(s));
    }
    return s;
  }

  function program(gl, vs, fs) {
    var p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('link: ' + gl.getProgramInfoLog(p));
    }
    return p;
  }

  function Renderer(canvas) {
    var gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance'
    });
    if (!gl) throw new Error('WebGL2 不可用');

    this.canvas = canvas;
    this.gl = gl;
    this.dpr = 1;
    this.aspect = 1;
    this.view = new Float32Array(16);
    this.proj = new Float32Array(16);

    this.pointProg = program(gl, POINT_VS, POINT_FS);
    this.sliceProg = program(gl, SLICE_VS, SLICE_FS);
    this.axisProg = program(gl, AXIS_VS, AXIS_FS);

    this.pointU = {
      proj: gl.getUniformLocation(this.pointProg, 'uProj'),
      view: gl.getUniformLocation(this.pointProg, 'uView'),
      size: gl.getUniformLocation(this.pointProg, 'uSize'),
      dpr: gl.getUniformLocation(this.pointProg, 'uDpr'),
      pix: gl.getUniformLocation(this.pointProg, 'uPix'),
      alpha: gl.getUniformLocation(this.pointProg, 'uAlpha'),
      dist: gl.getUniformLocation(this.pointProg, 'uDist'),
      colorMode: gl.getUniformLocation(this.pointProg, 'uColorMode'),
      pos: gl.getUniformLocation(this.pointProg, 'uPos'),
      neg: gl.getUniformLocation(this.pointProg, 'uNeg')
    };
    this.sliceU = {
      proj: gl.getUniformLocation(this.sliceProg, 'uProj'),
      view: gl.getUniformLocation(this.sliceProg, 'uView'),
      tex: gl.getUniformLocation(this.sliceProg, 'uTex')
    };
    this.axisU = {
      proj: gl.getUniformLocation(this.axisProg, 'uProj'),
      view: gl.getUniformLocation(this.axisProg, 'uView')
    };

    /* ---- point cloud: quad corners + per-instance data ---- */
    this.cloudVAO = gl.createVertexArray();
    gl.bindVertexArray(this.cloudVAO);

    this.cornerBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5
    ]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.cloudBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cloudBuf);
    gl.bufferData(gl.ARRAY_BUFFER, 16, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);
    this.cloudCapacity = 0;
    this.cloudCount = 0;

    /* ---- slice quad + texture ---- */
    this.sliceVAO = gl.createVertexArray();
    this.sliceBuf = gl.createBuffer();
    gl.bindVertexArray(this.sliceVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.sliceBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
    gl.bindVertexArray(null);

    this.sliceTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.sliceTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.sliceSize = 0;
    this.sliceY = 0;
    this.sliceReady = false;

    /* ---- axes ---- */
    this.axisVAO = gl.createVertexArray();
    this.axisBuf = gl.createBuffer();
    var ax = [];
    var L = 1.25;
    ax.push(-L, 0, 0, 0.58, 0.55, 0.50, L, 0, 0, 0.58, 0.55, 0.50);
    ax.push(0, -L, 0, 0.44, 0.42, 0.38, 0, L, 0, 0.44, 0.42, 0.38);
    ax.push(0, 0, -L, 0.30, 0.29, 0.26, 0, 0, L, 0.30, 0.29, 0.26);
    gl.bindVertexArray(this.axisVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.axisBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(ax), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(null);

    this.mode = 'cloud';
    this.pointSize = 2.6;
    this.alpha = 0.3;
    this.colorMode = 0;
    this.showAxes = false;

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.clearColor(0.9647, 0.9569, 0.9333, 1.0);
  }

  Renderer.prototype.resize = function () {
    var c = this.canvas;
    var dpr = Math.min((typeof self !== 'undefined' && self.devicePixelRatio) || 1, 2);
    var w = Math.max(1, Math.round((c.clientWidth || 1) * dpr));
    var h = Math.max(1, Math.round((c.clientHeight || 1) * dpr));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    this.dpr = dpr;
    this.aspect = w / h;
  };

  Renderer.prototype.setCloudCapacity = function (n) {
    if (n === this.cloudCapacity) return;
    var gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cloudBuf);
    gl.bufferData(gl.ARRAY_BUFFER, n * 16, gl.DYNAMIC_DRAW);
    this.cloudCapacity = n;
    this.cloudCount = 0;
  };

  Renderer.prototype.uploadCloud = function (data, start, count) {
    if (count <= 0) return;
    var gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cloudBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, start * 16, data.subarray(start * 4, (start + count) * 4));
    this.cloudCount = Math.max(this.cloudCount, start + count);
  };

  Renderer.prototype.setCloudCount = function (n) { this.cloudCount = n; };

  Renderer.prototype.setSlice = function (data, size, yOffset) {
    var gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.sliceTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    this.sliceSize = size;
    this.sliceY = yOffset;
    this.sliceReady = true;

    var y = yOffset;
    var quad = new Float32Array([
      -1, y, -1, 0, 0,
       1, y, -1, 1, 0,
      -1, y,  1, 0, 1,
       1, y,  1, 1, 1
    ]);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.sliceBuf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
  };

  Renderer.prototype.draw = function (yaw, pitch, dist, pointSize, alpha, colorMode) {
    var gl = this.gl;
    var c = this.canvas;
    gl.viewport(0, 0, c.width, c.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);

    var cp = Math.cos(pitch), sp = Math.sin(pitch);
    var eye = [dist * cp * Math.cos(yaw), dist * cp * Math.sin(yaw), dist * sp];
    lookAt(this.view, eye, [0, 0, 0], [0, 0, 1]);
    perspective(this.proj, FOV, this.aspect, 0.02, 60);

    if (this.mode === 'slice' && this.sliceReady) {
      gl.useProgram(this.sliceProg);
      gl.uniformMatrix4fv(this.sliceU.proj, false, this.proj);
      gl.uniformMatrix4fv(this.sliceU.view, false, this.view);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.sliceTex);
      gl.uniform1i(this.sliceU.tex, 0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(this.sliceVAO);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
    } else if (this.cloudCount > 0) {
      gl.useProgram(this.pointProg);
      gl.uniformMatrix4fv(this.pointU.proj, false, this.proj);
      gl.uniformMatrix4fv(this.pointU.view, false, this.view);
      gl.uniform1f(this.pointU.size, pointSize);
      gl.uniform1f(this.pointU.dpr, this.dpr);
      gl.uniform1f(this.pointU.pix, (2 * Math.tan(FOV / 2)) / c.height);
      gl.uniform1f(this.pointU.alpha, Math.min(0.6, Math.max(0.08, alpha * 24)));
      gl.uniform1f(this.pointU.dist, dist);
      gl.uniform1i(this.pointU.colorMode, colorMode);
      gl.uniform3f(this.pointU.pos, 0.0784, 0.0784, 0.0784);
      gl.uniform3f(this.pointU.neg, 0.7647, 0.2510, 0.1647);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(this.cloudVAO);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.cloudCount);
      gl.bindVertexArray(null);
    }

    if (this.showAxes) {
      gl.useProgram(this.axisProg);
      gl.uniformMatrix4fv(this.axisU.proj, false, this.proj);
      gl.uniformMatrix4fv(this.axisU.view, false, this.view);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(this.axisVAO);
      gl.drawArrays(gl.LINES, 0, 6);
      gl.bindVertexArray(null);
    }
  };

  return { Renderer: Renderer, perspective: perspective, lookAt: lookAt };
});
