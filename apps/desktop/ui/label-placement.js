// SPDX-License-Identifier: Apache-2.0
// 注记避让：屏幕像素坐标下的贪心放置。不依赖地图库，浏览器和 Node 都能运行。
(function (root) {
  "use strict";

  // 点注记的候选位置，按尝试顺序：右上、右下、左上、左下、右、左、上、下。
  const POINT_POSITIONS = ["NE", "SE", "NW", "SW", "E", "W", "N", "S"];
  const GAP = 2;

  function pointBox(position, x, y, width, height, radius) {
    const near = radius + GAP;
    switch (position) {
      case "NE": return { x: x + near, y: y - near - height };
      case "SE": return { x: x + near, y: y + near };
      case "NW": return { x: x - near - width, y: y - near - height };
      case "SW": return { x: x - near - width, y: y + near };
      case "E": return { x: x + near, y: y - height / 2 };
      case "W": return { x: x - near - width, y: y - height / 2 };
      case "N": return { x: x - width / 2, y: y - near - height };
      default: return { x: x - width / 2, y: y + near };
    }
  }

  function overlaps(a, b, padding) {
    return a.x < b.x + b.width + padding && b.x < a.x + a.width + padding
      && a.y < b.y + b.height + padding && b.y < a.y + a.height + padding;
  }

  function hitsCircle(box, circle, padding) {
    const nearestX = Math.max(box.x, Math.min(circle.x, box.x + box.width));
    const nearestY = Math.max(box.y, Math.min(circle.y, box.y + box.height));
    const dx = circle.x - nearestX;
    const dy = circle.y - nearestY;
    const reach = circle.r + padding;
    return dx * dx + dy * dy < reach * reach;
  }

  /** 均匀格网索引。盒子按覆盖的格子登记。 */
  function GridIndex(cell) {
    this.cell = cell;
    this.cells = new Map();
  }
  GridIndex.prototype.keys = function (box, padding) {
    const keys = [];
    const x0 = Math.floor((box.x - padding) / this.cell);
    const x1 = Math.floor((box.x + box.width + padding) / this.cell);
    const y0 = Math.floor((box.y - padding) / this.cell);
    const y1 = Math.floor((box.y + box.height + padding) / this.cell);
    for (let gx = x0; gx <= x1; gx += 1) for (let gy = y0; gy <= y1; gy += 1) keys.push(gx + "," + gy);
    return keys;
  };
  GridIndex.prototype.insert = function (item, box) {
    for (const key of this.keys(box, 0)) {
      const bucket = this.cells.get(key);
      if (bucket) bucket.push(item);
      else this.cells.set(key, [item]);
    }
  };
  GridIndex.prototype.near = function (box, padding) {
    const found = new Set();
    for (const key of this.keys(box, padding)) {
      const bucket = this.cells.get(key);
      if (bucket) for (const item of bucket) found.add(item);
    }
    return found;
  };

  function circleBox(circle) {
    return { x: circle.x - circle.r, y: circle.y - circle.r, width: circle.r * 2, height: circle.r * 2 };
  }

  /**
   * items: { id, text, width, height, kind: "point" | "line" | "polygon", anchors: [[x, y], ...], radius?, rank?, size? }
   *   点用 anchors[0] 和 8 个候选位置；线和面把盒子中心放在各个 anchor 上，按顺序尝试。
   * options: { width, height, padding?, symbols?: [{ x, y, r }] }
   *   symbols 是地图上的点符号；注记不能压住任何点符号。
   * 排序：rank 小的先放（图层越靠上越小），同 rank 时 size 大的先放，再按输入顺序。
   * 放不下的注记不画，在 dropped 里返回。
   */
  function placeLabels(items, options) {
    const padding = typeof options.padding === "number" ? options.padding : 2;
    const view = { x: 0, y: 0, width: options.width, height: options.height };
    const symbols = Array.isArray(options.symbols) ? options.symbols : [];
    const symbolIndex = new GridIndex(64);
    for (const circle of symbols) symbolIndex.insert(circle, circleBox(circle));
    const placedIndex = new GridIndex(64);
    const order = items.map((item, index) => ({ item, index }));
    order.sort((left, right) => ((left.item.rank || 0) - (right.item.rank || 0))
      || ((right.item.size || 0) - (left.item.size || 0))
      || (left.index - right.index));
    const placed = [];
    const dropped = [];
    for (const { item } of order) {
      const candidates = [];
      if (item.kind === "point") {
        const anchor = item.anchors[0];
        if (anchor) {
          for (const position of POINT_POSITIONS) {
            candidates.push({ position, anchor, ...pointBox(position, anchor[0], anchor[1], item.width, item.height, item.radius || 0) });
          }
        }
      } else {
        for (const anchor of item.anchors) {
          candidates.push({ position: "C", anchor, x: anchor[0] - item.width / 2, y: anchor[1] - item.height / 2 });
        }
      }
      let chosen = null;
      for (const candidate of candidates) {
        const box = { x: candidate.x, y: candidate.y, width: item.width, height: item.height };
        if (box.x < view.x || box.y < view.y || box.x + box.width > view.width || box.y + box.height > view.height) continue;
        let blocked = false;
        for (const other of placedIndex.near(box, padding)) {
          if (overlaps(box, other, padding)) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;
        for (const circle of symbolIndex.near(box, padding)) {
          if (hitsCircle(box, circle, padding)) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;
        chosen = { id: item.id, text: item.text, x: box.x, y: box.y, width: box.width, height: box.height, position: candidate.position, anchor: candidate.anchor };
        break;
      }
      if (chosen) {
        placed.push(chosen);
        placedIndex.insert(chosen, chosen);
      } else {
        dropped.push(item.id);
      }
    }
    return { placed, dropped };
  }

  function pointInRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const a = ring[i];
      const b = ring[j];
      if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  }

  function segmentDistance(x, y, a, b) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length2 = dx * dx + dy * dy;
    const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / length2));
    return Math.hypot(a[0] + t * dx - x, a[1] + t * dy - y);
  }

  function edgeDistance(x, y, rings) {
    let best = Infinity;
    for (const ring of rings) {
      for (let i = 1; i < ring.length; i += 1) best = Math.min(best, segmentDistance(x, y, ring[i - 1], ring[i]));
    }
    return best;
  }

  function insidePolygon(x, y, rings) {
    if (!rings[0] || !pointInRing(x, y, rings[0])) return false;
    for (let i = 1; i < rings.length; i += 1) if (pointInRing(x, y, rings[i])) return false;
    return true;
  }

  /** 面的注记点：在面内找离边界最远的点。先 12×12 格网，再在最好的格子周围细化两轮。 */
  function polygonAnchor(rings) {
    const outer = rings[0];
    if (!outer || outer.length < 3) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const pair of outer) {
      minX = Math.min(minX, pair[0]);
      minY = Math.min(minY, pair[1]);
      maxX = Math.max(maxX, pair[0]);
      maxY = Math.max(maxY, pair[1]);
    }
    let best = null;
    let stepX = (maxX - minX) / 12;
    let stepY = (maxY - minY) / 12;
    let originX = minX;
    let originY = minY;
    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i <= 12; i += 1) {
        for (let j = 0; j <= 12; j += 1) {
          const x = originX + i * stepX;
          const y = originY + j * stepY;
          if (!insidePolygon(x, y, rings)) continue;
          const distance = edgeDistance(x, y, rings);
          if (!best || distance > best.distance) best = { x, y, distance };
        }
      }
      if (!best) return null;
      originX = best.x - stepX;
      originY = best.y - stepY;
      stepX /= 6;
      stepY /= 6;
    }
    return best ? { point: [best.x, best.y], clearance: best.distance } : null;
  }

  /** 线的注记点：沿线 1/2、1/3、2/3 处。 */
  function lineAnchors(line) {
    const lengths = [0];
    for (let i = 1; i < line.length; i += 1) lengths.push(lengths[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]));
    const total = lengths[lengths.length - 1];
    if (!(total > 0)) return { anchors: line[0] ? [line[0]] : [], length: 0 };
    const at = (share) => {
      const target = total * share;
      for (let i = 1; i < line.length; i += 1) {
        if (lengths[i] >= target) {
          const span = lengths[i] - lengths[i - 1];
          const t = span > 0 ? (target - lengths[i - 1]) / span : 0;
          return [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t];
        }
      }
      return line[line.length - 1];
    };
    return { anchors: [at(0.5), at(1 / 3), at(2 / 3)], length: total };
  }

  root.IgisLabelPlacement = { placeLabels, polygonAnchor, lineAnchors, POINT_POSITIONS };
})(typeof globalThis !== "undefined" ? globalThis : this);
