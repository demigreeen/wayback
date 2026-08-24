#!/usr/bin/env python3
"""Генератор тестовых архивов экспорта для проверки парсера WayBack.

Создаёт в site/_test/:
  strava_export.zip  — activities/*.gpx.gz, *.fit.gz, *.tcx.gz + activities.csv
  garmin_export.zip  — вложенный ZIP с FIT-файлами
  huawei_export.zip  — motion path detail data.json в формате HiTrack
  plain.gpx          — одиночный файл
  strava_big.zip     — 300 тренировок как в живой выгрузке (только с --big):
                       на мелких фикстурах не видна цена обращений к файлу
  stress_export.zip  — 2500 тренировок + 200 МБ мусора (только с --stress):
                       проверка потоковой распаковки и памяти

История умышленно «переездная»: Лион -> Париж -> Барселона. Так проверяется
и дальний перелёт камеры, и подписи локаций со сменой страны.

Запуск:  python tools/make_testdata.py
"""

import csv
import gzip
import json
import io
import math
import struct
import sys
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "site" / "_test"
FIT_EPOCH = datetime(1989, 12, 31, tzinfo=timezone.utc)


def loop(base_lat, base_lon, n=80, r=0.009, phase=0.0):
    """Замкнутый маршрут-петля вокруг точки."""
    pts = []
    for i in range(n + 1):
        a = phase + 2 * math.pi * i / n
        wob = 1 + 0.2 * math.sin(3 * a + phase)
        pts.append((base_lat + r * wob * math.sin(a),
                    base_lon + r * 1.7 * wob * math.cos(a)))
    return pts


# ----------------------------------------------------------------- GPX / TCX
def make_gpx(pts, start: datetime, name: str, step: int = 1) -> bytes:
    """GPX в том виде, в каком его отдаёт Strava.

    Высота, время и расширения с пульсом на каждой точке — не украшательство:
    именно из-за них файл часового занятия весит под мегабайт. На маленьких
    фикстурах разбор был мгновенным и в замер не попадал, а на настоящем
    архиве упирался в построение DOM.
    """
    rows = []
    for i, (lat, lon) in enumerate(pts):
        t = (start + timedelta(seconds=i * step)).strftime("%Y-%m-%dT%H:%M:%SZ")
        rows.append(
            '  <trkpt lat="%.7f" lon="%.7f">\n'
            "   <ele>%.1f</ele>\n"
            "   <time>%s</time>\n"
            "   <extensions><gpxtpx:TrackPointExtension>"
            "<gpxtpx:hr>%d</gpxtpx:hr><gpxtpx:cad>%d</gpxtpx:cad>"
            "</gpxtpx:TrackPointExtension></extensions>\n"
            "  </trkpt>"
            % (lat, lon, 144 + 8 * math.sin(i / 40), t, 120 + i % 40, 80 + i % 12))
    body = "\n".join(rows)
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="StravaGPX" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
 <metadata><time>{start.strftime('%Y-%m-%dT%H:%M:%SZ')}</time></metadata>
 <trk><name>{name}</name><type>running</type><trkseg>
{body}
 </trkseg></trk>
</gpx>""".encode("utf-8")


def make_tcx(pts, start: datetime, sport: str = "Biking") -> bytes:
    rows = []
    dist = 0.0
    for i, (lat, lon) in enumerate(pts):
        if i:
            dist += 3.2
        t = (start + timedelta(seconds=i)).strftime("%Y-%m-%dT%H:%M:%SZ")
        rows.append(
            f"<Trackpoint><Time>{t}</Time>"
            f"<Position><LatitudeDegrees>{lat:.6f}</LatitudeDegrees>"
            f"<LongitudeDegrees>{lon:.6f}</LongitudeDegrees></Position>"
            f"<DistanceMeters>{dist:.1f}</DistanceMeters></Trackpoint>")
    body = "\n".join(rows)
    st = start.strftime("%Y-%m-%dT%H:%M:%SZ")
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
 <Activities><Activity Sport="{sport}">
  <Id>{st}</Id>
  <Lap StartTime="{st}"><DistanceMeters>{dist:.1f}</DistanceMeters><Track>
{body}
  </Track></Lap>
 </Activity></Activities>
</TrainingCenterDatabase>""".encode("utf-8")


# ----------------------------------------------------------------- FIT
CRC_TABLE = [0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
             0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400]


def fit_crc(data: bytes) -> int:
    crc = 0
    for byte in data:
        for half in (byte & 0x0F, (byte >> 4) & 0x0F):
            tmp = CRC_TABLE[crc & 0x0F]
            crc = (crc >> 4) & 0x0FFF
            crc = crc ^ tmp ^ CRC_TABLE[half]
    return crc


def semicircles(deg: float) -> int:
    return int(deg * (2 ** 31) / 180)


def make_fit(pts, start: datetime, sport: int = 1, total_m: float = 8000.0) -> bytes:
    """Минимальный валидный FIT: file_id + record'ы + session."""
    ts0 = int((start - FIT_EPOCH).total_seconds())
    body = io.BytesIO()

    # --- определение file_id (local 0, global 0): time_created (uint32)
    body.write(bytes([0x40, 0x00, 0x00]))
    body.write(struct.pack("<H", 0))          # global msg num 0
    body.write(bytes([1]))                    # 1 поле
    body.write(bytes([4, 4, 0x86]))           # field 4, size 4, uint32
    body.write(bytes([0x00]))                 # данные local 0
    body.write(struct.pack("<I", ts0))

    # --- определение record (local 1, global 20): timestamp, lat, lon
    body.write(bytes([0x41, 0x00, 0x00]))
    body.write(struct.pack("<H", 20))
    body.write(bytes([3]))
    body.write(bytes([253, 4, 0x86]))         # timestamp uint32
    body.write(bytes([0, 4, 0x85]))           # position_lat sint32
    body.write(bytes([1, 4, 0x85]))           # position_long sint32
    for i, (lat, lon) in enumerate(pts):
        body.write(bytes([0x01]))
        body.write(struct.pack("<Iii", ts0 + i * 8, semicircles(lat), semicircles(lon)))

    # --- определение session (local 2, global 18): sport, total_distance
    body.write(bytes([0x42, 0x00, 0x00]))
    body.write(struct.pack("<H", 18))
    body.write(bytes([2]))
    body.write(bytes([5, 1, 0x00]))           # sport enum
    body.write(bytes([9, 4, 0x86]))           # total_distance uint32 (см)
    body.write(bytes([0x02]))
    body.write(bytes([sport]))
    body.write(struct.pack("<I", int(total_m * 100)))

    data = body.getvalue()
    header = struct.pack("<BBHI4s", 14, 0x20, 2140, len(data), b".FIT")
    header += struct.pack("<H", fit_crc(header))
    full = header + data
    return full + struct.pack("<H", fit_crc(data))



# ----------------------------------------------------------------- Huawei
def make_huawei(activities) -> bytes:
    """motion path detail data.json: внутри attribute — текст формата HiTrack."""
    out = []
    for pts, start, sport in activities:
        lines = []
        ts0 = int(start.timestamp())
        for k, (lat, lon) in enumerate(pts):
            lines.append(f"tp=lbs;k={k};lat={lat:.6f};lon={lon:.6f};"
                         f"alt=100.0;t={ts0 + k * 8}")
        # Huawei помечает остановку заведомо невозможными координатами
        lines.append(f"tp=lbs;k={len(pts)};lat=90.0;lon=-80.0;alt=0.0;t=0")
        detail = chr(10).join(lines)
        simplify = json.dumps({"totalDistance": 8000})
        out.append({
            "sportType": sport,
            "startTime": int(start.timestamp() * 1000),
            "totalTime": len(pts) * 8000,
            "timeZone": "+0200",
            "attribute": f"HW_EXT_TRACK_DETAIL@is{detail}"
                         f"&&HW_EXT_TRACK_SIMPLIFY@is{simplify}",
        })
    return json.dumps(out, ensure_ascii=False).encode("utf-8")

# ----------------------------------------------------------------- сборка
# Переезд: два города одной страны, затем другая страна
LYON = (45.7640, 4.8357)
PARIS = (48.8566, 2.3522)
BARCELONA = (41.3874, 2.1686)


def build():
    OUT.mkdir(parents=True, exist_ok=True)

    # ---------- Strava bulk export ----------
    rows = [["Activity ID", "Activity Date", "Activity Name",
             "Activity Type", "Elapsed Time", "Distance", "Filename"]]
    day = datetime(2021, 4, 12, 7, 30, tzinfo=timezone.utc)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for i in range(30):
            day += timedelta(days=3 + i % 4)
            city = LYON if i < 12 else (PARIS if i < 22 else BARCELONA)
            # Трекер пишет точку раз в секунду: занятие от четверти часа
            # до полутора. Скорость разбора архива Strava определяется
            # объёмом точек, а не числом файлов.
            pts = loop(city[0] + (i % 5) * 0.004, city[1] + (i % 3) * 0.006,
                       n=900 + (i % 5) * 700, phase=i * 0.7)
            aid = 4000000000 + i
            if i % 3 == 0:
                raw, ext, sport = make_gpx(pts, day, f"Run {i}"), "gpx", "Run"
            elif i % 3 == 1:
                raw, ext, sport = make_fit(pts, day), "fit", "Run"
            else:
                raw, ext, sport = make_tcx(pts, day), "tcx", "Ride"
            fname = f"activities/{aid}.{ext}.gz"
            z.writestr(fname, gzip.compress(raw))
            rows.append([str(aid), day.strftime("%b %d, %Y, %I:%M:%S %p"),
                         f"Тренировка {i}", sport, str(len(pts)), "8.0", fname])
        sio = io.StringIO()
        csv.writer(sio, lineterminator="\n").writerows(rows)
        z.writestr("activities.csv", sio.getvalue())
        z.writestr("profile.json", '{"note":"должен быть проигнорирован"}')
    (OUT / "strava_export.zip").write_bytes(buf.getvalue())

    # ---------- Garmin GDPR: ZIP внутри ZIP ----------
    inner = io.BytesIO()
    day = datetime(2022, 6, 1, 6, 0, tzinfo=timezone.utc)
    with zipfile.ZipFile(inner, "w", zipfile.ZIP_DEFLATED) as z:
        for i in range(10):
            day += timedelta(days=5)
            pts = loop(PARIS[0] - i * 0.003, PARIS[1] + i * 0.005, phase=i)
            z.writestr(f"{day:%Y-%m-%d}_{i}_ACTIVITY.fit", make_fit(pts, day))
    outer = io.BytesIO()
    with zipfile.ZipFile(outer, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("DI_CONNECT/DI-Connect-Fitness-Uploaded-Files/UploadedFiles_0-Part1.zip",
                   inner.getvalue())
        z.writestr("DI_CONNECT/DI-Connect-User/user_profile.json", "{}")
    (OUT / "garmin_export.zip").write_bytes(outer.getvalue())

    # ---------- Huawei Health ----------
    acts = []
    day = datetime(2023, 2, 4, 18, 0, tzinfo=timezone.utc)
    for i in range(8):
        day += timedelta(days=4)
        city = BARCELONA if i < 5 else LYON
        acts.append((loop(city[0] + i * 0.002, city[1] - i * 0.003, n=40, phase=i * 1.3),
                     day, 4 if i % 3 else 5))          # 4 = бег, 5 = ходьба
    hw = io.BytesIO()
    with zipfile.ZipFile(hw, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("data/Motion path detail data & description/"
                   "motion path detail data.json", make_huawei(acts))
        z.writestr("data/Motion path detail data & description/description.txt",
                   "field descriptions")
    (OUT / "huawei_export.zip").write_bytes(hw.getvalue())

    # ---------- одиночный GPX ----------
    (OUT / "plain.gpx").write_bytes(
        make_gpx(loop(*BARCELONA), datetime(2023, 9, 3, 8, 0, tzinfo=timezone.utc), "Одиночный"))

    if "--stress" in sys.argv:
        build_stress()

    for f in sorted(OUT.iterdir()):
        print(f"{f.name:22} {f.stat().st_size:>9,} байт")


def build_big(count: int = 300) -> None:
    """Архив Strava размером с настоящий: 300 тренировок по 900-3500 точек.

    Ровно этот случай разбирался на телефоне две-три минуты. Мелкие фикстуры
    такое не ловят: узкое место было не в объёме данных, а в числе обращений
    к файлу, а оно растёт с числом записей в архиве.

    ZIP_STORED намеренно: настоящая Strava не сжимает повторно уже сжатые
    .gz, и распределение смещений в архиве должно быть таким же.
    """
    rows = [["Activity ID", "Activity Date", "Activity Name",
             "Activity Type", "Elapsed Time", "Distance", "Filename"]]
    day = datetime(2019, 1, 6, 7, 30, tzinfo=timezone.utc)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
        for i in range(count):
            day += timedelta(days=2 + i % 3)
            city = LYON if i < count * 0.37 else (PARIS if i < count * 0.73 else BARCELONA)
            pts = loop(city[0] + (i % 7) * 0.003, city[1] + (i % 5) * 0.004,
                       n=900 + (i % 6) * 520, phase=i * 0.41)
            aid = 5000000000 + i
            if i % 3 == 2:
                raw, ext, sport = make_tcx(pts, day), "tcx", "Ride"
            else:
                raw, ext, sport = make_gpx(pts, day, f"Пробежка {i}"), "gpx", "Run"
            fname = f"activities/{aid}.{ext}.gz"
            z.writestr(fname, gzip.compress(raw, 6))
            rows.append([str(aid), day.strftime("%b %d, %Y, %I:%M:%S %p"),
                         f"Тренировка {i}", sport, str(len(pts)), "8.0", fname])
        sio = io.StringIO()
        csv.writer(sio, lineterminator="\n").writerows(rows)
        z.writestr("activities.csv", sio.getvalue())
    (OUT / "strava_big.zip").write_bytes(buf.getvalue())


def build_stress(count: int = 2500) -> None:
    """Архив как у активного пользователя с многолетней историей.

    Внутри намеренно лежит огромный нерелевантный JSON: Garmin кладёт в
    выгрузку сотни мегабайт данных сна и шагов. Парсер обязан проскочить
    его потоком, ни разу не распаковав, иначе вкладка ляжет по памяти.
    """
    inner = io.BytesIO()
    day = datetime(2019, 1, 5, 7, 0, tzinfo=timezone.utc)
    with zipfile.ZipFile(inner, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as z:
        for i in range(count):
            day += timedelta(days=1)
            c = LYON if i < count * 0.36 else (PARIS if i < count * 0.72 else BARCELONA)
            pts = loop(c[0] + (i % 40) * 0.001, c[1] + (i % 30) * 0.0015,
                       n=30, phase=i * 0.37)
            z.writestr(f"{day:%Y-%m-%d}_{i}_ACTIVITY.fit", make_fit(pts, day))

    junk = b'{"sleep":[' + b"0" * 200_000_000 + b"]}"
    outer = io.BytesIO()
    with zipfile.ZipFile(outer, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as z:
        z.writestr("DI_CONNECT/DI-Connect-Aggregator/huge_sleep_data.json", junk)
        z.writestr("DI_CONNECT/DI-Connect-Fitness-Uploaded-Files/UploadedFiles_0-Part1.zip",
                   inner.getvalue())
    (OUT / "stress_export.zip").write_bytes(outer.getvalue())


if __name__ == "__main__":
    build()
    if "--big" in sys.argv:
        build_big()
    if "--stress" in sys.argv:
        build_stress()
