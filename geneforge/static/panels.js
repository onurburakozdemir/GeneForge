/* GeneForge right-hand panels, dialogs and the structure viewer. */
(function () {
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const act = () => GF.state.sequences[GF.ui.activeId] || null;
  const sel = () => GF.ui.selection;
  let CAPS = null;
  let viewer = null;

  fetch('/api/capabilities').then(r => r.json()).then(c => {
    CAPS = c;
    if (GF.ui.tab === 'tools' || GF.ui.tab === '3d') render();
  }).catch(() => { CAPS = {}; });

  function modal(title, html, onOk, okLabel) {
    const back = $('#modal-back'), box = $('#modal');
    box.innerHTML = `<h2>${esc(title)}</h2>${html}
      <div class="mactions">
        <button class="btn" data-x="cancel">Cancel</button>
        ${onOk ? `<button class="btn primary" data-x="ok">${esc(okLabel || 'OK')}</button>` : ''}
      </div>`;
    back.classList.remove('hidden');
    const close = () => { back.classList.add('hidden'); box.innerHTML = ''; };
    box.querySelector('[data-x=cancel]').onclick = close;
    const ok = box.querySelector('[data-x=ok]');
    if (ok) ok.onclick = () => { if (onOk(box) !== false) close(); };
    back.onclick = e => { if (e.target === back) close(); };
    const first = box.querySelector('input,select,textarea');
    if (first) setTimeout(() => first.focus(), 30);
    return { close, box };
  }
  const val = (box, n) => (box.querySelector('[name=' + n + ']') || {}).value;

  function render() {
    const p = $('#panel'), s = act();
    if (!s && GF.ui.tab !== '3d') {
      p.innerHTML = '<div class="empty">Open a sequence to see this panel.</div>';
      return;
    }
    ({ features: featuresPanel, enzymes: enzymesPanel, primers: primersPanel,
       tools: toolsPanel, '3d': structurePanel }[GF.ui.tab] || featuresPanel)(p, s);
  }

  /* ---------------------------------------------------------- features */

  function featuresPanel(p, s) {
    const feats = s.features || [];
    const r = sel(), hasSel = r && r[1] > r[0];
    p.innerHTML = `
      <div class="ptitle">Molecule</div>
      <div class="field"><label>Topology</label><select name="topo">
        <option value="linear" ${s.topology !== 'circular' ? 'selected' : ''}>linear</option>
        <option value="circular" ${s.topology === 'circular' ? 'selected' : ''}>circular</option>
      </select></div>
      <div class="ptitle">Selection</div>
      ${hasSel
        ? `<div class="hint">${(r[0] + 1).toLocaleString()}–${r[1].toLocaleString()} · ${(r[1] - r[0]).toLocaleString()} bp</div>
           <button class="btn" data-a="annotate" style="width:100%;margin:5px 0">Annotate selection</button>`
        : '<div class="hint">Drag across the sequence or the map to select. Right-click for copy, translate and annotate.</div>'}
      <div class="ptitle">Features (${feats.length})</div><div id="featlist"></div>`;
    p.querySelector('[name=topo]').onchange = e =>
      GF.patch('/api/sequences/' + s.id, { topology: e.target.value })
        .catch(err => GF.toast(err.message));
    const list = p.querySelector('#featlist');
    if (!feats.length) list.innerHTML = '<div class="empty">none</div>';
    feats.forEach(f => {
      const a = f.segments[0][0], b = f.segments[f.segments.length - 1][1];
      const row = document.createElement('div');
      row.className = 'row' + (GF.ui.activeFeature === f.id ? ' active' : '');
      row.innerHTML = `<span class="swatch" style="background:${esc(f.color)}"></span>
        <span class="nm" title="${esc(f.type)}">${esc(f.label)}</span>
        <span class="co">${(a + 1).toLocaleString()}–${b.toLocaleString()}${f.strand === -1 ? ' ←' : f.strand === 1 ? ' →' : ''}</span>
        <span class="x" title="Delete this annotation">×</span>`;
      row.onclick = ev => {
        if (ev.target.classList.contains('x')) { GF.deleteFeature(s, f); return; }
        GF.selectFeature(f);
      };
      row.ondblclick = () => editFeature(s, f);
      row.oncontextmenu = ev => {
        ev.preventDefault(); ev.stopPropagation();
        GF.showCtx(ev, [{ header: `${f.label} (${f.type})` },
          { label: 'Select', run: () => GF.selectFeature(f) },
          { label: 'Edit…', run: () => editFeature(s, f) },
          { label: 'Delete annotation', danger: true, run: () => GF.deleteFeature(s, f) }]);
      };
      list.appendChild(row);
    });
    const ann = p.querySelector('[data-a=annotate]');
    if (ann) ann.onclick = annotateDialog;
  }

  function featureForm(f) {
    const types = ['misc_feature', 'CDS', 'gene', 'promoter', 'terminator', 'RBS',
      'primer_bind', 'protein_bind', 'rep_origin', 'regulatory', 'variation', 'repeat_region'];
    return `<div class="field"><label>Label</label><input name="label" value="${esc(f && f.label || '')}"></div>
      <div class="frow">
        <div class="field"><label>Type</label><select name="type">
          ${types.map(t => `<option ${f && f.type === t ? 'selected' : ''}>${t}</option>`).join('')}
        </select></div>
        <div class="field"><label>Strand</label><select name="strand">
          <option value="1" ${!f || (f.strand !== -1 && f.strand !== 0) ? 'selected' : ''}>forward →</option>
          <option value="-1" ${f && f.strand === -1 ? 'selected' : ''}>reverse ←</option>
          <option value="0" ${f && f.strand === 0 ? 'selected' : ''}>none</option>
        </select></div></div>
      <div class="frow">
        <div class="field"><label>Start (1-based)</label><input name="start" type="number" value="${f ? f.segments[0][0] + 1 : ''}"></div>
        <div class="field"><label>End</label><input name="end" type="number" value="${f ? f.segments[f.segments.length - 1][1] : ''}"></div></div>
      <div class="field"><label>Colour</label><input name="color" type="color" value="${esc(f && f.color || '#75c6a9')}" style="height:30px;padding:2px"></div>
      <div class="field"><label>Note</label><input name="note" value="${esc(f && f.qualifiers && f.qualifiers.note || '')}"></div>`;
  }

  function annotateDialog() {
    const s = act(); if (!s) return;
    const r = sel();
    if (!r || r[1] <= r[0]) return GF.toast('select a region first');
    modal('New annotation', featureForm({ segments: [[r[0], r[1]]], strand: 1, color: '#75c6a9', type: 'misc_feature' }), box => {
      const a = parseInt(val(box, 'start'), 10) - 1, b = parseInt(val(box, 'end'), 10);
      if (!(b > a)) { GF.toast('end must be after start'); return false; }
      GF.post(`/api/sequences/${s.id}/features`, {
        label: val(box, 'label') || 'feature', type: val(box, 'type'),
        strand: parseInt(val(box, 'strand'), 10), color: val(box, 'color'),
        segments: [[a, b]], qualifiers: val(box, 'note') ? { note: val(box, 'note') } : {},
      }).then(() => GF.toast('annotation added')).catch(e => GF.toast(e.message, 4000));
    }, 'Add');
  }

  function editFeature(s, f) {
    const m = modal('Edit feature', featureForm(f), box => {
      const a = parseInt(val(box, 'start'), 10) - 1, b = parseInt(val(box, 'end'), 10);
      if (!(b > a)) { GF.toast('end must be after start'); return false; }
      GF.patch(`/api/sequences/${s.id}/features/${f.id}`, {
        label: val(box, 'label'), type: val(box, 'type'),
        strand: parseInt(val(box, 'strand'), 10), color: val(box, 'color'),
        segments: [[a, b]],
        qualifiers: Object.assign({}, f.qualifiers, val(box, 'note') ? { note: val(box, 'note') } : {}),
      }).catch(e => GF.toast(e.message, 4000));
    }, 'Save');
    const d = document.createElement('button');
    d.className = 'btn'; d.textContent = 'Delete';
    d.style.cssText = 'margin-right:auto;color:#c53030';
    d.onclick = () => {
      if (!confirm('Delete "' + f.label + '"?')) return;
      GF.del(`/api/sequences/${s.id}/features/${f.id}`).then(m.close).catch(e => GF.toast(e.message));
    };
    m.box.querySelector('.mactions').prepend(d);
  }

  /* ----------------------------------------------------------- enzymes */

  const COMMON = ['EcoRI', 'BamHI', 'HindIII', 'XhoI', 'NotI', 'NcoI', 'NdeI', 'XbaI', 'SalI',
    'PstI', 'SpeI', 'KpnI', 'SacI', 'SmaI', 'AscI', 'AgeI', 'BglII', 'ClaI', 'EcoRV', 'MluI',
    'NheI', 'PacI', 'SphI', 'StuI', 'AvrII', 'BsaI', 'BsmBI', 'BbsI', 'SapI', 'PmeI', 'DpnI'];

  function enzymesPanel(p, s) {
    const r = GF.ui.restriction;
    const shown = GF.ui.showCuts;
    p.innerHTML = `<div class="ptitle">Cutting enzymes</div>
      <div class="field"><input name="enzq" list="enzopts" placeholder="add an enzyme, then press Enter…">
        <datalist id="enzopts">${COMMON.map(n => `<option>${n}</option>`).join('')}</datalist></div>
      <div id="chips" style="display:flex;flex-wrap:wrap;gap:4px;margin:4px 2px 8px"></div>
      <div class="frow" style="margin:0 2px 6px">
        <button class="btn ${shown ? 'primary' : ''}" data-a="toggle">
          ${shown ? 'Hide cut sites' : 'Show cut sites'}</button>
        <button class="btn" data-a="clear">Remove all</button></div>
      <div class="frow" style="margin:0 2px 8px">
        <button class="btn" data-a="common">Common set</button>
        <button class="btn" data-a="unique">Unique only</button></div>
      <div id="enzresult"></div>`;
    const chips = p.querySelector('#chips');
    if (!GF.ui.enzymes.length) {
      chips.innerHTML = '<span class="hint">none yet — add one above</span>';
    }
    GF.ui.enzymes.forEach(n => {
      const c = document.createElement('span');
      c.className = 'tag';
      c.textContent = n;
      const x = document.createElement('span');
      x.className = 'chipx'; x.textContent = '×';
      x.title = `remove ${n}`;
      x.style.cursor = 'pointer';
      x.onclick = () => {
        GF.ui.enzymes = GF.ui.enzymes.filter(v => v !== n);
        GF.loadRestriction().then(render);
      };
      c.appendChild(x);
      chips.appendChild(c);
    });
    const q = p.querySelector('[name=enzq]');
    const add = () => {
      const n = q.value.trim();
      if (!n) return;
      if (GF.ui.enzymes.some(v => v.toLowerCase() === n.toLowerCase())) {
        GF.toast(`${n} is already in the list`); q.value = ''; return;
      }
      GF.ui.enzymes.push(n); q.value = '';
      GF.loadRestriction().then(render);
    };
    q.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
    p.querySelector('[data-a=toggle]').onclick = () => {
      GF.ui.showCuts = !GF.ui.showCuts;
      const box = document.querySelector('#show-cuts');
      if (box) box.checked = GF.ui.showCuts;
      GF.renderMaps(); GF.drawLines(); render();
    };
    p.querySelector('[data-a=clear]').onclick = () => {
      GF.ui.enzymes = []; GF.ui.cuts = []; GF.ui.restriction = null;
      GF.renderMaps(); GF.drawLines(); render();
    };
    p.querySelector('[data-a=common]').onclick = () => { GF.ui.enzymes = COMMON.slice(); GF.loadRestriction().then(render); };
    p.querySelector('[data-a=unique]').onclick = () => {
      if (!r) return; GF.ui.enzymes = r.unique.slice(); GF.loadRestriction().then(render);
    };
    const out = p.querySelector('#enzresult');
    if (!GF.ui.enzymes.length) { out.innerHTML = '<div class="empty">no enzymes chosen</div>'; return; }
    if (!r) { out.innerHTML = '<div class="empty">analysing…</div>'; return; }
    const cut = r.enzymes || [];
    out.innerHTML = `<div class="ptitle">Sites</div>
      ${cut.length ? `<table class="t"><tr><th>Enzyme</th><th>n</th><th>Cut · overhang</th></tr>
        ${cut.map(e => `<tr title="${esc(e.pattern)}">
          <td><b>${esc(e.name)}</b><div class="mono" style="color:#8a94a0">${esc(e.site)}</div></td>
          <td>${e.count}${e.cuts !== e.count ? ` <span class="tag warn" title="cut falls outside this fragment">${e.cuts}</span>` : ''}</td>
          <td class="mono">${e.sites.slice(0, 6).map(x => (x.cut + 1).toLocaleString() +
            (x.overhang ? ` <span style="color:#8a94a0">${esc(x.overhang)}</span>` : '')).join('<br>')}</td>
        </tr>`).join('')}</table>` : '<div class="empty">no sites</div>'}
      ${(r.non_cutters || []).length ? `<div class="hint">Non-cutters: ${r.non_cutters.slice(0, 18).join(', ')}</div>` : ''}
      <div class="ptitle">Fragments (${(r.fragments || []).length})</div>
      <table class="t"><tr><th>Size</th><th>From</th><th>To</th></tr>
        ${(r.fragments || []).slice(0, 25).map(f => `<tr><td><b>${f.length.toLocaleString()}</b></td>
          <td class="mono">${(f.start + 1).toLocaleString()}</td>
          <td class="mono">${f.end.toLocaleString()}${f.wraps ? ' ↩' : ''}</td></tr>`).join('')}</table>`;
  }

  window.GFPanels = { render, annotateDialog, featuresPanel, enzymesPanel, editFeature };
  window.__GFP = { modal, val, esc, act, sel, render, get CAPS() { return CAPS; },
                   setCaps(c) { CAPS = c; },
                   set viewer(v) { viewer = v; }, get viewer() { return viewer; } };
})();

/* ---- primers and tools ---- */
(function () {
  const H = window.__GFP, $ = s => document.querySelector(s);
  const { modal, val, esc, act, sel } = H;

  function primersPanel(p, s) {
    const r = sel();
    p.innerHTML = `<div class="ptitle">Design</div>
      ${r && r[1] > r[0]
        ? `<div class="hint">Amplify ${(r[0] + 1).toLocaleString()}–${r[1].toLocaleString()} (${(r[1] - r[0]).toLocaleString()} bp)</div>
           <button class="btn primary" data-a="design" style="width:100%;margin:5px 0">Design primers (primer3)</button>`
        : '<div class="hint">Select the region you want to amplify.</div>'}
      <div id="pairs"></div>
      <div class="ptitle">Saved primers (${GF.state.primers.length})</div><div id="plist"></div>`;
    const list = p.querySelector('#plist');
    if (!GF.state.primers.length) list.innerHTML = '<div class="empty">none</div>';
    GF.state.primers.forEach(pr => {
      const row = document.createElement('div');
      row.className = 'row'; row.title = pr.seq;
      row.innerHTML = `<span class="nm">${esc(pr.name)}</span>
        <span class="co">${pr.length} nt · ${pr.tm ? pr.tm.toFixed(1) + '°C' : '–'} · ${pr.gc}% GC</span>`;
      row.onclick = () => { navigator.clipboard.writeText(pr.seq); GF.toast('copied ' + pr.name); };
      list.appendChild(row);
    });
    const btn = p.querySelector('[data-a=design]');
    if (!btn) return;
    btn.onclick = () => {
      btn.disabled = true; btn.textContent = 'designing…';
      GF.post(`/api/sequences/${s.id}/primers/design`, { start: r[0], end: r[1], n_return: 5 })
        .then(res => {
          btn.disabled = false; btn.textContent = 'Design primers (primer3)';
          const box = p.querySelector('#pairs');
          if (res.error) { box.innerHTML = `<div class="hint" style="color:#c53030">${esc(res.error)}</div>`; return; }
          if (!res.pairs.length) { box.innerHTML = '<div class="empty">no acceptable pairs</div>'; return; }
          box.innerHTML = '<div class="ptitle">Candidates</div>' + res.pairs.map((x, i) => `
            <div style="border:1px solid var(--line);border-radius:6px;padding:7px;margin:6px 2px;font-size:11px">
              <div style="display:flex;justify-content:space-between"><b>Pair ${i + 1}</b><span class="tag">${x.product_size} bp</span></div>
              <div class="mono" style="margin-top:4px">F ${esc(x.left.seq)}</div>
              <div style="color:#5b6672">Tm ${x.left.tm}°C · ${x.left.gc}% GC · pos ${x.left.start + 1}</div>
              <div class="mono" style="margin-top:3px">R ${esc(x.right.seq)}</div>
              <div style="color:#5b6672">Tm ${x.right.tm}°C · ${x.right.gc}% GC · pos ${x.right.start + 1}</div>
              <button class="btn" data-pair="${i}" style="width:100%;margin-top:5px">Save pair &amp; annotate</button>
            </div>`).join('');
          box.querySelectorAll('[data-pair]').forEach(b => b.onclick = () => {
            const x = res.pairs[+b.dataset.pair], base = (s.name || 'amp').replace(/\s+/g, '_');
            Promise.all([
              GF.post('/api/primers', { name: `${base}_F${+b.dataset.pair + 1}`, seq: x.left.seq, attach_to: s.id }),
              GF.post('/api/primers', { name: `${base}_R${+b.dataset.pair + 1}`, seq: x.right.seq, attach_to: s.id }),
            ]).then(() => GF.toast('primers saved and annotated')).catch(e => GF.toast(e.message, 4000));
          });
        }).catch(e => { btn.disabled = false; btn.textContent = 'Design primers (primer3)'; GF.toast(e.message, 4000); });
    };
  }

  function toolsPanel(p, s) {
    const r = sel(), hasSel = r && r[1] > r[0], cap = H.CAPS || {};
    const warn = (ok, what) => ok ? '' : `<div class="hint" style="color:#c05621">${what} not installed</div>`;
    p.innerHTML = `
      <div class="ptitle">Open reading frames</div>
      <div class="frow" style="margin:0 2px">
        <button class="btn" data-a="orfs">Find ORFs</button>
        <button class="btn" data-a="orfcds">Longest → CDS</button></div>
      <div id="orfout"></div>

      <div class="ptitle">Secondary structure</div>
      ${warn(cap.fold_nucleic, 'ViennaRNA')}
      <div class="frow" style="margin:0 2px">
        <button class="btn" data-a="fold" ${cap.fold_nucleic ? '' : 'disabled'}>Fold ${hasSel ? 'selection' : 'all'}</button>
        <button class="btn" data-a="rbs" ${cap.fold_nucleic ? '' : 'disabled'}>RBS check</button></div>
      <div id="foldout"></div>

      <div class="ptitle">Alignment${cap.msa_engine ? ' · ' + esc(cap.msa_engine) : ''}</div>
      ${warn(cap.msa, 'FAMSA / MUSCLE')}
      <button class="btn" data-a="align" style="width:100%;margin:2px" ${cap.msa ? '' : 'disabled'}>Align sequences…</button>
      <div id="alignout"></div>

      <div class="ptitle">Mutagenesis</div>
      <button class="btn" data-a="mutate" style="width:100%;margin:2px">Make protein variant…</button>

      <div class="ptitle">Structure prediction</div>
      <div class="hint">Prediction and 3D live in the <b>Structure &amp; protein</b> tab,
        next to DNA at the top of this pane.</div>
      <button class="btn" data-a="go3d" style="width:100%;margin:2px">Open Structure &amp; protein</button>
      ${cap.specs && cap.specs.ram_gb ? `<div class="hint">This machine: ${cap.specs.ram_gb} GB RAM · ${cap.specs.cpus} cores${cap.specs.chip ? ' · ' + esc(cap.specs.chip) : ''}</div>` : ''}

      <div class="ptitle">Assembly</div>
      <div class="frow" style="margin:0 2px">
        <button class="btn" data-a="gg">Golden Gate…</button>
        <button class="btn" data-a="gib">Gibson…</button></div>`;

    p.querySelector('[data-a=orfs]').onclick = () => {
      GF.ui.showOrfs = true; $('#show-orfs').checked = true;
      GF.loadOrfs().then(() => {
        const o = GF.ui.orfs;
        p.querySelector('#orfout').innerHTML = o.length
          ? `<table class="t"><tr><th>Position</th><th></th><th>aa</th></tr>${o.slice(0, 15).map(x =>
              `<tr><td class="mono">${(x.start + 1).toLocaleString()}–${x.end.toLocaleString()}</td>
               <td>${x.strand === 1 ? '→' : '←'}</td><td>${x.length_aa}</td></tr>`).join('')}</table>`
          : '<div class="empty">none ≥30 aa</div>';
      });
    };
    p.querySelector('[data-a=orfcds]').onclick = () => {
      if (!GF.ui.orfs.length) return GF.toast('find ORFs first');
      const o = GF.ui.orfs[0];
      GF.post(`/api/sequences/${s.id}/features`, {
        label: `ORF ${o.length_aa} aa`, type: 'CDS', strand: o.strand,
        segments: [[o.start, o.end]], qualifiers: { translation: o.protein },
      }).then(() => GF.toast('CDS added')).catch(e => GF.toast(e.message));
    };
    p.querySelector('[data-a=fold]').onclick = () => {
      const body = { id: s.id, kind: 'dna' };
      if (hasSel) { body.start = r[0]; body.end = r[1]; }
      p.querySelector('#foldout').innerHTML = '<div class="hint">folding…</div>';
      GF.post('/api/fold/nucleic', body).then(res => {
        p.querySelector('#foldout').innerHTML = res.error
          ? `<div class="hint" style="color:#c53030">${esc(res.error)}</div>`
          : `<div class="hint">MFE <b>${res.mfe}</b> kcal/mol · ensemble ${res.ensemble_energy} · ${esc(res.engine)}</div>
             <div class="mono" style="background:var(--panel2);padding:6px;border-radius:5px;line-height:1.35;overflow-x:auto;white-space:pre">${esc(res.sequence.slice(0, 400))}
${esc(res.structure.slice(0, 400))}</div>`;
      }).catch(e => p.querySelector('#foldout').innerHTML = `<div class="hint" style="color:#c53030">${esc(e.message)}</div>`);
    };
    p.querySelector('[data-a=rbs]').onclick = () => {
      p.querySelector('#foldout').innerHTML = '<div class="hint">checking RBS…</div>';
      GF.post(`/api/sequences/${s.id}/rbs`, {}).then(res => {
        if (res.error) { p.querySelector('#foldout').innerHTML = `<div class="hint" style="color:#c05621">${esc(res.error)}</div>`; return; }
        const tone = res.dG_open < 4 ? 'good' : res.dG_open < 8 ? 'warn' : 'bad';
        const lo = res.rbs_local[0], hi = res.rbs_local[1], pad = Math.min(20, lo);
        p.querySelector('#foldout').innerHTML =
          `<div class="hint">RBS ${res.rbs_start + 1}–${res.rbs_end} · <span class="tag ${tone}">ΔG_open ${res.dG_open} kcal/mol</span></div>
           <div class="hint">${esc(res.verdict)} · ${res.rbs_paired_bases}/${res.rbs_length} bases paired</div>
           <div class="mono" style="background:var(--panel2);padding:6px;border-radius:5px;line-height:1.35;overflow-x:auto;white-space:pre">${esc(res.window.slice(lo - pad, hi + 20))}
${esc(res.structure.slice(lo - pad, hi + 20))}
${' '.repeat(pad)}${'^'.repeat(hi - lo)}</div>`;
      }).catch(e => GF.toast(e.message, 5000));
    };
    p.querySelector('[data-a=align]').onclick = () => GFPanels.alignDialog();
    p.querySelector('[data-a=mutate]').onclick = () => GFPanels.mutateDialog(s);
    p.querySelector('[data-a=af3]').onclick = () => GFPanels.af3Dialog();
    p.querySelector('[data-a=gg]').onclick = () => GFPanels.assemblyDialog('goldengate');
    p.querySelector('[data-a=gib]').onclick = () => GFPanels.assemblyDialog('gibson');
    p.querySelector('[data-a=go3d]').onclick = () => GF.setMainTab('structure');
  }

  GFPanels.primersPanel = primersPanel;
  GFPanels.toolsPanel = toolsPanel;
})();

/* ---- dialogs, copy menu, 3D viewer ---- */
(function () {
  const H = window.__GFP, $ = s => document.querySelector(s);
  const { modal, val, esc, act, sel } = H;
  let viewer = null;

  function render() {
    const p = $('#panel'), s = act();
    if (!s && GF.ui.tab !== '3d') { p.innerHTML = '<div class="empty">Open a sequence to see this panel.</div>'; return; }
    const map = { features: GFPanels.featuresPanel, enzymes: GFPanels.enzymesPanel,
                  primers: GFPanels.primersPanel, tools: GFPanels.toolsPanel, '3d': structurePanel };
    (map[GF.ui.tab] || GFPanels.featuresPanel)(p, s);
  }

  function pickSeqs(label) {
    const list = Object.values(GF.state.sequences);
    if (!list.length) return '<div class="empty">nothing open</div>';
    return `<div class="field"><label>${esc(label)}</label>${list.map(s =>
      `<label class="chk" style="padding:3px 0"><input type="checkbox" name="pick" value="${s.id}">
        ${esc(s.name)}<span class="co" style="margin-left:auto">${s.seq.length.toLocaleString()} bp</span></label>`).join('')}</div>`;
  }
  const picked = box => Array.from(box.querySelectorAll('[name=pick]:checked')).map(i => i.value);

  function alignDialog() {
    modal('Align sequences', pickSeqs('Choose two or more'), box => {
      const ids = picked(box);
      if (ids.length < 2) { GF.toast('pick at least two'); return false; }
      GF.post('/api/align', { ids }).then(res => {
        if (res.error) return GF.toast(res.error, 5000);
        GF.ui.tab = 'tools'; GF.syncTabs(); render();
        const out = $('#alignout');
        if (out) out.innerHTML =
          `<div class="hint">${esc(res.method)} · ${res.length.toLocaleString()} columns · mean identity ${res.mean_identity}%</div>
           <table class="t"><tr><th>Sequence</th><th>Identity</th><th>Diffs</th></tr>
           ${res.rows.map(r => `<tr><td>${esc(r.name)}</td><td>${r.identity}%</td><td>${r.differences.length}</td></tr>`).join('')}</table>
           <div class="hint">Variable columns: ${res.variable_positions.slice(0, 40).map(x => x + 1).join(', ') || 'none'}</div>`;
      }).catch(e => GF.toast(e.message, 5000));
    }, 'Align');
  }

  function mutateDialog(s) {
    const regions = (s.features || []).filter(f => /CDS|gene|peptide|mNG|ZF|tag/i.test(f.type + ' ' + f.label));
    modal('Protein variant', `
      <div class="field"><label>Region to translate</label><select name="region">
        ${regions.map(f => `<option value="${f.segments[0][0]},${f.segments[f.segments.length - 1][1]},${f.strand}">
          ${esc(f.label)} (${f.segments[0][0] + 1}–${f.segments[f.segments.length - 1][1]})</option>`).join('')}
        <option value="custom">custom…</option></select></div>
      <div class="frow">
        <div class="field"><label>Start (1-based)</label><input name="cs" type="number" placeholder="from region"></div>
        <div class="field"><label>End</label><input name="ce" type="number" placeholder="from region"></div></div>
      <div class="field"><label>Mutations, comma separated</label><input name="muts" placeholder="F12L, W8F"></div>
      <div class="field"><label>New name</label><input name="nm" placeholder="auto"></div>
      <div class="hint">Residue numbering starts at the first codon of the chosen region.</div>`,
      box => {
        let cs = null, ce = null, strand = 1;
        const rv = val(box, 'region');
        if (rv && rv !== 'custom') { const a = rv.split(','); cs = +a[0]; ce = +a[1]; strand = +a[2] || 1; }
        if (val(box, 'cs')) cs = parseInt(val(box, 'cs'), 10) - 1;
        if (val(box, 'ce')) ce = parseInt(val(box, 'ce'), 10);
        const muts = (val(box, 'muts') || '').split(',').map(x => x.trim()).filter(Boolean);
        if (!muts.length) { GF.toast('enter at least one mutation'); return false; }
        if (cs === null || ce === null) { GF.toast('choose a region'); return false; }
        GF.post(`/api/sequences/${s.id}/mutate`, { cds_start: cs, cds_end: ce, strand,
          mutations: muts, name: val(box, 'nm') || undefined })
          .then(res => GF.toast('made ' + res.applied.map(a => a.mutation).join(', '), 4000))
          .catch(e => GF.toast(e.message, 7000));
      }, 'Create variant');
  }

  /* AlphaFold 3 jobs are a list of components, as many as the complex needs:
     several protein chains, several DNA or RNA strands, and ions. */
  const AF3_IONS = ['ZN', 'MG', 'CA', 'NA', 'K', 'CL', 'MN', 'FE', 'CU', 'CO', 'NI'];

  function af3Dialog() {
    const list = Object.values(GF.state.sequences);
    let rows = [];
    let nextKey = 1;

    const sourceOptions = sel =>
      list.map(s => `<option value="${s.id}" ${sel === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('');

    const rowHtml = r => {
      const isIon = r.kind === 'ion';
      return `<div class="af3row" data-k="${r.key}"
            style="border:1px solid var(--line);border-radius:6px;padding:7px;margin:6px 0">
        <div class="frow" style="align-items:flex-end">
          <div class="field" style="flex:0 0 108px"><label>Component</label>
            <select name="kind_${r.key}">
              <option value="protein" ${r.kind === 'protein' ? 'selected' : ''}>protein</option>
              <option value="dna_ds" ${r.kind === 'dna_ds' ? 'selected' : ''}>DNA, duplex</option>
              <option value="dna_ss" ${r.kind === 'dna_ss' ? 'selected' : ''}>DNA, 1 strand</option>
              <option value="rna" ${r.kind === 'rna' ? 'selected' : ''}>RNA</option>
              <option value="ion" ${isIon ? 'selected' : ''}>ion</option>
            </select></div>
          <div class="field" style="flex:1">${isIon
            ? `<label>Ion</label><select name="ion_${r.key}">
                 ${AF3_IONS.map(i => `<option ${r.ion === i ? 'selected' : ''}>${i}</option>`).join('')}
               </select>`
            : `<label>From</label><select name="src_${r.key}">${sourceOptions(r.src)}</select>`}</div>
          <div class="field" style="flex:0 0 62px"><label>Copies</label>
            <input name="n_${r.key}" type="number" min="1" value="${r.count || 1}"></div>
          <button class="btn" data-del="${r.key}" title="remove"
                  style="flex:0 0 auto;color:var(--err)">×</button>
        </div>
        ${isIon ? '' : `<label class="chk" style="margin-top:4px">
          <input type="checkbox" name="selonly_${r.key}"> use only my current selection</label>`}
      </div>`;
    };

    const addRow = (kind) => { rows.push({ key: nextKey++, kind: kind || 'protein', count: 1, ion: 'ZN' }); };
    if (list.length) addRow('protein');

    const m = modal('AlphaFold 3 job', `
      <div class="field"><label>Job name</label><input name="jn" value="geneforge_job"></div>
      <div id="af3rows"></div>
      <div class="frow" style="margin:2px 0 6px">
        <button class="btn" data-add="protein">+ protein</button>
        <button class="btn" data-add="dna_ds">+ DNA</button>
        <button class="btn" data-add="rna">+ RNA</button>
        <button class="btn" data-add="ion">+ ion</button></div>
      <div class="hint">Add one component per chain. C2H2 zinc fingers need one Zn per
        finger — a three-finger domain such as Zif268 takes 3 Zn per chain. A duplex is
        written as both strands, which AlphaFold 3 requires.</div>`,
      box => {
        const proteins = [], dna = [], rna = [], ions = [];
        const pastes = [];
        for (const r of rows) {
          const kind = val(box, 'kind_' + r.key);
          const count = Math.max(1, parseInt(val(box, 'n_' + r.key), 10) || 1);
          if (kind === 'ion') {
            ions.push({ ion: val(box, 'ion_' + r.key), count });
            continue;
          }
          const srcId = val(box, 'src_' + r.key);
          const s = GF.state.sequences[srcId];
          if (!s) { pastes.push(r.key); continue; }
          const selOnly = (box.querySelector(`[name=selonly_${r.key}]`) || {}).checked;
          let a = 0, b = s.seq.length, st = 1;
          if (selOnly && s.id === GF.ui.activeId && sel()) { a = sel()[0]; b = sel()[1]; }
          else if (kind === 'protein') {
            const cds = (s.features || []).find(f => f.type === 'CDS');
            if (cds) { a = cds.segments[0][0]; b = cds.segments[cds.segments.length - 1][1]; st = cds.strand || 1; }
          }
          let nt = s.seq.slice(a, b);
          if (st === -1) nt = GF.rc(nt);
          if (kind === 'protein') proteins.push({ sequence: GF.translateJS(nt), count });
          else if (kind === 'rna') rna.push({ sequence: nt, count });
          else dna.push({ sequence: nt, double: kind === 'dna_ds', count });
        }
        if (pastes.length) { GF.toast('choose a sequence for every component'); return false; }
        if (!proteins.length && !dna.length && !rna.length) {
          GF.toast('add at least one protein, DNA or RNA component'); return false;
        }
        GF.post('/api/af3', { name: val(box, 'jn'), proteins, dna, rna, ions, save: true }).then(res => {
          modal('AlphaFold 3 job ready', `
            <div class="hint">${res.entities} entities · about ${res.approx_tokens} tokens</div>
            <div class="hint">Saved to:<br><span class="mono">${esc(res.path || '')}</span></div>
            <textarea class="mono" rows="9" style="width:100%">${esc(res.json)}</textarea>
            <div class="hint">Upload this file at alphafoldserver.com — it takes a job JSON directly.</div>`,
            () => window.open('https://alphafoldserver.com/', '_blank'), 'Open AlphaFold Server');
        }).catch(e => GF.toast(e.message, 7000));
      }, 'Build job');

    /* Keep what is already typed when the list is redrawn. */
    const readBack = () => rows.forEach(r => {
      const k = val(m.box, 'kind_' + r.key); if (k) r.kind = k;
      const n = val(m.box, 'n_' + r.key); if (n) r.count = Math.max(1, parseInt(n, 10) || 1);
      const s = val(m.box, 'src_' + r.key); if (s) r.src = s;
      const i = val(m.box, 'ion_' + r.key); if (i) r.ion = i;
    });

    const draw = () => {
      const host = m.box.querySelector('#af3rows');
      host.innerHTML = rows.length ? rows.map(rowHtml).join('')
        : '<div class="empty">no components yet — add one below</div>';
      host.querySelectorAll('[data-del]').forEach(b => b.onclick = ev => {
        ev.preventDefault();
        readBack();
        rows = rows.filter(r => String(r.key) !== b.dataset.del);
        draw();
      });
      /* switching to or from "ion" swaps the second field, so redraw */
      rows.forEach(r => {
        const kindSel = m.box.querySelector(`[name=kind_${r.key}]`);
        if (kindSel) kindSel.onchange = () => { readBack(); draw(); };
      });
    };

    m.box.querySelectorAll('[data-add]').forEach(b => b.onclick = ev => {
      ev.preventDefault();
      readBack();
      addRow(b.dataset.add);
      draw();
    });
    draw();
  }

  function assemblyDialog(kind) {
    const gg = kind === 'goldengate';
    modal(gg ? 'Golden Gate assembly' : 'Gibson assembly', `${pickSeqs('Fragments, any order')}
      ${gg ? '<div class="field"><label>Type IIS enzyme</label><select name="enz"><option>BsaI</option><option>BsmBI</option><option>BbsI</option><option>SapI</option></select></div>'
           : '<div class="field"><label>Minimum homology (bp)</label><input name="hom" type="number" value="20"></div>'}
      <label class="chk"><input type="checkbox" name="circ" checked> circular product</label>`,
      box => {
        const ids = picked(box);
        if (ids.length < 2) { GF.toast('pick at least two fragments'); return false; }
        const body = { ids, circular: box.querySelector('[name=circ]').checked };
        if (gg) body.enzyme = val(box, 'enz'); else body.min_homology = +val(box, 'hom');
        GF.post('/api/assembly/' + (gg ? 'goldengate' : 'gibson'), body).then(res => {
          if (res.error) return GF.toast(res.error, 7000);
          modal('Assembly result', `
            <div class="hint">${res.length.toLocaleString()} bp · ${res.circular ? 'circular' : 'linear'}${res.order ? ' · ' + res.order.join(' → ') : ''}</div>
            ${(res.unused || []).length ? `<div class="hint" style="color:#c05621">Unused: ${res.unused.join(', ')}</div>` : ''}
            <div class="field"><label>Name</label><input name="nm" value="assembly"></div>`,
            b2 => GF.post('/api/sequences', { name: val(b2, 'nm') || 'assembly', seq: res.sequence,
              topology: res.circular ? 'circular' : 'linear' })
              .then(s2 => { GF.setActive(s2.id); GF.toast('assembly opened'); }), 'Open as sequence');
        }).catch(e => GF.toast(e.message, 7000));
      }, 'Simulate');
  }

  function newSequenceDialog() {
    modal('New sequence', `
      <div class="field"><label>Name</label><input name="nm" value="untitled"></div>
      <div class="field"><label>Sequence</label><textarea name="sq" rows="6" placeholder="ACGT…"></textarea></div>
      <div class="field"><label>Topology</label><select name="tp"><option value="linear">linear</option><option value="circular">circular</option></select></div>`,
      box => {
        const sq = (val(box, 'sq') || '').replace(/[^A-Za-z]/g, '');
        if (!sq) { GF.toast('enter a sequence'); return false; }
        GF.post('/api/sequences', { name: val(box, 'nm'), seq: sq, topology: val(box, 'tp') })
          .then(s => GF.setActive(s.id)).catch(e => GF.toast(e.message));
      }, 'Create');
  }

  /** Turn whatever is selected into a primer, without the design step. */
  function primerFromSelection(strand) {
    const s = act(), r = sel();
    if (!s || !r || r[1] <= r[0]) return GF.toast('select a region first');
    const raw = s.seq.slice(r[0], r[1]);
    const seq = strand === -1 ? GF.rc(raw) : raw;
    const base = (s.name || 'primer').replace(/\W+/g, '_');
    const name = `${base}_${strand === -1 ? 'R' : 'F'}${r[0] + 1}`;
    if (seq.length > 60) {
      GF.toast(`${seq.length} nt is long for a primer, but go ahead if you mean it`, 4000);
    }
    GF.post('/api/primer/stats', { seq }).then(st => {
      modal(strand === -1 ? 'New reverse primer' : 'New primer', `
        <div class="field"><label>Name</label><input name="nm" value="${esc(name)}"></div>
        <div class="field"><label>Sequence 5'→3'${strand === -1 ? ' (reverse complement of the selection)' : ''}</label>
          <textarea name="sq" rows="3" class="mono">${esc(seq)}</textarea></div>
        <div class="hint">${seq.length} nt · Tm ${st.tm} °C · ${st.gc}% GC
          · hairpin ${st.hairpin_tm} °C · self-dimer ${st.homodimer_tm} °C
          ${st.gc_clamp ? '· GC clamp' : '· no GC clamp'}</div>
        <label class="chk"><input type="checkbox" name="att" checked>
          annotate its binding site on ${esc(s.name)}</label>`,
        box => {
          const sq = (val(box, 'sq') || '').replace(/[^A-Za-z]/g, '');
          if (!sq) { GF.toast('enter a sequence'); return false; }
          const body = { name: val(box, 'nm') || name, seq: sq };
          if (box.querySelector('[name=att]').checked) body.attach_to = s.id;
          GF.post('/api/primers', body)
            .then(pr => GF.toast(`${pr.name}: Tm ${pr.tm} °C, ${pr.gc}% GC`, 4000))
            .catch(e => GF.toast(e.message, 5000));
        }, 'Save primer');
    }).catch(e => GF.toast(e.message, 5000));
  }

  function newPrimerDialog() {
    modal('Add primer', `
      <div class="field"><label>Name</label><input name="nm" value="primer"></div>
      <div class="field"><label>Sequence 5'→3'</label><textarea name="sq" rows="3"></textarea></div>
      <label class="chk"><input type="checkbox" name="att" checked> annotate binding site on the open sequence</label>`,
      box => {
        const sq = (val(box, 'sq') || '').replace(/[^A-Za-z]/g, '');
        if (!sq) { GF.toast('enter a sequence'); return false; }
        const body = { name: val(box, 'nm'), seq: sq };
        if (box.querySelector('[name=att]').checked && act()) body.attach_to = act().id;
        GF.post('/api/primers', body)
          .then(p => GF.toast(`${p.name}: Tm ${p.tm}°C, ${p.gc}% GC`, 4000))
          .catch(e => GF.toast(e.message, 5000));
      }, 'Add');
  }

  function saveAsDialog(s) {
    modal('Save sequence', `
      <div class="field"><label>File name</label><input name="fn" value="${esc((s.name || 'sequence').replace(/\W+/g, '_'))}.gb"></div>
      <div class="field"><label>Format</label><select name="fm"><option value="genbank">GenBank (.gb)</option><option value="fasta">FASTA (.fasta)</option></select></div>
      <div class="hint">Saved into the working folder:<br><span class="mono">${esc(GF.state.folder)}</span></div>`,
      box => GF.post(`/api/sequences/${s.id}/save`, { path: val(box, 'fn'), format: val(box, 'fm') })
        .then(r => GF.toast('saved ' + r.path.split('/').pop())).catch(e => GF.toast(e.message, 5000)), 'Save');
  }

  /** Pick the working folder, the way an editor opens a project folder. */
  function folderDialog() {
    const m = modal('Open folder', `
      <div class="fp-path" id="fp-now">…</div>
      <div class="fp-list" id="fp-list"><div class="empty">loading…</div></div>
      <div class="field" style="margin-top:8px"><label>Or type a path</label>
        <input name="manual" placeholder="~/Documents/constructs"></div>
      <div class="hint">Opening a folder only changes what the file list shows.
        Nothing is opened, written or closed.</div>`,
      box => {
        const typed = (val(box, 'manual') || '').trim();
        use(typed || here);
        return true;
      }, 'Open this folder');

    let here = GF.state.folder;
    const use = path => GF.post('/api/folder', { path })
      .then(r => GF.toast('working in ' + r.folder.split('/').pop()))
      .catch(e => GF.toast(e.message, 5000));

    const load = path => GF.api('/api/folder/browse?path=' + encodeURIComponent(path || ''))
      .then(d => {
        here = d.path;
        m.box.querySelector('#fp-now').textContent =
          `${d.path}   ·   ${d.n_sequences} sequence file${d.n_sequences === 1 ? '' : 's'}`;
        const list = m.box.querySelector('#fp-list');
        list.innerHTML = '';
        const add = (label, target, cls) => {
          const row = document.createElement('div');
          row.className = 'row' + (cls ? ' ' + cls : '');
          row.innerHTML = `<span class="nm">${esc(label)}</span>`;
          row.onclick = () => load(target);
          list.appendChild(row);
        };
        add('🏠  Home', d.home);
        if (d.parent) add('↑  ' + d.parent.split('/').pop() + '/..', d.parent);
        if (!d.folders.length) {
          const e = document.createElement('div');
          e.className = 'empty'; e.textContent = 'no sub-folders';
          list.appendChild(e);
        }
        d.folders.forEach(f => add('📁  ' + f.name, f.path));
      })
      .catch(e => { m.box.querySelector('#fp-list').innerHTML =
        `<div class="empty">${esc(e.message)}</div>`; });

    load(GF.state.folder);
  }

  /* ------------------------------------------------- structure & protein

     The Structure tab owns the whole main pane, so the viewer is a first
     class view beside the sequence rather than an overlay on the map. This
     panel is its side bar: what to look at, and what to do with it. */

  function structurePanel(p) {
    const cap = H.CAPS || {};
    const cur = GF.ui.structPath;
    p.innerHTML = `
      ${GF.ui.mainTab !== 'structure'
        ? '<button class="btn" data-a="open3d" style="width:100%;margin:2px 2px 8px">Open the Structure tab</button>' : ''}
      <div class="ptitle">Structures in folder</div>
      <div id="stlist"><div class="empty">scanning…</div></div>
      <div class="ptitle">Predict</div>
      <button class="btn" data-a="af3" style="width:100%;margin:2px">Build AlphaFold 3 job…</button>
      <button class="btn" data-a="esm" style="width:100%;margin:2px" ${cap.esmfold ? '' : 'disabled'}>
        Fold selection with ESMFold</button>
      ${cap.esmfold ? '' : `<div class="hint">ESMFold is not installed.
        <a href="#" data-a="addons">Add it from Add-ons</a>.</div>`}
      <div class="ptitle">Ray-traced image</div>
      <div class="field"><label>Style</label><select name="style">
        <option value="cartoon">cartoon, rainbow</option><option value="surface">surface</option>
        <option value="sticks">sticks</option><option value="cartoon_bfactor">cartoon by B-factor / pLDDT</option>
      </select></div>
      <button class="btn" data-a="pymol" style="width:100%;margin:2px" ${cap.pymol && cur ? '' : 'disabled'}>
        ${cur ? 'Render with PyMOL' : 'Pick a structure first'}</button>
      ${cap.pymol ? '' : '<div class="hint" style="color:#c05621">PyMOL not installed</div>'}
      <div id="renderout"></div>`;

    const on = (sel, fn) => { const e = p.querySelector(sel); if (e) e.onclick = ev => { ev.preventDefault(); fn(ev); }; };
    on('[data-a=open3d]', () => GF.setMainTab('structure'));
    on('[data-a=af3]', () => af3Dialog());
    on('[data-a=addons]', () => addonsDialog());
    on('[data-a=pymol]', () => renderStructure(p.querySelector('[name=style]').value));
    const esm = p.querySelector('[data-a=esm]');
    if (esm && !esm.disabled) esm.onclick = () => esmfoldRun();

    refreshStructures().then(() => {
      const list = p.querySelector('#stlist');
      if (!list) return;
      const all = GF.ui.structures;
      if (!all.length) { list.innerHTML = '<div class="empty">no .pdb / .cif here</div>'; return; }
      list.innerHTML = '';
      all.forEach(st => {
        const row = document.createElement('div');
        row.className = 'row' + (st.path === GF.ui.structPath ? ' active' : '');
        row.innerHTML = `<span class="nm">${esc(st.name)}</span><span class="co">${(st.size / 1024).toFixed(0)}k</span>`;
        row.onclick = () => { showStructure(st.path); GF.setMainTab('structure'); };
        list.appendChild(row);
      });
    });
  }

  /** Reload the folder's structure list and keep the picker in step. */
  function refreshStructures() {
    return GF.api('/api/structures').then(d => {
      GF.ui.structures = d.structures || [];
      const pick = $('#struct-pick');
      if (pick) {
        pick.innerHTML = GF.ui.structures.length
          ? GF.ui.structures.map(s =>
              `<option value="${esc(s.path)}" ${s.path === GF.ui.structPath ? 'selected' : ''}>${esc(s.name)}</option>`).join('')
          : '<option value="">no .pdb or .cif in this folder</option>';
      }
      /* show something straight away rather than an empty black pane */
      if (!GF.ui.structPath && GF.ui.structures.length && GF.ui.mainTab === 'structure') {
        showStructure(GF.ui.structures[0].path);
      }
      return GF.ui.structures;
    }).catch(() => []);
  }

  function setStructInfo(text) {
    const el = $('#struct-info');
    if (el) el.textContent = text;
  }

  function showStructure(path) {
    if (!path) return;
    GF.ui.structPath = path;
    const pick = $('#struct-pick');
    if (pick && pick.value !== path) pick.value = path;
    const host = $('#viewer3d');
    host.classList.remove('hidden');
    host.innerHTML = '<div class="v3-canvas" id="v3canvas"></div>';
    const canvas = host.querySelector('#v3canvas');
    setStructInfo('loading ' + path.split('/').pop() + '…');
    fetch('/api/structure?path=' + encodeURIComponent(path)).then(r => r.text()).then(text => {
      if (typeof $3Dmol === 'undefined') {
        canvas.innerHTML = '<div class="v3-empty">3Dmol.js not vendored</div>';
        return;
      }
      viewer = $3Dmol.createViewer(canvas, { backgroundColor: '#0f1216' });
      H.viewer = viewer;
      viewer.addModel(text, /\.cif$|\.mmcif$/i.test(path) ? 'cif' : 'pdb');
      applyStyle(GF.ui.style3d);
      viewer.zoomTo(); viewer.render();
      const atoms = viewer.selectedAtoms({}).length;
      const chains = new Set(viewer.selectedAtoms({}).map(a => a.chain)).size;
      setStructInfo(`${path.split('/').pop()} · ${atoms.toLocaleString()} atoms · ${chains} chain${chains === 1 ? '' : 's'}`);
      if (GF.ui.tab === '3d') render();
    }).catch(e => {
      canvas.innerHTML = `<div class="v3-empty">${esc(e.message)}</div>`;
      setStructInfo('could not load ' + path.split('/').pop());
    });
  }

  function resizeViewer() {
    if (!viewer) return;
    try { viewer.resize(); viewer.render(); } catch (e) { }
  }

  function applyStyle(style) {
    if (!viewer) return;
    viewer.setStyle({}, {});
    viewer.removeAllSurfaces();
    if (style === 'cartoon') viewer.setStyle({}, { cartoon: { color: 'spectrum' } });
    else if (style === 'stick') viewer.setStyle({}, { stick: { radius: 0.18 } });
    else if (style === 'sphere') viewer.setStyle({}, { sphere: { scale: 0.3 } });
    else if (style === 'surface') {
      viewer.setStyle({}, { cartoon: { color: 'spectrum' } });
      viewer.addSurface($3Dmol.SurfaceType.VDW, { opacity: 0.72, color: 'white' });
    } else if (style === 'plddt') {
      viewer.setStyle({}, { cartoon: { colorfunc: a =>
        a.b > 90 ? '#0053d6' : a.b > 70 ? '#65cbf3' : a.b > 50 ? '#ffdb13' : '#ff7d45' } });
    }
    viewer.render();
  }

  /* ----------------------------------------------------------- rendering */

  function renderStructure(style) {
    const path = GF.ui.structPath;
    if (!path) return GF.toast('pick a structure first');
    const chosen = style || (document.querySelector('#panel [name=style]') || {}).value || 'cartoon';
    const btn = $('#btn-render');
    if (btn) { btn.disabled = true; btn.textContent = 'rendering…'; }
    GF.toast('rendering with PyMOL…', 4000);
    return GF.post('/api/render', { path, style: chosen })
      .then(res => {
        if (btn) { btn.disabled = false; btn.textContent = 'Render'; }
        renderResultDialog(res);
      })
      .catch(e => {
        if (btn) { btn.disabled = false; btn.textContent = 'Render'; }
        GF.toast(e.message, 7000);
      });
  }

  /** Show the finished image with the obvious ways to keep it. */
  function renderResultDialog(res) {
    const url = '/api/image?path=' + encodeURIComponent(res.png) + '&t=' + Date.now();
    const file = res.png.split('/').pop();
    const m = modal('Render ready', `
      <img class="renderimg" src="${url}">
      <div class="hint">${(res.size / 1024).toFixed(0)} kB · ${res.width}×${res.height}</div>
      <div class="hint">Saved next to the structure as
        <span class="mono">${esc(file)}</span></div>
      <div class="frow" style="margin-top:8px">
        <a class="btn" href="${url}" download="${esc(file)}" data-x="dl">Download…</a>
        <button class="btn" data-x="reveal">Show in Finder</button>
        <button class="btn" data-x="saveas">Save a copy as…</button>
      </div>`);
    m.box.querySelector('[data-x=reveal]').onclick = () =>
      GF.post('/api/reveal', { path: res.png })
        .then(() => GF.toast('shown in Finder'))
        .catch(e => GF.toast(e.message, 5000));
    m.box.querySelector('[data-x=saveas]').onclick = () => {
      m.close();
      modal('Save a copy', `
        <div class="field"><label>File name</label><input name="fn" value="${esc(file)}"></div>
        <div class="hint">Saved into the working folder:<br>
          <span class="mono">${esc(GF.state.folder)}</span></div>`,
        box2 => GF.post('/api/copy_file', { from: res.png, name: val(box2, 'fn') })
          .then(r => GF.toast('saved ' + r.path.split('/').pop(), 4000))
          .catch(e => GF.toast(e.message, 5000)), 'Save');
    };
    /* also drop it in the side panel, so it is still there after closing */
    const out = document.querySelector('#renderout');
    if (out) {
      out.innerHTML = `<img class="renderimg" src="${url}">
        <div class="hint">${esc(file)} · <a href="${url}" download="${esc(file)}">download</a></div>`;
    }
  }

  /* ------------------------------------------------------------- predict */

  function predictMenu(ev) {
    const cap = H.CAPS || {};
    const s = act(), r = sel();
    const hasSel = !!(s && r && r[1] > r[0]);
    GF.showCtx(ev, [
      { header: hasSel ? `selection ${(r[0] + 1).toLocaleString()}–${r[1].toLocaleString()}` : 'no selection' },
      { label: 'Build AlphaFold 3 job…', run: () => af3Dialog() },
      cap.esmfold
        ? { label: hasSel ? 'Fold selection with ESMFold' : 'Fold the CDS with ESMFold', run: () => esmfoldRun() }
        : { label: 'ESMFold — install from Add-ons…', run: () => addonsDialog() },
    ]);
  }

  function esmfoldRun() {
    const s = act();
    if (!s) return GF.toast('open a sequence first');
    const r = sel(), hasSel = r && r[1] > r[0];
    const body = { id: s.id, save: true, name: (s.name || 'seq').replace(/\W+/g, '_') + '_esmfold' };
    if (hasSel) { body.start = r[0]; body.end = r[1]; }
    GF.toast('folding with ESMFold — this takes minutes on CPU', 6000);
    setStructInfo('folding with ESMFold…');
    GF.post('/api/esmfold', body).then(res => {
      GF.toast(`ESMFold done — mean pLDDT ${res.mean_plddt}`, 6000);
      if (res.path) {
        GF.setMainTab('structure');
        refreshStructures().then(() => {
          showStructure(res.path);
          GF.ui.style3d = 'plddt';
          document.querySelectorAll('#style3d button').forEach(b =>
            b.classList.toggle('on', b.dataset.s === 'plddt'));
          applyStyle('plddt');
        });
      }
    }).catch(e => { setStructInfo('ESMFold failed'); GF.toast(e.message, 8000); });
  }

  /* -------------------------------------------------------------- add-ons */

  const ADDONS = [{
    key: 'esmfold',
    name: 'ESMFold',
    blurb: 'Predict a protein structure on this Mac, no upload. Single chain only — ' +
           'no DNA, no multimers, no metals. About 5 GB to install, plus a 2.7 GB ' +
           'model the first time you fold.',
  }];

  function addonsDialog() {
    const m = modal('Add-ons', '<div id="addonlist"><div class="empty">checking…</div></div>', null);
    const draw = cap => {
      const host = m.box.querySelector('#addonlist');
      if (!host) return;
      host.innerHTML = ADDONS.map(a => {
        const ready = !!cap[a.key];
        const st = (cap[a.key + '_install'] || {}).state;
        const why = cap[a.key + '_why'] || {};
        const log = ((cap[a.key + '_install'] || {}).log || []).slice(-2).join('<br>');
        let action;
        if (ready) action = '<span class="tag ok">installed</span>';
        else if (st === 'running') action = `<span class="tag">installing…</span>`;
        else action = `<button class="btn primary" data-install="${a.key}">Install</button>`;
        return `<div style="border:1px solid var(--line);border-radius:7px;padding:9px;margin:6px 0">
          <div style="display:flex;align-items:center;gap:8px">
            <b style="flex:1">${esc(a.name)}</b>${action}</div>
          <div class="hint" style="margin-top:4px">${esc(a.blurb)}</div>
          ${!ready && why.enough_ram === false
            ? `<div class="hint" style="color:#c05621">This Mac reports
                ${cap.specs && cap.specs.ram_gb} GB of RAM and ESMFold needs about 16 GB,
                so it would install but refuse to run. The AlphaFold 3 export has no such
                limit.</div>` : ''}
          ${st === 'running' && log ? `<div class="hint mono" style="margin-top:4px">${log}</div>` : ''}
          ${st === 'failed' ? '<div class="hint" style="color:#c53030">The last attempt failed; the notices at the top have the detail.</div>' : ''}
          ${ready ? '' : `<div class="hint">Or in a terminal, in the GeneForge folder:
              <span class="mono">${esc(why.command || './setup.sh --with-esmfold')}</span></div>`}
        </div>`;
      }).join('');
      host.querySelectorAll('[data-install]').forEach(b => b.onclick = () => {
        const a = ADDONS.find(x => x.key === b.dataset.install);
        if (!confirm(`Install ${a.name}?\n\n${a.blurb}`)) return;
        b.disabled = true; b.textContent = 'starting…';
        GF.post('/api/esmfold/install', {})
          .then(() => { GF.toast('install started — you can keep working', 5000); watch(); })
          .catch(e => { b.disabled = false; b.textContent = 'Install'; GF.toast(e.message, 6000); });
      });
    };
    let timer = null;
    const watch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        GF.api('/api/capabilities').then(c => {
          H.setCaps(c);
          if (document.body.contains(m.box) && m.box.querySelector('#addonlist')) draw(c);
          if (GF.ui.tab === '3d' || GF.ui.tab === 'tools') render();
          if ((c.esmfold_install || {}).state === 'running') watch();
          else if (c.esmfold) GF.toast('ESMFold is ready to use', 5000);
        }).catch(() => { });
      }, 4000);
    };
    GF.api('/api/capabilities').then(c => {
      H.setCaps(c);
      draw(c);
      if ((c.esmfold_install || {}).state === 'running') watch();
    });
  }

  Object.assign(GFPanels, { render, alignDialog, mutateDialog, af3Dialog, assemblyDialog,
    newSequenceDialog, newPrimerDialog, primerFromSelection, saveAsDialog, folderDialog, structurePanel,
    showStructure, refreshStructures, applyStyle, resizeViewer, renderStructure,
    predictMenu, esmfoldRun, addonsDialog });
})();
