/* WayBack — license.js
   Покупка без сервера, без аккаунтов и без базы данных.

   Как это устроено. У владельца сайта на диске лежит закрытый ключ, здесь —
   открытый. После оплаты владелец подписывает номер заказа закрытым ключом
   и отправляет покупателю ссылку вида wayback.pro/#k=<ключ>. Браузер
   проверяет подпись открытым ключом и запоминает результат. Проверка идёт
   локально: ни сервер, ни сеть не участвуют, а «кто оплатил» нигде не
   хранится — ответ содержится в самой подписи.

   Часть ссылки после # браузер не отправляет на сервер, поэтому ключ
   существует только в письме покупателя и в его localStorage.

   Чего эта схема не умеет, и это осознанный размен:
   - ссылку можно переслать, и она заработает у другого (см. REVOKED);
   - проверку можно обойти через инструменты разработчика.
   Защита от того и другого требует сервера, а сервер стоит дороже
   потерь при цене в двести рублей.
*/
'use strict';

const WBLicense = (() => {

  // ---------------------------------------------------------------- настройка
  //
  // ССЫЛКА НА ОПЛАТУ из платёжного сервиса. Пока строка пустая, блок
  // покупки на сайте всё равно виден — скрывается только сама кнопка
  // оплаты, а вместо неё показывается почта для ручной выдачи ключа.
  // Вставьте ссылку — кнопка появится сама.
  const PAY_URL = '';

  const PRICE = { was: 499, now: 199, currency: '₽' };

  // ОТКРЫТЫЙ КЛЮЧ. null означает, что ключи ещё не созданы: сайт работает,
  // но ни одна ссылка не будет принята. Создаётся один раз в tools/keygen.html
  // вместе с закрытым; оттуда же копируется готовая строка для этого места.
  //
  // Закрытому ключу здесь не место никогда: по нему подделывают покупки.
  const PUBLIC_JWK = null;

  // Отключённые покупки — по номеру заказа. Сюда попадает номер, чью ссылку
  // выложили в открытый доступ. Действует со следующего обновления сайта.
  const REVOKED = [];

  const STORE = 'wb.license';
  const HASH_KEY = 'k';

  // ---------------------------------------------------------------- состояние
  let paid = false;
  let order = null;
  let ready;

  // ---------------------------------------------------------------- кодировки
  function fromB64url(s) {
    const t = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(t + '='.repeat((4 - t.length % 4) % 4));
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  // ---------------------------------------------------------------- проверка
  // Токен: v1.<полезная часть>.<подпись>
  // Подписывается текст полезной части как есть — так проверка не зависит
  // от того, в каком порядке JSON разложит поля.
  async function verify(token) {
    if (!PUBLIC_JWK || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') return null;

    let sig, payload;
    try {
      sig = fromB64url(parts[2]);
      payload = JSON.parse(new TextDecoder().decode(fromB64url(parts[1])));
    } catch (e) { return null; }

    if (!payload || typeof payload.o !== 'string') return null;
    if (REVOKED.indexOf(payload.o) !== -1) return null;

    try {
      const key = await crypto.subtle.importKey(
        'jwk', PUBLIC_JWK, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      const ok = await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' }, key, sig,
        new TextEncoder().encode(parts[1]));
      return ok ? payload : null;
    } catch (e) { return null; }
  }

  // ---------------------------------------------------------------- запуск
  function hashToken() {
    const h = location.hash.replace(/^#/, '');
    if (!h) return null;
    const m = new URLSearchParams(h).get(HASH_KEY);
    return m || null;
  }

  // Ключ из адреса убираем, чтобы он не остался в строке браузера и не уехал
  // случайно вместе со скриншотом или пересланной ссылкой на страницу.
  function cleanHash() {
    const h = new URLSearchParams(location.hash.replace(/^#/, ''));
    h.delete(HASH_KEY);
    const rest = h.toString();
    history.replaceState(null, '', location.pathname + location.search +
      (rest ? '#' + rest : ''));
  }

  async function init() {
    let stored = null;
    try { stored = localStorage.getItem(STORE); } catch (e) { /* приватный режим */ }

    const fresh = hashToken();
    if (fresh) {
      const p = await verify(fresh);
      cleanHash();
      if (p) {
        paid = true; order = p.o;
        try { localStorage.setItem(STORE, fresh); } catch (e) { /* не критично */ }
        toast('Подпись в кадре отключена. Ссылка сохранена в этом браузере.');
        return;
      }
      // Испорченная ссылка не должна отбирать уже действующую покупку
      if (!stored) {
        toast('Ссылка не распознана. Проверьте, что она скопирована целиком.', true);
      }
    }

    if (stored) {
      const p = await verify(stored);
      if (p) { paid = true; order = p.o; }
      else { try { localStorage.removeItem(STORE); } catch (e) { /* пусто */ } }
    }
  }

  // ---------------------------------------------------------------- сообщение
  function toast(text, warn) {
    const el = document.createElement('div');
    el.className = 'wb-toast' + (warn ? ' warn' : '');
    el.textContent = text;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('in'));
    setTimeout(() => {
      el.classList.remove('in');
      setTimeout(() => el.remove(), 400);
    }, 6000);
  }

  ready = init();

  // Ссылку могут вставить в адресную строку уже открытого сайта. Смена
  // только якоря страницу не перезагружает, поэтому init() сам бы не
  // сработал, и человек решил бы, что ссылка нерабочая.
  window.addEventListener('hashchange', () => { if (hashToken()) init(); });

  return {
    ready,
    isPaid: () => paid,
    order: () => order,
    price: () => PRICE,
    payUrl: () => PAY_URL,
    enabled: () => !!PAY_URL
  };
})();
