/* GeneForge front end: live state, maps, and the sequence editor. */
const GF = {
  state: { folder: '', sequences: {}, primers: [], files: [] },
  ui: {
    activeId: null, view: 'linear', showRev: true, showAA: false, showOrfs: false,
    selection: null, dragAnchor: null, activeFeature: null,
    enzymes: ['EcoRI', 'BamHI', 'HindIII', 'XhoI', 'NdeI', 'BsaI', 'BsmBI'],
    tab: 'features', orfs: [], cuts: [], restriction: null, fileFilter: '',
    charW: 7.7, lineH: 0, perLine: 60, metrics: null,
  },
  ws: null,
};

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function api(path, opts) {
  return fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts))
    .then(async r => {
      if (!r.ok) {
        let msg = r.statusText;
        try { const j = await r.json(); msg = j.detail || msg; } catch (e) { }
        throw new Error(msg);
      }
      return r.headers.get('content-type')?.includes('json') ? r.json() : r.text();
    });
}
const post = (p, b) => api(p, { method: 'POST', body: JSON.stringify(b || {}) });
const patch = (p, b) => api(p, { method: 'PATCH', body: JSON.stringify(b || {}) });
const del = p => api(p, { method: 'DELETE' });

let toastTimer;
function toast(msg, ms) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms || 2200);
}
function notice(text, cls) {
  const n = document.createElement('div');
  n.className = 'notice ' + (cls || ''); n.textContent = text;
  $('#notices').appendChild(n);
  setTimeout(() => n.remove(), 5200);
}

const active = () => GF.state.sequences[GF.ui.activeId] || null;

/* ------------------------------------------------------------------ socket */

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  GF.ws = ws;
  ws.onopen = () => $('#conn').classList.remove('offline');
  ws.onclose = () => { $('#conn').classList.add('offline'); setTimeout(connect, 1400); };
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    handle(m);
  };
}

function handle(m) {
  switch (m.type) {
    case 'state':
      GF.state.folder = m.folder;
      GF.state.files = m.files || [];
      GF.state.primers = m.primers || [];
      GF.state.sequences = {};
      (m.sequences || []).forEach(s => GF.state.sequences[s.id] = s);
      $('#folder').textContent = m.folder;
      $('#folder').title = m.folder;
      renderAll();
      break;
    case 'seq.upsert': {
      const s = m.sequence;
      const isNew = !GF.state.sequences[s.id];
      GF.state.sequences[s.id] = s;
      if (m.origin === 'agent' || m.origin === 'disk') {
        notice((m.note || s.name), m.origin === 'agent' ? 'agent' : 'disk');
        if (isNew && m.origin === 'agent') setActive(s.id);
      }
      renderOpenList();
      if (s.id === GF.ui.activeId) refreshActive(m.origin === 'agent');
      break;
    }
    case 'seq.remove':
      delete GF.state.sequences[m.id];
      if (GF.ui.activeId === m.id) {
        const next = Object.keys(GF.state.sequences)[0] || null;
        setActive(next);
      }
      renderOpenList();
      break;
    case 'primers':
      GF.state.primers = m.primers || [];
      renderPrimerList();
      if (GF.ui.tab === 'primers') renderPanel();
      break;
    case 'files':
      GF.state.files = m.files || [];
      renderFileList();
      break;
    case 'notice':
      notice(m.message, m.level === 'error' ? 'error' : '');
      break;
  }
}

/* --------------------------------------------------------------- rendering */

function renderAll() {
  renderOpenList(); renderFileList(); renderPrimerList();
  renderToolbar(); renderMaps(); renderSeqView(); renderPanel(); renderStatus();
}

/** Re-render the active sequence while keeping scroll, selection and panel. */
function refreshActive(flash) {
  const keep = $('#seqscroll').scrollTop;
  renderToolbar(); renderMaps(); renderSeqView(); renderPanel(); renderStatus();
  $('#seqscroll').scrollTop = keep;
  if (flash) { $('#main').classList.add('flash'); setTimeout(() => $('#main').classList.remove('flash'), 1200); }
}

function renderOpenList() {
  const ul = $('#open-list'); ul.innerHTML = '';
  const seqs = Object.values(GF.state.sequences);
  if (!seqs.length) { ul.innerHTML = '<li class="empty" style="cursor:default">nothing open</li>'; return; }
  seqs.forEach(s => {
    const li = document.createElement('li');
    li.className = s.id === GF.ui.activeId ? 'active' : '';
    li.innerHTML = `<span class="topo">${s.topology === 'circular' ? '○' : '—'}</span>
      <span class="nm">${esc(s.name)}</span>
      ${s.dirty ? '<span class="dot-dirty" title="unsaved changes"></span>' : ''}
      <span class="sub">${s.seq.length.toLocaleString()}</span>
      <span class="x" title="Close">×</span>`;
    li.onclick = e => {
      if (e.target.classList.contains('x')) { closeSeq(s); return; }
      setActive(s.id);
    };
    ul.appendChild(li);
  });
}

function closeSeq(s) {
  if (s.dirty && !confirm(`"${s.name}" has unsaved changes. Close anyway?`)) return;
  del('/api/sequences/' + s.id).catch(e => toast(e.message));
}

function renderFileList() {
  const ul = $('#file-list'); ul.innerHTML = '';
  const q = GF.ui.fileFilter.toLowerCase();
  const files = GF.state.files.filter(f => !q || f.rel.toLowerCase().includes(q));
  if (!files.length) {
    ul.innerHTML = `<li class="empty" style="cursor:default">${GF.state.files.length ? 'no match' : 'no sequence files here'}</li>`;
    return;
  }
  files.slice(0, 400).forEach(f => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="nm" title="${esc(f.rel)}">${esc(f.name)}</span>
                    <span class="sub">${(f.size / 1024).toFixed(1)}k</span>`;
    li.onclick = () => openPath(f.path);
    ul.appendChild(li);
  });
}

function openPath(path) {
  post('/api/open', { path }).then(r => {
    if (r.sequences && r.sequences.length) setActive(r.sequences[0].id);
    renderOpenList();
  }).catch(e => toast(e.message, 3600));
}

function renderPrimerList() {
  const ul = $('#primer-list'); ul.innerHTML = '';
  if (!GF.state.primers.length) { ul.innerHTML = '<li class="empty" style="cursor:default">none yet</li>'; return; }
  GF.state.primers.forEach(p => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="nm" title="${esc(p.seq)}">${esc(p.name)}</span>
      <span class="sub">${p.tm ? p.tm.toFixed(1) + '°' : ''} ${p.length}nt</span>
      <span class="x" title="Delete">×</span>`;
    li.onclick = e => {
      if (e.target.classList.contains('x')) { del('/api/primers/' + p.id); return; }
      GF.ui.tab = 'primers'; syncTabs(); renderPanel();
    };
    ul.appendChild(li);
  });
}

function renderToolbar() {
  const s = active();
  $('#seq-name').value = s ? s.name : '';
  $('#seq-name').disabled = !s;
  $('#seq-meta').textContent = s
    ? `${s.seq.length.toLocaleString()} bp · ${s.topology}${s.dirty ? ' · unsaved' : (s.path ? '' : ' · not on disk')}`
    : '';
  $$('#view-toggle button').forEach(b => b.classList.toggle('on', b.dataset.view === GF.ui.view));
  $$('#topology-toggle button').forEach(b => b.classList.toggle('on', s && b.dataset.topo === s.topology));
  const hasSel = !!(GF.ui.selection && GF.ui.selection[1] > GF.ui.selection[0]);
  $('#btn-annotate').disabled = !hasSel;
  $('#btn-copy').disabled = !s;
  $('#btn-save').disabled = !s;
  $('#btn-save').textContent = s && s.dirty ? 'Save •' : 'Save';
}

function renderMaps() {
  const s = active();
  const wrap = $('#mapwrap');
  wrap.className = 'v-' + GF.ui.view;
  // A circle needs vertical room; grow the pane rather than drawing a tiny ring.
  if (GF.ui.view === 'circular' && wrap.clientHeight < 430) wrap.style.height = '430px';
  if (!s) {
    $('#map-linear').innerHTML = `<div class="empty" style="padding-top:60px">
      Drag a GenBank or FASTA file here, or pick one from the folder list.</div>`;
    $('#map-circular').innerHTML = '';
    return;
  }
  const opts = {
    selection: GF.ui.selection, cuts: GF.ui.cuts, orfs: GF.ui.orfs,
    showOrfs: GF.ui.showOrfs, activeFeature: GF.ui.activeFeature,
    onFeature: f => selectFeature(f),
    onRange: (a, b, done) => { if (a !== null) setSelection(a, b); if (done) renderPanel(); },
  };
  if (GF.ui.view !== 'circular') GFMaps.renderLinear($('#map-linear'), s, opts);
  if (GF.ui.view !== 'linear') GFMaps.renderCircular($('#map-circular'), s, opts);
}

/* ------------------------------------------------------- sequence viewer */

const CODON = {};
(function () {
  const bases = 'TCAG';
  const aas = 'FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG';
  let i = 0;
  for (const a of bases) for (const b of bases) for (const c of bases) CODON[a + b + c] = aas[i++];
})();
const COMP = { A: 'T', C: 'G', G: 'C', T: 'A', N: 'N', U: 'A' };
const comp = s => s.replace(/./g, c => COMP[c] || 'N');
const rc = s => comp(s).split('').reverse().join('');

function measure() {
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;font-family:var(--mono);font-size:12.5px;white-space:pre';
  probe.textContent = 'ACGT'.repeat(25);
  document.body.appendChild(probe);
  GF.ui.charW = probe.getBoundingClientRect().width / 100;
  probe.remove();
}

function trackPlan() {
  const rows = [{ k: 'fwd', cls: 't-fwd' }];
  if (GF.ui.showAA) [0, 1, 2].forEach(f => rows.push({ k: 'aa' + f, cls: 't-aa f' + (f + 1), frame: f, strand: 1 }));
  if (GF.ui.showRev) rows.push({ k: 'rev', cls: 't-rev' });
  if (GF.ui.showAA && GF.ui.showRev) [0, 1, 2].forEach(f => rows.push({ k: 'raa' + f, cls: 't-aa', frame: f, strand: -1 }));
  return rows;
}

function layout() {
  const s = active(); if (!s) return null;
  const gutter = 74, rightPad = 26;
  const avail = $('#seqscroll').clientWidth - gutter - rightPad;
  const per = Math.max(20, Math.floor(avail / GF.ui.charW / 10) * 10);
  const rows = trackPlan();
  const rowH = 16, blockPad = 12;
  const lineH = rows.length * rowH + blockPad;
  return { gutter, per, rows, rowH, lineH, nLines: Math.ceil(s.seq.length / per) || 1 };
}

function aaRow(seq, from, to, frame, strand, L) {
  const out = new Array(to - from).fill(' ');
  if (strand === 1) {
    let p = frame + Math.ceil((from - frame) / 3) * 3;
    for (; p + 3 <= L; p += 3) {
      const centre = p + 1;
      if (centre >= to) break;
      if (centre >= from) out[centre - from] = CODON[seq.substr(p, 3)] || 'X';
    }
  } else {
    for (let k = frame; k + 3 <= L; k += 3) {
      const fStart = L - k - 3, centre = fStart + 1;
      if (centre < from) break;
      if (centre < to) {
        const codon = rc(seq.substr(fStart, 3));
        out[centre - from] = CODON[codon] || 'X';
      }
    }
  }
  return out.join('');
}

function renderSeqView() {
  const s = active();
  const inner = $('#seqinner');
  if (!s) { inner.innerHTML = ''; inner.style.height = '0px'; return; }
  const lay = layout(); GF.ui.metrics = lay;
  inner.style.height = (lay.nLines * lay.lineH + 20) + 'px';
  drawLines();
}

function drawLines() {
  const s = active(); const lay = GF.ui.metrics; if (!s || !lay) return;
  const scroll = $('#seqscroll'), inner = $('#seqinner');
  const top = scroll.scrollTop, h = scroll.clientHeight;
  const first = Math.max(0, Math.floor(top / lay.lineH) - 3);
  const last = Math.min(lay.nLines, Math.ceil((top + h) / lay.lineH) + 3);
  const L = s.seq.length;
  const frag = document.createDocumentFragment();

  for (let i = first; i < last; i++) {
    const from = i * lay.per, to = Math.min(L, from + lay.per);
    if (from >= L) break;
    const line = document.createElement('div');
    line.className = 'line';
    line.style.top = (i * lay.lineH) + 'px';
    line.style.height = lay.lineH + 'px';

    const num = document.createElement('div');
    num.className = 'ln-num'; num.style.top = '0px';
    num.textContent = (from + 1).toLocaleString();
    line.appendChild(num);

    const fwd = s.seq.slice(from, to);
    lay.rows.forEach((r, ri) => {
      const d = document.createElement('div');
      d.className = 'ln-track ' + r.cls;
      d.style.top = (ri * lay.rowH) + 'px';
      if (r.k === 'fwd') d.textContent = fwd;
      else if (r.k === 'rev') d.textContent = comp(fwd);
      else d.textContent = aaRow(s.seq, from, to, r.frame, r.strand, L);
      line.appendChild(d);
    });

    const ov = document.createElement('div');
    ov.className = 'ln-ov';
    ov.style.width = (lay.per * GF.ui.charW) + 'px';
    paintOverlay(ov, from, to, lay);
    line.appendChild(ov);
    frag.appendChild(line);
  }
  inner.innerHTML = '';
  inner.appendChild(frag);
}

function paintOverlay(ov, from, to, lay) {
  const s = active();
  const x = p => (p - from) * GF.ui.charW;
  const fwdTop = 0, fwdH = lay.rowH;

  /* features: tint behind the bases plus a solid underline */
  let lane = 0;
  (s.features || []).forEach(f => {
    (f.segments || []).forEach(([a, b]) => {
      if (b <= from || a >= to) return;
      const a2 = Math.max(a, from), b2 = Math.min(b, to);
      const tint = document.createElement('div');
      tint.className = 'ov-feat';
      tint.style.cssText = `left:${x(a2)}px;width:${(b2 - a2) * GF.ui.charW}px;top:${fwdTop}px;height:${fwdH}px;background:${f.color}`;
      ov.appendChild(tint);
      const bar = document.createElement('div');
      bar.className = 'ov-featline';
      bar.style.cssText = `left:${x(a2)}px;width:${(b2 - a2) * GF.ui.charW}px;top:${fwdTop + fwdH - 2}px;background:${f.color}`;
      ov.appendChild(bar);
    });
  });

  /* ORFs */
  if (GF.ui.showOrfs) {
    GF.ui.orfs.slice(0, 60).forEach(o => {
      if (o.end <= from || o.start >= to) return;
      const a2 = Math.max(o.start, from), b2 = Math.min(o.end, to);
      const d = document.createElement('div');
      d.className = 'ov-orf';
      d.style.cssText = `left:${x(a2)}px;width:${(b2 - a2) * GF.ui.charW}px;top:${lay.rows.length * lay.rowH + 1}px;background:${o.strand === 1 ? '#2f855a' : '#9c4221'}`;
      ov.appendChild(d);
    });
  }

  /* restriction cuts */
  GF.ui.cuts.forEach(c => {
    if (c.pos < from || c.pos >= to) return;
    const d = document.createElement('div');
    d.className = 'ov-cut';
    d.style.cssText = `left:${x(c.pos)}px;top:0;height:${lay.rows.length * lay.rowH}px`;
    ov.appendChild(d);
    const t = document.createElement('div');
    t.className = 'ov-cutlabel';
    t.style.cssText = `left:${x(c.pos) + 2}px;top:${-1}px`;
    t.textContent = c.label;
    ov.appendChild(t);
  });

  /* selection */
  const sel = GF.ui.selection;
  if (sel && sel[1] > sel[0] && sel[1] > from && sel[0] < to) {
    const a2 = Math.max(sel[0], from), b2 = Math.min(sel[1], to);
    const d = document.createElement('div');
    d.className = 'ov-sel';
    d.style.cssText = `left:${x(a2)}px;width:${Math.max(1, (b2 - a2) * GF.ui.charW)}px;top:0;height:${lay.rows.length * lay.rowH}px`;
    ov.appendChild(d);
  }
}

function baseAt(ev) {
  const lay = GF.ui.metrics, s = active();
  if (!lay || !s) return null;
  const r = $('#seqinner').getBoundingClientRect();
  const y = ev.clientY - r.top, x = ev.clientX - r.left - lay.gutter;
  const line = Math.floor(y / lay.lineH);
  if (line < 0) return 0;
  const col = Math.max(0, Math.min(lay.per, Math.round(x / GF.ui.charW)));
  return Math.max(0, Math.min(s.seq.length, line * lay.per + col));
}

function setSelection(a, b) {
  GF.ui.selection = (a === null || b === null || b <= a) ? null : [a, b];
  GF.ui.activeFeature = null;
  renderToolbar(); renderStatus(); drawLines();
  if (GF.ui.view !== 'circular') GFMaps.renderLinear($('#map-linear'), active(), mapOpts());
  if (GF.ui.view !== 'linear') GFMaps.renderCircular($('#map-circular'), active(), mapOpts());
}

function mapOpts() {
  return {
    selection: GF.ui.selection, cuts: GF.ui.cuts, orfs: GF.ui.orfs,
    showOrfs: GF.ui.showOrfs, activeFeature: GF.ui.activeFeature,
    onFeature: f => selectFeature(f),
    onRange: (a, b, done) => { if (a !== null) setSelection(a, b); if (done) renderPanel(); },
  };
}

function selectFeature(f) {
  const [a] = f.segments[0], b = f.segments[f.segments.length - 1][1];
  GF.ui.selection = [a, b];
  GF.ui.activeFeature = f.id;
  GF.ui.tab = 'features'; syncTabs();
  renderToolbar(); renderStatus(); drawLines(); renderPanel();
  if (GF.ui.view !== 'circular') GFMaps.renderLinear($('#map-linear'), active(), mapOpts());
  if (GF.ui.view !== 'linear') GFMaps.renderCircular($('#map-circular'), active(), mapOpts());
  scrollToBase(a);
}

function scrollToBase(p) {
  const lay = GF.ui.metrics; if (!lay) return;
  const line = Math.floor(p / lay.per);
  $('#seqscroll').scrollTop = Math.max(0, line * lay.lineH - 60);
}

function renderStatus() {
  const s = active();
  if (!s) { $('#sel-info').textContent = 'no sequence open'; $('#hover-info').textContent = ''; return; }
  const sel = GF.ui.selection;
  if (!sel) { $('#sel-info').textContent = `${s.seq.length.toLocaleString()} bp · no selection`; }
  else {
    const sub = s.seq.slice(sel[0], sel[1]);
    const gc = sub ? (100 * (sub.match(/[GC]/g) || []).length / sub.length) : 0;
    $('#sel-info').textContent =
      `${(sel[0] + 1).toLocaleString()}–${sel[1].toLocaleString()} · ${sub.length.toLocaleString()} bp · GC ${gc.toFixed(1)}%` +
      (sub.length % 3 === 0 ? ` · ${sub.length / 3} codons` : '');
  }
  const f = GF.ui.activeFeature && (s.features || []).find(x => x.id === GF.ui.activeFeature);
  $('#hover-info').textContent = f ? `${f.label} (${f.type})` : '';
}

/* ------------------------------------------------------------------ wiring */

function setActive(id) {
  GF.ui.activeId = id;
  GF.ui.selection = null; GF.ui.activeFeature = null;
  GF.ui.orfs = []; GF.ui.cuts = []; GF.ui.restriction = null;
  renderOpenList(); renderToolbar(); renderMaps(); renderSeqView(); renderPanel(); renderStatus();
  if (id && GF.ui.showOrfs) loadOrfs();
  if (id && GF.ui.enzymes.length) loadRestriction();
}

function loadOrfs() {
  const s = active(); if (!s) return Promise.resolve();
  return api(`/api/sequences/${s.id}/orfs?min_aa=30&starts=ATG`)
    .then(r => { GF.ui.orfs = r.orfs || []; renderMaps(); drawLines(); if (GF.ui.tab === 'tools') renderPanel(); });
}

function loadRestriction() {
  const s = active(); if (!s) return Promise.resolve();
  return post(`/api/sequences/${s.id}/restriction`, { enzymes: GF.ui.enzymes })
    .then(r => {
      GF.ui.restriction = r;
      GF.ui.cuts = [];
      (r.enzymes || []).forEach(e => e.sites.forEach(st => {
        if (st.cut_in_range) GF.ui.cuts.push({ pos: st.cut, label: e.name });
      }));
      renderMaps(); drawLines();
      if (GF.ui.tab === 'enzymes') renderPanel();
    });
}

function wire() {
  measure();
  connect();

  $('#seq-name').onchange = e => {
    const s = active(); if (!s) return;
    patch('/api/sequences/' + s.id, { name: e.target.value }).catch(err => toast(err.message));
  };
  $$('#view-toggle button').forEach(b => b.onclick = () => {
    GF.ui.view = b.dataset.view; renderToolbar(); renderMaps();
  });
  $$('#topology-toggle button').forEach(b => b.onclick = () => {
    const s = active(); if (!s) return;
    patch('/api/sequences/' + s.id, { topology: b.dataset.topo }).catch(e => toast(e.message));
  });
  $('#show-rev').onchange = e => { GF.ui.showRev = e.target.checked; renderSeqView(); };
  $('#show-aa').onchange = e => { GF.ui.showAA = e.target.checked; renderSeqView(); };
  $('#show-orfs').onchange = e => {
    GF.ui.showOrfs = e.target.checked;
    if (GF.ui.showOrfs && !GF.ui.orfs.length) loadOrfs(); else { renderMaps(); drawLines(); }
  };
  $('#file-filter').oninput = e => { GF.ui.fileFilter = e.target.value; renderFileList(); };
  $('#btn-save').onclick = saveActive;
  $('#btn-new').onclick = () => GFPanels.newSequenceDialog();
  $('#btn-newprimer').onclick = () => GFPanels.newPrimerDialog();
  $('#btn-annotate').onclick = () => GFPanels.annotateDialog();
  $('#btn-copy').onclick = e => { e.stopPropagation(); GFPanels.copyMenu(); };
  document.addEventListener('click', () => $('#copy-menu').classList.remove('open'));

  $$('#tabs button').forEach(b => b.onclick = () => {
    GF.ui.tab = b.dataset.tab; syncTabs(); renderPanel();
  });

  /* selection by dragging across the bases */
  const scroll = $('#seqscroll');
  scroll.addEventListener('mousedown', ev => {
    if (ev.button !== 0) return;
    const p = baseAt(ev); if (p === null) return;
    GF.ui.dragAnchor = p; setSelection(p, p); ev.preventDefault();
  });
  scroll.addEventListener('mousemove', ev => {
    if (GF.ui.dragAnchor === null) return;
    const p = baseAt(ev); if (p === null) return;
    setSelection(Math.min(GF.ui.dragAnchor, p), Math.max(GF.ui.dragAnchor, p));
  });
  window.addEventListener('mouseup', () => {
    if (GF.ui.dragAnchor !== null) { GF.ui.dragAnchor = null; renderPanel(); }
  });
  scroll.addEventListener('scroll', () => drawLines(), { passive: true });

  /* drag & drop files */
  ['dragover', 'drop'].forEach(t => document.addEventListener(t, e => e.preventDefault()));
  document.addEventListener('drop', async ev => {
    const files = Array.from(ev.dataTransfer?.files || []);
    for (const f of files) {
      try {
        const text = await f.text();
        const r = await post('/api/import', { filename: f.name, text });
        if (r.sequences?.length) setActive(r.sequences[0].id);
        toast(`opened ${f.name}`);
      } catch (e) { toast(`${f.name}: ${e.message}`, 4000); }
    }
  });

  /* keyboard */
  document.addEventListener('keydown', ev => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(ev.target.tagName);
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 's') { ev.preventDefault(); saveActive(); return; }
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'a' && !typing) {
      const s = active(); if (s) { ev.preventDefault(); setSelection(0, s.seq.length); }
      return;
    }
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'c' && !typing && GF.ui.selection) {
      const s = active();
      navigator.clipboard.writeText(s.seq.slice(GF.ui.selection[0], GF.ui.selection[1]));
      toast('copied DNA'); return;
    }
    if (ev.key === 'Escape') { setSelection(null, null); renderPanel(); }
  });

  let rt;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { measure(); renderMaps(); renderSeqView(); }, 140);
  });

  /* draggable splitter between map and sequence */
  let dragSplit = false;
  $('#splitter').addEventListener('mousedown', () => { dragSplit = true; document.body.style.cursor = 'ns-resize'; });
  window.addEventListener('mousemove', ev => {
    if (!dragSplit) return;
    const top = $('#mapwrap').getBoundingClientRect().top;
    $('#mapwrap').style.height = Math.max(90, Math.min(600, ev.clientY - top)) + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (dragSplit) { dragSplit = false; document.body.style.cursor = ''; renderMaps(); renderSeqView(); }
  });
}

function syncTabs() {
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === GF.ui.tab));
}

function saveActive() {
  const s = active(); if (!s) return;
  if (s.path) {
    if (!confirm(`Overwrite this file?\n\n${s.path}`)) return;
    post(`/api/sequences/${s.id}/save`, {}).then(r => toast('saved ' + r.path.split('/').pop()))
      .catch(e => toast(e.message, 4000));
  } else {
    GFPanels.saveAsDialog(s);
  }
}

function renderPanel() { GFPanels.render(); }

function translateJS(nt) {
  const s = (nt || '').toUpperCase().replace(/[^ACGTU]/g, 'N').replace(/U/g, 'T');
  let out = '';
  for (let i = 0; i + 3 <= s.length; i += 3) {
    const aa = CODON[s.substr(i, 3)] || 'X';
    if (aa === '*') break;
    out += aa;
  }
  return out;
}

Object.assign(GF, {
  api, post, patch, del, toast, notice,
  setActive, selectFeature, loadOrfs, loadRestriction, syncTabs,
  renderAll, refreshActive, renderOpenList, renderToolbar, renderMaps,
  renderSeqView, renderStatus, drawLines, setSelection, scrollToBase,
  mapOpts, saveActive, openPath, translateJS, rc, comp, active,
});

document.addEventListener('DOMContentLoaded', wire);
