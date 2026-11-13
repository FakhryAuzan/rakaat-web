'use strict';
/* Rakaat Counter (web): counts rakaat by detecting sujood with the front camera.
   Every 2 sujood = 1 rakaat. Same logic as the Android app's Camera mode. */

// ---------------- Data ----------------
const PRAYERS = [
  ['fajr', 'Fajr', 2, false], ['dhuhr', 'Dhuhr', 4, false], ['asr', 'Asr', 4, false],
  ['maghrib', 'Maghrib', 3, false], ['isha', 'Isha', 4, false], ['jumuah', "Jumu'ah", 2, false],
  ['q_fajr', 'Qabliyah Fajr', 2, true], ['q_dhuhr', 'Qabliyah Dhuhr', 2, true], ['b_dhuhr', "Ba'diyah Dhuhr", 2, true],
  ['q_asr', 'Qabliyah Asr', 4, true], ['b_maghrib', "Ba'diyah Maghrib", 2, true], ['q_isha', 'Qabliyah Isha', 2, true],
  ['b_isha', "Ba'diyah Isha", 2, true], ['dhuha', 'Dhuha', 2, true], ['tahajjud', 'Tahajjud', 2, true],
  ['witr', 'Witr', 3, true], ['tarawih', 'Tarawih', 2, true], ['tahiyyat', 'Tahiyyatul Masjid', 2, true],
  ['istikharah', 'Istikharah', 2, true], ['custom', 'Custom', 2, true],
].map(([id, name, def, adj]) => ({ id, name, def, adj }));

const DEFAULT_PROFILE = { primary: 'face', faceRuku: 0.12, faceRukuRate: 0.5, faceSujood: 0.35, faceSujoodRate: 0.9, lumaRukuRel: 0, lumaSujoodRel: 0 };
const DEFAULTS = {
  startDelay: 5, statusLight: true, warnMistakes: true, missedRuku: 'yellow', completion: 'beep',
  theme: 'system', glow: true, readout: false, prayerId: 'fajr', counts: {}, profile: null,
};

let S = loadSettings();
function loadSettings() {
  try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('rc_settings') || '{}')); }
  catch (e) { return Object.assign({}, DEFAULTS); }
}
function save() { try { localStorage.setItem('rc_settings', JSON.stringify(S)); } catch (e) { /* storage unavailable */ } }

const prayerById = id => PRAYERS.find(p => p.id === id) || PRAYERS[0];
const rakaatFor = p => (p.adj ? (S.counts[p.id] || p.def) : p.def);
const median = v => { const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => performance.now();
const $ = id => document.getElementById(id);
const pct = v => Math.round(v * 100) + '%';

// ---------------- Sound / vibration ----------------
let audio = null;
function unlockAudio() {
  try {
    if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
  } catch (e) { audio = null; }
}
function beep(count = 1, long = false) {
  if (!audio) return;
  const dur = long ? 0.6 : 0.12, gap = 0.18;
  for (let i = 0; i < count; i++) {
    const t = audio.currentTime + i * (dur + gap);
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = long ? 660 : 880;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(audio.destination);
    o.start(t); o.stop(t + dur + 0.05);
  }
}
function vibrate(pattern) { try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) { /* not supported */ } }

// ---------------- Keep the screen awake ----------------
const Awake = {
  lock: null,
  async on() {
    try { if ('wakeLock' in navigator) this.lock = await navigator.wakeLock.request('screen'); } catch (e) { this.lock = null; }
    try { await $('keepawake').play(); } catch (e) { /* fallback not allowed */ }
  },
  off() {
    try { if (this.lock) this.lock.release(); } catch (e) { /* ignore */ }
    this.lock = null;
    try { $('keepawake').pause(); } catch (e) { /* ignore */ }
  },
};

// ---------------- Camera ----------------
const Cam = {
  stream: null, running: false, onReading: null, modelReady: false,
  canvas: document.createElement('canvas'), ctx: null,
  async loadModel() {
    if (this.modelReady) return;
    await faceapi.nets.tinyFaceDetector.loadFromUri('models');
    this.modelReady = true;
  },
  async start(onReading) {
    this.onReading = onReading;
    const video = $('cam');
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false,
    });
    video.srcObject = this.stream;
    try { await video.play(); } catch (e) { /* autoplay will start it */ }
    await this.loadModel();
    this.running = true;
    this.loop();
  },
  stop() {
    this.running = false;
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = null;
    $('cam').srcObject = null;
  },
  luma(video) {
    const w = 48, h = 36;
    if (!this.ctx) { this.canvas.width = w; this.canvas.height = h; this.ctx = this.canvas.getContext('2d', { willReadFrequently: true }); }
    this.ctx.drawImage(video, 0, 0, w, h);
    const d = this.ctx.getImageData(0, 0, w, h).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    return sum / (w * h);
  },
  async loop() {
    const video = $('cam');
    const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.4 });
    while (this.running) {
      const t0 = now();
      try {
        if (video.readyState >= 2 && video.videoWidth > 0) {
          const luma = this.luma(video);
          const det = await faceapi.detectSingleFace(video, opts);
          const r = { time: now(), faceFound: !!det, faceSize: det ? det.box.width / video.videoWidth : 0, luma };
          if (this.running && this.onReading) this.onReading(r);
        }
      } catch (e) { console.warn(e); }
      await sleep(Math.max(30, 80 - (now() - t0)));
    }
  },
};

// ---------------- Posture classifier (0 far, 1 ruku, 2 sujood) ----------------
class CameraClassifier {
  constructor(p) {
    this.p = p;
    this.faceMode = p.primary === 'face';
    this.dir = p.lumaSujoodRel >= 0 ? 1 : -1;
    this.lumaS = Math.abs(p.lumaSujoodRel);
    this.lumaR = this.dir * p.lumaRukuRel;
    this.rukuDetectable = this.faceMode
      ? (p.faceRukuRate >= 0.4 && p.faceRuku > 0.03 && p.faceRuku <= 0.75 * p.faceSujood)
      : (this.lumaR >= 0.06 && this.lumaR <= 0.75 * this.lumaS);
    this.level = 0; this.lumaBase = NaN; this.lastLuma = NaN; this.sFace = 0; this.sLuma = 0;
    this.baseline = []; this.collecting = false; this.warning = null;
  }
  beginBaseline() { this.baseline = []; this.collecting = true; this.level = 0; }
  endBaseline() {
    this.collecting = false;
    const t = now();
    let v = this.baseline.filter(b => t - b[0] <= 1500).map(b => b[1]);
    if (!v.length) v = this.baseline.map(b => b[1]);
    this.lumaBase = v.length ? median(v) : this.lastLuma;
    this.warning = (!this.faceMode && isNaN(this.lumaBase)) ? 'No picture from the camera' : null;
  }
  levelFor(s, nearEnter, nearExit, midEnter, midExit) {
    if (s >= nearEnter || (this.level === 2 && s >= nearExit)) return 2;
    if (midEnter != null && (s >= midEnter || (this.level >= 1 && s >= midExit))) return 1;
    return 0;
  }
  feed(r) {
    if (!isNaN(r.luma)) this.lastLuma = r.luma;
    if (this.collecting) { if (!isNaN(r.luma)) this.baseline.push([r.time, r.luma]); return; }
    const p = this.p;
    if (isNaN(this.lumaBase) && !isNaN(r.luma)) { this.lumaBase = r.luma; this.warning = null; }
    this.sLuma = (isNaN(this.lumaBase) || isNaN(r.luma)) ? 0 : this.dir * (r.luma - this.lumaBase) / Math.max(this.lumaBase, 8);
    this.sFace = r.faceFound ? r.faceSize : 0;
    let l;
    if (this.faceMode) {
      l = this.levelFor(this.sFace, 0.7 * p.faceSujood, 0.5 * p.faceSujood,
        this.rukuDetectable ? 0.7 * p.faceRuku : null, this.rukuDetectable ? 0.5 * p.faceRuku : null);
      // Face too close to be recognised: hold "sujood" while the picture still looks like sujood.
      if (l < 2 && this.level === 2 && this.lumaS >= 0.15 && this.sLuma >= 0.5 * this.lumaS) l = 2;
    } else {
      l = this.levelFor(this.sLuma, 0.6 * this.lumaS, 0.35 * this.lumaS,
        this.rukuDetectable ? 0.6 * this.lumaR : null, this.rukuDetectable ? 0.4 * this.lumaR : null);
    }
    this.level = l;
    if (l === 0 && !isNaN(r.luma) && !isNaN(this.lumaBase)) this.lumaBase = 0.98 * this.lumaBase + 0.02 * r.luma;
  }
  readout() {
    return `${this.faceMode ? 'face' : 'brightness'} mode | face ${this.sFace.toFixed(2)} (sujood at ${(0.7 * this.p.faceSujood).toFixed(2)}) | luma ${Math.round(this.lastLuma)} base ${Math.round(this.lumaBase)}`;
  }
}

// ---------------- Rakaat counter (state machine) ----------------
const SUJOOD_HOLD_MS = 700, RELEASE_MS = 500, ARM_MS = 2000, RUKU_HOLD_MS = 300, CONFIRM_MS = 300;

class RakaatCounter {
  constructor(target) { this.target = target; this.warnMistakes = true; this.missedRukuYellow = true; this.rukuDetectable = true; this.onChange = () => {}; this.onTarget = () => {}; this.reset(true); }
  reset(silent) {
    this.rakaat = 0; this.sujoodTotal = 0; this.sujoodInRakaat = 0; this.rukuDone = false;
    this.status = 'green'; this.message = null; this.pendingNew = false; this.rukuMissing = false;
    this.resetMotion();
    if (!silent) this.onChange();
  }
  resetMotion() {
    this.inSujood = false; this.nearSince = -1; this.notNearSince = -1; this.farSince = -1; this.midSince = -1;
    this.rukuArmed = true; this.rukuCandidate = false;
  }
  tick(t, level) {
    if (level === 2) {
      this.notNearSince = -1;
      if (this.nearSince < 0) this.nearSince = t;
      if (!this.inSujood && t - this.nearSince >= SUJOOD_HOLD_MS) {
        this.inSujood = true; this.rukuArmed = false; this.rukuCandidate = false; this.onSujood();
      }
    } else {
      this.nearSince = -1;
      if (this.inSujood) {
        if (this.notNearSince < 0) this.notNearSince = t;
        if (t - this.notNearSince >= RELEASE_MS) this.inSujood = false;
      }
    }
    if (this.inSujood) { this.farSince = -1; this.midSince = -1; return; }
    // Ruku = far -> mid (held) -> far again. Going down into sujood (mid -> near) doesn't count.
    if (level === 0) {
      this.midSince = -1;
      if (this.farSince < 0) this.farSince = t;
      if (!this.rukuArmed && t - this.farSince >= ARM_MS) this.rukuArmed = true;
      if (this.rukuCandidate && t - this.farSince >= CONFIRM_MS) { this.rukuCandidate = false; this.onRuku(); }
    } else if (level === 1) {
      this.farSince = -1;
      if (this.midSince < 0) this.midSince = t;
      if (this.rukuArmed && t - this.midSince >= RUKU_HOLD_MS) this.rukuCandidate = true;
    } else {
      this.farSince = -1; this.midSince = -1; this.rukuCandidate = false;
    }
  }
  startNewRakaat() { this.sujoodInRakaat = 0; this.rukuDone = false; this.rukuMissing = false; this.pendingNew = false; }
  onRuku() {
    if (this.pendingNew) this.startNewRakaat();
    if (this.sujoodInRakaat === 1 && this.warnMistakes) this.flag('red', `Only 1 sujood detected in rakaat ${this.rakaat + 1}`);
    this.rukuDone = true;
    this.onChange();
  }
  onSujood() {
    if (this.pendingNew) this.startNewRakaat();
    if (this.sujoodInRakaat === 0 && !this.rukuDone && this.rukuDetectable) this.rukuMissing = true;
    this.sujoodInRakaat++; this.sujoodTotal++;
    if (this.sujoodInRakaat >= 2) {
      this.rakaat++; this.pendingNew = true;
      if (this.rukuMissing && this.rukuDetectable && this.missedRukuYellow) this.flag('yellow', `Ruku not detected in rakaat ${this.rakaat}`);
      if (this.rakaat > this.target && this.warnMistakes) this.flag('red', `More than ${this.target} rakaat counted`);
      if (this.rakaat === this.target) this.onTarget();
    }
    this.onChange();
  }
  flag(s, msg) { if (s === 'red' || this.status !== 'red') { this.status = s; this.message = msg; } }
}

// ---------------- Main screen ----------------
const counter = new RakaatCounter(rakaatFor(prayerById(S.prayerId)));
let state = 'idle'; // idle | countdown | running
let classifier = null, countdownEnd = 0, lastReadingAt = 0, ticker = null, defaultsAccepted = false;

counter.onChange = render;
counter.onTarget = () => {
  if (S.completion === 'beep') beep(1, true);
  else if (S.completion === 'vibrate') vibrate(600);
  render();
};

function applyCounterSettings() {
  counter.warnMistakes = S.warnMistakes;
  counter.missedRukuYellow = S.missedRuku === 'yellow';
}

async function requestStart() {
  unlockAudio();
  if (!S.profile && !defaultsAccepted) {
    const go = await dialog('Not calibrated yet',
      'Calibrating takes about 30 seconds and makes counting much more accurate for your phone, mat and room.',
      'Calibrate now', 'Use defaults');
    if (go) { openCalibration(); return; }
    defaultsAccepted = true;
  }
  startSession();
}

async function startSession() {
  const c = new CameraClassifier(S.profile || DEFAULT_PROFILE);
  setBusy(true);
  try {
    await Cam.start(r => { lastReadingAt = r.time; if (classifier) classifier.feed(r); });
  } catch (e) {
    setBusy(false);
    Cam.stop();
    dialog('Camera unavailable', cameraErrorText(e), 'OK', null);
    return;
  }
  setBusy(false);
  classifier = c;
  applyCounterSettings();
  counter.rukuDetectable = c.rukuDetectable;
  counter.resetMotion();
  Awake.on();
  c.beginBaseline();
  lastReadingAt = now();
  countdownEnd = now() + S.startDelay * 1000;
  state = 'countdown';
  clearInterval(ticker);
  ticker = setInterval(onTick, 100);
  render();
}

function stopSession() {
  Cam.stop();
  Awake.off();
  classifier = null;
  state = 'idle';
  clearInterval(ticker);
  ticker = null;
  render();
}

function onTick() {
  const t = now();
  if (!classifier) return;
  if (state === 'countdown' && t >= countdownEnd) {
    classifier.endBaseline();
    state = 'running';
    beep(1);
    vibrate(150);
  } else if (state === 'running') {
    counter.tick(t, classifier.level);
  }
  render();
}

function cameraErrorText(e) {
  const name = e && e.name;
  if (name === 'NotAllowedError') return 'Camera access was blocked. Allow camera access for this site (Safari: aA menu → Website Settings → Camera → Allow) and try again.';
  if (name === 'NotFoundError') return 'No front camera was found.';
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return 'The camera only works when the page is opened over https.';
  return 'Could not start the camera: ' + (e && e.message ? e.message : e);
}

function setBusy(b) { $('btnStart').disabled = b; if (b) $('btnStart').textContent = 'Starting…'; }

function render() {
  const p = prayerById(S.prayerId);
  const target = counter.target;
  const t = now();
  $('prayerLabel').textContent = `${p.name} · ${target}`;
  document.body.classList.toggle('glow', S.glow && state !== 'idle');

  const big = $('big');
  big.classList.remove('countdown', 'over');
  if (state === 'countdown') {
    big.textContent = Math.max(0, Math.ceil((countdownEnd - t) / 1000));
    big.classList.add('countdown');
    $('state').textContent = 'Get into position…';
  } else {
    big.textContent = counter.rakaat;
    if (counter.rakaat > target) big.classList.add('over');
    $('state').textContent = counter.rakaat === target ? '✓ Complete'
      : counter.rakaat > target ? 'Over target'
      : state === 'running' ? 'Counting'
      : counter.sujoodTotal > 0 ? 'Paused' : 'Ready';
  }
  $('target').textContent = `of ${target} rakaat`;

  $('dotRuku').classList.toggle('on', counter.rukuDone);
  $('indRuku').classList.toggle('na', !counter.rukuDetectable);
  $('rukuLabel').textContent = counter.rukuDetectable ? 'Ruku' : 'Ruku (n/a)';
  $('dotS1').classList.toggle('on', counter.sujoodInRakaat >= 1);
  $('dotS2').classList.toggle('on', counter.sujoodInRakaat >= 2);
  $('total').textContent = `Total sujood: ${counter.sujoodTotal}`;

  $('statusRow').hidden = !S.statusLight;
  let transient = null;
  if (state === 'running' && classifier) {
    if (classifier.warning) transient = classifier.warning;
    else if (t - lastReadingAt > 2500) transient = 'Camera not responding';
  }
  const notStarted = state === 'idle' && counter.sujoodTotal === 0 && counter.status === 'green';
  let color = 'green', text = 'On track';
  if (notStarted) { color = ''; text = 'Not started'; }
  else if (state === 'countdown') { color = ''; text = 'Measuring the room…'; }
  else if (counter.status === 'red') { color = 'red'; text = counter.message || 'Check your count'; }
  else if (transient) { color = 'yellow'; text = transient; }
  else if (counter.status === 'yellow') { color = 'yellow'; text = counter.message || 'Unsure'; }
  $('statusDot').className = 'status-dot ' + color;
  $('statusText').textContent = text;

  const ro = $('readout');
  ro.hidden = !(S.readout && classifier);
  if (!ro.hidden) ro.textContent = `level ${classifier.level} | ` + classifier.readout();

  if (!$('btnStart').disabled) {
    $('btnStart').textContent = state === 'idle' ? (counter.sujoodTotal > 0 ? 'Resume' : 'Start')
      : state === 'countdown' ? 'Cancel' : 'Stop';
  }
}

// ---------------- Prayer picker ----------------
let countPrayer = null, countValue = 2;
function openPrayerPicker() {
  const list = $('prayerList');
  list.innerHTML = '';
  const groups = [['Fard', PRAYERS.filter(p => !p.adj)], ['Sunnah', PRAYERS.filter(p => p.adj && p.id !== 'custom')], ['Other', PRAYERS.filter(p => p.id === 'custom')]];
  for (const [title, items] of groups) {
    const h = document.createElement('div'); h.className = 'group-title'; h.textContent = title; list.appendChild(h);
    const card = document.createElement('div'); card.className = 'card';
    for (const p of items) {
      const b = document.createElement('button');
      b.className = 'list-btn' + (p.id === S.prayerId ? ' selected' : '');
      b.innerHTML = `<span>${p.id === 'custom' ? 'Custom…' : p.name}</span><span>${rakaatFor(p)} rakaat${p.adj ? ' ✎' : ''}</span>`;
      b.onclick = () => { if (p.adj) openCount(p); else { selectPrayer(p); hide('prayerSheet'); } };
      card.appendChild(b);
    }
    list.appendChild(card);
  }
  show('prayerSheet');
}
function openCount(p) {
  countPrayer = p; countValue = rakaatFor(p);
  $('countTitle').textContent = `${p.name}: how many rakaat?`;
  $('countNum').textContent = countValue;
  show('countSheet');
}
function selectPrayer(p) {
  S.prayerId = p.id; save();
  counter.target = rakaatFor(p);
  counter.reset();
  render();
}

// ---------------- Settings ----------------
function openSettings() {
  $('setDelay').value = S.startDelay; $('delayVal').textContent = S.startDelay;
  $('setGlow').checked = S.glow; $('setStatus').checked = S.statusLight; $('setWarn').checked = S.warnMistakes;
  $('setMissedRuku').value = S.missedRuku; $('setComplete').value = S.completion; $('setTheme').value = S.theme;
  $('setReadout').checked = S.readout;
  $('calStatus').textContent = S.profile ? `Calibrated ✓ (${S.profile.primary === 'face' ? 'face' : 'brightness'} detection)` : 'Not calibrated';
  show('settingsSheet');
}
function bindSettings() {
  $('setDelay').oninput = e => { S.startDelay = +e.target.value; $('delayVal').textContent = S.startDelay; save(); };
  $('setGlow').onchange = e => { S.glow = e.target.checked; save(); };
  $('setStatus').onchange = e => { S.statusLight = e.target.checked; save(); render(); };
  $('setWarn').onchange = e => { S.warnMistakes = e.target.checked; save(); applyCounterSettings(); };
  $('setMissedRuku').onchange = e => { S.missedRuku = e.target.value; save(); applyCounterSettings(); };
  $('setComplete').onchange = e => { S.completion = e.target.value; save(); unlockAudio(); if (S.completion === 'beep') beep(1); };
  $('setTheme').onchange = e => { S.theme = e.target.value; save(); applyTheme(); };
  $('setReadout').onchange = e => { S.readout = e.target.checked; save(); render(); };
  $('btnCalibrate').onclick = () => { hide('settingsSheet'); openCalibration(); };
}
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const dark = S.theme === 'dark' || (S.theme === 'system' && darkQuery.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name=theme-color]').content = dark ? '#121413' : '#1F7A63';
}

// ---------------- Calibration ----------------
const Cal = { phase: 'ready', end: 0, last: null, samples: {}, timer: null, result: null };

function openCalibration() {
  if (state !== 'idle') stopSession();
  show('calSheet');
  calReady();
}
function calReady() {
  Cal.phase = 'ready'; clearInterval(Cal.timer);
  $('calTitle').textContent = 'Calibrate';
  $('calBody').textContent =
    '1. Put the phone on the mat exactly where it will be during prayer: screen up, just beyond where your forehead goes.\n' +
    '2. Tap Begin and stand in your place. You have 5 seconds.\n' +
    '3. Follow the beeps (turn your volume up):\n' +
    '   • 1 beep: stand still\n   • 2 beeps: go into ruku and hold\n   • 3 beeps: go into sujood and hold\n   • 1 long beep: done, you can get up\n\n' +
    'Do this in the same light you usually pray in.';
  $('calTimer').textContent = '';
  $('calPreviewSpace').hidden = true; $('cam').classList.remove('preview');
  $('calMain').hidden = false; $('calMain').textContent = 'Begin'; $('calMain').disabled = false; $('calMain').onclick = calBegin;
  $('calSecondary').hidden = true;
}
async function calBegin() {
  unlockAudio();
  $('calMain').disabled = true; $('calMain').textContent = 'Starting…';
  try {
    await Cam.start(r => { Cal.last = r; });
  } catch (e) {
    Cam.stop();
    $('calMain').disabled = false; $('calMain').textContent = 'Begin';
    dialog('Camera unavailable', cameraErrorText(e), 'OK', null);
    return;
  }
  Awake.on();
  if (S.glow) document.body.classList.add('glow');
  Cal.samples = {}; Cal.last = null; Cal.result = null;
  $('cam').classList.add('preview'); $('calPreviewSpace').hidden = false;
  $('calMain').hidden = true;
  $('calSecondary').hidden = false; $('calSecondary').textContent = 'Cancel';
  $('calSecondary').onclick = () => { calStop(); calReady(); };
  calEnter('prep', 5000, 'Get ready', 'Stand in your place. The small circle shows what the camera sees.');
  Cal.timer = setInterval(calTick, 100);
}
function calEnter(phase, ms, title, body) {
  Cal.phase = phase; Cal.end = now() + ms;
  $('calTitle').textContent = title; $('calBody').textContent = body;
}
function calTick() {
  const t = now();
  if (['stand', 'ruku', 'sujood'].includes(Cal.phase) && Cal.last) (Cal.samples[Cal.phase] = Cal.samples[Cal.phase] || []).push(Cal.last);
  $('calTimer').textContent = Math.max(0, Math.ceil((Cal.end - t) / 1000));
  if (t < Cal.end) return;
  switch (Cal.phase) {
    case 'prep': beep(1); calEnter('stand', 3000, 'Stand still', 'Measuring while you stand…'); break;
    case 'stand': beep(2); calEnter('toRuku', 3000, 'Go into ruku', 'Bow and hold the position.'); break;
    case 'toRuku': calEnter('ruku', 3000, 'Hold ruku', 'Measuring ruku…'); break;
    case 'ruku': beep(3); calEnter('toSujood', 4000, 'Go into sujood', 'Prostrate and hold the position.'); break;
    case 'toSujood': calEnter('sujood', 3000, 'Hold sujood', 'Measuring sujood…'); break;
    case 'sujood': beep(1, true); calFinish(); break;
  }
}
function calStop() {
  clearInterval(Cal.timer);
  Cam.stop(); Awake.off();
  document.body.classList.remove('glow');
  $('cam').classList.remove('preview'); $('calPreviewSpace').hidden = true;
}
function calFinish() {
  calStop();
  Cal.phase = 'done';
  $('calTimer').textContent = '';
  const [ok, text] = calCompute();
  $('calTitle').textContent = ok ? 'Calibration result ✓' : 'Calibration failed';
  $('calBody').textContent = text;
  $('calSecondary').hidden = false; $('calSecondary').textContent = 'Try again'; $('calSecondary').onclick = calReady;
  if (ok) {
    $('calMain').hidden = false; $('calMain').disabled = false; $('calMain').textContent = 'Save';
    $('calMain').onclick = () => { S.profile = Cal.result; save(); toast('Calibration saved'); hide('calSheet'); render(); };
  } else {
    $('calMain').hidden = true;
  }
}
function calCompute() {
  const stand = Cal.samples.stand || [], ruku = Cal.samples.ruku || [], sujood = Cal.samples.sujood || [];
  if (!stand.length || !sujood.length) return [false, 'No pictures came from the camera. Try again.'];
  const rate = l => l.length ? l.filter(r => r.faceFound).length / l.length : 0;
  const size = l => { const v = l.filter(r => r.faceFound).map(r => r.faceSize); return v.length ? median(v) : 0; };
  const luma = l => { const v = l.map(r => r.luma).filter(x => !isNaN(x)); return v.length ? median(v) : NaN; };
  const lumaStand = luma(stand);
  const rel = l => { const v = luma(l); return (isNaN(v) || isNaN(lumaStand)) ? 0 : (v - lumaStand) / Math.max(lumaStand, 8); };

  const rukuRate = rate(ruku), rukuSize = size(ruku), sujoodRate = rate(sujood), sujoodSize = size(sujood);
  const lumaRuku = rel(ruku), lumaSujood = rel(sujood);
  const numbers =
    `Face seen: standing ${pct(rate(stand))}, ruku ${pct(rukuRate)}, sujood ${pct(sujoodRate)}\n` +
    `Face size: ruku ${rukuSize.toFixed(2)}, sujood ${sujoodSize.toFixed(2)}\n` +
    `Brightness change: ruku ${pct(lumaRuku)}, sujood ${pct(lumaSujood)}\n\n`;

  const faceOk = sujoodRate >= 0.5 && sujoodSize >= 0.1 && (rukuRate < 0.4 || sujoodSize >= 1.25 * rukuSize);
  const lumaOk = Math.abs(lumaSujood) >= 0.15;
  if (!faceOk && !lumaOk) {
    return [false, numbers + "Couldn't see a clear difference in sujood. Make sure the phone is screen-up just beyond where your forehead goes, and your face is above it in sujood. In a dark room, keep \"Light up my face\" on."];
  }
  const profile = { primary: faceOk ? 'face' : 'luma', faceRuku: rukuSize, faceRukuRate: rukuRate, faceSujood: sujoodSize, faceSujoodRate: sujoodRate, lumaRukuRel: lumaRuku, lumaSujoodRel: lumaSujood };
  Cal.result = profile;
  const rukuOk = new CameraClassifier(profile).rukuDetectable;
  return [true, numbers +
    (faceOk ? 'Sujood: your face is clearly detected ✓' : "Sujood: detected from picture brightness ✓ (face wasn't clear enough)") + '\n' +
    (rukuOk ? 'Ruku: detectable ✓' : "Ruku: not clear enough, so ruku won't be tracked (shown as n/a).")];
}

// ---------------- UI helpers ----------------
function show(id) { $(id).hidden = false; }
function hide(id) { $(id).hidden = true; }
let toastTimer = null;
function toast(msg) {
  const el = $('toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}
function dialog(title, text, yes, no) {
  return new Promise(resolve => {
    $('modalTitle').textContent = title; $('modalText').textContent = text;
    $('modalYes').textContent = yes || 'OK';
    $('modalNo').hidden = !no; if (no) $('modalNo').textContent = no;
    $('modalYes').onclick = () => { hide('modal'); resolve(true); };
    $('modalNo').onclick = () => { hide('modal'); resolve(false); };
    show('modal');
  });
}

// ---------------- Wire up ----------------
$('btnPrayer').onclick = openPrayerPicker;
$('btnSettings').onclick = openSettings;
$('btnStart').onclick = () => { if (state === 'idle') requestStart(); else stopSession(); };
$('btnReset').onclick = () => { counter.reset(); toast('Count reset'); };
$('countMinus').onclick = () => { countValue = Math.max(1, countValue - 1); $('countNum').textContent = countValue; };
$('countPlus').onclick = () => { countValue = Math.min(20, countValue + 1); $('countNum').textContent = countValue; };
$('countOk').onclick = () => { S.counts[countPrayer.id] = countValue; save(); selectPrayer(countPrayer); hide('countSheet'); hide('prayerSheet'); };
document.querySelectorAll('[data-close]').forEach(b => { b.onclick = () => hide(b.dataset.close); });
$('calBack').onclick = () => { if (Cal.phase !== 'ready' && Cal.phase !== 'done') calStop(); Cal.phase = 'ready'; hide('calSheet'); };

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (state !== 'idle') stopSession();
    if (Cal.phase !== 'ready' && Cal.phase !== 'done') { calStop(); calReady(); }
  }
});
darkQuery.addEventListener && darkQuery.addEventListener('change', applyTheme);

bindSettings();
applyTheme();
applyCounterSettings();
render();

// Preload the face model in the background, and register offline support.
if (window.faceapi) Cam.loadModel().catch(() => {});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
