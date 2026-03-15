// ── Ski Tracker App ──────────────────────────────────────────────────────────

const STATES = { REST: 'rest', LIFT: 'lift', DOWNHILL: 'downhill' };

// Thresholds for automatic state detection
const SPEED_MOVING = 1.5;       // km/h — above this you're not resting
const SPEED_DOWNHILL = 8;       // km/h — above this while descending = downhill
const ALT_CHANGE_THRESHOLD = 3; // meters over sample window to count as ascending/descending
const SAMPLE_WINDOW = 5;        // number of recent positions to average altitude change

// ── State ────────────────────────────────────────────────────────────────────
let tracking = false;
let watchId = null;
let wakeLock = null;
let map = null;
let positionHistory = [];    // { lat, lng, alt, speed, time }
let segments = [];           // { state, startTime, endTime, positions[], altStart, altEnd }
let currentSegment = null;
let currentState = STATES.REST;
let startTime = null;
let updateInterval = null;

// Map layers
let trackPolylines = [];
let currentPositionMarker = null;

// ── Initialization ───────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  initTabs();
  initControls();
  loadSession();
});

function initMap() {
  map = L.map('map', {
    center: [46.8, 10.3],  // Alps default
    zoom: 14,
    zoomControl: false
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap',
    maxZoom: 19
  }).addTo(map);

  // Add zoom control to top-right on mobile
  L.control.zoom({ position: 'topright' }).addTo(map);

  // Fix Leaflet sizing
  setTimeout(() => map.invalidateSize(), 100);
}

function initTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(tab.dataset.tab + '-view').classList.add('active');
      if (tab.dataset.tab === 'map') {
        setTimeout(() => map.invalidateSize(), 50);
      }
    });
  });
}

function initControls() {
  document.getElementById('btn-start').addEventListener('click', startTracking);
  document.getElementById('btn-stop').addEventListener('click', stopTracking);
}

// ── Tracking ─────────────────────────────────────────────────────────────────
async function startTracking() {
  if (tracking) return;

  try {
    // Request geolocation permission
    await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true
      });
    });
  } catch (e) {
    alert('Location permission is required for ski tracking.');
    return;
  }

  tracking = true;
  startTime = startTime || Date.now();
  document.getElementById('btn-start').classList.add('hidden');
  document.getElementById('btn-stop').classList.remove('hidden');

  // Acquire wake lock to keep screen on / prevent sleep
  await acquireWakeLock();

  // Start watching position
  watchId = navigator.geolocation.watchPosition(
    onPosition,
    onPositionError,
    {
      enableHighAccuracy: true,
      maximumAge: 2000,
      timeout: 10000
    }
  );

  // Start a new segment if we don't have one
  if (!currentSegment) {
    startNewSegment(STATES.REST);
  }

  // Periodic UI update
  updateInterval = setInterval(updateUI, 1000);

  // Register service worker for background operation
  registerServiceWorker();
}

function stopTracking() {
  if (!tracking) return;
  tracking = false;

  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  // Close current segment
  if (currentSegment) {
    currentSegment.endTime = Date.now();
    segments.push({ ...currentSegment });
    currentSegment = null;
  }

  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = null;
  }

  releaseWakeLock();

  document.getElementById('btn-stop').classList.add('hidden');
  document.getElementById('btn-start').classList.remove('hidden');

  saveSession();
  updateUI();
}

// ── Position handling ────────────────────────────────────────────────────────
function onPosition(pos) {
  const point = {
    lat: pos.coords.latitude,
    lng: pos.coords.longitude,
    alt: pos.coords.altitude,
    speed: pos.coords.speed,       // m/s
    accuracy: pos.coords.accuracy,
    time: Date.now()
  };

  positionHistory.push(point);

  // Add to current segment
  if (currentSegment) {
    currentSegment.positions.push(point);
  }

  // Update map position
  updateMapPosition(point);

  // Detect state change
  detectState(point);

  // Save periodically (every 10 points)
  if (positionHistory.length % 10 === 0) {
    saveSession();
  }
}

function onPositionError(err) {
  console.warn('Geolocation error:', err.message);
}

// ── State detection ──────────────────────────────────────────────────────────
function detectState(point) {
  const speedKmh = (point.speed || 0) * 3.6;
  const altChange = getRecentAltitudeChange();
  let newState = currentState;

  if (speedKmh < SPEED_MOVING) {
    newState = STATES.REST;
  } else if (speedKmh >= SPEED_DOWNHILL && altChange < -ALT_CHANGE_THRESHOLD) {
    newState = STATES.DOWNHILL;
  } else if (altChange > ALT_CHANGE_THRESHOLD) {
    newState = STATES.LIFT;
  } else if (speedKmh >= SPEED_DOWNHILL) {
    // Fast but no clear altitude change — likely downhill on flat section
    newState = STATES.DOWNHILL;
  } else if (speedKmh >= SPEED_MOVING) {
    // Slow movement — could be lift or walking
    newState = altChange > 0 ? STATES.LIFT : currentState;
  }

  if (newState !== currentState) {
    transitionState(newState);
  }
}

function getRecentAltitudeChange() {
  const recent = positionHistory.slice(-SAMPLE_WINDOW);
  if (recent.length < 2) return 0;

  const alts = recent.filter(p => p.alt !== null && p.alt !== undefined).map(p => p.alt);
  if (alts.length < 2) return 0;

  return alts[alts.length - 1] - alts[0];
}

function transitionState(newState) {
  const now = Date.now();

  // Close current segment
  if (currentSegment) {
    currentSegment.endTime = now;
    const positions = currentSegment.positions;
    if (positions.length > 0) {
      const alts = positions.filter(p => p.alt != null).map(p => p.alt);
      currentSegment.altStart = alts.length ? alts[0] : null;
      currentSegment.altEnd = alts.length ? alts[alts.length - 1] : null;
    }
    segments.push({ ...currentSegment });
  }

  currentState = newState;
  startNewSegment(newState);
}

function startNewSegment(state) {
  currentSegment = {
    state: state,
    startTime: Date.now(),
    endTime: null,
    positions: [],
    altStart: null,
    altEnd: null
  };
}

// ── Map ──────────────────────────────────────────────────────────────────────
function updateMapPosition(point) {
  const latlng = [point.lat, point.lng];

  if (!currentPositionMarker) {
    currentPositionMarker = L.circleMarker(latlng, {
      radius: 8,
      fillColor: '#fff',
      fillOpacity: 1,
      color: '#e94560',
      weight: 3
    }).addTo(map);
    map.setView(latlng, 15);
  } else {
    currentPositionMarker.setLatLng(latlng);
  }

  // Draw track segment
  if (positionHistory.length >= 2) {
    const prev = positionHistory[positionHistory.length - 2];
    const color = getStateColor(currentState);
    const line = L.polyline([[prev.lat, prev.lng], latlng], {
      color: color,
      weight: 4,
      opacity: 0.85
    }).addTo(map);
    trackPolylines.push(line);
  }

  // Follow position
  map.panTo(latlng);
}

function getStateColor(state) {
  switch (state) {
    case STATES.DOWNHILL: return '#e74c3c';
    case STATES.LIFT: return '#3498db';
    case STATES.REST: return '#f39c12';
    default: return '#aaa';
  }
}

function redrawMap() {
  // Clear existing
  trackPolylines.forEach(l => map.removeLayer(l));
  trackPolylines = [];
  if (currentPositionMarker) {
    map.removeLayer(currentPositionMarker);
    currentPositionMarker = null;
  }

  // Redraw all segments
  const allSegments = [...segments];
  if (currentSegment) allSegments.push(currentSegment);

  const allPoints = [];

  allSegments.forEach(seg => {
    if (seg.positions.length < 2) return;
    const color = getStateColor(seg.state);
    const coords = seg.positions.map(p => [p.lat, p.lng]);
    const line = L.polyline(coords, { color, weight: 4, opacity: 0.85 }).addTo(map);
    trackPolylines.push(line);
    allPoints.push(...coords);
  });

  // Place current position marker
  if (allPoints.length > 0) {
    const last = allPoints[allPoints.length - 1];
    currentPositionMarker = L.circleMarker(last, {
      radius: 8, fillColor: '#fff', fillOpacity: 1, color: '#e94560', weight: 3
    }).addTo(map);

    // Fit bounds
    if (allPoints.length > 1) {
      map.fitBounds(L.latLngBounds(allPoints).pad(0.1));
    }
  }
}

// ── Timeline ─────────────────────────────────────────────────────────────────
function renderTimeline() {
  const container = document.getElementById('timeline');
  const allSegments = [...segments];
  if (currentSegment) {
    allSegments.push({ ...currentSegment, endTime: Date.now() });
  }

  if (allSegments.length === 0) {
    container.innerHTML = '<p style="text-align:center;color:var(--color-text-dim);padding-top:40px;">Start tracking to see your timeline</p>';
    return;
  }

  let html = '';
  allSegments.forEach((seg, i) => {
    const duration = (seg.endTime || Date.now()) - seg.startTime;
    const durationStr = formatDuration(duration);
    const startStr = new Date(seg.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    let details = durationStr;
    if (seg.altStart != null && seg.altEnd != null) {
      const altDiff = Math.round(seg.altEnd - seg.altStart);
      const arrow = altDiff > 0 ? '&#9650;' : altDiff < 0 ? '&#9660;' : '';
      details += ` &middot; ${arrow} ${Math.abs(altDiff)}m`;
      details += ` &middot; ${Math.round(seg.altStart)}m → ${Math.round(seg.altEnd)}m`;
    }

    // Speed stats for downhill
    if (seg.state === STATES.DOWNHILL && seg.positions.length > 0) {
      const speeds = seg.positions.filter(p => p.speed != null).map(p => p.speed * 3.6);
      if (speeds.length > 0) {
        const maxSpeed = Math.round(Math.max(...speeds));
        details += ` &middot; max ${maxSpeed} km/h`;
      }
    }

    html += `
      <div class="timeline-entry">
        <div class="timeline-bar ${seg.state}"></div>
        <div class="timeline-info">
          <div class="timeline-state" style="color:${getStateColor(seg.state)}">${seg.state}</div>
          <div class="timeline-details">${details}</div>
        </div>
        <div class="timeline-time">${startStr}</div>
      </div>`;
  });

  container.innerHTML = html;
  // Auto-scroll to bottom
  container.scrollTop = container.scrollHeight;
}

// ── Stats ────────────────────────────────────────────────────────────────────
function updateStats() {
  const allSegments = [...segments];
  if (currentSegment) {
    allSegments.push({ ...currentSegment, endTime: Date.now() });
  }

  let downhillTime = 0, liftTime = 0, restTime = 0;
  let totalVertical = 0;
  let maxSpeed = 0;
  let topAltitude = null;
  let runs = 0;

  allSegments.forEach(seg => {
    const dur = (seg.endTime || Date.now()) - seg.startTime;
    switch (seg.state) {
      case STATES.DOWNHILL:
        downhillTime += dur;
        runs++;
        break;
      case STATES.LIFT:
        liftTime += dur;
        break;
      case STATES.REST:
        restTime += dur;
        break;
    }

    // Vertical drop for downhill segments
    if (seg.state === STATES.DOWNHILL && seg.altStart != null && seg.altEnd != null) {
      const drop = seg.altStart - seg.altEnd;
      if (drop > 0) totalVertical += drop;
    }

    // Max speed & top altitude
    seg.positions.forEach(p => {
      if (p.speed != null) {
        const sKmh = p.speed * 3.6;
        if (sKmh > maxSpeed) maxSpeed = sKmh;
      }
      if (p.alt != null) {
        if (topAltitude === null || p.alt > topAltitude) topAltitude = p.alt;
      }
    });
  });

  const totalTime = downhillTime + liftTime + restTime;

  document.getElementById('stat-total-time').textContent = formatDuration(totalTime);
  document.getElementById('stat-downhill-time').textContent = formatDuration(downhillTime);
  document.getElementById('stat-lift-time').textContent = formatDuration(liftTime);
  document.getElementById('stat-rest-time').textContent = formatDuration(restTime);
  document.getElementById('stat-max-speed').textContent = Math.round(maxSpeed) + ' km/h';
  document.getElementById('stat-total-vertical').textContent = Math.round(totalVertical) + ' m';
  document.getElementById('stat-runs').textContent = runs;
  document.getElementById('stat-top-altitude').textContent = topAltitude != null ? Math.round(topAltitude) + ' m' : '-- m';
}

// ── UI Update ────────────────────────────────────────────────────────────────
function updateUI() {
  // State badge
  const badge = document.getElementById('current-state');
  badge.textContent = currentState.toUpperCase();
  badge.className = 'state-badge ' + currentState;

  // Altitude
  const lastPoint = positionHistory[positionHistory.length - 1];
  if (lastPoint && lastPoint.alt != null) {
    document.getElementById('altitude-display').textContent = Math.round(lastPoint.alt) + ' m';
  }

  // Speed
  if (lastPoint && lastPoint.speed != null) {
    document.getElementById('speed-display').textContent = Math.round(lastPoint.speed * 3.6) + ' km/h';
  }

  renderTimeline();
  updateStats();
}

// ── Wake Lock ────────────────────────────────────────────────────────────────
async function acquireWakeLock() {
  const statusEl = document.getElementById('wake-lock-status');
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      statusEl.textContent = 'Screen wake lock active';

      wakeLock.addEventListener('release', () => {
        statusEl.textContent = 'Wake lock released';
        // Try to re-acquire if still tracking
        if (tracking) {
          setTimeout(acquireWakeLock, 1000);
        }
      });

      // Re-acquire on visibility change (e.g., switching tabs)
      document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible' && tracking) {
          await acquireWakeLock();
        }
      });
    } catch (e) {
      statusEl.textContent = 'Wake lock not available';
      console.warn('Wake Lock failed:', e);
    }
  } else {
    statusEl.textContent = 'Wake lock not supported';
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release();
    wakeLock = null;
  }
  document.getElementById('wake-lock-status').textContent = '';
}

// ── Service Worker ───────────────────────────────────────────────────────────
async function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('sw.js');
      console.log('Service Worker registered');
    } catch (e) {
      console.warn('SW registration failed:', e);
    }
  }
}

// ── Session persistence (localStorage) ───────────────────────────────────────
function saveSession() {
  const data = {
    tracking,
    startTime,
    currentState,
    segments,
    currentSegment,
    positionHistory: positionHistory.slice(-5000) // cap stored points
  };
  try {
    localStorage.setItem('ski-session', JSON.stringify(data));
  } catch (e) {
    console.warn('Save failed:', e);
  }
}

function loadSession() {
  try {
    const raw = localStorage.getItem('ski-session');
    if (!raw) return;
    const data = JSON.parse(raw);

    if (data.segments) segments = data.segments;
    if (data.positionHistory) positionHistory = data.positionHistory;
    if (data.startTime) startTime = data.startTime;
    if (data.currentState) currentState = data.currentState;

    // Restore map & UI
    if (positionHistory.length > 0 || segments.length > 0) {
      redrawMap();
      updateUI();
    }
  } catch (e) {
    console.warn('Load failed:', e);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
