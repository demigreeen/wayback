#!/usr/bin/env python3
"""Сборка компактного датасета городов для подписей локаций в анимации.

Источник: GeoNames cities15000 (CC BY 4.0) — требует указания авторства,
оно проставлено в подвале сайта.

Формат на выходе (site/js/cities.js) — строки с разделителями, без JSON:
    packed    — настоящие города: имя|ISO2|широта*100|долгота*100;...
    districts — районы городов в том же формате. Они НЕ участвуют в поиске
                ближайшего (иначе подпись «Sant Marti» вместо «Barcelona»),
                но нужны, чтобы узнать район в названии самой тренировки.
Целые координаты в сотых долях градуса дают точность ~1 км — с запасом
для сопоставления «в каком городе тренировался».

Запуск:  python tools/make_cities.py
"""

import io
import json
import re
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "site" / "js" / "cities.js"

CITIES_URL = "https://download.geonames.org/export/dump/cities15000.zip"
COUNTRY_URL = "https://download.geonames.org/export/dump/countryInfo.txt"

MIN_POP = 100_000

# Только настоящие населённые пункты. Всё остальное (PPLX — район города,
# PPLL — местность, PPLQ — заброшенное) даёт подписи вида «Ciutat Vella»
# вместо «Barcelona».
KEEP_FEATURES = {"PPL", "PPLA", "PPLA2", "PPLA3", "PPLA4", "PPLA5", "PPLC", "PPLG"}

# Названия стран по-русски для тех, что реально встретятся у бегунов.
# Для остальных остаётся английское название из GeoNames.
RU_COUNTRIES = {
    "RU": "Россия", "UA": "Украина", "BY": "Беларусь", "KZ": "Казахстан",
    "AM": "Армения", "GE": "Грузия", "AZ": "Азербайджан", "MD": "Молдова",
    "UZ": "Узбекистан", "KG": "Киргизия", "TJ": "Таджикистан",
    "DE": "Германия", "FR": "Франция", "ES": "Испания", "IT": "Италия",
    "PT": "Португалия", "GB": "Великобритания", "IE": "Ирландия",
    "NL": "Нидерланды", "BE": "Бельгия", "LU": "Люксембург",
    "CH": "Швейцария", "AT": "Австрия", "CZ": "Чехия", "SK": "Словакия",
    "PL": "Польша", "HU": "Венгрия", "RO": "Румыния", "BG": "Болгария",
    "GR": "Греция", "HR": "Хорватия", "SI": "Словения", "RS": "Сербия",
    "BA": "Босния и Герцеговина", "ME": "Черногория", "MK": "Северная Македония",
    "AL": "Албания", "SE": "Швеция", "NO": "Норвегия", "FI": "Финляндия",
    "DK": "Дания", "IS": "Исландия", "EE": "Эстония", "LV": "Латвия",
    "LT": "Литва", "CY": "Кипр", "MT": "Мальта",
    "TR": "Турция", "IL": "Израиль", "AE": "ОАЭ", "SA": "Саудовская Аравия",
    "EG": "Египет", "MA": "Марокко", "TN": "Тунис", "ZA": "ЮАР",
    "US": "США", "CA": "Канада", "MX": "Мексика", "BR": "Бразилия",
    "AR": "Аргентина", "CL": "Чили", "CO": "Колумбия", "PE": "Перу",
    "CN": "Китай", "JP": "Япония", "KR": "Южная Корея", "IN": "Индия",
    "TH": "Таиланд", "VN": "Вьетнам", "ID": "Индонезия", "MY": "Малайзия",
    "SG": "Сингапур", "PH": "Филиппины", "AU": "Австралия", "NZ": "Новая Зеландия",
}


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "WayBack/1.0"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return r.read()


def build() -> None:
    print("Скачиваем countryInfo.txt...")
    countries = {}
    for line in fetch(COUNTRY_URL).decode("utf-8").splitlines():
        if line.startswith("#") or not line.strip():
            continue
        p = line.split("\t")
        if len(p) > 4 and p[0]:
            countries[p[0]] = p[4]          # ISO2 -> английское название

    print("Скачиваем cities15000.zip...")
    raw = fetch(CITIES_URL)
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        text = z.read("cities15000.txt").decode("utf-8")

    rows = []
    districts = []
    for line in text.splitlines():
        p = line.split("\t")
        if len(p) < 15:
            continue
        try:
            pop = int(p[14])
            lat, lon = float(p[4]), float(p[5])
        except ValueError:
            continue
        if pop < MIN_POP:
            continue
        name, iso2, feature = p[1], p[8], p[7]
        if not name or not iso2 or "|" in name or ";" in name:
            continue
        # PPLX — это район города («Sant Marti», «Paris 18 Buttes-Montmartre»).
        # В поиске ближайшего они перебивают сам город, поэтому идут отдельно.
        if feature in KEEP_FEATURES:
            rows.append((pop, name, iso2, lat, lon))
        elif feature == "PPLX":
            districts.append((pop, name, iso2, lat, lon))

    # По убыванию населения: при равном расстоянии выигрывает крупный город
    rows.sort(key=lambda r: -r[0])
    districts.sort(key=lambda r: -r[0])
    pack = lambda rs: ";".join(
        f"{n}|{iso}|{round(lat * 100)}|{round(lon * 100)}"
        for _, n, iso, lat, lon in rs
    )
    packed = pack(rows)

    used = sorted({r[2] for r in rows})
    ru = {c: RU_COUNTRIES.get(c, countries.get(c, c)) for c in used}
    en = {c: countries.get(c, c) for c in used}

    js = (
        "/* WayBack — cities.js\n"
        "   Города для подписей локаций. Источник: GeoNames cities15000,\n"
        "   лицензия CC BY 4.0 — авторство указано в подвале сайта.\n"
        f"   Города с населением от {MIN_POP:,}. Координаты — в сотых долях\n"
        "   градуса (точность ~1 км, достаточно для определения города).\n"
        f"   Сгенерировано tools/make_cities.py. Городов: {len(rows)}, "
        f"районов: {len(districts)}.\n"
        "*/\n"
        "'use strict';\n\n"
        "const WBCities = {\n"
        f"  packed: {json.dumps(packed, ensure_ascii=False)},\n"
        f"  districts: {json.dumps(pack(districts), ensure_ascii=False)},\n"
        f"  ru: {json.dumps(ru, ensure_ascii=False)},\n"
        f"  en: {json.dumps(en, ensure_ascii=False)}\n"
        "};\n"
    )
    OUT.write_text(js, encoding="utf-8")
    print(f"Готово: {OUT.relative_to(ROOT)} — {len(rows)} городов, "
          f"{len(districts)} районов, {OUT.stat().st_size / 1024:.0f} КБ")


if __name__ == "__main__":
    build()
