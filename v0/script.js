(() => {
  'use strict';

  /* ============ Pace model ============
     CPS = characters per second of subtitle text.
     Thresholds tuned for TTS intelligibility: a synthesized voice
     reading faster than ~21 cps starts to sound rushed/garbled,
     while very low cps usually means a long silent gap, not a problem
     for the voice itself but worth knowing about. */
  const PACE = {
    good:    { key:'good',    label:'Good pace',   icon:'check_circle',  color:'#00B0A0', max:15 },
    fast:    { key:'fast',    label:'Fast',        icon:'trending_up',   color:'#F2A72E', max:21 },
    toofast: { key:'toofast', label:'Too fast — consider merging', icon:'priority_high', color:'#E15554', max:Infinity },
    slow:    { key:'slow',    label:'Slow / long pause', icon:'hourglass_bottom', color:'#6C7BC7', max:0 }
  };

  function classifyPace(cps){
    if (!isFinite(cps)) return PACE.slow;
    if (cps < 6) return PACE.slow;
    if (cps < 15) return PACE.good;
    if (cps < 21) return PACE.fast;
    return PACE.toofast;
  }

  /* ============ Time helpers ============ */
  function srtTimeToSeconds(str){
    const m = String(str).trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
    if (!m) return NaN;
    const [ , h, mi, s, ms ] = m;
    return (+h)*3600 + (+mi)*60 + (+s) + (+ms.padEnd(3,'0'))/1000;
  }
  function secondsToSrtTime(total){
    if (!isFinite(total) || total < 0) total = 0;
    const h = Math.floor(total/3600);
    const mi = Math.floor((total%3600)/60);
    const s = Math.floor(total%60);
    const ms = Math.round((total - Math.floor(total))*1000);
    const pad = (n,l=2)=>String(n).padStart(l,'0');
    return `${pad(h)}:${pad(mi)}:${pad(s)},${pad(ms,3)}`;
  }

  /* ============ SRT parse / build ============ */
  function parseSrt(raw){
    const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g,'\n').replace(/\r/g,'\n').trim();
    const blocks = text.split(/\n\s*\n/);
    const cues = [];
    let autoId = 1;
    for (const block of blocks){
      const lines = block.split('\n').filter(l => l.length || true);
      if (!lines.length) continue;
      let idx = 0;
      let firstLine = lines[0].trim();
      let cursor = 0;
      let indexVal = autoId;
      if (/^\d+$/.test(firstLine)){
        indexVal = parseInt(firstLine,10);
        cursor = 1;
      }
      const timeLine = lines[cursor] || '';
      const tm = timeLine.match(/(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/);
      if (!tm) continue;
      const start = srtTimeToSeconds(tm[1]);
      const end = srtTimeToSeconds(tm[2]);
      const textLines = lines.slice(cursor+1);
      const cueText = textLines.join('\n').trim();
      cues.push({
        id: 'c'+(autoId++)+'_'+Math.random().toString(36).slice(2,7),
        index: indexVal,
        start, end,
        text: cueText
      });
    }
    return cues;
  }

  function buildSrt(cues){
    return cues.map((c,i) => {
      return `${i+1}\n${secondsToSrtTime(c.start)} --> ${secondsToSrtTime(c.end)}\n${c.text}\n`;
    }).join('\n').trim() + '\n';
  }

  /* ============ Metrics ============ */
  function metricsFor(cue){
    const duration = Math.max(0, cue.end - cue.start);
    const length = cue.text.replace(/\n/g,' ').length;
    const cps = duration > 0 ? length/duration : Infinity;
    return { duration, length, cps, pace: classifyPace(cps) };
  }

  /* ============ State ============ */
  let cues = [];
  let openMenuId = null;
  let sourceFileName = '';

  /* ============ DOM refs ============ */
  const $ = sel => document.querySelector(sel);
  const menuToggle = $('#menuToggle');
  const sideNav = $('#sideNav');
  const scrim = $('#scrim');
  const navItems = document.querySelectorAll('.nav-item');
  const pages = document.querySelectorAll('.page');
  const fileInput = $('#fileInput');
  const fileNameEl = $('#fileName');
  const saveBtn = $('#saveBtn');
  const editorEmpty = $('#editorEmpty');
  const cueListWrap = $('#cueListWrap');
  const cueListEl = $('#cueList');
  const cueSummaryEl = $('#cueSummary');
  const legendEl = $('#legend');
  const toastEl = $('#toast');
  const jumbotronCta = $('#jumbotronCta');

  /* ============ Navigation ============ */
  function showPage(name){
    pages.forEach(p => p.classList.toggle('active', p.id === `page-${name}`));
    navItems.forEach(n => n.classList.toggle('active', n.dataset.page === name));
    if (window.innerWidth <= 900) setNavOpen(false);
  }
  function currentPageFromHash(){
    const h = location.hash.replace('#','');
    return (h === 'editor') ? 'editor' : 'home';
  }
  navItems.forEach(item => {
    item.addEventListener('click', e => {
      e.preventDefault();
      location.hash = item.dataset.page;
    });
  });
  window.addEventListener('hashchange', () => showPage(currentPageFromHash()));
  jumbotronCta.addEventListener('click', () => { location.hash = 'editor'; });

  function setNavOpen(open){
    sideNav.classList.toggle('collapsed', !open);
    document.body.classList.toggle('nav-open', open);
    menuToggle.setAttribute('aria-expanded', String(open));
  }
  let navOpen = window.innerWidth > 900;
  setNavOpen(navOpen);
  menuToggle.addEventListener('click', () => { navOpen = !navOpen; setNavOpen(navOpen); });
  scrim.addEventListener('click', () => { navOpen = false; setNavOpen(false); });

  /* ============ Jumbotron waveform decoration ============ */
  (function drawWave(){
    const g = document.querySelector('.wave-bars');
    if (!g) return;
    const n = 60;
    let html = '';
    for (let i=0;i<n;i++){
      const h = 10 + Math.abs(Math.sin(i*0.4))*80 + Math.random()*15;
      const x = i*(600/n);
      html += `<rect x="${x.toFixed(1)}" y="${(120-h).toFixed(1)}" width="${(600/n-3).toFixed(1)}" height="${h.toFixed(1)}" rx="2"></rect>`;
    }
    g.innerHTML = html;
  })();

  /* ============ Toast ============ */
  let toastTimer = null;
  function toast(msg){
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(()=> toastEl.classList.remove('show'), 2200);
  }

  /* ============ Legend ============ */
  function renderLegend(){
    legendEl.innerHTML = Object.values(PACE).map(p => `
      <span class="legend-item"><span class="legend-dot" style="background:${p.color}"></span>${p.label.split(' —')[0]}</span>
    `).join('');
  }
  renderLegend();

  /* ============ File loading ============ */
  fileInput.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = parseSrt(reader.result);
      if (!parsed.length){
        toast('Could not find any cues in that file.');
        return;
      }
      cues = parsed;
      sourceFileName = file.name;
      fileNameEl.textContent = file.name;
      saveBtn.disabled = false;
      editorEmpty.hidden = true;
      cueListWrap.hidden = false;
      renderCues();
      toast(`Loaded ${cues.length} cues from ${file.name}`);
    };
    reader.onerror = () => toast('Could not read that file.');
    reader.readAsText(file);
    fileInput.value = '';
  });

  /* ============ Rendering ============ */
  function renderSummary(){
    const total = cues.length;
    let flagged = 0;
    let totalDur = 0;
    cues.forEach(c => {
      const m = metricsFor(c);
      totalDur += m.duration;
      if (m.pace.key === 'toofast') flagged++;
    });
    cueSummaryEl.innerHTML = `
      <span><b>${total}</b> cues</span>
      <span><b>${totalDur.toFixed(1)}s</b> total speech time</span>
      <span><b>${flagged}</b> too fast for comfortable TTS</span>
    `;
  }

  function fmtCps(cps){ return isFinite(cps) ? cps.toFixed(1) : '∞'; }

  function renderCues(){
    renderSummary();
    cueListEl.innerHTML = cues.map((c, i) => {
      const m = metricsFor(c);
      const barPct = Math.min(100, (isFinite(m.cps) ? m.cps : 30) / 26 * 100);
      return `
      <div class="cue-row pace-${m.pace.key}" data-id="${c.id}">
        <div class="cue-index">
          <input type="text" class="idx-input" data-field="index" value="${c.index}" aria-label="Cue index">
        </div>
        <div class="cue-main">
          <div class="cue-times">
            <input type="text" class="time-input" data-field="start" value="${secondsToSrtTime(c.start)}" aria-label="Start time">
            <span class="material-symbols-outlined time-arrow">arrow_right_alt</span>
            <input type="text" class="time-input" data-field="end" value="${secondsToSrtTime(c.end)}" aria-label="End time">
          </div>
          <textarea class="cue-text" data-field="text" rows="2" aria-label="Subtitle text">${escapeHtml(c.text)}</textarea>
          <div class="cue-metrics">
            <span class="metric-chip"><span class="material-symbols-outlined">timer</span>${m.duration.toFixed(2)}s</span>
            <span class="metric-chip"><span class="material-symbols-outlined">text_fields</span>${m.length} chars</span>
            <span class="metric-chip pace-chip"><span class="material-symbols-outlined">${m.pace.icon}</span>${fmtCps(m.cps)} cps · ${m.pace.label.split(' —')[0]}</span>
          </div>
          <div class="pace-bar-track"><div class="pace-bar-fill" style="width:${barPct}%"></div></div>
        </div>
        <div class="cue-actions">
          <button class="kebab-btn" data-action="menu" aria-label="Cue options" aria-haspopup="true">
            <span class="material-symbols-outlined">more_vert</span>
          </button>
          <div class="cue-menu" data-menu>
            <button data-action="merge-next" ${i === cues.length-1 ? 'disabled' : ''}>
              <span class="material-symbols-outlined">vertical_align_bottom</span>
              Merge with next<span class="cue-menu-shortcut">Alt+M</span>
            </button>
            <button data-action="merge-prev" ${i === 0 ? 'disabled' : ''}>
              <span class="material-symbols-outlined">vertical_align_top</span>
              Merge with previous<span class="cue-menu-shortcut">Alt+Shift+M</span>
            </button>
            <div class="cue-menu-divider"></div>
            <button data-action="delete" class="danger">
              <span class="material-symbols-outlined">delete</span>
              Remove cue<span class="cue-menu-shortcut">Alt+Del</span>
            </button>
          </div>
        </div>
      </div>`;
    }).join('');
  }

  function escapeHtml(str){
    return str.replace(/[&<>]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[ch]));
  }

  function findCue(id){ return cues.find(c => c.id === id); }
  function findIndexById(id){ return cues.findIndex(c => c.id === id); }

  function updateRowMetricsOnly(row, cue){
    const m = metricsFor(cue);
    row.className = `cue-row pace-${m.pace.key}`;
    row.querySelector('.cue-metrics').innerHTML = `
      <span class="metric-chip"><span class="material-symbols-outlined">timer</span>${m.duration.toFixed(2)}s</span>
      <span class="metric-chip"><span class="material-symbols-outlined">text_fields</span>${m.length} chars</span>
      <span class="metric-chip pace-chip"><span class="material-symbols-outlined">${m.pace.icon}</span>${fmtCps(m.cps)} cps · ${m.pace.label.split(' —')[0]}</span>
    `;
    const barPct = Math.min(100, (isFinite(m.cps) ? m.cps : 30) / 26 * 100);
    row.querySelector('.pace-bar-fill').style.width = barPct + '%';
    renderSummary();
  }

  /* ============ Editing ============ */
  cueListEl.addEventListener('input', e => {
    const row = e.target.closest('.cue-row');
    if (!row) return;
    const cue = findCue(row.dataset.id);
    if (!cue) return;
    const field = e.target.dataset.field;
    if (field === 'text'){
      cue.text = e.target.value;
      updateRowMetricsOnly(row, cue);
    } else if (field === 'index'){
      const v = parseInt(e.target.value,10);
      cue.index = isNaN(v) ? cue.index : v;
    } else if (field === 'start' || field === 'end'){
      const secs = srtTimeToSeconds(e.target.value);
      e.target.classList.toggle('invalid', isNaN(secs));
      if (!isNaN(secs)){
        cue[field] = secs;
        updateRowMetricsOnly(row, cue);
      }
    }
  });

  cueListEl.addEventListener('blur', e => {
    if (!e.target.classList || !e.target.classList.contains('time-input')) return;
    const row = e.target.closest('.cue-row');
    const cue = findCue(row.dataset.id);
    const field = e.target.dataset.field;
    // snap back to a clean formatted value if valid, else restore last good value
    const secs = srtTimeToSeconds(e.target.value);
    if (isNaN(secs)){
      e.target.value = secondsToSrtTime(cue[field]);
      e.target.classList.remove('invalid');
      toast('That time didn\u2019t look like HH:MM:SS,mmm — reverted.');
    } else {
      e.target.value = secondsToSrtTime(secs);
    }
  }, true);

  /* ============ Menu + actions ============ */
  cueListEl.addEventListener('click', e => {
    const menuBtn = e.target.closest('[data-action="menu"]');
    if (menuBtn){
      const row = menuBtn.closest('.cue-row');
      const menu = row.querySelector('[data-menu]');
      const isOpen = menu.classList.contains('open');
      closeAllMenus();
      if (!isOpen){ menu.classList.add('open'); openMenuId = row.dataset.id; }
      return;
    }
    const actionBtn = e.target.closest('[data-action]');
    if (actionBtn && !actionBtn.disabled){
      const action = actionBtn.dataset.action;
      const row = actionBtn.closest('.cue-row');
      if (['merge-next','merge-prev','delete'].includes(action)){
        performAction(action, row.dataset.id);
      }
    }
    if (!e.target.closest('.cue-menu') && !e.target.closest('[data-action="menu"]')){
      closeAllMenus();
    }
  });

  function closeAllMenus(){
    document.querySelectorAll('.cue-menu.open').forEach(m => m.classList.remove('open'));
    openMenuId = null;
  }
  document.addEventListener('click', e => {
    if (!e.target.closest('.cue-actions')) closeAllMenus();
  });

  function performAction(action, id){
    const idx = findIndexById(id);
    if (idx === -1) return;
    if (action === 'delete'){
      cues.splice(idx,1);
      toast('Cue removed.');
    } else if (action === 'merge-next' && idx < cues.length-1){
      mergeCues(idx, idx+1);
      toast('Merged with next cue.');
    } else if (action === 'merge-prev' && idx > 0){
      mergeCues(idx-1, idx);
      toast('Merged with previous cue.');
    }
    closeAllMenus();
    renderCues();
  }

  function mergeCues(iFirst, iSecond){
    const a = cues[iFirst], b = cues[iSecond];
    const merged = {
      id: a.id,
      index: a.index,
      start: a.start,
      end: b.end,
      text: [a.text, b.text].filter(Boolean).join(' ')
    };
    cues.splice(iFirst, 2, merged);
  }

  /* ============ Keyboard shortcuts ============ */
  cueListEl.addEventListener('keydown', e => {
    if (!e.altKey) return;
    const row = e.target.closest('.cue-row');
    if (!row) return;
    const id = row.dataset.id;
    if (e.key.toLowerCase() === 'm' && e.shiftKey){
      e.preventDefault(); performAction('merge-prev', id);
    } else if (e.key.toLowerCase() === 'm'){
      e.preventDefault(); performAction('merge-next', id);
    } else if (e.key === 'Delete' || e.key === 'Backspace'){
      e.preventDefault(); performAction('delete', id);
    }
  });

  /* ============ Save ============ */
  saveBtn.addEventListener('click', () => {
    if (!cues.length){ toast('Nothing to save yet.'); return; }
    const srt = buildSrt(cues);
    const blob = new Blob([srt], { type:'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const base = sourceFileName ? sourceFileName.replace(/\.srt$/i,'') : 'edited';
    a.href = url;
    a.download = `${base}.edited.srt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('SRT file saved.');
  });

  /* ============ Init ============ */
  showPage(currentPageFromHash());
})();
