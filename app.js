(() => {
  'use strict';

  const OS_API = '/api/states';
  const VS_API = 'https://data.vatsim.net/v3/vatsim-data.json';
  const SOURCE_OS = 'opensky';
  const SOURCE_VS = 'vatsim';
  const REFRESH_MS = 25000;
  const RETRY_MS = 8000;
  const FETCH_TIMEOUT_MS = 30000;
  const MAX_PLACES = 130;
  const M2FT = 3.28084;
  const MS2KT = 1.94384;
  const MPS2FPM = 196.85;

  const map = L.map('map', { worldCopyJump: true }).setView([28, 10], 4);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  const markers = new Map();
  const flightsData = new Map();
  let selected = null;
  let tickTimer = null;
  let scheduleTimer = null;
  let inFlight = false;
  let failures = 0;
  let secondsLeft = REFRESH_MS / 1000;
  let loRegion = null;

  const $ = (id) => document.getElementById(id);
  const el = {
    status: $('status'),
    statusText: $('status-text'),
    statTotal: $('stat-total'),
    statAir: $('stat-air'),
    statGround: $('stat-ground'),
    refreshText: $('refresh-text'),
    refreshFill: $('refresh-fill'),
    flights: $('flights'),
    listCount: $('list-count'),
    search: $('search'),
    filter: $('filter'),
    country: $('country'),
    detail: $('detail'),
    detailClose: $('detail-close')
  };

  /* ---------------- Icons & markers ---------------- */

  const svgPlane = (size) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor">
       <path d="M21 12a1 1 0 0 1-.4.8l-3.4 2.56-.7 5.14a.5.5 0 0 1-.86.3l-2-1.9-1.8 2.42a.35.35 0 0 1-.63-.24l.44-3.34L8.9 13.6l-3.7 1.76a.5.5 0 0 1-.5-.04L2.9 14a.5.5 0 0 1 .06-.87l4.2-1.86L2.9 9.4a.5.5 0 0 1-.06-.87L4.7 7.2a.5.5 0 0 1 .5-.04l3.7 1.76 1.97-1.72-.44-3.34A.35.35 0 0 1 10.7 3.42l1.8 2.42 2-1.9a.5.5 0 0 1 .86.3l.7 5.14 3.4 2.56a1 1 0 0 1 .54.92Z"/>
     </svg>`;

  function planeIcon(heading, isSelected) {
    const cls = ['plane-icon'];
    if (isSelected) cls.push('selected');
    return L.divIcon({
      className: 'plane-marker',
      iconSize: [30, 30],
      iconAnchor: [15, 15],
      popupAnchor: [0, -16],
      html: `<div class="${cls.join(' ')}" style="transform:rotate(${heading || 0}deg)">${svgPlane(28)}</div>`
    });
  }

  /* ---------------- Data modelling ---------------- */

  const S = {
    ICAO: 0, CALLSIGN: 1, COUNTRY: 2, TPOS: 3, CONTACT: 4, LON: 5, LAT: 6,
    BARO: 7, GROUND: 8, VEL: 9, TRACK: 10, VRATE: 11, GEO: 13, SQUAWK: 14
  };

  function modelState(s) {
    return {
      icao: s[S.ICAO],
      callsign: (s[S.CALLSIGN] || '').trim(),
      country: s[S.COUNTRY],
      lon: s[S.LON],
      lat: s[S.LAT],
      alt: s[S.BARO] != null ? Math.round(s[S.BARO] * M2FT) : null,
      geoAlt: s[S.GEO] != null ? Math.round(s[S.GEO] * M2FT) : null,
      vel: s[S.VEL] != null ? Math.round(s[S.VEL] * MS2KT) : null,
      track: s[S.TRACK] != null ? Math.round(s[S.TRACK]) : null,
      vrate: s[S.VRATE] != null ? Math.round(s[S.VRATE] * MPS2FPM) : null,
      onGround: !!s[S.GROUND],
      squawk: s[S.SQUAWK] || null,
      contact: s[S.CONTACT]
    };
  }

  function isFresh(f) {
    return f.alt != null || (Date.now() / 1000 - f.contact) < 60;
  }

  /* ---------------- Markers ---------------- */

  function upsertMarker(f) {
    const key = f.icao;
    const existing = markers.get(key);
    const opts = { lat: f.lat, lon: f.lon, icao: key, callsign: f.callsign, onGround: f.onGround };

    if (existing) {
      markers.set(key, { ...existing, ...opts });
      existing.marker.setLatLng([f.lat, f.lon]);
      existing.marker.setIcon(planeIcon(f.track, key === selected));
      existing.marker.setPopupContent(popupHtml(f));
      existing.marker._icon?.classList.toggle('on-ground', f.onGround);
      return false;
    }

    const marker = L.marker([f.lat, f.lon], { icon: planeIcon(f.track, key === selected) })
      .addTo(map)
      .bindPopup(popupHtml(f), { closeButton: false, autoClose: false });

    marker.on('click', () => selectFlight(key));
    marker._icon?.classList.toggle('on-ground', f.onGround);
    markers.set(key, { ...opts, marker });
    return true;
  }

  function popupHtml(f) {
    const cs = f.callsign || 'Unknown';
    return `<strong>${cs}</strong><br>${f.country || ''}<br>` +
      `${nbsp(f.alt, 'ft')} · ${nbsp(f.vel, 'kt')} · ${f.track != null ? f.track + '°' : '—'}`;
  }

  function nbsp(v, unit) { return v != null ? `${v.toLocaleString()} ${unit}` : '—'; }

  function updateMarkers() {
    const seen = new Set();
    let ranking = [];

    for (const f of flightsData.values()) {
      if (f.lat == null || f.lon == null) continue;
      if (!isFresh(f)) continue;
      seen.add(f.icao);
      if (f.onGround) continue;
      ranking.push({ icao: f.icao, alt: f.alt });
    }

    ranking.sort((a, b) => (b.alt ?? -1) - (a.alt ?? -1));

    for (const f of flightsData.values()) {
      if (!seen.has(f.icao)) continue;
      if (f.onGround) continue;
      const rank = ranking.findIndex(r => r.icao === f.icao);
      if (rank >= MAX_PLACES && f.icao !== selected) seen.delete(f.icao);
    }

    for (const [key, entry] of markers) {
      if (!seen.has(key) && key !== selected) {
        map.removeLayer(entry.marker);
        markers.delete(key);
      }
    }

    for (const f of flightsData.values()) {
      if (f.lat == null || f.lon == null) continue;
      if (seen.has(f.icao) || f.icao === selected) upsertMarker(f);
    }
  }

  /* ---------------- Selection ---------------- */

  function selectFlight(key) {
    selected = key;
    const f = flightsData.get(key);
    for (const [k, e] of markers) {
      e.marker.setIcon(planeIcon(e.track ?? null, k === key));
    }
    document.querySelectorAll('.flight').forEach(node => {
      node.classList.toggle('active', node.dataset.icao === key);
    });
    if (f) {
      map.setView([f.lat, f.lon], Math.max(map.getZoom(), 8));
      if (f.lat != null && f.lon != null && markers.get(key)) {
        markers.get(key).marker.setPopupContent(popupHtml(f)).openPopup();
      }
      renderDetail(f);
    }
  }

  function renderDetail(f) {
    if (!f) { el.detail.classList.add('hidden'); return; }
    el.detail.classList.remove('hidden');
    $('d-callsign').textContent = f.callsign || 'Unknown';
    $('d-icao').textContent = f.icao;
    $('d-origin').textContent = f.country || '—';
    $('d-alt').textContent = nbsp(f.alt, 'ft');
    $('d-speed').textContent = nbsp(f.vel, 'kt');
    $('d-heading').textContent = f.track != null ? f.track + '°' : '—';
    $('d-vs').textContent = nbsp(f.vrate, 'fpm');
    $('d-status').textContent = f.onGround ? 'On ground' : 'In air';
    $('d-squawk').textContent = f.squawk || '—';
  }

  function clearSelection() {
    selected = null;
    el.detail.classList.add('hidden');
    document.querySelectorAll('.flight').forEach(n => n.classList.remove('active'));
  }

  /* ---------------- Flight list ---------------- */

  function matchesFilter(f) {
    const mode = el.filter.value;
    if (mode === 'air' && f.onGround) return false;
    if (mode === 'ground' && !f.onGround) return false;
    const q = el.search.value.trim().toUpperCase();
    if (q && !(f.callsign || '').toUpperCase().includes(q)) return false;
    return true;
  }

  function buildCountries() {
    const dn = new Intl.DisplayNames(['en'], { type: 'region' });
    const esc = (s) => s.replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
    const seen = new Set();
    const opts = [];
    for (const code of ALL_COUNTRIES) {
      let name;
      try { name = dn.of(code); } catch { continue; }
      if (!name || name === code || seen.has(name)) continue;
      seen.add(name);
      opts.push(`<option value="${esc(name)}">${esc(name)}</option>`);
    }
    opts.sort((a, b) => {
      const va = a.match(/value="[^"]*"/)[0].toLowerCase();
      const vb = b.match(/value="[^"]*"/)[0].toLowerCase();
      return va < vb ? -1 : va > vb ? 1 : 0;
    });
    el.country.innerHTML = `<option value="">All countries</option>${opts.join('')}`;
  }

  function renderList() {
    const items = [...flightsData.values()].filter(matchesFilter);
    el.listCount.textContent = `${items.length} flights`;
    if (!items.length) {
      el.flights.innerHTML = `<div class="empty">No flights in view${el.search.value ? ' matching search' : ''}</div>`;
      return;
    }

    const frag = document.createDocumentFragment();
    for (const f of items) {
      const row = document.createElement('div');
      row.className = 'flight' + (f.icao === selected ? ' active' : '');
      row.dataset.icao = f.icao;
      row.innerHTML = `
        <span class="flight-head">✈</span>
        <div class="flight-meta">
          <div class="flight-callsign">
            ${f.callsign || '—'}
            <span class="pill ${f.onGround ? 'ground' : 'air'}">${f.onGround ? 'GND' : 'AIR'}</span>
          </div>
          <div class="flight-origin">${f.country || 'Unknown origin'}</div>
        </div>
        <div class="flight-info">
          <div>ALT <strong>${nbsp(f.alt, 'ft')}</strong></div>
          <div>SPD <strong>${nbsp(f.vel, 'kt')}</strong></div>
        </div>`;
      row.addEventListener('click', () => selectFlight(f.icao));
      frag.appendChild(row);
    }
    el.flights.innerHTML = '';
    el.flights.appendChild(frag);
  }

  /* ---------------- Fetching ---------------- */

  function setStatus(state, text) {
    el.status.classList.remove('failed', 'connecting', 'ok');
    if (state) el.status.classList.add(state);
    el.statusText.textContent = text;
  }

  class RetryError extends Error {
    constructor(status, delay) {
      super(`HTTP ${status}`);
      this.status = status;
      this.delay = delay;
    }
  }

  let currentDelay = REFRESH_MS;
  let source = SOURCE_OS;
  let osCooldownUntil = 0;

  function getQueryBounds() {
    if (loRegion) {
      return {
        south: loRegion.south, west: loRegion.west,
        north: loRegion.north, east: loRegion.east
      };
    }
    const b = map.getBounds();
    return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
  }

  function clampBounds(b, maxSpan) {
    const span = maxSpan / 2;
    const cLat = (b.south + b.north) / 2;
    const cLon = (b.west + b.east) / 2;
    return {
      south: clampLat(cLat - span, -90, 90),
      north: clampLat(cLat + span, -90, 90),
      west: cLon - span,
      east: cLon + span
    };
  }

  function clampLat(v, min, max) { return Math.min(max, Math.max(min, v)); }

  function originCountry(icao) {
    if (!icao || !/^[A-Z]{4}$/.test(icao)) return null;
    const code = ICAO_COUNTRY[icao.slice(0, 2)] || ICAO_LETTER[icao[0]];
    if (!code) return null;
    try {
      return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || null;
    } catch {
      return null;
    }
  }

  function renderResult() {
    updateMarkers();
    renderList();
    if (selected && flightsData.has(selected)) renderDetail(flightsData.get(selected));
    if (selected && !flightsData.has(selected)) clearSelection();
    $('stat-total').textContent = flightsData.size;
    $('stat-air').textContent = [...flightsData.values()].filter(f => !f.onGround).length;
    $('stat-ground').textContent = [...flightsData.values()].filter(f => f.onGround).length;
    failures = 0;
    scheduleNext(REFRESH_MS);
  }

  function finishError(what) {
    failures += 1;
    const backoff = Math.min(RETRY_MS * Math.pow(2, failures - 1), 60000);
    const delay = Math.max(backoff + Math.round(Math.random() * 1000), 10000);
    setStatus('failed', `Update failed (${what}) — retry in ${Math.ceil(delay / 1000)}s`);
    scheduleNext(delay);
  }

  function whyError(err) {
    if (err && err.name === 'AbortError') return 'timed out';
    if (err && err.status) return `HTTP ${err.status}`;
    if (err && err.message) return err.message;
    return 'network error';
  }

  function switchToVatsim(cooldownMs, why) {
    source = SOURCE_VS;
    osCooldownUntil = Date.now() + cooldownMs;
    setStatus('connecting', `OpenSky throttled — VATSIM (${why})`);
  }

  async function requestOpenSky(signal) {
    const b = clampBounds(getQueryBounds(), 60);
    const params = new URLSearchParams({
      lamin: b.south, lomin: b.west,
      lamax: b.north, lomax: b.east
    });
    const url = `${OS_API}?${params}`;
    let res;
    try {
      res = await fetch(url, { signal });
    } catch (err) {
      switchToVatsim(300000, 'OpenSky unavailable');
      throw err;
    }

    if (res.status === 429 || res.status === 404) {
      const ra = parseInt(res.headers.get('Retry-After') || res.headers.get('X-Rate-Limit-Retry-After-Seconds'), 10);
      const release = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 60000;
      switchToVatsim(Math.max(release, 300000), `HTTP ${res.status}`);
      throw new RetryError(res.status, release);
    }
    if (!res.ok) {
      switchToVatsim(300000, `HTTP ${res.status}`);
      throw new RetryError(res.status, RETRY_MS);
    }

    const data = await res.json();
    const states = data.states || [];
    flightsData.clear();
    for (const s of states) {
      const f = modelState(s);
      if (f.lat == null || f.lon == null) continue;
      flightsData.set(f.callsign || f.icao, f);
    }
    source = SOURCE_OS;
    osCooldownUntil = 0;
    setStatus('ok', `Live — ${new Date(data.time * 1000).toLocaleTimeString()}`);
    renderResult();
    return true;
  }

  async function requestVatsim(signal) {
    const res = await fetch(VS_API, { signal });
    if (!res.ok) throw new RetryError(res.status, RETRY_MS);
    const data = await res.json();
    const b = getQueryBounds();
    const now = Date.now() / 1000;
    flightsData.clear();
    for (const p of (data.pilots || [])) {
      const lat = +p.latitude;
      const lon = +p.longitude;
      if (!isFinite(lat) || !isFinite(lon)) continue;
      if (lat < b.south || lat > b.north || lon < b.west || lon > b.east) continue;
      const gs = +p.groundspeed || 0;
      const alt = +p.altitude || 0;
      const dep = p.flight_plan && p.flight_plan.departure;
      const arr = p.flight_plan && p.flight_plan.arrival;
      flightsData.set(p.callsign, {
        icao: p.callsign,
        callsign: p.callsign,
        country: originCountry(dep || arr),
        lon,
        lat,
        alt: Math.round(alt),
        vel: Math.round(gs),
        track: +p.heading || null,
        vrate: null,
        onGround: alt < 700 && gs < 80,
        squawk: p.transponder || null,
        contact: now
      });
    }
    source = SOURCE_VS;
    setStatus('ok', `Live — VATSIM ${new Date().toLocaleTimeString()}`);
    renderResult();
    return true;
  }

  async function fetchStates() {
    if (inFlight) {
      scheduleNext(RETRY_MS);
      return false;
    }
    inFlight = true;
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

    try {
      if (source === SOURCE_OS || Date.now() >= osCooldownUntil) {
        try {
          return await requestOpenSky(ctrl.signal);
        } catch (err) {
          try {
            return await requestVatsim(ctrl.signal);
          } catch (err2) {
            finishError(whyError(err2));
            return false;
          }
        }
      } else {
        try {
          return await requestVatsim(ctrl.signal);
        } catch (err) {
          finishError(whyError(err));
          return false;
        }
      }
    } finally {
      clearTimeout(to);
      inFlight = false;
    }
  }

  function refreshNow() {
    clearTimeout(scheduleTimer);
    countdownStart();
    fetchStates();
  }

  function scheduleNext(delay) {
    currentDelay = delay;
    countdownStart();
    clearTimeout(scheduleTimer);
    scheduleTimer = setTimeout(refreshNow, delay);
  }

  function startCountdown() {
    tickTimer = setInterval(() => {
      secondsLeft -= 1;
      if (secondsLeft < 0) secondsLeft = 0;
      el.refreshText.textContent = `Refreshing in ${Math.ceil(secondsLeft)}s`;
      el.refreshFill.style.width = `${Math.max(secondsLeft / (currentDelay / 1000), 0) * 100}%`;
    }, 1000);
  }

  function countdownStart() {
    secondsLeft = currentDelay / 1000;
    el.refreshText.textContent = `Refreshing in ${Math.ceil(secondsLeft)}s`;
    el.refreshFill.style.width = '100%';
  }

  /* ---------------- Events ---------------- */

  async function applyCountry() {
    const country = el.country.value;
    if (!country) {
      loRegion = null;
      updateMarkers();
      renderList();
      refreshNow();
      return;
    }
    if (loRegion && loRegion.country === country) return;

    setStatus('connecting', `Locating ${country}…`);
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&polygon_geojson=0&q=${encodeURIComponent(country)}`,
        { signal: ctrl.signal }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.length) throw new Error('not found');
      const bb = data[0].boundingbox;
      loRegion = {
        country,
        south: +bb[0], north: +bb[1], west: +bb[2], east: +bb[3]
      };
      setStatus('connecting', `Tracking ${country}…`);
      map.fitBounds([[+bb[0], +bb[2]], [+bb[1], +bb[3]]]);
      updateMarkers();
      renderList();
      refreshNow();
    } catch (err) {
      loRegion = null;
      el.country.value = '';
      setStatus('failed', `Locate ${country} failed`);
      updateMarkers();
      renderList();
      refreshNow();
    } finally {
      clearTimeout(to);
    }
  }

  let boundsTimer = null;
  map.on('moveend', () => {
    if (loRegion) return;
    if (map.getZoom() < 5) {
      refreshNow();
      return;
    }
    clearTimeout(boundsTimer);
    setStatus('connecting', 'Paused — map moving');
    boundsTimer = setTimeout(refreshNow, 900);
  });

  $('refresh-btn').addEventListener('click', () => {
    clearTimeout(boundsTimer);
    refreshNow();
  });

  el.search.addEventListener('input', renderList);
  el.filter.addEventListener('change', renderList);
  el.country.addEventListener('change', applyCountry);
  el.detailClose.addEventListener('click', clearSelection);

  /* ---------------- Boot ---------------- */

  setStatus('connecting', 'Connecting…');
  buildCountries();
  startCountdown();
  refreshNow();
})();