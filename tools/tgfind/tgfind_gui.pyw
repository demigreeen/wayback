#!/usr/bin/env python3
"""Окно для tgfind: ключи API, телефон, слова и настройки — без консоли.

Запуск: двойной щелчок по этому файлу (расширение .pyw — без чёрного окна)
или  python tgfind_gui.pyw

Всё, что введено в окне, сохраняется рядом: слова — в queries.txt и
keywords.txt, ключи и телефон — в config.json. Сам поиск — тот же, что
в командной строке (tgfind.run), окно только собирает данные и
показывает журнал.
"""

import asyncio
import contextlib
import json
import os
import queue
import threading
import tkinter as tk
from tkinter import messagebox, simpledialog, ttk
from tkinter.scrolledtext import ScrolledText

import tgfind

ONLY = {"Чаты и каналы": None, "Только чаты": "чат", "Только каналы": "канал"}


class LogWriter:
    """stdout рабочего потока → очередь → журнал в окне."""
    def __init__(self, q):
        self.q = q

    def write(self, s):
        if s:
            self.q.put(s)

    def flush(self):
        pass


class App:
    def __init__(self, root):
        self.root = root
        self.log_q = queue.Queue()
        self.loop = None
        self.task = None
        self.worker = None

        root.title("Поиск чатов Telegram")
        root.geometry("900x720")
        root.minsize(720, 560)
        pad = {"padx": 8, "pady": 4}

        # ---------- доступ к Telegram
        acc = ttk.LabelFrame(root, text="Доступ к Telegram")
        acc.pack(fill="x", **pad)
        self.api_id = tk.StringVar()
        self.api_hash = tk.StringVar()
        self.phone = tk.StringVar()
        for col, (label, var, show) in enumerate([
                ("api_id", self.api_id, None),
                ("api_hash", self.api_hash, "•"),
                ("Телефон (+7…)", self.phone, None)]):
            ttk.Label(acc, text=label).grid(row=0, column=col * 2, sticky="w", padx=(8, 4), pady=6)
            e = ttk.Entry(acc, textvariable=var, width=24 if col != 1 else 34)
            if show:
                e.configure(show=show)
            e.grid(row=0, column=col * 2 + 1, sticky="w", padx=(0, 8))
        ttk.Label(acc, foreground="#666",
                  text="Ключи — на my.telegram.org → API development tools. "
                       "Код подтверждения окно спросит само при первом входе."
                  ).grid(row=1, column=0, columnspan=6, sticky="w", padx=8, pady=(0, 6))

        # ---------- слова
        words = ttk.Frame(root)
        words.pack(fill="both", expand=True, **pad)
        words.columnconfigure(0, weight=1)
        words.columnconfigure(1, weight=1)
        words.rowconfigure(2, weight=1)

        ttk.Label(words, text="Что искать в поиске Telegram",
                  font=("Segoe UI", 10, "bold")).grid(row=0, column=0, sticky="w")
        ttk.Label(words, text="Слова, по которым чат подходит",
                  font=("Segoe UI", 10, "bold")).grid(row=0, column=1, sticky="w", padx=(12, 0))
        ttk.Label(words, foreground="#666", wraplength=400, justify="left",
                  text="По запросу на строку, как в строке поиска Telegram. "
                       "Добавляйте города: «бег казань» находит местные клубы."
                  ).grid(row=1, column=0, sticky="w")
        ttk.Label(words, foreground="#666", wraplength=400, justify="left",
                  text="Основа слова на строку: «бег» найдёт «бегуны» и «беговой». "
                       "Чат подходит, если слово есть в названии, описании "
                       "или часто встречается в сообщениях."
                  ).grid(row=1, column=1, sticky="w", padx=(12, 0))
        self.queries = ScrolledText(words, height=12, width=40, font=("Segoe UI", 10), undo=True)
        self.keywords = ScrolledText(words, height=12, width=40, font=("Segoe UI", 10), undo=True)
        self.queries.grid(row=2, column=0, sticky="nsew", pady=(4, 0))
        self.keywords.grid(row=2, column=1, sticky="nsew", padx=(12, 0), pady=(4, 0))

        # ---------- настройки
        opts = ttk.Frame(root)
        opts.pack(fill="x", **pad)
        self.threshold = tk.IntVar(value=5)
        self.min_members = tk.IntVar(value=20)
        self.only = tk.StringVar(value="Чаты и каналы")
        ttk.Label(opts, text="Слова в сообщениях больше").pack(side="left")
        ttk.Spinbox(opts, from_=0, to=1000, width=5, textvariable=self.threshold).pack(side="left", padx=4)
        ttk.Label(opts, text="раз").pack(side="left", padx=(0, 16))
        ttk.Label(opts, text="Участников не меньше").pack(side="left")
        ttk.Spinbox(opts, from_=0, to=1000000, increment=10, width=7,
                    textvariable=self.min_members).pack(side="left", padx=(4, 16))
        ttk.Combobox(opts, values=list(ONLY), textvariable=self.only, state="readonly",
                     width=16).pack(side="left")

        # ---------- кнопки
        btns = ttk.Frame(root)
        btns.pack(fill="x", **pad)
        self.start_btn = ttk.Button(btns, text="▶ Начать поиск", command=self.start)
        self.stop_btn = ttk.Button(btns, text="■ Остановить", command=self.stop, state="disabled")
        self.start_btn.pack(side="left")
        self.stop_btn.pack(side="left", padx=6)
        ttk.Button(btns, text="Открыть таблицу", command=self.open_results).pack(side="left", padx=(18, 0))
        ttk.Button(btns, text="Открыть папку", command=lambda: os.startfile(tgfind.HERE)).pack(side="left", padx=6)
        ttk.Button(btns, text="Начать заново", command=self.reset).pack(side="right")

        # ---------- журнал
        self.log = ScrolledText(root, height=12, font=("Consolas", 9), state="disabled",
                                background="#fafafa")
        self.log.pack(fill="both", expand=True, **pad)
        self.status = ttk.Label(root, text="Готово к запуску", foreground="#444")
        self.status.pack(fill="x", padx=10, pady=(0, 8))

        self.load()
        root.protocol("WM_DELETE_WINDOW", self.on_close)
        root.after(100, self.pump_log)

    # ------------------------------------------------ данные
    def load(self):
        if tgfind.CONFIG.exists():
            cfg = json.loads(tgfind.CONFIG.read_text(encoding="utf-8"))
            self.api_id.set(str(cfg.get("api_id", "")))
            self.api_hash.set(cfg.get("api_hash", ""))
            self.phone.set(cfg.get("phone", ""))
        for box, path in ((self.queries, tgfind.HERE / "queries.txt"),
                          (self.keywords, tgfind.HERE / "keywords.txt")):
            box.insert("1.0", "\n".join(tgfind.load_list(path)))

    @staticmethod
    def lines(box):
        return [l.strip() for l in box.get("1.0", "end").splitlines() if l.strip()]

    def save(self):
        """Проверить введённое и сохранить. None — если чего-то не хватает."""
        api_id, api_hash, phone = self.api_id.get().strip(), self.api_hash.get().strip(), self.phone.get().strip()
        if not api_id.isdigit():
            messagebox.showwarning("Не хватает данных", "api_id — это число с my.telegram.org")
            return None
        if len(api_hash) != 32:
            messagebox.showwarning("Не хватает данных", "api_hash — строка ровно из 32 символов")
            return None
        queries, keywords = self.lines(self.queries), self.lines(self.keywords)
        if not queries or not keywords:
            messagebox.showwarning("Не хватает данных", "Заполните оба списка слов")
            return None
        try:
            threshold, min_members = int(self.threshold.get()), int(self.min_members.get())
        except (tk.TclError, ValueError):
            messagebox.showwarning("Не хватает данных", "В настройках нужны целые числа")
            return None

        cfg = {"api_id": int(api_id), "api_hash": api_hash, "phone": phone}
        tgfind.CONFIG.write_text(json.dumps(cfg), encoding="utf-8")
        (tgfind.HERE / "queries.txt").write_text("\n".join(queries) + "\n", encoding="utf-8")
        (tgfind.HERE / "keywords.txt").write_text("\n".join(keywords) + "\n", encoding="utf-8")
        return dict(queries=queries, kw_words=keywords, cfg=cfg, threshold=threshold,
                    min_members=min_members, only=ONLY[self.only.get()])

    # ------------------------------------------------ вопросы из рабочего потока
    def ask(self, prompt, secret=False):
        """Спросить в окне и вернуть ответ в рабочий поток (он ждёт).

        К окну из рабочего потока обращаться нельзя — Tkinter этого не
        переносит. Вопрос уходит через ту же очередь, что и журнал,
        а диалог открывает pump_log в потоке окна.
        """
        done, box = threading.Event(), {}
        self.log_q.put(("ask", prompt, secret, done, box))
        done.wait()
        return (box.get("v") or "").strip()

    # ------------------------------------------------ запуск и остановка
    def start(self):
        params = self.save()
        if not params:
            return
        if not params["cfg"]["phone"] and not (tgfind.HERE / "tgfind.session").exists():
            messagebox.showwarning("Не хватает данных", "Для первого входа нужен номер телефона")
            return
        self.set_running(True)
        self.write_log("\n=== Запуск ===\n")
        self.worker = threading.Thread(target=self.work, args=(params,), daemon=True)
        self.worker.start()

    def work(self, params):
        async def go():
            self.task = asyncio.current_task()
            return await tgfind.run(
                params["queries"], params["kw_words"], params["cfg"],
                threshold=params["threshold"], min_members=params["min_members"],
                only=params["only"], phone=params["cfg"]["phone"] or None,
                code_callback=lambda: self.ask("Код из Telegram:"),
                password=lambda: self.ask("Пароль двухэтапной проверки:", secret=True))

        with contextlib.redirect_stdout(LogWriter(self.log_q)):
            self.loop = asyncio.new_event_loop()
            try:
                self.loop.run_until_complete(go())
                self.log_q.put(("done", "Готово — нажмите «Открыть таблицу»"))
            except Exception as e:
                self.log_q.put(f"\nОшибка: {e}\n")
                self.log_q.put(("done", f"Ошибка: {e}"))
            except BaseException:
                # Остановка до входа в аккаунт прилетает сюда отменой
                self.log_q.put(("done", "Остановлено"))
            finally:
                self.loop.close()
                self.loop = self.task = None

    def stop(self):
        if self.loop and self.task:
            self.status.configure(text="Останавливаем — сохраняем найденное…")
            self.loop.call_soon_threadsafe(self.task.cancel)

    def set_running(self, running):
        self.start_btn.configure(state="disabled" if running else "normal")
        self.stop_btn.configure(state="normal" if running else "disabled")
        self.status.configure(text="Идёт поиск… Окно можно свернуть." if running else "Готово к запуску")

    # ------------------------------------------------ журнал
    def write_log(self, text):
        self.log.configure(state="normal")
        self.log.insert("end", text)
        self.log.see("end")
        self.log.configure(state="disabled")

    def pump_log(self):
        try:
            while True:
                item = self.log_q.get_nowait()
                if isinstance(item, str):
                    self.write_log(item)
                elif item[0] == "ask":
                    _, prompt, secret, done, box = item
                    kw = {"show": "•"} if secret else {}
                    box["v"] = simpledialog.askstring("Вход в Telegram", prompt,
                                                      parent=self.root, **kw)
                    done.set()
                else:                           # ("done", текст статуса)
                    self.set_running(False)
                    self.status.configure(text=item[1])
        except queue.Empty:
            pass
        self.root.after(100, self.pump_log)

    # ------------------------------------------------ прочее
    def open_results(self):
        path = tgfind.HERE / "results.csv"
        if path.exists():
            os.startfile(path)
        else:
            messagebox.showinfo("Таблицы пока нет", "Она появится после первого поиска")

    def reset(self):
        if self.loop:
            messagebox.showinfo("Идёт поиск", "Сначала остановите поиск")
            return
        if not messagebox.askyesno(
                "Начать заново",
                "Забыть, какие запросы и чаты уже проверены, и искать всё с нуля?\n\n"
                "Нужно, если вы поменяли слова, по которым чат подходит: "
                "старые чаты иначе не перепроверяются. Вход в Telegram сохранится."):
            return
        for name in ("state.json", "results.csv", "links.txt"):
            with contextlib.suppress(FileNotFoundError):
                (tgfind.HERE / name).unlink()
        self.write_log("\nПрогресс сброшен — следующий поиск начнётся с нуля.\n")

    def on_close(self):
        if self.loop and not messagebox.askyesno(
                "Идёт поиск", "Остановить поиск и закрыть? Найденное сохранено."):
            return
        self.stop()
        self.root.after(300, self.root.destroy)


def main():
    root = tk.Tk()
    with contextlib.suppress(tk.TclError):
        ttk.Style().theme_use("vista")
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
