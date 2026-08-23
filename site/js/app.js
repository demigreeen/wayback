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
      });
    } catch (err) {
      showParse(false);
      alert('Не удалось прочитать архив: ' + (err && err.message ? err.message : err));
      return;
    }
    showParse(false);
    fileInput.value = '';

    if (!parsed.acts.length) {
      alert('В этих файлах не нашлось тренировок, которые можно показать ' +
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
  // Синтетическая история с переездом: два города одной страны, затем другая.
  // Именно переезд делает анимацию интересной — ради него в кадре и подписи
  // локаций, а камера показывает дальний перелёт.
  function demoActs() {
    const cities = [
      { name: 'Лион',      lat: 45.7640, lon: 4.8357, n: 34 },
      { name: 'Париж',     lat: 48.8566, lon: 2.3522, n: 28 },
      { name: 'Барселона', lat: 41.3874, lon: 2.1686, n: 22 }
    ];
    const acts = [];
    let t = Date.UTC(2021, 3, 12, 7, 30);
    let seed = 20240817;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

    for (const city of cities) {
      for (let k = 0; k < city.n; k++) {
        const d = new Date(t);
        const p = n => String(n).padStart(2, '0');
        acts.push({
          ts: t,
          date: `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`,
          name: `Пробежка · ${city.name}`,
          type: 'run',
          km: Math.round((4 + rnd() * 12) * 10) / 10,
          // Разброс держим небольшим, чтобы точки не расползались за город
          // и подпись локации оставалась той же самой
          lat: city.lat + (rnd() - 0.5) * 0.05,
          lon: city.lon + (rnd() - 0.5) * 0.07
        });
        t += (2 + Math.floor(rnd() * 5)) * 86400000;
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
