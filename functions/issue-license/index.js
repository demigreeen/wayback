/* WayBack — issue-license
   Облачная функция: создаёт платёж и превращает оплату в письмо со ссылкой.

   Делает две вещи, потому что обе требуют секретного ключа ЮKassa,
   а ключу место только на сервере — в браузер его класть нельзя.

   1. Создание платежа. Магазин подключён по протоколу API, а значит
      статичной ссылки на оплату не существует: платёж создаётся запросом
      с суммой и адресом возврата, в ответ приходит адрес страницы оплаты,
      куда браузер и отправляет покупателя. Сумму задаёт эта функция,
      а не браузер: иначе цену можно было бы переписать в инструментах
      разработчика и купить за рубль.

   2. Выдача ключа. ЮKassa шлёт уведомление «payment.succeeded» — но само
      уведомление не подписано и его тело можно подделать, поэтому ему
      не верят напрямую. Функция берёт из уведомления только ID платежа
      и перепроверяет статус через API своим секретным ключом. Только
      после этого подписывает номер платежа закрытым ключом сайта
      и отправляет письмо со ссылкой — тем же способом, каким это делает
      вручную tools/keygen.html.

   Базы данных нет: номером покупки служит сам ID платежа от ЮKassa,
   он уже уникален. Копия каждого письма уходит на OWNER_EMAIL — это
   и есть журнал покупок, по которому можно найти платёж и, если нужно,
   вписать его ID в REVOKED в site/js/license.js.

   Известный компромисс без базы: если ЮKassa пришлёт уведомление дважды
   (у неё так бывает при повторах), письмо может уйти дважды. Обе ссылки
   будут рабочими и вести на один и тот же платёж — вреда в этом нет,
   кроме лишнего письма.

   Переменные окружения (задаются в консоли облака, не в этом файле):
     PRIVATE_KEY_JWK    — закрытый ключ, тот же JSON, что скачал keygen.html
     YOOKASSA_SHOP_ID    — идентификатор магазина
     YOOKASSA_SECRET_KEY — секретный ключ ЮKassa (из Настройки → API ключи)
     AMOUNT              — цена в рублях, например 199. Она же проверяется
                           при выдаче ключа, чтобы оплата другой суммы
                           не открывала доступ
     SITE_URL            — https://wayback.pro
     SMTP                — строка подключения к почте, либо вместо неё
                           SMTP_HOST + SMTP_PORT + SMTP_USER + SMTP_PASS
     MAIL_FROM           — адрес отправителя
     OWNER_EMAIL         — куда слать копию каждого письма (необязательно)
   Подробности разворачивания — в README.md рядом с этим файлом.
*/
'use strict';

const { webcrypto } = require('crypto');
const nodemailer = require('nodemailer');
const fetch = require('node-fetch');

const { subtle } = webcrypto;

// ---------------------------------------------------------------- кодировки
function toB64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------- подпись
// Закрытый ключ импортируется один раз за время жизни контейнера функции,
// а не на каждый вызов — так холодный старт не бьёт по задержке ответа.
let cachedKey = null;
async function privateKey() {
  if (!cachedKey) {
    const jwk = JSON.parse(process.env.PRIVATE_KEY_JWK);
    cachedKey = subtle.importKey(
      'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  }
  return cachedKey;
}

// Формат токена и порядок подписи — ровно как в tools/keygen.html и
// site/js/license.js. Расхождение в мелочи (лишний пробел, другой порядок
// полей) сделает все выданные функцией ссылки нерабочими.
async function signOrder(orderId) {
  const payload = { o: String(orderId), d: new Date().toISOString().slice(0, 10) };
  const payloadB64 = toB64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const key = await privateKey();
  const sig = await subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(payloadB64, 'utf8'));
  return `v1.${payloadB64}.${toB64url(sig)}`;
}

// ---------------------------------------------------------------- ЮKassa
// Тело вебхука — это то, что прислал вызывающий, а не обязательно ЮKassa:
// у HTTP-уведомлений ЮKassa нет проверяемой подписи. Поэтому по ID из
// уведомления платёж перезапрашивается напрямую, своим секретным ключом,
// и уже этому ответу можно доверять.
function authHeader() {
  const pair = `${process.env.YOOKASSA_SHOP_ID}:${process.env.YOOKASSA_SECRET_KEY}`;
  return 'Basic ' + Buffer.from(pair).toString('base64');
}

function amount() {
  return Number(process.env.AMOUNT || '0');
}

async function fetchPayment(paymentId) {
  const res = await fetch(`https://api.yookassa.ru/v3/payments/${paymentId}`, {
    headers: { Authorization: authHeader() }
  });
  if (!res.ok) throw new Error(`ЮKassa API ответила ${res.status}`);
  return res.json();
}

// Ключ идемпотентности: если браузер повторит запрос из-за обрыва связи,
// ЮKassa вернёт тот же платёж, а не создаст второй.
function idempotenceKey() {
  return require('crypto').randomUUID();
}

// Чек нужен по 54-ФЗ: для самозанятого ЮKassa формирует его через «Мой
// налог», но контакт покупателя обязана получить от нас. Если ЮKassa
// ответит ошибкой на блок receipt — значит, чек у магазина формируется
// иначе, и блок надо убрать; текст ошибки будет в логах функции.
async function createPayment(email) {
  const rub = amount().toFixed(2);
  const body = {
    amount: { value: rub, currency: 'RUB' },
    capture: true,
    confirmation: {
      type: 'redirect',
      return_url: `${process.env.SITE_URL}/paid.html`
    },
    description: 'WayBack — отключение водяного знака',
    // Почту дублируем в metadata: чек живёт по своим правилам, а нам она
    // нужна железно — именно на неё уйдёт ссылка
    metadata: { email },
    receipt: {
      customer: { email },
      items: [{
        description: 'Отключение водяного знака в сервисе WayBack',
        quantity: '1.00',
        amount: { value: rub, currency: 'RUB' },
        vat_code: 1,
        payment_subject: 'service',
        payment_mode: 'full_payment'
      }]
    }
  };

  const res = await fetch('https://api.yookassa.ru/v3/payments', {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Idempotence-Key': idempotenceKey(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`ЮKassa отказала (${res.status}): ` +
      (data ? JSON.stringify(data) : 'без тела'));
  }
  return data;
}

// ---------------------------------------------------------------- почта
// Настройки почты задаются одним из двух способов, потому что заводить
// четыре отдельные переменные в консоли облака удаётся не всегда:
//
//   SMTP=smtps://имя%40ящик.ру:пароль@smtp.yandex.ru:465
//   либо SMTP_HOST + SMTP_PORT + SMTP_USER + SMTP_PASS
//
// В строке подключения символ @ внутри имени пользователя записывается
// как %40 — иначе разбор адреса споткнётся о второй @.
function mailTransport() {
  const url = (process.env.SMTP || '').trim();
  if (url) {
    if (!/^smtps?:\/\//i.test(url)) {
      throw new Error('SMTP должен начинаться с smtps:// — сейчас там другое');
    }
    return nodemailer.createTransport(url);
  }
  if (!process.env.SMTP_HOST) {
    throw new Error('Почта не настроена: нет ни SMTP, ни SMTP_HOST');
  }
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

async function sendLink(to, link) {
  const transport = mailTransport();
  const text = [
    'Спасибо за покупку.',
    '',
    'Ваша ссылка:',
    link,
    '',
    'Сохраните это письмо. Ссылка бессрочная и работает на любом вашем',
    'устройстве — просто откройте её в том браузере, где будете делать видео.',
    'Если браузер очистит данные, откройте ссылку заново.',
    '',
    'Ссылка личная, не публикуйте её.'
  ].join('\n');
  await transport.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to,
    bcc: process.env.OWNER_EMAIL || undefined,
    subject: 'WayBack — ваша ссылка',
    text
  });
}

// ---------------------------------------------------------------- вход
// Ответ 200 говорит ЮKassa «принято, не повторять» — так отвечаем и на
// события, которые нас не касаются, и на случаи, где повтор не поможет
// (нет почты в чеке — это требует ручного разбора, а не автоповтора).
// Ответ 500 — только на временный сбой (сеть, ЮKassa недоступна), чтобы
// ЮKassa попробовала прислать уведомление ещё раз.
const ok = body => ({ statusCode: 200, body });
const retry = body => ({ statusCode: 500, body });

// Браузер обращается сюда с другого домена, поэтому нужны заголовки CORS
// и ответ на предварительный запрос OPTIONS. Уведомлениям ЮKassa они
// не мешают: лишние заголовки в ответе она игнорирует.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};
const json = (statusCode, obj) => ({
  statusCode,
  headers: Object.assign({ 'Content-Type': 'application/json' }, CORS),
  body: JSON.stringify(obj)
});

// Проверка почты нарочно мягкая: строгие выражения отсекают живые адреса,
// а настоящая проверка тут одна — письмо либо дойдёт, либо нет.
const EMAIL_OK = /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/;

// Браузер просит адрес страницы оплаты. Сумму берём свою: если бы её
// присылал браузер, цену можно было бы переписать и купить за рубль.
async function handleCreate(body) {
  const email = String(body.email || '').trim().toLowerCase();
  if (!EMAIL_OK.test(email) || email.length > 254) {
    return json(400, { error: 'bad_email' });
  }
  if (!amount()) {
    console.error('AMOUNT не задан');
    return json(500, { error: 'not_configured' });
  }
  try {
    const payment = await createPayment(email);
    const url = payment.confirmation && payment.confirmation.confirmation_url;
    if (!url) throw new Error('ЮKassa не вернула confirmation_url');
    return json(200, { confirmation_url: url });
  } catch (e) {
    console.error('createPayment', e.message);
    return json(502, { error: 'payment_create_failed' });
  }
}

module.exports.handler = async event => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  let body;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf8')
      : (event.body || '{}');
    body = JSON.parse(raw);
  } catch (e) {
    return ok('bad json');
  }

  // Два разных вызывающих: сайт просит создать платёж, ЮKassa сообщает
  // о его успехе. Различаем по телу запроса.
  if (body && body.action === 'create') return handleCreate(body);

  const obj = body.object;
  if (body.event !== 'payment.succeeded' || !obj || !obj.id) {
    return ok('ignored');
  }

  let payment;
  try {
    payment = await fetchPayment(obj.id);
  } catch (e) {
    console.error('fetchPayment', e);
    return retry('payment lookup failed');
  }

  if (payment.status !== 'succeeded') return ok('not succeeded yet');

  const minAmount = amount();
  if (minAmount && Number(payment.amount.value) < minAmount) {
    console.error('amount mismatch', payment.id, payment.amount);
    return ok('amount too low');
  }

  // Почта берётся из чека — ЮKassa требует её (или телефон) для НПД-чека
  // самозанятого, так что в норме она у платежа есть. Телефон в качестве
  // получателя письма не годится, поэтому при нём тоже считаем письмо
  // невозможным и полагаемся на ручной разбор по OWNER_EMAIL.
  const email = payment.receipt_email
    || (payment.recipient && payment.recipient.customer && payment.recipient.customer.email)
    || (payment.metadata && payment.metadata.email);
  if (!email) {
    console.error('no email for payment', payment.id, payment.amount);
    return ok('no email — needs manual follow-up');
  }

  try {
    const token = await signOrder(payment.id);
    const link = `${process.env.SITE_URL}/#k=${token}`;
    await sendLink(email, link);
  } catch (e) {
    console.error('sendLink', e);
    return retry('mail send failed');
  }

  return ok('sent');
};
