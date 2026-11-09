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
      <div class="ptitle">Selection</div>
      ${hasSel
        ? `<div class="hint">${(r[0] + 1).toLocaleString()}–${r[1].toLocaleString()} · ${(r[1] - r[0]).toLocaleString()} bp</div>
           <button class="btn" data-a="annotate" style="width:100%;margin:5px 0">Annotate selection</button>`
        : '<div class="hint">Drag across the sequence or the map to select.</div>'}
      <div class="ptitle">Features (${feats.length})</div><div id="featlist"></div>`;
    const list = p.querySelector('#featlist');
    if (!feats.length) list.innerHTML = '<div class="empty">none</div>';
    feats.forEach(f => {
      const a = f.segments[0][0], b = f.segments[f.segments.length - 1][1];
      const row = document.createElement('div');
      row.className = 'row' + (GF.ui.activeFeature === f.id ? ' active' : '');
      row.innerHTML = `<span class="swatch" style="background:${esc(f.color)}"></span>
        <span class="nm" title="${esc(f.type)}">${esc(f.label)}</span>
        <span class="co">${(a + 1).toLocaleString()}–${b.toLocaleString()}${f.strand === -1 ? ' ←' : f.strand === 1 ? ' →' : ''}</span>`;
      row.onclick = () => GF.selectFeature(f);
      row.ondblclick = () => editFeature(s, f);
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
    p.innerHTML = `<div class="ptitle">Enzymes</div>
      <div class="field"><input name="enzq" placeholder="add enzyme (e.g. BsmBI)…"></div>
      <div id="chips" style="display:flex;flex-wrap:wrap;gap:4px;margin:4px 2px 8px"></div>
      <div class="frow" style="margin:0 2px 8px">
        <button class="btn" data-a="common">Common set</button>
        <button class="btn" data-a="unique">Unique only</button></div>
      <div id="enzresult"></div>`;
    const chips = p.querySelector('#chips');
    GF.ui.enzymes.forEach(n => {
      const c = document.createElement('span');
      c.className = 'tag'; c.style.cursor = 'pointer'; c.title = 'remove';
      c.textContent = n + ' ×';
      c.onclick = () => { GF.ui.enzymes = GF.ui.enzymes.filter(x => x !== n); GF.loadRestriction().then(render); };
      chips.appendChild(c);
    });
    const q = p.querySelector('[name=enzq]');
    q.onkeydown = e => {
      if (e.key !== 'Enter') return;
      const n = q.value.trim();
      if (n && GF.ui.enzymes.indexOf(n) < 0) { GF.ui.enzymes.push(n); q.value = ''; GF.loadRestriction().then(render); }
    };
    p.querySelector('[data-a=common]').onclick = () => { GF.ui.enzymes = COMMON.slice(); GF.loadRestriction().then(render); };
    p.querySelector('[data-a=unique]').onclick = () => {
      if (!r) return; GF.ui.enzymes = r.unique.slice(); GF.loadRestriction().then(render);
    };
    const out = p.querySelector('#enzresult');
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
      <button class="btn" data-a="af3" style="width:100%;margin:2px">Build AlphaFold 3 job…</button>
      <button class="btn" data-a="esm" style="width:100%;margin:2px" ${cap.esmfold ? '' : 'disabled'}>Fold ${hasSel ? 'selection' : 'CDS'} with ESMFold</button>
      ${warn(cap.esmfold, 'ESMFold (torch + transformers)')}
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
    const esm = p.querySelector('[data-a=esm]');
    if (esm && !esm.disabled) esm.onclick = () => {
      esm.disabled = true; esm.textContent = 'folding… may take minutes';
      const body = { id: s.id, save: true, name: (s.name || 'seq').replace(/\W+/g, '_') + '_esmfold' };
      if (hasSel) { body.start = r[0]; body.end = r[1]; }
      GF.post('/api/esmfold', body).then(res => {
        esm.disabled = false; esm.textContent = 'Fold with ESMFold';
        GF.toast(`ESMFold done — mean pLDDT ${res.mean_plddt}`, 5000);
        if (res.path) { GF.ui.tab = '3d'; GF.syncTabs(); H.render(); GFPanels.viewStructure(res.path); }
      }).catch(e => { esm.disabled = false; esm.textContent = 'Fold with ESMFold'; GF.toast(e.message, 7000); });
    };
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

  function af3Dialog() {
    const list = Object.values(GF.state.sequences);
    modal('AlphaFold 3 job', `
      <div class="field"><label>Job name</label><input name="jn" value="geneforge_job"></div>
      ${list.map(s => `<div class="field"><label>${esc(s.name)}</label><select name="role_${s.id}">
        <option value="">ignore</option>
        <option value="protein">protein — translate CDS</option>
        <option value="protein_sel">protein — translate selection</option>
        <option value="dna_ds">DNA — double-stranded</option>
        <option value="dna_ss">DNA — single strand</option></select></div>`).join('')}
      <div class="frow">
        <div class="field"><label>Zn²⁺ ions</label><input name="zn" type="number" value="0" min="0"></div>
        <div class="field"><label>Mg²⁺ ions</label><input name="mg" type="number" value="0" min="0"></div></div>
      <div class="hint">C2H2 zinc fingers need one Zn per finger — a three-finger domain such as Zif268 takes 3 Zn per chain. Double-stranded DNA is written as both strands, which AlphaFold 3 requires.</div>`,
      box => {
        const proteins = [], dna = [];
        for (const s of list) {
          const role = val(box, 'role_' + s.id);
          if (!role) continue;
          if (role.indexOf('protein') === 0) {
            let a = 0, b = s.seq.length, st = 1;
            const cds = (s.features || []).find(f => f.type === 'CDS');
            if (role === 'protein_sel' && s.id === GF.ui.activeId && sel()) { a = sel()[0]; b = sel()[1]; }
            else if (cds) { a = cds.segments[0][0]; b = cds.segments[cds.segments.length - 1][1]; st = cds.strand || 1; }
            let nt = s.seq.slice(a, b);
            if (st === -1) nt = GF.rc(nt);
            proteins.push({ sequence: GF.translateJS(nt), count: 1 });
          } else dna.push({ sequence: s.seq, double: role === 'dna_ds', count: 1 });
        }
        if (!proteins.length && !dna.length) { GF.toast('assign at least one chain'); return false; }
        const ions = [];
        if (+val(box, 'zn') > 0) ions.push({ ion: 'ZN', count: +val(box, 'zn') });
        if (+val(box, 'mg') > 0) ions.push({ ion: 'MG', count: +val(box, 'mg') });
        GF.post('/api/af3', { name: val(box, 'jn'), proteins, dna, ions, save: true }).then(res => {
          modal('AlphaFold 3 job ready', `
            <div class="hint">${res.entities} entities · about ${res.approx_tokens} tokens</div>
            <div class="hint">Saved to:<br><span class="mono">${esc(res.path || '')}</span></div>
            <textarea class="mono" rows="9" style="width:100%">${esc(res.json)}</textarea>
            <div class="hint">Upload this file at alphafoldserver.com — it takes a job JSON directly.</div>`,
            () => window.open('https://alphafoldserver.com/', '_blank'), 'Open AlphaFold Server');
        }).catch(e => GF.toast(e.message, 7000));
      }, 'Build job');
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

  const COPY_ITEMS = [['DNA, forward', 'dna'], ['DNA, reverse complement', 'dna_revcomp'],
    ['DNA, complement', 'dna_complement'], ['DNA, reversed', 'dna_rev'], null,
    ['RNA, forward', 'rna'], ['RNA, reverse complement', 'rna_revcomp'], null,
    ['Protein, frame 1', 'protein', 0], ['Protein, frame 2', 'protein', 1],
    ['Protein, frame 3', 'protein', 2], ['Protein, reverse strand', 'protein_revcomp', 0], null,
    ['FASTA', 'fasta'], ['GenBank record', 'genbank']];

  function copyMenu() {
    const s = act(); if (!s) return;
    const m = $('#copy-menu'), r = sel();
    m.innerHTML = `<div class="hint" style="padding:3px 8px">${r && r[1] > r[0]
      ? 'selection ' + (r[0] + 1).toLocaleString() + '–' + r[1].toLocaleString() : 'whole sequence'}</div>` +
      COPY_ITEMS.map(it => it === null ? '<div class="sep"></div>'
        : `<button data-mode="${it[1]}" data-frame="${it[2] || 0}">${esc(it[0])}</button>`).join('');
    m.classList.add('open');
    m.querySelectorAll('button').forEach(b => b.onclick = ev => {
      ev.stopPropagation();
      const body = { id: s.id, mode: b.dataset.mode, frame: +b.dataset.frame };
      if (r && r[1] > r[0]) { body.start = r[0]; body.end = r[1]; }
      GF.post('/api/copy', body).then(res => {
        navigator.clipboard.writeText(res.text);
        GF.toast('copied ' + res.length.toLocaleString() + ' characters');
        m.classList.remove('open');
      }).catch(e => GF.toast(e.message, 4000));
    });
  }

  function structurePanel(p) {
    const cap = H.CAPS || {};
    p.innerHTML = `<div class="ptitle">Structures in folder</div><div id="stlist"><div class="empty">scanning…</div></div>
      <div class="ptitle">Render</div>
      <div class="field"><label>Style</label><select name="style">
        <option value="cartoon">cartoon, rainbow</option><option value="surface">surface</option>
        <option value="sticks">sticks</option><option value="cartoon_bfactor">cartoon by B-factor / pLDDT</option></select></div>
      <button class="btn" data-a="pymol" style="width:100%;margin:2px" ${cap.pymol ? '' : 'disabled'}>PyMOL ray-traced render</button>
      ${cap.pymol ? '' : '<div class="hint" style="color:#c05621">PyMOL not installed</div>'}
      <button class="btn" data-a="blender" style="width:100%;margin:2px">Write Blender / Molecular Nodes script</button>
      <div class="hint">Molecular Nodes' scripting API is still changing, so GeneForge writes a script you run in Blender rather than driving it headlessly.</div>
      <div id="renderout"></div>`;
    let current = null;
    fetch('/api/structures').then(r => r.json()).then(d => {
      const list = p.querySelector('#stlist');
      if (!d.structures.length) { list.innerHTML = '<div class="empty">no .pdb / .cif here</div>'; return; }
      list.innerHTML = '';
      d.structures.forEach(st => {
        const row = document.createElement('div');
        row.className = 'row';
        row.innerHTML = `<span class="nm">${esc(st.name)}</span><span class="co">${(st.size / 1024).toFixed(0)}k</span>`;
        row.onclick = () => {
          current = st.path;
          p.querySelectorAll('#stlist .row').forEach(x => x.classList.remove('active'));
          row.classList.add('active');
          viewStructure(st.path);
        };
        list.appendChild(row);
      });
    }).catch(() => { });
    p.querySelector('[data-a=pymol]').onclick = e => {
      if (!current) return GF.toast('pick a structure first');
      const b = e.target; b.disabled = true; b.textContent = 'rendering…';
      GF.post('/api/render', { path: current, style: p.querySelector('[name=style]').value }).then(res => {
        b.disabled = false; b.textContent = 'PyMOL ray-traced render';
        p.querySelector('#renderout').innerHTML =
          `<div class="hint">${(res.size / 1024).toFixed(0)} kB · ${res.width}×${res.height}<br><span class="mono">${esc(res.png)}</span></div>`;
      }).catch(err => { b.disabled = false; b.textContent = 'PyMOL ray-traced render'; GF.toast(err.message, 7000); });
    };
    p.querySelector('[data-a=blender]').onclick = () => {
      if (!current) return GF.toast('pick a structure first');
      GF.post('/api/render', { path: current, engine: 'blender', style: p.querySelector('[name=style]').value })
        .then(res => p.querySelector('#renderout').innerHTML =
          `<div class="hint">Script written:<br><span class="mono">${esc(res.script)}</span><br>Open it in Blender's Scripting tab and press Run.</div>`)
        .catch(e => GF.toast(e.message, 5000));
    };
  }

  function viewStructure(path) {
    const host = $('#viewer3d');
    host.classList.remove('hidden');
    host.innerHTML = `<div class="v3-bar"><b>${esc(path.split('/').pop())}</b>
        <button data-s="cartoon">cartoon</button><button data-s="stick">sticks</button>
        <button data-s="sphere">spheres</button><button data-s="surface">surface</button>
        <button data-s="plddt">pLDDT</button><span style="flex:1"></span><button data-s="close">close</button>
      </div><div class="v3-canvas" id="v3canvas"></div>`;
    const canvas = host.querySelector('#v3canvas');
    fetch('/api/structure?path=' + encodeURIComponent(path)).then(r => r.text()).then(text => {
      if (typeof $3Dmol === 'undefined') { canvas.innerHTML = '<div class="empty" style="color:#8a94a0">3Dmol.js not vendored</div>'; return; }
      viewer = $3Dmol.createViewer(canvas, { backgroundColor: '#0f1216' });
      viewer.addModel(text, /\.cif$|\.mmcif$/i.test(path) ? 'cif' : 'pdb');
      applyStyle('cartoon'); viewer.zoomTo(); viewer.render();
    }).catch(e => canvas.innerHTML = `<div class="empty" style="color:#8a94a0">${esc(e.message)}</div>`);
    host.querySelectorAll('[data-s]').forEach(b => b.onclick = () => {
      if (b.dataset.s === 'close') { host.classList.add('hidden'); viewer = null; return; }
      applyStyle(b.dataset.s); if (viewer) viewer.render();
    });
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
  }

  Object.assign(GFPanels, { render, alignDialog, mutateDialog, af3Dialog, assemblyDialog,
    newSequenceDialog, newPrimerDialog, saveAsDialog, copyMenu, viewStructure, structurePanel });
})();
