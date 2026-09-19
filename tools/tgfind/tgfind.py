#!/usr/bin/env python3
"""tgfind — поиск публичных чатов и каналов Telegram по ключевым словам.

Что делает:
  1. Ищет по каждому запросу из queries.txt — как поиск в самом Telegram.
  2. Расширяет список: ссылки t.me и @упоминания из описаний найденных
     чатов, «похожие каналы», которые советует Telegram.
  3. Оставляет чат, если слово из keywords.txt есть в названии или
     описании либо встречалось в сообщениях больше THRESHOLD раз.
  4. Пишет results.csv (открывается в Excel) и links.txt.

Чего НЕ делает: не вступает в чаты, ничего не пишет, не собирает
участников. Только читает то, что видно любому без вступления.

Прогресс хранится в state.json: прерванный запуск продолжается с того же
места, повторный — проверяет только новое. Удалите state.json, чтобы
начать с нуля.

Запуск:  python tgfind.py            (подробности — README.md)
"""

import argparse
import asyncio
import csv
import json
import random
import re
import sys
from pathlib import Path

from telethon import TelegramClient, errors, functions, types

HERE = Path(__file__).resolve().parent
CONFIG = HERE / "config.json"
STATE = HERE / "state.json"
SESSION = HERE / "tgfind"          # tgfind.session — вход в аккаунт, никому не отдавать

# Русский и эмодзи в названиях: без явного UTF-8 вывод в файл или в чужую
# консоль Windows превращается в кракозябры или падает
# Под pythonw (окно без консоли) stdout нет вовсе — трогать нечего
if sys.stdout is not None and hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

USERNAME_RE = re.compile(r"(?:t\.me/|telegram\.me/|@)([A-Za-z][A-Za-z0-9_]{4,31})", re.I)
# Служебные адреса t.me, которые не являются чатами
NOT_CHATS = {"joinchat", "addstickers", "share", "proxy", "socks", "addlist", "boost", "iv"}


def load_list(path: Path) -> list[str]:
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            out.append(line)
    return out


def keyword_regex(words: list[str]) -> re.Pattern:
    # Слово ищется как начало слова: «бег» находит «бегуны» и «беговой»,
    # но не «побег». Поэтому в keywords.txt пишут основу слова.
    alt = "|".join(re.escape(w.lower()) for w in sorted(words, key=len, reverse=True))
    return re.compile(r"(?<![0-9a-zа-яё])(?:" + alt + ")", re.I)


def get_config() -> dict:
    if CONFIG.exists():
        return json.loads(CONFIG.read_text(encoding="utf-8"))
    print("Нужны api_id и api_hash — их выдают на https://my.telegram.org")
    print("(API development tools → создать приложение, название любое).")
    cfg = {"api_id": int(input("api_id: ").strip()),
           "api_hash": input("api_hash: ").strip()}
    CONFIG.write_text(json.dumps(cfg), encoding="utf-8")
    return cfg


def load_state() -> dict:
    if STATE.exists():
        return json.loads(STATE.read_text(encoding="utf-8"))
    return {"done_queries": [], "chats": {}, "resolved": []}


def save_state(state: dict) -> None:
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
    tmp.replace(STATE)


def public_name(ent) -> str | None:
    # Имя бывает не в username, а в списке usernames — у чатов, купивших
    # второе имя на Fragment. Берём первое действующее.
    if getattr(ent, "username", None):
        return ent.username
    for u in getattr(ent, "usernames", None) or []:
        if u.active:
            return u.username
    return None


async def pause(a=1.0, b=2.5):
    # Паузы между запросами: без них Telegram быстро отвечает FloodWait
    await asyncio.sleep(random.uniform(a, b))


class Finder:
    def __init__(self, client, state, kw_words, threshold, max_resolve, min_members):
        self.client = client
        self.state = state
        self.kw_words = kw_words
        self.kw_re = keyword_regex(kw_words)
        self.threshold = threshold
        self.min_members = min_members
        self.resolve_left = max_resolve
        self.queue = {}          # id -> entity, ещё не проверенные
        # Все, кто хоть раз попадал в очередь. Без этого канал, который
        # Telegram советует похожим на самого себя, проверялся бы дважды.
        self.seen = set(state["chats"])
        self.usernames = []      # найденные в описаниях, ещё не открытые

    async def call(self, request):
        """Запрос с переждать-и-повторить на FloodWait."""
        for _ in range(3):
            try:
                return await self.client(request)
            except errors.FloodWaitError as e:
                print(f"  Telegram просит паузу {e.seconds} с — ждём")
                await asyncio.sleep(e.seconds + 5)
            except errors.RPCError as e:
                # Чат закрыли, удалили или запретили — пропускаем его,
                # а не роняем весь запуск
                print(f"  пропущено: {e.__class__.__name__}")
                return None
        return None

    def add(self, ent):
        if not isinstance(ent, types.Channel) or not public_name(ent):
            return                              # без имени нет публичной ссылки
        key = str(ent.id)
        if key in self.seen:
            return
        self.seen.add(key)
        self.queue[key] = ent

    async def search(self, queries):
        done = set(self.state["done_queries"])
        todo = [q for q in queries if q not in done]
        for n, q in enumerate(todo, 1):
            res = await self.call(functions.contacts.SearchRequest(q=q, limit=100))
            before = len(self.queue)
            if res:
                for ch in res.chats:
                    self.add(ch)
            print(f"[поиск {n}/{len(todo)}] «{q}»: новых {len(self.queue) - before}")
            self.state["done_queries"].append(q)
            save_state(self.state)
            await pause()

    async def count_messages(self, ent) -> int:
        total = 0
        for w in self.kw_words:
            try:
                msgs = await self.client.get_messages(ent, search=w, limit=0)
            except errors.FloodWaitError as e:
                print(f"  Telegram просит паузу {e.seconds} с — ждём")
                await asyncio.sleep(e.seconds + 5)
                continue
            except (errors.ChannelPrivateError, errors.RPCError):
                return total
            total += msgs.total or 0
            if total > self.threshold:
                break                          # порог пройден — дальше незачем
            await pause(0.4, 1.0)
        return total

    async def check(self, ent):
        full = await self.call(functions.channels.GetFullChannelRequest(ent))
        if full is None:
            return None
        about = full.full_chat.about or ""
        members = full.full_chat.participants_count or 0
        kind = "канал" if ent.broadcast else "чат"
        name = public_name(ent)

        # Ссылки из описания — источник новых чатов: клубы ссылаются друг на друга
        for u in USERNAME_RE.findall(about):
            if u.lower() not in NOT_CHATS and u.lower() != name.lower():
                self.usernames.append(u)

        reasons = []
        if self.kw_re.search(ent.title or ""):
            reasons.append("название")
        if self.kw_re.search(about):
            reasons.append("описание")
        if not reasons and members >= self.min_members:
            count = await self.count_messages(ent)
            if count > self.threshold:
                reasons.append(f"сообщения ({count})")

        # «Похожие каналы» Telegram выдаёт только для каналов
        if reasons and ent.broadcast:
            rec = await self.call(functions.channels.GetChannelRecommendationsRequest(channel=ent))
            if rec:
                for ch in rec.chats:
                    self.add(ch)

        return {
            "link": f"https://t.me/{name}",
            "title": ent.title or "",
            "kind": kind,
            "members": members,
            "match": ", ".join(reasons),
            "about": about.replace("\n", " ").strip(),
        }

    async def resolve_usernames(self):
        seen = set(self.state["resolved"])
        batch = []
        for u in self.usernames:
            if u.lower() not in seen:
                seen.add(u.lower())
                batch.append(u)
        self.usernames = []
        for u in batch:
            # Открытие по имени Telegram ограничивает строже всего,
            # поэтому за запуск их не больше --max-resolve
            if self.resolve_left <= 0:
                return
            self.resolve_left -= 1
            try:
                self.add(await self.client.get_entity(u))
            except errors.FloodWaitError as e:
                print(f"  открытие по имени: пауза {e.seconds} с — оставим на следующий запуск")
                self.resolve_left = 0
                return
            except (ValueError, errors.RPCError):
                pass                           # не существует или это человек
            self.state["resolved"].append(u.lower())
            await pause()

    async def process_queue(self):
        while self.queue or self.usernames:
            while self.queue:
                key, ent = self.queue.popitem()
                row = await self.check(ent)
                if row is None:
                    continue
                self.state["chats"][key] = row
                save_state(self.state)
                mark = "+" if row["match"] else " "
                print(f" {mark} {row['kind']:5} {row['members']:>7}  {row['link']}  {row['title'][:50]}"
                      + (f"  [{row['match']}]" if row["match"] else ""))
                await pause()
            await self.resolve_usernames()
            if self.resolve_left <= 0:
                self.usernames = []


def write_results(state: dict, only: str | None, min_members: int) -> int:
    rows = [r for r in state["chats"].values() if r["match"] and r["members"] >= min_members]
    if only:
        rows = [r for r in rows if r["kind"] == only]
    # Сначала чаты, потом каналы; внутри — по числу участников
    rows.sort(key=lambda r: (r["kind"] != "чат", -r["members"]))

    # utf-8-sig и точка с запятой — чтобы русский Excel открыл без мастера импорта
    with open(HERE / "results.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f, delimiter=";")
        w.writerow(["Ссылка", "Название", "Тип", "Участников", "Почему найден", "Описание"])
        for r in rows:
            w.writerow([r["link"], r["title"], r["kind"], r["members"], r["match"], r["about"][:300]])
    (HERE / "links.txt").write_text("\n".join(r["link"] for r in rows) + "\n", encoding="utf-8")
    return len(rows)


async def run(queries, kw_words, cfg, threshold=5, min_members=20, only=None,
              max_resolve=60, phone=None, code_callback=None, password=None) -> int:
    """Один полный проход поиска. Общий для командной строки и окна.

    phone, code_callback, password — для входа из окна: без них Telethon
    спрашивает телефон и код в консоли.
    """
    client = TelegramClient(str(SESSION), cfg["api_id"], cfg["api_hash"])
    client.flood_sleep_threshold = 120      # короткие паузы Telethon выждет сам
    state = load_state()
    login = {k: v for k, v in (("phone", phone), ("code_callback", code_callback),
                               ("password", password)) if v}
    try:
        await client.start(**login)         # в первый раз — телефон и код
        finder = Finder(client, state, kw_words, threshold, max_resolve, min_members)
        await finder.search(queries)
        print(f"\nПроверяем чаты: {len(finder.queue)}. «+» — подходит.\n")
        await finder.process_queue()
    except (KeyboardInterrupt, asyncio.CancelledError):
        print("\nОстановлено. Прогресс сохранён — следующий запуск продолжит.")
    finally:
        save_state(state)
        n = write_results(state, only, min_members)
        print(f"\nПодходящих: {n}. Список — results.csv (Excel) и links.txt")
        await client.disconnect()
    return n


async def main():
    ap = argparse.ArgumentParser(description="Поиск публичных чатов Telegram по ключевым словам")
    ap.add_argument("--queries", default=HERE / "queries.txt", type=Path,
                    help="что вводить в поиск Telegram (по строке)")
    ap.add_argument("--keywords", default=HERE / "keywords.txt", type=Path,
                    help="основы слов, по которым чат считается подходящим")
    ap.add_argument("--threshold", type=int, default=5,
                    help="сколько сообщений со словами должно быть БОЛЬШЕ (по умолчанию 5)")
    ap.add_argument("--min-members", type=int, default=20,
                    help="меньше участников — в список не попадает (по умолчанию 20)")
    ap.add_argument("--only", choices=["чат", "канал"], help="оставить только чаты или только каналы")
    ap.add_argument("--max-resolve", type=int, default=60,
                    help="сколько ссылок из описаний открывать за запуск (по умолчанию 60)")
    ap.add_argument("--export-only", action="store_true",
                    help="не искать, только пересобрать results.csv из уже найденного")
    args = ap.parse_args()

    if args.export_only:
        n = write_results(load_state(), args.only, args.min_members)
        print(f"Готово: {n} в results.csv и links.txt")
        return

    queries = load_list(args.queries)
    kw_words = load_list(args.keywords)
    if not queries or not kw_words:
        sys.exit("queries.txt и keywords.txt не должны быть пустыми")

    await run(queries, kw_words, get_config(), args.threshold, args.min_members,
              args.only, args.max_resolve)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
