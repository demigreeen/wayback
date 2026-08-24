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
    // ФИО самозанятого полностью
    name: '',

    // ИНН самозанятого, 12 цифр
    inn: '',

    // Почта для связи с покупателями. Показывается на сайте открыто,
    // поэтому лучше отдельный ящик, а не личный.
    email: '',

    // Телефон. Платёжный сервис просит его в списке контактов.
    // Можно оставить пустым, если хватает почты — но тогда будьте готовы
    // дослать номер по их запросу.
    phone: '',

    // Почтовый адрес. Достаточно города: домашний адрес на открытом сайте
    // собирает спам и звонки, а требованию соответствует и город.
    address: ''
  };

  // Дата, с которой действуют документы. Меняется при правке оферты.
  const DOCS_DATE = '24 августа 2026 года';

  const MISSING = '⟨не заполнено⟩';

  function value(key) {
    return DATA[key] || MISSING;
  }

  // Подстановка в разметку: <span data-wb="email"></span>.
  // Для почты и телефона делаем ссылку — на телефоне это одно касание.
  function fill(root) {
    (root || document).querySelectorAll('[data-wb]').forEach(el => {
      const key = el.dataset.wb;
      if (key === 'docsDate') { el.textContent = DOCS_DATE; return; }
      const v = DATA[key];
      if (!v) { el.textContent = MISSING; el.classList.add('wb-missing'); return; }
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
