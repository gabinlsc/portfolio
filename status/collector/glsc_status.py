#!/usr/bin/env python3
"""glsc-status : sondes des services de glsc.fr pour status.glsc.fr.

Lancé chaque minute par un timer systemd. À chaque passage :
  1. sonde en parallèle chaque cible (HTTP/HTTPS ou port TCP) ;
  2. met à jour l'historique (dernières 24 h minute par minute, 90 jours en agrégats) ;
  3. ouvre ou ferme les incidents, et prévient Discord si un webhook est configuré ;
  4. écrit status.json (atomique) pour la page publique.

Aucune dépendance hors bibliothèque standard (Python 3.8+).
Même format de cibles que Serv-Pulse : {"webhook_url": "...", "targets": [{"name", "type": "http"|"tcp", ...}]}.
"""
import argparse
import json
import os
import shutil
import socket
import ssl
import tempfile
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

USER_AGENT = "glsc-status/1.0 (+https://status.glsc.fr)"
MINUTES_KEPT = 24 * 60
DAYS_KEPT = 90
INCIDENTS_KEPT = 50
FAILS_BEFORE_INCIDENT = 2   # 2 échecs d'affilée avant d'ouvrir un incident (évite les faux positifs)

UP, DEGRADED, DOWN = "up", "degraded", "down"


# ------------------------------------------------------------------ sondes
def cert_days_left(host, port=443, timeout=8):
    """Jours restants avant expiration du certificat TLS, ou None."""
    try:
        ctx = ssl.create_default_context()
        with socket.create_connection((host, port), timeout=timeout) as sock:
            with ctx.wrap_socket(sock, server_hostname=host) as tls:
                not_after = tls.getpeercert()["notAfter"]
        expires = ssl.cert_time_to_seconds(not_after)
        return int((expires - time.time()) // 86400)
    except Exception:
        return None


def probe_http(t):
    url = t["url"]
    timeout = t.get("timeout", 10)
    expect = t.get("expect_status", [200])
    if isinstance(expect, int):
        expect = [expect]
    start = time.monotonic()
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT}, method=t.get("method", "GET"))
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            resp.read(65536)
            code = resp.status
    except urllib.error.HTTPError as e:
        code = e.code
    except Exception as e:  # timeout, DNS, TLS, connexion refusée…
        return {"ok": False, "latency_ms": None, "detail": type(e).__name__}
    latency = int((time.monotonic() - start) * 1000)
    if code not in expect:
        return {"ok": False, "latency_ms": latency, "detail": "HTTP %d" % code}
    return {"ok": True, "latency_ms": latency, "detail": "HTTP %d" % code}


def probe_tcp(t):
    timeout = t.get("timeout", 5)
    start = time.monotonic()
    try:
        with socket.create_connection((t["host"], int(t["port"])), timeout=timeout):
            pass
    except Exception as e:
        return {"ok": False, "latency_ms": None, "detail": type(e).__name__}
    return {"ok": True, "latency_ms": int((time.monotonic() - start) * 1000), "detail": "port ouvert"}


def probe(t):
    result = probe_tcp(t) if t.get("type") == "tcp" else probe_http(t)
    slow = t.get("slow_ms", 1500)
    if not result["ok"]:
        result["state"] = DOWN
    elif result["latency_ms"] is not None and result["latency_ms"] > slow:
        result["state"] = DEGRADED
    else:
        result["state"] = UP
    if t.get("type", "http") == "http" and t["url"].startswith("https://") and t.get("check_cert", True):
        host = t["url"].split("/")[2].split(":")[0]
        result["cert_days"] = cert_days_left(host)
    return result


# ------------------------------------------------------------------ serveur
def server_metrics(disk_path="/"):
    m = {}
    try:
        with open("/proc/uptime") as f:
            m["uptime_s"] = int(float(f.read().split()[0]))
    except OSError:
        pass
    try:
        m["load"] = [round(x, 2) for x in os.getloadavg()]
        m["cpus"] = os.cpu_count()
    except OSError:
        pass
    try:
        info = {}
        with open("/proc/meminfo") as f:
            for line in f:
                k, v = line.split(":", 1)
                info[k] = int(v.split()[0])
        m["mem_pct"] = round(100 * (1 - info["MemAvailable"] / info["MemTotal"]), 1)
    except (OSError, KeyError, ValueError):
        pass
    try:
        du = shutil.disk_usage(disk_path)
        m["disk_pct"] = round(100 * du.used / du.total, 1)
    except OSError:
        pass
    return m


# ------------------------------------------------------------------ alertes
def discord(webhook, title, description, color):
    if not webhook:
        return
    payload = json.dumps({"embeds": [{
        "title": title, "description": description, "color": color,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "footer": {"text": "status.glsc.fr"},
    }]}).encode()
    try:
        req = urllib.request.Request(webhook, data=payload, method="POST",
                                     headers={"Content-Type": "application/json", "User-Agent": USER_AGENT})
        urllib.request.urlopen(req, timeout=10).read()
    except Exception:
        pass  # une alerte ratée ne doit jamais bloquer la page de statut


# ------------------------------------------------------------------ état
def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json_atomic(path, data):
    d = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".tmp-", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def day_key(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d")


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if ts else None


def update(state, targets, results, now, webhook):
    """Met à jour l'état persistant et renvoie la liste des services pour status.json."""
    services = state.setdefault("services", {})
    incidents = state.setdefault("incidents", [])
    out = []
    today = day_key(now)
    cutoff_days = sorted({day_key(now - i * 86400) for i in range(DAYS_KEPT)})

    for t, r in zip(targets, results):
        sid = t["id"]
        s = services.setdefault(sid, {"minutes": [], "days": {}, "fail_streak": 0, "open_incident": None})
        ok = r["state"] != DOWN

        s["minutes"].append([int(now), 1 if ok else 0, r["latency_ms"]])
        s["minutes"] = [x for x in s["minutes"] if x[0] > now - MINUTES_KEPT * 60]
        d = s["days"].setdefault(today, [0, 0])
        d[0] += 1 if ok else 0
        d[1] += 1
        s["days"] = {k: v for k, v in s["days"].items() if k >= cutoff_days[0]}

        # incidents
        if ok:
            if s["open_incident"] is not None:
                inc = next((i for i in incidents if i["id"] == s["open_incident"]), None)
                if inc:
                    inc["end"] = int(now)
                    discord(webhook, "✅ %s est de retour" % t["name"],
                            "Indisponible pendant %s." % human_duration(inc["end"] - inc["start"]), 0x22C55E)
                s["open_incident"] = None
            s["fail_streak"] = 0
        else:
            s["fail_streak"] += 1
            if s["fail_streak"] == FAILS_BEFORE_INCIDENT and s["open_incident"] is None:
                start = int(now) - (FAILS_BEFORE_INCIDENT - 1) * state.get("interval", 60)
                inc = {"id": "%s-%d" % (sid, start), "service": sid, "name": t["name"],
                       "start": start, "end": None, "detail": r["detail"]}
                incidents.append(inc)
                s["open_incident"] = inc["id"]
                discord(webhook, "🔴 %s est indisponible" % t["name"], "Erreur : %s" % r["detail"], 0xEF4444)

        mins = s["minutes"]
        lat = [x[2] for x in mins[-60:] if x[2] is not None]
        days = []
        for k in cutoff_days:
            v = s["days"].get(k)
            days.append(round(100 * v[0] / v[1], 2) if v and v[1] else None)
        tot = [v for k, v in s["days"].items() if k >= cutoff_days[-30]]
        up30 = sum(v[0] for v in tot) / max(1, sum(v[1] for v in tot))

        out.append({
            "id": sid, "name": t["name"], "group": t.get("group", "Services"),
            "link": t.get("link"), "description": t.get("description", ""),
            "state": r["state"], "detail": r["detail"], "latency_ms": r["latency_ms"],
            "avg_latency_ms": int(sum(lat) / len(lat)) if lat else None,
            "cert_days": r.get("cert_days"),
            "uptime_24h": round(100 * sum(x[1] for x in mins) / max(1, len(mins)), 2),
            "uptime_30d": round(100 * up30, 2),
            "days": days,
            "spark": [x[2] if x[1] else -1 for x in mins[-60:]],
        })

    # services retirés de la config : on oublie leur historique
    for sid in list(services):
        if sid not in {t["id"] for t in targets}:
            del services[sid]
    state["incidents"] = incidents[-INCIDENTS_KEPT:]
    return out


def human_duration(sec):
    sec = int(sec)
    if sec < 60:
        return "%d s" % sec
    if sec < 3600:
        return "%d min" % (sec // 60)
    h, m = divmod(sec // 60, 60)
    return "%d h %02d" % (h, m) if h < 24 else "%d j %d h" % (h // 24, h % 24)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("-c", "--config", default="/etc/glsc-status/targets.json")
    ap.add_argument("-s", "--state", default="/var/lib/glsc-status/state.json")
    ap.add_argument("-o", "--output", default="/var/www/status.glsc.fr/status.json")
    ap.add_argument("-w", "--webhook-file", default="/etc/glsc-status/discord-webhook",
                    help="fichier contenant l'URL du webhook Discord (hors dépôt, optionnel)")
    ap.add_argument("--interval", type=int, default=60, help="période du timer, en secondes")
    ap.add_argument("--now", type=float, help=argparse.SUPPRESS)  # pour les tests
    args = ap.parse_args()

    cfg = load_json(args.config, None)
    if not cfg or not cfg.get("targets"):
        raise SystemExit("Config introuvable ou vide : %s" % args.config)
    targets = cfg["targets"]
    for i, t in enumerate(targets):
        t.setdefault("id", t["name"].lower().replace(" ", "-") if "name" in t else "cible-%d" % i)

    now = args.now or time.time()
    with ThreadPoolExecutor(max_workers=min(16, len(targets))) as pool:
        results = list(pool.map(probe, targets))

    state = load_json(args.state, {})
    state["interval"] = args.interval
    webhook = cfg.get("webhook_url", "")
    try:
        with open(args.webhook_file, encoding="utf-8") as f:
            webhook = f.read().strip() or webhook
    except OSError:
        pass
    services = update(state, targets, results, now, webhook)
    write_json_atomic(args.state, state)

    downs = sum(1 for s in services if s["state"] == DOWN)
    slows = sum(1 for s in services if s["state"] == DEGRADED)
    overall = "down" if downs and downs == len(services) else ("partial" if downs else ("degraded" if slows else "up"))

    public_incidents = [
        {"name": i["name"], "service": i["service"], "start": iso(i["start"]), "end": iso(i["end"]),
         "duration_s": (i["end"] or int(now)) - i["start"], "detail": i.get("detail", "")}
        for i in reversed(state["incidents"])
    ][:15]

    write_json_atomic(args.output, {
        "generated_at": iso(now),
        "interval_s": args.interval,
        "overall": overall,
        "server": server_metrics(),
        "services": services,
        "incidents": public_incidents,
        "day_labels": sorted({day_key(now - i * 86400) for i in range(DAYS_KEPT)}),
    })


if __name__ == "__main__":
    main()
