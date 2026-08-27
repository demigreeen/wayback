/* WayBack — player.js
   Канвас-движок анимации истории тренировок. Перенос из build_animation.py (v8).

   Данные: одна точка старта на тренировку. Точки появляются в хронологическом
   порядке, между ними тянется постоянный след, камера ведётся покадрово.

   Отличия от v8:
   - палитра чёрно-синяя (#3b82f6 / #60a5fa на фоне #0b0e14);
   - водяной знак wayback.pro и атрибуция карты в кадре;
   - teardown() — плеер можно запускать повторно с другим архивом.

   НЕ ЛОМАТЬ (причины в PROJECT.md):
   - проигрывание с камерой идёт на своём канвасе, не через Leaflet: Leaflet при
     смене зума отменяет загрузку тайлов и карта во время перелёта сереет;
   - все тайлы грузятся в память ДО старта (tileCache);
   - экспорт видео покадровый через WebCodecs, yield между кадрами — через
     MessageChannel, а не setTimeout (таймеры тротлятся в фоновой вкладке).
*/
'use strict';

const WBPlayer = (() => {

  // Цвета кадра живут в theme.js вместе с цветами карты: подбирать их
  // порознь нельзя, иначе при смене темы след и карта разъезжаются.
  // Читаем функциями — тема меняется на лету, значение нужно на момент
  // отрисовки, а не на момент загрузки файла.
  const F = () => WBTheme.frame();
  const FOLLOW_ZOOM = 13;
  const FAR_METERS = 25000;
  const BURST_MS   = 700;

  // Камера не должна дёргаться за каждой тренировкой. Пока следующая точка
  // рядом с текущим центром И с большим запасом внутри кадра — камера стоит,
  // движется только голова. Радиус в метрах задаёт поведение, пиксельная
  // зона — страховка, чтобы точка не ушла за край на маленьком кадре.
  //
  // 4 км, а не прежние 2.5: на демо-истории камера стояла в 39% шагов и
  // переезжала внутри одного города, хотя смысл переезда — показать смену
  // места. С 4 км стоит в 80%. Пять километров дают 95%, но тогда камера
  // почти не двигается вовсе и анимация теряет ход.
  //
  // Оговорка про превью. Зона ограничена ещё и кадром, а кадр превью меньше
  // видео: вертикальное превью на ноутбуке — около 530 px, в него при зуме 13
  // влезает ~3.2 км, а не 4. Поэтому в вертикали превью камера переезжает
  // чуть раньше, чем в скачанном видео (72% против 80%). В горизонтали
  // и на видео решает радиус, и они совпадают точно. Убрать расхождение
  // можно только уменьшив FOLLOW_ZOOM, а это меняет вид всей анимации.
  const HOLD_RADIUS_M = 4000;
  const HOLD_SAFE_FRAC = 0.9;
  const WATERMARK  = 'wayback.pro';

  // ---------------------------------------------------------------- источник карты
  // ЕДИНСТВЕННОЕ место, где задаётся карта. Отсюда её берут все трое:
  // интерактивный Leaflet, канвас-движок и подпись в кадре видео.
  // Раньше это лежало в трёх местах и легко расходилось.
  //
  // ВНИМАНИЕ по лицензии. Тайлы попадают в скачиваемое видео, а это
  // распространение производного материала — отдельный пункт почти во всех
  // условиях. У CARTO бесплатный тариф только некоммерческий; у MapTiler
  // и Stadia экспорт в видео на любом тарифе согласуется отдельно.
  // Чистый путь — свои тайлы из данных OpenStreetMap: там рендер считается
  // «Produced Work», распространять его можно свободно, нужна лишь атрибуция.
  // Подробности и план перехода — в docs/MAPS.md.
  //
  // ИСТОЧНИКОВ НЕСКОЛЬКО, и это не запас на всякий случай. Основной,
  // OpenFreeMap, стоит за Cloudflare, а Cloudflare у части мобильных
  // операторов в России недоступен — у таких посетителей карта не
  // появлялась вовсе, и демо зависало на «Готовим карту». Запасные
  // выбраны так, чтобы не зависеть от Cloudflare: VersaTiles — свой
  // хостинг, тайлы OpenStreetMap — Fastly.
  //
  // Схема слоёв у запасных другая (Shortbread против OpenMapTiles),
  // приведение к общему словарю живёт в vectormap.js.
  const MAP = {
    // Векторные тайлы OpenStreetMap. Картинку рисуем сами (js/vectormap.js),
    // поэтому готовый кадр — наш Produced Work по ODbL: распространять
    // в видео можно свободно, нужна только атрибуция.
    sources: [
      { name: 'OpenFreeMap', schema: 'openmaptiles',
        tilejson: 'https://tiles.openfreemap.org/planet' },
      { name: 'VersaTiles', schema: 'shortbread', maxzoom: 14,
        tiles: 'https://tiles.versatiles.org/tiles/osm/{z}/{x}/{y}' },
      { name: 'OSM vector', schema: 'shortbread', maxzoom: 14,
        tiles: 'https://vector.openstreetmap.org/shortbread_v1/{z}/{x}/{y}.mvt' }
    ],
    maxZoom: 20,
    attribution: '© OpenStreetMap',
    commercial: true
  };

  // Карта не обязательна: без неё следы и подписи всё равно рисуются.
  // Флаг нужен, чтобы не молчать — человек должен понимать, почему фон пуст.
  let mapUnavailable = false;

  const ATTRIB = MAP.attribution;

  // Толщина следа, точек и курсора у превью и у видео РАЗНАЯ — намеренно.
  // В видео геометрия пропорциональна кадру: иначе в 1080×1920 абсолютные
  // 4 px выглядят вдвое тоньше, чем в превью шириной ~530 px.
  // В превью — те же экранные пиксели, что были изначально: на маленьком
  // кадре пропорциональный масштаб выглядит непомерно жирно.
  const STROKE_VIDEO = 1.5;
  const geoForVideo = (W, H) => Math.min(W, H) / 720 * STROKE_VIDEO;

  // ---------------------------------------------------------------- утилиты
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

  // Русская форма множественного числа: 1 город, 2 города, 5 городов
  function plural(n, forms) {
    const a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return forms[2];
    if (b > 1 && b < 5) return forms[1];
    if (b === 1) return forms[0];
    return forms[2];
  }

  // ---------------------------------------------------------------- геолокация
  // Ближайший крупный город к точке. Данные — WBCities (GeoNames, CC BY),
  // целиком локально: ни одного запроса наружу, иначе рушится обещание
  // приватности, ради которого сайт и сделан бессерверным.
  const MAX_CITY_KM = 120;
  let cityGrid = null;

  // Для сопоставления с названием тренировки: «Париж» и «Paris 18» должны
  // сойтись независимо от регистра и диакритики («Gràcia» ↔ «Gracia»).
  const norm = s => s.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');

  function buildCityGrid() {
    cityGrid = new Map();
    if (typeof WBCities === 'undefined') return;
    const add = (str, isDistrict) => {
      if (!str) return;
      const recs = str.split(';');
      for (let rank = 0; rank < recs.length; rank++) {
        const p = recs[rank].split('|');
        if (p.length !== 4) continue;
        const lat = +p[2] / 100, lon = +p[3] / 100;
        const key = Math.round(lat) + ':' + Math.round(lon);
        let cell = cityGrid.get(key);
        if (!cell) { cell = []; cityGrid.set(key, cell); }
        // rank — номер по убыванию населения: данные так отсортированы
        cell.push({ name: p[0], cc: p[1], lat, lon, rank,
                    district: isDistrict, norm: norm(p[0]) });
      }
    };
    add(WBCities.packed, false);
    add(WBCities.districts, true);
  }

  // Название встречается в тексте как отдельное слово, а не куском другого:
  // без этой проверки «Ош» находился бы в слове «Хорошая».
  function nameInText(text, needle) {
    if (needle.length < 3) return false;
    let i = text.indexOf(needle);
    while (i !== -1) {
      const before = i === 0 ? ' ' : text[i - 1];
      const after = i + needle.length >= text.length ? ' ' : text[i + needle.length];
      if (!/[a-zа-я0-9]/.test(before) && !/[a-zа-я0-9]/.test(after)) return true;
      i = text.indexOf(needle, i + 1);
    }
    return false;
  }

  // place — место прямо из выгрузки (Garmin отдаёт locationName: «Москва»,
  // «Одинцовский район»). Это точнее любой геометрии и уже на языке
  // пользователя, поэтому имеет приоритет.
  // title — название тренировки; в нём место тоже часто есть («Kaluga Running»).
  function locationOf(lat, lon, title, place) {
    if (!cityGrid) buildCityGrid();
    if (!cityGrid.size) return null;
    const cosLat = Math.max(0.05, Math.cos(lat * Math.PI / 180));
    // К полюсам градус долготы короче — расширяем окно поиска, иначе
    // на широте Хельсинки ближайший город может не попасть в ячейки
    const spanLo = Math.max(2, Math.ceil(1.5 / cosLat));
    const la = Math.round(lat), lo = Math.round(lon);
    const cand = [];
    let bestD = Infinity;
    for (let dla = -2; dla <= 2; dla++)
      for (let dlo = -spanLo; dlo <= spanLo; dlo++) {
        const cell = cityGrid.get((la + dla) + ':' + (lo + dlo));
        if (!cell) continue;
        for (const c of cell) {
          const dx = (c.lon - lon) * cosLat, dy = c.lat - lat;
          const d = Math.sqrt(dx * dx + dy * dy) * 111.32;   // км
          if (d > MAX_CITY_KM) continue;
          cand.push({ d, c });
          if (!c.district && d < bestD) bestD = d;
        }
      }
    if (!cand.length) return null;

    // Ближайший город — он же основа для подсчёта городов и стран.
    // Из близких берём самый крупный: пробежка в пригороде должна
    // подписываться «Лион», а не названием соседней коммуны.
    const limit = Math.max(bestD * 1.15, 12);
    let base = null, bestRank = Infinity;
    for (const { d, c } of cand) {
      if (!c.district && d <= limit && c.rank < bestRank) { bestRank = c.rank; base = c; }
    }
    if (!base) return null;

    // Если место названо в самой тренировке — берём оттуда. Название сверяем
    // только с окрестными кандидатами: иначе «Long Run» нашёл бы город Лонг
    // где-нибудь на другом континенте.
    let named = null;
    if (!place && title) {
      const t = norm(title);
      for (const { c } of cand) {
        if (!nameInText(t, c.norm)) continue;
        // Длиннее — точнее: «Sant Marti» важнее, чем «Sant»
        if (!named || c.norm.length > named.norm.length) named = c;
      }
    }

    const country = (WBCities.ru && WBCities.ru[base.cc]) || base.cc;
    const shownName = place || (named ? named.name : base.name);
    return {
      city: base.name, cc: base.cc, country,     // для подсчёта — всегда город
      label: shownName + ', ' + country           // в кадре — что точнее
    };
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

  // ---------------------------------------------------------------- состояние
  let ACTS = [], PTS = [], N = 0, CUM_KM = [], bounds = null, DATE_RANGE = '';
  // Полный список тренировок, каким его дал лендинг. Выбор периода
  // перезапускает плеер на подмножестве, и без исходника расширить
  // период обратно было бы уже нечем.
  let SOURCE_ACTS = [];
  let GEO_SUMMARY = '';         // «5 городов · 2 страны» для финального кадра
  let map = null, trailGlow = null, trail = null, dotsLayer = null, headMarker = null;
  let gridLayer = null;          // слой карты Leaflet — перерисовывается при смене темы
  let placed = 0;
  const committedLL = [];
  const dotMarkers = [];
  let playing = false;
  let anim = null;              // Leaflet-режим (камера выключена)
  let live = null;              // канвас-режим
  let uiBound = false;

  // Ориентация кадра. Вертикаль — основной формат: TikTok, Reels и Shorts
  // вертикальные, а именно они главный канал распространения.
  const FRAMES = {
    portrait:  { 480: [480, 854],  720: [720, 1280],  1080: [1080, 1920], ratio: 9 / 16 },
    landscape: { 480: [854, 480],  720: [1280, 720],  1080: [1920, 1080], ratio: 16 / 9 }
  };
  const BITRATES = { 480: 3_000_000, 720: 6_000_000, 1080: 10_000_000 };
  // Ориентация превью и ориентация выгрузки разведены намеренно.
  //
  // Смотрят на том экране, который есть: на компьютере широкий кадр занимает
  // окно целиком, вертикальный оставил бы чёрные поля по бокам. А делятся
  // вертикальным — именно он идёт в истории и ленты. Раньше это была одна
  // величина, и приходилось выбирать, чем пожертвовать.
  //
  // Расхождение теперь безопасно: после рендера показывается готовое видео,
  // так что человек видит результат до того, как скачает.
  let previewOrient = 'portrait';
  let exportOrient = 'portrait';
  let selQuality = 1080, selFps = 30;

  // Телефон определяем по типу указателя, а не по ширине окна: узкое окно
  // на десктопе рендерит 1080p нормально, а планшет с мышью — тоже
  const isMobile = () =>
    window.matchMedia('(pointer: coarse)').matches && window.innerWidth < 900;

  // Размер кадра живого превью: тот же кадр, что уйдёт в видео, вписанный в окно
  function frameSize() {
    const vw = Math.max(320, window.innerWidth), vh = Math.max(240, window.innerHeight);
    const r = FRAMES[previewOrient].ratio;       // ширина / высота
    let w = Math.round(vh * r), h = vh;
    if (w > vw) { w = vw; h = Math.round(vw / r); }
    return [w, h];
  }

  // DOM
  let slider, playBtn, resetBtn, speedSelect, followCam, videoBtn, orientSelect;
  let shownCountEl, currentDateEl, currentNameEl, cumKmEl, counterEl, liveCanvas;
  let exportOverlay, exportPct, exportBarFill, exportStatus, exportCancel;
  let exportSettings, exportProgress, exportStart, exportClose;
  let buyBtns = [];

  // ---------------------------------------------------------------- геометрия шагов
  const delayMs = () => parseInt(speedSelect.value, 10);
  const isFar = i => i > 0 && PTS[i - 1].distanceTo(PTS[i]) > FAR_METERS;
  const stepDur = i => i === 0 ? 1200 : (isFar(i) ? Math.max(800, delayMs()) : delayMs());

  function makeArc(from, to) {
    const meters = from.distanceTo(to);
    if (meters < FAR_METERS) return 0;
    return Math.max(1.5, Math.min(8, Math.log2(meters / 3000)));
  }

  // ---------------------------------------------------------------- таймлайн
  function buildPhases(W, H) {
    // Отступ считается от короткой стороны — иначе в вертикали общий план
    // прижимается к краям, а в горизонтали остаются лишние поля
    const ovZ = fitZoom(bounds.pad(0.15), W, H, Math.round(Math.min(W, H) * 0.08));
    const ovC = bounds.getCenter();
    const phases = [];
    const arrivals = new Array(N).fill(Infinity);
    let acc = 0;
    const push = ph => { ph.t0 = acc; acc += ph.dur; phases.push(ph); };

    // Зона покоя: точка внутри неё камеру не сдвигает
    const safeX = W * HOLD_SAFE_FRAC / 2, safeY = H * HOLD_SAFE_FRAC / 2;
    const holds = (c, p) => {
      if (c.distanceTo(p) > HOLD_RADIUS_M) return false;
      const [cx, cy] = project(c.lat, c.lng, FOLLOW_ZOOM);
      const [px, py] = project(p.lat, p.lng, FOLLOW_ZOOM);
      return Math.abs(px - cx) <= safeX && Math.abs(py - cy) <= safeY;
    };

    push({ kind: 'hold', dur: 600, cam: () => [ovC, ovZ], aFloat: 0 });
    push({
      kind: 'step', i: 0, dur: 1200,
      cam: t => [lerpLL(ovC, PTS[0], easeInOut(t)), lerp(ovZ, FOLLOW_ZOOM, easeInOut(t))]
    });
    arrivals[0] = acc;

    let camC = PTS[0];                       // куда сейчас смотрит камера
    for (let i = 1; i < N; i++) {
      const far = isFar(i), dur = stepDur(i);
      const to = PTS[i];

      if (!far && holds(camC, to)) {
        // Камера стоит: соседние тренировки одного района не должны
        // болтать кадр туда-сюда. Двигается только голова.
        const fixed = camC;
        push({ kind: 'step', i, dur, far: false,
               cam: () => [fixed, FOLLOW_ZOOM] });
      } else {
        // Точка вышла из зоны покоя — переезжаем и центрируемся на ней
        const from = camC;
        const arc = far ? makeArc(from, to) : 0;
        push({
          kind: 'step', i, dur, far,
          cam: t => {
            const e = easeInOut(t);
            return [lerpLL(from, to, e), FOLLOW_ZOOM - arc * Math.sin(Math.PI * t)];
          }
        });
        camC = to;
      }
      arrivals[i] = acc;
    }

    // Отъезд начинается оттуда, где камера реально стоит, а не от последней
    // точки — иначе перед финалом получается рывок
    const fromFinale = camC;
    push({
      kind: 'finale', dur: 2000,
      cam: t => [lerpLL(fromFinale, ovC, easeInOut(t)), lerp(FOLLOW_ZOOM, ovZ, easeInOut(t))]
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

  // ---------------------------------------------------------------- кэш тайлов
  const tileCache = new Map();
  let tilesAborted = false;

  // Тайл нарисован в цветах той темы, что была на момент отрисовки, поэтому
  // при переключении кэш сбрасывается. Данные тайлов (самое дорогое — сеть)
  // лежат отдельно в vectormap.js и переживают смену темы, так что заново
  // ничего не скачивается, только перерисовывается.
  //
  // Поколение нужно из-за отрисовок, начатых до переключения: их результат
  // придёт уже в новой теме и в кэш попасть не должен.
  let themeGen = 0;

  // untilMs — собрать только начало таймлайна: этого хватает, чтобы
  // запустить проигрывание, не дожидаясь всей карты
  function collectTiles(phases, W, H, untilMs) {
    const keys = new Set();
    for (const ph of phases) {
      if (untilMs !== undefined && ph.t0 > untilMs) break;
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

  // Тайлы рисуются из векторных данных в канвас. Дальше по течению ничего
  // не меняется: drawImage одинаково принимает и картинку, и канвас.
  // Одна волна загрузки на текущем источнике. Возвращает список ключей,
  // которые не пришли: по нему решается, дырки это или мёртвый источник.
  function loadWave(keys, onTile) {
    return new Promise(resolve => {
      let idx = 0, live = 0, finished = false;
      const failed = [];
      const total = keys.length;
      const fin = () => { if (!finished) { finished = true; resolve(failed); } };
      const CONC = 16;
      const next = () => {
        if (finished || tilesAborted) { fin(); return; }
        if (idx >= total) { if (live === 0) fin(); return; }
        const key = keys[idx++];
        const [z, x, y] = key.split('/').map(Number);
        const gen = themeGen;
        live++;
        WBVectorMap.renderTile(z, x, y)
          .then(cv => {
            // Не пришедший тайл в кэш не кладём: он неотличим от честно
            // пустого, а закэшированная пустышка пережила бы переход
            // на живой источник и осталась дыркой навсегда.
            if (cv && cv.failed) failed.push(key);
            else if (gen === themeGen) tileCache.set(key, cv);
          })
          .catch(() => { failed.push(key); })
          .then(() => {
            live--;
            onTile && onTile();
            if (idx >= total && live === 0) fin(); else next();
          });
      };
      for (let k = 0; k < CONC; k++) next();
    });
  }

  async function loadTiles(keys, onProgress) {
    keys = keys.filter(k => !tileCache.has(k));
    if (!keys.length) return;
    // Карта недоступна — не повод не показать анимацию: следы, подписи
    // и весь HUD рисуются поверх фона и без тайлов. Раньше здесь падало
    // необработанным исключением, и проигрывание не начиналось:
    // человек навсегда оставался на полосе «Готовим карту».
    try {
      await WBVectorMap.init(MAP.sources);
    } catch (e) {
      console.warn('карта:', e && e.message ? e.message : e);
      noteMapUnavailable();
      return;
    }

    // Источник, прошедший проверку, ещё не обязан выдержать нагрузку.
    // Проверочный запрос один, а тут их сотни, и тайлы на рабочем зуме
    // весят по сотне килобайт: у мобильных операторов мелкое проходит,
    // крупное — нет. Поэтому следим за долей неудач и на ходу уходим
    // к следующему источнику. Именно из-за этого карта была в превью,
    // но пропадала в рендере видео, где тайлов нужно на порядок больше.
    const total = keys.length;
    let done = 0;
    const tick = () => { done++; onProgress && onProgress(Math.min(done, total), total); };

    let pending = keys;
    for (let attempt = 0; attempt <= MAP.sources.length; attempt++) {
      const failed = await loadWave(pending, tick);
      if (tilesAborted) return;
      // Отдельные дырки — обычное дело: у источника может не быть тайла.
      // Их дорисует растянутый родительский, менять источник незачем.
      if (failed.length * 2 <= pending.length) return;
      if (!(await WBVectorMap.nextSource())) {
        noteMapUnavailable();
        return;
      }
      // Новый источник — новая схема и новые данные: всё, что успели
      // нарисовать прежним, пересобираем.
      tileCache.clear();
      if (gridLayer && gridLayer.redraw) gridLayer.redraw();
      pending = keys;
      done = 0;
    }
  }

  // ---------------------------------------------------------------- кадр
  // geo — масштаб геометрии следа. Приходит снаружи, потому что у превью и
  // у видео он разный: см. STROKE_VIDEO.
  function drawFrame(ctx, W, H, cam, aFloat, head, tlMs, curIdx, arrivals,
                     withHud, finalHud, geo) {
    const [c, zf] = cam;
    ctx.fillStyle = F().bg;
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
        // Запасной вариант: родительский тайл, растянутый — вместо пустоты.
        // Поднимаемся на несколько уровней: фоновая догрузка может отставать,
        // и одного уровня вверх не всегда хватает.
        for (let up = 1; up <= 4; up++) {
          const pz = z - up, px = x >> up, py = y >> up;
          if (pz < 0) break;
          img = tileCache.get(pz + '/' + px + '/' + py);
          if (!img) continue;
          const part = 256 >> up;                       // какая доля тайла нужна
          ctx.drawImage(img, (x - (px << up)) * part, (y - (py << up)) * part,
                        part, part,
                        x * ts - originX, y * ts - originY, ts + 0.6, ts + 0.6);
          break;
        }
      }

    // Подписи городов и стран — поверх тайлов, но под следом: карта остаётся
    // фоном. Координаты берём мировые, из тайлов, поэтому текст не режется
    // на стыках и не двоится.
    drawPlaceLabels(ctx, W, H, z, scale, originX, originY, x0, x1, y0, y1);

    const toScreen = ll => {
      const [px, py] = project(ll.lat, ll.lng, z);
      return [px * scale - originX, py * scale - originY];
    };

    const placedN = Math.min(N, Math.floor(aFloat));
    const scr = [];
    for (let i = 0; i < placedN; i++) scr.push(toScreen(PTS[i]));
    const headScr = head ? toScreen(head) : null;

    const g = geo || 1;

    const path = scr.slice();
    if (headScr && aFloat < N) path.push(headScr);
    if (path.length > 1) {
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      for (const [w, style] of [[11 * g, F().trailGlow],
                                [4 * g, F().trailLine]]) {
        ctx.beginPath();
        ctx.moveTo(path[0][0], path[0][1]);
        for (let k = 1; k < path.length; k++) ctx.lineTo(path[k][0], path[k][1]);
        ctx.strokeStyle = style; ctx.lineWidth = w;
        ctx.stroke();
      }
    }

    const dotR = 4 * g, margin = dotR + 4;
    ctx.fillStyle = F().dot;
    for (let i = 0; i < placedN; i++) {
      const [sx, sy] = scr[i];
      if (sx < -margin || sy < -margin || sx > W + margin || sy > H + margin) continue;
      ctx.beginPath(); ctx.arc(sx, sy, dotR, 0, Math.PI * 2); ctx.fill();
    }

    for (let i = 0; i < placedN; i++) {
      const dt = tlMs - arrivals[i];
      if (dt < 0 || dt > BURST_MS + 160) continue;
      const [sx, sy] = scr[i];
      for (const delay of [0, 160]) {
        const p = (dt - delay) / BURST_MS;
        if (p < 0 || p > 1) continue;
        ctx.strokeStyle = `rgba(${F().burst},${(1 - p) * 0.95})`;
        ctx.lineWidth = 2.5 * g;
        ctx.beginPath(); ctx.arc(sx, sy, (8 + p * 26) * g, 0, Math.PI * 2); ctx.stroke();
      }
    }

    if (headScr) {
      const [hx, hy] = headScr;
      const hr = 7 * g;
      ctx.shadowColor = F().accent; ctx.shadowBlur = 18 * g;
      ctx.fillStyle = F().accent;
      ctx.beginPath(); ctx.arc(hx, hy, hr, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = F().headRing; ctx.lineWidth = 2 * g;
      ctx.beginPath(); ctx.arc(hx, hy, hr, 0, Math.PI * 2); ctx.stroke();
    }

    // Масштаб HUD считается по короткой стороне: иначе в вертикали 1080×1920
    // панель раздувается до ширины кадра, а в горизонтали выглядит мелкой
    const k = Math.min(W, H) / 720;

    // атрибуция карты — требование лицензии OpenStreetMap/CARTO
    ctx.textAlign = 'left';
    ctx.fillStyle = F().attribution;
    ctx.font = `500 ${10.5 * k}px "Segoe UI", Arial`;
    ctx.fillText(ATTRIB, 12 * k, H - 10 * k);

    if (withHud) {
      // Покупка убирает обе марки: «WAYBACK» в шапке панели и адрес
      // в правом нижнем углу. Без шапки панель не должна остаться
      // с пустотой сверху — содержимое поднимается, а сама она укорачивается.
      const brand = !(typeof WBLicense !== 'undefined' && WBLicense.isPaid());
      const up = brand ? 0 : 32;

      const boxW = Math.min(360 * k, W - 48 * k);
      ctx.fillStyle = F().hudPanel;
      roundRect(ctx, 24 * k, 24 * k, boxW, (152 - up) * k, 14 * k); ctx.fill();
      if (brand) {
        ctx.fillStyle = F().accentHi; ctx.font = `700 ${13 * k}px "Segoe UI", Arial`;
        ctx.fillText('WAYBACK', 44 * k, 54 * k);
      }

      const dim = F().hudDim;
      if (finalHud) {
        ctx.fillStyle = F().hudText; ctx.font = `800 ${21 * k}px "Segoe UI", Arial`;
        ctx.fillText(DATE_RANGE, 44 * k, (94 - up) * k);
        ctx.fillStyle = dim; ctx.font = `600 ${15 * k}px "Segoe UI", Arial`;
        ctx.fillText(GEO_SUMMARY || 'вся история', 44 * k, (122 - up) * k);
        ctx.fillStyle = F().accentHi; ctx.font = `700 ${16 * k}px "Segoe UI", Arial`;
        ctx.fillText(`${N} ${plural(N, ['тренировка', 'тренировки', 'тренировок'])} · ` +
                     `${CUM_KM[N - 1].toFixed(1)} км`, 44 * k, (152 - up) * k);
      } else {
        const cur = curIdx >= 0 && curIdx < N ? ACTS[curIdx] : null;
        ctx.fillStyle = F().hudText; ctx.font = `800 ${34 * k}px "Segoe UI", Arial`;
        ctx.fillText(cur ? cur.date : '—', 44 * k, (96 - up) * k);
        ctx.fillStyle = dim; ctx.font = `600 ${15 * k}px "Segoe UI", Arial`;
        ctx.fillText(ellipsize(ctx, cur && cur.locLabel ? cur.locLabel : '',
                               boxW - 40 * k), 44 * k, (122 - up) * k);
        ctx.fillStyle = F().accentHi; ctx.font = `700 ${16 * k}px "Segoe UI", Arial`;
        const km = curIdx >= 0 ? CUM_KM[Math.min(curIdx, N - 1)].toFixed(1) : '0';
        ctx.fillText(`${placedN} / ${N} · ${km} км`, 44 * k, (152 - up) * k);
      }

      // Водяной знак сайта. Он же — канал привлечения: бесплатное видео
      // уходит в соцсети с адресом в углу. Снимается покупкой.
      if (typeof WBLicense !== 'undefined' && WBLicense.isPaid()) return;
      ctx.textAlign = 'right';
      ctx.font = `700 ${15 * k}px "Segoe UI", Arial`;
      ctx.fillStyle = F().watermark;
      ctx.fillText(WATERMARK, W - 16 * k, H - 14 * k);
      const dotX = W - 16 * k - ctx.measureText(WATERMARK).width - 11 * k;
      ctx.fillStyle = F().accent;
      ctx.beginPath(); ctx.arc(dotX, H - 19 * k, 4.5 * k, 0, Math.PI * 2); ctx.fill();
      ctx.textAlign = 'left';
    }
  }

  // Подписи населённых пунктов из тайлов. Крупные важнее мелких, поэтому
  // сортируем по значимости и выкидываем то, что налезает на уже
  // поставленное: иначе на общем плане получается каша из имён.
  function drawPlaceLabels(ctx, W, H, z, scale, originX, originY, x0, x1, y0, y1) {
    const k = Math.min(W, H) / 720;
    const found = [];
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const t = tileCache.get(z + '/' + x + '/' + y);
        if (t && t.labels) found.push(...t.labels);
      }
    if (!found.length) return;
    found.sort((a, b) => a.rank - b.rank);

    // Одно и то же имя приходит из буферов нескольких тайлов — оставляем
    // первое вхождение, оно же самое значимое после сортировки
    const seen = new Set();
    const uniq = found.filter(l => {
      const key = l.name + '@' + Math.round(l.wx) + ',' + Math.round(l.wy);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const taken = [];
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = F().labelShadow;
    let drawn = 0;
    for (const l of uniq) {
      if (drawn >= 14) break;              // больше глазу и не нужно
      const px = l.wx * scale - originX, py = l.wy * scale - originY;
      const size = l.size * k;
      if (px < 0 || py < 0 || px > W || py > H) continue;
      ctx.font = `600 ${size}px "Segoe UI", Arial`;
      const w = ctx.measureText(l.name).width, h = size * 1.2;
      const box = [px - w / 2 - 4 * k, py - h / 2, px + w / 2 + 4 * k, py + h / 2];
      if (taken.some(t => !(box[2] < t[0] || box[0] > t[2] ||
                            box[3] < t[1] || box[1] > t[3]))) continue;
      taken.push(box);
      ctx.shadowBlur = 4 * k;
      ctx.fillStyle = l.cls === 'country' ? F().labelCountry : F().labelPlace;
      if (l.cls === 'country') ctx.letterSpacing = (2 * k) + 'px';
      ctx.fillText(l.name, px, py);
      if (l.cls === 'country') ctx.letterSpacing = '0px';
      drawn++;
    }
    ctx.shadowBlur = 0;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  // Длинные названия («Франкфурт-на-Майне, Германия») не должны вылезать за панель
  function ellipsize(ctx, text, maxW) {
    if (!text || ctx.measureText(text).width <= maxW) return text || '';
    let s = text;
    while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
    return s + '…';
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

  // Смена темы. Карта перерисовывается из тех же данных, слои Leaflet
  // перекрашиваются на месте, кадр рисуется заново — всё без перезагрузки.
  function applyTheme() {
    themeGen++;
    tileCache.clear();

    const f = WBTheme.frame();
    if (trailGlow) trailGlow.setStyle({ color: f.accent });
    if (trail) trail.setStyle({ color: f.accentHi });
    for (const m of dotMarkers) m.setStyle({ color: f.accent, fillColor: f.accent });

    const player = $('player');
    if (player) player.classList.toggle('light', WBTheme.isLight());
    if (map) map.getContainer().style.background = WBTheme.map().bg;
    if (gridLayer) gridLayer.redraw();

    // Живое превью держит свой кадр — пересобираем его целиком
    if (live) { pause(); live = null; }
    if (N) render(placed);
  }

  // Слой Leaflet поверх того же векторного рендера
  const VectorGridLayer = L.GridLayer.extend({
    createTile: function (coords, done) {
      const tile = document.createElement('canvas');
      tile.width = tile.height = 256;
      WBVectorMap.renderTile(coords.z, coords.x, coords.y)
        .then(cv => { tile.getContext('2d').drawImage(cv, 0, 0); done(null, tile); })
        .catch(err => done(err, tile));
      return tile;
    }
  });

  // ---------------------------------------------------------------- Leaflet-режим
  function makeDot(a) {
    return L.circleMarker([a.lat, a.lon], {
      radius: 4, color: F().accent, weight: 1, fillColor: F().accent, fillOpacity: 0.6
    }).bindPopup(`<b>${a.date}</b><br>${escapeHtml(a.name || '')}<br>${a.km} км`);
  }

  function setHudFor(i) {
    currentDateEl.classList.remove('period');
    if (i >= 0 && i < N) {
      currentDateEl.textContent = ACTS[i].date;
      currentNameEl.textContent = ACTS[i].locLabel || ACTS[i].name || '';
      cumKmEl.textContent = CUM_KM[i].toFixed(1);
    } else {
      currentDateEl.textContent = '—';
      currentNameEl.textContent = DATE_RANGE;
      cumKmEl.textContent = '0';
    }
  }

  // Финальный кадр: вместо даты последней тренировки — весь период
  function setHudPeriod() {
    currentDateEl.textContent = DATE_RANGE;
    currentDateEl.classList.add('period');
    currentNameEl.textContent = GEO_SUMMARY || `вся история · ${N} тренировок`;
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

  function cancelAnim() {
    if (anim && anim.raf) cancelAnimationFrame(anim.raf);
    anim = null;
  }

  function hideLiveCanvas() {
    showMapLoading(false);
    liveCanvas.classList.remove('visible');
    const p = $('player'); if (p) p.classList.remove('playing');
    if (live && live.raf) cancelAnimationFrame(live.raf);
    if (live) live.raf = 0;
  }

  function render(n) {
    n = Math.max(0, Math.min(N, n));
    cancelAnim();
    hideLiveCanvas();
    while (placed < n) {
      committedLL.push(PTS[placed]);
      const m = makeDot(ACTS[placed]); m.addTo(dotsLayer); dotMarkers.push(m);
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

  function camApply(c, z) { map.setView(c, z, { animate: false }); }

  function spawnBurst(ll) {
    const burstIcon = L.divIcon({
      className: 'burst', html: '<div class="ring"></div><div class="ring r2"></div>',
      iconSize: [0, 0]
    });
    const m = L.marker(ll, { icon: burstIcon, interactive: false, zIndexOffset: 900 }).addTo(map);
    setTimeout(() => { if (map) map.removeLayer(m); }, BURST_MS + 350);
  }

  function commitPoint(i) {
    committedLL.push(PTS[i]);
    const m = makeDot(ACTS[i]); m.addTo(dotsLayer); dotMarkers.push(m);
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

  // ---------------------------------------------------------------- канвас-режим
  // Сколько таймлайна грузим до старта. Остальное догружается фоном впереди
  // головы: ждать всю карту ради первых секунд бессмысленно, а если фон
  // отстанет, кадр подставит растянутый родительский тайл.
  const FIRST_WAVE_MS = 5000;

  // Сообщение показываем один раз за запуск: тайлы просят десятки раз,
  // и без этого человек получил бы десяток одинаковых плашек.
  function noteMapUnavailable() {
    if (mapUnavailable) return;
    mapUnavailable = true;
    showMapLoading(false);
    if (typeof WBLicense !== 'undefined' && WBLicense.toast) {
      WBLicense.toast('Карта не загрузилась — показываем без неё. ' +
                      'Похоже, её сервер недоступен у вашего оператора связи.', true);
    }
    if (counterEl) counterEl.textContent = 'карта недоступна';
  }

  function showMapLoading(on, pct) {
    const el = $('mapLoading');
    if (!el) return;
    el.classList.toggle('show', !!on);
    if (on) $('mapLoadingBar').style.width = Math.round(pct || 0) + '%';
  }

  async function preloadFirstWave(phases, W, H) {
    tilesAborted = false;
    const first = collectTiles(phases, W, H, FIRST_WAVE_MS);
    showMapLoading(true, 0);
    await loadTiles(first, (d, t) => showMapLoading(true, d / t * 100));
    showMapLoading(false);
    // Остальное — фоном, порядок совпадает с ходом анимации
    const rest = collectTiles(phases, W, H);
    if (!tilesAborted) loadTiles(rest, (d, t) => {
      counterEl.textContent = d >= t ? '' : `карта ${Math.round(d / t * 100)}%`;
      if (d >= t) syncCounters();
    });
  }

  async function startCanvasPlayback(fromAFloat) {
    // Превью показывает ровно тот кадр, что уйдёт в видео: та же пропорция,
    // тот же общий план. Иначе вертикальный ролик оказывается сюрпризом.
    // Рисуем в физических пикселях экрана: на телефоне с плотным дисплеем
    // канвас в CSS-пикселях растягивается и всё выглядит мылом.
    const [cssW, cssH] = frameSize();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(cssW * dpr), H = Math.round(cssH * dpr);
    const { phases, arrivals, totalMs } = buildPhases(W, H);

    playBtn.disabled = true; videoBtn.disabled = true;
    await preloadFirstWave(phases, W, H);
    playBtn.disabled = false; videoBtn.disabled = false;
    if (!playing) return;   // отменили, пока грузилась карта

    liveCanvas.width = W; liveCanvas.height = H;
    liveCanvas.style.width = cssW + 'px';
    liveCanvas.style.height = cssH + 'px';
    const ctx = liveCanvas.getContext('2d');
    liveCanvas.classList.add('visible');
    // Прячем Leaflet, чтобы поля вокруг вертикального кадра были чёрными,
    // а не обрезком карты
    $('player').classList.add('playing');

    live = {
      phases, arrivals, totalMs, ctx, W, H,
      // dpr, а не 1: канвас рисуется в физических пикселях, и без этого
      // след стал бы вдвое тоньше прежнего на плотных экранах
      geo: dpr,
      base: timeForAFloat(phases, arrivals, fromAFloat),
      startTs: performance.now(), raf: 0, lastAFloat: fromAFloat
    };

    const loop = () => {
      if (!playing || !live) return;
      const elapsed = live.base + (performance.now() - live.startTs);
      const st = stateAt(live.phases, elapsed);
      live.lastAFloat = st.aFloat;
      drawFrame(live.ctx, live.W, live.H, st.cam, st.aFloat, st.head, elapsed,
                st.curIdx, live.arrivals, false, false, live.geo);

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
        live = null;
        render(N);            // скрывает канвас
        return;
      }
      live.raf = requestAnimationFrame(loop);
    };
    live.raf = requestAnimationFrame(loop);
  }

  // ---------------------------------------------------------------- управление
  async function play() {
    if (playing) return;
    playing = true;
    playBtn.textContent = '⏸';

    if (followCam.checked) {
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

  // ---------------------------------------------------------------- экспорт видео
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

  // ---------------------------------------------------------------- результат
  // Готовое видео сначала показывается, и только потом сохраняется.
  // Раньше файл падал в загрузки сразу: человек не видел, что получилось,
  // а на телефоне ещё и не понимал, куда именно оно делось.
  let result = null;          // { blob, name, url }

  const SHARE_TEXT = 'Весь спортивный путь в одном видео\nwayback.pro';

  function clearResult() {
    if (result && result.url) URL.revokeObjectURL(result.url);
    result = null;
    const v = $('resultVideo');
    if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
  }

  // Поделиться файлом умеют не все: на настольных браузерах такого обычно
  // нет вовсе. Спрашиваем не «телефон ли это», а умеет ли браузер отдать
  // именно файл — проверка по возможности честнее проверки по устройству.
  // Настольный Chrome тоже отвечает, что умеет делиться файлом, но окно
  // открывается урезанное или не открывается вовсе. Поэтому к проверке
  // возможности добавлена проверка устройства: на компьютере кнопки нет.
  function canShareFile(file) {
    return isMobile() && !!(navigator.canShare && navigator.share &&
                            navigator.canShare({ files: [file] }));
  }

  function showResult(blob, name) {
    clearResult();
    result = { blob, name, url: URL.createObjectURL(blob) };

    const v = $('resultVideo');
    v.src = result.url;
    v.play().catch(() => { /* автовоспроизведение может быть запрещено */ });

    const mb = (blob.size / 1048576).toFixed(1);
    const fmt = exportOrient === 'portrait' ? '9:16' : '16:9';
    $('resultMeta').textContent = `${fmt} · ${selQuality}p · ${selFps} кадров/с · ${mb} МБ`;

    const file = new File([blob], name, { type: blob.type });
    const share = $('resultShare');
    share.hidden = !canShareFile(file);
    $('resultHint').hidden = true;

    showExportView('result');
    exportOverlay.classList.add('visible');
  }

  async function shareResult() {
    if (!result) return;
    const file = new File([result.blob], result.name, { type: result.blob.type });
    const hint = $('resultHint');
    try {
      await navigator.share({ files: [file], text: SHARE_TEXT, title: 'WayBack' });
    } catch (e) {
      // Отмена — это не ошибка: человек просто закрыл системное окно
      if (e && e.name === 'AbortError') return;
      hint.textContent = 'Не получилось открыть окно «Поделиться». ' +
        'Сохраните видео и отправьте из галереи.';
      hint.hidden = false;
    }
  }

  function saveBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }

  // Имя файла по выбранному качеству, а не по высоте кадра: у вертикали
  // высота 1920, и «wayback-1920p» читалось бы как другое разрешение
  function videoName(ext) {
    const o = exportOrient === 'portrait' ? 'vert' : 'gor';
    return `wayback-${o}-${selQuality}p${selFps}.${ext}`;
  }

  function nextTick() {
    return new Promise(r => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => r();
      ch.port2.postMessage(0);
    });
  }

  async function exportWebCodecs(W, H, FPS, BITRATE) {
    // Локально, а не с CDN: сборщик MP4 нужен в момент рендера, и внешний
    // адрес здесь означал бы, что у части пользователей экспорт просто
    // не запустится. Из тех же соображений локальны Leaflet и fflate.
    if (!window.Mp4Muxer) await loadScript('js/vendor/mp4-muxer.js');

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
    await loadTiles(keys, (d, t) => setExportProgress(d / t * 12, 'Готовим карту...'));
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
      drawFrame(ctx, W, H, st.cam, st.aFloat, st.head, tlMs, st.curIdx, arrivals,
                true, st.final, geoForVideo(W, H));

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
    setExportProgress(100, 'Готовим предпросмотр...');
    showResult(new Blob([muxer.target.buffer], { type: 'video/mp4' }), videoName('mp4'));
  }

  async function exportRealtime(W, H) {
    const { phases, arrivals, totalMs } = buildPhases(W, H);
    const keys = collectTiles(phases, W, H);
    tilesAborted = false;
    await loadTiles(keys, (d, t) => setExportProgress(d / t * 15, 'Готовим карту...'));
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

    const rec = new MediaRecorder(stream,
      mime ? { mimeType: mime, videoBitsPerSecond: 8_000_000 } : undefined);
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
        drawFrame(ctx, W, H, st.cam, st.aFloat, st.head, elapsed, st.curIdx, arrivals,
                  true, st.final, geoForVideo(W, H));
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
    showResult(new Blob(chunks, { type: mime || 'video/webm' }), videoName(ext));
  }

  function bindSeg(segEl, onPick) {
    segEl.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        segEl.querySelectorAll('button').forEach(b => b.classList.remove('sel'));
        btn.classList.add('sel');
        onPick(parseInt(btn.dataset.v, 10));
      });
    });
  }

  async function runExport() {
    exportAbort = false;
    showExportView('progress');
    setExportProgress(0, 'Подготовка...');
    const [w, h] = FRAMES[exportOrient][selQuality];
    const bitrate = BITRATES[selQuality];
    try {
      let done = false;
      if (window.VideoEncoder) {
        try {
          await exportWebCodecs(w, h, selFps, bitrate);
          done = true;
        } catch (e) {
          if (!exportAbort) console.warn('WebCodecs недоступен, запасной способ:', e);
        }
      }
      if (!done && !exportAbort) {
        if (!window.MediaRecorder) {
          alert('Ваш браузер не поддерживает запись видео. Попробуйте Chrome или Edge.');
          showExportView('settings');
          return;
        }
        await exportRealtime(w, h);
      }
    } catch (e) {
      exportOverlay.classList.remove('visible');
      throw e;
    }

    // Отмена возвращает к настройкам, а не оставляет висеть на прогрессе:
    // человек нажал «Отмена», чтобы что-то поменять и запустить заново.
    // Раньше здесь стоял return из середины try — управление сюда
    // не доходило, и окно замирало на полосе прогресса.
    if (exportAbort) showExportView('settings');
  }

  // ---------------------------------------------------------------- инициализация
  function bindUI() {
    if (uiBound) return;
    uiBound = true;

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
      // смена скорости перестраивает таймлайн — продолжим с той же точки при Play
      if (playing) pause();
      if (live) live.lastAFloat = Math.floor(live.lastAFloat || 0);
    });
    followCam.addEventListener('change', () => { if (playing) pause(); });

    // Список в панели плеера меняет то, что видно на экране
    orientSelect.addEventListener('change', () => {
      const v = orientSelect.value;
      if (v === previewOrient) return;
      previewOrient = v;
      pause(); live = null; render(placed);
    });
    // Кнопки в окне экспорта меняют то, что уйдёт в файл. Подсветку
    // переносим здесь же: без неё нажатие ничего не меняло на вид,
    // и выбор выглядел сломанным.
    $('segO').querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        exportOrient = btn.dataset.v;
        $('segO').querySelectorAll('button').forEach(b =>
          b.classList.toggle('sel', b === btn));
      });
    });

    bindSeg($('segQ'), v => { selQuality = v; });
    bindSeg($('segF'), v => { selFps = v; });


    // Превью — под экран: на компьютере горизонтально, на телефоне вертикально.
    previewOrient = isMobile() ? 'portrait' : 'landscape';
    orientSelect.value = previewOrient;

    // Выгрузка — всегда вертикально: этот формат идут в истории и ленты.
    // На компьютере это намеренно расходится с превью.
    exportOrient = 'portrait';
    $('segO').querySelectorAll('button').forEach(b =>
      b.classList.toggle('sel', b.dataset.v === exportOrient));
    videoBtn.addEventListener('click', () => {
      pause();
      showExportView('settings');
      exportOverlay.classList.add('visible');
    });
    // Кнопок покупки две: в панели плеера (широкий экран) и в окне
    // экспорта над «Начать рендер» (телефон). Панель PRO лежит вне плеера
    // и всплывает поверх окна экспорта — закрыв её, человек возвращается
    // ровно туда, откуда пришёл, и вести его за руку не нужно.
    buyBtns.forEach(b => b.addEventListener('click', () => {
      pause();
      WBPro.open();
    }));
    // Значок показывает, куда переключишься, а не текущее состояние:
    // так понятнее, что кнопка делает.
    // Класс ставится и здесь, а не только в applyTheme: тема могла прийти
    // из прошлого посещения, и тогда смены не происходит — а разметку
    // покрасить всё равно нужно.
    const syncThemeBtn = () => {
      const light = WBTheme.isLight();
      $('player').classList.toggle('light', light);
      const b = $('themeBtn');
      if (!b) return;
      b.textContent = light ? '☀' : '☾';
      b.title = WBPro.isPaid()
        ? (light ? 'Переключить на тёмную карту' : 'Переключить на светлую карту')
        : 'Тёмная тема входит в PRO';
      b.setAttribute('aria-pressed', String(light));
    };
    syncThemeBtn();
    $('themeBtn').addEventListener('click', () => {
      WBPro.gate('Тёмная тема входит в PRO-версию', () => {
        WBTheme.toggle();
        syncThemeBtn();
      });
    });
    WBTheme.onChange(applyTheme);

    $('periodBtn').addEventListener('click', () => {
      WBPro.gate('Выбор периода входит в PRO-версию', openPeriod);
    });
    $('perClose').addEventListener('click', closePeriod);
    $('perApply').addEventListener('click', applyPeriod);
    $('perFrom').addEventListener('change', syncPeriodCount);
    $('perTo').addEventListener('change', syncPeriodCount);
    $('periodOverlay').addEventListener('click', e => {
      if (e.target === $('periodOverlay')) closePeriod();
    });

    // Купившему платные кнопки надо разблокировать, и наоборот — сбросить
    // тёмную тему, если ключ перестал действовать. Проверка асинхронная,
    // поэтому подписываемся, а не читаем однократно.
    WBPro.onChange(isPaid => {
      $('themeBtn').classList.toggle('locked', !isPaid);
      $('periodBtn').classList.toggle('locked', !isPaid);
      if (!isPaid && !WBTheme.isLight()) WBTheme.set('light');
      syncThemeBtn();
      syncBuyBtn();
    });

    $('resultSave').addEventListener('click', () => {
      if (result) saveBlob(result.blob, result.name);
    });
    $('resultShare').addEventListener('click', shareResult);
    $('resultClose').addEventListener('click', () => {
      exportOverlay.classList.remove('visible');
      clearResult();
    });

    exportStart.addEventListener('click', () => {
      runExport().catch(e => {
        exportOverlay.classList.remove('visible');
        alert('Не получилось записать видео: ' + e.message);
      });
    });
    exportClose.addEventListener('click', () => { exportOverlay.classList.remove('visible'); });
    exportCancel.addEventListener('click', () => { exportAbort = true; tilesAborted = true; });
    $('backBtn').addEventListener('click', () => {
      teardown();
      $('player').hidden = true;
      document.body.classList.remove('in-player');
    });
  }

  // В окне экспорта три вида: настройки, ход рендера, готовое видео.
  // Покупка сюда больше не входит — она в своей панели поверх всего.
  function showExportView(which) {
    exportSettings.style.display = which === 'settings' ? 'block' : 'none';
    $('resultPanel').hidden = which !== 'result';
    exportProgress.style.display = which === 'progress' ? 'block' : 'none';
    if (which !== 'result') clearResult();
  }

  // Кнопки покупки две — в панели плеера и в окне экспорта; какая видна,
  // решает ширина экрана (css). Купившему их показывать незачем: покупать
  // больше нечего, а платные кнопки рядом и так разблокированы.
  function syncBuyBtn() {
    const hide = typeof WBLicense === 'undefined' || WBLicense.isPaid();
    buyBtns.forEach(b => { b.hidden = hide; });
  }

  // ---------------------------------------------------------------- период
  // Выбор периода перезапускает плеер на подмножестве тренировок: start()
  // и так пересобирает всё с нуля (teardown + новая карта), поэтому
  // отдельной ветки «пересчитать таймлайн» не нужно.
  const dayISO = ts => {
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  // Границы полей включают весь день «по», иначе тренировка этого дня
  // в отрезок не попадёт и человек решит, что фильтр врёт.
  const fromTs = () => {
    const v = $('perFrom').value;
    return v ? new Date(v + 'T00:00:00').getTime() : -Infinity;
  };
  const toTs = () => {
    const v = $('perTo').value;
    return v ? new Date(v + 'T23:59:59.999').getTime() : Infinity;
  };
  const inPeriod = () => {
    const a = fromTs(), b = toTs();
    return SOURCE_ACTS.filter(x => x.ts >= a && x.ts <= b);
  };

  function openPeriod() {
    pause();
    const first = SOURCE_ACTS[0], last = SOURCE_ACTS[SOURCE_ACTS.length - 1];
    $('perAll').textContent =
      `Всего ${SOURCE_ACTS.length}: ${first.date} — ${last.date}`;
    $('perFrom').min = $('perTo').min = dayISO(first.ts);
    $('perFrom').max = $('perTo').max = dayISO(last.ts);
    $('perFrom').value = dayISO(ACTS[0].ts);
    $('perTo').value = dayISO(ACTS[N - 1].ts);

    // Готовые кнопки по годам: чаще всего нужен именно год, а не отрезок,
    // и вводить две даты ради этого — лишняя работа.
    const box = $('perPresets');
    box.innerHTML = '';
    const years = [...new Set(SOURCE_ACTS.map(a => new Date(a.ts).getFullYear()))];
    const preset = (label, from, to) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', () => {
        $('perFrom').value = from; $('perTo').value = to;
        syncPeriodCount();
      });
      box.appendChild(b);
    };
    preset('Всё', dayISO(first.ts), dayISO(last.ts));
    for (const y of years) preset(String(y), `${y}-01-01`, `${y}-12-31`);

    syncPeriodCount();
    $('periodOverlay').classList.add('visible');
  }

  function closePeriod() {
    $('periodOverlay').classList.remove('visible');
  }

  function syncPeriodCount() {
    const n = inPeriod().length;
    $('perCount').textContent = n
      ? `${n} ${plural(n, ['тренировка', 'тренировки', 'тренировок'])} в этом периоде`
      : 'В этом периоде нет тренировок';
    $('perApply').disabled = n === 0;
  }

  function applyPeriod() {
    const acts = inPeriod();
    if (!acts.length) return;
    closePeriod();
    start(acts, true);
  }

  // Повторный запуск (пользователь вернулся и загрузил другой архив):
  // Leaflet не даёт переинициализировать тот же контейнер, поэтому карту
  // сносим целиком. tileCache намеренно сохраняем — он общий по z/x/y.
  function teardown() {
    playing = false;
    if (live && live.raf) cancelAnimationFrame(live.raf);
    live = null;
    if (anim && anim.raf) cancelAnimationFrame(anim.raf);
    anim = null;
    if (map) { map.remove(); map = null; }
    dotMarkers.length = 0;
    committedLL.length = 0;
    placed = 0;
    trailGlow = trail = dotsLayer = headMarker = null;
    if (liveCanvas) liveCanvas.classList.remove('visible');
  }

  // keepSource — перезапуск на подмножестве (выбор периода). Полный
  // список при этом сохраняется, иначе период нельзя было бы расширить.
  function start(acts, keepSource) {
    if (!acts || acts.length === 0) return;
    if (!keepSource) SOURCE_ACTS = acts;

    slider = $('slider'); playBtn = $('playBtn'); resetBtn = $('resetBtn');
    speedSelect = $('speed'); followCam = $('followCam'); videoBtn = $('videoBtn');
    orientSelect = $('orient');
    shownCountEl = $('shownCount'); currentDateEl = $('currentDate');
    currentNameEl = $('currentName'); cumKmEl = $('cumKm'); counterEl = $('counter');
    liveCanvas = $('liveCanvas');
    exportOverlay = $('exportOverlay'); exportPct = $('exportPct');
    exportBarFill = $('exportBarFill'); exportStatus = $('exportStatus');
    exportCancel = $('exportCancel');
    exportSettings = $('exportSettings'); exportProgress = $('exportProgress');
    buyBtns = [$('buyBtn'), $('buyBtnPanel')].filter(Boolean);

    // Состояние кнопок покупки держит подписка в bindUI: проверка ключа
    // асинхронная, и однократной сверки не хватает — купивший на миг
    // увидел бы предложение купить снова.
    syncBuyBtn();
    exportStart = $('exportStart'); exportClose = $('exportClose');

    teardown();

    ACTS = acts;
    N = ACTS.length;
    PTS = ACTS.map(a => L.latLng(a.lat, a.lon));
    CUM_KM = []; { let s = 0; for (const a of ACTS) { s += (a.km || 0); CUM_KM.push(s); } }
    bounds = L.latLngBounds(PTS);
    DATE_RANGE = `${ACTS[0].date} — ${ACTS[N - 1].date}`;

    // Подписи локаций: без них переезд из города в город читается как
    // «точки просто уехали куда-то вбок»
    const cities = new Set(), countries = new Set();
    for (const a of ACTS) {
      const loc = locationOf(a.lat, a.lon, a.name, a.place);
      a.locLabel = loc ? loc.label : '';
      if (loc) { cities.add(loc.city); countries.add(loc.cc); }
    }
    GEO_SUMMARY = cities.size
      ? `${cities.size} ${plural(cities.size, ['город', 'города', 'городов'])}` +
        (countries.size > 1
          ? ` · ${countries.size} ${plural(countries.size, ['страна', 'страны', 'стран'])}`
          : '')
      : '';

    $('player').hidden = false;
    document.body.classList.add('in-player');
    $('totalCount').textContent = N;
    slider.max = N; slider.value = N;

    map = L.map('map', {
      zoomControl: true, attributionControl: true,
      zoomSnap: 0, zoomAnimation: false, markerZoomAnimation: false, fadeAnimation: false
    });
    // Интерактивная карта рисуется тем же движком, что и кадры видео,
    // поэтому пауза и проигрывание выглядят одинаково
    mapUnavailable = false;
    WBVectorMap.init(MAP.sources).catch(e => {
      console.warn('карта:', e && e.message ? e.message : e);
      noteMapUnavailable();
    });
    gridLayer = new VectorGridLayer({
      maxZoom: MAP.maxZoom, attribution: MAP.attribution, keepBuffer: 6
    }).addTo(map);
    map.fitBounds(bounds.pad(0.2));

    const paint = L.canvas({ padding: 0.5 });
    trailGlow = L.polyline([], { renderer: paint, color: F().accent, weight: 11, opacity: 0.16,
      interactive: false, lineJoin: 'round' }).addTo(map);
    trail = L.polyline([], { renderer: paint, color: F().accentHi, weight: 4, opacity: 0.8,
      interactive: false, lineJoin: 'round', lineCap: 'round' }).addTo(map);
    dotsLayer = L.layerGroup().addTo(map);

    const headIcon = L.divIcon({
      className: 'head-marker', html: '<div class="core"></div>', iconSize: [0, 0]
    });
    headMarker = L.marker([0, 0], { icon: headIcon, interactive: false, zIndexOffset: 1000 });

    bindUI();
    render(N);
  }

  // Подпись в подвале — из того же конфига, что и карта в кадре
  const credit = $('mapCredit');
  if (credit) credit.textContent = MAP.attribution;

  // Отрисовка одного кадра в переданный канвас — для проверок из site/_test.
  // Идёт тем же путём, что и экспорт видео, поэтому проверка видит настоящий
  // кадр, а не его пересказ. Требует уже запущенного плеера: данные и карта
  // берутся из его состояния.
  function renderFrameTo(canvas, W, H, atMs) {
    const { phases, arrivals, totalMs } = buildPhases(W, H);
    const t = atMs === undefined ? totalMs : Math.max(0, Math.min(totalMs, atMs));
    const st = stateAt(phases, t);
    canvas.width = W; canvas.height = H;
    drawFrame(canvas.getContext('2d'), W, H, st.cam, st.aFloat, st.head, t,
              st.curIdx, arrivals, true, st.final, geoForVideo(W, H));
    return { totalMs, at: t };
  }

  return { start, renderFrameTo };
})();
