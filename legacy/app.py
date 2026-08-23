#!/usr/bin/env python3
"""
app.py — графическое приложение «Карта пробежек Garmin».

Никакой консоли: кнопка установки библиотек, поля для логина,
две кнопки — выгрузить пробежки и собрать/открыть анимацию.

Запуск:  двойной клик по run.bat (Windows)  или  python app.py
"""

from __future__ import annotations

import importlib
import importlib.util
import json
import os
import queue
import subprocess
import sys
import threading
import webbrowser
from pathlib import Path

try:
    import tkinter as tk
    from tkinter import messagebox, simpledialog, ttk
except ImportError:
    print("В вашей сборке Python нет tkinter (обычно бывает только в Linux).")
    print("Поставьте пакет python3-tk или пользуйтесь консольными скриптами:")
    print("  python fetch_runs.py   затем   python build_animation.py")
    sys.exit(1)

SCRIPT_DIR = Path(__file__).resolve().parent
CONFIG_FILE = SCRIPT_DIR / "app_config.json"
RUNS_FILE = SCRIPT_DIR / "runs.json"

BG = "#12151c"
PANEL = "#1a1f2a"
ACCENT = "#ff5a36"
TEXT = "#f2f2f0"
DIM = "#9aa0ad"
OK = "#57d98a"


def deps_installed() -> bool:
    return (importlib.util.find_spec("garminconnect") is not None
            and importlib.util.find_spec("curl_cffi") is not None)


# Известные пути современных браузеров на Windows. Открываем файл напрямую
# в первом найденном — иначе Windows может отдать HTML в Internet Explorer,
# который не умеет ни современный JS, ни запись видео.
BROWSER_CANDIDATES = [
    (r"%ProgramFiles%\Google\Chrome\Application\chrome.exe", "Chrome"),
    (r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe", "Chrome"),
    (r"%LocalAppData%\Google\Chrome\Application\chrome.exe", "Chrome"),
    (r"%LocalAppData%\Yandex\YandexBrowser\Application\browser.exe", "Яндекс Браузер"),
    (r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe", "Edge"),
    (r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe", "Edge"),
    (r"%ProgramFiles%\Mozilla Firefox\firefox.exe", "Firefox"),
    (r"%ProgramFiles%\Opera\opera.exe", "Opera"),
    (r"%LocalAppData%\Programs\Opera\opera.exe", "Opera"),
]


def open_html(path: Path) -> str:
    """Открывает HTML в современном браузере. Возвращает имя браузера."""
    if sys.platform == "win32":
        for raw, name in BROWSER_CANDIDATES:
            exe = os.path.expandvars(raw)
            if Path(exe).is_file():
                subprocess.Popen([exe, str(path)])
                return name
        os.startfile(str(path))  # системная ассоциация — крайний случай
        return "браузер по умолчанию"
    webbrowser.open(path.as_uri())
    return "браузер по умолчанию"


class App:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.busy = False
        self.log_queue: queue.Queue[str] = queue.Queue()

        root.title("Карта пробежек Garmin")
        root.geometry("620x640")
        root.minsize(560, 560)
        root.configure(bg=BG)

        self._build_ui()
        self._load_config()
        self._poll_log()
        self._refresh_state()

    # ------------------------------------------------------------------ UI

    def _build_ui(self):
        pad = {"padx": 16, "pady": 6}

        header = tk.Label(self.root, text="Карта пробежек Garmin",
                          font=("Segoe UI", 16, "bold"), fg=TEXT, bg=BG)
        header.pack(anchor="w", padx=16, pady=(14, 0))
        sub = tk.Label(self.root,
                       text="Точки старта всех беговых тренировок → анимация на карте",
                       font=("Segoe UI", 10), fg=DIM, bg=BG)
        sub.pack(anchor="w", padx=16, pady=(0, 8))

        # --- Шаг 0. Библиотеки ---
        dep_frame = tk.Frame(self.root, bg=PANEL)
        dep_frame.pack(fill="x", **pad)
        self.dep_label = tk.Label(dep_frame, text="Проверка библиотек...",
                                  font=("Segoe UI", 10), fg=TEXT, bg=PANEL)
        self.dep_label.pack(side="left", padx=12, pady=10)
        self.dep_btn = tk.Button(dep_frame, text="Установить",
                                 command=self.install_deps,
                                 bg=ACCENT, fg=BG, relief="flat",
                                 font=("Segoe UI", 10, "bold"),
                                 activebackground="#ff7a54", cursor="hand2")
        self.dep_btn.pack(side="right", padx=12, pady=8)

        # --- Шаг 1. Аккаунт ---
        acc_frame = tk.LabelFrame(self.root, text=" 1. Аккаунт Garmin Connect ",
                                  font=("Segoe UI", 10, "bold"),
                                  fg=TEXT, bg=PANEL, bd=0,
                                  labelanchor="nw")
        acc_frame.pack(fill="x", **pad)

        tk.Label(acc_frame, text="Email:", font=("Segoe UI", 10),
                 fg=DIM, bg=PANEL).grid(row=0, column=0, sticky="w",
                                        padx=12, pady=(10, 4))
        self.email_var = tk.StringVar()
        self.email_entry = tk.Entry(acc_frame, textvariable=self.email_var,
                                    font=("Segoe UI", 11), bg="#232936",
                                    fg=TEXT, insertbackground=TEXT, relief="flat")
        self.email_entry.grid(row=0, column=1, sticky="ew", padx=(0, 12),
                              pady=(10, 4), ipady=4)

        tk.Label(acc_frame, text="Пароль:", font=("Segoe UI", 10),
                 fg=DIM, bg=PANEL).grid(row=1, column=0, sticky="w",
                                        padx=12, pady=4)
        self.password_var = tk.StringVar()
        self.password_entry = tk.Entry(acc_frame, textvariable=self.password_var,
                                       show="•", font=("Segoe UI", 11),
                                       bg="#232936", fg=TEXT,
                                       insertbackground=TEXT, relief="flat")
        self.password_entry.grid(row=1, column=1, sticky="ew", padx=(0, 12),
                                 pady=4, ipady=4)

        hint = tk.Label(acc_frame,
                        text="После первого входа сессия запоминается — дальше поля можно оставлять пустыми.\n"
                             "Пароль никуда не сохраняется и уходит только на серверы Garmin.",
                        font=("Segoe UI", 8), fg=DIM, bg=PANEL, justify="left")
        hint.grid(row=2, column=0, columnspan=2, sticky="w", padx=12, pady=(2, 10))
        acc_frame.columnconfigure(1, weight=1)

        # --- Шаг 2-3. Кнопки действий ---
        btn_frame = tk.Frame(self.root, bg=BG)
        btn_frame.pack(fill="x", **pad)

        self.fetch_btn = tk.Button(btn_frame, text="2. Выгрузить пробежки из Garmin",
                                   command=self.fetch_runs,
                                   bg=ACCENT, fg=BG, relief="flat",
                                   font=("Segoe UI", 11, "bold"),
                                   activebackground="#ff7a54", cursor="hand2",
                                   pady=8)
        self.fetch_btn.pack(fill="x", pady=(0, 6))

        self.build_btn = tk.Button(btn_frame, text="3. Собрать анимацию и открыть в браузере",
                                   command=self.build_and_open,
                                   bg="#2a3140", fg=TEXT, relief="flat",
                                   font=("Segoe UI", 11, "bold"),
                                   activebackground="#39424f", cursor="hand2",
                                   pady=8)
        self.build_btn.pack(fill="x")

        # --- Журнал ---
        log_frame = tk.LabelFrame(self.root, text=" Журнал ",
                                  font=("Segoe UI", 9), fg=DIM, bg=BG, bd=0)
        log_frame.pack(fill="both", expand=True, padx=16, pady=(6, 12))
        self.log_text = tk.Text(log_frame, height=10, bg="#0d1017", fg="#c8cdd8",
                                font=("Consolas", 9), relief="flat", wrap="word",
                                state="disabled")
        self.log_text.pack(fill="both", expand=True, padx=2, pady=2)

        self.status_var = tk.StringVar(value="")
        tk.Label(self.root, textvariable=self.status_var, font=("Segoe UI", 9),
                 fg=DIM, bg=BG, anchor="w").pack(fill="x", padx=16, pady=(0, 8))

    # ------------------------------------------------------------- helpers

    def log(self, msg: str):
        self.log_queue.put(str(msg))

    def _poll_log(self):
        try:
            while True:
                msg = self.log_queue.get_nowait()
                self.log_text.configure(state="normal")
                self.log_text.insert("end", msg + "\n")
                self.log_text.see("end")
                self.log_text.configure(state="disabled")
        except queue.Empty:
            pass
        self.root.after(120, self._poll_log)

    def _refresh_state(self):
        if deps_installed():
            self.dep_label.configure(text="✓ Библиотеки установлены", fg=OK)
            self.dep_btn.configure(state="disabled", bg="#2a3140", fg=DIM,
                                   text="Готово")
        else:
            self.dep_label.configure(text="Нужно установить библиотеки Garmin",
                                     fg=TEXT)
            self.dep_btn.configure(state="normal", bg=ACCENT, fg=BG,
                                   text="Установить")

        has_runs = RUNS_FILE.exists()
        n = 0
        if has_runs:
            try:
                n = len(json.loads(RUNS_FILE.read_text(encoding="utf-8")))
            except Exception:
                pass
        if has_runs and n:
            self.build_btn.configure(bg=ACCENT, fg=BG)
            self.status_var.set(f"В базе {n} пробежек — можно собирать анимацию "
                                f"или дозагрузить свежие.")
        else:
            self.status_var.set("Начните с выгрузки пробежек (кнопка 2).")

    def _set_busy(self, busy: bool):
        self.busy = busy
        state = "disabled" if busy else "normal"
        self.fetch_btn.configure(state=state)
        self.build_btn.configure(state=state)
        if not busy:
            self._refresh_state()

    def _run_in_thread(self, target):
        if self.busy:
            return
        self._set_busy(True)

        def wrapper():
            try:
                target()
            except Exception as exc:  # noqa: BLE001 — показываем пользователю
                self.log(f"ОШИБКА: {exc}")
                self.root.after(0, lambda: messagebox.showerror(
                    "Ошибка", str(exc), parent=self.root))
            finally:
                self.root.after(0, lambda: self._set_busy(False))

        threading.Thread(target=wrapper, daemon=True).start()

    def _load_config(self):
        try:
            cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            self.email_var.set(cfg.get("email", ""))
        except Exception:
            pass

    def _save_config(self):
        try:
            CONFIG_FILE.write_text(
                json.dumps({"email": self.email_var.get().strip()},
                           ensure_ascii=False),
                encoding="utf-8")
        except Exception:
            pass

    def ask_mfa(self) -> str:
        """Вызывается из рабочего потока: показывает диалог в главном потоке."""
        result: dict[str, str | None] = {}
        done = threading.Event()

        def ask():
            result["code"] = simpledialog.askstring(
                "Подтверждение Garmin",
                "Garmin прислал код подтверждения\n(на почту или в приложение).\n\nВведите код:",
                parent=self.root)
            done.set()

        self.root.after(0, ask)
        done.wait()
        return (result.get("code") or "").strip()

    # ------------------------------------------------------------- actions

    def install_deps(self):
        def job():
            self.log("Устанавливаю библиотеки (pip)...")
            cmd = [sys.executable, "-m", "pip", "install", "-r",
                   str(SCRIPT_DIR / "requirements.txt")]
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, text=True)
            assert proc.stdout is not None
            for line in proc.stdout:
                line = line.strip()
                if line:
                    self.log("  " + line)
            proc.wait()
            importlib.invalidate_caches()
            if proc.returncode == 0 and deps_installed():
                self.log("✓ Библиотеки установлены.")
            else:
                raise RuntimeError(
                    "Установка не удалась — посмотрите журнал выше.")

        self._run_in_thread(job)

    def fetch_runs(self):
        if not deps_installed():
            messagebox.showwarning(
                "Библиотеки", "Сначала установите библиотеки (кнопка сверху).",
                parent=self.root)
            return

        email = self.email_var.get().strip() or None
        password = self.password_var.get() or None
        self._save_config()

        def job():
            import fetch_runs
            self.log("— — —")
            added, total = fetch_runs.fetch_and_save(
                email, password, mfa_callback=self.ask_mfa, log=self.log)
            self.log(f"✓ Готово: добавлено {added}, всего в базе {total} пробежек.")
            # пароль в поле больше не нужен
            self.root.after(0, lambda: self.password_var.set(""))

        self._run_in_thread(job)

    def build_and_open(self):
        if not RUNS_FILE.exists():
            messagebox.showwarning(
                "Нет данных", "Сначала выгрузите пробежки (кнопка 2).",
                parent=self.root)
            return

        def job():
            import build_animation
            self.log("— — —")
            out = build_animation.build(log=self.log)
            browser = open_html(out)
            self.log(f"Открываю в браузере ({browser})...")
            self.log(f"Файл: {out}")
            self.log("Кнопка «🎬 Видео» на странице запишет анимацию в файл mp4/webm.")

        self._run_in_thread(job)


def bind_clipboard_hotkeys(root: tk.Tk):
    """Ctrl+V / Ctrl+C / Ctrl+X / Ctrl+A в полях ввода на любой раскладке.

    tkinter привязывает буфер обмена к латинским keysym, поэтому на русской
    раскладке Ctrl+V «не работает». Ловим по keycode — он не зависит от
    раскладки (Windows: V=86, C=67, X=88, A=65).
    """
    def handler(event):
        if not (event.state & 0x4):          # без Ctrl — не наше
            return None
        if event.keysym.lower() in ("v", "c", "x", "a"):
            return None                       # латинская раскладка — tkinter справился сам
        widget = event.widget
        if not isinstance(widget, tk.Entry):
            return None
        action = {86: "<<Paste>>", 67: "<<Copy>>",
                  88: "<<Cut>>", 65: "<<SelectAll>>"}.get(event.keycode)
        if not action:
            return None
        try:
            if action == "<<Paste>>":
                # заменяем выделенное, как в обычных программах
                if widget.selection_present():
                    widget.delete("sel.first", "sel.last")
            widget.event_generate(action)
        except tk.TclError:
            pass
        return "break"

    root.bind_all("<KeyPress>", handler, add="+")


def main():
    root = tk.Tk()
    bind_clipboard_hotkeys(root)
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
