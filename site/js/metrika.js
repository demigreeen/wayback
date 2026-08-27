/* WayBack — metrika.js
   Счётчик посещений и событий (Яндекс.Метрика).

   Зачем именно она: аудитория первым делом русскоязычная, а Метрика
   доступна из России без ухищрений — в отличие от Google Analytics,
   который у части посетителей просто не загрузится. Заодно это тот
   инструмент, которым владелец сайта умеет пользоваться сам.

   ЧТО ЗДЕСЬ ВАЖНО НЕ СЛОМАТЬ

   1. Вебвизор выключен намеренно и включать его нельзя. Он пишет
      содержимое страницы, а на странице плеера видны названия и места
      тренировок посетителя — это ровно те данные, о которых сайт
      обещает, что они никуда не уходят. Обещание держится устройством
      сервиса, а вебвизор его бы нарушил.

   2. Счётчик поднимается только после того, как license.js уберёт ключ
      покупки из адреса. Ключ приходит в части адреса после «#», и по
      устройству HTTP на сервер она не уходит — но Метрика читает адрес
      из браузера и отправила бы его вместе с ключом. Отсюда ожидание
      WBLicense.ready: cleanHash() к этому моменту уже отработал.

   3. Пустой ID полностью выключает счётчик: ни одного запроса наружу.
      Так сайт работает у себя на машине и у любого, кто его развернёт.

   4. Считаем события, а не людей: цель одна — нажатие «Скачать видео».
      Ничего про конкретного посетителя сюда не передаётся.
*/
'use strict';

const WBMetrika = (() => {

  // НОМЕР СЧЁТЧИКА Яндекс.Метрики. Пустое значение (0) выключает счётчик
  // целиком: скрипт Метрики не загружается и наружу не уходит ничего.
  // Взять номер: metrika.yandex.ru -> счётчик -> «Настройка» -> «Номер».
  const COUNTER_ID = 0;

  let ready = false;
  const queue = [];

  // Отправка цели. До подъёма счётчика складываем в очередь: человек
  // может успеть нажать кнопку раньше, чем Метрика поднимется, и такое
  // нажатие терять нельзя — оно и есть то, что мы считаем.
  function goal(name) {
    if (!COUNTER_ID) return;
    if (!ready) { queue.push(name); return; }
    try { window.ym(COUNTER_ID, 'reachGoal', name); } catch (e) { /* не критично */ }
  }

  function load() {
    /* eslint-disable */
    (function (m, e, t, r, i, k, a) {
      m[i] = m[i] || function () { (m[i].a = m[i].a || []).push(arguments); };
      m[i].l = 1 * new Date();
      for (var j = 0; j < document.scripts.length; j++) {
        if (document.scripts[j].src === r) return;
      }
      k = e.createElement(t); a = e.getElementsByTagName(t)[0];
      k.async = 1; k.src = r; a.parentNode.insertBefore(k, a);
    })(window, document, 'script',
       'https://mc.yandex.ru/metrika/tag.js', 'ym');
    /* eslint-enable */

    window.ym(COUNTER_ID, 'init', {
      clickmap: true,
      trackLinks: true,
      accurateTrackBounce: true,
      // Вебвизор выключен намеренно — см. пункт 1 в шапке файла
      webvisor: false
    });

    ready = true;
    while (queue.length) goal(queue.shift());
  }

  if (COUNTER_ID) {
    // Ждём, пока license.js уберёт ключ из адреса (пункт 2 в шапке).
    // Если license.js почему-то нет — поднимаем сразу, счётчик не должен
    // зависеть от чужого файла.
    if (typeof WBLicense !== 'undefined' && WBLicense.ready) {
      WBLicense.ready.then(load, load);
    } else {
      load();
    }
  }

  return { goal, enabled: () => !!COUNTER_ID };
})();
