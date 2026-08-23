#!/usr/bin/env python3
"""
fetch_runs.py

Логика выгрузки из Garmin Connect точек СТАРТА беговых тренировок
(широта/долгота + дата). Результат сохраняется/дополняется в runs.json
рядом со скриптом.

Можно использовать двумя способами:
  1) Через графическое приложение:  python app.py  (рекомендуется)
  2) Из консоли напрямую:           python fetch_runs.py

Запускать можно многократно — активности не дублируются (дедуп по
activityId), так что скрипт безопасно перезапускать позже, чтобы
подтянуть новые пробежки.
"""

from __future__ import annotations

import getpass
import json
import os
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
OUTPUT_FILE = SCRIPT_DIR / "runs.json"
TOKEN_DIR = str(Path.home() / ".garminconnect")

# Ключевые слова в activityType.typeKey, которые Garmin использует для
# всех разновидностей бега (обычный бег, трейл, беговая дорожка,
# на дорожке стадиона, виртуальный забег и т.д.)
RUNNING_TYPE_MARKERS = ("running", "run")

# Сколько активностей запрашивать за один вызов API
PAGE_SIZE = 100


# ---------------------------------------------------------------------------
# Основная логика (используется и консолью, и графическим приложением)
# ---------------------------------------------------------------------------

def login(email: str | None, password: str | None, mfa_callback=None, log=print):
    """Авторизация в Garmin Connect.

    Если email/пароль не переданы — пробуем войти по сохранённым токенам
    из прошлого успешного входа (~/.garminconnect).
    """
    from garminconnect import Garmin  # импорт здесь, чтобы GUI мог сначала поставить пакет

    if mfa_callback is None:
        mfa_callback = lambda: input("Код двухфакторной аутентификации (MFA): ").strip()

    if email and password:
        client = Garmin(email, password, prompt_mfa=mfa_callback)
        log("Авторизация по логину и паролю...")
        client.login(TOKEN_DIR)
        log("Вход выполнен. Токены сохранены — в следующий раз пароль, "
            "скорее всего, не понадобится.")
        return client

    # Пытаемся войти по сохранённым токенам
    log("Логин/пароль не указаны — пробую войти по сохранённой сессии...")
    try:
        client = Garmin()
        client.login(TOKEN_DIR)
        log("Вход по сохранённой сессии выполнен.")
        return client
    except Exception as exc:
        raise RuntimeError(
            "Не получилось войти по сохранённой сессии. "
            "Укажите email и пароль от Garmin Connect."
        ) from exc


def is_running_activity(activity: dict) -> bool:
    type_key = (activity.get("activityType") or {}).get("typeKey", "") or ""
    type_key = type_key.lower()
    return any(marker in type_key for marker in RUNNING_TYPE_MARKERS)


def fetch_all_activities(client, log=print) -> list[dict]:
    """Постранично выгружает вообще все активности аккаунта."""
    all_activities: list[dict] = []
    start = 0
    while True:
        log(f"  запрашиваю активности {start}–{start + PAGE_SIZE}...")
        page = client.get_activities(start, PAGE_SIZE)
        if not page:
            break
        all_activities.extend(page)
        if len(page) < PAGE_SIZE:
            break
        start += PAGE_SIZE
    return all_activities


def extract_run_points(activities: list[dict], log=print) -> list[dict]:
    points = []
    skipped_no_gps = 0
    for activity in activities:
        if not is_running_activity(activity):
            continue

        lat = activity.get("startLatitude")
        lon = activity.get("startLongitude")
        if lat is None or lon is None:
            # Например, тренировка на беговой дорожке / без GPS
            skipped_no_gps += 1
            continue

        start_local = activity.get("startTimeLocal", "")  # "YYYY-MM-DD HH:MM:SS"
        date_only = start_local.split(" ")[0] if start_local else ""

        points.append(
            {
                "activityId": activity.get("activityId"),
                "name": activity.get("activityName", ""),
                "type": (activity.get("activityType") or {}).get("typeKey", ""),
                "date": date_only,
                "datetime": start_local,
                "lat": lat,
                "lon": lon,
                "distance_km": round((activity.get("distance") or 0) / 1000, 2),
                "duration_min": round((activity.get("duration") or 0) / 60, 1),
            }
        )

    if skipped_no_gps:
        log(f"  пропущено без GPS-координат (например, беговая дорожка): {skipped_no_gps}")

    return points


def load_existing() -> dict[int, dict]:
    if not OUTPUT_FILE.exists():
        return {}
    try:
        data = json.loads(OUTPUT_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}
    return {r["activityId"]: r for r in data if r.get("activityId") is not None}


def fetch_and_save(
    email: str | None = None,
    password: str | None = None,
    mfa_callback=None,
    log=print,
) -> tuple[int, int]:
    """Полный цикл: вход → выгрузка → фильтрация → сохранение в runs.json.

    Возвращает (сколько точек добавлено, сколько всего точек в файле).
    """
    client = login(email, password, mfa_callback=mfa_callback, log=log)

    log("Выгружаю список активностей (для большой истории может занять "
        "минуту-другую)...")
    activities = fetch_all_activities(client, log=log)
    log(f"Всего активностей в аккаунте: {len(activities)}")

    new_points = extract_run_points(activities, log=log)
    log(f"Из них беговых тренировок с GPS-стартом: {len(new_points)}")

    existing = load_existing()
    before = len(existing)
    for p in new_points:
        existing[p["activityId"]] = p

    merged = sorted(existing.values(), key=lambda r: r["datetime"])
    OUTPUT_FILE.write_text(
        json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    added = len(existing) - before
    log(f"Сохранено в {OUTPUT_FILE.name}: новых точек {added}, всего {len(merged)}.")
    return added, len(merged)


# ---------------------------------------------------------------------------
# Консольный запуск
# ---------------------------------------------------------------------------

def main() -> None:
    try:
        import garminconnect  # noqa: F401
    except ImportError:
        sys.exit(
            "Не найдена библиотека garminconnect.\n"
            "Установите зависимости: pip install -r requirements.txt\n"
            "Или запустите графическое приложение: python app.py"
        )

    email = os.getenv("EMAIL")
    password = os.getenv("PASSWORD")
    if not (email and password):
        print("=== Вход в Garmin Connect ===")
        print("(оставьте поля пустыми, чтобы попробовать войти по сохранённой сессии)")
        email = input("Email: ").strip() or None
        password = getpass.getpass("Пароль (не отображается при вводе): ") or None

    fetch_and_save(email, password)
    print("\nТеперь запустите: python build_animation.py")


if __name__ == "__main__":
    main()
