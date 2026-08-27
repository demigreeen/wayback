/* WayBack — vectormap.js
   Отрисовка базовой карты из векторных тайлов OpenStreetMap в канвас.

   Зачем свой рендер, а не готовые картинки с чужого сервера:
   тайлы попадают в скачиваемое видео, а это распространение производного
   материала — отдельный пункт почти во всех условиях (MapTiler и Stadia
   согласуют такое письмом в отдел продаж). Здесь мы рисуем карту сами из
   данных OpenStreetMap, и по ODbL готовая картинка — «Produced Work»:
   распространять её можно свободно, нужна лишь атрибуция. Подробности —
   в docs/MAPS.md.

   Наружу отдаётся renderTile(z, x, y) -> Promise<canvas 256×256>.
   Канвас подставляется вместо Image везде, где движок звал drawImage,
   поэтому ниже по течению ничего не меняется.
*/
'use strict';

const WBVectorMap = (() => {

  const TILE_PX = 256;

  // ---------------------------------------------------------------- стиль
  // Сами цвета живут в theme.js — там же, где цвета следа и панели:
  // карта и то, что поверх неё, должны подбираться вместе, иначе при смене
  // темы они разъезжаются. Здесь остаётся только геометрия: толщина линий
  // и зумы, с которых слой проступает.
  //
  // Функции, а не константы: тема меняется на лету, и значение должно
  // читаться в момент отрисовки тайла.
  const C = () => WBTheme.map();

  // Дороги: толщина в пикселях тайла (256). Мелкие проступают только
  // на крупных зумах, иначе город превращается в кашу.
  const ROAD_SPECS = [
    { classes: ['service', 'minor'],  key: 'minor',     w: 0.5, minZ: 13 },
    { classes: ['tertiary'],          key: 'tertiary',  w: 0.7, minZ: 11 },
    { classes: ['secondary'],         key: 'secondary', w: 0.9, minZ: 9 },
    { classes: ['primary'],           key: 'primary',   w: 1.1, minZ: 7 },
    { classes: ['trunk', 'motorway'], key: 'motorway',  w: 1.4, minZ: 5 }
  ];

  // Подписи. Мелкие пункты появляются только на крупных зумах, иначе
  // общий план превращается в сплошной текст.
  const PLACE_MINZ = {
    country: 3, state: 6, province: 6,
    city: 6, town: 9, village: 11,
    suburb: 12, quarter: 13, neighbourhood: 13, hamlet: 13
  };
  // Кегль в пикселях кадра 720 по короткой стороне; player.js домножит
  const PLACE_SIZE = {
    country: 15, state: 12, province: 12,
    city: 13, town: 11.5, village: 10.5,
    suburb: 10, quarter: 9.5, neighbourhood: 9.5, hamlet: 9.5
  };

  // ---------------------------------------------------------------- схемы
  // Источников тайлов несколько, и отдают они РАЗНЫЕ схемы. Основной —
  // OpenMapTiles, запасные — Shortbread: другие имена слоёв и другие
  // названия классов дорог и населённых пунктов. Приводим всё к словарю
  // OpenMapTiles, чтобы стиль выше (ROAD_SPECS, PLACE_MINZ) остался один
  // на всех и его не пришлось дублировать под каждый источник.
  const GREEN = /wood|forest|grass|park|scrub|meadow|garden|heath|orchard|vineyard/;

  // Виды дорог Shortbread → классы OpenMapTiles
  const SB_ROAD = {
    motorway: 'motorway', trunk: 'trunk', primary: 'primary',
    secondary: 'secondary', tertiary: 'tertiary',
    unclassified: 'minor', residential: 'minor', living_street: 'minor',
    pedestrian: 'minor', service: 'service', track: 'service', busway: 'minor'
  };

  const SCHEMAS = {
    // Заливки идут по порядку, от общего к частному
    openmaptiles: {
      fills: [
        { name: 'landuse', color: 'landuse' },
        { name: 'landcover', color: 'green', filter: pr => GREEN.test(pr.class || '') },
        { name: 'park', color: 'green' },
        { name: 'water', color: 'water' },
        { name: 'building', color: 'building', minZ: 14 }
      ],
      waterway: 'waterway', roads: 'transportation',
      place: 'place', boundary: 'boundary',
      roadClass: pr => pr.class || '',
      placeClass: pr => pr.class || '',
      placeRank: pr => pr.rank
    },
    shortbread: {
      fills: [
        { name: 'land', color: 'landuse' },
        { name: 'land', color: 'green', filter: pr => GREEN.test(pr.kind || '') },
        { name: 'water_polygons', color: 'water' },
        { name: 'ocean', color: 'water' },
        { name: 'buildings', color: 'building', minZ: 14 }
      ],
      waterway: 'water_lines', roads: 'streets',
      place: 'place_labels', boundary: 'boundaries',
      roadClass: pr => SB_ROAD[pr.kind] || '',
      placeClass: pr => pr.kind || '',
      // В Shortbread ранга нет — подписи упорядочатся по одному кеглю
      placeRank: () => undefined
    }
  };

  // ---------------------------------------------------------------- MVT
  // Минимальный разбор protobuf: нужны только слои, тип геометрии,
  // одно-два свойства и координаты. Готовые библиотеки тянут лишнее.
  class Reader {
    constructor(buf) { this.b = buf; this.p = 0; this.end = buf.length; }
    varint() {
      let r = 0, sh = 0, c;
      do {
        c = this.b[this.p++];
        r += (c & 0x7f) * Math.pow(2, sh);
        sh += 7;
      } while (c & 0x80);
      return r;
    }
    tag() { const v = this.varint(); return [v >> 3, v & 7]; }
    skip(wt) {
      if (wt === 0) this.varint();
      else if (wt === 2) this.p += this.varint();
      else if (wt === 5) this.p += 4;
      else if (wt === 1) this.p += 8;
      else throw new Error('wire type ' + wt);
    }
    bytes() {
      const n = this.varint();
      const r = this.b.subarray(this.p, this.p + n);
      this.p += n;
      return r;
    }
    str() { return new TextDecoder().decode(this.bytes()); }
    sub() { return new Reader(this.bytes()); }
  }

  const zig = v => (v >> 1) ^ -(v & 1);

  function decodeTile(u8) {
    const r = new Reader(u8);
    const layers = [];
    while (r.p < r.end) {
      const [f, wt] = r.tag();
      if (f === 3 && wt === 2) layers.push(decodeLayer(r.sub()));
      else r.skip(wt);
    }
    return layers;
  }

  function decodeLayer(r) {
    let name = '', extent = 4096;
    const features = [], keys = [], values = [];
    while (r.p < r.end) {
      const [f, wt] = r.tag();
      if (f === 1 && wt === 2) name = r.str();
      else if (f === 2 && wt === 2) features.push(r.sub());
      else if (f === 3 && wt === 2) keys.push(r.str());
      else if (f === 4 && wt === 2) values.push(decodeValue(r.sub()));
      else if (f === 5 && wt === 0) extent = r.varint();
      else r.skip(wt);
    }
    return { name, extent, features, keys, values };
  }

  function decodeValue(r) {
    let v = null;
    while (r.p < r.end) {
      const [f, wt] = r.tag();
      if (f === 1 && wt === 2) v = r.str();
      else if (f === 4 && wt === 0) v = r.varint();
      else if (f === 5 && wt === 0) v = r.varint();
      else if (f === 6 && wt === 0) v = zig(r.varint());
      else if (f === 7 && wt === 0) v = !!r.varint();
      else r.skip(wt);
    }
    return v;
  }

  // Возвращает { type, props, geom } — geom это массив колец/линий,
  // каждое из которых плоский массив координат в единицах extent.
  function decodeFeature(fr, layer) {
    fr.p = 0;
    let type = 0, tags = null, geom = null;
    while (fr.p < fr.end) {
      const [f, wt] = fr.tag();
      if (f === 3 && wt === 0) type = fr.varint();
      else if (f === 2 && wt === 2) tags = fr.bytes();
      else if (f === 4 && wt === 2) geom = fr.bytes();
      else fr.skip(wt);
    }
    const props = {};
    if (tags) {
      const tr = new Reader(tags);
      while (tr.p < tr.end) {
        const k = layer.keys[tr.varint()];
        const v = layer.values[tr.varint()];
        if (k !== undefined) props[k] = v;
      }
    }
    return { type, props, geom };
  }

  function decodeGeometry(geom) {
    const rings = [];
    if (!geom) return rings;
    const gr = new Reader(geom);
    let x = 0, y = 0, cur = null;
    while (gr.p < gr.end) {
      const cmdLen = gr.varint();
      const cmd = cmdLen & 0x7, times = cmdLen >> 3;
      if (cmd === 1) {                       // MoveTo — начало нового кольца
        for (let i = 0; i < times; i++) {
          x += zig(gr.varint()); y += zig(gr.varint());
          cur = [x, y];
          rings.push(cur);
        }
      } else if (cmd === 2) {                // LineTo
        for (let i = 0; i < times; i++) {
          x += zig(gr.varint()); y += zig(gr.varint());
          if (cur) { cur.push(x, y); }
        }
      } else if (cmd === 7) {                // ClosePath
        if (cur && cur.length >= 2) cur.push(cur[0], cur[1]);
      }
    }
    return rings;
  }

  // ---------------------------------------------------------------- отрисовка
  function pathOf(ctx, rings, k) {
    ctx.beginPath();
    for (const r of rings) {
      if (r.length < 4) continue;
      ctx.moveTo(r[0] * k, r[1] * k);
      for (let i = 2; i < r.length; i += 2) ctx.lineTo(r[i] * k, r[i + 1] * k);
    }
  }

  function drawLayer(ctx, layer, k, draw) {
    for (const fr of layer.features) {
      const f = decodeFeature(fr, layer);
      draw(f, decodeGeometry(f.geom));
    }
  }

  function paint(ctx, layers, z, labels, tileOrigin, worldScale) {
    ctx.fillStyle = C().bg;
    ctx.fillRect(0, 0, TILE_PX, TILE_PX);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    const byName = {};
    for (const l of layers) byName[l.name] = l;

    const fillLayer = (name, color, filter) => {
      const l = byName[name];
      if (!l) return;
      const k = TILE_PX / l.extent;
      ctx.fillStyle = color;
      drawLayer(ctx, l, k, (f, rings) => {
        if (f.type !== 3) return;
        if (filter && !filter(f.props)) return;
        pathOf(ctx, rings, k);
        ctx.fill('evenodd');
      });
    };

    // Заливки: от общего к частному, состав задаёт схема источника
    for (const f of schema.fills) {
      if (f.minZ && z < f.minZ) continue;
      fillLayer(f.name, C()[f.color], f.filter);
    }

    // Реки — линиями, иначе на средних зумах их не видно
    const wl = byName[schema.waterway];
    if (wl && z >= 10) {
      const k = TILE_PX / wl.extent;
      ctx.strokeStyle = C().water; ctx.lineWidth = 1.2;
      drawLayer(ctx, wl, k, (f, rings) => {
        if (f.type !== 2) return;
        pathOf(ctx, rings, k);
        ctx.stroke();
      });
    }

    // Дороги: от мелких к крупным, чтобы крупные лежали сверху
    const tr = byName[schema.roads];
    if (tr) {
      const k = TILE_PX / tr.extent;
      const feats = [];
      for (const fr of tr.features) {
        const f = decodeFeature(fr, tr);
        if (f.type !== 2) continue;
        feats.push([f, decodeGeometry(f.geom)]);
      }
      for (const spec of ROAD_SPECS) {
        if (z < spec.minZ) continue;
        ctx.strokeStyle = C().roads[spec.key];
        ctx.lineWidth = spec.w;
        ctx.beginPath();
        for (const [f, rings] of feats) {
          const cls = schema.roadClass(f.props);
          if (!spec.classes.includes(cls)) continue;
          for (const r of rings) {
            if (r.length < 4) continue;
            ctx.moveTo(r[0] * k, r[1] * k);
            for (let i = 2; i < r.length; i += 2) ctx.lineTo(r[i] * k, r[i + 1] * k);
          }
        }
        ctx.stroke();
      }
    }

    // Подписи не рисуем здесь: на стыках тайлов текст обрезался бы, а имя
    // из соседнего тайла дублировалось. Собираем их в мировых координатах,
    // а рисует player.js поверх готового кадра.
    const pl = byName[schema.place];
    if (pl && labels) {
      const k = TILE_PX / pl.extent;
      for (const fr of pl.features) {
        const f = decodeFeature(fr, pl);
        if (f.type !== 1) continue;
        const cls = schema.placeClass(f.props);
        const minz = PLACE_MINZ[cls];
        if (minz === undefined || z < minz) continue;
        const name = f.props['name:ru'] || f.props.name || f.props.name_en;
        if (!name) continue;
        const rings = decodeGeometry(f.geom);
        if (!rings.length || rings[0].length < 2) continue;
        // Мировые пиксели на зуме запрошенного тайла
        const wx = tileOrigin[0] + rings[0][0] * k * worldScale;
        const wy = tileOrigin[1] + rings[0][1] * k * worldScale;
        labels.push({ name, cls, size: PLACE_SIZE[cls] || 10,
                      rank: (schema.placeRank(f.props) || 20) + (cls === 'country' ? -30 : 0),
                      wx, wy });
      }
    }

    // Границы государств — еле заметно, для ориентира на общем плане
    const bl = byName[schema.boundary];
    if (bl) {
      const k = TILE_PX / bl.extent;
      ctx.strokeStyle = C().boundary; ctx.lineWidth = 0.8;
      drawLayer(ctx, bl, k, (f, rings) => {
        if (f.type !== 2 || (f.props.admin_level || 99) > 2) return;
        pathOf(ctx, rings, k);
        ctx.stroke();
      });
    }
  }

  // ---------------------------------------------------------------- источник
  // У OpenFreeMap адрес тайлов версионированный и меняется при обновлении
  // планеты, поэтому берём актуальный из TileJSON один раз при старте.
  // У запасных источников адрес постоянный и TileJSON не нужен.
  let tilesTemplate = null;
  let maxDataZoom = 14;
  let schema = SCHEMAS.openmaptiles;
  let initPromise = null;
  let usedSource = null;

  // Заблокированная сеть чаще не отвечает ошибкой, а молча висит. Без
  // тайм-аута перебор источников не начался бы вовсе: первый же источник
  // держал бы очередь до бесконечности, а человек смотрел бы на «Готовим
  // карту». Отсюда явный обрыв запроса.
  const SOURCE_TIMEOUT_MS = 7000;

  function fetchWithTimeout(url, ms) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms || SOURCE_TIMEOUT_MS);
    return fetch(url, { signal: ctl.signal }).finally(() => clearTimeout(t));
  }

  async function trySource(src) {
    if (src.tiles) {
      // Постоянный адрес: проверяем реальным тайлом, а не самим фактом
      // существования адреса — иначе неотвечающий источник выиграл бы
      // перебор и карта осталась бы пустой.
      const probe = src.tiles.replace('{z}', 1).replace('{x}', 1).replace('{y}', 1);
      const r = await fetchWithTimeout(probe);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      await r.arrayBuffer();
      return { template: src.tiles, maxzoom: src.maxzoom || 14 };
    }
    const r = await fetchWithTimeout(src.tilejson);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (!j.tiles || !j.tiles.length) throw new Error('в TileJSON нет tiles');
    return { template: j.tiles[0],
             maxzoom: typeof j.maxzoom === 'number' ? j.maxzoom : 14 };
  }

  // sources — список источников по убыванию предпочтения. Перебираем, пока
  // какой-нибудь не ответит: основной идёт через Cloudflare, а он у части
  // мобильных операторов в России недоступен, и без запасных карта у таких
  // посетителей не появлялась вовсе.
  function init(sources) {
    if (initPromise) return initPromise;
    const list = Array.isArray(sources) ? sources : [sources];
    initPromise = (async () => {
      const errors = [];
      for (const src of list) {
        try {
          const got = await trySource(src);
          tilesTemplate = got.template;
          maxDataZoom = got.maxzoom;
          schema = SCHEMAS[src.schema] || SCHEMAS.openmaptiles;
          usedSource = src;
          if (errors.length) console.warn('карта: перешли на запасной источник', src.name);
          return tilesTemplate;
        } catch (e) {
          errors.push(src.name + ': ' + (e && e.message ? e.message : e));
        }
      }
      // Неудачу НЕ запоминаем: сеть могла отвалиться на минуту, и
      // запомненный отказ означал бы карту-пустышку до перезагрузки.
      initPromise = null;
      throw new Error('ни один источник карты не ответил — ' + errors.join('; '));
    })();
    return initPromise;
  }

  // Четыре тайла z13 берут данные из одного z12. Без общего кэша каждый
  // просил бы его сам — вчетверо больше запросов и разбора.
  const dataCache = new Map();
  const DATA_CACHE_MAX = 400;

  function tileData(z, x, y) {
    const key = z + '/' + x + '/' + y;
    let p = dataCache.get(key);
    if (p) return p;
    p = fetchTile(z, x, y).then(u8 => (u8.length ? decodeTile(u8) : []));
    dataCache.set(key, p);
    if (dataCache.size > DATA_CACHE_MAX) {
      // Map держит порядок вставки — вычищаем самые давние
      const drop = dataCache.size - DATA_CACHE_MAX;
      let i = 0;
      for (const k of dataCache.keys()) { if (i++ >= drop) break; dataCache.delete(k); }
    }
    return p;
  }

  async function fetchTile(z, x, y) {
    if (!tilesTemplate) throw new Error('WBVectorMap.init не вызван');
    const url = tilesTemplate
      .replace('{z}', z).replace('{x}', x).replace('{y}', y);
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    let u8 = new Uint8Array(await res.arrayBuffer());
    // Некоторые зеркала отдают gzip без заголовка Content-Encoding
    if (u8.length > 2 && u8[0] === 0x1f && u8[1] === 0x8b) u8 = fflate.gunzipSync(u8);
    return u8;
  }

  // Потолок зума данных. Ниже реального maxDataZoom намеренно: один тайл
  // z12 покрывает четыре тайла z13, а вектор при увеличении не мылится.
  // Это вчетверо сокращает число запросов на рабочем зуме анимации —
  // главный источник трафика. Платим детализацией мелких улиц, но карта
  // у нас фон, а не герой кадра.
  const DATA_ZOOM_CAP = 12;

  // Данные есть только до maxDataZoom. Выше берём родительский тайл и
  // рисуем нужную четверть в увеличении — вектор от этого не мылится.
  async function renderTile(z, x, y) {
    const cv = document.createElement('canvas');
    cv.width = TILE_PX; cv.height = TILE_PX;
    const ctx = cv.getContext('2d');

    let dz = 0, dx = x, dy = y, dzoom = z;
    const cap = Math.min(maxDataZoom, DATA_ZOOM_CAP);
    while (dzoom > cap) { dzoom--; dx >>= 1; dy >>= 1; dz++; }

    let layers;
    try { layers = await tileData(dzoom, dx, dy); }
    catch (e) {
      dataCache.delete(dzoom + '/' + dx + '/' + dy);   // дать шанс повторить
      ctx.fillStyle = C().bg; ctx.fillRect(0, 0, TILE_PX, TILE_PX);
      return cv;
    }

    if (dz > 0) {
      const scale = 1 << dz;
      ctx.save();
      ctx.translate(-(x - (dx << dz)) * TILE_PX, -(y - (dy << dz)) * TILE_PX);
      ctx.scale(scale, scale);
      // Фон рисуем до трансформации, иначе зальётся только четверть
      ctx.restore();
      ctx.fillStyle = C().bg; ctx.fillRect(0, 0, TILE_PX, TILE_PX);
      ctx.save();
      ctx.translate(-(x - (dx << dz)) * TILE_PX, -(y - (dy << dz)) * TILE_PX);
      ctx.scale(scale, scale);
    }

    let labels = [];
    if (layers.length) {
      const scale = 1 << dz;
      // Начало координат тайла с данными, пересчитанное на запрошенный зум
      paint(ctx, layers, z, labels,
            [dx * TILE_PX * scale, dy * TILE_PX * scale], scale);
    } else { ctx.fillStyle = C().bg; ctx.fillRect(0, 0, TILE_PX, TILE_PX); }

    if (dz > 0) ctx.restore();

    // Отсекать по границам тайла нельзя: у векторных тайлов есть буфер, и
    // объекты у края намеренно продублированы в соседях. «Москва» лежала
    // на 14 пикселей ниже нижней границы своего тайла и терялась.
    // Дубликаты убирает player.js при отрисовке — там виден весь кадр.
    // Исключение — когда тайл нарисован из родительского: он покрывает
    // четыре запрошенных, и без отсечения имя размножится вчетверо.
    if (dz > 0) {
      const x0 = x * TILE_PX, y0 = y * TILE_PX;
      labels = labels.filter(l => l.wx >= x0 && l.wx < x0 + TILE_PX &&
                                  l.wy >= y0 && l.wy < y0 + TILE_PX);
    }
    cv.labels = labels;
    return cv;
  }

  return { init, renderTile, decodeTile, TILE_PX, bg: () => C().bg,
           source: () => usedSource };
})();
