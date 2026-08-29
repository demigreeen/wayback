/* WayBack — parse.js
   Разбор архивов экспорта тренировок прямо в браузере.

   Поддерживается:
   - ZIP (Strava bulk export, Garmin GDPR-архив с вложенными ZIP, Polar, Suunto, COROS)
   - ZIP под паролем по схеме WinZip AES — так приходит выгрузка Huawei
     (расшифровка в `zipaes.js`, пароль спрашивается на месте)
   - GZIP-файлы внутри архива (.gpx.gz / .fit.gz / .tcx.gz — так пакует Strava)
   - GPX и TCX через DOMParser
   - FIT — собственный бинарный парсер (только нужные сообщения: record / session / file_id)
   - activities.csv из Strava как индекс имён/типов
   - Huawei Health — motion path detail data.json (внутри формат HiTrack)

   Формат результата:
   { acts: [{ts, date, name, place, type, km, lat, lon}], skipped, types: Map, locked }

   Трек читается целиком (нужен для длины дистанции, если её нет в файле),
   но наружу отдаётся одна точка на тренировку — и это НЕ точка старта:
   она смещена на ~500 м вперёд по маршруту, потому что старт почти всегда
   у дома. Тренировки короче отступа отбрасываются.
*/
'use strict';

const WBParse = (() => {

  const FIT_EPOCH = 631065600;          // 1989-12-31T00:00:00Z в unix-секундах
  const SEMI = 180 / 2147483648;        // semicircles -> градусы

  // ------------------------------------------------------------ геометрия
  function havM(a, b) {
    const R = 6371000, d = Math.PI / 180;
    const dLat = (b[0] - a[0]) * d, dLon = (b[1] - a[1]) * d;
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(a[0] * d) * Math.cos(b[0] * d) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function trackKm(pts) {
    let s = 0;
    for (let i = 1; i < pts.length; i++) s += havM(pts[i - 1], pts[i]);
    return s / 1000;
  }

  // ------------------------------------------------------------ приватность
  // Наружу отдаётся не точка старта, а точка чуть дальше по маршруту.
  // Тренировка почти всегда начинается у дома, и точный старт — это адрес.
  const PRIVACY_OFFSET_M = 500;
  const PRIVACY_JITTER_M = 150;

  // Отступ слегка разный у каждой тренировки: при одинаковом точки легли бы
  // ровным кольцом вокруг дома и его центр читался бы всё равно.
  // Хэш от времени старта — чтобы один и тот же архив давал один результат.
  function offsetFor(ts) {
    const h = (Math.abs(Math.imul(ts | 0, 2654435761)) % 1000) / 1000;
    return PRIVACY_OFFSET_M + (h - 0.5) * 2 * PRIVACY_JITTER_M;
  }

  // Точка на треке через offsetM метров от начала. null — трек короче отступа,
  // такую тренировку показывать нельзя: она целиком уместится рядом с домом.
  function pointAfter(pts, offsetM) {
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const d = havM(pts[i - 1], pts[i]);
      if (acc + d >= offsetM) {
        const f = d > 0 ? (offsetM - acc) / d : 0;
        return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f,
                pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f];
      }
      acc += d;
    }
    return null;
  }

  // ------------------------------------------------------------ определение формата
  function sniff(name, u8) {
    if (u8.length > 3 && u8[0] === 0x50 && u8[1] === 0x4B && u8[2] === 3 && u8[3] === 4) return 'zip';
    if (u8.length > 2 && u8[0] === 0x1F && u8[1] === 0x8B) return 'gz';
    if (u8.length > 12 && u8[8] === 0x2E && u8[9] === 0x46 && u8[10] === 0x49 && u8[11] === 0x54) return 'fit';
    // XML: пропускаем BOM и пробелы
    let i = 0;
    while (i < u8.length && (u8[i] === 0xEF || u8[i] === 0xBB || u8[i] === 0xBF ||
           u8[i] === 0x20 || u8[i] === 0x0A || u8[i] === 0x0D || u8[i] === 0x09)) i++;
    if (u8[i] === 0x3C) return 'xml';
    if (u8[i] === 0x5B || u8[i] === 0x7B) return 'json';   // [ или { — выгрузка Huawei
    if (/\.csv$/i.test(name)) return 'csv';
    return null;
  }

  // ------------------------------------------------------------ GPX / TCX
  //
  // Разбор идёт сканированием текста, а не через DOMParser. Причина —
  // цена дерева: в часовой пробежке Strava около 3600 точек, у каждой ещё
  // высота, время и расширения с пульсом, то есть порядка 50 тысяч узлов
  // на файл. Замер на GPX в 883 КБ: DOM — 31 мс, сканирование — 1 мс.
  // На телефоне разрыв тот же, но в абсолютных числах он превращал разбор
  // архива Strava в полторы тренировки в секунду.
  //
  // От файла нам нужны координаты, время старта, название и вид спорта.
  // Строить ради них дерево незачем. DOM остаётся запасным путём: если
  // сканер ничего не нашёл, а точки в тексте есть, файл разбирается
  // по-старому.

  // Атрибуты могут идти в любом порядке и в любых кавычках, тег — с
  // префиксом пространства имён. Опережающие проверки разбирают тег
  // целиком и потому не зависят от порядка lat и lon.
  const RE_TRKPT = /<(?:\w+:)?trkpt\b(?=[^>]*\blat\s*=\s*["']([^"']*)["'])(?=[^>]*\blon\s*=\s*["']([^"']*)["'])/g;
  const RE_HAS_TRKPT = /<(?:\w+:)?trkpt\b/;
  const RE_TIME = /<(?:\w+:)?time>([^<]+)<\/(?:\w+:)?time>/gi;
  const RE_TRK = /<(?:\w+:)?trk\b[^>]*>/;
  const RE_GPX = /<(?:\w+:)?gpx\b/i;
  const RE_TCX = /<(?:\w+:)?TrainingCenterDatabase\b/i;
  const RE_LATLON = /<(?:\w+:)?LatitudeDegrees>\s*([^<\s]+)\s*<\/(?:\w+:)?LatitudeDegrees>\s*<(?:\w+:)?LongitudeDegrees>\s*([^<\s]+)\s*</g;
  const RE_HAS_LATLON = /<(?:\w+:)?LatitudeDegrees>/;
  const RE_DIST = /<(?:\w+:)?DistanceMeters>\s*([^<\s]+)/g;
  const RE_SPORT = /<(?:\w+:)?Activity\b[^>]*\bSport\s*=\s*["']([^"']*)["']/;
  const RE_LAP_START = /<(?:\w+:)?Lap\b[^>]*\bStartTime\s*=\s*["']([^"']*)["']/;
  const RE_NAME = /<(?:\w+:)?name>([^<]*)</;
  const RE_TYPE = /<(?:\w+:)?type>([^<]*)</;

  // Первое время, встреченное начиная с позиции from
  function timeFrom(text, from) {
    RE_TIME.lastIndex = Math.max(0, from);
    const m = RE_TIME.exec(text);
    if (!m) return null;
    const v = Date.parse(m[1].trim());
    return isFinite(v) ? v : null;
  }

  function parseXMLTrack(text) {
    const head = text.slice(0, 2048);
    if (RE_GPX.test(head)) return scanGPX(text) || viaDOM(text, RE_HAS_TRKPT, parseGPXDoc);
    if (RE_TCX.test(head)) return scanTCX(text) || viaDOM(text, RE_HAS_LATLON, parseTCXDoc);
    return null;
  }

  // Дерево строим, только если точки в тексте есть, а сканер их не увидел:
  // платить за DOM ради файла, в котором трека нет вовсе, незачем.
  function viaDOM(text, hasPoints, parseDoc) {
    if (!hasPoints.test(text)) return null;
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) return null;
    return parseDoc(doc);
  }

  function scanGPX(text) {
    const pts = [];
    RE_TRKPT.lastIndex = 0;
    let m;
    while ((m = RE_TRKPT.exec(text))) {
      // Пустая строка даёт 0, а не NaN, поэтому проверяется отдельно
      if (m[1] === '' || m[2] === '') continue;
      const lat = +m[1], lon = +m[2];
      if (lat === lat && lon === lon) pts.push([lat, lon]);
    }
    if (pts.length < 2) return null;

    // Время старта берём у первой точки. metadata/time — запасной вариант:
    // у части выгрузок там время создания файла, а не начала тренировки.
    const first = text.search(RE_HAS_TRKPT);
    let ts = timeFrom(text, first);
    if (ts === null && first > 0) ts = timeFrom(text, 0);

    // Название и вид ищем между <trk> и <trkseg>: теги с теми же именами
    // есть и в metadata, и внутри точек.
    let name = null, type = null;
    const mt = RE_TRK.exec(text);
    if (mt) {
      const from = mt.index + mt[0].length;
      const seg = text.indexOf('<trkseg', from);
      const info = text.slice(from, seg > from ? seg : Math.min(from + 2048, text.length));
      const mn = RE_NAME.exec(info); if (mn) name = mn[1].trim();
      const mp = RE_TYPE.exec(info); if (mp) type = mp[1].trim();
    }
    return { pts, ts, name, type };
  }

  function scanTCX(text) {
    const pts = [];
    RE_LATLON.lastIndex = 0;
    let m;
    while ((m = RE_LATLON.exec(text))) {
      const lat = +m[1], lon = +m[2];
      if (lat === lat && lon === lon) pts.push([lat, lon]);
    }
    if (pts.length < 2) return null;

    const ms = RE_SPORT.exec(text);
    const type = ms ? ms[1] : null;

    let ts = timeFrom(text, 0);
    if (ts === null) {
      const ml = RE_LAP_START.exec(text);
      if (ml) { const v = Date.parse(ml[1]); if (isFinite(v)) ts = v; }
    }

    // Суммарная дистанция — в последнем DistanceMeters: у точек он
    // накопительный, так что последний и есть итог. Ищем по хвосту файла,
    // полный проход — только если в хвосте не нашлось.
    const lastDist = str => {
      let mm, v = null;
      RE_DIST.lastIndex = 0;
      while ((mm = RE_DIST.exec(str))) v = mm[1];
      return v;
    };
    let distM = null;
    const raw = lastDist(text.slice(-8192)) || lastDist(text);
    if (raw !== null) {
      const v = parseFloat(raw);
      if (isFinite(v) && v > 0) distM = v;
    }
    return { pts, ts, name: null, type, distM };
  }

  function parseGPXDoc(doc) {
    const pts = [];
    let ts = null;
    const els = doc.getElementsByTagName('trkpt');
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      const lat = parseFloat(el.getAttribute('lat'));
      const lon = parseFloat(el.getAttribute('lon'));
      if (!isFinite(lat) || !isFinite(lon)) continue;
      pts.push([lat, lon]);
      if (ts === null) {
        const t = el.getElementsByTagName('time')[0];
        if (t) { const v = Date.parse(t.textContent); if (isFinite(v)) ts = v; }
      }
    }
    if (ts === null) {
      const mt = doc.querySelector('metadata > time');
      if (mt) { const v = Date.parse(mt.textContent); if (isFinite(v)) ts = v; }
    }
    let name = null, type = null;
    const trk = doc.getElementsByTagName('trk')[0];
    if (trk) {
      for (const ch of trk.children) {
        if (ch.localName === 'name') name = ch.textContent.trim();
        if (ch.localName === 'type') type = ch.textContent.trim();
      }
    }
    return pts.length >= 2 ? { pts, ts, name, type } : null;
  }

  function parseTCXDoc(doc) {
    const pts = [];
    let ts = null, type = null, distM = null;
    const act = doc.getElementsByTagName('Activity')[0];
    if (act) type = act.getAttribute('Sport');
    const tps = doc.getElementsByTagName('Trackpoint');
    for (let i = 0; i < tps.length; i++) {
      const tp = tps[i];
      let lat = null, lon = null;
      const pos = tp.getElementsByTagName('Position')[0];
      if (!pos) continue;
      for (const ch of pos.children) {
        if (ch.localName === 'LatitudeDegrees') lat = parseFloat(ch.textContent);
        if (ch.localName === 'LongitudeDegrees') lon = parseFloat(ch.textContent);
      }
      if (!isFinite(lat) || !isFinite(lon)) continue;
      pts.push([lat, lon]);
      if (ts === null) {
        const t = tp.getElementsByTagName('Time')[0];
        if (t) { const v = Date.parse(t.textContent); if (isFinite(v)) ts = v; }
      }
    }
    if (ts === null) {
      const lap = doc.getElementsByTagName('Lap')[0];
      if (lap) { const v = Date.parse(lap.getAttribute('StartTime') || ''); if (isFinite(v)) ts = v; }
    }
    // суммарная дистанция из последнего DistanceMeters, если есть
    const dms = doc.getElementsByTagName('DistanceMeters');
    if (dms.length) {
      const v = parseFloat(dms[dms.length - 1].textContent);
      if (isFinite(v) && v > 0) distM = v;
    }
    return pts.length >= 2 ? { pts, ts, name: null, type, distM } : null;
  }

  // ------------------------------------------------------------ FIT (бинарный)
  function fitVal(dv, off, base, size, little) {
    try {
      switch (base) {
        case 0: case 2: { const v = dv.getUint8(off); return v === 0xFF ? null : v; }
        case 1:  { const v = dv.getInt8(off); return v === 0x7F ? null : v; }
        case 3:  { const v = dv.getInt16(off, little); return v === 0x7FFF ? null : v; }
        case 4:  { const v = dv.getUint16(off, little); return v === 0xFFFF ? null : v; }
        case 5:  { const v = dv.getInt32(off, little); return v === 0x7FFFFFFF ? null : v; }
        case 6:  { const v = dv.getUint32(off, little); return v === 0xFFFFFFFF ? null : v; }
        case 8:  return dv.getFloat32(off, little);
        case 9:  return dv.getFloat64(off, little);
        case 10: { const v = dv.getUint8(off); return v === 0 ? null : v; }
        case 11: { const v = dv.getUint16(off, little); return v === 0 ? null : v; }
        case 12: { const v = dv.getUint32(off, little); return v === 0 ? null : v; }
        default: return null;
      }
    } catch (e) { return null; }
  }

  // Спорт из FIT-enum (профиль Garmin)
  const FIT_SPORT = { 1: 'run', 2: 'ride', 5: 'swim', 11: 'walk', 17: 'hike' };

  function parseFIT(u8) {
    try {
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      const pts = [];
      let ts = null, created = null, sport = null, distM = null;
      let pos = 0;
      while (pos + 12 <= u8.length) {
        const hdrSize = u8[pos];
        if (hdrSize !== 12 && hdrSize !== 14) break;
        if (!(u8[pos + 8] === 0x2E && u8[pos + 9] === 0x46 &&
              u8[pos + 10] === 0x49 && u8[pos + 11] === 0x54)) break;
        const dataSize = dv.getUint32(pos + 4, true);
        let p = pos + hdrSize;
        const end = Math.min(p + dataSize, u8.length);
        const defs = new Array(16).fill(null);

        while (p < end) {
          const hdr = u8[p++];
          let def = null;
          if (hdr & 0x80) {                      // compressed timestamp data
            def = defs[(hdr >> 5) & 0x03];
          } else if (hdr & 0x40) {               // definition message
            const local = hdr & 0x0F, hasDev = !!(hdr & 0x20);
            p += 1;                              // reserved
            const little = u8[p++] === 0;
            const g = little ? dv.getUint16(p, true) : dv.getUint16(p, false); p += 2;
            const nf = u8[p++];
            const fields = new Array(nf);
            let size = 0;
            for (let i = 0; i < nf; i++) {
              fields[i] = { num: u8[p], size: u8[p + 1], base: u8[p + 2] & 0x1F };
              size += u8[p + 1]; p += 3;
            }
            let devSize = 0;
            if (hasDev) {
              const nd = u8[p++];
              for (let i = 0; i < nd; i++) { devSize += u8[p + 1]; p += 3; }
            }
            defs[local] = { little, g, fields, size, devSize };
            continue;
          } else {                               // normal data message
            def = defs[hdr & 0x0F];
          }
          if (!def || p + def.size + def.devSize > end) { p = end; break; }

          if (def.g === 20 || def.g === 18 || def.g === 0) {
            let fp = p, lat = null, lon = null, t = null;
            for (const f of def.fields) {
              const v = fitVal(dv, fp, f.base, f.size, def.little);
              if (def.g === 20) {
                if (f.num === 0) lat = v;
                else if (f.num === 1) lon = v;
                else if (f.num === 253) t = v;
              } else if (def.g === 18) {
                if (f.num === 9 && v !== null) distM = v / 100;
                else if (f.num === 5 && v !== null && sport === null) sport = v;
              } else if (def.g === 0) {
                if (f.num === 4 && v !== null) created = v;
              }
              fp += f.size;
            }
            if (def.g === 20) {
              if (lat !== null && lon !== null) pts.push([lat * SEMI, lon * SEMI]);
              if (ts === null && t !== null) ts = t;
            }
          }
          p += def.size + def.devSize;
        }
        pos = end + 2;                           // CRC файла
      }
      if (pts.length < 2) return null;
      const t0 = ts !== null ? ts : created;
      return {
        pts,
        ts: t0 !== null ? (t0 + FIT_EPOCH) * 1000 : null,
        name: null,
        type: sport !== null ? (FIT_SPORT[sport] || 'other') : null,
        distM
      };
    } catch (e) { return null; }
  }

  // ------------------------------------------------------------ CSV (Strava activities.csv)
  function parseCSV(text) {
    const rows = []; let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (c !== '\r') cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }

  function buildCsvIndex(text) {
    const rows = parseCSV(text);
    if (rows.length < 2) return null;
    const head = rows[0].map(h => h.toLowerCase());
    const col = re => head.findIndex(h => re.test(h));
    const cFile = col(/filename|имя файла/);
    const cName = col(/activity name|название/);
    const cType = col(/activity type|тип/);
    const cDate = col(/activity date|дата/);
    if (cFile === -1) return null;
    const idx = new Map();
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const f = r[cFile];
      if (!f) continue;
      const base = f.split('/').pop().replace(/\.gz$/i, '');
      idx.set(base, {
        name: cName !== -1 ? r[cName] : null,
        type: cType !== -1 ? r[cType] : null,
        ts:   cDate !== -1 ? Date.parse(r[cDate]) : NaN
      });
    }
    return idx;
  }

  // ------------------------------------------------------------ нормализация типа
  function normType(raw) {
    if (!raw) return 'other';
    const s = String(raw).toLowerCase();
    if (/run|бег|jog/.test(s)) return 'run';
    if (/ride|cycl|bik|velo|вело/.test(s)) return 'ride';
    if (/walk|ходь/.test(s)) return 'walk';
    if (/hike|поход/.test(s)) return 'hike';
    if (/swim|плав/.test(s)) return 'swim';
    if (/ski|snowboard|лыж/.test(s)) return 'ski';
    if (/run|ride|walk|hike|swim|ski/.test(s)) return s;
    return 'other';
  }

  const TYPE_LABEL = {
    run: 'Бег', ride: 'Велосипед', walk: 'Ходьба', hike: 'Походы',
    swim: 'Плавание', ski: 'Лыжи', other: 'Другое'
  };

  // ------------------------------------------------------------ Huawei Health
  // Выгрузка Huawei приходит не треками, а файлом motion path detail data.json,
  // внутри которого поле attribute хранит текст формата HiTrack:
  //   tp=lbs;k=_;lat=_;lon=_;alt=_;t=_
  // Разбираем его сами — готовых библиотек для браузера нет.
  // Списка кодов Huawei не публикует — даже в описании полей, которое
  // прилагается к самой выгрузке, у sportType написано просто «Sport type».
  // Всё, что ниже сотни, восстановлено по исходникам Hitrava; 219 опознан
  // на живой выгрузке владельцем этих тренировок.
  const HW_SPORT = {
    2: 'hike', 3: 'ride', 4: 'run', 5: 'walk', 101: 'run', 102: 'swim',
    103: 'ride', 104: 'swim', 111: 'other', 117: 'other', 118: 'run',
    145: 'other', 219: 'ski', 282: 'hike'
  };

  function parseHuawei(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      // В partTimeMap Huawei иногда кладёт значения, ломающие разбор целиком
      try { data = JSON.parse(text.replace(/"partTimeMap":\{.*?\},/g, '')); }
      catch (e2) { return null; }
    }
    if (!Array.isArray(data)) return null;

    // До 07/2020 активности лежали внутри motionPathData, после — плоским списком
    const flat = [];
    for (const item of data) {
      if (!item || typeof item !== 'object') continue;
      if (Array.isArray(item.motionPathData)) flat.push(...item.motionPathData);
      else flat.push(item);
    }

    const out = [];
    for (const act of flat) {
      if (!act || typeof act.attribute !== 'string') continue;
      const detail = act.attribute
        .split('&&HW_EXT_TRACK_SIMPLIFY@is')[0]
        .replace('HW_EXT_TRACK_DETAIL@is', '');

      const pts = [];
      for (const line of detail.split(/[\r\n]+/)) {
        if (!line.startsWith('tp=lbs')) continue;
        let lat = null, lon = null;
        for (const kv of line.split(';')) {
          const i = kv.indexOf('=');
          if (i < 0) continue;
          const k = kv.slice(0, i);
          if (k === 'lat') lat = parseFloat(kv.slice(i + 1));
          else if (k === 'lon') lon = parseFloat(kv.slice(i + 1));
        }
        if (lat === null || lon === null || !isFinite(lat) || !isFinite(lon)) continue;
        // Паузу и остановку Huawei помечает заведомо невозможными координатами
        if ((lat === 90 && lon === -80) || (lat === 0 && lon === 0)) continue;
        if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
        pts.push([lat, lon]);
      }
      if (pts.length < 2) continue;

      // Дистанцию берём у самих часов, а не считаем по треку. Замер на живой
      // выгрузке: по сумме расхождение всего 6%, но по отдельным тренировкам
      // оно доходит до двадцатикратного. Виноваты прыжки GPS — один сорвавшийся
      // отсчёт добавляет к километровой пробежке двадцать километров, и это
      // сразу видно в счётчике «км суммарно». Так же поступают разборы GPX,
      // TCX и FIT: цифра из файла точнее геометрии.
      const ts = Number(act.startTime);
      const dist = Number(act.totalDistance);          // метры
      out.push({
        pts,
        ts: isFinite(ts) && ts > 0 ? ts : null,
        name: null,
        type: HW_SPORT[act.sportType] || null,
        distM: isFinite(dist) && dist > 0 ? dist : null
      });
    }
    return out.length ? out : null;
  }

  // ------------------------------------------------------------ сводка Garmin
  // summarizedActivities.json — список всех тренировок аккаунта. Треков в нём
  // нет, зато есть название и locationName: «Москва», «Одинцовский район».
  // Это и есть название места из самой тренировки — точнее любой геометрии.
  // Пользуемся им как справочником, сопоставляя по времени старта.
  function parseGarminSummary(text) {
    let data;
    try { data = JSON.parse(text); } catch (e) { return null; }

    // Структура менялась: то массив, то объект с summarizedActivitiesExport.
    // Ищем первый массив, элементы которого похожи на тренировки.
    const findList = node => {
      if (Array.isArray(node)) {
        if (node.length && node[0] && typeof node[0] === 'object' &&
            ('beginTimestamp' in node[0] || 'startTimeGmt' in node[0])) return node;
        for (const it of node) { const r = findList(it); if (r) return r; }
      } else if (node && typeof node === 'object') {
        for (const k of Object.keys(node)) { const r = findList(node[k]); if (r) return r; }
      }
      return null;
    };
    const list = findList(data);
    if (!list) return null;

    const idx = new Map();
    for (const a of list) {
      const ts = Number(a.beginTimestamp || a.startTimeGmt);
      if (!isFinite(ts) || ts <= 0) continue;
      idx.set(Math.round(ts / 60000), {
        name: a.name || null,
        place: a.locationName || null,
        type: a.activityType || a.sportType || null
      });
    }
    return idx.size ? idx : null;
  }

  // ------------------------------------------------------------ распаковка
  // Из архива вынимаем только то, что может оказаться тренировкой. JSON берём
  // выборочно: в Garmin-выгрузке их сотни, и разбирать их все бессмысленно.
  const INTERESTING =
    /\.(zip|gpx|tcx|fit|gz)$|activit[^/]*\.csv$|motion[ _-]?path[^/]*\.json$|hitrack|summarizedActivities[^/]*\.json$/i;

  // ZIP читается через центральный каталог, а не потоком.
  //
  // Причина конкретная: Garmin (как и многие серверные упаковщики) ставит
  // флаг 0x08 — размеры записи лежат не в локальном заголовке, а в
  // дескрипторе ПОСЛЕ данных. Потоковый разбор на такой записи не знает,
  // где она кончается, и обрывается на первой же. В центральном каталоге
  // размеры есть всегда.
  //
  // Побочная выгода: доступ произвольный, поэтому мегабайты данных сна и
  // шагов мы просто не читаем — ни байта.
  const MAX_ENTRY = 300 * 1024 * 1024;

  function makeReader(src) {
    if (src instanceof Uint8Array) {
      return {
        size: src.length,
        read: async (a, b) => src.subarray(Math.max(0, a), Math.min(b, src.length))
      };
    }
    return {
      size: src.size,
      read: async (a, b) => new Uint8Array(await src.slice(a, b).arrayBuffer())
    };
  }

  // Сколько байт держим в памяти за один заход и через какой пропуск
  // ещё выгодно дочитать соседнюю запись, не начиная новый запрос.
  const READ_CHUNK = 8 * 1024 * 1024;
  const READ_GAP = 1 * 1024 * 1024;
  // Запас на локальный заголовок: его дополнительное поле бывает длиннее,
  // чем в центральном каталоге. Не хватило — запись дочитывается отдельно.
  const LOCAL_SLACK = 4096;

  // Отпечаток содержимого записи. Huawei кладёт в выгрузку каждый файл треков
  // по три раза: в живом архиве 24 файла, а различных среди них восемь.
  // Разбор копий — это втрое больше времени (4.7 с против 1.5 на настольной
  // машине, на телефоне вчетверо дольше) и втрое больший счётчик пропущенных:
  // «пропущено: 45» вместо честных 15.
  //
  // Считаем по сжатым байтам, до распаковки: копия обходится в проход по
  // мегабайту вместо шести. Одинаковое содержимое один и тот же упаковщик
  // сжимает одинаково; если вдруг нет — мы просто не заметим копию и разберём
  // её дважды, как раньше. Ошибиться в другую сторону нельзя.
  //
  // Два независимых счётчика плюс длина: на паре тысяч записей вероятность
  // случайного совпадения — доли триллионной. CRC из каталога не годится:
  // у зашифрованных записей он обнулён.
  function fingerprint(u8) {
    let a = 0x811c9dc5 | 0, b = 0x9e3779b9 | 0;
    const n = u8.length;
    // Пословный проход, если выравнивание позволяет: на десятках мегабайт
    // разница с побайтовым заметна на глаз
    if ((u8.byteOffset & 3) === 0) {
      const w = new Uint32Array(u8.buffer, u8.byteOffset, n >>> 2);
      for (let i = 0; i < w.length; i++) {
        a = Math.imul(a ^ w[i], 0x01000193);
        b = (Math.imul(b + w[i], 0x85ebca6b) ^ (b >>> 13)) | 0;
      }
      for (let i = n & ~3; i < n; i++) a = Math.imul(a ^ u8[i], 0x01000193);
    } else {
      for (let i = 0; i < n; i++) {
        a = Math.imul(a ^ u8[i], 0x01000193);
        b = (Math.imul(b + u8[i], 0x85ebca6b) ^ (b >>> 13)) | 0;
      }
    }
    return n + ':' + (a >>> 0) + ':' + (b >>> 0);
  }

  // Данные записи из уже прочитанного куска. Возвращает null, если запись
  // в кусок не поместилась — тогда её читают отдельным запросом.
  function sliceEntry(it, buf, base) {
    const off = it.lOff - base;
    if (off < 0 || off + 30 > buf.length) return null;
    const lv = new DataView(buf.buffer, buf.byteOffset + off, 30);
    if (lv.getUint32(0, true) !== 0x04034b50) return null;
    const from = off + 30 + lv.getUint16(26, true) + lv.getUint16(28, true);
    if (from + it.csize > buf.length) return null;
    return buf.subarray(from, from + it.csize);
  }

  // max — сколько байт от начала записи хватит. Нужен для проверки пароля:
  // там достаточно соли и двух контрольных байт, а не всей записи.
  async function readEntry(it, r, max) {
    const lh = await r.read(it.lOff, it.lOff + 30);
    if (lh.length < 30) return null;
    const lv = new DataView(lh.buffer, lh.byteOffset, lh.byteLength);
    if (lv.getUint32(0, true) !== 0x04034b50) return null;
    const from = it.lOff + 30 + lv.getUint16(26, true) + lv.getUint16(28, true);
    return r.read(from, from + (max ? Math.min(max, it.csize) : it.csize));
  }

  // Чтение архива идёт по центральному каталогу: сначала собираем список
  // нужных записей, потом читаем их пачками.
  //
  // Пачки — не преждевременная оптимизация, а разница между «работает» и
  // «не работает» на телефоне. Обращение к File там идёт через поставщика
  // контента Android и стоит сотни миллисекунд независимо от объёма. При
  // чтении по записи архив Strava на 300 тренировок давал под семьсот
  // обращений и разбирался две-три минуты, тогда как архив Garmin с тем же
  // числом тренировок — за секунды: у Garmin тренировки лежат во вложенном
  // ZIP, который читается целиком одним куском и дальше разбирается в
  // памяти. Пачки дают Strava то же самое.
  //
  // Через большой пропуск не читаем: в выгрузке Garmin рядом с тренировками
  // лежат сотни мегабайт данных сна, и тащить их в память незачем.
  async function zipEach(src, onEntry, ctx) {
    const r = makeReader(src);
    if (r.size < 22) return;

    // Хвост: EOCD лежит в последних 22 байтах плюс комментарий (до 64 КБ)
    const tailLen = Math.min(r.size, 65557 + 22);
    const tail = await r.read(r.size - tailLen, r.size);
    const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return;

    let count = tv.getUint16(eocd + 10, true);
    let cdSize = tv.getUint32(eocd + 12, true);
    let cdOff = tv.getUint32(eocd + 16, true);

    // ZIP64: поля переполнены, настоящие значения в отдельной записи
    if (count === 0xFFFF || cdSize === 0xFFFFFFFF || cdOff === 0xFFFFFFFF) {
      for (let i = eocd - 20; i >= 0; i--) {
        if (tv.getUint32(i, true) !== 0x07064b50) continue;
        const z64 = Number(tv.getBigUint64(i + 8, true));
        const rec = await r.read(z64, z64 + 56);
        const rv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
        if (rec.length >= 56 && rv.getUint32(0, true) === 0x06064b50) {
          count = Number(rv.getBigUint64(32, true));
          cdSize = Number(rv.getBigUint64(40, true));
          cdOff = Number(rv.getBigUint64(48, true));
        }
        break;
      }
    }
    if (!cdSize || cdOff + cdSize > r.size) return;

    const cd = await r.read(cdOff, cdOff + cdSize);
    const cv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
    const dec = new TextDecoder();
    let p = 0;

    // ---- первый проход: что вообще стоит читать
    let items = [];
    for (let k = 0; k < count && p + 46 <= cd.length; k++) {
      if (cv.getUint32(p, true) !== 0x02014b50) break;
      const flags = cv.getUint16(p + 8, true);
      const method = cv.getUint16(p + 10, true);
      let csize = cv.getUint32(p + 20, true);
      let usize = cv.getUint32(p + 24, true);
      const nLen = cv.getUint16(p + 28, true);
      const eLen = cv.getUint16(p + 30, true);
      const cLen = cv.getUint16(p + 32, true);
      let lOff = cv.getUint32(p + 42, true);
      const name = dec.decode(cd.subarray(p + 46, p + 46 + nLen));
      const eStart = p + 46 + nLen;

      if (csize === 0xFFFFFFFF || usize === 0xFFFFFFFF || lOff === 0xFFFFFFFF) {
        let q = eStart;
        const end = q + eLen;
        while (q + 4 <= end) {
          const id = cv.getUint16(q, true), len = cv.getUint16(q + 2, true);
          if (id === 0x0001) {
            let o = q + 4;
            if (usize === 0xFFFFFFFF) { usize = Number(cv.getBigUint64(o, true)); o += 8; }
            if (csize === 0xFFFFFFFF) { csize = Number(cv.getBigUint64(o, true)); o += 8; }
            if (lOff === 0xFFFFFFFF) { lOff = Number(cv.getBigUint64(o, true)); }
            break;
          }
          q += 4 + len;
        }
      }
      p += 46 + nLen + eLen + cLen;

      if (!name || name.endsWith('/') || !csize) continue;
      if (usize > MAX_ENTRY) continue;
      if (!INTERESTING.test(name)) continue;

      // Запись под паролем. У WinZip AES настоящий метод сжатия и длина
      // ключа лежат в дополнительном поле, а method помечен числом 99.
      // Нет этого поля — шифрование чужое (ZipCrypto), читать не умеем.
      let aes = null;
      if (flags & 1) {
        aes = WBZipAES.info(cd.subarray(eStart, eStart + eLen));
        if (!aes) { ctx.locked++; continue; }
      }
      const cmeth = aes ? aes.method : method;
      if (cmeth !== 0 && cmeth !== 8) continue;       // не «как есть» и не deflate

      items.push({
        name, lOff, csize, usize, aes, method: cmeth,
        end: lOff + 30 + nLen + eLen + csize + LOCAL_SLACK
      });
    }

    // Порядок в каталоге может не совпадать с порядком в файле, а читать
    // выгодно по возрастанию смещения
    items.sort((a, b) => a.lOff - b.lOff);

    // Архив под паролем. Спрашиваем один раз на всю загрузку и тут же
    // сверяем по первой зашифрованной записи: для этого хватает её первых
    // байт, а перемолоть сотни мегабайт чужим ключом и понять это в конце —
    // худшее, что тут можно сделать. Пароль общий и на вложенные архивы.
    const enc = items.find(it => it.aes);
    if (enc && !ctx.pwKey && ctx.askPassword && WBZipAES.ready()) {
      const head = await readEntry(enc, r, WBZipAES.headLen(enc.aes.strength));
      for (let tries = 0; head; tries++) {
        const pw = await ctx.askPassword(tries);
        if (!pw) break;                              // передумали
        const k = await WBZipAES.key(pw);
        if (!k) break;                               // считать ключ нечем
        if (await WBZipAES.check(head, enc.aes.strength, k)) { ctx.pwKey = k; break; }
      }
    }
    // Без ключа зашифрованное читать незачем: это десятки мегабайт впустую
    if (enc && !ctx.pwKey) {
      for (const it of items) if (it.aes) ctx.locked++;
      items = items.filter(it => !it.aes);
    }

    // ---- второй проход: читаем пачками
    let i = 0;
    while (i < items.length) {
      const base = items[i].lOff;
      let j = i, end = items[i].end;
      while (j + 1 < items.length) {
        const nxt = items[j + 1];
        if (nxt.lOff - end > READ_GAP) break;         // впереди чужие данные
        if (nxt.end - base > READ_CHUNK) break;       // пачка набралась
        j++; end = Math.max(end, nxt.end);
      }

      let buf = null;
      try {
        buf = await r.read(base, Math.min(end, r.size));
      } catch (e) { /* читаем записи по одной ниже */ }

      for (let k = i; k <= j; k++) {
        const it = items[k];
        let raw = buf ? sliceEntry(it, buf, base) : null;
        try {
          if (!raw) raw = await readEntry(it, r);      // не поместилась в пачку
          if (!raw || raw.length < it.csize) continue;
          if (it.aes) {
            // open() снимает шифр в своей копии — общий буфер пачки цел
            raw = await WBZipAES.open(raw, it.aes.strength, ctx.pwKey);
            if (!raw) { ctx.locked++; continue; }
          }
          const fp = fingerprint(raw);
          if (ctx.seenFiles.has(fp)) continue;         // копия уже разобрана
          ctx.seenFiles.add(fp);
          const out = it.method === 0
            ? raw
            : fflate.inflateSync(raw, it.usize ? { out: new Uint8Array(it.usize) } : undefined);
          await onEntry(it.name, out);
        } catch (e) {
          continue;                                   // битая запись не рушит архив
        }
      }
      buf = null;                                     // кусок больше не нужен
      i = j + 1;
    }
  }

  const tick = () => new Promise(r => setTimeout(r, 0));

  async function headBytes(src) {
    if (src instanceof Uint8Array) return src.subarray(0, 16);
    return new Uint8Array(await src.slice(0, 16).arrayBuffer());
  }

  const asU8 = async src =>
    src instanceof Uint8Array ? src : new Uint8Array(await src.arrayBuffer());

  // Рекурсивный обход: zip -> вложенные zip -> gz -> файлы.
  // Ничего не накапливаем: каждый найденный файл сразу уходит в onFile.
  async function expand(name, src, depth, onFile, ctx) {
    if (depth > 4) return;
    const kind = sniff(name, await headBytes(src));
    if (kind === 'zip') {
      await zipEach(src, (n, u8) => expand(n, u8, depth + 1, onFile, ctx), ctx);
    } else if (kind === 'gz') {
      let inner;
      try { inner = fflate.gunzipSync(await asU8(src)); } catch (e) { return; }
      await expand(name.replace(/\.gz$/i, ''), inner, depth, onFile, ctx);
    } else if (kind) {
      await onFile(name, await asU8(src), kind);
    }
  }

  // ------------------------------------------------------------ главный конвейер
  function fmtDate(ts) {
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
  }

  // onPassword(попытка) → пароль или пустое, если человек отказался.
  // Вызывается, только когда в архиве действительно есть закрытые записи.
  async function parseInput(files, onProgress, onPassword) {
    const report = (stage, done, total) => onProgress && onProgress(stage, done, total);
    const decoder = new TextDecoder();

    // Пароль живёт ровно один разбор: спрашивать его дважды за одну
    // загрузку незачем, а хранить между загрузками — тем более.
    const ctx = { askPassword: onPassword || null, pwKey: null, locked: 0,
                  seenFiles: new Set() };

    const acts = [];
    const seen = new Set();
    let skipped = 0, found = 0, csvIndex = null, garminIndex = null;
    let lastYield = performance.now();

    // Одна разобранная тренировка занимает ~100 байт, поэтому копим только их,
    // а байты файла отпускаем сразу после разбора.
    // Счётчик skipped показывается пользователю, поэтому в него попадает
    // только то, что действительно похоже на потерянную тренировку.
    // Служебные файлы (сон, шаги, настройки) сюда не считаются: в архиве
    // Garmin их тысячи, и «пропущено: 2324» читалось бы как поломка.
    const addTrack = (a, base) => {
      if (!a || !a.pts || a.pts.length < 2) { skipped++; return; }
      // Точка старта наружу не идёт — берём точку дальше по маршруту.
      // Трек короче отступа показать нельзя, не раскрыв, откуда человек вышел.
      const p = pointAfter(a.pts, offsetFor(a.ts || 0));
      if (!p) { skipped++; return; }
      const km = a.distM ? a.distM / 1000 : trackKm(a.pts);
      acts.push({
        _base: base,
        _ts: a.ts, _name: a.name, _type: a.type,
        km, lat: p[0], lon: p[1]
      });
    };

    const onFile = async (name, u8, kind) => {
      found++;
      const base = name.split('/').pop().replace(/\.gz$/i, '');
      try {
        if (kind === 'fit') {
          // FIT без трека — это данные сна, шагов или настройки устройства,
          // а не пропущенная тренировка. Молча мимо.
          const a = parseFIT(u8);
          if (a) addTrack(a, base);
        } else if (kind === 'xml') {
          addTrack(parseXMLTrack(decoder.decode(u8)), base);
        } else if (kind === 'json') {
          if (/summarizedActivities/i.test(name)) {
            if (!garminIndex) garminIndex = parseGarminSummary(decoder.decode(u8));
          } else {
            const list = parseHuawei(decoder.decode(u8));
            if (list) for (const a of list) addTrack(a, base);
            else skipped++;
          }
        } else if (kind === 'csv' && !csvIndex) {
          // CSV маленький и может встретиться после треков — держим до конца
          try { csvIndex = buildCsvIndex(decoder.decode(u8)); } catch (e) { /* не критично */ }
        }
      } catch (e) {
        skipped++;                       // битый файл не должен ронять весь архив
      }
      // Отдаём управление браузеру, иначе на большом архиве вкладка «зависает»
      if (performance.now() - lastYield > 80) {
        lastYield = performance.now();
        report('parse', acts.length, found);
        await tick();
      }
    };

    report('unpack', 0, 0);
    for (const f of files) {
      await expand(f.name, f, 0, onFile, ctx);
    }
    report('parse', acts.length, found);

    // Метаданные из activities.csv подставляем в конце: файл мог встретиться
    // в архиве позже самих тренировок
    const out = [];
    for (const a of acts) {
      const meta = csvIndex ? csvIndex.get(a._base) : null;
      const ts = (a._ts !== null && isFinite(a._ts)) ? a._ts
               : (meta && isFinite(meta.ts) ? meta.ts : null);
      if (ts === null) { skipped++; continue; }   // без даты хронология невозможна
      if (a.km < 0.1) { skipped++; continue; }

      const key = Math.round(ts / 60000) + '|' + a.km.toFixed(1);
      if (seen.has(key)) continue;                // дубликат: Garmin этим грешит
      seen.add(key);

      // Сводку Garmin сопоставляем по времени старта: имени файла, общего
      // с FIT, у неё нет. Соседние минуты — на случай расхождения на секунды
      // между началом активности и первой записью трека.
      let gm = null;
      if (garminIndex) {
        const m = Math.round(ts / 60000);
        gm = garminIndex.get(m) || garminIndex.get(m - 1) || garminIndex.get(m + 1);
      }

      out.push({
        ts,
        date: fmtDate(ts),
        name: (meta && meta.name) || (gm && gm.name) || a._name || '',
        place: (gm && gm.place) || '',
        type: normType((meta && meta.type) || (gm && gm.type) || a._type),
        km: Math.round(a.km * 100) / 100,
        lat: a.lat,
        lon: a.lon
      });
    }

    out.sort((x, y) => x.ts - y.ts);
    const types = new Map();
    for (const a of out) types.set(a.type, (types.get(a.type) || 0) + 1);
    // locked — записи, оставшиеся под паролем. Без него архив выглядит
    // пустым, и сказать об этом надо иначе, чем «тренировок не нашлось».
    return { acts: out, skipped, types, locked: ctx.locked };
  }

  return { parseInput, TYPE_LABEL };
})();
