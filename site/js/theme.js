/* WayBack — theme.js
   Палитра карты и кадра в одном месте.

   Карта и след рисуются разным кодом — тайлы в vectormap.js, всё поверх
   в player.js, — но глазу это один кадр. Пока цвета лежали в двух файлах,
   светлую тему нельзя было сделать, не рассогласовав их. Теперь обе части
   берут цвета отсюда.

   Правило подбора: карта — фон, а не герой. Синий след должен доминировать
   в обеих темах, поэтому карта держится обесцвеченной, а насыщенность
   отдаётся следу. В светлой теме синий взят темнее: на белом фоне светлый
   #60a5fa теряется, а #2563eb читается так же уверенно, как #60a5fa
   на чёрном.
*/
'use strict';

const WBTheme = (() => {

  const STORE = 'wb.theme';

  const DARK = {
    name: 'dark',

    // ---- карта (vectormap.js)
    map: {
      bg:       '#0b0e14',
      water:    '#08101c',
      green:    '#0b1210',
      landuse:  '#0c0f16',
      building: '#111520',
      boundary: 'rgba(150,165,190,0.18)',
      roads: {
        minor:     '#1a1e28',
        tertiary:  '#20252f',
        secondary: '#272c38',
        primary:   '#2f3542',
        motorway:  '#3a4151'
      }
    },

    // ---- всё, что рисуется поверх карты (player.js)
    frame: {
      // Фон кадра совпадает с фоном карты: это одна поверхность, просто
      // в кадре она проступает там, где тайла ещё нет.
      bg:          '#0b0e14',
      accent:      '#3b82f6',
      accentHi:    '#60a5fa',
      trailGlow:   'rgba(59,130,246,0.16)',
      trailLine:   'rgba(96,165,250,0.8)',
      dot:         'rgba(59,130,246,0.65)',
      burst:       '96,165,250',          // rgb для прозрачности по ходу волны
      headRing:    '#ffffff',
      hudPanel:    'rgba(13,16,24,0.75)',
      hudText:     '#f4f3f1',
      hudDim:      '#9aa0ad',
      attribution: 'rgba(255,255,255,0.38)',
      watermark:   'rgba(255,255,255,0.62)',
      labelShadow: 'rgba(0,0,0,0.85)',
      labelCountry:'rgba(186,198,218,0.78)',
      labelPlace:  'rgba(158,170,190,0.72)'
    }
  };

  const LIGHT = {
    name: 'light',

    map: {
      bg:       '#f2f5fa',
      water:    '#cbdcf0',
      green:    '#dde9d9',
      landuse:  '#eaeef5',
      building: '#dfe4ed',
      boundary: 'rgba(90,105,130,0.30)',
      // Дороги темнее фона — на светлой карте это читается лучше, чем белые
      roads: {
        minor:     '#e4e9f1',
        tertiary:  '#dbe1ea',
        secondary: '#d0d8e4',
        primary:   '#c2ccdc',
        motorway:  '#b2bfd3'
      }
    },

    frame: {
      bg:          '#f2f5fa',
      accent:      '#2563eb',
      accentHi:    '#1d4ed8',
      trailGlow:   'rgba(37,99,235,0.14)',
      trailLine:   'rgba(37,99,235,0.85)',
      dot:         'rgba(37,99,235,0.7)',
      burst:       '37,99,235',
      // Белое кольцо вокруг головы на светлой карте исчезает — берём тёмное
      headRing:    '#0f172a',
      hudPanel:    'rgba(255,255,255,0.85)',
      hudText:     '#0f172a',
      hudDim:      '#5b6577',
      attribution: 'rgba(15,23,42,0.45)',
      watermark:   'rgba(15,23,42,0.55)',
      // Тень у подписи меняет роль: в тёмной теме затемняет, в светлой
      // работает как белая обводка вокруг тёмных букв
      labelShadow: 'rgba(255,255,255,0.95)',
      labelCountry:'rgba(30,41,59,0.80)',
      labelPlace:  'rgba(51,65,85,0.72)'
    }
  };

  const THEMES = { dark: DARK, light: LIGHT };

  // По умолчанию светлая: сайт вокруг белый, и тёмный плеер после белого
  // лендинга читался как чужая страница. Тёмная остаётся выбором.
  let current = (() => {
    try {
      const saved = localStorage.getItem(STORE);
      if (saved && THEMES[saved]) return THEMES[saved];
    } catch (e) { /* приватный режим — просто светлая */ }
    return LIGHT;
  })();

  const listeners = [];

  function set(name) {
    const next = THEMES[name];
    if (!next || next === current) return current;
    current = next;
    try { localStorage.setItem(STORE, name); } catch (e) { /* не критично */ }
    for (const fn of listeners) {
      try { fn(current); } catch (e) { console.error('theme listener', e); }
    }
    return current;
  }

  return {
    get: () => current,
    map: () => current.map,
    frame: () => current.frame,
    name: () => current.name,
    isLight: () => current.name === 'light',
    set,
    toggle: () => set(current.name === 'dark' ? 'light' : 'dark'),
    onChange: fn => { listeners.push(fn); }
  };
})();
