/* WayBack — footer.js
   Подвал собирается кодом, а не копируется по страницам: реквизиты
   и ссылки на документы обязаны совпадать везде, а расходятся они
   ровно тогда, когда лежат в трёх файлах.

   Загружается ДО player.js: тот при старте ищет #mapCredit, и к этому
   моменту подвал уже должен существовать.
*/
'use strict';

(() => {
  const foot = document.getElementById('siteFooter');
  if (!foot) return;

  foot.innerHTML =
    '<div class="wrap">' +
      '<div class="foot-req">Самозанятый <b data-wb="name"></b> · ' +
        'ИНН <span data-wb="inn"></span> · <span data-wb="email"></span></div>' +
      '<div class="foot-links">' +
        '<a href="oferta.html">Публичная оферта</a>' +
        '<a href="privacy.html">Политика конфиденциальности</a>' +
      '</div>' +
      '<div class="foot-credit">Карта: <span id="mapCredit">© OpenStreetMap</span> · ' +
        'Города: GeoNames (CC BY)</div>' +
    '</div>';

  if (typeof WBContacts !== 'undefined') WBContacts.fill(foot);

  // Цена в оферте и в разделе «Цена» — из license.js, чтобы правка суммы
  // в одном месте не разошлась с документом.
  if (typeof WBLicense !== 'undefined') {
    const p = WBLicense.price();
    document.querySelectorAll('[data-wb-price]').forEach(el => {
      el.textContent = p[el.dataset.wbPrice];
    });
  }
})();
