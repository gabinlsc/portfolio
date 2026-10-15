#!/usr/bin/env python3
"""Fabrique un faux log nginx (format glsc_json) sur N jours, pour tester la sonde et l'admin en local.

  python3 make_fixture.py <fichier.log> [jours]
"""
import datetime as dt
import json
import random
import sys

random.seed(42)
out, days = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 30
HOSTS = [("glsc.fr", ["/", "/"]), ("cv.glsc.fr", ["/"]), ("share.glsc.fr", ["/"]), ("old.glsc.fr", ["/", "/GeoFrance/", "/pixelwar/"]),
         ("games.glsc.fr", ["/"]), ("status.glsc.fr", ["/"]), ("uno.glsc.fr", ["/"]), ("president.glsc.fr", ["/"])]
WEIGHTS = [30, 18, 9, 5, 10, 4, 7, 6]
REFS = ["", "", "", "https://www.linkedin.com/", "https://www.google.com/", "https://github.com/gabinlsc", "https://glsc.fr/",
        "https://www.welcometothejungle.com/", "https://duckduckgo.com/", "https://lnkd.in/x"]
UAS = ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36",
       "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
       "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36",
       "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15"]
BOTS = ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "curl/8.5.0", "python-requests/2.31"]
SCANS = ["/wp-login.php", "/.env", "/.git/config", "/phpmyadmin/", "/xmlrpc.php", "/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php", "/cgi-bin/luci"]
EVENTS = ["print", "email", "email_copy", "linkedin", "github", "project:Vortex", "project:UNO"]
LANGS = ["fr-FR,fr;q=0.9", "fr", "en-US,en;q=0.9", "fr-FR", "es-ES"]

now = dt.datetime.now(dt.timezone.utc)
lines = []
for d in range(days, -1, -1):
    for _ in range(random.randint(60, 160) + (days - d) * 2):
        t = now - dt.timedelta(days=d, seconds=random.randint(0, 86399 if d else int((now - now.replace(hour=0, minute=0, second=0)).total_seconds())))
        host, paths = random.choices(HOSTS, WEIGHTS)[0]
        ip = f"{random.choice([82, 90, 176, 37, 92])}.{random.randint(0, 255)}.{random.randint(0, 255)}.{random.randint(1, 254)}"
        ua = random.choice(UAS)
        rec = {"t": t.isoformat(timespec="seconds"), "h": host, "ip": ip, "s": 200, "m": "GET", "u": random.choice(paths),
               "b": random.randint(3000, 40000), "r": random.choice(REFS), "a": ua, "rt": round(random.random() / 10, 3), "l": random.choice(LANGS)}
        lines.append(rec)
        for asset in ("/_glsc/hub.css", "/_glsc/fonts/fredoka-latin-600-normal.woff2"):
            lines.append({**rec, "u": asset, "r": f"https://{host}/", "b": 9000})
        if host in ("cv.glsc.fr", "share.glsc.fr") and random.random() < 0.3:
            e = random.choice(EVENTS[:5] if host == "cv.glsc.fr" else EVENTS[5:])
            lines.append({**rec, "u": f"/_glsc/b.gif?e={e}", "b": 43})
    for _ in range(random.randint(20, 60)):
        t = now - dt.timedelta(days=d, seconds=random.randint(0, 80000 if d else 3000))
        lines.append({"t": t.isoformat(timespec="seconds"), "h": random.choice(["glsc.fr", "87.106.8.177", "cv.glsc.fr"]),
                      "ip": f"{random.choice([45, 185, 193, 141])}.{random.randint(0, 255)}.{random.randint(0, 255)}.{random.randint(1, 254)}",
                      "s": 404, "m": "GET", "u": random.choice(SCANS), "b": 150, "r": "", "a": random.choice(BOTS + ["Mozilla/5.0"]), "rt": 0.001, "l": ""})
    for _ in range(random.randint(2, 6)):
        t = now - dt.timedelta(days=d, seconds=random.randint(0, 80000 if d else 3000))
        lines.append({"t": t.isoformat(timespec="seconds"), "h": "glsc.fr", "ip": "82.64.1.2", "s": 404, "m": "GET",
                      "u": random.choice(["/cv.pdf", "/contact", "/blog"]), "b": 300, "r": "", "a": UAS[0], "rt": 0.002, "l": "fr"})

lines.sort(key=lambda r: r["t"])
with open(out, "w", encoding="utf-8") as f:
    for r in lines:
        f.write(json.dumps(r) + "\n")
print(f"{len(lines)} lignes → {out}")
