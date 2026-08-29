/* WayBack — zipaes.js
   Записи ZIP, закрытые паролем по схеме WinZip AES.

   Зачем это здесь. Выгрузка Huawei приходит письмом уже зашифрованной:
   пароль человек задаёт сам, когда заказывает копию данных. Для читателя
   архива такой файл выглядит целым, но пустым — записи на месте, а взять
   из них нечего, и сайт честно отвечал «тренировок не нашлось». Отправлять
   человека распаковывать архиватором нельзя: выгрузку Huawei заказывают
   только с телефона, и распаковать там 400 МБ практически нечем.

   Формат (APPNOTE гл. 7 плюс спецификация WinZip AE-2):
     запись = соль | 2 байта проверки пароля | шифротекст | 10 байт подписи
     ключи  = PBKDF2-HMAC-SHA1(пароль, соль, 1000 повторов) → шифр|подпись|2
     шифр   = AES-CTR со счётчиком в 16 байт, растёт с единицы младшим
              байтом вперёд
   Настоящий метод сжатия и длина ключа лежат в дополнительном поле 0x9901,
   а в самой записи метод помечен числом 99.

   Почему AES написан руками, а не взят у браузера. WebCrypto умеет AES-CTR,
   но наращивает счётчик как число со старшим байтом слева, а WinZip — задом
   наперёд. Совпадает только первый блок, поэтому вызывать пришлось бы по
   разу на каждые 16 байт: на 33 МБ выгрузки это миллионы обращений к крипто-
   подсистеме. Через WebCrypto идёт только PBKDF2 — там всё решают повторы
   хэша, и своя реализация была бы и медленнее, и подозрительнее.

   Подпись HMAC не проверяется намеренно. Её работа — заметить порчу файла,
   но битую запись и так отбрасывает распаковка, а перебирать ради этого
   ещё раз все 33 МБ незачем. Пароль сверяется по двум контрольным байтам:
   этого хватает, чтобы не молотить весь архив с заведомо чужим ключом.
*/
'use strict';

const WBZipAES = (() => {

  // ------------------------------------------------------------ таблицы AES
  // S-блок считается по определению, а не лежит таблицей на 256 чисел:
  // так в файле видно, что это стандартный AES, а не чья-то самоделка.
  const S = new Uint8Array(256);
  (() => {
    const rotl = (x, n) => ((x << n) | (x >>> (8 - n))) & 0xFF;
    let p = 1, q = 1;
    do {
      p = (p ^ (p << 1) ^ (p & 0x80 ? 0x1B : 0)) & 0xFF;   // умножение на 3
      q = (q ^ (q << 1)) & 0xFF;                           // деление на 3
      q = (q ^ (q << 2)) & 0xFF;
      q = (q ^ (q << 4)) & 0xFF;
      if (q & 0x80) q ^= 0x09;
      S[p] = (q ^ rotl(q, 1) ^ rotl(q, 2) ^ rotl(q, 3) ^ rotl(q, 4) ^ 0x63) & 0xFF;
    } while (p !== 1);
    S[0] = 0x63;
  })();

  // Четыре таблицы раунда: подстановка и перемешивание столбца сразу вместе.
  // Один раунд превращается в четыре выборки и три XOR на слово.
  const T0 = new Uint32Array(256), T1 = new Uint32Array(256),
        T2 = new Uint32Array(256), T3 = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const s = S[i];
    const s2 = ((s << 1) ^ (s & 0x80 ? 0x1B : 0)) & 0xFF;
    const t = ((s2 << 24) | (s << 16) | (s << 8) | (s2 ^ s)) >>> 0;
    T0[i] = t;
    T1[i] = ((t >>> 8) | (t << 24)) >>> 0;
    T2[i] = ((t >>> 16) | (t << 16)) >>> 0;
    T3[i] = ((t >>> 24) | (t << 8)) >>> 0;
  }

  const subWord = w =>
    (((S[(w >>> 24) & 255] << 24) | (S[(w >>> 16) & 255] << 16) |
      (S[(w >>> 8) & 255] << 8) | S[w & 255]) >>> 0);

  // Развёртка ключа. Длина ключа задаёт число раундов: 16 байт — 10,
  // 24 — 12, 32 — 14.
  function expandKey(key) {
    const nk = key.length >> 2, nr = nk + 6;
    const w = new Uint32Array(4 * (nr + 1));
    for (let i = 0; i < nk; i++) {
      w[i] = ((key[4 * i] << 24) | (key[4 * i + 1] << 16) |
              (key[4 * i + 2] << 8) | key[4 * i + 3]) >>> 0;
    }
    let rcon = 1;
    for (let i = nk; i < w.length; i++) {
      let t = w[i - 1];
      if (i % nk === 0) {
        t = subWord(((t << 8) | (t >>> 24)) >>> 0) ^ (rcon << 24);
        rcon = ((rcon << 1) ^ (rcon & 0x80 ? 0x1B : 0)) & 0xFF;
      } else if (nk > 6 && i % nk === 4) {
        t = subWord(t);
      }
      w[i] = (w[i - nk] ^ t) >>> 0;
    }
    return { w, nr };
  }

  // Гаммирование на месте: шифротекст в буфере становится открытым текстом.
  // Копия здесь была бы вторым таким же куском памяти на каждую запись.
  function ctrXor(rk, data) {
    const w = rk.w, nr = rk.nr, n = data.length;

    for (let p = 0, blk = 1; p < n; p += 16, blk++) {
      // Счётчик WinZip: номер блока младшим байтом вперёд, остальное нули.
      // Больше четырёх байт не нужно — записи ограничены сотнями мегабайт.
      let s0 = ((((blk & 255) << 24) | (((blk >>> 8) & 255) << 16) |
                 (((blk >>> 16) & 255) << 8) | ((blk >>> 24) & 255)) ^ w[0]) >>> 0;
      let s1 = w[1], s2 = w[2], s3 = w[3];

      let k = 4;
      for (let r = 1; r < nr; r++) {
        const a = T0[(s0 >>> 24) & 255] ^ T1[(s1 >>> 16) & 255] ^
                  T2[(s2 >>> 8) & 255] ^ T3[s3 & 255] ^ w[k];
        const b = T0[(s1 >>> 24) & 255] ^ T1[(s2 >>> 16) & 255] ^
                  T2[(s3 >>> 8) & 255] ^ T3[s0 & 255] ^ w[k + 1];
        const c = T0[(s2 >>> 24) & 255] ^ T1[(s3 >>> 16) & 255] ^
                  T2[(s0 >>> 8) & 255] ^ T3[s1 & 255] ^ w[k + 2];
        const d = T0[(s3 >>> 24) & 255] ^ T1[(s0 >>> 16) & 255] ^
                  T2[(s1 >>> 8) & 255] ^ T3[s2 & 255] ^ w[k + 3];
        s0 = a; s1 = b; s2 = c; s3 = d; k += 4;
      }

      // Последний раунд идёт без перемешивания столбцов — только подстановка
      const o0 = ((S[(s0 >>> 24) & 255] << 24) | (S[(s1 >>> 16) & 255] << 16) |
                  (S[(s2 >>> 8) & 255] << 8) | S[s3 & 255]) ^ w[k];
      const o1 = ((S[(s1 >>> 24) & 255] << 24) | (S[(s2 >>> 16) & 255] << 16) |
                  (S[(s3 >>> 8) & 255] << 8) | S[s0 & 255]) ^ w[k + 1];
      const o2 = ((S[(s2 >>> 24) & 255] << 24) | (S[(s3 >>> 16) & 255] << 16) |
                  (S[(s0 >>> 8) & 255] << 8) | S[s1 & 255]) ^ w[k + 2];
      const o3 = ((S[(s3 >>> 24) & 255] << 24) | (S[(s0 >>> 16) & 255] << 16) |
                  (S[(s1 >>> 8) & 255] << 8) | S[s2 & 255]) ^ w[k + 3];

      if (p + 16 <= n) {
        data[p]      ^= o0 >>> 24; data[p +  1] ^= o0 >>> 16;
        data[p +  2] ^= o0 >>> 8;  data[p +  3] ^= o0;
        data[p +  4] ^= o1 >>> 24; data[p +  5] ^= o1 >>> 16;
        data[p +  6] ^= o1 >>> 8;  data[p +  7] ^= o1;
        data[p +  8] ^= o2 >>> 24; data[p +  9] ^= o2 >>> 16;
        data[p + 10] ^= o2 >>> 8;  data[p + 11] ^= o2;
        data[p + 12] ^= o3 >>> 24; data[p + 13] ^= o3 >>> 16;
        data[p + 14] ^= o3 >>> 8;  data[p + 15] ^= o3;
      } else {
        const ks = [o0, o1, o2, o3];                 // хвост короче блока
        for (let i = 0; p + i < n; i++) {
          data[p + i] ^= ks[i >> 2] >>> (24 - 8 * (i & 3));
        }
      }
    }
  }

  // ------------------------------------------------------------ обвязка ZIP
  const SALT = [0, 8, 12, 16];        // длина соли по силе ключа 1/2/3
  const KEY  = [0, 16, 24, 32];       // и длина самого ключа

  // Дополнительное поле 0x9901: версия | «AE» | сила ключа | метод сжатия.
  // Возвращает null, если поля нет — значит, шифрование не наше (ZipCrypto
  // или чужое расширение), и такую запись читать мы не умеем.
  function info(extra) {
    for (let q = 0; q + 4 <= extra.length; ) {
      const id = extra[q] | (extra[q + 1] << 8);
      const len = extra[q + 2] | (extra[q + 3] << 8);
      if (id === 0x9901 && len >= 7 && q + 11 <= extra.length) {
        const strength = extra[q + 8];
        if (!KEY[strength]) return null;
        return { strength, method: extra[q + 9] | (extra[q + 10] << 8) };
      }
      q += 4 + len;
    }
    return null;
  }

  // Сколько байт от начала записи нужно, чтобы проверить пароль
  const headLen = strength => SALT[strength] + 2;

  // Есть ли чем считать PBKDF2. WebCrypto живёт только в защищённом
  // контексте: по https и на localhost есть, на file:// нет. Спрашивать
  // пароль там, где расшифровать всё равно нечем, — издевательство.
  const ready = () => !!(self.crypto && self.crypto.subtle);

  // Пароль импортируется один раз на архив, а PBKDF2 всё равно считается
  // заново на каждую запись: соль у них разная.
  async function key(password) {
    if (!self.crypto || !self.crypto.subtle) return null;   // не защищённый контекст
    try {
      return await crypto.subtle.importKey(
        'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    } catch (e) { return null; }
  }

  async function derive(salt, strength, pwKey) {
    const kl = KEY[strength];
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: 1000, hash: 'SHA-1' }, pwKey, (2 * kl + 2) * 8);
    return new Uint8Array(bits);
  }

  // Подходит ли пароль. Хватает начала записи — соли и двух байт проверки.
  async function check(head, strength, pwKey) {
    const sl = SALT[strength], kl = KEY[strength];
    if (!sl || !pwKey || head.length < sl + 2) return false;
    try {
      const kb = await derive(head.subarray(0, sl), strength, pwKey);
      return kb[2 * kl] === head[sl] && kb[2 * kl + 1] === head[sl + 1];
    } catch (e) { return false; }
  }

  // Расшифрованное содержимое записи (ещё сжатое) или null, если пароль
  // не тот. Исходный буфер не трогаем: он общий на всю пачку записей.
  async function open(raw, strength, pwKey) {
    const sl = SALT[strength], kl = KEY[strength];
    if (!sl || !pwKey || raw.length < sl + 12) return null;
    try {
      const kb = await derive(raw.subarray(0, sl), strength, pwKey);
      if (kb[2 * kl] !== raw[sl] || kb[2 * kl + 1] !== raw[sl + 1]) return null;
      const data = raw.slice(sl + 2, raw.length - 10);
      ctrXor(expandKey(kb.subarray(0, kl)), data);
      return data;
    } catch (e) { return null; }
  }

  return { info, headLen, ready, key, check, open };
})();
