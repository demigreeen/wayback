/* WayBack — issue-license
   Облачная функция: превращает оплату в ЮKassa в письмо со ссылкой.

   Как это работает. ЮKassa шлёт сюда уведомление «payment.succeeded» —
   но само уведомление не подписано и его тело можно подделать, поэтому
   ему не верят напрямую. Функция берёт из уведомления только ID платежа
   и перепроверяет его статус через API ЮKassa своим секретным ключом.
   Только после этого подписывает номер платежа закрытым ключом сайта
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
     EXPECTED_AMOUNT     — минимальная сумма в рублях, например 199
     SITE_URL            — https://wayback.pro
     SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM
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
async function fetchPayment(paymentId) {
  const auth = Buffer.from(
    `${process.env.YOOKASSA_SHOP_ID}:${process.env.YOOKASSA_SECRET_KEY}`
  ).toString('base64');
  const res = await fetch(`https://api.yookassa.ru/v3/payments/${paymentId}`, {
    headers: { Authorization: `Basic ${auth}` }
  });
  if (!res.ok) throw new Error(`ЮKassa API ответила ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------- почта
async function sendLink(to, link) {
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
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
    from: process.env.MAIL_FROM,
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

module.exports.handler = async event => {
  let body;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf8')
      : (event.body || '{}');
    body = JSON.parse(raw);
  } catch (e) {
    return ok('bad json');
  }

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

  const minAmount = Number(process.env.EXPECTED_AMOUNT || '0');
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
