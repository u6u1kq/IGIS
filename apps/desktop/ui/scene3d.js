// SPDX-License-Identifier: Apache-2.0
// 三维页渲染：可旋转地形、叠加栅格、爆炸图分层、地层体体素。纯 WebGL，不依赖第三方库。
"use strict";

(function () {
  const VERTEX = `
attribute vec3 aPosition;
attribute vec4 aColor;
attribute vec3 aNormal;
uniform mat4 uMatrix;
uniform float uLight;
uniform float uPointSize;
varying vec4 vColor;
void main() {
  gl_Position = uMatrix * vec4(aPosition, 1.0);
  gl_PointSize = uPointSize;
  float shade = uLight > 0.5 ? 0.45 + 0.55 * max(dot(normalize(aNormal), normalize(vec3(-0.4, -0.5, 0.75))), 0.0) : 1.0;
  vColor = vec4(aColor.rgb * shade, aColor.a);
}`;
  const FRAGMENT = `
precision mediump float;
varying vec4 vColor;
void main() { gl_FragColor = vColor; }`;

  const PALETTE = [
    [0.86, 0.35, 0.27], [0.25, 0.55, 0.85], [0.35, 0.7, 0.35], [0.9, 0.7, 0.2],
    [0.6, 0.4, 0.75], [0.2, 0.7, 0.7], [0.85, 0.45, 0.65], [0.55, 0.55, 0.3],
  ];

  function compile(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || "着色器编译失败");
    return shader;
  }

  function perspective(fov, aspect, near, far) {
    const f = 1 / Math.tan(fov / 2);
    const nf = 1 / (near - far);
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
  }

  function lookAt(eye, target, up) {
    let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
    let len = Math.hypot(zx, zy, zz) || 1;
    zx /= len; zy /= len; zz /= len;
    let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
    len = Math.hypot(xx, xy, xz) || 1;
    xx /= len; xy /= len; xz /= len;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    return [
      xx, yx, zx, 0,
      xy, yy, zy, 0,
      xz, yz, zz, 0,
      -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
      -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
      -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
      1,
    ];
  }

  function multiply(a, b) {
    const out = new Array(16).fill(0);
    for (let col = 0; col < 4; col += 1) {
      for (let row = 0; row < 4; row += 1) {
        let sum = 0;
        for (let k = 0; k < 4; k += 1) sum += a[k * 4 + row] * b[col * 4 + k];
        out[col * 4 + row] = sum;
      }
    }
    return out;
  }

  function elevationColor(t) {
    const stops = [[0, [0.33, 0.55, 0.32]], [0.45, [0.62, 0.66, 0.38]], [0.75, [0.6, 0.48, 0.34]], [1, [0.93, 0.92, 0.9]]];
    for (let i = 1; i < stops.length; i += 1) {
      if (t <= stops[i][0]) {
        const [t0, c0] = stops[i - 1];
        const [t1, c1] = stops[i];
        const f = (t - t0) / Math.max(t1 - t0, 1e-9);
        return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
      }
    }
    return stops[stops.length - 1][1];
  }

  function rampColor(t) {
    const a = [0.27, 0.0, 0.33], b = [0.13, 0.57, 0.55], c = [0.99, 0.91, 0.14];
    if (t < 0.5) {
      const f = t / 0.5;
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
    }
    const f = (t - 0.5) / 0.5;
    return [b[0] + (c[0] - b[0]) * f, b[1] + (c[1] - b[1]) * f, b[2] + (c[2] - b[2]) * f];
  }

  /** 叠加栅格的颜色。返回 null 表示这个点不改地形颜色。 */
  function drapeColor(kind, value, scale) {
    if (value === null || value === undefined || !Number.isFinite(value)) return null;
    if (kind === "runoff") {
      if (value <= 0.01) return null;
      const f = Math.min(value / Math.max(scale.max, 0.02), 1);
      return [0.55 - 0.45 * f, 0.75 - 0.45 * f, 1.0 - 0.25 * f];
    }
    if (kind === "landslide") {
      if (value < 1) return [0.85, 0.12, 0.1];
      if (value < 1.3) return [0.95, 0.6, 0.15];
      return null;
    }
    const span = scale.max - scale.min;
    return rampColor(span > 0 ? (value - scale.min) / span : 0.5);
  }

  function sampleGrid(grid, x, y) {
    if (!grid) return null;
    const [minx, miny, maxx, maxy] = grid.extent;
    if (x < minx || x > maxx || y < miny || y > maxy) return null;
    const column = Math.min(grid.width - 1, Math.floor(((x - minx) / (maxx - minx)) * grid.width));
    const row = Math.min(grid.height - 1, Math.floor(((maxy - y) / (maxy - miny)) * grid.height));
    const value = grid.values[row * grid.width + column];
    return typeof value === "number" ? value : null;
  }

  function create(canvas) {
    const gl = canvas.getContext("webgl", { antialias: true, alpha: false });
    if (!gl) throw new Error("这台电脑的窗口不支持 WebGL，三维页画不出来。");
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("着色器链接失败");
    const loc = {
      position: gl.getAttribLocation(program, "aPosition"),
      color: gl.getAttribLocation(program, "aColor"),
      normal: gl.getAttribLocation(program, "aNormal"),
      matrix: gl.getUniformLocation(program, "uMatrix"),
      light: gl.getUniformLocation(program, "uLight"),
      pointSize: gl.getUniformLocation(program, "uPointSize"),
    };
    const state = {
      terrain: null,
      drape: null,
      drapeKind: "raster",
      drapeScale: { min: 0, max: 1 },
      stack: null,
      geology: null,
      visible: { terrain: true, drape: true, stack: true, geology: true },
      exaggeration: 1,
      yaw: -0.6,
      pitch: 0.75,
      distance: 1000,
      pan: [0, 0],
      frame: null,
      meshes: { terrain: null, stack: null, geology: null },
      geologyCell: 1,
    };

    function upload(mode, data) {
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
      return { buffer, mode, count: data.length / 10 };
    }

    function drop(name) {
      const mesh = state.meshes[name];
      if (mesh) for (const part of mesh) gl.deleteBuffer(part.buffer);
      state.meshes[name] = null;
    }

    /** 世界坐标：以地形中心为原点，z 从地形最低点起算并乘竖向放大。没有地形时由分层或地层体定原点。 */
    function frame() {
      if (state.terrain) {
        const [minx, miny, maxx, maxy] = state.terrain.extent;
        return { cx: (minx + maxx) / 2, cy: (miny + maxy) / 2, z0: state.terrain.minimum ?? 0, size: Math.max(maxx - minx, maxy - miny), epsg: state.terrain.epsg ?? null };
      }
      if (state.geology) {
        const g = state.geology;
        return { cx: g.origin[0] + (g.grid[0] * g.step[0]) / 2, cy: g.origin[1] + (g.grid[1] * g.step[1]) / 2, z0: g.origin[2], size: Math.max(g.grid[0] * g.step[0], g.grid[1] * g.step[1]), epsg: null };
      }
      if (state.stack && state.stack.bounds) {
        const [minx, miny, maxx, maxy] = state.stack.bounds;
        const corner = state.stack.project([maxx, maxy], { cx: minx, cy: miny });
        return { cx: (minx + maxx) / 2, cy: (miny + maxy) / 2, z0: 0, size: Math.max(corner[0], corner[1], state.stack.gap * state.stack.layers.length, 1), epsg: state.stack.epsg };
      }
      return null;
    }

    function buildTerrain() {
      drop("terrain");
      const grid = state.terrain;
      const f = state.frame;
      if (!grid || !f) return;
      const { width, height, values } = grid;
      const [minx, miny, maxx, maxy] = grid.extent;
      const dx = (maxx - minx) / width;
      const dy = (maxy - miny) / height;
      const zmin = grid.minimum ?? 0;
      const zspan = Math.max((grid.maximum ?? 1) - zmin, 1e-9);
      const ex = state.exaggeration;
      const at = (i, j) => values[j * width + i];
      const position = (i, j) => [minx + (i + 0.5) * dx - f.cx, maxy - (j + 0.5) * dy - f.cy, (at(i, j) - f.z0) * ex];
      const normal = (i, j) => {
        const left = at(Math.max(i - 1, 0), j), right = at(Math.min(i + 1, width - 1), j);
        const up = at(i, Math.max(j - 1, 0)), down = at(i, Math.min(j + 1, height - 1));
        const here = at(i, j);
        const gx = ((typeof right === "number" ? right : here) - (typeof left === "number" ? left : here)) * ex / (2 * dx);
        const gy = ((typeof up === "number" ? up : here) - (typeof down === "number" ? down : here)) * ex / (2 * dy);
        return [-gx, -gy, 1];
      };
      const color = (i, j) => {
        const base = elevationColor((at(i, j) - zmin) / zspan);
        if (state.drape && state.visible.drape) {
          const p = position(i, j);
          const tinted = drapeColor(state.drapeKind, sampleGrid(state.drape, p[0] + f.cx, p[1] + f.cy), state.drapeScale);
          if (tinted) return [tinted[0], tinted[1], tinted[2], 1];
        }
        return [base[0], base[1], base[2], 1];
      };
      const data = [];
      const push = (i, j) => { data.push(...position(i, j), ...color(i, j), ...normal(i, j)); };
      for (let j = 0; j < height - 1; j += 1) {
        for (let i = 0; i < width - 1; i += 1) {
          if ([at(i, j), at(i + 1, j), at(i, j + 1), at(i + 1, j + 1)].some((value) => typeof value !== "number")) continue;
          push(i, j); push(i, j + 1); push(i + 1, j);
          push(i + 1, j); push(i, j + 1); push(i + 1, j + 1);
        }
      }
      if (data.length > 0) state.meshes.terrain = [upload(gl.TRIANGLES, data)];
    }

    function buildStack() {
      drop("stack");
      const stack = state.stack;
      const f = state.frame;
      if (!stack || !f) return;
      const sameFrame = state.terrain && stack.epsg !== null && stack.epsg === f.epsg;
      const local = sameFrame ? { cx: f.cx, cy: f.cy } : { cx: (stack.bounds[0] + stack.bounds[2]) / 2, cy: (stack.bounds[1] + stack.bounds[3]) / 2 };
      const top = state.terrain ? ((state.terrain.maximum ?? 0) - f.z0) * state.exaggeration : 0;
      const lines = [];
      const points = [];
      stack.layers.forEach((layer, index) => {
        const z = top + stack.gap * (index + 1);
        const rgb = PALETTE[index % PALETTE.length];
        const color = [rgb[0], rgb[1], rgb[2], 1];
        const xy = (pair) => stack.project(pair, local);
        for (const ring of layer.rings) {
          for (let k = 0; k + 1 < ring.length; k += 1) {
            const a = xy(ring[k]);
            const b = xy(ring[k + 1]);
            lines.push(a[0], a[1], z, ...color, 0, 0, 1, b[0], b[1], z, ...color, 0, 0, 1);
          }
        }
        for (const pair of layer.points) {
          const p = xy(pair);
          points.push(p[0], p[1], z, ...color, 0, 0, 1);
        }
      });
      const parts = [];
      if (lines.length > 0) parts.push(upload(gl.LINES, lines));
      if (points.length > 0) parts.push(upload(gl.POINTS, points));
      state.meshes.stack = parts.length > 0 ? parts : null;
    }

    function buildGeology() {
      drop("geology");
      const g = state.geology;
      const f = state.frame;
      if (!g || !f) return;
      const [nx, ny, nz] = g.grid;
      const data = [];
      for (let k = 0; k < nz; k += 1) {
        for (let j = 0; j < ny; j += 1) {
          for (let i = 0; i < nx; i += 1) {
            const unit = g.cells[(k * ny + j) * nx + i];
            if (typeof unit !== "number" || unit < 0) continue;
            const rgb = unit === 0 ? [0.55, 0.55, 0.55] : PALETTE[(unit - 1) % PALETTE.length];
            const x = g.origin[0] + (i + 0.5) * g.step[0] - f.cx;
            const y = g.origin[1] + (j + 0.5) * g.step[1] - f.cy;
            const z = (g.origin[2] + (k + 0.5) * g.step[2] - f.z0) * state.exaggeration;
            data.push(x, y, z, rgb[0], rgb[1], rgb[2], 1, 0, 0, 1);
          }
        }
      }
      state.geologyCell = Math.max(g.step[0], g.step[1]);
      if (data.length > 0) state.meshes.geology = [upload(gl.POINTS, data)];
    }

    function rebuild(resetCamera) {
      const previous = state.frame;
      state.frame = frame();
      if (state.frame && (resetCamera || !previous)) {
        state.distance = state.frame.size * 1.6;
        state.pan = [0, 0];
      }
      buildTerrain();
      buildStack();
      buildGeology();
      draw();
    }

    function draw() {
      const ratio = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
      const height = Math.max(1, Math.floor(canvas.clientHeight * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      gl.viewport(0, 0, width, height);
      gl.clearColor(0.922, 0.886, 0.831, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      if (!state.frame) return;
      const target = [state.pan[0], state.pan[1], 0];
      const eye = [
        target[0] + state.distance * Math.cos(state.pitch) * Math.sin(state.yaw),
        target[1] - state.distance * Math.cos(state.pitch) * Math.cos(state.yaw),
        target[2] + state.distance * Math.sin(state.pitch),
      ];
      const fov = Math.PI / 4;
      const matrix = multiply(perspective(fov, width / height, state.distance / 1000, state.distance * 20), lookAt(eye, target, [0, 0, 1]));
      gl.useProgram(program);
      gl.uniformMatrix4fv(loc.matrix, false, new Float32Array(matrix));
      const pixelsPerMeter = height / (2 * state.distance * Math.tan(fov / 2));
      for (const name of ["terrain", "stack", "geology"]) {
        if (!state.visible[name] || !state.meshes[name]) continue;
        for (const part of state.meshes[name]) {
          gl.bindBuffer(gl.ARRAY_BUFFER, part.buffer);
          gl.enableVertexAttribArray(loc.position);
          gl.vertexAttribPointer(loc.position, 3, gl.FLOAT, false, 40, 0);
          gl.enableVertexAttribArray(loc.color);
          gl.vertexAttribPointer(loc.color, 4, gl.FLOAT, false, 40, 12);
          gl.enableVertexAttribArray(loc.normal);
          gl.vertexAttribPointer(loc.normal, 3, gl.FLOAT, false, 40, 28);
          gl.uniform1f(loc.light, part.mode === gl.TRIANGLES ? 1 : 0);
          const size = name === "geology" ? state.geologyCell * pixelsPerMeter : 5 * ratio;
          gl.uniform1f(loc.pointSize, Math.min(Math.max(size, 2), 48));
          gl.drawArrays(part.mode, 0, part.count);
        }
      }
    }

    let dragging = null;
    canvas.addEventListener("pointerdown", (event) => {
      dragging = { x: event.clientX, y: event.clientY, pan: event.shiftKey || event.button === 2 };
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const dx = event.clientX - dragging.x;
      const dy = event.clientY - dragging.y;
      dragging.x = event.clientX;
      dragging.y = event.clientY;
      if (dragging.pan) {
        const scale = state.distance / Math.max(canvas.clientHeight, 1);
        const cos = Math.cos(state.yaw), sin = Math.sin(state.yaw);
        state.pan[0] -= (dx * cos + dy * sin) * scale;
        state.pan[1] -= (dx * sin - dy * cos) * scale;
      } else {
        state.yaw += dx * 0.008;
        state.pitch = Math.min(Math.max(state.pitch + dy * 0.008, 0.05), 1.55);
      }
      draw();
    });
    canvas.addEventListener("pointerup", () => { dragging = null; });
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      state.distance = Math.min(Math.max(state.distance * Math.exp(event.deltaY * 0.001), 1), 1e7);
      draw();
    }, { passive: false });

    return {
      setTerrain(grid) {
        const resetCamera = !state.terrain || !grid || state.terrain.extent.join() !== grid.extent.join();
        state.terrain = grid;
        rebuild(resetCamera);
      },
      setDrape(grid, kind, scale) {
        state.drape = grid;
        state.drapeKind = kind || "raster";
        state.drapeScale = scale || { min: grid?.minimum ?? 0, max: grid?.maximum ?? 1 };
        buildTerrain();
        draw();
      },
      setStack(stack) {
        state.stack = stack;
        rebuild(!state.terrain && !state.geology);
      },
      setGeology(model) {
        state.geology = model;
        rebuild(!state.terrain);
      },
      setVisible(name, visible) {
        state.visible[name] = visible;
        if (name === "drape") buildTerrain();
        draw();
      },
      setExaggeration(value) {
        state.exaggeration = Math.min(Math.max(Number(value) || 1, 0.1), 50);
        rebuild(false);
      },
      resetView() {
        state.yaw = -0.6;
        state.pitch = 0.75;
        rebuild(true);
      },
      draw,
    };
  }

  /** 把一个 GeoJSON 图层整理成爆炸图要画的环和点。经纬度在没有地形时换成以中心为原点的米。 */
  function stackFromCollections(layers, gap) {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    let epsg = null;
    const prepared = layers.map((collection) => {
      const rings = [];
      const points = [];
      const crsName = collection && collection.crs && collection.crs.properties ? String(collection.crs.properties.name || "") : "";
      const code = /^EPSG:(\d+)$/.exec(crsName);
      if (code && epsg === null) epsg = Number(code[1]);
      const visit = (geometry) => {
        if (!geometry) return;
        const c = geometry.coordinates;
        if (geometry.type === "Point") points.push(c);
        else if (geometry.type === "MultiPoint") points.push(...c);
        else if (geometry.type === "LineString") rings.push(c);
        else if (geometry.type === "MultiLineString" || geometry.type === "Polygon") rings.push(...c);
        else if (geometry.type === "MultiPolygon") for (const polygon of c) rings.push(...polygon);
        else if (geometry.type === "GeometryCollection") for (const part of geometry.geometries || []) visit(part);
      };
      for (const feature of (collection && collection.features) || []) visit(feature.geometry);
      for (const pair of [...points, ...rings.flat()]) {
        if (!Array.isArray(pair) || !Number.isFinite(pair[0]) || !Number.isFinite(pair[1])) continue;
        minx = Math.min(minx, pair[0]); maxx = Math.max(maxx, pair[0]);
        miny = Math.min(miny, pair[1]); maxy = Math.max(maxy, pair[1]);
      }
      return { rings, points };
    });
    if (!Number.isFinite(minx)) return null;
    const geographic = epsg === 4326 || (epsg === null && minx >= -180 && maxx <= 180 && miny >= -90 && maxy <= 90);
    const lat0 = (miny + maxy) / 2;
    const project = geographic
      ? (pair, center) => [(pair[0] - center.cx) * 111320 * Math.cos((lat0 * Math.PI) / 180), (pair[1] - center.cy) * 110540]
      : (pair, center) => [pair[0] - center.cx, pair[1] - center.cy];
    return { layers: prepared, gap, bounds: [minx, miny, maxx, maxy], epsg: geographic ? null : epsg, project, geographic };
  }

  window.IgisScene = { create, stackFromCollections };
})();
