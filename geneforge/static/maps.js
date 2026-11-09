/* GeneForge map rendering: linear and circular SVG views. */
(function () {
  const NS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs, parent) {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs || {}) {
      if (attrs[k] === null || attrs[k] === undefined) continue;
      n.setAttribute(k, attrs[k]);
    }
    if (parent) parent.appendChild(n);
    return n;
  }

  function contrast(hex) {
    const h = (hex || '#888').replace('#', '');
    const v = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
    const r = parseInt(v.slice(0, 2), 16), g = parseInt(v.slice(2, 4), 16), b = parseInt(v.slice(4, 6), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#1b1f24' : '#ffffff';
  }

  function niceStep(span, target) {
    const raw = span / Math.max(target, 1);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const m of [1, 2, 5, 10]) if (raw <= m * mag) return m * mag;
    return 10 * mag;
  }

  /* Assign each item the topmost lane where it does not collide. */
  function packLanes(items, pad) {
    const lanes = [];
    const out = new Map();
    items.forEach(it => {
      let i = 0;
      while (true) {
        if (!lanes[i]) { lanes[i] = -Infinity; }
        if (it.a >= lanes[i] + pad) { lanes[i] = it.b; out.set(it.key, i); break; }
        i++;
      }
    });
    return { lane: out, count: Math.max(lanes.length, 1) };
  }

  function featSpan(f) {
    const segs = f.segments || [[0, 0]];
    return [segs[0][0], segs[segs.length - 1][1]];
  }

  /* ------------------------------------------------------------------ linear */

  function renderLinear(host, data, opts) {
    opts = opts || {};
    host.innerHTML = '';
    host.style.overflowY = 'auto';
    const W = Math.max(host.clientWidth || 800, 320);
    const L = Math.max(data.seq.length, 1);
    const padL = 54, padR = 54;
    const innerW = W - padL - padR;
    const axisY = 52, laneH = 18, laneTop = axisY + 16;

    const feats = (data.features || []).slice()
      .map(f => { const [a, b] = featSpan(f); return { key: f.id, a, b, f }; })
      .sort((x, y) => x.a - y.a || y.b - x.b);
    const packed = packLanes(feats, Math.ceil(L / Math.max(innerW, 1) * 60));
    const orfs = opts.showOrfs ? (opts.orfs || []) : [];
    const orfItems = orfs.map((o, i) => ({ key: 'o' + i, a: o.start, b: o.end, o }));
    const orfPacked = packLanes(orfItems, Math.ceil(L / Math.max(innerW, 1) * 60));
    const orfTop = laneTop + packed.count * laneH + 10;
    const H = Math.max(host.clientHeight || 220,
      orfTop + (orfs.length ? orfPacked.count * 9 + 14 : 0) + 18);

    const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` }, host);
    const x = p => padL + (Math.max(0, Math.min(L, p)) / L) * innerW;
    const posAt = px => Math.round(((px - padL) / innerW) * L);

    /* ruler */
    el('line', { class: 'axis', x1: padL, y1: axisY, x2: padL + innerW, y2: axisY }, svg);
    const step = niceStep(L, Math.max(4, Math.floor(innerW / 90)));
    for (let p = 0; p <= L; p += step) {
      const xx = x(p);
      el('line', { class: 'tick', x1: xx, y1: axisY, x2: xx, y2: axisY + 5 }, svg);
      const t = el('text', { class: 'ticktext', x: xx, y: axisY + 15, 'text-anchor': 'middle' }, svg);
      t.textContent = p.toLocaleString();
    }
    const endT = el('text', { class: 'ticktext', x: padL + innerW, y: axisY - 7, 'text-anchor': 'end' }, svg);
    endT.textContent = L.toLocaleString() + ' bp' + (data.topology === 'circular' ? ' ○' : '');

    /* selection band */
    if (opts.selection && opts.selection[1] > opts.selection[0]) {
      const [s, e] = opts.selection;
      el('rect', { class: 'selband', x: x(s), y: axisY - 13, width: Math.max(1.5, x(e) - x(s)), height: H - axisY + 6 }, svg);
    }

    /* restriction cuts */
    (opts.cuts || []).forEach(c => {
      const xx = x(c.pos);
      el('line', { class: 'cut', x1: xx, y1: axisY - 13, x2: xx, y2: axisY + 2 }, svg);
      const t = el('text', { class: 'cuttext', x: xx, y: axisY - 17, 'text-anchor': 'middle' }, svg);
      t.textContent = c.label;
    });

    /* features */
    const laneLabelEnd = {};           // right-most x a label already occupies, per lane
    feats.forEach(item => {
      const f = item.f;
      const lane = packed.lane.get(item.key) || 0;
      const y = laneTop + lane * laneH;
      const g = el('g', { class: 'feat' + (opts.activeFeature === f.id ? ' sel' : '') }, svg);
      g.dataset.featureId = f.id;
      const segs = f.segments || [[item.a, item.b]];
      const x1 = x(item.a), x2 = x(item.b);
      if (segs.length > 1) {
        el('line', { x1, y1: y + 6, x2, y2: y + 6, stroke: f.color, 'stroke-width': 1, 'stroke-dasharray': '2 2' }, g);
      }
      segs.forEach(([a, b]) => {
        const sx = x(a), ex = Math.max(x(b), sx + 2), w = ex - sx;
        const head = Math.min(7, Math.max(0, w - 1));
        let d;
        if (f.strand === -1) {
          d = `M${sx + head},${y} L${ex},${y} L${ex},${y + 12} L${sx + head},${y + 12} L${sx},${y + 6} Z`;
        } else if (f.strand === 1) {
          d = `M${sx},${y} L${ex - head},${y} L${ex},${y + 6} L${ex - head},${y + 12} L${sx},${y + 12} Z`;
        } else {
          d = `M${sx},${y} L${ex},${y} L${ex},${y + 12} L${sx},${y + 12} Z`;
        }
        const p = el('path', { class: 'shape', d, fill: f.color, stroke: 'rgba(0,0,0,.18)', 'stroke-width': .6 }, g);
        p.appendChild(el('title', {}, null)).textContent =
          `${f.label}  ${f.type}\n${item.a + 1}..${item.b} (${item.b - item.a} bp) ${f.strand === -1 ? '←' : f.strand === 1 ? '→' : ''}`;
      });
      const w = x2 - x1;
      const label = f.label || f.type;
      if (w > label.length * 5.6 + 12) {
        const t = el('text', { class: 'flabel', x: (x1 + x2) / 2, y: y + 9, 'text-anchor': 'middle', fill: contrast(f.color) }, g);
        t.textContent = label;
      } else if (w > 3) {
        const textW = label.length * 5.6;
        const prevEnd = laneLabelEnd[lane] ?? -Infinity;
        const fitsRight = x2 + 6 + textW < W - 4;
        const nextStart = nextStartInLane(feats, packed, lane, item.b);
        const clearRight = fitsRight && (x2 + 6 + textW) < x(nextStart) - 3;
        const clearLeft = (x1 - 6 - textW) > prevEnd + 3 && (x1 - 6 - textW) > padL;
        if (clearRight || clearLeft) {
          const right = clearRight;
          const t = el('text', {
            class: 'flabel', x: right ? x2 + 5 : x1 - 5, y: y + 9,
            'text-anchor': right ? 'start' : 'end', fill: '#5b6672'
          }, g);
          t.textContent = label;
          laneLabelEnd[lane] = right ? x2 + 5 + textW : x1 - 5;
        } else {
          laneLabelEnd[lane] = Math.max(prevEnd, x2);
        }
      } else {
        laneLabelEnd[lane] = Math.max(laneLabelEnd[lane] ?? -Infinity, x2);
      }
      g.addEventListener('click', ev => { ev.stopPropagation(); opts.onFeature && opts.onFeature(f); });
    });

    /* ORF track. Each ORF is drawn as an arrow whose tail sits on the start
       codon, so the reading direction is visible without reading the numbers. */
    if (orfs.length) {
      const t = el('text', { class: 'ticktext', x: padL, y: orfTop - 3 }, svg);
      t.textContent = 'ORFs';
      orfItems.forEach(item => {
        const lane = orfPacked.lane.get(item.key) || 0;
        const y = orfTop + lane * 9;
        const col = item.o.strand === 1 ? '#2f855a' : '#9c4221';
        const x1 = x(item.a), x2 = Math.max(x(item.b), x1 + 4);
        const fwd = item.o.strand === 1;
        const h = 5, half = h / 2;
        el('rect', { class: 'orfbar', x: x1, y, width: x2 - x1, height: h, rx: 1.5, fill: col }, svg);
        /* A big arrow head sits ON the start codon, pointing the way the frame
           reads. That is the left end on the plus strand and the right end on
           the minus strand, which is the part that is otherwise easy to miss. */
        const sx = fwd ? x1 : x2, dir = fwd ? 1 : -1, hw = 7, hh = 4.5;
        const g = el('g', { class: 'orfstart' }, svg);
        el('path', {
          d: `M${sx},${y - hh + half} L${sx + dir * hw},${y + half} L${sx},${y + hh + half} Z`,
          fill: col
        }, g);
        el('line', { x1: sx, y1: y - hh + half, x2: sx, y2: y + hh + half,
                     stroke: col, 'stroke-width': 2 }, g);
        g.appendChild(el('title', {}, null)).textContent =
          `ORF start codon at ${fwd ? item.a + 1 : item.b}, ` +
          `reads ${fwd ? 'rightwards →' : 'leftwards ←'}\n` +
          `${item.a + 1}..${item.b} · ${item.o.length_aa} aa`;
      });
    }

    /* primer track, above the ruler, with the arrow head at the 3' end */
    (opts.primers || []).forEach(pr => {
      const x1 = x(pr.start), x2 = Math.max(x(pr.end), x1 + 3);
      const y = axisY - 26;
      const fwd = pr.strand !== -1;
      const head = Math.min(6, Math.max(2, (x2 - x1) * 0.5));
      const d = fwd
        ? `M${x1},${y} L${x2 - head},${y} L${x2},${y + 3} L${x2 - head},${y + 6} L${x1},${y + 6} Z`
        : `M${x2},${y} L${x1 + head},${y} L${x1},${y + 3} L${x1 + head},${y + 6} L${x2},${y + 6} Z`;
      const p = el('path', { class: 'primerbar', d, fill: '#b7791f' }, svg);
      p.appendChild(el('title', {}, null)).textContent =
        `${pr.name} ${fwd ? '→' : '←'} ${pr.start + 1}..${pr.end}` +
        (pr.tm ? `\nTm ${pr.tm.toFixed(1)} °C` : '');
    });

    /* drag to select */
    let dragging = null;
    svg.addEventListener('mousedown', ev => {
      if (ev.target.closest('.feat')) return;
      const r = svg.getBoundingClientRect();
      dragging = posAt(ev.clientX - r.left);
      ev.preventDefault();
    });
    svg.addEventListener('mousemove', ev => {
      if (dragging === null) return;
      const r = svg.getBoundingClientRect();
      const p = posAt(ev.clientX - r.left);
      opts.onRange && opts.onRange(Math.min(dragging, p), Math.max(dragging, p), false);
    });
    window.addEventListener('mouseup', () => {
      if (dragging !== null) { opts.onRange && opts.onRange(null, null, true); dragging = null; }
    });
    return svg;
  }

  /** Start of the next feature packed into the same lane, or +infinity. */
  function nextStartInLane(feats, packed, lane, after) {
    let best = Infinity;
    for (const it of feats) {
      if ((packed.lane.get(it.key) || 0) !== lane) continue;
      if (it.a >= after && it.a < best) best = it.a;
    }
    return best;
  }

  /* ---------------------------------------------------------------- circular */

  function polar(cx, cy, r, ang) { return [cx + r * Math.cos(ang), cy + r * Math.sin(ang)]; }

  function arcPath(cx, cy, rIn, rOut, a0, a1, headAng) {
    const big = (a1 - a0) % (Math.PI * 2) > Math.PI ? 1 : 0;
    const rMid = (rIn + rOut) / 2;
    const h = headAng || 0;
    const [x0i, y0i] = polar(cx, cy, rIn, a0);
    const [x0o, y0o] = polar(cx, cy, rOut, a0);
    if (h > 0) {
      const aT = a1 - h;
      const [x1o, y1o] = polar(cx, cy, rOut, aT);
      const [xt, yt] = polar(cx, cy, rMid, a1);
      const [x1i, y1i] = polar(cx, cy, rIn, aT);
      return `M${x0o},${y0o} A${rOut},${rOut} 0 ${big} 1 ${x1o},${y1o} L${xt},${yt} L${x1i},${y1i} A${rIn},${rIn} 0 ${big} 0 ${x0i},${y0i} Z`;
    }
    if (h < 0) {
      const aT = a0 - h;
      const [xt, yt] = polar(cx, cy, rMid, a0);
      const [x0o2, y0o2] = polar(cx, cy, rOut, aT);
      const [x1o, y1o] = polar(cx, cy, rOut, a1);
      const [x1i, y1i] = polar(cx, cy, rIn, a1);
      const [x0i2, y0i2] = polar(cx, cy, rIn, aT);
      return `M${xt},${yt} L${x0o2},${y0o2} A${rOut},${rOut} 0 ${big} 1 ${x1o},${y1o} L${x1i},${y1i} A${rIn},${rIn} 0 ${big} 0 ${x0i2},${y0i2} Z`;
    }
    const [x1o, y1o] = polar(cx, cy, rOut, a1);
    const [x1i, y1i] = polar(cx, cy, rIn, a1);
    return `M${x0o},${y0o} A${rOut},${rOut} 0 ${big} 1 ${x1o},${y1o} L${x1i},${y1i} A${rIn},${rIn} 0 ${big} 0 ${x0i},${y0i} Z`;
  }

  function renderCircular(host, data, opts) {
    opts = opts || {};
    host.innerHTML = '';
    host.style.overflow = 'hidden';
    const W = Math.max(host.clientWidth || 300, 240);
    const H = Math.max(host.clientHeight || 240, 220);
    const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` }, host);
    const cx = W / 2, cy = H / 2;
    const L = Math.max(data.seq.length, 1);
    const linear = data.topology !== 'circular';
    const gap = linear ? 0.22 : 0;          // visual break for linear molecules
    const sweep = Math.PI * 2 - gap;
    // Keep the ring proportional to the panel and the labels close to it,
    // instead of flinging leader lines out to the container edges.
    const R = Math.max(46, Math.min(W * 0.40, H / 2 - 42));
    const labelGap = Math.min(96, Math.max(44, W * 0.12));
    const colR = Math.min(W - 6, cx + R + labelGap);
    const colL = Math.max(6, cx - R - labelGap);
    const ang = p => -Math.PI / 2 + gap / 2 + (Math.max(0, Math.min(L, p)) / L) * sweep;

    /* backbone. An SVG arc whose start and end coincide draws nothing, so a
       closed molecule needs a real circle rather than a 0-to-L arc. */
    if (linear) {
      el('path', { d: arcPath(cx, cy, R - 1, R + 1, ang(0), ang(L), 0), fill: '#aab2bd' }, svg);
    } else {
      el('circle', { cx, cy, r: R, fill: 'none', stroke: '#aab2bd', 'stroke-width': 2 }, svg);
    }

    /* ticks */
    const step = niceStep(L, 8);
    for (let p = 0; p < L; p += step) {
      if (!linear && p > 0 && (L - p) / L * sweep < 0.16) continue;  // too close to the origin
      const a = ang(p);
      const [x1, y1] = polar(cx, cy, R + 2, a);
      const [x2, y2] = polar(cx, cy, R + 7, a);
      el('line', { class: 'tick', x1, y1, x2, y2 }, svg);
      const [tx, ty] = polar(cx, cy, R + 15, a);
      const t = el('text', {
        class: 'ticktext', x: tx, y: ty + 3,
        'text-anchor': Math.cos(a) > .25 ? 'start' : Math.cos(a) < -.25 ? 'end' : 'middle'
      }, svg);
      t.textContent = p.toLocaleString();
    }

    /* selection */
    if (opts.selection && opts.selection[1] > opts.selection[0]) {
      const [s, e] = opts.selection;
      el('path', { class: 'selband', d: arcPath(cx, cy, R - 9, R + 9, ang(s), ang(e), 0) }, svg);
    }

    /* features, packed inward */
    const feats = (data.features || []).slice()
      .map(f => { const [a, b] = featSpan(f); return { key: f.id, a, b, f }; })
      .sort((x, y) => x.a - y.a || y.b - x.b);
    const packed = packLanes(feats, Math.ceil(L / 180));
    const laneW = Math.min(13, Math.max(7, (R - 40) / Math.max(packed.count, 1)));
    const labelAnchors = [];

    feats.forEach(item => {
      const f = item.f;
      const lane = packed.lane.get(item.key) || 0;
      const rOut = R - 7 - lane * (laneW + 2.5);
      const rIn = rOut - laneW;
      if (rIn < 16) return;
      const g = el('g', { class: 'feat' + (opts.activeFeature === f.id ? ' sel' : '') }, svg);
      g.dataset.featureId = f.id;
      (f.segments || [[item.a, item.b]]).forEach(([a, b]) => {
        const a0 = ang(a), a1 = ang(Math.max(b, a + Math.max(1, L / 900)));
        const headAng = Math.min((a1 - a0) * .45, 0.07) * (f.strand === -1 ? -1 : 1);
        const p = el('path', {
          class: 'shape', d: arcPath(cx, cy, rIn, rOut, a0, a1, f.strand === 0 ? 0 : headAng),
          fill: f.color, stroke: 'rgba(0,0,0,.18)', 'stroke-width': .6
        }, g);
        p.appendChild(el('title', {}, null)).textContent =
          `${f.label}  ${f.type}\n${item.a + 1}..${item.b} (${item.b - item.a} bp)`;
      });
      g.addEventListener('click', ev => { ev.stopPropagation(); opts.onFeature && opts.onFeature(f); });
      const mid = (ang(item.a) + ang(item.b)) / 2;
      if (item.b - item.a > L / 110) {
        labelAnchors.push({ f, ang: mid, r: rOut, g });
      }
    });

    /* labels: de-overlapped down each side, with leader lines */
    const sides = { l: [], r: [] };
    labelAnchors.forEach(a => {
      const [px, py] = polar(cx, cy, R + 18, a.ang);
      (Math.cos(a.ang) >= 0 ? sides.r : sides.l).push({ ...a, px, py });
    });
    ['l', 'r'].forEach(side => {
      const arr = sides[side].sort((p, q) => p.py - q.py);
      const minGap = 13;
      for (let i = 1; i < arr.length; i++) {
        if (arr[i].py - arr[i - 1].py < minGap) arr[i].py = arr[i - 1].py + minGap;
      }
      const overflow = arr.length ? arr[arr.length - 1].py - (H - 8) : 0;
      if (overflow > 0) arr.forEach(a => { a.py -= overflow; });
      arr.forEach(a => {
        const tx = side === 'r' ? colR : colL;
        const [ax, ay] = polar(cx, cy, a.r + 1, a.ang);
        el('polyline', {
          points: `${ax},${ay} ${a.px},${a.py} ${side === 'r' ? tx - 3 : tx + 3},${a.py}`,
          fill: 'none', stroke: '#c7cdd4', 'stroke-width': .9
        }, svg);
        const t = el('text', {
          class: 'flabel', x: tx, y: a.py + 3,
          'text-anchor': side === 'r' ? 'end' : 'start', fill: '#5b6672'
        }, svg);
        let label = a.f.label || a.f.type;
        const max = Math.floor((side === 'r' ? (W - colR + labelGap) : (colL + labelGap)) / 5.6) + 6;
        if (label.length > max) label = label.slice(0, Math.max(3, max - 1)) + '…';
        t.textContent = label;
        t.style.cursor = 'pointer';
        t.addEventListener('click', ev => { ev.stopPropagation(); opts.onFeature && opts.onFeature(a.f); });
      });
    });

    /* primers as short arcs just outside the ring */
    (opts.primers || []).forEach(pr => {
      const a0 = ang(pr.start), a1 = ang(Math.max(pr.end, pr.start + Math.max(1, L / 900)));
      const headAng = Math.min((a1 - a0) * .45, 0.05) * (pr.strand === -1 ? -1 : 1);
      const p = el('path', {
        class: 'primerbar', d: arcPath(cx, cy, R + 4, R + 9, a0, a1, headAng), fill: '#b7791f'
      }, svg);
      p.appendChild(el('title', {}, null)).textContent =
        `${pr.name} ${pr.strand === -1 ? '←' : '→'} ${pr.start + 1}..${pr.end}`;
    });

    /* restriction cuts outside the ring */
    (opts.cuts || []).slice(0, 40).forEach(c => {
      const a = ang(c.pos);
      const [x1, y1] = polar(cx, cy, R + 2, a);
      const [x2, y2] = polar(cx, cy, R + 10, a);
      el('line', { class: 'cut', x1, y1, x2, y2 }, svg);
    });

    /* centre caption */
    const t1 = el('text', { class: 'title', x: cx, y: cy - 4, 'text-anchor': 'middle' }, svg);
    let nm = data.name || '';
    if (nm.length > 22) nm = nm.slice(0, 21) + '…';
    t1.textContent = nm;
    const t2 = el('text', { class: 'subtitle', x: cx, y: cy + 12, 'text-anchor': 'middle' }, svg);
    t2.textContent = `${L.toLocaleString()} bp · ${linear ? 'linear' : 'circular'}`;
    return svg;
  }

  window.GFMaps = { renderLinear, renderCircular, contrast };
})();
