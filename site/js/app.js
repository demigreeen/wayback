/* WayBack — app.js
   Связующий слой лендинга: приём файлов, прогресс разбора, сводка,
   фильтр по видам спорта, запуск плеера, демо-данные. */
'use strict';

(() => {
  const $ = id => document.getElementById(id);

  const dropzone   = $('dropzone');
  const fileInput  = $('fileInput');
  const pickBtn    = $('pickBtn');
  const demoBtn    = $('demoBtn');

  const parseOverlay = $('parseOverlay');
  const parseBarFill = $('parseBarFill');
  const parseStatus  = $('parseStatus');

  const pwOverlay  = $('pwOverlay');
  const pwHint     = $('pwHint');
  const pwInput    = $('pwInput');
  const pwOk       = $('pwOk');
  const pwCancel   = $('pwCancel');

  const summaryOverlay = $('summaryOverlay');
  const sumCount   = $('sumCount');
  const sumMeta    = $('sumMeta');
  const typeFilters = $('typeFilters');
  const startBtn   = $('startBtn');
  const cancelSummary = $('cancelSummary');

  let parsed = null;          // {acts, skipped, types}

  // ------------------------------------------------------------ приём файлов
  pickBtn.addEventListener('click', e => { e.stopPropagation(); fileInput.click(); });
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) handleFiles([...fileInput.files]);
  });

  ['dragenter', 'dragover'].forEach(ev =>
    dropzone.addEventListener(ev, e => {
      e.preventDefault(); e.stopPropagation();
      dropzone.classList.add('over');
    }));
  ['dragleave', 'drop'].forEach(ev =>
    dropzone.addEventListener(ev, e => {
      e.preventDefault(); e.stopPropagation();
      if (ev === 'dragleave' && dropzone.contains(e.relatedTarget)) return;
      dropzone.classList.remove('over');
    }));
  dropzone.addEventListener('drop', e => {
    const files = [...(e.dataTransfer.files || [])];
    if (files.length) handleFiles(files);
  });
  // Если файл уронили мимо зоны, браузер по умолчанию откроет его вместо сайта
  ['dragover', 'drop'].forEach(ev =>
    window.addEventListener(ev, e => {
      if (!dropzone.contains(e.target)) e.preventDefault();
    }));

  // ------------------------------------------------------------ разбор
  function showParse(show) {
    parseOverlay.classList.toggle('visible', show);
    if (show) {
      parseBarFill.style.width = '0%';
      parseStatus.textContent = 'Читаем файлы…';
    }
  }

  // ------------------------------------------------------------ пароль архива
  // Выгрузка Huawei приходит зашифрованной, пароль человек задавал сам.
  // Спрашиваем ровно тогда, когда закрытая запись действительно встретилась,
  // и повторяем, пока не подойдёт: ошибиться в длинном пароле легко.
  // Прогресс на это время убираем — два окна друг на друге читаются плохо.
  function askPassword(attempt) {
    return new Promise(resolve => {
      const underParse = parseOverlay.classList.contains('visible');
      parseOverlay.classList.remove('visible');

      pwHint.textContent = attempt
        ? 'Пароль не подошёл. Проверьте раскладку и попробуйте ещё раз.'
        : 'Huawei присылает выгрузку зашифрованной. Введите пароль, который ' +
          'вы задали, когда заказывали копию данных.';
      pwHint.classList.toggle('bad', attempt > 0);
      pwInput.value = '';
      pwOverlay.classList.add('visible');
      pwInput.focus();

      const close = value => {
        pwOverlay.classList.remove('visible');
        pwOk.removeEventListener('click', onOk);
        pwCancel.removeEventListener('click', onCancel);
        pwInput.removeEventListener('keydown', onKey);
        if (underParse) parseOverlay.classList.add('visible');
        resolve(value);
      };
      const onOk = () => { if (pwInput.value) close(pwInput.value); };
      const onCancel = () => close(null);
      const onKey = e => {
        if (e.key === 'Enter') { e.preventDefault(); onOk(); }
        else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      };
      pwOk.addEventListener('click', onOk);
      pwCancel.addEventListener('click', onCancel);
      pwInput.addEventListener('keydown', onKey);
    });
  }

  async function handleFiles(files) {
    showParse(true);
    let lastPaint = 0;
    try {
      parsed = await WBParse.parseInput(files, (stage, done, total) => {
        const now = performance.now();
        if (now - lastPaint < 60 && !(stage === 'parse' && done === total)) return;
        lastPaint = now;
        if (stage === 'unpack') {
          parseBarFill.style.width = '8%';
          parseStatus.textContent = `Распаковываем архив… найдено файлов: ${done}`;
        } else {
          parseBarFill.style.width = (10 + (total ? done / total * 90 : 0)) + '%';
          parseStatus.textContent = `Читаем треки: ${done} из ${total}`;
        }
      }, askPassword);
    } catch (err) {
      showParse(false);
      alert('Не удалось прочитать архив: ' + (err && err.message ? err.message : err));
      return;
    }
    showParse(false);
    fileInput.value = '';

    if (!parsed.acts.length) {
      // Архив под паролем изнутри выглядит пустым, и «тренировок не нашлось»
      // отправило бы человека искать несуществующую ошибку в выгрузке.
      alert(parsed.locked
        ? 'Архив закрыт паролем, поэтому прочитать в нём нечего.\n\n' +
          'Huawei шифрует выгрузку: пароль вы задавали сами, когда заказывали ' +
          'копию данных. Загрузите архив ещё раз и введите его.'
        : 'В этих файлах не нашлось тренировок, которые можно показать ' +
          'на карте.\n\n' +
          'Проверьте, что загружаете архив экспорта целиком (ZIP) ' +
          'или файлы GPX / FIT / TCX. Тренировки без GPS — зал, беговая ' +
          'дорожка — а также совсем короткие в анимацию не попадают.');
      return;
    }
    showSummary();
  }

  // ------------------------------------------------------------ сводка и фильтры
  function showSummary() {
    const { acts, skipped, types } = parsed;
    const km = acts.reduce((s, a) => s + a.km, 0);
    sumCount.textContent = acts.length;
    sumMeta.textContent =
      `${acts[0].date} — ${acts[acts.length - 1].date} · ` +
      `${Math.round(km).toLocaleString('ru-RU')} км` +
      (skipped ? ` · пропущено: ${skipped}` : '');

    typeFilters.innerHTML = '';
    const sorted = [...types.entries()].sort((a, b) => b[1] - a[1]);
    for (const [type, n] of sorted) {
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = true; cb.dataset.type = type;
      cb.addEventListener('change', updateStartState);
      label.appendChild(cb);
      label.appendChild(document.createTextNode(
        `${WBParse.TYPE_LABEL[type] || type} · ${n}`));
      typeFilters.appendChild(label);
    }
    // единственный вид спорта — фильтровать нечего
    typeFilters.style.display = sorted.length > 1 ? 'flex' : 'none';

    updateStartState();
    summaryOverlay.classList.add('visible');
  }

  function filteredActs() {
    if (typeFilters.style.display === 'none') return parsed.acts;
    const sel = new Set([...typeFilters.querySelectorAll('input:checked')]
      .map(cb => cb.dataset.type));
    return parsed.acts.filter(a => sel.has(a.type));
  }

  function updateStartState() {
    const n = filteredActs().length;
    startBtn.disabled = n === 0;
    startBtn.textContent = n === 0
      ? 'Выберите хотя бы один вид'
      : `Смотреть анимацию (${n})`;
  }

  cancelSummary.addEventListener('click', () => {
    summaryOverlay.classList.remove('visible');
  });

  startBtn.addEventListener('click', () => {
    const acts = filteredActs();
    if (!acts.length) return;
    summaryOverlay.classList.remove('visible');
    WBPlayer.start(acts);
  });

  // ------------------------------------------------------------ демо-данные
  // Вымышленный бегун за три года: 310 тренировок, база в Москве, переезд
  // в Петербург, зима в Таиланде, командировки по России, Камчатка.
  // Демо снимается в рекламный ролик, поэтому в нём должны быть и дальние
  // перелёты камеры, и короткие выезды, и смена страны.
  //
  // Место кладётся в place: подпись в кадре тогда по-русски — «Москва,
  // Россия», а не «Moscow» из базы GeoNames. Таиланд — Паттайя, а не Пхукет:
  // Пхукета в базе нет (меньше 100 тысяч жителей), без подписи он выпал бы
  // и из итога «13 городов · 4 страны».
  //
  // Центры приморских городов сдвинуты вглубь суши, разброс уменьшен,
  // чтобы точки не падали в море.
  const DEMO_PLACES = {
    msk:   ['Москва',                   55.7558,  37.6173, 1.3],
    spb:   ['Санкт-Петербург',          59.9343,  30.3351, 1.0],
    ptt:   ['Паттайя',                  12.935,  100.895,  0.5],
    kzn:   ['Казань',                   55.7887,  49.1221, 0.8],
    sochi: ['Сочи',                     43.600,   39.745,  0.5],
    ekb:   ['Екатеринбург',             56.8389,  60.6057, 1.0],
    nn:    ['Нижний Новгород',          56.315,   44.02,   0.7],
    nsk:   ['Новосибирск',              55.035,   82.94,   0.8],
    krd:   ['Краснодар',                45.05,    38.98,   0.8],
    ant:   ['Анталья',                  36.905,   30.70,   0.5],
    tbs:   ['Тбилиси',                  41.7151,  44.8271, 0.8],
    pkc:   ['Петропавловск-Камчатский', 53.06,   158.645,  0.4],
    tula:  ['Тула',                     54.1931,  37.6173, 0.7]
  };

  // Дата, с которой человек бегает в этом месте; конец — начало следующего
  const DEMO_PLAN = [
    // год 1: Москва → Петербург → Таиланд → Москва с выездами
    ['2023-08-01', 'msk'], ['2023-11-01', 'spb'], ['2024-02-01', 'ptt'],
    ['2024-03-01', 'msk'], ['2024-05-24', 'kzn'], ['2024-06-02', 'msk'],
    ['2024-06-21', 'spb'], ['2024-06-30', 'msk'], ['2024-07-12', 'sochi'],
    ['2024-07-24', 'msk'],
    // год 2: Москва, выезды на 2–3 недели в крупные города
    ['2024-09-16', 'ekb'], ['2024-10-04', 'msk'], ['2024-12-09', 'nn'],
    ['2024-12-27', 'msk'], ['2025-02-17', 'nsk'], ['2025-03-10', 'msk'],
    ['2025-05-12', 'krd'], ['2025-05-30', 'msk'],
    // год 3: Москва → Петербург → Турция → Грузия → Москва → Камчатка → Москва
    ['2025-11-01', 'spb'], ['2025-12-01', 'ant'], ['2025-12-15', 'tbs'],
    ['2026-01-01', 'msk'], ['2026-03-01', 'pkc'], ['2026-06-01', 'msk'],
    ['2026-06-26', 'spb'], ['2026-07-05', 'msk'], ['2026-07-24', 'tula'],
    ['2026-07-31', 'msk'], ['2026-09-01', null]
  ];
  const DEMO_TOTAL = 310;

  function demoActs() {
    let seed = 20240817;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const DAY = 86400000;

    const segs = [];
    for (let i = 0; i + 1 < DEMO_PLAN.length; i++) {
      const from = Date.parse(DEMO_PLAN[i][0]), to = Date.parse(DEMO_PLAN[i + 1][0]);
      segs.push({ place: DEMO_PLACES[DEMO_PLAN[i][1]], from, days: (to - from) / DAY });
    }

    // Тренировки делим пропорционально времени, но на короткий выезд
    // не меньше трёх — иначе он мелькнёт в ролике незамеченным.
    // Недостачу или излишек забирают самые длинные отрезки.
    const allDays = segs.reduce((s, g) => s + g.days, 0);
    for (const g of segs) g.n = Math.max(3, Math.round(g.days / allDays * DEMO_TOTAL));
    let diff = DEMO_TOTAL - segs.reduce((s, g) => s + g.n, 0);
    const longest = [...segs].sort((a, b) => b.days - a.days);
    for (let k = 0; diff !== 0; k = (k + 1) % longest.length) {
      const step = Math.sign(diff);
      if (longest[k].n + step < 3) continue;
      longest[k].n += step;
      diff -= step;
    }

    const p = n => String(n).padStart(2, '0');
    const acts = [];
    for (const g of segs) {
      const [name, lat, lon, spread] = g.place;
      const cos = Math.cos(lat * Math.PI / 180);
      for (let k = 0; k < g.n; k++) {
        const day = Math.floor((k + 0.5 + (rnd() - 0.5) * 0.6) * g.days / g.n);
        const ts = g.from + day * DAY + Math.floor((4 + rnd() * 13) * 3600000);
        const d = new Date(ts);
        // Примерно треть занятий — длинные, остальные — будничные 5–14 км
        const km = rnd() < 0.3 ? 16 + rnd() * 14 : 5 + rnd() * 9;
        // Сумма двух случайных гуще в центре — пятно, а не квадрат
        const r1 = rnd() + rnd() - 1, r2 = rnd() + rnd() - 1;
        acts.push({
          ts,
          date: `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`,
          name: `Пробежка · ${name}`,
          place: name,
          type: 'run',
          km: Math.round(km * 10) / 10,
          lat: lat + r1 * 0.03 * spread,
          lon: lon + r2 * 0.03 * spread / cos
        });
      }
    }
    acts.sort((a, b) => a.ts - b.ts);
    return acts;
  }

  demoBtn.addEventListener('click', () => {
    const acts = demoActs();
    parsed = { acts, skipped: 0, types: new Map([['run', acts.length]]) };
    showSummary();
  });
})();
