/* WayBack — contacts.js
   Реквизиты в одном месте.

   ЗАПОЛНИТЬ ПЕРЕД ПОДКЛЮЧЕНИЕМ ОПЛАТЫ. Отсюда значения подставляются
   в подвал сайта, в оферту и в политику конфиденциальности — править
   три файла руками не нужно.

   Требование платёжного сервиса: на сайте должны быть указаны ФИО и ИНН
   самозанятого и способ связи. Пока поля пустые, на их месте видна
   заметная пометка — так пропуск нельзя не заметить.
*/
'use strict';

const WBContacts = (() => {

  const DATA = {
    // ФИО здесь НЕТ намеренно. Этот файл отдаётся браузеру как есть,
    // и любой может открыть wayback.pro/js/contacts.js и прочитать его —
    // убрать имя из разметки, оставив в скрипте, значило бы не убрать
    // его вовсе. Исполнителя определяет ИНН: он публичный и проверяется
    // через сайт ФНС, поэтому и оферта, и политика остаются
    // с определённой стороной договора.

    // ИНН самозанятого, 12 цифр
    inn: '402811145107',

    // Почта для связи с покупателями. Показывается на сайте открыто,
    // поэтому лучше отдельный ящик, а не личный.
    email: 'koslos5896@gmail.com',

    // Телефон. Платёжный сервис просит его в списке контактов.
    // Пустое значение прячет строку целиком, а не оставляет «Телефон: —».
    phone: '',

    // Почтовый адрес. Достаточно города: домашний адрес на открытом сайте
    // собирает спам и звонки, а требованию соответствует и город.
    address: 'г. Калуга'
  };

  // Дата, с которой действуют документы. Меняется при правке оферты.
  const DOCS_DATE = '27 августа 2026 года';

  const MISSING = '⟨не заполнено⟩';

  function value(key) {
    return DATA[key] || MISSING;
  }

  // Подстановка в разметку: <span data-wb="email"></span>.
  // Для почты и телефона делаем ссылку — на телефоне это одно касание.
  function fill(root) {
    const scope = root || document;

    // Необязательные строки: <span data-wb-line="phone">Телефон: …</span>.
    // Пустое значение убирает строку целиком — иначе в реквизитах осталось
    // бы висеть «Телефон:» без номера.
    scope.querySelectorAll('[data-wb-line]').forEach(el => {
      el.hidden = !DATA[el.dataset.wbLine];
    });

    scope.querySelectorAll('[data-wb]').forEach(el => {
      const key = el.dataset.wb;
      if (key === 'docsDate') { el.textContent = DOCS_DATE; return; }
      const v = DATA[key];
      if (!v) {
        // Внутри скрытой необязательной строки пометка не нужна: строки
        // на экране нет, а .wb-missing должен оставаться честным признаком
        // того, что забыли заполнить обязательное поле.
        const line = el.closest('[data-wb-line]');
        if (line && line.hidden) { el.textContent = ''; return; }
        el.textContent = MISSING; el.classList.add('wb-missing'); return;
      }
      el.classList.remove('wb-missing');
      if (key === 'email') { el.innerHTML = ''; el.append(link('mailto:' + v, v)); return; }
      if (key === 'phone') { el.innerHTML = ''; el.append(link('tel:' + v.replace(/[^\d+]/g, ''), v)); return; }
      el.textContent = v;
    });
  }

  function link(href, text) {
    const a = document.createElement('a');
    a.href = href; a.textContent = text;
    return a;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => fill());
  } else {
    fill();
  }

  return { get: value, fill, docsDate: () => DOCS_DATE, raw: () => DATA };
})();
