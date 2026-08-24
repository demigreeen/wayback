#!/usr/bin/env python3
"""Сборка архива облачной функции для Yandex Cloud.

Существует ради двух ошибок, которые легко сделать руками.

Первая: архивировать нужно СОДЕРЖИМОЕ папки функции, а не саму папку.
Если внутри архива окажется каталог issue-license, Yandex Cloud не найдёт
index.js и функция упадёт на первом же вызове.

Вторая, куда коварнее: Compress-Archive в Windows PowerShell 5.1 пишет
пути через обратный слэш. Формат ZIP требует прямой, и на Linux — а облако
работает на нём — такой архив разворачивается в плоский набор файлов
с именами вроде «node_modules\\nodemailer\\index.js». Функция падает
на require, причём ошибка выглядит так, будто зависимостей нет вовсе.
Python пишет пути правильно.

Запуск из корня проекта:
    python tools/build_function.py
"""

import io
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "functions" / "issue-license"
OUT = ROOT / "build"
ZIP = OUT / "issue-license.zip"

# В архив не должно попадать ничего лишнего: облако считает размер,
# а лишние файлы только запутывают при разборе проблем.
SKIP_DIRS = {".git", ".cache", "build"}
SKIP_FILES = {".DS_Store", "issue-license.zip"}


def run_npm() -> None:
    print("Ставлю зависимости…")
    npm = shutil.which("npm") or shutil.which("npm.cmd")
    if not npm:
        sys.exit("Не нашёл npm. Установите Node.js и повторите.")
    res = subprocess.run([npm, "install", "--omit=dev", "--no-audit", "--no-fund"],
                         cwd=SRC)
    if res.returncode != 0:
        sys.exit("npm install завершился с ошибкой")
    if not (SRC / "node_modules").is_dir():
        sys.exit("node_modules не появились — без них функция не запустится")


def build() -> int:
    OUT.mkdir(exist_ok=True)
    if ZIP.exists():
        ZIP.unlink()

    count = 0
    with zipfile.ZipFile(ZIP, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for folder, dirs, files in os.walk(SRC):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
            for name in files:
                if name in SKIP_FILES:
                    continue
                full = Path(folder) / name
                # as_posix даёт прямые слэши на любой системе — то самое,
                # ради чего эта сборка не на PowerShell
                arc = full.relative_to(SRC).as_posix()
                z.write(full, arc)
                count += 1
    return count


def verify() -> None:
    with zipfile.ZipFile(ZIP) as z:
        names = z.namelist()
    problems = []
    if "index.js" not in names:
        problems.append("index.js не в корне архива — Yandex Cloud его не найдёт")
    if not any(n.startswith("node_modules/") for n in names):
        problems.append("нет node_modules — функция упадёт на require")
    if not any(n == "node_modules/nodemailer/package.json" for n in names):
        problems.append("не вижу nodemailer внутри node_modules")
    back = [n for n in names if "\\" in n]
    if back:
        problems.append("в путях обратные слэши: %s" % back[:3])
    if problems:
        sys.exit("Архив собран неправильно:\n  - " + "\n  - ".join(problems))


def main() -> None:
    if not SRC.is_dir():
        sys.exit("Не нашёл папку функции: %s" % SRC)
    run_npm()
    print("Собираю архив…")
    count = build()
    verify()
    size = ZIP.stat().st_size / 1048576
    print("")
    print("Готово.")
    print("  Файл:   %s" % ZIP)
    print("  Размер: %.2f МБ" % size)
    print("  Файлов: %d" % count)
    print("  index.js в корне, пути прямыми слэшами — проверено")
    print("")
    print("Дальше: консоль Yandex Cloud -> функция issue-license -> Редактор ->")
    print("источник кода ZIP-архив -> загрузить этот файл -> Сохранить изменения.")


if __name__ == "__main__":
    main()
