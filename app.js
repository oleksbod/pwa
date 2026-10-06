'use strict';

// ---------- IndexedDB (sessions + items, blobs stored directly) ----------
const DB_NAME = 'field-notes-poc';
let dbPromise;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('sessions', { keyPath: 'id' });
        db.createObjectStore('items', { keyPath: 'id' }).createIndex('bySession', 'sessionId');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

const asPromise = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const txDone = tx => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = tx.onabort = () => rej(tx.error); });

const store = {
  async all(name) {
    const db = await openDb();
    return asPromise(db.transaction(name).objectStore(name).getAll());
  },
  async get(name, id) {
    const db = await openDb();
    return asPromise(db.transaction(name).objectStore(name).get(id));
  },
  async put(name, value) {
    const db = await openDb();
    const tx = db.transaction(name, 'readwrite');
    tx.objectStore(name).put(value);
    return txDone(tx);
  },
  async remove(name, id) {
    const db = await openDb();
    const tx = db.transaction(name, 'readwrite');
    tx.objectStore(name).delete(id);
    return txDone(tx);
  },
  async itemsOf(sessionId) {
    const db = await openDb();
    return asPromise(db.transaction('items').objectStore('items').index('bySession').getAll(sessionId));
  }
};

// ---------- helpers ----------
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const pad = n => String(n).padStart(2, '0');
const fmtTime = ts => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtDate = ts => { const d = new Date(ts); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${fmtTime(ts)}`; };
const fmtDur = ms => { const s = Math.round(ms / 1000); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; };
const fmtSize = b => b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
const stamp = ts => { const d = new Date(ts); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; };
const slug = s => (s || 'session').toLowerCase().replace(/[^a-z0-9а-яіїєґ]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40) || 'session';
const extFor = mime => mime.includes('jpeg') ? 'jpg' : mime.includes('png') ? 'png' : mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : mime.includes('webm') ? 'webm' : 'bin';

const ICON_TRASH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
const ICON_SHARE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3M7 8l5-5 5 5M5 13v7h14v-7"/></svg>';

// ---------- toasts (mimic platform snack bar) ----------
function toast(type, title, text, action) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = `<div class="t-body"><strong>${esc(title)}</strong>${text ? esc(text) : ''}</div>`;
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.onclick = () => { el.remove(); action.run(); };
    el.appendChild(b);
  }
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), action ? 9000 : 5000);
}

// ---------- connectivity ----------
let online = navigator.onLine;

async function probe() {
  if (!navigator.onLine) return false;
  try {
    // bypasses SW cache because of the unique query string
    const r = await fetch(`./manifest.webmanifest?ping=${Date.now()}`, { cache: 'no-store' });
    return r.ok;
  } catch { return false; }
}

async function updateConnectivity(fromEvent) {
  const now = await probe();
  if (now === online && !fromEvent) return;
  const changed = now !== online;
  online = now;
  $('#netPill').textContent = online ? 'Online' : 'Offline';
  $('#netPill').classList.toggle('offline', !online);
  $('#offlineBanner').hidden = online;
  if (!changed) return;
  if (online) {
    const pending = (await store.all('items')).filter(i => !i.sharedAt).length;
    toast('success', 'Connection restored', pending ? `${pending} item(s) not uploaded yet.` : 'Everything is uploaded.',
      pending && view.name === 'session' ? { label: 'Upload', run: () => shareSession(view.id) } : null);
  } else {
    toast('warning', 'Connection lost', 'Keep capturing. Everything is saved on this device.');
  }
}

window.addEventListener('online', () => updateConnectivity(true));
window.addEventListener('offline', () => updateConnectivity(true));
setInterval(() => { if (document.visibilityState === 'visible') updateConnectivity(false); }, 15000);

// ---------- views ----------
let view = { name: 'sessions' };
let objectUrls = [];

function go(next) { view = next; render(); window.scrollTo(0, 0); }

async function render() {
  objectUrls.forEach(URL.revokeObjectURL);
  objectUrls = [];
  if (view.name === 'session') return renderSession();
  return renderSessions();
}

async function renderSessions() {
  $('#title').textContent = 'Field notes';
  $('#subtitle').textContent = 'PoC · offline capture';
  $('#backBtn').hidden = true;
  $('#captureBar').hidden = true;

  const sessions = (await store.all('sessions')).sort((a, b) => b.createdAt - a.createdAt);
  const items = await store.all('items');
  const cards = sessions.map(s => {
    const own = items.filter(i => i.sessionId === s.id);
    const count = t => own.filter(i => i.type === t).length;
    const pending = own.filter(i => !i.sharedAt).length;
    const chip = own.length === 0 ? '' : pending
      ? `<span class="chip pending">${pending} not uploaded</span>`
      : '<span class="chip done">Uploaded</span>';
    return `<button class="card link" data-action="open" data-id="${s.id}">
      <div class="card-head"><div class="card-title">${esc(s.title)}</div>${chip}</div>
      <div class="card-meta"><span>${count('photo')} photos</span><span>${count('audio')} voice</span><span>${count('text')} text</span><span style="margin-left:auto">${fmtDate(s.createdAt)}</span></div>
    </button>`;
  }).join('');

  $('#main').innerHTML = `
    <h1>My capture sessions</h1>
    ${cards || '<div class="empty">No sessions yet. Create one and try it in airplane mode.</div>'}
    <button class="btn primary block" data-action="new-session" style="margin-top:8px">+ New session</button>`;
}

async function renderSession() {
  const s = await store.get('sessions', view.id);
  if (!s) return go({ name: 'sessions' });
  const items = (await store.itemsOf(s.id)).sort((a, b) => b.createdAt - a.createdAt);
  const pending = items.filter(i => !i.sharedAt).length;
  const count = t => items.filter(i => i.type === t).length;

  $('#title').textContent = s.title;
  $('#subtitle').textContent = `${count('photo')} photos · ${count('audio')} voice · ${count('text')} text`;
  $('#backBtn').hidden = false;
  $('#captureBar').hidden = false;

  const list = items.map(i => {
    let media = '';
    if (i.blob) {
      const url = URL.createObjectURL(i.blob);
      objectUrls.push(url);
      media = i.type === 'photo' ? `<img src="${url}" alt="Photo taken at ${fmtTime(i.createdAt)}" loading="lazy">` : `<audio controls preload="metadata" src="${url}"></audio>`;
    }
    const label = i.type === 'photo' ? 'Photo' : i.type === 'audio' ? `Voice · ${fmtDur(i.durationMs || 0)}` : 'Text note';
    const size = i.blob ? ` · ${fmtSize(i.blob.size)}` : '';
    const chip = i.sharedAt ? '<span class="chip done">Uploaded</span>' : '<span class="chip pending">Not uploaded</span>';
    return `<article class="item">
      ${i.type === 'photo' ? media : ''}
      <div class="item-body">
        ${i.type === 'audio' ? media : ''}
        ${i.type === 'text' ? `<div class="item-text">${esc(i.text)}</div>` : ''}
        <div class="item-meta"><span>${label} · ${fmtTime(i.createdAt)}${size}</span><span class="spacer"></span>${chip}
          <button class="item-del" data-action="del-item" data-id="${i.id}" aria-label="Delete item">${ICON_TRASH}</button></div>
      </div>
    </article>`;
  }).join('');

  $('#main').innerHTML = `
    <button class="btn primary block" data-action="share" ${items.length ? '' : 'disabled'}>${ICON_SHARE} ${pending ? `Upload ${pending} new item(s) to Drive` : 'Upload all again'}</button>
    <div class="muted">Opens the phone's share menu. Choose Google Drive and a folder.</div>
    ${list || '<div class="empty">Nothing here yet. Use Photo, Voice or Text below.</div>'}
    <button class="btn danger" data-action="del-session" style="margin-top:16px">Delete session</button>`;
}

// ---------- capture ----------
async function addItem(item) {
  await store.put('items', { id: uid(), sessionId: view.id, createdAt: Date.now(), sharedAt: null, ...item });
  requestPersistence();
  render();
}

async function compressImage(file, max = 1600, quality = 0.85) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
    return blob || file;
  } catch {
    return file;
  }
}

$('#photoInput').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const blob = await compressImage(file);
  await addItem({ type: 'photo', blob, mime: blob.type || 'image/jpeg' });
  toast('success', 'Photo saved', `${fmtSize(blob.size)} on this device`);
});

const rec = { stream: null, recorder: null, chunks: [], startedAt: 0, timer: 0, raf: 0, audioCtx: null, wakeLock: null };

function pickMime() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return types.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
}

async function startRecording() {
  if (!window.MediaRecorder) return toast('error', 'Recording is not supported', 'This browser has no MediaRecorder.');
  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (err) {
    return toast('error', 'No access to the microphone', 'Allow the microphone for this app in the browser settings.');
  }
  const mime = pickMime();
  rec.recorder = new MediaRecorder(rec.stream, mime ? { mimeType: mime } : undefined);
  rec.chunks = [];
  rec.recorder.ondataavailable = e => { if (e.data.size) rec.chunks.push(e.data); };
  rec.recorder.start(1000);
  rec.startedAt = Date.now();

  $('#recorder').hidden = false;
  $('#recHint').textContent = online
    ? 'Audio is saved on the device. In the real app the text appears live while online.'
    : 'Offline: audio is saved on the device and will be converted to text after sync.';
  $('#recTime').textContent = '00:00';
  rec.timer = setInterval(() => { $('#recTime').textContent = fmtDur(Date.now() - rec.startedAt); }, 250);
  drawLevel();
  try { rec.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
}

function drawLevel() {
  const canvas = $('#recLevel');
  const ctx = canvas.getContext('2d');
  rec.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const analyser = rec.audioCtx.createAnalyser();
  analyser.fftSize = 256;
  rec.audioCtx.createMediaStreamSource(rec.stream).connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  const history = new Array(40).fill(2);
  let last = 0;
  const loop = t => {
    rec.raf = requestAnimationFrame(loop);
    if (t - last < 80) return;
    last = t;
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
    history.push(Math.max(2, (peak / 128) * canvas.height));
    history.shift();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#0060FF';
    const w = canvas.width / history.length;
    history.forEach((h, i) => ctx.fillRect(i * w + 1, (canvas.height - h) / 2, w - 3, h));
  };
  rec.raf = requestAnimationFrame(loop);
}

async function stopRecording(save) {
  const recorder = rec.recorder;
  if (!recorder) return;
  const durationMs = Date.now() - rec.startedAt;
  if (recorder.state !== 'inactive') {
    const stopped = new Promise(res => { recorder.onstop = res; });
    recorder.stop();
    await stopped;
  }
  clearInterval(rec.timer);
  cancelAnimationFrame(rec.raf);
  rec.stream.getTracks().forEach(t => t.stop());
  rec.audioCtx?.close();
  rec.wakeLock?.release().catch(() => {});
  rec.recorder = null;
  $('#recorder').hidden = true;

  if (!save) return;
  const blob = new Blob(rec.chunks, { type: recorder.mimeType || 'audio/webm' });
  await addItem({ type: 'audio', blob, mime: blob.type, durationMs });
  toast('success', 'Voice note saved', `${fmtDur(durationMs)} · ${fmtSize(blob.size)}`);
}

// ---------- "sync": share to Google Drive via the OS share sheet ----------
async function shareSession(sessionId) {
  const session = await store.get('sessions', sessionId);
  const items = (await store.itemsOf(sessionId)).sort((a, b) => a.createdAt - b.createdAt);
  const pending = items.filter(i => !i.sharedAt);
  const target = pending.length ? pending : items;
  const base = slug(session.title);

  const files = target.filter(i => i.blob).map(i =>
    new File([i.blob], `${base}_${stamp(i.createdAt)}_${i.type === 'photo' ? 'photo' : 'voice'}.${extFor(i.mime)}`, { type: i.mime }));

  // one text file with all notes + an index of the media files (the future "structure")
  const lines = [`Session: ${session.title}`, `Created: ${fmtDate(session.createdAt)}`, `Exported: ${fmtDate(Date.now())}`, ''];
  items.forEach(i => {
    const name = i.blob ? `${base}_${stamp(i.createdAt)}_${i.type === 'photo' ? 'photo' : 'voice'}.${extFor(i.mime)}` : '';
    if (i.type === 'text') lines.push(`[${fmtTime(i.createdAt)}] TEXT: ${i.text}`);
    else lines.push(`[${fmtTime(i.createdAt)}] ${i.type === 'photo' ? 'PHOTO' : `VOICE ${fmtDur(i.durationMs || 0)}`}: ${name}`);
  });
  files.push(new File([lines.join('\n')], `${base}_${stamp(Date.now())}_notes.txt`, { type: 'text/plain' }));

  if (navigator.canShare && navigator.canShare({ files })) {
    try {
      await navigator.share({ files, title: session.title });
    } catch (err) {
      if (err.name !== 'AbortError') toast('error', 'Upload failed', err.message);
      return;
    }
  } else {
    // fallback (desktop / unsupported): download the files
    files.forEach(f => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(f);
      a.download = f.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    });
  }

  const now = Date.now();
  for (const i of target) await store.put('items', { ...i, sharedAt: now });
  toast('success', 'Handed over to the share target', `${files.length} file(s). Check the Drive app for upload progress.`);
  render();
}

// ---------- storage / diagnostics ----------
async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch { /* optional */ }
}

async function showDiagnostics() {
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const persisted = await navigator.storage?.persisted?.().catch(() => null);
  const testFile = new File(['x'], 'x.txt', { type: 'text/plain' });
  const rows = {
    'Online (real check)': online ? 'yes' : 'no',
    'Installed (standalone)': matchMedia('(display-mode: standalone)').matches ? 'yes' : 'no (open from home screen icon)',
    'Service worker': navigator.serviceWorker?.controller ? 'active, app works offline' : 'not controlling yet (reload once)',
    'Recording format': pickMime() || 'MediaRecorder not supported',
    'Share files': navigator.canShare?.({ files: [testFile] }) ? 'supported' : 'not supported (downloads instead)',
    'Storage used': est ? `${fmtSize(est.usage || 0)} of ${fmtSize(est.quota || 0)}` : 'unknown',
    'Persistent storage': persisted == null ? 'unknown' : persisted ? 'yes' : 'no',
    'App version': APP_VERSION
  };
  $('#diagList').innerHTML = Object.entries(rows).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  $('#diagnostics').hidden = false;
}

// ---------- events ----------
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, id } = el.dataset;
  switch (action) {
    case 'open': return go({ name: 'session', id });
    case 'new-session': {
      const title = prompt('Session name', `Session ${fmtDate(Date.now())}`);
      if (title === null) return;
      const s = { id: uid(), title: title.trim() || `Session ${fmtDate(Date.now())}`, createdAt: Date.now() };
      await store.put('sessions', s);
      return go({ name: 'session', id: s.id });
    }
    case 'photo': return $('#photoInput').click();
    case 'voice': return startRecording();
    case 'rec-stop': return stopRecording(true);
    case 'rec-cancel': return stopRecording(false);
    case 'text':
      $('#noteText').value = '';
      $('#textEditor').hidden = false;
      return $('#noteText').focus();
    case 'text-cancel': $('#textEditor').hidden = true; return;
    case 'text-save': {
      const text = $('#noteText').value.trim();
      $('#textEditor').hidden = true;
      if (text) { await addItem({ type: 'text', text }); toast('success', 'Text note saved'); }
      return;
    }
    case 'share': return shareSession(view.id);
    case 'del-item':
      if (confirm('Delete this item from the device?')) { await store.remove('items', id); render(); }
      return;
    case 'del-session': {
      if (!confirm('Delete the whole session from the device?')) return;
      for (const i of await store.itemsOf(view.id)) await store.remove('items', i.id);
      await store.remove('sessions', view.id);
      return go({ name: 'sessions' });
    }
    case 'diag-close': $('#diagnostics').hidden = true; return;
    case 'persist': await requestPersistence(); return showDiagnostics();
  }
});

$('#backBtn').addEventListener('click', () => go({ name: 'sessions' }));
$('#diagBtn').addEventListener('click', showDiagnostics);

// install prompt (Android Chrome)
let installEvent = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvent = e; $('#installBtn').hidden = false; });
$('#installBtn').addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice;
  installEvent = null;
  $('#installBtn').hidden = true;
});

// ---------- service worker ----------
const APP_VERSION = '0.1.0';

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      sw?.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
          toast('info', 'New version available', '', { label: 'Update', run: () => sw.postMessage('SKIP_WAITING') });
        }
      });
    });
  });
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded) { reloaded = true; location.reload(); } });
}

updateConnectivity(true).then(render);
