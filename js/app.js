(function () {
  'use strict';

  /* ================= constants ================= */

  var DEFAULT_TITLE = 'HIIT Timer';
  var STORE_KEY = 'hiit-timer.v1';
  var RING_RADIUS = 118;
  var RING_C = 2 * Math.PI * RING_RADIUS;
  var MAX_HISTORY = 50;

  var PRESETS = [
    { id: 'classic', name: 'Classic HIIT', desc: '4 x 20s / 60s', rounds: 4, work: 20, rest: 60 },
    { id: 'tabata', name: 'Tabata', desc: '8 x 20s / 10s', rounds: 8, work: 20, rest: 10 },
    { id: 'hi3030', name: '30 / 30', desc: '8 x 30s / 30s', rounds: 8, work: 30, rest: 30 },
    { id: 'metcon', name: 'Metcon', desc: '6 x 40s / 20s', rounds: 6, work: 40, rest: 20 }
  ];

  /* ================= tiny helpers ================= */

  function $(sel) { return document.querySelector(sel); }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function fmt(sec) {
    sec = Math.max(0, Math.round(sec));
    return Math.floor(sec / 60) + ':' + pad2(sec % 60);
  }

  function clampInt(v, min, max, dflt) {
    var n = parseInt(v, 10);
    if (isNaN(n)) return dflt;
    return Math.min(max, Math.max(min, n));
  }

  /* ================= storage ================= */

  var store = {
    settings: { rounds: 4, work: 20, rest: 60 },
    preset: 'classic',
    prefs: { sound: true, vibrate: true },
    history: []
  };

  function loadStore() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return;
      if (data.settings && typeof data.settings === 'object') {
        store.settings.rounds = clampInt(data.settings.rounds, 1, 30, 4);
        store.settings.work = clampInt(data.settings.work, 5, 600, 20);
        store.settings.rest = clampInt(data.settings.rest, 0, 600, 60);
      }
      if (typeof data.preset === 'string') store.preset = data.preset;
      if (data.prefs && typeof data.prefs === 'object') {
        store.prefs.sound = data.prefs.sound !== false;
        store.prefs.vibrate = data.prefs.vibrate !== false;
      }
      if (Array.isArray(data.history)) store.history = data.history.slice(0, MAX_HISTORY);
    } catch (e) { /* corrupted storage — fall back to defaults */ }
  }

  function saveStore() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) { /* storage full/blocked */ }
  }

  function presetName() {
    for (var i = 0; i < PRESETS.length; i++) {
      if (PRESETS[i].id === store.preset) return PRESETS[i].name;
    }
    return 'Custom';
  }

  function matchPreset(s) {
    for (var i = 0; i < PRESETS.length; i++) {
      var p = PRESETS[i];
      if (p.rounds === s.rounds && p.work === s.work && p.rest === s.rest) return p.id;
    }
    return null;
  }

  /* ================= sound (Web Audio, no assets) ================= */

  var Sound = {
    ctx: null,
    ensure: function () {
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        if (!this.ctx) this.ctx = new AC();
        if (this.ctx.state === 'suspended') this.ctx.resume();
      } catch (e) { /* no audio — fine */ }
    },
    beep: function (freq, delay, dur, vol) {
      if (!store.prefs.sound || !this.ctx) return;
      try {
        var t = this.ctx.currentTime + (delay || 0);
        var d = dur || 0.18;
        var osc = this.ctx.createOscillator();
        var gain = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(vol || 0.25, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + d);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(t);
        osc.stop(t + d + 0.05);
      } catch (e) { /* ignore */ }
    },
    work: function () { this.beep(988, 0, 0.15); this.beep(988, 0.2, 0.15); },
    rest: function () { this.beep(494, 0, 0.3, 0.2); },
    done: function () {
      var notes = [523.25, 659.25, 783.99, 1046.5];
      for (var i = 0; i < notes.length; i++) this.beep(notes[i], i * 0.16, 0.22, 0.25);
    }
  };

  function buzz(pattern) {
    if (store.prefs.vibrate && navigator.vibrate) {
      try { navigator.vibrate(pattern); } catch (e) { /* ignore */ }
    }
  }

  /* ================= wake lock ================= */

  var wakeLock = null;

  function requestWakeLock() {
    try {
      if (navigator.wakeLock && navigator.wakeLock.request) {
        navigator.wakeLock.request('screen').then(function (lock) {
          wakeLock = lock;
          lock.addEventListener('release', function () {
            if (wakeLock === lock) wakeLock = null;
          });
        }).catch(function () { /* ignore */ });
      }
    } catch (e) { /* ignore */ }
  }

  function releaseWakeLock() {
    try { if (wakeLock && wakeLock.release) wakeLock.release().catch(function () {}); } catch (e) { /* ignore */ }
    wakeLock = null;
  }

  /* ================= elements ================= */

  var el = {};
  var body = document.body;

  function cacheElements() {
    el.time = $('#time');
    el.badge = $('#badge');
    el.roundInfo = $('#round-info');
    el.phaseLabel = $('#phase-label');
    el.ringFg = $('#ring-progress');
    el.dots = $('#dots');
    el.primary = $('#btn-primary');
    el.skip = $('#btn-skip');
    el.reset = $('#btn-reset');
    el.settingsCard = $('#settings-card');
    el.chips = Array.prototype.slice.call(document.querySelectorAll('.chip'));
    el.inRounds = $('#in-rounds');
    el.inWork = $('#in-work');
    el.inRest = $('#in-rest');
    el.summary = $('#summary');
    el.soundBtn = $('#btn-sound');
    el.vibrateBtn = $('#btn-vibrate');
    el.fullBtn = $('#btn-fullscreen');
    el.installBtn = $('#btn-install');
    el.historyList = $('#history-list');
    el.historyEmpty = $('#history-empty');
    el.clearHistory = $('#btn-clear-history');
  }

  /* ================= settings model ================= */

  function currentSettings() {
    return {
      rounds: clampInt(store.settings.rounds, 1, 30, 4),
      work: clampInt(store.settings.work, 5, 600, 20),
      rest: clampInt(store.settings.rest, 0, 600, 60)
    };
  }

  function totalSecOf(s) { return s.rounds * s.work + (s.rounds - 1) * s.rest; }

  function renderSummary() {
    var s = currentSettings();
    el.summary.textContent =
      s.rounds + ' round' + (s.rounds === 1 ? '' : 's') +
      ' · ' + fmt(s.work) + ' work · ' + fmt(s.rest) + ' rest · ' + fmt(totalSecOf(s)) + ' total';
    syncChips(s);
  }

  function syncChips(s) {
    var active = matchPreset(s);
    el.chips.forEach(function (chip) {
      chip.classList.toggle('active', chip.dataset.preset === active);
    });
  }

  function syncInputs() {
    var s = store.settings;
    el.inRounds.value = s.rounds;
    el.inWork.value = s.work;
    el.inRest.value = s.rest;
  }

  function applyInputsToStore() {
    var r = parseInt(el.inRounds.value, 10);
    var w = parseInt(el.inWork.value, 10);
    var rs = parseInt(el.inRest.value, 10);
    if (!isNaN(r)) store.settings.rounds = r;
    if (!isNaN(w)) store.settings.work = w;
    if (!isNaN(rs)) store.settings.rest = rs;
    store.settings = currentSettings();
    store.preset = matchPreset(store.settings) || 'custom';
    saveStore();
    renderSummary();
    if (timer.status === 'idle') { renderPhaseInfo(); renderDots(); }
  }

  function selectPreset(id) {
    var p = null;
    for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === id) p = PRESETS[i];
    if (!p) return;
    store.settings = { rounds: p.rounds, work: p.work, rest: p.rest };
    store.preset = p.id;
    saveStore();
    syncInputs();
    renderSummary();
    if (timer.status === 'idle') { renderPhaseInfo(); renderDots(); }
  }

  /* ================= timer engine ================= */

  var timer = {
    phases: [],
    index: 0,
    endsAt: 0,
    remainingMs: 0,
    totalMs: 0,
    status: 'idle' // idle | running | paused | done
  };

  function buildPhases(s) {
    var phases = [];
    for (var i = 0; i < s.rounds; i++) {
      phases.push({ type: 'work', seconds: s.work });
      if (i < s.rounds - 1 && s.rest > 0) phases.push({ type: 'rest', seconds: s.rest });
    }
    return phases;
  }

  function phaseMs(p) { return p.seconds * 1000; }

  function start() {
    var s = currentSettings();
    var phases = buildPhases(s);
    if (!phases.length) return;
    timer.phases = phases;
    timer.index = 0;
    timer.totalMs = totalSecOf(s) * 1000;
    timer.status = 'running';
    timer.endsAt = Date.now() + phaseMs(phases[0]);
    Sound.ensure();
    beginPhase(phases[0]);
    paint(phaseMs(phases[0])); // show the full first phase immediately
    releaseWakeLock();
    requestWakeLock();
    renderControls();
    renderDots();
  }

  function pause() {
    if (timer.status !== 'running') return;
    timer.remainingMs = Math.max(0, timer.endsAt - Date.now());
    timer.status = 'paused';
    body.dataset.phase = 'paused';
    renderControls();
    renderPhaseInfo();
  }

  function resume() {
    if (timer.status !== 'paused') return;
    timer.endsAt = Date.now() + timer.remainingMs;
    timer.status = 'running';
    body.dataset.phase = timer.phases[timer.index].type;
    lastSec = -1;
    renderControls();
    renderPhaseInfo();
    requestWakeLock();
  }

  function skip() {
    if (timer.status !== 'running' && timer.status !== 'paused') return;
    var now = Date.now();
    var paused = timer.status === 'paused';
    timer.index += 1;
    if (timer.index >= timer.phases.length) { finish(); return; }
    var p = timer.phases[timer.index];
    if (paused) {
      timer.remainingMs = phaseMs(p);
      paint(phaseMs(p)); // loop doesn't paint while paused, so refresh by hand
    } else {
      timer.endsAt = now + phaseMs(p);
    }
    beginPhase(p);
  }

  function reset() {
    timer.status = 'idle';
    timer.index = 0;
    timer.phases = buildPhases(currentSettings());
    body.dataset.phase = 'idle';
    releaseWakeLock();
    lastSec = -1;
    renderAll();
  }

  function advance(now) {
    // Fast-forward through every phase that has already ended. End times are
    // chained (old end + duration) so wall-clock time is never lost even if
    // the tab was throttled in the background and Date.now() jumped ahead.
    var guard = 0;
    while (timer.status === 'running' && now >= timer.endsAt) {
      timer.index += 1;
      if (timer.index >= timer.phases.length) {
        finish();
        return;
      }
      var p = timer.phases[timer.index];
      timer.endsAt += phaseMs(p);
      if (++guard > 10000) break; // safety valve
    }
    if (guard > 0 && timer.status === 'running') {
      beginPhase(timer.phases[timer.index]); // cue only the phase we land in
    }
  }

  function beginPhase(p) {
    body.dataset.phase = p.type;
    if (p.type === 'work') { Sound.work(); buzz([120]); }
    else { Sound.rest(); buzz([70]); }
    lastSec = -1;
    renderPhaseInfo();
    renderDots();
  }

  function finish() {
    timer.status = 'done';
    body.dataset.phase = 'done';
    Sound.done();
    buzz([180, 90, 180]);
    releaseWakeLock();
    var s = currentSettings();
    store.history.unshift({
      at: Date.now(),
      name: presetName(),
      rounds: s.rounds,
      work: s.work,
      rest: s.rest,
      totalSec: Math.round(timer.totalMs / 1000)
    });
    store.history = store.history.slice(0, MAX_HISTORY);
    saveStore();
    renderHistory();
    renderPhaseInfo();
    renderDots();
    renderControls();
  }

  /* ================= rendering ================= */

  var lastSec = -1;

  function loop() {
    if (timer.status === 'running') {
      var now = Date.now();
      advance(now); // no-op unless a phase boundary has been crossed
      if (timer.status === 'running') paint(timer.endsAt - now);
    }
    requestAnimationFrame(loop);
  }

  function paint(leftMs) {
    var p = timer.phases[timer.index];
    var dur = phaseMs(p);
    var frac = Math.min(1, Math.max(0, leftMs / dur));
    el.ringFg.style.strokeDashoffset = String(RING_C * (1 - frac));

    var sec = Math.ceil(leftMs / 1000);
    if (sec > p.seconds) sec = p.seconds;
    if (sec !== lastSec) {
      lastSec = sec;
      el.time.textContent = fmt(sec);
      el.time.classList.toggle('low', sec <= 3);
      document.title = fmt(sec) + ' · ' + (p.type === 'work' ? 'Work' : 'Rest') + ' — ' + DEFAULT_TITLE;
    }
  }

  function renderPhaseInfo() {
    var st = timer.status;
    var s = currentSettings();

    if (st === 'idle') {
      el.badge.textContent = 'Ready';
      el.roundInfo.textContent = s.rounds + ' rounds · ' + fmt(totalSecOf(s)) + ' total';
      el.phaseLabel.textContent = 'Ready';
      el.time.textContent = fmt(s.work);
      el.time.classList.remove('low');
      el.ringFg.style.strokeDashoffset = '0';
      document.title = DEFAULT_TITLE;
      lastSec = -1;
      return;
    }

    if (st === 'done') {
      el.badge.textContent = 'Done';
      el.roundInfo.textContent = 'Workout complete';
      el.phaseLabel.textContent = 'Complete';
      el.time.textContent = fmt(Math.round(timer.totalMs / 1000));
      el.time.classList.remove('low');
      el.ringFg.style.strokeDashoffset = '0';
      document.title = 'Done — ' + DEFAULT_TITLE;
      lastSec = -1;
      return;
    }

    var p = timer.phases[timer.index];
    var workCount = 0;
    for (var i = 0; i <= timer.index && i < timer.phases.length; i++) {
      if (timer.phases[i].type === 'work') workCount++;
    }
    el.badge.textContent = p.type === 'work' ? 'Work' : 'Rest';
    el.roundInfo.textContent = p.type === 'work'
      ? 'Round ' + workCount + ' of ' + s.rounds
      : 'Rest · after round ' + workCount;
    el.phaseLabel.textContent = st === 'paused' ? 'Paused' : (p.type === 'work' ? 'Go' : 'Recover');
    lastSec = -1;
  }

  function renderDots() {
    var s = currentSettings();
    // completed = work rounds whose work phase is finished
    var completed = 0;
    if (timer.status === 'running' || timer.status === 'paused') {
      var cur = timer.phases[timer.index];
      var upto = cur && cur.type === 'rest' ? timer.index : timer.index - 1;
      for (var i = 0; i <= upto; i++) {
        if (timer.phases[i] && timer.phases[i].type === 'work') completed++;
      }
    } else if (timer.status === 'done') {
      completed = s.rounds;
    }
    var inSession = timer.status === 'running' || timer.status === 'paused';
    el.dots.innerHTML = '';
    for (var r = 1; r <= s.rounds; r++) {
      var d = document.createElement('span');
      d.className = 'dot' +
        (r <= completed ? ' done' :
        r === completed + 1 && inSession ? ' active' : '');
      el.dots.appendChild(d);
    }
  }

  function renderControls() {
    var st = timer.status;
    el.primary.textContent =
      st === 'idle' ? 'Start' :
      st === 'running' ? 'Pause' :
      st === 'paused' ? 'Resume' : 'Again';
    el.skip.hidden = st !== 'running' && st !== 'paused';
    el.reset.hidden = st === 'idle';
    el.settingsCard.classList.toggle('locked', st === 'running' || st === 'paused');
  }

  function renderHistory() {
    var list = el.historyList;
    list.innerHTML = '';
    var h = store.history;
    el.clearHistory.hidden = h.length === 0;
    el.historyEmpty.hidden = h.length > 0;
    h.forEach(function (item) {
      var li = document.createElement('li');
      var dot = document.createElement('span');
      dot.className = 'h-dot';
      var main = document.createElement('div');
      main.className = 'h-main';
      var name = document.createElement('strong');
      name.textContent = item.name || 'Custom';
      var sub = document.createElement('div');
      sub.className = 'h-sub';
      sub.textContent = item.rounds + ' x ' + fmt(item.work) + ' / ' + fmt(item.rest);
      main.appendChild(name);
      main.appendChild(sub);
      var meta = document.createElement('span');
      meta.className = 'h-meta';
      try {
        var d = new Date(item.at);
        meta.textContent = fmt(item.totalSec) + ' · ' +
          d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
          d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      } catch (e) {
        meta.textContent = fmt(item.totalSec);
      }
      li.appendChild(dot);
      li.appendChild(main);
      li.appendChild(meta);
      list.appendChild(li);
    });
  }

  function renderPrefs() {
    el.soundBtn.setAttribute('aria-pressed', store.prefs.sound ? 'true' : 'false');
    el.vibrateBtn.setAttribute('aria-pressed', store.prefs.vibrate ? 'true' : 'false');
  }

  function renderAll() {
    syncInputs();
    renderSummary();
    renderHistory();
    renderPhaseInfo();
    renderDots();
    renderControls();
  }

  /* ================= primary action ================= */

  function onPrimary() {
    Sound.ensure();
    if (timer.status === 'idle' || timer.status === 'done') start();
    else if (timer.status === 'running') pause();
    else if (timer.status === 'paused') resume();
  }

  /* ================= events ================= */

  function wireEvents() {
    el.primary.addEventListener('click', onPrimary);
    el.skip.addEventListener('click', skip);
    el.reset.addEventListener('click', reset);

    el.chips.forEach(function (chip) {
      chip.addEventListener('click', function () { selectPreset(chip.dataset.preset); });
    });

    [el.inRounds, el.inWork, el.inRest].forEach(function (input) {
      input.addEventListener('input', applyInputsToStore);
      input.addEventListener('change', syncInputs);
    });

    el.clearHistory.addEventListener('click', function () {
      store.history = [];
      saveStore();
      renderHistory();
    });

    el.soundBtn.addEventListener('click', function () {
      store.prefs.sound = !store.prefs.sound;
      saveStore();
      renderPrefs();
      if (store.prefs.sound) Sound.ensure();
    });

    el.vibrateBtn.addEventListener('click', function () {
      store.prefs.vibrate = !store.prefs.vibrate;
      saveStore();
      renderPrefs();
    });

    el.fullBtn.addEventListener('click', function () {
      try {
        if (document.fullscreenElement) document.exitFullscreen();
        else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
      } catch (e) { /* ignore */ }
    });

    var deferredInstall = null;
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferredInstall = e;
      el.installBtn.hidden = false;
    });
    el.installBtn.addEventListener('click', function () {
      if (!deferredInstall) return;
      deferredInstall.prompt();
      deferredInstall.userChoice.then(function () {
        deferredInstall = null;
        el.installBtn.hidden = true;
      });
    });
    window.addEventListener('appinstalled', function () {
      el.installBtn.hidden = true;
    });

    document.addEventListener('keydown', function (e) {
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.code === 'Space') { e.preventDefault(); onPrimary(); }
      else if (e.key === 's' || e.key === 'S') skip();
      else if (e.key === 'r' || e.key === 'R') reset();
    });

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && timer.status === 'running') {
        requestWakeLock();
        lastSec = -1;
      }
    });
  }

  /* ================= init ================= */

  function init() {
    cacheElements();
    loadStore();
    el.ringFg.style.strokeDasharray = String(RING_C);
    el.ringFg.style.strokeDashoffset = '0';
    renderPrefs();
    renderAll();
    wireEvents();
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').catch(function () { /* not eligible (e.g. http) */ });
      });
    }
    requestAnimationFrame(loop);
  }

  init();
})();
