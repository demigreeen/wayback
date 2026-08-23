#!/usr/bin/env python3
"""
build_animation.py

Читает runs.json и собирает animation.html — анимированную карту пробежек.

Проигрывание с камерой идёт на собственном canvas-движке (тот же, что
рендерит видео): все тайлы карты предзагружаются в память ДО старта,
поэтому серых квадратов не бывает даже при дальних перелётах. Leaflet
используется для пауз, перемотки и интерактивного просмотра.

Использование:
    python build_animation.py [входной_json] [выходной_html]

По умолчанию: runs.json -> animation.html
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent


def build(input_path: Path | None = None,
          output_path: Path | None = None,
          log=print) -> Path:
    """Собирает animation.html. Возвращает путь к готовому файлу."""
    input_path = Path(input_path) if input_path else SCRIPT_DIR / "runs.json"
    output_path = Path(output_path) if output_path else SCRIPT_DIR / "animation.html"

    if not input_path.exists():
        raise FileNotFoundError(
            f"Файл {input_path} не найден. Сначала выгрузите пробежки "
            f"(кнопка 2 в приложении)."
        )

    points = json.loads(input_path.read_text(encoding="utf-8"))
    points = [p for p in points if p.get("lat") is not None and p.get("lon") is not None]
    points.sort(key=lambda r: r.get("datetime", ""))

    if not points:
        raise ValueError("В runs.json нет точек с координатами — анимировать нечего.")

    total_km = round(sum(p.get("distance_km") or 0 for p in points), 1)

    html = (
        HTML_TEMPLATE
        .replace("__RUNS_DATA__", json.dumps(points, ensure_ascii=False))
        .replace("__COUNT__", str(len(points)))
        .replace("__TOTAL_KM__", str(total_km))
        .replace("__DATE_RANGE__", f'{points[0]["date"]} — {points[-1]["date"]}')
    )

    output_path.write_text(html, encoding="utf-8")
    log(f"Готово: {output_path.name}")
    log(f"Точек: {len(points)}, суммарно {total_km} км, "
        f"период {points[0]['date']} — {points[-1]['date']}")
    return output_path


HTML_TEMPLATE = r"""<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Карта пробежек — анимация</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<style>
  :root {
    --bg: #0b0e14;
    --panel: rgba(13, 16, 24, 0.82);
    --accent: #ff5a36;
    --accent-hi: #ff8b62;
    --text: #f4f3f1;
    --text-dim: #9aa0ad;
    --border: rgba(255,255,255,0.10);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: var(--bg);
    font-family: "Segoe UI", -apple-system, Roboto, Helvetica, Arial, sans-serif; }
  #map { position: absolute; inset: 0; background: var(--bg); }

  /* Канвас кинематографичного проигрывания — поверх карты, под панелями */
  #liveCanvas {
    position: absolute; inset: 0; z-index: 500; display: none;
    width: 100%; height: 100%; pointer-events: none; background: var(--bg);
  }
  #liveCanvas.visible { display: block; }

  #hud {
    position: absolute; top: 18px; left: 18px; z-index: 1000;
    background: var(--panel); color: var(--text); border: 1px solid var(--border);
    border-radius: 16px; padding: 16px 20px; backdrop-filter: blur(10px);
    min-width: 240px; box-shadow: 0 12px 32px rgba(0,0,0,0.45);
  }
  #hud h1 { font-size: 13px; font-weight: 600; margin: 0; letter-spacing: 0.6px;
    text-transform: uppercase; color: var(--text-dim); }
  #hud .current-date { font-size: 28px; font-weight: 800; margin-top: 6px;
    font-variant-numeric: tabular-nums; letter-spacing: 0.5px; }
  #hud .current-date.period { font-size: 18px; line-height: 1.35; }
  #hud .current-name { font-size: 13px; color: var(--text-dim); margin-top: 2px;
    min-height: 17px; max-width: 240px; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; }
  #hud .stats { display: flex; gap: 18px; margin-top: 12px; padding-top: 12px;
    border-top: 1px solid var(--border); }
  #hud .stat .v { font-size: 18px; font-weight: 700; color: var(--accent-hi);
    font-variant-numeric: tabular-nums; }
  #hud .stat .l { font-size: 11px; color: var(--text-dim); margin-top: 1px; }

  #controls {
    position: absolute; bottom: 18px; left: 50%; transform: translateX(-50%);
    z-index: 1000; width: min(960px, calc(100% - 36px));
    background: var(--panel); color: var(--text); border: 1px solid var(--border);
    border-radius: 16px; padding: 12px 16px; backdrop-filter: blur(10px);
    display: flex; align-items: center; gap: 12px;
    box-shadow: 0 12px 32px rgba(0,0,0,0.45);
  }
  button {
    background: var(--accent); color: #0b0e14; border: none; border-radius: 10px;
    width: 42px; height: 42px; font-size: 16px; cursor: pointer; flex: 0 0 auto;
    display: flex; align-items: center; justify-content: center; font-weight: 700;
    transition: filter .15s, transform .1s;
  }
  button:hover { filter: brightness(1.12); }
  button:active { transform: scale(0.95); }
  button:disabled { filter: grayscale(0.7) brightness(0.7); cursor: default; }
  button.secondary { background: transparent; color: var(--text);
    border: 1px solid var(--border); width: auto; padding: 0 14px; font-size: 13px; }
  #slider { flex: 1 1 auto; accent-color: var(--accent); cursor: pointer; }
  select {
    background: rgba(255,255,255,0.05); color: var(--text);
    border: 1px solid var(--border);
    border-radius: 10px; padding: 9px 6px; font-size: 12px; flex: 0 0 auto;
    cursor: pointer;
  }
  select option { background: #151a24; }
  label.follow {
    display: flex; align-items: center; gap: 6px; font-size: 12px;
    color: var(--text-dim); cursor: pointer; flex: 0 0 auto; user-select: none;
  }
  label.follow input { accent-color: var(--accent); cursor: pointer; }
  #counter { font-size: 12px; color: var(--text-dim); flex: 0 0 auto;
    min-width: 86px; text-align: right; font-variant-numeric: tabular-nums; }

  .head-marker { pointer-events: none; }
  .head-marker .core {
    position: absolute; left: -7px; top: -7px; width: 14px; height: 14px;
    border-radius: 50%; background: var(--accent); border: 2px solid #fff;
    box-shadow: 0 0 14px rgba(255,90,54,0.95), 0 0 34px rgba(255,90,54,0.45);
  }

  .burst { pointer-events: none; }
  .burst .ring {
    position: absolute; left: -11px; top: -11px; width: 22px; height: 22px;
    border-radius: 50%; border: 2.5px solid var(--accent);
    animation: burst 0.7s ease-out forwards;
  }
  .burst .ring.r2 { animation-delay: 0.16s; opacity: 0; }
  @keyframes burst {
    0%   { transform: scale(0.35); opacity: 0.95; }
    100% { transform: scale(2.8);  opacity: 0; }
  }

  .leaflet-popup-content-wrapper, .leaflet-popup-tip {
    background: #151a24; color: var(--text);
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  }

  #exportOverlay {
    position: fixed; inset: 0; z-index: 2000; display: none;
    background: rgba(5, 7, 11, 0.92); backdrop-filter: blur(8px);
    align-items: center; justify-content: center;
  }
  #exportOverlay.visible { display: flex; }
  #exportBox {
    background: var(--panel); border: 1px solid var(--border); border-radius: 20px;
    padding: 36px 44px; text-align: center; min-width: 360px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.6);
  }
  #exportPct { font-size: 52px; font-weight: 800; color: var(--accent-hi);
    font-variant-numeric: tabular-nums; }
  #exportBar { height: 8px; border-radius: 4px; background: rgba(255,255,255,0.08);
    margin: 18px 0 14px; overflow: hidden; }
  #exportBarFill { height: 100%; width: 0%; border-radius: 4px;
    background: linear-gradient(90deg, var(--accent), var(--accent-hi));
    transition: width .2s linear; }
  #exportStatus { color: var(--text-dim); font-size: 14px; margin-bottom: 22px;
    max-width: 380px; }
  #exportCancel { width: auto; padding: 0 20px; height: 40px; font-size: 13px;
    background: transparent; color: var(--text); border: 1px solid var(--border);
    margin: 0 auto; }

  /* Настройки видео перед рендером */
  #exportSettings .exp-title { font-size: 18px; font-weight: 700; color: var(--text);
    margin-bottom: 20px; }
  .exp-row { display: flex; align-items: center; justify-content: space-between;
    gap: 16px; margin-bottom: 14px; }
  .exp-row > span { font-size: 13px; color: var(--text-dim); flex: 0 0 auto; }
  .seg { display: flex; gap: 6px; }
  .seg button { width: auto; height: 34px; padding: 0 14px; font-size: 13px;
    background: rgba(255,255,255,0.05); color: var(--text);
    border: 1px solid var(--border); border-radius: 8px; font-weight: 600; }
  .seg button.sel { background: var(--accent); color: #0b0e14;
    border-color: var(--accent); }
  #exportStart { width: 100%; height: 44px; font-size: 14px; margin: 18px 0 10px;
    border-radius: 10px; }
  #exportClose { width: 100%; height: 38px; font-size: 13px;
    background: transparent; color: var(--text-dim); border: none; }

  @media (max-width: 640px) {
    #hud { right: 18px; min-width: 0; }
    #controls { flex-wrap: wrap; }
    #slider { order: 1; flex-basis: 100%; }
  }
</style>
</head>
<body>

<div id="map"></div>
<canvas id="liveCanvas"></canvas>

<div id="hud">
  <h1>Карта пробежек</h1>
  <div class="current-date" id="currentDate">—</div>
  <div class="current-name" id="currentName">__DATE_RANGE__</div>
  <div class="stats">
    <div class="stat"><div class="v"><span id="shownCount">0</span> / __COUNT__</div><div class="l">пробежек</div></div>
    <div class="stat"><div class="v" id="cumKm">0</div><div class="l">км суммарно</div></div>
  </div>
</div>

<div id="controls">
  <button id="playBtn" title="Играть / Пауза">▶</button>
  <button class="secondary" id="resetBtn" title="Сначала">⟲</button>
  <input type="range" id="slider" min="0" max="__COUNT__" value="__COUNT__" step="1">
  <select id="speed" title="Скорость">
    <option value="1000">Очень медленно</option>
    <option value="333">Медленно</option>
    <option value="200" selected>Обычно</option>
    <option value="100">Быстро</option>
    <option value="50">Очень быстро</option>
  </select>
  <label class="follow" title="Камера следует за точками (кинорежим)">
    <input type="checkbox" id="followCam" checked> камера
  </label>
  <button class="secondary" id="videoBtn" title="Записать и скачать видеофайл">⬇ Скачать видео</button>
  <div id="counter"></div>
</div>

<div id="exportOverlay">
  <div id="exportBox">
    <div id="exportSettings">
      <div class="exp-title">Настройки видео</div>
      <div class="exp-row"><span>Качество</span>
        <div class="seg" id="segQ">
          <button data-v="480">480p</button>
          <button data-v="720">720p</button>
          <button data-v="1080" class="sel">1080p</button>
        </div>
      </div>
      <div class="exp-row"><span>Кадров/сек</span>
        <div class="seg" id="segF">
          <button data-v="15">15</button>
          <button data-v="24">24</button>
          <button data-v="30" class="sel">30</button>
          <button data-v="60">60</button>
        </div>
      </div>
      <button id="exportStart">Начать рендер</button>
      <button id="exportClose">Отмена</button>
    </div>
    <div id="exportProgress" style="display:none">
      <div id="exportPct">0%</div>
      <div id="exportBar"><div id="exportBarFill"></div></div>
      <div id="exportStatus">Подготовка...</div>
      <button id="exportCancel">Отмена</button>
    </div>
  </div>
</div>

<script>
'use strict';
const RUNS = __RUNS_DATA__;
const N = RUNS.length;
const ACCENT = '#ff5a36';
const ACCENT_HI = '#ff8b62';
const FOLLOW_ZOOM = 13;
const FAR_METERS = 25000;
const BURST_MS = 700;
const TILE_URL = (z, x, y) => {
  const sub = 'abcd'[(x + y) % 4];
  return `https://${sub}.basemaps.cartocdn.com/dark_all/${z}/${x}/${y}.png`;
};

const PTS = RUNS.map(r => L.latLng(r.lat, r.lon));
const CUM_KM = []; { let s = 0; for (const r of RUNS) { s += (r.distance_km || 0); CUM_KM.push(s); } }

// ------------------------------------------------------------------ утилиты
const $ = id => document.getElementById(id);
const lerp = (a, b, t) => a + (b - a) * t;
const lerpLL = (a, b, t) => L.latLng(lerp(a.lat, b.lat, t), lerp(a.lng, b.lng, t));
const easeInOut = t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
const clamp01 = t => Math.max(0, Math.min(1, t));

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ------------------------------------------------------------------ карта (Leaflet — для пауз и интерактива)
const map = L.map('map', {
  zoomControl: true, attributionControl: true,
  zoomSnap: 0, zoomAnimation: false, markerZoomAnimation: false, fadeAnimation: false
});
// crossOrigin — чтобы тайлы Leaflet и тайлы canvas-движка делили один HTTP-кэш
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', {
  maxZoom: 20, attribution: '&copy; OpenStreetMap &copy; CARTO',
  keepBuffer: 6, crossOrigin: 'anonymous'
}).addTo(map);

const bounds = L.latLngBounds(PTS);
map.fitBounds(bounds.pad(0.2));

const paint = L.canvas({ padding: 0.5 });
const trailGlow = L.polyline([], { renderer: paint, color: ACCENT, weight: 11, opacity: 0.14, interactive: false, lineJoin: 'round' }).addTo(map);
const trail     = L.polyline([], { renderer: paint, color: ACCENT_HI, weight: 4, opacity: 0.8, interactive: false, lineJoin: 'round', lineCap: 'round' }).addTo(map);
const dotsLayer = L.layerGroup().addTo(map);

const headIcon = L.divIcon({
  className: 'head-marker', html: '<div class="core"></div>', iconSize: [0, 0]
});
const headMarker = L.marker([0, 0], { icon: headIcon, interactive: false, zIndexOffset: 1000 });

const burstIcon = L.divIcon({
  className: 'burst', html: '<div class="ring"></div><div class="ring r2"></div>', iconSize: [0, 0]
});
function spawnBurst(ll) {
  const m = L.marker(ll, { icon: burstIcon, interactive: false, zIndexOffset: 900 }).addTo(map);
  setTimeout(() => map.removeLayer(m), BURST_MS + 350);
}

// ------------------------------------------------------------------ DOM
const slider = $('slider'), playBtn = $('playBtn'), resetBtn = $('resetBtn');
const speedSelect = $('speed'), followCam = $('followCam'), videoBtn = $('videoBtn');
const shownCountEl = $('shownCount'), currentDateEl = $('currentDate');
const currentNameEl = $('currentName'), cumKmEl = $('cumKm'), counterEl = $('counter');
const liveCanvas = $('liveCanvas');
const exportOverlay = $('exportOverlay'), exportPct = $('exportPct');
const exportBarFill = $('exportBarFill'), exportStatus = $('exportStatus');
const exportCancel = $('exportCancel');
const exportSettings = $('exportSettings'), exportProgress = $('exportProgress');
const exportStart = $('exportStart'), exportClose = $('exportClose');

const delayMs = () => parseInt(speedSelect.value, 10);
const isFar = i => i > 0 && PTS[i - 1].distanceTo(PTS[i]) > FAR_METERS;
const stepDur = i => i === 0 ? 1200 : (isFar(i) ? Math.max(800, delayMs()) : delayMs());

// ------------------------------------------------------------------ Leaflet-состояние (пауза/перемотка/статичная камера)
let placed = 0;
const committedLL = [];
const dotMarkers = [];
let playing = false;
let anim = null;          // Leaflet-путь (камера выключена)
let finaleRaf = 0;

function makeDot(r) {
  return L.circleMarker([r.lat, r.lon], {
    renderer: paint, radius: 4, color: ACCENT, weight: 1,
    fillColor: ACCENT, fillOpacity: 0.6
  }).bindPopup(`<b>${r.date}</b><br>${escapeHtml(r.name || '')}<br>${r.distance_km ?? '?'} км`);
}

function setHudFor(i) {
  currentDateEl.classList.remove('period');
  if (i >= 0) {
    currentDateEl.textContent = RUNS[i].date;
    currentNameEl.textContent = RUNS[i].name || '';
    cumKmEl.textContent = CUM_KM[i].toFixed(1);
  } else {
    currentDateEl.textContent = '—';
    currentNameEl.textContent = '__DATE_RANGE__';
    cumKmEl.textContent = '0';
  }
}

// Финальный кадр: вместо даты последней пробежки — весь период
function setHudPeriod() {
  currentDateEl.textContent = '__DATE_RANGE__';
  currentDateEl.classList.add('period');
  currentNameEl.textContent = `вся история · ${N} пробежек`;
  cumKmEl.textContent = CUM_KM[N - 1].toFixed(1);
}

function syncCounters() {
  shownCountEl.textContent = placed;
  counterEl.textContent = placed + ' / ' + N;
  slider.value = placed;
}

function setTrail(extraHead) {
  const lls = extraHead ? committedLL.concat([extraHead]) : committedLL;
  trailGlow.setLatLngs(lls);
  trail.setLatLngs(lls);
}

function stopFinale() { if (finaleRaf) { cancelAnimationFrame(finaleRaf); finaleRaf = 0; } }

function cancelAnim() {
  if (anim && anim.raf) cancelAnimationFrame(anim.raf);
  anim = null;
  stopFinale();
}

function render(n) {
  n = Math.max(0, Math.min(N, n));
  cancelAnim();
  hideLiveCanvas();
  while (placed < n) {
    committedLL.push(PTS[placed]);
    const m = makeDot(RUNS[placed]); m.addTo(dotsLayer); dotMarkers.push(m);
    placed++;
  }
  while (placed > n) {
    committedLL.pop();
    dotsLayer.removeLayer(dotMarkers.pop());
    placed--;
  }
  setTrail(null);
  if (placed > 0) {
    headMarker.setLatLng(PTS[placed - 1]);
    if (!map.hasLayer(headMarker)) headMarker.addTo(map);
  } else if (map.hasLayer(headMarker)) map.removeLayer(headMarker);
  if (placed >= N) setHudPeriod(); else setHudFor(placed - 1);
  syncCounters();
}

// ------------------------------------------------------------------ камера/геометрия
function camApply(c, z) { map.setView(c, z, { animate: false }); }

function makeArc(from, to) {
  const meters = from.distanceTo(to);
  if (meters < FAR_METERS) return 0;
  return Math.max(1.5, Math.min(8, Math.log2(meters / 3000)));
}

function project(lat, lng, z) {
  const n = 256 * Math.pow(2, z);
  const x = (lng + 180) / 360 * n;
  const latR = lat * Math.PI / 180;
  const y = (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n;
  return [x, y];
}

function fitZoom(b, w, h, pad) {
  for (let z = 17; z >= 2; z -= 0.25) {
    const [x1, y1] = project(b.getNorth(), b.getWest(), z);
    const [x2, y2] = project(b.getSouth(), b.getEast(), z);
    if (Math.abs(x2 - x1) <= w - 2 * pad && Math.abs(y2 - y1) <= h - 2 * pad) return z;
  }
  return 2;
}

// ------------------------------------------------------------------ таймлайн (общий для канваса и видео)
function buildPhases(W, H) {
  const ovZ = fitZoom(bounds.pad(0.15), W, H, Math.round(H * 0.08));
  const ovC = bounds.getCenter();
  const phases = [];
  const arrivals = new Array(N).fill(Infinity);
  let acc = 0;
  const push = ph => { ph.t0 = acc; acc += ph.dur; phases.push(ph); };

  push({ kind: 'hold', dur: 600, cam: () => [ovC, ovZ], aFloat: 0 });
  push({
    kind: 'step', i: 0, dur: 1200,
    cam: t => [lerpLL(ovC, PTS[0], easeInOut(t)), lerp(ovZ, FOLLOW_ZOOM, easeInOut(t))]
  });
  arrivals[0] = acc;
  for (let i = 1; i < N; i++) {
    const far = isFar(i), dur = stepDur(i);
    const from = PTS[i - 1], to = PTS[i];
    const arc = far ? makeArc(from, to) : 0;
    push({
      kind: 'step', i, dur, far,
      cam: t => {
        const e = far ? easeInOut(t) : t;
        return [lerpLL(from, to, e), FOLLOW_ZOOM - arc * Math.sin(Math.PI * t)];
      }
    });
    arrivals[i] = acc;
  }
  const last = PTS[N - 1];
  push({
    kind: 'finale', dur: 2000,
    cam: t => [lerpLL(last, ovC, easeInOut(t)), lerp(FOLLOW_ZOOM, ovZ, easeInOut(t))]
  });
  push({ kind: 'hold', dur: 1400, cam: () => [ovC, ovZ], aFloat: N });
  return { phases, arrivals, totalMs: acc };
}

function stateAt(phases, elapsed) {
  let ph = phases[phases.length - 1], tLoc = 1;
  for (const p of phases) {
    if (elapsed < p.t0 + p.dur) { ph = p; tLoc = (elapsed - p.t0) / p.dur; break; }
  }
  tLoc = clamp01(tLoc);
  let aFloat, head, curIdx;
  if (ph.kind === 'hold') {
    aFloat = ph.aFloat; head = ph.aFloat >= N ? PTS[N - 1] : null; curIdx = ph.aFloat - 1;
  } else if (ph.kind === 'finale') {
    aFloat = N; head = PTS[N - 1]; curIdx = N - 1;
  } else if (ph.i === 0) {
    aFloat = tLoc; head = PTS[0]; curIdx = 0;
  } else {
    const e = ph.far ? easeInOut(tLoc) : tLoc;
    aFloat = ph.i + tLoc;
    head = lerpLL(PTS[ph.i - 1], PTS[ph.i], e);
    curIdx = ph.i;
  }
  const final = ph.kind === 'finale' || (ph.kind === 'hold' && ph.aFloat >= N);
  return { cam: ph.cam(tLoc), aFloat, head, curIdx, final };
}

function timeForAFloat(phases, arrivals, a) {
  if (a <= 0) return 0;
  if (a >= N) return arrivals[N - 1];
  const i = Math.floor(a), frac = a - i;
  for (const ph of phases) {
    if (ph.kind === 'step' && ph.i === i) return ph.t0 + frac * ph.dur;
  }
  return i > 0 ? arrivals[i - 1] : 0;
}

// ------------------------------------------------------------------ кэш тайлов (общий, в памяти)
const tileCache = new Map();   // "z/x/y" -> Image (загруженные с crossOrigin)

function collectTiles(phases, W, H) {
  const keys = new Set();
  for (const ph of phases) {
    const samples = Math.max(6, Math.ceil(ph.dur / 150));
    for (let s = 0; s <= samples; s++) {
      const [c, zf] = ph.cam(s / samples);
      const z = Math.round(zf);
      const [cx, cy] = project(c.lat, c.lng, z);
      const n = Math.pow(2, z);
      const x0 = Math.floor((cx - W / 2) / 256) - 1, x1 = Math.floor((cx + W / 2) / 256) + 1;
      const y0 = Math.floor((cy - H / 2) / 256) - 1, y1 = Math.floor((cy + H / 2) / 256) + 1;
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++)
          if (x >= 0 && y >= 0 && x < n && y < n) keys.add(z + '/' + x + '/' + y);
    }
  }
  return [...keys];
}

let tilesAborted = false;
function loadTiles(keys, onProgress) {
  keys = keys.filter(k => !tileCache.has(k));
  return new Promise(resolve => {
    let done = 0, idx = 0, finished = false;
    const total = keys.length;
    const fin = () => { if (!finished) { finished = true; resolve(); } };
    if (!total) { fin(); return; }
    const CONC = 16;
    const next = () => {
      if (finished || tilesAborted) { fin(); return; }
      if (idx >= total) { if (done >= total) fin(); return; }
      const key = keys[idx++];
      const [z, x, y] = key.split('/').map(Number);
      const img = new Image();
      img.crossOrigin = 'anonymous';
      const step = ok => () => {
        if (ok) tileCache.set(key, img);
        done++; onProgress && onProgress(done, total);
        done >= total ? fin() : next();
      };
      img.onload = step(true); img.onerror = step(false);
      img.src = TILE_URL(z, x, y);
    };
    for (let k = 0; k < CONC; k++) next();
  });
}

// ------------------------------------------------------------------ отрисовка кадра (канвас: живое проигрывание и видео)
function drawFrame(ctx, W, H, cam, aFloat, head, tlMs, curIdx, arrivals, withHud, finalHud) {
  const [c, zf] = cam;
  ctx.fillStyle = '#0b0e14';
  ctx.fillRect(0, 0, W, H);

  const z = Math.round(zf);
  const scale = Math.pow(2, zf - z);
  const [cx, cy] = project(c.lat, c.lng, z);
  const originX = cx * scale - W / 2, originY = cy * scale - H / 2;
  const ts = 256 * scale;
  const x0 = Math.floor(originX / ts), x1 = Math.floor((originX + W) / ts);
  const y0 = Math.floor(originY / ts), y1 = Math.floor((originY + H) / ts);
  ctx.imageSmoothingEnabled = true;

  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++) {
      let img = tileCache.get(z + '/' + x + '/' + y);
      if (img) {
        ctx.drawImage(img, x * ts - originX, y * ts - originY, ts + 0.6, ts + 0.6);
        continue;
      }
      // запасной вариант: родительский тайл (z-1), растянутый — вместо пустоты
      img = tileCache.get((z - 1) + '/' + (x >> 1) + '/' + (y >> 1));
      if (img) {
        const half = 128;
        ctx.drawImage(img, (x & 1) * half, (y & 1) * half, half, half,
                      x * ts - originX, y * ts - originY, ts + 0.6, ts + 0.6);
      }
    }

  const toScreen = ll => {
    const [px, py] = project(ll.lat, ll.lng, z);
    return [px * scale - originX, py * scale - originY];
  };

  const placedN = Math.min(N, Math.floor(aFloat));
  const scr = [];
  for (let i = 0; i < placedN; i++) scr.push(toScreen(PTS[i]));
  const headScr = head ? toScreen(head) : null;

  const path = scr.slice();
  if (headScr && aFloat < N) path.push(headScr);
  if (path.length > 1) {
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const [w, style] of [[11, 'rgba(255,90,54,0.14)'], [4, 'rgba(255,139,98,0.8)']]) {
      ctx.beginPath();
      ctx.moveTo(path[0][0], path[0][1]);
      for (let k = 1; k < path.length; k++) ctx.lineTo(path[k][0], path[k][1]);
      ctx.strokeStyle = style; ctx.lineWidth = w;
      ctx.stroke();
    }
  }

  ctx.fillStyle = 'rgba(255,90,54,0.65)';
  for (let i = 0; i < placedN; i++) {
    const [sx, sy] = scr[i];
    if (sx < -10 || sy < -10 || sx > W + 10 || sy > H + 10) continue;
    ctx.beginPath(); ctx.arc(sx, sy, 4, 0, Math.PI * 2); ctx.fill();
  }

  for (let i = 0; i < placedN; i++) {
    const dt = tlMs - arrivals[i];
    if (dt < 0 || dt > BURST_MS + 160) continue;
    const [sx, sy] = scr[i];
    for (const delay of [0, 160]) {
      const p = (dt - delay) / BURST_MS;
      if (p < 0 || p > 1) continue;
      ctx.strokeStyle = `rgba(255,90,54,${(1 - p) * 0.95})`;
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(sx, sy, 8 + p * 26, 0, Math.PI * 2); ctx.stroke();
    }
  }

  if (headScr) {
    const [hx, hy] = headScr;
    ctx.shadowColor = ACCENT; ctx.shadowBlur = 18;
    ctx.fillStyle = ACCENT;
    ctx.beginPath(); ctx.arc(hx, hy, 7, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(hx, hy, 7, 0, Math.PI * 2); ctx.stroke();
  }

  if (withHud) {
    const k = H / 720;
    ctx.fillStyle = 'rgba(13,16,24,0.75)';
    roundRect(ctx, 24 * k, 24 * k, 320 * k, 116 * k, 14 * k); ctx.fill();
    ctx.fillStyle = '#9aa0ad'; ctx.font = `600 ${13 * k}px Segoe UI, Arial`;
    ctx.fillText('КАРТА ПРОБЕЖЕК', 44 * k, 52 * k);
    if (finalHud) {
      // финальный кадр: период всей истории
      ctx.fillStyle = '#f4f3f1'; ctx.font = `800 ${21 * k}px Segoe UI, Arial`;
      ctx.fillText('__DATE_RANGE__', 44 * k, 88 * k);
      ctx.fillStyle = '#ff8b62'; ctx.font = `700 ${16 * k}px Segoe UI, Arial`;
      ctx.fillText(`${N} пробежек · ${CUM_KM[N - 1].toFixed(1)} км`, 44 * k, 122 * k);
    } else {
      ctx.fillStyle = '#f4f3f1'; ctx.font = `800 ${34 * k}px Segoe UI, Arial`;
      ctx.fillText(curIdx >= 0 ? RUNS[curIdx].date : '—', 44 * k, 92 * k);
      ctx.fillStyle = '#ff8b62'; ctx.font = `700 ${16 * k}px Segoe UI, Arial`;
      const km = curIdx >= 0 ? CUM_KM[curIdx].toFixed(1) : '0';
      ctx.fillText(`${Math.min(placedN, N)} / ${N} пробежек · ${km} км`, 44 * k, 122 * k);
    }
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ------------------------------------------------------------------ живое проигрывание на канвасе (камера включена)
// Тайлы рисуются из памяти (tileCache) — серых квадратов не бывает.
let live = null;          // {phases, arrivals, totalMs, base, startTs, raf, ctx, W, H, lastAFloat}
let preloadedForSpeed = null;

function hideLiveCanvas() {
  liveCanvas.classList.remove('visible');
  if (live && live.raf) cancelAnimationFrame(live.raf);
  if (live) live.raf = 0;
}

async function ensureTilesFor(phases, W, H, label) {
  const keys = collectTiles(phases, W, H);
  tilesAborted = false;
  await loadTiles(keys, (d, t) => {
    counterEl.textContent = `${label} ${Math.round(d / t * 100)}%`;
  });
  syncCounters();
}

async function startCanvasPlayback(fromAFloat) {
  const W = liveCanvas.clientWidth || window.innerWidth;
  const H = liveCanvas.clientHeight || window.innerHeight;
  const { phases, arrivals, totalMs } = buildPhases(W, H);

  playBtn.disabled = true; videoBtn.disabled = true;
  await ensureTilesFor(phases, W, H, 'карта');
  playBtn.disabled = false; videoBtn.disabled = false;
  if (!playing) return;   // отменили, пока грузилась карта

  liveCanvas.width = W; liveCanvas.height = H;
  const ctx = liveCanvas.getContext('2d');
  liveCanvas.classList.add('visible');

  live = {
    phases, arrivals, totalMs, ctx, W, H,
    base: timeForAFloat(phases, arrivals, fromAFloat),
    startTs: performance.now(), raf: 0, lastAFloat: fromAFloat
  };

  const loop = () => {
    if (!playing || !live) return;
    const elapsed = live.base + (performance.now() - live.startTs);
    const st = stateAt(live.phases, elapsed);
    live.lastAFloat = st.aFloat;
    drawFrame(live.ctx, live.W, live.H, st.cam, st.aFloat, st.head, elapsed,
              st.curIdx, live.arrivals, false);

    // DOM-панели обновляются поверх канваса
    if (st.final) setHudPeriod(); else setHudFor(st.curIdx);
    const shown = Math.min(N, Math.floor(st.aFloat));
    shownCountEl.textContent = shown;
    counterEl.textContent = shown + ' / ' + N;
    slider.value = shown;

    if (elapsed >= live.totalMs) {
      // конец: бесшовно возвращаем Leaflet в том же ракурсе
      const endCam = stateAt(live.phases, live.totalMs).cam;
      playing = false;
      playBtn.textContent = '▶';
      camApply(endCam[0], endCam[1]);
      const savedLive = live; live = null;
      render(N);            // скрывает канвас
      return;
    }
    live.raf = requestAnimationFrame(loop);
  };
  live.raf = requestAnimationFrame(loop);
}

// ------------------------------------------------------------------ Leaflet-проигрывание (камера выключена — статичный вид)
function commitPoint(i) {
  committedLL.push(PTS[i]);
  const m = makeDot(RUNS[i]); m.addTo(dotsLayer); dotMarkers.push(m);
  placed = i + 1;
  setTrail(null);
  spawnBurst(PTS[i]);
  syncCounters();
}

function runStep(i, resumeElapsed) {
  if (i >= N) { playing = false; playBtn.textContent = '▶'; return; }
  const from = i === 0 ? PTS[0] : PTS[i - 1];
  const to = PTS[i];
  const dur = stepDur(i);
  const far = isFar(i);

  setHudFor(i);
  if (!map.hasLayer(headMarker)) headMarker.addTo(map);

  anim = { i, dur, from, to, far, start: performance.now() - (resumeElapsed || 0), raf: 0 };

  const a = anim;
  const frame = () => {
    if (!playing || anim !== a) return;
    const t = Math.min((performance.now() - a.start) / a.dur, 1);
    const head = lerpLL(a.from, a.to, a.far ? easeInOut(t) : t);
    if (i > 0) setTrail(head);
    headMarker.setLatLng(head);
    if (t < 1) {
      a.raf = requestAnimationFrame(frame);
    } else {
      commitPoint(i);
      anim = null;
      if (playing) runStep(i + 1);
    }
  };
  a.raf = requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ управление
async function play() {
  if (playing) return;
  stopFinale();
  playing = true;
  playBtn.textContent = '⏸';

  if (followCam.checked) {
    // кинорежим на канвасе
    let fromA;
    if (live && live.lastAFloat !== undefined && liveCanvas.classList.contains('visible')) {
      fromA = live.lastAFloat;              // продолжаем с паузы
    } else {
      fromA = (placed >= N) ? 0 : placed;   // с текущей позиции ползунка
    }
    if (fromA >= N) fromA = 0;
    await startCanvasPlayback(fromA);
  } else {
    hideLiveCanvas(); live = null;
    if (anim) { runStep(anim.i, anim.pausedElapsed || 0); return; }
    if (placed >= N) render(0);
    runStep(placed);
  }
}

function pause() {
  playing = false;
  playBtn.textContent = '▶';
  if (live && live.raf) {
    cancelAnimationFrame(live.raf); live.raf = 0;
    // Синхронизируем Leaflet под замороженным кадром, чтобы скраб был бесшовным
    const cur = stateAt(live.phases, timeForAFloat(live.phases, live.arrivals, live.lastAFloat));
    camApply(cur.cam[0], cur.cam[1]);
  }
  if (anim) {
    anim.pausedElapsed = performance.now() - anim.start;
    if (anim.raf) cancelAnimationFrame(anim.raf);
  }
}

playBtn.addEventListener('click', () => { playing ? pause() : play(); });
resetBtn.addEventListener('click', () => {
  pause(); live = null; render(0);
  map.fitBounds(bounds.pad(0.2));
});
slider.addEventListener('input', () => {
  pause(); live = null;
  render(parseInt(slider.value, 10));
});
speedSelect.addEventListener('change', () => {
  // смена скорости перестраивает таймлайн — продолжим с той же точки при следующем Play
  if (playing) { pause(); }
  if (live) { live.lastAFloat = Math.floor(live.lastAFloat || 0); }
});
followCam.addEventListener('change', () => { if (playing) pause(); });

// ------------------------------------------------------------------ экспорт видео
let exportAbort = false;

function setExportProgress(pct, text) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  exportPct.textContent = p + '%';
  exportBarFill.style.width = p + '%';
  if (text) exportStatus.textContent = text;
}

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('load failed'));
    document.head.appendChild(s);
  });
}

function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}

function nextTick() {
  return new Promise(r => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => r();
    ch.port2.postMessage(0);
  });
}

async function exportWebCodecs(W, H, FPS, BITRATE) {
  const MUXER_URL = 'https://cdn.jsdelivr.net/npm/mp4-muxer@5/build/mp4-muxer.min.js';
  if (!window.Mp4Muxer) await loadScript(MUXER_URL);

  const codecs = [
    ['avc', 'avc1.640028'], ['avc', 'avc1.42001f'], ['vp9', 'vp09.00.41.08']
  ];
  let chosen = null;
  for (const [mux, codec] of codecs) {
    const sup = await VideoEncoder.isConfigSupported(
      { codec, width: W, height: H, bitrate: BITRATE, framerate: FPS });
    if (sup.supported) { chosen = { mux, codec }; break; }
  }
  if (!chosen) throw new Error('нет поддерживаемого кодека');

  const { phases, arrivals, totalMs } = buildPhases(W, H);
  const keys = collectTiles(phases, W, H);
  tilesAborted = false;
  await loadTiles(keys, (d, t) => {
    setExportProgress(d / t * 12, 'Готовим карту...');
  });
  if (exportAbort) return;

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  const muxer = new Mp4Muxer.Muxer({
    target: new Mp4Muxer.ArrayBufferTarget(),
    video: { codec: chosen.mux, width: W, height: H },
    fastStart: 'in-memory'
  });
  let encError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: e => { encError = e; }
  });
  encoder.configure({ codec: chosen.codec, width: W, height: H,
                      bitrate: BITRATE, framerate: FPS });

  const totalFrames = Math.ceil(totalMs / 1000 * FPS);
  const usPerFrame = Math.round(1_000_000 / FPS);

  for (let f = 0; f < totalFrames; f++) {
    if (exportAbort) { try { encoder.close(); } catch (e) {} return; }
    if (encError) throw encError;

    const tlMs = f * 1000 / FPS;
    const st = stateAt(phases, tlMs);
    drawFrame(ctx, W, H, st.cam, st.aFloat, st.head, tlMs, st.curIdx, arrivals, true, st.final);

    const vf = new VideoFrame(canvas, { timestamp: f * usPerFrame, duration: usPerFrame });
    encoder.encode(vf, { keyFrame: f % (FPS * 4) === 0 });
    vf.close();

    if (encoder.encodeQueueSize > 8) {
      await new Promise(r => {
        const h = () => { encoder.removeEventListener('dequeue', h); r(); };
        encoder.addEventListener('dequeue', h);
        setTimeout(() => { encoder.removeEventListener('dequeue', h); r(); }, 500);
      });
    }
    if (f % 3 === 0) {
      setExportProgress(12 + f / totalFrames * 86,
        'Рендерим видео покадрово — можно свернуть вкладку, рендер продолжится...');
      await nextTick();
    }
  }

  await encoder.flush();
  muxer.finalize();
  if (exportAbort) return;
  setExportProgress(100, 'Сохраняем файл...');
  saveBlob(new Blob([muxer.target.buffer], { type: 'video/mp4' }),
           `karta-probezhek-${H}p${FPS}.mp4`);
}

async function exportRealtime(W, H) {
  const { phases, arrivals, totalMs } = buildPhases(W, H);
  const keys = collectTiles(phases, W, H);
  tilesAborted = false;
  await loadTiles(keys, (d, t) => {
    setExportProgress(d / t * 15, 'Готовим карту...');
  });
  if (exportAbort) return;

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  const mimes = ['video/mp4;codecs=avc1.42E01E', 'video/mp4',
                 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  const mime = mimes.find(m => MediaRecorder.isTypeSupported(m)) || '';
  const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';

  let stream = canvas.captureStream(0);
  let track = stream.getVideoTracks()[0];
  if (!track.requestFrame) { stream = canvas.captureStream(30); track = null; }

  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8_000_000 } : undefined);
  const chunks = [];
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  const recDone = new Promise(res => { rec.onstop = res; });
  rec.start(250);

  const t0 = performance.now();
  await new Promise(resolve => {
    const frame = () => {
      if (exportAbort) { resolve(); return; }
      const elapsed = performance.now() - t0;
      const st = stateAt(phases, elapsed);
      drawFrame(ctx, W, H, st.cam, st.aFloat, st.head, elapsed, st.curIdx, arrivals, true, st.final);
      if (track) track.requestFrame();
      setExportProgress(15 + elapsed / totalMs * 85,
        'Записываем в реальном времени — НЕ сворачивайте вкладку...');
      if (elapsed >= totalMs) { resolve(); return; }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });

  rec.stop();
  await recDone;
  if (exportAbort || !chunks.length) return;
  saveBlob(new Blob(chunks, { type: mime || 'video/webm' }), 'karta-probezhek.' + ext);
}

// --- выбор качества и FPS перед рендером ---
const QUALITY = {
  480:  { w: 854,  h: 480,  bitrate: 3_000_000 },
  720:  { w: 1280, h: 720,  bitrate: 6_000_000 },
  1080: { w: 1920, h: 1080, bitrate: 10_000_000 }
};
let selQuality = 1080, selFps = 30;

function bindSeg(segEl, onPick) {
  segEl.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      segEl.querySelectorAll('button').forEach(b => b.classList.remove('sel'));
      btn.classList.add('sel');
      onPick(parseInt(btn.dataset.v, 10));
    });
  });
}
bindSeg($('segQ'), v => { selQuality = v; });
bindSeg($('segF'), v => { selFps = v; });

async function runExport() {
  exportAbort = false;
  exportSettings.style.display = 'none';
  exportProgress.style.display = 'block';
  setExportProgress(0, 'Подготовка...');
  const q = QUALITY[selQuality];
  try {
    if (window.VideoEncoder) {
      try {
        await exportWebCodecs(q.w, q.h, selFps, q.bitrate);
        return;
      } catch (e) {
        if (exportAbort) return;
        console.warn('WebCodecs недоступен, запасной способ:', e);
      }
    }
    if (!window.MediaRecorder) {
      alert('Ваш браузер не поддерживает запись видео. Попробуйте Chrome или Edge.');
      return;
    }
    await exportRealtime(q.w, q.h);
  } finally {
    exportOverlay.classList.remove('visible');
  }
}

videoBtn.addEventListener('click', () => {
  pause();
  exportSettings.style.display = 'block';
  exportProgress.style.display = 'none';
  exportOverlay.classList.add('visible');
});
exportStart.addEventListener('click', () => { runExport().catch(e => {
  exportOverlay.classList.remove('visible');
  alert('Не получилось записать видео: ' + e.message);
}); });
exportClose.addEventListener('click', () => { exportOverlay.classList.remove('visible'); });
exportCancel.addEventListener('click', () => { exportAbort = true; tilesAborted = true; });

// ------------------------------------------------------------------ старт
render(N);
</script>

</body>
</html>
"""


def main() -> None:
    input_path = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    output_path = Path(sys.argv[2]) if len(sys.argv) > 2 else None
    try:
        out = build(input_path, output_path)
    except (FileNotFoundError, ValueError) as exc:
        sys.exit(str(exc))
    print("Откройте этот файл в браузере, чтобы посмотреть анимацию:")
    print(f"  {out}")


if __name__ == "__main__":
    main()
