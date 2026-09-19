#!/usr/bin/env python3
"""tgfind — поиск публичных чатов Telegram по ключевым словам.

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


STATE_VERSION = 2


def load_state() -> dict:
    if not STATE.exists():
        return {"version": STATE_VERSION, "done_queries": [], "chats": {}, "resolved": []}
    state = json.loads(STATE.read_text(encoding="utf-8"))
    if state.get("version", 1) < 2:
        # Версия 1 сохраняла каналы как результат и не искала их чаты.
        # Каналы забываем, запросы повторяем — каналы найдутся снова и на этот
        # раз приведут к своим чатам. Проверенные чаты остаются: их не трогаем.
        state["chats"] = {k: v for k, v in state["chats"].items() if v.get("kind") != "канал"}
        state["done_queries"] = []
        state["version"] = STATE_VERSION
    return state


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
        self.via = {}            # id чата обсуждения -> имя канала, через который найден
        self.links_found = 0     # чатов, найденных через каналы
        self.private_linked = 0  # у подходящих каналов чат обсуждения закрытый

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
        key = str(ent.id)

        # Ссылки из описания — источник новых чатов: клубы ссылаются друг на друга
        for u in USERNAME_RE.findall(about):
            if u.lower() not in NOT_CHATS and u.lower() != name.lower():
                self.usernames.append(u)

        reasons = []
        if key in self.via:
            reasons.append(f"чат канала @{self.via[key]}")
        if self.kw_re.search(ent.title or ""):
            reasons.append("название")
        if self.kw_re.search(about):
            reasons.append("описание")

        if ent.broadcast:
            # Канал — не цель, а мост. Подходит он только по названию или
            # описанию: по счёту сообщений у большого канала «бег» найдётся
            # всегда, и через «похожие каналы» поиск уползал в случайные.
            if reasons:
                await self.bridge(ent, full, name)
        elif not reasons and members >= self.min_members:
            count = await self.count_messages(ent)
            if count > self.threshold:
                reasons.append(f"сообщения ({count})")

        return {
            "link": f"https://t.me/{name}",
            "title": ent.title or "",
            "kind": kind,
            "members": members,
            "match": ", ".join(reasons),
            "about": about.replace("\n", " ").strip(),
        }

    async def bridge(self, ent, full, name):
        """Подходящий канал: его чат обсуждения — в очередь, похожие каналы —
        тоже, но им самим снова придётся пройти по названию или описанию."""
        lid = getattr(full.full_chat, "linked_chat_id", None)
        if lid:
            linked = next((c for c in full.chats if c.id == lid), None)
            if linked is not None and public_name(linked):
                self.via.setdefault(str(linked.id), name)
                self.add(linked)
                self.links_found += 1
            else:
                # Закрытый чат обсуждения: ссылки нет, писать можно только
                # в комментариях под постами канала
                self.private_linked += 1
        rec = await self.call(functions.channels.GetChannelRecommendationsRequest(channel=ent))
        if rec:
            for ch in rec.chats:
                self.add(ch)

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
                # По порядку поступления, а не с конца: иначе «похожие» только
                # что проверенного канала шли первыми и поиск уходил вглубь,
                # не закончив с найденным по запросам
                key = next(iter(self.queue))
                ent = self.queue.pop(key)
                row = await self.check(ent)
                if row is None:
                    continue
                self.state["chats"][key] = row
                save_state(self.state)
                if row["kind"] == "канал":
                    # Канал в список не идёт — в журнале видно, зачем он был
                    if row["match"]:
                        print(f"   канал {row['members']:>7}  {row['link']}  {row['title'][:50]}  → ищем его чат")
                else:
                    mark = "+" if row["match"] else " "
                    print(f" {mark} чат   {row['members']:>7}  {row['link']}  {row['title'][:50]}"
                          + (f"  [{row['match']}]" if row["match"] else ""))
                await pause()
            await self.resolve_usernames()
            if self.resolve_left <= 0:
                self.usernames = []


LINKS_HTML = """<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Чаты Telegram</title>
<style>
:root { --bg:#fff; --fg:#1a1d24; --dim:#6b7280; --line:#e5e7eb; --link:#2563eb; --done:#9ca3af; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#16181d; --fg:#e8eaee; --dim:#9aa1ad; --line:#2a2e36; --link:#6ea8ff; --done:#5b6270; }
}
body { margin:0; background:var(--bg); color:var(--fg);
       font:15px/1.45 "Segoe UI", system-ui, sans-serif; }
main { max-width:860px; margin:0 auto; padding:24px 16px 48px; }
h1 { font-size:22px; margin:0 0 4px; }
.sub { color:var(--dim); margin:0 0 16px; }
input[type=search] { width:100%; box-sizing:border-box; padding:10px 12px; font:inherit;
       color:inherit; background:transparent; border:1px solid var(--line); border-radius:8px; }
ol { padding-left:0; list-style:none; margin:16px 0 0; }
li { display:flex; gap:12px; align-items:baseline; padding:9px 2px; border-bottom:1px solid var(--line); }
li input { flex:none; transform:translateY(2px); }
.n { flex:none; width:34px; color:var(--dim); text-align:right; font-variant-numeric:tabular-nums; }
.t { flex:1; min-width:0; }
.t a { color:var(--link); text-decoration:none; font-weight:600; overflow-wrap:anywhere; }
.t a:hover { text-decoration:underline; }
.m { color:var(--dim); font-size:13px; }
.c { flex:none; color:var(--dim); font-variant-numeric:tabular-nums; }
li.done .t a, li.done .c { color:var(--done); text-decoration:line-through; }
</style></head><body><main>
<h1>Чаты Telegram</h1>
<p class="sub">__COUNT__ · галочка «написал» запоминается в этом браузере</p>
<input type="search" id="q" placeholder="Найти по названию или ссылке">
<ol id="list">
__ROWS__
</ol>
</main>
<script>
const KEY = 'tgfind-done';
let done = {};
try { done = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) {}
for (const li of document.querySelectorAll('li')) {
  const box = li.querySelector('input'), id = li.dataset.id;
  box.checked = !!done[id]; li.classList.toggle('done', box.checked);
  box.addEventListener('change', () => {
    li.classList.toggle('done', box.checked);
    if (box.checked) done[id] = 1; else delete done[id];
    try { localStorage.setItem(KEY, JSON.stringify(done)); } catch (e) {}
  });
}
document.getElementById('q').addEventListener('input', e => {
  const q = e.target.value.trim().toLowerCase();
  for (const li of document.querySelectorAll('li'))
    li.hidden = q && !li.textContent.toLowerCase().includes(q);
});
</script></body></html>
"""


def write_html(rows: list[dict], name: str = "links.html", heading: str = "Чаты Telegram") -> None:
    """links.html — те же чаты кликабельным списком для браузера."""
    from html import escape
    items = []
    for i, r in enumerate(rows, 1):
        link = escape(r["link"], quote=True)
        members = f"{int(r['members']):,}".replace(",", " ")   # 15 069
        items.append(
            f'<li data-id="{link}"><input type="checkbox" title="написал">'
            f'<span class="n">{i}</span>'
            f'<span class="t"><a href="{link}" target="_blank" rel="noopener">'
            f'{escape(r["title"] or r["link"])}</a><br>'
            f'<span class="m">{escape(r["link"].replace("https://", ""))} · {escape(r["match"])}</span></span>'
            f'<span class="c">{members}</span></li>')
    page = (LINKS_HTML.replace("<title>Чаты Telegram</title>", f"<title>{escape(heading)}</title>")
                      .replace("<h1>Чаты Telegram</h1>", f"<h1>{escape(heading)}</h1>")
                      .replace("__COUNT__", f"{len(rows)} чатов")
                      .replace("__ROWS__", "\n".join(items)))
    (HERE / name).write_text(page, encoding="utf-8")


def write_results(state: dict, min_members: int) -> int:
    # Только чаты: каналы нужны лишь как путь к их чатам обсуждения
    rows = [r for r in state["chats"].values()
            if r["match"] and r["kind"] == "чат" and r["members"] >= min_members]
    rows.sort(key=lambda r: -r["members"])

    # utf-8-sig и точка с запятой — чтобы русский Excel открыл без мастера импорта
    with open(HERE / "results.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f, delimiter=";")
        w.writerow(["Ссылка", "Название", "Тип", "Участников", "Почему найден", "Описание"])
        for r in rows:
            w.writerow([r["link"], r["title"], r["kind"], r["members"], r["match"], r["about"][:300]])
    (HERE / "links.txt").write_text("\n".join(r["link"] for r in rows) + "\n", encoding="utf-8")
    write_html(rows)
    return len(rows)


async def run(queries, kw_words, cfg, threshold=5, min_members=20,
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
        print(f"\nЧерез каналы найдено чатов: {finder.links_found}. "
              f"У подходящих каналов закрытых чатов обсуждения: {finder.private_linked} "
              f"(в них пишут только в комментариях под постами).")
    except (KeyboardInterrupt, asyncio.CancelledError):
        print("\nОстановлено. Прогресс сохранён — следующий запуск продолжит.")
    finally:
        save_state(state)
        n = write_results(state, min_members)
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
    ap.add_argument("--max-resolve", type=int, default=60,
                    help="сколько ссылок из описаний открывать за запуск (по умолчанию 60)")
    ap.add_argument("--export-only", action="store_true",
                    help="не искать, только пересобрать results.csv из уже найденного")
    args = ap.parse_args()

    if args.export_only:
        n = write_results(load_state(), args.min_members)
        print(f"Готово: {n} в results.csv и links.txt")
        return

    queries = load_list(args.queries)
    kw_words = load_list(args.keywords)
    if not queries or not kw_words:
        sys.exit("queries.txt и keywords.txt не должны быть пустыми")

    await run(queries, kw_words, get_config(), args.threshold, args.min_members,
              args.max_resolve)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
