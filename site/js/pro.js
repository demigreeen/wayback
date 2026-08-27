/* WayBack — pro.js
   Панель PRO-версии: что входит в покупку, форма оплаты, запирание платных
   возможностей.

   Почему отдельный файл. Раньше панель покупки жила внутри окна экспорта
   в player.js и открывалась только из плеера. Теперь входов четыре —
   кнопка в шапке лендинга, кнопка в панели плеера и две запертые
   возможности (период и тёмная тема), — а лендинг работает до того, как
   плеер вообще запущен. Общий владелец панели должен подниматься при
   загрузке страницы, поэтому он вынесен сюда, а player.js только зовёт
   WBPro.open().

   Панель лежит в конце body, а не внутри плеера, по той же причине.

   Запирание честное ровно настолько, насколько честна вся схема покупки:
   проверка идёт в браузере и обходится инструментами разработчика.
   Это осознанный размен, объяснённый в license.js. */
'use strict';

const WBPro = (() => {

  const $ = id => document.getElementById(id);

  // Что входит в PRO — для панели покупки. Первым идёт водяной знак:
  // он самый понятный и был первой причиной платить, остальное добавилось
  // позже. Про разовость платежа здесь не пишем: это уже сказано значком
  // «разово, навсегда» над списком, а повтор разбавляет перечень выгод.
  //
  // На price.html тот же список написан руками в HTML, и это намеренно:
  // смысловой текст страницы не должен появляться скриптом, иначе поисковый
  // робот увидит пустой раздел. Там перечень длиннее — страница тарифов
  // обязана называть и условия оплаты. Правки по составу — в оба места,
  // а сам состав услуги ещё и в п. 1.1 оферты.
  const FEATURES = [
    'В углу кадра не будет надписи <b>wayback.pro</b>',
    'Выбор периода: видео за нужный год или свой отрезок дат',
    'Доступ к тёмной теме карты',
    'Ссылка придёт на почту и работает на любом вашем устройстве'
  ];

  let overlay = null;
  const watchers = [];

  const paid = () => typeof WBLicense !== 'undefined' && WBLicense.isPaid();

  // ---------------------------------------------------------------- панель
  function fill() {
    if (typeof WBLicense === 'undefined') return;
    const p = WBLicense.price();
    $('buyWas').textContent = p.was + ' ' + p.currency;
    $('buyNow').textContent = p.now + ' ' + p.currency;

    const list = $('buyList');
    if (list && !list.dataset.filled) {
      list.innerHTML = FEATURES.map(f => '<li>' + f + '</li>').join('');
      list.dataset.filled = '1';
    }

    const canPay = WBLicense.enabled();
    $('buyForm').hidden = !canPay;
    $('buySoon').hidden = canPay;
    if (!canPay) return;

    $('buyGo').textContent = 'Оплатить ' + p.now + ' ' + p.currency;
    $('buyError').hidden = true;
  }

  // Почта нужна дважды: на неё уйдёт ссылка и на неё же ЮKassa пришлёт чек.
  // Спрашиваем её здесь, а не полагаемся на чек: так письмо уйдёт даже если
  // у платежа почта окажется в другом поле.
  async function goToPayment() {
    const go = $('buyGo');
    const err = $('buyError');
    const email = $('buyEmail').value.trim();

    const fail = text => { err.textContent = text; err.hidden = false; };
    err.hidden = true;

    if (!/^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(email)) {
      fail('Проверьте адрес почты — на неё придёт ссылка.');
      $('buyEmail').focus();
      return;
    }

    // Пока идёт запрос, кнопку надо запереть: второй щелчок создал бы
    // второй платёж, и человек заплатил бы дважды.
    const was = go.textContent;
    go.disabled = true;
    go.textContent = 'Открываем оплату…';
    try {
      location.href = await WBLicense.startPayment(email);
    } catch (e) {
      fail(e.message);
      go.disabled = false;
      go.textContent = was;
    }
  }

  // ---------------------------------------------------------------- открытие
  // Панель поверх всего, в том числе поверх окна экспорта: на телефоне
  // покупку открывают именно оттуда, и закрывать окно экспорта ради этого
  // неправильно — человек вернётся к тем же настройкам.
  function open(reason) {
    if (!overlay) return;
    fill();
    const hint = $('buyReason');
    if (hint) {
      hint.textContent = reason || '';
      hint.hidden = !reason;
    }
    overlay.classList.add('visible');
    document.body.classList.add('pro-open');
  }

  function close() {
    if (!overlay) return;
    overlay.classList.remove('visible');
    document.body.classList.remove('pro-open');
  }

  // ---------------------------------------------------------------- запирание
  // Единая точка для платных кнопок: не куплено — вместо действия
  // открывается панель с объяснением, почему её показали.
  function gate(reason, action) {
    if (paid()) { action(); return true; }
    open(reason);
    return false;
  }

  // Состояние покупки приходит асинхронно (подпись проверяется через
  // crypto.subtle), поэтому всё, что от него зависит, подписывается сюда
  // и пересчитывается, когда license.js закончит.
  function onChange(fn) {
    watchers.push(fn);
    fn(paid());
  }

  function sync() {
    watchers.forEach(fn => fn(paid()));
  }

  // ---------------------------------------------------------------- запуск
  function init() {
    overlay = $('proOverlay');
    if (!overlay) return;

    $('buyBack').addEventListener('click', close);
    // Щелчок мимо панели закрывает её: панель — предложение, а не шаг,
    // который обязательно проходить.
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && overlay.classList.contains('visible')) close();
    });

    $('buyGo').addEventListener('click', goToPayment);
    $('buyEmail').addEventListener('keydown', e => {
      if (e.key === 'Enter') goToPayment();
    });

    // Кнопка в шапке лендинга. Купившему покупать нечего — вместо неё
    // остаётся отметка, что PRO работает в этом браузере: до первого видео
    // другого подтверждения у человека нет.
    const btn = $('proBtn');
    if (btn) {
      btn.addEventListener('click', () => open());
      onChange(isPaid => {
        btn.textContent = isPaid ? 'PRO активен' : 'PRO версия';
        btn.classList.toggle('is-paid', isPaid);
        btn.disabled = isPaid;
      });
    }

    if (typeof WBLicense !== 'undefined') WBLicense.ready.then(sync);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { open, close, gate, isPaid: paid, onChange, sync, FEATURES };
})();
