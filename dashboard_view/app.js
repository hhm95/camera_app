'use strict';
// Dashboard: talks only to the host_backend REST API.
// Served by host_backend at "/" (same origin). To open this folder from elsewhere, pass the
// API address: index.html?api=http://HOST:3000

const API = (new URLSearchParams(location.search).get('api') || '').replace(/\/$/, '');
const POLL_MS = 2000;

const $grid = document.getElementById('cameras');
const $empty = document.getElementById('empty');
const $apiState = document.getElementById('api-state');
const $tpl = document.getElementById('camera-card');

const cards = new Map(); // camera id -> { el, state, ... }

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString() : '–');
const fmtBytes = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

async function getJson(url) {
  const res = await fetch(API + url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

function stateClass(state) {
  if (state === 'connected') return 'pill-ok';
  if (state === 'connecting' || state === 'reconnecting' || state === 'stalled') return 'pill-warn';
  return 'pill-bad';
}

function createCard(cam) {
  const el = $tpl.content.firstElementChild.cloneNode(true);
  const card = { id: cam.id, el, liveState: null, recLoaded: false };
  el.querySelector('.cam-name').textContent = cam.name;
  el.querySelector('.cam-addr').textContent = `${cam.id} · ${cam.address}`;

  const details = el.querySelector('.recordings');
  details.addEventListener('toggle', () => { if (details.open) loadDays(card); });
  el.querySelector('.rec-day').addEventListener('change', (e) => loadDay(card, e.target.value));

  // Live MJPEG stream: reload it when the camera comes back after an outage.
  card.img = el.querySelector('.live-img');
  card.img.addEventListener('error', () => { card.liveState = null; });

  // Live audio: an independent MP3 stream, played alongside (not frame-synced to) the video.
  card.audio = el.querySelector('.live-audio');
  card.audioState = null;
  card.audio.addEventListener('error', () => { card.audioState = null; });

  $grid.appendChild(el);
  cards.set(cam.id, card);
  return card;
}

function updateCard(card, s) {
  const el = card.el;
  const pill = el.querySelector('.state');
  pill.textContent = s.state;
  pill.className = `pill state ${stateClass(s.state)}`;

  const live = el.querySelector('.live');
  const overlay = el.querySelector('.live-overlay');
  const online = s.state === 'connected' && s.lastFrameAt;
  live.classList.toggle('offline', !online);
  overlay.textContent = s.state === 'connected' ? 'Waiting for first frame…'
    : `Camera ${s.state}${s.lastError ? ` — ${s.lastError}` : ''}`;

  if (online && card.liveState !== 'streaming') {
    card.img.src = `${API}/api/cameras/${encodeURIComponent(s.id)}/live?t=${Date.now()}`;
    card.liveState = 'streaming';
  } else if (!online && s.state !== 'connected') {
    card.liveState = null;
  }

  if (online && card.audioState !== 'streaming') {
    card.audio.src = `${API}/api/cameras/${encodeURIComponent(s.id)}/live/audio?t=${Date.now()}`;
    card.audio.play().catch(() => {}); // autoplay-with-sound may be blocked until a user gesture
    card.audioState = 'streaming';
  } else if (!online && s.state !== 'connected' && card.audioState) {
    card.audio.removeAttribute('src');
    card.audio.load();
    card.audioState = null;
  }

  const set = (k, v) => { el.querySelector(`[data-k="${k}"]`).textContent = v; };
  const v = s.video;
  set('resolution', v.resolution ? `${v.resolution.width}×${v.resolution.height}` : '–');
  set('fps', v.fps ? `${v.fps} fps` : '–');
  set('bitrate', v.bitrateKbps ? `${v.bitrateKbps} kbps` : '–');
  set('frames', `${v.framesDecoded} decoded / ${v.framesReceived} rx`);
  set('lost', `${s.rtp.video.packetsLost} / ${s.rtp.video.packetsReceived} pkts`);
  set('audioLost', `${s.rtp.audio.packetsLost} / ${s.rtp.audio.packetsReceived} pkts`);
  set('reconnects', String(s.reconnects));
  set('dtls', s.dtls ? `${s.dtls.version} · ${s.dtls.group} key exchange · ${s.dtls.signature} certificate · ${s.dtls.cipher}` : 'not established');
  set('lastFrame', fmtTime(s.lastFrameAt));
}

async function loadDays(card) {
  const sel = card.el.querySelector('.rec-day');
  try {
    const { days } = await getJson(`/api/cameras/${encodeURIComponent(card.id)}/recordings`);
    const current = sel.value;
    sel.innerHTML = '';
    for (const d of [...days].reverse()) {
      const o = document.createElement('option');
      o.value = d.date;
      o.textContent = `${d.date} (${d.videoFiles} video, ${d.frames} frames)`;
      sel.appendChild(o);
    }
    if (!days.length) {
      card.el.querySelector('.rec-content').textContent = 'No recordings yet.';
      return;
    }
    if (current) sel.value = current;
    loadDay(card, sel.value);
  } catch (err) {
    card.el.querySelector('.rec-content').textContent = err.message;
  }
}

async function loadDay(card, date) {
  const box = card.el.querySelector('.rec-content');
  try {
    const day = await getJson(`/api/cameras/${encodeURIComponent(card.id)}/recordings/${date}`);
    box.textContent = '';
    const add = (tag, text) => { const n = document.createElement(tag); n.textContent = text; box.appendChild(n); return n; };

    add('h3', `Video segments (${day.video.length})`);
    const ul = document.createElement('ul');
    for (const f of day.video) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = API + f.url;
      a.textContent = f.name;
      li.append(a, ` · ${fmtBytes(f.bytes)} · H.264 Annex-B`);
      ul.appendChild(li);
    }
    box.appendChild(ul);

    add('h3', `Audio segments (${day.audio.length})`);
    const aul = document.createElement('ul');
    for (const f of day.audio) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = API + f.url;
      a.textContent = f.name;
      li.append(a, ` · ${fmtBytes(f.bytes)} · G.711 WAV`);
      aul.appendChild(li);
    }
    box.appendChild(aul);

    add('h3', `Frames (${day.frames.length})`);
    const thumbs = document.createElement('div');
    thumbs.className = 'thumbs';
    for (const f of day.frames.slice(-24).reverse()) {
      const a = document.createElement('a');
      a.href = API + f.url;
      a.target = '_blank';
      a.rel = 'noopener';
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = API + f.url;
      img.alt = f.name;
      const cap = document.createElement('span');
      cap.textContent = f.name.replace(/\.jpg$/, '').replace(/^(\d\d)(\d\d)(\d\d)_.*/, '$1:$2:$3');
      a.append(img, cap);
      thumbs.appendChild(a);
    }
    box.appendChild(thumbs);

    add('h3', `Events (${day.events.length})`);
    const ev = add('div', '');
    ev.className = 'events';
    ev.textContent = day.events.slice(-20).map((e) => `${fmtTime(e.time)}  ${e.type}${e.reason ? ` (${e.reason})` : ''}`).join('\n');
    ev.style.whiteSpace = 'pre';
  } catch (err) {
    box.textContent = err.message;
  }
}

async function poll() {
  try {
    const list = await getJson('/api/cameras');
    $apiState.textContent = 'host online';
    $apiState.className = 'pill pill-ok';
    $empty.hidden = list.length > 0;

    const ids = new Set(list.map((c) => c.id));
    for (const [id, card] of cards) {
      if (!ids.has(id)) { card.el.remove(); cards.delete(id); }
    }
    await Promise.all(list.map(async (cam) => {
      const card = cards.get(cam.id) || createCard(cam);
      try {
        updateCard(card, await getJson(`/api/cameras/${encodeURIComponent(cam.id)}/status`));
      } catch (err) {
        console.warn(err);
      }
    }));
  } catch (err) {
    $apiState.textContent = 'host unreachable';
    $apiState.className = 'pill pill-off';
  }
}

poll();
setInterval(poll, POLL_MS);
