#!/usr/bin/env python3
"""
glsc-admin-collect — sonde root de admin.glsc.fr (aucune dépendance hors Python 3).

  collect   (chaque minute, glsc-admin-collect.timer)
    1. lit les nouvelles lignes du log nginx JSON (/var/log/nginx/glsc-access.log) → table requests ;
    2. mesure le serveur (CPU, mémoire, disque, services, certificats, processus) → health.json + table health ;
    3. état des conteneurs de jeux et joueurs connectés → docker.json + table games ;
       résultats des parties (/var/lib/glsc-games/<jeu>/results.jsonl) → table results + classements ;
    4. tentatives SSH (journald) et fail2ban → table ssh + security.json ;
    5. GitHub (toutes les 15 min) et sauvegardes/versions (toutes les 10 min) → github.json, deploys.json ;
    6. envoie les alertes Discord (si un webhook est réglé dans l'admin) ;
    7. publie une copie figée de la base (metrics.db) lisible par www-data.
  queue     (déclenché par glsc-admin-queue.path dès qu'un fichier arrive)
    traite les demandes de l'admin : message Discord, redémarrage d'un jeu (liste blanche).
  recap     (commande glsc-recap, ou bouton de l'admin via la file d'attente)
    envoie tout de suite le récap Discord des 7 derniers jours (--semaine : semaine dernière ; --apercu : sans envoyer).
    Le récap de la semaine écoulée part aussi tout seul le lundi à 9 h (collect).
  deploy    (déclenché par glsc-deploy.path : push sur main ou bouton de l'admin)
    télécharge le dépôt et lance les scripts de déploiement prévus pour la cible (liste blanche),
    publie l'historique (deploy-runs.json), les journaux (deploy-logs/) et prévient sur Discord.

L'admin web (www-data) ne fait que LIRE ce qui est publié ; elle n'a aucun droit sur Docker ni sur les logs.
"""
import argparse
import datetime as dt
import glob
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Europe/Paris")
GAMES = {  # service compose → (nom affiché, port local, domaine)
    "uno": ("UNO", 3101, "uno.glsc.fr"),
    "president": ("Le Président", 3102, "president.glsc.fr"),
    "vortex": ("Vortex", 3103, "vortex.glsc.fr"),
}
SERVICES = [  # unité systemd → libellé
    ("nginx.service", "Serveur web (nginx)"), ("php-fpm", "PHP"), ("docker.service", "Docker"),
    ("ssh.service", "SSH"), ("fail2ban.service", "fail2ban"), ("cron.service", "Tâches planifiées (cron)"),
    ("certbot.timer", "Renouvellement HTTPS (certbot)"), ("glsc-status.timer", "Sonde status.glsc.fr"),
    ("glsc-admin-collect.timer", "Sonde de l'admin"),
]
STATIC_EXT = re.compile(r"\.(css|js|mjs|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|json|xml|txt|webmanifest|mp4|webm|pdf|zip)$", re.I)
BOT_UA = re.compile(r"bot|crawl|spider|slurp|curl|wget|python|httpclient|preview|facebookexternalhit|discord|whatsapp|go-http|okhttp|java/|libwww|scan|headless|zgrab|masscan|nmap|nuclei|httpx", re.I)
SCAN_PATH = re.compile(
    r"(wp-(login|admin|content|includes|json)|xmlrpc\.php|/\.env|/\.git|/\.aws|/\.ssh|/\.svn|/\.DS_Store|phpmyadmin|/pma/|/myadmin|"
    r"cgi-bin|/vendor/phpunit|eval-stdin|/actuator|/boaform|/HNAP1|/solr|/owa/|/autodiscover|/\.well-known/security|"
    r"/server-status|/config\.(json|php|yml)|/setup\.php|/install\.php|/shell|/backup|\.sql$|\.bak$|\.old$|/telescope|/debug|/console|"
    r"/geoserver|/manager/html|/jenkins|/druid|/hudson|\.php7?$)", re.I)
PAGE_SKIP = re.compile(r"^/(_glsc/|api/|socket\.io|assets/|f/)")
NO_PAGE_HOSTS = {"admin.glsc.fr", "click.glsc.fr"}


def log(*a):
    print("[glsc-admin]", *a, file=sys.stderr, flush=True)


def run(cmd, timeout=20):
    """Commande système → texte (vide si absente ou en échec)."""
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def write_json(path, data, group_gid=None, mode=0o640):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    os.chmod(tmp, mode)
    if group_gid is not None:
        try:
            os.chown(tmp, 0, group_gid)
        except PermissionError:
            pass
    os.replace(tmp, path)


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


# ---------------------------------------------------------------- base de travail
SCHEMA = """
CREATE TABLE IF NOT EXISTS requests (ts INTEGER NOT NULL, day TEXT NOT NULL, host TEXT NOT NULL, ip TEXT NOT NULL, status INTEGER NOT NULL,
  method TEXT NOT NULL, path TEXT NOT NULL, query TEXT NOT NULL, bytes INTEGER NOT NULL, referer TEXT NOT NULL, ua TEXT NOT NULL,
  device TEXT NOT NULL, bot INTEGER NOT NULL, page INTEGER NOT NULL, scan INTEGER NOT NULL, lang TEXT NOT NULL, rt REAL NOT NULL);
CREATE INDEX IF NOT EXISTS requests_ts ON requests(ts);
CREATE INDEX IF NOT EXISTS requests_host_ts ON requests(host, ts);
CREATE TABLE IF NOT EXISTS health (ts INTEGER PRIMARY KEY, cpu REAL, mem_used INTEGER, mem_total INTEGER, swap_used INTEGER, swap_total INTEGER,
  disk_used INTEGER, disk_total INTEGER, load1 REAL);
CREATE TABLE IF NOT EXISTS games (ts INTEGER NOT NULL, game TEXT NOT NULL, conns INTEGER NOT NULL, cpu REAL, mem INTEGER);
CREATE INDEX IF NOT EXISTS games_ts ON games(ts);
CREATE TABLE IF NOT EXISTS ssh (ts INTEGER NOT NULL, ip TEXT NOT NULL, user TEXT NOT NULL, kind TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ssh_ts ON ssh(ts);
CREATE TABLE IF NOT EXISTS results (ts INTEGER NOT NULL, game TEXT NOT NULL, match TEXT NOT NULL, mode TEXT NOT NULL, name TEXT NOT NULL,
  key TEXT NOT NULL, rank INTEGER NOT NULL, won INTEGER NOT NULL, role TEXT, kills INTEGER, deaths INTEGER, assists INTEGER);
CREATE INDEX IF NOT EXISTS results_game_ts ON results(game, ts);
"""


def device_of(ua):
    if not ua or BOT_UA.search(ua):
        return "robot"
    if re.search(r"ipad|tablet", ua, re.I):
        return "tablette"
    if re.search(r"mobi|android|iphone", ua, re.I):
        return "mobile"
    return "ordinateur"


def parse_line(line):
    """Une ligne du log nginx (format glsc_json) → tuple pour la table requests, ou None."""
    try:
        r = json.loads(line)
        ts = int(dt.datetime.fromisoformat(r["t"]).timestamp())
    except (ValueError, KeyError, TypeError):
        return None
    uri = str(r.get("u", ""))[:2000]
    path, _, query = uri.partition("?")
    path = path[:300] or "/"
    host = str(r.get("h", "")).lower()[:80]
    ua = str(r.get("a", ""))[:300]
    status = int(r.get("s") or 0)
    method = str(r.get("m", ""))[:10]
    scan = 1 if SCAN_PATH.search(path) else 0
    device = device_of(ua)
    bot = 1 if device == "robot" or scan else 0
    page = int(method == "GET" and status in (200, 304) and not bot and host not in NO_PAGE_HOSTS
               and not STATIC_EXT.search(path) and not PAGE_SKIP.search(path))
    lang = str(r.get("l", ""))[:2].lower() if r.get("l") else ""
    if not re.fullmatch(r"[a-z]{2}", lang):
        lang = ""
    ref = str(r.get("r", ""))[:300]
    day = dt.datetime.fromtimestamp(ts, TZ).strftime("%Y-%m-%d")
    try:
        rt = float(r.get("rt") or 0)
    except ValueError:
        rt = 0.0
    return (ts, day, host, str(r.get("ip", ""))[:45], status, method, path, query[:300], int(r.get("b") or 0), ref, ua,
            device, bot, page, scan, lang, rt)


def ingest_log(db, state, logfile, max_lines=300000):
    """Lit les lignes ajoutées depuis le dernier passage, y compris la fin d'un fichier qui vient d'être archivé (.1)."""
    pos = state.setdefault("log", {"inode": None, "offset": 0})
    try:
        st = os.stat(logfile)
    except OSError:
        return 0
    rows = []

    def read(path, offset):
        with open(path, "rb") as f:
            f.seek(offset)
            for raw in f:
                if not raw.endswith(b"\n"):
                    break  # ligne en cours d'écriture : on la lira au prochain passage
                offset += len(raw)
                row = parse_line(raw.decode("utf-8", "replace"))
                if row:
                    rows.append(row)
                if len(rows) >= max_lines:
                    break
        return offset

    if pos["inode"] != st.st_ino:
        rotated = logfile + ".1"
        if pos["inode"] is not None and os.path.exists(rotated) and os.stat(rotated).st_ino == pos["inode"]:
            read(rotated, pos["offset"])
        pos["inode"], pos["offset"] = st.st_ino, 0
    if st.st_size < pos["offset"]:
        pos["offset"] = 0  # fichier tronqué
    pos["offset"] = read(logfile, pos["offset"])
    if rows:
        db.executemany("INSERT INTO requests VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    return len(rows)


# ---------------------------------------------------------------- santé
def cpu_percent(state):
    with open("/proc/stat") as f:
        vals = [int(x) for x in f.readline().split()[1:]]
    idle, total = vals[3] + (vals[4] if len(vals) > 4 else 0), sum(vals)
    prev = state.get("cpu")
    state["cpu"] = [idle, total]
    if not prev or total == prev[1]:
        return 0.0
    return max(0.0, min(100.0, 100.0 * (1 - (idle - prev[0]) / (total - prev[1]))))


def meminfo():
    m = {}
    with open("/proc/meminfo") as f:
        for line in f:
            k, v = line.split(":", 1)
            m[k] = int(v.split()[0]) * 1024
    return m


def unit_state(name):
    """(présent, actif) pour une unité systemd ; « php-fpm » trouve la bonne version de PHP."""
    if name == "php-fpm":
        units = re.findall(r"(php[\d.]*-fpm\.service)", run(["systemctl", "list-unit-files", "php*-fpm.service", "--no-legend"]))
        if not units:
            return name, False, False
        name = units[-1]
    present = bool(run(["systemctl", "list-unit-files", name, "--no-legend"]).strip())
    active = run(["systemctl", "is-active", name]).strip() == "active"
    return name, present, active


def cert_list(live_dir):
    out = []
    for cert in sorted(glob.glob(os.path.join(live_dir, "*", "cert.pem"))):
        domain = os.path.basename(os.path.dirname(cert))
        end = run(["openssl", "x509", "-enddate", "-noout", "-in", cert]).strip()
        expires = days = None
        if end.startswith("notAfter="):
            try:
                t = dt.datetime.strptime(end[9:], "%b %d %H:%M:%S %Y %Z").replace(tzinfo=dt.timezone.utc)
                expires = int(t.timestamp())
                days = int((t - dt.datetime.now(dt.timezone.utc)).total_seconds() // 86400)
            except ValueError:
                pass
        out.append({"domain": domain, "expires": expires, "days": days})
    return out


def top_processes(n=6):
    out = []
    for line in run(["ps", "-eo", "comm=,rss=,pcpu=", "--sort=-rss"]).splitlines()[:n]:
        parts = line.rsplit(None, 2)
        if len(parts) == 3:
            try:
                out.append({"name": parts[0], "rss": int(parts[1]) * 1024, "cpu": float(parts[2])})
            except ValueError:
                pass
    return out


def health(db, state, now, args):
    m = meminfo()
    du = shutil.disk_usage("/")
    with open("/proc/uptime") as f:
        uptime = int(float(f.read().split()[0]))
    with open("/proc/loadavg") as f:
        load = [float(x) for x in f.read().split()[:3]]
    rx = tx = 0
    try:
        with open("/proc/net/dev") as f:
            for line in f.readlines()[2:]:
                name, data = line.split(":", 1)
                if name.strip() != "lo":
                    v = data.split()
                    rx += int(v[0])
                    tx += int(v[8])
    except OSError:
        pass
    osname = ""
    for line in open("/etc/os-release", encoding="utf-8") if os.path.exists("/etc/os-release") else []:
        if line.startswith("PRETTY_NAME="):
            osname = line.split("=", 1)[1].strip().strip('"')
    updates = None
    notifier = "/var/lib/update-notifier/updates-available"
    if os.path.exists(notifier):
        mt = re.search(r"(\d+) (?:updates?|mises? à jour)", open(notifier, encoding="utf-8", errors="replace").read())
        updates = int(mt.group(1)) if mt else 0
    services = []
    for unit, label in SERVICES:
        name, present, active = unit_state(unit)
        services.append({"name": name, "label": label, "present": present, "active": active})
    cpu = cpu_percent(state)
    mem_used = m.get("MemTotal", 0) - m.get("MemAvailable", 0)
    swap_used = m.get("SwapTotal", 0) - m.get("SwapFree", 0)
    snap = {
        "at": now, "cpu": round(cpu, 1), "cpus": os.cpu_count() or 1, "load": load, "uptime": uptime, "os": osname,
        "mem": {"used": mem_used, "total": m.get("MemTotal", 0)}, "swap": {"used": swap_used, "total": m.get("SwapTotal", 0)},
        "disk": {"used": du.used, "total": du.total}, "net": {"rx": rx, "tx": tx},
        "services": services, "certs": cert_list(args.letsencrypt), "top": top_processes(),
        "updates": updates, "reboot": os.path.exists("/var/run/reboot-required"),
    }
    db.execute("INSERT OR REPLACE INTO health VALUES (?,?,?,?,?,?,?,?,?)",
               (now, cpu, mem_used, m.get("MemTotal", 0), swap_used, m.get("SwapTotal", 0), du.used, du.total, load[0]))
    return snap


# ---------------------------------------------------------------- jeux (Docker)
def connections(port):
    """Nombre d'adresses distinctes connectées au port local du jeu (≈ joueurs ; nginx relaie avec X-Real-IP)."""
    out = run(["ss", "-Htn", "state", "established", f"( sport = :{port} )"])
    peers = {line.split()[-1].rsplit(":", 1)[0] for line in out.splitlines() if line.strip()}
    return len(peers)


def docker_state(db, now):
    containers = []
    ps = run(["docker", "ps", "-a", "--filter", "label=com.docker.compose.project=glsc-games", "--format", "{{json .}}"])
    stats = {}
    for line in run(["docker", "stats", "--no-stream", "--format", "{{json .}}"], timeout=30).splitlines():
        try:
            s = json.loads(line)
            stats[s["Name"]] = s
        except (ValueError, KeyError):
            continue
    for line in ps.splitlines():
        try:
            c = json.loads(line)
        except ValueError:
            continue
        labels = dict(kv.split("=", 1) for kv in c.get("Labels", "").split(",") if "=" in kv)
        service = labels.get("com.docker.compose.service", "")
        if service not in GAMES:
            continue
        label, port, domain = GAMES[service]
        s = stats.get(c["Names"], {})
        cpu = mem = None
        try:
            cpu = float(s.get("CPUPerc", "").rstrip("%"))
        except ValueError:
            pass
        mem = parse_size(s.get("MemUsage", "").split("/")[0].strip()) if s else None
        restarts = run(["docker", "inspect", "-f", "{{.RestartCount}}", c["Names"]]).strip()
        conns = connections(port) if c.get("State") == "running" else 0
        containers.append({"name": c["Names"], "service": service, "label": label, "domain": domain, "port": port,
                           "state": c.get("State", "?"), "status": c.get("Status", ""), "image": c.get("Image", ""),
                           "cpu": cpu, "mem": mem, "conns": conns, "restarts": int(restarts) if restarts.isdigit() else 0})
        db.execute("INSERT INTO games VALUES (?,?,?,?,?)", (now, service, conns, cpu, mem))
    containers.sort(key=lambda c: list(GAMES).index(c["service"]))
    return {"at": now, "containers": containers}


def parse_size(s):
    mt = re.match(r"([\d.]+)\s*([KMGT]?i?B)", s)
    if not mt:
        return None
    mult = {"B": 1, "KB": 1e3, "MB": 1e6, "GB": 1e9, "KiB": 1024, "MiB": 1024**2, "GiB": 1024**3, "TiB": 1024**4}
    return int(float(mt.group(1)) * mult.get(mt.group(2), 1))


# ---------------------------------------------------------------- sécurité
SSH_FAIL = re.compile(r"Failed (?:password|publickey) for (?!invalid user)(\S+) from (\S+)")
SSH_INVALID = re.compile(r"Invalid user (\S*) from (\S+)")
SSH_OK = re.compile(r"Accepted (\S+) for (\S+) from (\S+)")


def ssh_events(db, state, now):
    since = state.get("ssh_since", now - 3600)
    out = run(["journalctl", "-t", "sshd", "-t", "sshd-session", "--since", f"@{since}", "-o", "short-unix", "-q", "--no-pager"], timeout=30)
    accepted = []
    last = since
    for line in out.splitlines():
        try:
            ts = int(float(line.split(" ", 1)[0]))
        except ValueError:
            continue
        last = max(last, ts)
        if mt := SSH_OK.search(line):
            db.execute("INSERT INTO ssh VALUES (?,?,?,?)", (ts, mt.group(3), mt.group(2), "accepted"))
            accepted.append({"ts": ts, "user": mt.group(2), "ip": mt.group(3), "method": mt.group(1)})
        elif mt := SSH_INVALID.search(line):
            db.execute("INSERT INTO ssh VALUES (?,?,?,?)", (ts, mt.group(2), mt.group(1)[:40], "invalid"))
        elif mt := SSH_FAIL.search(line):
            db.execute("INSERT INTO ssh VALUES (?,?,?,?)", (ts, mt.group(2), mt.group(1)[:40], "fail"))
    state["ssh_since"] = last + 1 if out.strip() else max(since, now - 120)
    return accepted


def fail2ban():
    if not shutil.which("fail2ban-client"):
        return None
    jails = re.search(r"Jail list:\s*(.*)", run(["fail2ban-client", "status"]))
    out = []
    for jail in [j.strip() for j in (jails.group(1).split(",") if jails else []) if j.strip()]:
        txt = run(["fail2ban-client", "status", jail])
        banned = re.search(r"Banned IP list:\s*(.*)", txt)
        total = re.search(r"Total banned:\s*(\d+)", txt)
        out.append({"name": jail, "banned": banned.group(1).split() if banned else [], "total": int(total.group(1)) if total else 0})
    return out


# ---------------------------------------------------------------- activité publique pour share.glsc.fr
def github_projects(user, repos, state, now):
    """Langages et derniers commits de chaque dépôt public, pour la page Projets.

    L'API sans jeton est limitée à 60 appels par heure : on ne redemande le détail d'un dépôt
    (2 appels) que lorsque sa date de dernier push a changé. Le reste vient du cache (state).
    """
    cache = state.setdefault("projects", {})
    since = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - 90 * 86400))
    calls = 0
    for r in repos:
        if r.get("private"):
            continue
        name, c = r["name"], cache.get(r["name"], {})
        if c.get("pushed") != r["pushed"] and calls < 24:  # au pire 26 appels par passage
            langs = http_json(f"https://api.github.com/repos/{user}/{name}/languages")
            commits = http_json(f"https://api.github.com/repos/{user}/{name}/commits?since={since}&per_page=100")
            calls += 2
            total = sum(langs.values()) or 1
            c = {
                "pushed": r["pushed"],
                "languages": [[k, round(v * 100 / total, 1)] for k, v in sorted(langs.items(), key=lambda kv: -kv[1])][:4],
                "dates": [iso_ts(x["commit"]["committer"]["date"]) for x in commits if not x["commit"]["message"].startswith("Merge ")],
                "last": [{"message": x["commit"]["message"].splitlines()[0][:100], "sha": x["sha"][:7], "at": iso_ts(x["commit"]["committer"]["date"])}
                         for x in commits if not x["commit"]["message"].startswith("Merge ")][:3],
            }
            cache[name] = c
    out = []
    for r in repos:
        c = cache.get(r["name"])
        if r.get("private") or not c:
            continue
        out.append({"name": r["name"], "url": r["url"], "stars": r["stars"], "pushed": r["pushed"], "languages": c["languages"],
                    "commits30": sum(1 for d in c["dates"] if d >= now - 30 * 86400),
                    "commits90": len(c["dates"]), "last": c["last"]})
    # fil global : les derniers commits, tous dépôts confondus
    recent = sorted(({**x, "repo": p["name"]} for p in out for x in p["last"]), key=lambda x: -x["at"])[:6]
    return {"at": now, "user": user, "repos": out, "recent": recent}


# ---------------------------------------------------------------- GitHub, sauvegardes, versions
def iso_ts(s):
    return int(dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())


def http_json(url, timeout=10):
    req = urllib.request.Request(url, headers={"User-Agent": "glsc-admin", "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def github(user):
    repos = http_json(f"https://api.github.com/users/{user}/repos?sort=pushed&per_page=60")
    events = http_json(f"https://api.github.com/users/{user}/events/public?per_page=60")
    commits, feed = [], []

    def ts(s):
        return int(dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())

    for e in events:
        repo = e.get("repo", {}).get("name", "").split("/")[-1]
        at, p, t = ts(e["created_at"]), e.get("payload", {}), e.get("type")
        if t == "PushEvent":
            for c in reversed(p.get("commits", [])):
                if c.get("message", "").startswith("Merge "):
                    continue
                commits.append({"repo": repo, "message": c["message"].splitlines()[0][:120], "sha": c["sha"][:7], "at": at,
                                "url": f"https://github.com/{user}/{repo}/commit/{c['sha']}"})
        elif t == "PullRequestEvent":
            pr = p.get("pull_request", {})
            action = "PR fusionnée" if p.get("action") == "closed" and pr.get("merged") else f"PR {p.get('action', '')}"
            feed.append({"type": action, "repo": repo, "text": f"#{pr.get('number')} {pr.get('title', '')}"[:120], "url": pr.get("html_url"), "at": at})
        elif t == "CreateEvent":
            feed.append({"type": f"{p.get('ref_type', '')} créé", "repo": repo, "text": p.get("ref") or repo, "url": None, "at": at})
        elif t in ("ReleaseEvent", "IssuesEvent", "WatchEvent", "ForkEvent"):
            names = {"ReleaseEvent": "release", "IssuesEvent": "issue", "WatchEvent": "étoile", "ForkEvent": "fork"}
            feed.append({"type": names[t], "repo": repo, "text": (p.get("release") or p.get("issue") or {}).get("name")
                         or (p.get("issue") or {}).get("title") or repo, "url": None, "at": at})
    return {
        "at": int(time.time()),
        # tous les dépôts (page Projets) ; l'admin n'en affiche que les 18 plus récents
        "all": [{"name": r["name"], "description": r.get("description") or "", "url": r["html_url"], "language": r.get("language"),
                 "stars": r.get("stargazers_count", 0), "pushed": ts(r["pushed_at"]), "private": r.get("private", False)}
                for r in repos if not r.get("fork")],
        "commits": commits[:15], "events": feed[:15],
    }


BACKUP_NAME = re.compile(r"^(\d{8})-(\d{6})(?:-(\w+))?$")


def deploys(state, backups_dir, games_src, version_file, now):
    sizes = state.setdefault("backup_sizes", {})
    refresh = now - state.get("sizes_at", 0) > 1800
    backups = []
    for d in sorted(glob.glob(os.path.join(backups_dir, "*")), reverse=True):
        mt = BACKUP_NAME.match(os.path.basename(d))
        if not mt or not os.path.isdir(d):
            continue
        at = int(dt.datetime.strptime(mt.group(1) + mt.group(2), "%Y%m%d%H%M%S").replace(tzinfo=TZ).timestamp())
        name = os.path.basename(d)
        if refresh or name not in sizes:
            out = run(["du", "-sb", d], timeout=60).split()
            sizes[name] = int(out[0]) if out and out[0].isdigit() else None
        backups.append({"name": name, "at": at, "kind": mt.group(3) or "", "size": sizes.get(name)})
    if refresh:
        state["sizes_at"] = now
        state["backup_sizes"] = {b["name"]: b["size"] for b in backups}
    versions = []
    v = load_json(version_file, None)
    if v:
        versions.append({"name": "Sites (portfolio)", "commit": v.get("sha", "?")[:7], "subject": v.get("subject", ""), "at": v.get("at", 0)})
    for repo in sorted(glob.glob(os.path.join(games_src, "*", ".git"))):
        out = run(["git", "-C", os.path.dirname(repo), "log", "-1", "--format=%h|%ct|%s"]).strip()
        if out.count("|") >= 2:
            h, ct, s = out.split("|", 2)
            versions.append({"name": os.path.basename(os.path.dirname(repo)), "commit": h, "subject": s[:100], "at": int(ct)})
    return {"at": now, "backups": backups, "total": sum(b["size"] or 0 for b in backups), "versions": versions}


# ---------------------------------------------------------------- alertes Discord
def app_settings(app_db):
    """Réglages de l'admin (lecture seule) : webhook et alertes activées."""
    try:
        con = sqlite3.connect(f"file:{app_db}?mode=ro", uri=True, timeout=3)
        rows = dict(con.execute("SELECT key, value FROM settings").fetchall())
        con.close()
        return rows
    except sqlite3.Error:
        return {}


def discord(webhook, title, text, color=0xFFD84D, fields=None, url=None):
    if not webhook:
        return False
    embed = {"title": title[:250], "description": text[:3500], "color": color, "timestamp": dt.datetime.now(dt.timezone.utc).isoformat()}
    if fields:  # au plus 25 champs de 1024 caractères (limites Discord)
        embed["fields"] = [{"name": n[:250], "value": v[:1020] or "—", "inline": inline} for n, v, inline in fields[:25]]
    if url:
        embed["url"] = url
    payload = json.dumps({"username": "glsc.fr", "embeds": [embed]}).encode()
    try:
        req = urllib.request.Request(webhook, data=payload, method="POST", headers={"Content-Type": "application/json", "User-Agent": "glsc-admin"})
        urllib.request.urlopen(req, timeout=8).close()
        return True
    except OSError as e:
        log("discord :", e)
        return False


def alerts(state, settings, now, hl, dk, accepted):
    hook = settings.get("discord_webhook", "")
    on = lambda k: settings.get(f"alert_{k}", "1") == "1"  # noqa: E731
    cool = state.setdefault("cooldown", {})

    def fire(key, every, title, text, color):
        if now - cool.get(key, 0) >= every:
            cool[key] = now
            discord(hook, title, text, color)

    if hl:
        disk = hl["disk"]["used"] / max(1, hl["disk"]["total"])
        if on("disk") and disk > 0.85:
            fire("disk", 6 * 3600, "💾 Disque presque plein", f"{disk:.0%} utilisé sur le serveur.", 0xFF9478)
        mem = hl["mem"]["used"] / max(1, hl["mem"]["total"])
        state["mem_high"] = state.get("mem_high", 0) + 1 if mem > 0.95 else 0
        if on("memory") and state["mem_high"] >= 3:
            fire("memory", 3600, "🧠 Mémoire saturée", f"{mem:.0%} de RAM utilisée depuis 3 min.", 0xFF9478)
        for c in hl["certs"]:
            if on("cert") and c["days"] is not None and c["days"] < 14:
                fire("cert:" + c["domain"], 86400, "🔐 Certificat bientôt expiré", f"{c['domain']} expire dans {c['days']} jours (certbot devrait le renouveler).", 0xFFD84D)
    if dk:
        prev = state.setdefault("containers", {})
        for c in dk["containers"]:
            was = prev.get(c["service"])
            if on("game_down") and was == "running" and c["state"] != "running":
                discord(hook, f"🎮 {c['label']} est arrêté", f"État du conteneur : {c['state']} ({c['status']}).", 0xEF4444)
            if on("game_down") and was not in (None, "running") and c["state"] == "running":
                discord(hook, f"✅ {c['label']} est reparti", "Le conteneur tourne à nouveau.", 0x22C55E)
            prev[c["service"]] = c["state"]
    if on("ssh"):
        for a in accepted:
            discord(hook, "🖥️ Connexion SSH au serveur", f"Utilisateur **{a['user']}** depuis {a['ip']} ({a['method']}).", 0x8FD3FF)


def sync_status_webhook(state, settings, path):
    """status.glsc.fr prévient déjà quand un site tombe : on lui passe le webhook réglé dans l'admin."""
    hook = settings.get("discord_webhook", "") if settings.get("alert_site_down", "1") == "1" else ""
    if not os.path.isdir(os.path.dirname(path)):
        return
    current = open(path, encoding="utf-8").read().strip() if os.path.exists(path) else ""
    ours = state.get("status_hook", "")
    if hook and current != hook and (not current or current == ours):
        with open(path + ".tmp", "w", encoding="utf-8") as f:
            f.write(hook + "\n")
        os.chmod(path + ".tmp", 0o640)
        try:
            shutil.chown(path + ".tmp", "root", "glsc-status")
        except (LookupError, PermissionError):
            pass
        os.replace(path + ".tmp", path)
        state["status_hook"] = hook
    elif not hook and current and current == ours:
        os.remove(path)
        state["status_hook"] = ""


# ---------------------------------------------------------------- publication
def publish_db(work_db, pub_db, gid):
    tmp = pub_db + ".tmp"
    if os.path.exists(tmp):
        os.remove(tmp)
    src = sqlite3.connect(work_db)
    dst = sqlite3.connect(tmp)
    src.backup(dst)
    dst.execute("PRAGMA journal_mode=DELETE")
    dst.close()
    src.close()
    os.chmod(tmp, 0o640)
    if gid is not None:
        try:
            os.chown(tmp, 0, gid)
        except PermissionError:
            pass
    os.replace(tmp, pub_db)

# ---------------------------------------------------------------- classements des jeux
# Recherchés dans le pseudo entier (même collés ou écrits en l33t) ; les mots courts ou ambigus
# (« Monique », « computer », « Montenegro »…) ne sont refusés que seuls.
INSULTS = ("connard", "connasse", "salope", "putain", "encule", "batard", "bougnoul", "nazi", "hitler", "fuck", "bitch",
           "nigger", "nigga", "whore", "porno", "couille", "merde")
INSULT_WORDS = {"pd", "tg", "fdp", "ntm", "con", "conne", "pute", "putes", "nique", "niquer", "negre", "negro", "pede", "cunt",
                "shit", "chatte", "bite", "sex", "sexe", "porn", "penis", "ss"}
DEFAULT_NAMES = re.compile(r"^(joueur|joueuse|player|invite|guest|anonyme|anonymous|moi|test|bot|hote|host|toto)\s*\d*$")
LEET = str.maketrans("013457@$", "oieastas")


def name_key(name):
    """Clé d'un pseudo : sans accents ni majuscules, espaces réduits (« Gabin » = « gabin » = « GABIN »)."""
    import unicodedata
    plain = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return " ".join(plain.casefold().split()) or name.casefold().strip()


def name_ok(key):
    """False pour un pseudo par défaut ou injurieux : il n'apparaît jamais dans le classement public."""
    if DEFAULT_NAMES.match(key):
        return False
    squashed = re.sub(r"[^a-z]", "", key.translate(LEET))
    words = set(re.findall(r"[a-z]+", key.translate(LEET)))
    return not (any(w in squashed for w in INSULTS) or words & INSULT_WORDS)


def ingest_results(db, state, data_dir, now):
    """Lit les nouvelles lignes de chaque results.jsonl (écrits par les jeux) ; seuls les humains sont gardés."""
    offsets = state.setdefault("results", {})
    added = 0
    for game in GAMES:
        path = os.path.join(data_dir, game, "results.jsonl")
        try:
            st = os.stat(path)
        except OSError:
            continue
        pos = offsets.get(game, {})
        start = pos.get("off", 0) if pos.get("ino") == st.st_ino and st.st_size >= pos.get("off", 0) else 0
        with open(path, "rb") as f:
            f.seek(start)
            chunk = f.read(4 * 1024 * 1024)
        end = chunk.rfind(b"\n") + 1  # une ligne en cours d'écriture attend le prochain passage
        offset = start
        for raw in chunk[:end].splitlines(keepends=True):
            line_at, offset = offset, offset + len(raw)
            try:
                r = json.loads(raw)
                t, players = int(r["t"]), r["players"]
                if r.get("game") != game or not isinstance(players, list) or len(players) > 16 or not now - 400 * 86400 < t <= now + 300:
                    continue
            except (ValueError, KeyError, TypeError):
                continue
            match = f"{game}:{st.st_ino}:{line_at}"
            mode = str(r.get("mode", ""))[:20]
            for p in players:
                if not isinstance(p, dict) or p.get("bot") is not False or not isinstance(p.get("name"), str):
                    continue
                name = " ".join(p["name"].split())[:24]
                if not name:
                    continue
                num = lambda k: int(p[k]) if isinstance(p.get(k), (int, float)) else None  # noqa: E731
                db.execute("INSERT INTO results VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                           (t, game, match, mode, name, name_key(name), num("rank") or 0, 1 if p.get("won") is True else 0,
                            str(p["role"])[:20] if isinstance(p.get("role"), str) else None, num("kills"), num("deaths"), num("assists")))
                added += 1
        offsets[game] = {"ino": st.st_ino, "off": start + end}
    return added


def leaderboards(db, now, hidden):
    """Classements par jeu, sur 7 jours et depuis toujours. Version publique (filtrée) et version admin (tout, avec raisons)."""
    week = now - 7 * 86400
    public, admin = {"at": now, "games": {}}, {"at": now, "games": {}}
    for game in GAMES:
        g_pub, g_adm = {}, {}
        for period, since in (("week", week), ("all", 0)):
            matches, players = db.execute("SELECT COUNT(DISTINCT match), COUNT(DISTINCT key) FROM results WHERE game = ? AND ts >= ?",
                                          (game, since)).fetchone()
            order = "SUM(kills) DESC, SUM(deaths) ASC" if game == "vortex" else "SUM(won) DESC, COUNT(*) ASC"
            rows = db.execute(f"""SELECT key, name, MAX(ts), COUNT(*), SUM(won), SUM(kills), SUM(deaths), SUM(assists),
                                         SUM(role = 'president'), SUM(role = 'trouduc')
                                  FROM results WHERE game = ? AND ts >= ? GROUP BY key ORDER BY {order}, MAX(ts) DESC LIMIT 150""",
                                  (game, since)).fetchall()
            board, review = [], []
            for key, name, last, played, wins, kills, deaths, assists, pres, trou in rows:
                entry = {"name": name, "played": played, "wins": wins or 0}
                if game == "vortex":
                    entry.update(kills=kills or 0, deaths=deaths or 0, assists=assists or 0)
                if game == "president":
                    entry.update(president=pres or 0, trouduc=trou or 0)
                why = "masqué" if key in hidden else None if name_ok(key) else "filtré"
                review.append({**entry, "key": key, "last": last, "hidden": why})
                if not why and len(board) < 10 and (entry["wins"] or entry.get("kills")):
                    board.append(entry)
            g_pub[period] = {"matches": matches, "players": players, "top": board}
            g_adm[period] = {"matches": matches, "players": players, "names": review[:100]}
            if game == "president":  # le titre que personne ne veut
                worst = sorted((e for e in review if not e["hidden"] and e["trouduc"]), key=lambda e: (-e["trouduc"], e["played"]))
                g_pub[period]["trouduc"] = {k: worst[0][k] for k in ("name", "trouduc", "played")} if worst else None
        public["games"][game], admin["games"][game] = g_pub, g_adm
    return public, admin

# ---------------------------------------------------------------- récap Discord du lundi
SITE_NAMES = {"glsc.fr": "Hub", "cv.glsc.fr": "CV", "share.glsc.fr": "Projets", "old.glsc.fr": "Archives", "games.glsc.fr": "Salle de jeux",
              "status.glsc.fr": "Statut", "uno.glsc.fr": "UNO", "president.glsc.fr": "Président", "vortex.glsc.fr": "Vortex"}
CV_EVENTS = {"print": "impressions", "email": "clics e-mail", "email_copy": "e-mails copiés", "phone": "clics téléphone",
             "linkedin": "clics LinkedIn", "github": "clics GitHub", "site": "clics site"}


def source_of(ref):
    """Même regroupement que l'admin (Trafic) : d'où viennent les visiteurs."""
    host = (urllib.parse.urlsplit(ref).hostname or "") if ref not in ("", "-") else ""
    host = re.sub(r"^(www|m|l|lm)\.", "", host)
    for key, name in (("linkedin", "LinkedIn"), ("lnkd.in", "LinkedIn"), ("google", "Google"), ("bing", "Bing"), ("duckduckgo", "DuckDuckGo"),
                      ("github", "GitHub"), ("indeed", "Indeed"), ("welcometothejungle", "Welcome to the Jungle"), ("discord", "Discord")):
        if key in host:
            return name
    return "Direct" if not host else None if host.endswith("glsc.fr") else host


def week_bounds(now):
    """Semaine écoulée : du lundi 0 h au lundi suivant 0 h (heure de Paris)."""
    today = dt.datetime.fromtimestamp(now, TZ).replace(hour=0, minute=0, second=0, microsecond=0)
    end = today - dt.timedelta(days=today.weekday())
    start = end - dt.timedelta(days=7)
    return int(start.timestamp()), int(end.timestamp())


def trend(cur, prev):
    if not prev:
        return " (nouveau)" if cur else ""
    p = round((cur - prev) * 100 / prev)
    return f" ({'+' if p >= 0 else ''}{p} %)" if p else " (=)"


def fr(n):
    return f"{n:,}".replace(",", " ")


def weekly_recap(db, state, start, end, pub_dir, status_file):
    """Titre, texte et champs du récap entre start et end (comparé à la période d'avant, de même durée)."""
    prev = (2 * start - end, start)
    one = lambda sql, args=(): db.execute(sql, args).fetchone()[0] or 0  # noqa: E731
    fields = []

    # Visites
    views = one("SELECT COUNT(*) FROM requests WHERE page = 1 AND ts >= ? AND ts < ?", (start, end))
    views_prev = one("SELECT COUNT(*) FROM requests WHERE page = 1 AND ts >= ? AND ts < ?", prev)
    visitors = one("SELECT COUNT(DISTINCT ip || ua) FROM requests WHERE page = 1 AND ts >= ? AND ts < ?", (start, end))
    sites = db.execute("SELECT host, COUNT(*) n FROM requests WHERE page = 1 AND ts >= ? AND ts < ? GROUP BY host ORDER BY n DESC LIMIT 4",
                       (start, end)).fetchall()
    sources = {}
    for ref, n in db.execute("SELECT referer, COUNT(*) FROM requests WHERE page = 1 AND ts >= ? AND ts < ? GROUP BY referer", (start, end)):
        src = source_of(ref)
        if src:
            sources[src] = sources.get(src, 0) + n
    top_src = sorted(sources.items(), key=lambda kv: -kv[1])[:3]
    fields.append(("👀 Visites", "\n".join(filter(None, [
        f"**{fr(views)}** pages vues{trend(views, views_prev)} · **{fr(visitors)}** visiteurs",
        "Sites : " + ", ".join(f"{SITE_NAMES.get(h, h)} {fr(n)}" for h, n in sites) if sites else None,
        "Sources : " + ", ".join(f"{k} {fr(v)}" for k, v in top_src) if top_src else None])), False))

    # CV et projets (beacons /_glsc/b.gif?e=…)
    cv_views = one("SELECT COUNT(*) FROM requests WHERE page = 1 AND host = 'cv.glsc.fr' AND ts >= ? AND ts < ?", (start, end))
    events = {}
    for q, n in db.execute("SELECT query, COUNT(*) FROM requests WHERE path = '/_glsc/b.gif' AND bot = 0 AND ts >= ? AND ts < ? GROUP BY query",
                           (start, end)):
        e = urllib.parse.parse_qs(q).get("e", [""])[0][:60]
        if e:
            events[e] = events.get(e, 0) + n
    cv_bits = [f"{fr(n)} {CV_EVENTS[e]}" for e, n in sorted(events.items(), key=lambda kv: -kv[1]) if e in CV_EVENTS][:4]
    projects = sorted(((e[8:], n) for e, n in events.items() if e.startswith("project:")), key=lambda kv: -kv[1])[:3]
    fields.append(("📄 CV & projets", "\n".join(filter(None, [
        f"CV vu **{fr(cv_views)}** fois" + (" · " + ", ".join(cv_bits) if cv_bits else ""),
        "Projets cliqués : " + ", ".join(f"{p} ({fr(n)})" for p, n in projects) if projects else None])), False))

    # Jeux
    lines = []
    for game, (label, _, _) in GAMES.items():
        matches = one("SELECT COUNT(DISTINCT match) FROM results WHERE game = ? AND ts >= ? AND ts < ?", (game, start, end))
        peak = one("SELECT MAX(conns) FROM games WHERE game = ? AND ts >= ? AND ts < ?", (game, start, end))
        order = "SUM(kills) DESC" if game == "vortex" else "SUM(won) DESC, COUNT(*) ASC"
        champ = None
        for key, name, wins, kills in db.execute(f"SELECT key, name, SUM(won), SUM(kills) FROM results WHERE game = ? AND ts >= ? AND ts < ? "
                                                 f"GROUP BY key ORDER BY {order} LIMIT 20", (game, start, end)):
            if name_ok(key) and (wins or kills):
                champ = f"👑 {name} ({fr(kills or 0)} élim.)" if game == "vortex" else f"👑 {name} ({fr(wins)} victoire{'s' if wins > 1 else ''})"
                break
        if matches or peak:
            unit = "partie" if game == "uno" else "manche"
            lines.append(f"**{label}** : {fr(matches)} {unit}{'s' if matches > 1 else ''}" + (f", jusqu'à {peak} connectés" if peak else "")
                         + (f" · {champ}" if champ else ""))
    fields.append(("🎮 Jeux", "\n".join(lines) or "Personne n'a joué cette semaine.", False))

    # GitHub (cache de la page Projets : dates des commits hors merge, 90 jours)
    per_repo = {name: sum(1 for d in c.get("dates", []) if start <= d < end) for name, c in state.get("projects", {}).items()}
    commits = sum(per_repo.values())
    busiest = sorted(((n, r) for r, n in per_repo.items() if n), reverse=True)[:3]
    runs = load_json(os.path.join(pub_dir, "deploy-runs.json"), {}).get("runs", [])
    week_runs = [r for r in runs if start <= (r.get("start") or 0) < end]
    ok = sum(1 for r in week_runs if r.get("status") == "ok")
    fields.append(("🛠️ Code", "\n".join(filter(None, [
        f"**{fr(commits)}** commit{'s' if commits > 1 else ''}" + (" · " + ", ".join(f"{r} {n}" for n, r in busiest) if busiest else ""),
        f"{ok} déploiement{'s' if ok > 1 else ''} réussi{'s' if ok > 1 else ''}" + (f", **{len(week_runs) - ok} raté{'s' if len(week_runs) - ok > 1 else ''}**" if len(week_runs) > ok else "")
        if week_runs else None])), False))

    # Serveur
    status = load_json(status_file, {})
    incidents = []
    for i in status.get("incidents", []):
        try:
            t = int(dt.datetime.fromisoformat(i["start"].replace("Z", "+00:00")).timestamp())
        except (KeyError, ValueError, AttributeError):
            continue
        if start <= t < end:
            incidents.append(i)
    down = sum(int(i.get("duration_s") or 0) for i in incidents)
    ssh = one("SELECT COUNT(*) FROM ssh WHERE kind != 'accepted' AND ts >= ? AND ts < ?", (start, end))
    scans = one("SELECT COUNT(*) FROM requests WHERE scan = 1 AND ts >= ? AND ts < ?", (start, end))
    health = load_json(os.path.join(pub_dir, "health.json"), {})
    disk = health.get("disk") or {}
    certs = [c for c in health.get("certs", []) if c.get("days") is not None and c["days"] < 21]
    fields.append(("🖥️ Serveur", "\n".join(filter(None, [
        f"**{len(incidents)}** incident{'s' if len(incidents) > 1 else ''}" + (f" ({human(down)} d'indisponibilité : "
                                                                          + ", ".join(sorted({i['name'] for i in incidents})) + ")" if incidents else " 🎉"),
        f"{fr(ssh)} tentatives SSH refusées · {fr(scans)} requêtes de robots scanneurs",
        f"Disque : {disk['used'] * 100 // max(1, disk['total'])} % utilisé" if disk.get("total") else None,
        "⚠️ Certificats bientôt expirés : " + ", ".join(f"{c['domain']} ({c['days']} j)" for c in certs) if certs else None])), False))

    a = dt.datetime.fromtimestamp(start, TZ)
    b = dt.datetime.fromtimestamp(end - 1, TZ)
    months = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."]
    title = f"📊 Récap · {a.day} {months[a.month - 1]} → {b.day} {months[b.month - 1]}"
    return title, f"Ce qui s'est passé sur glsc.fr, du {a.strftime('%d/%m %H:%M')} au {b.strftime('%d/%m %H:%M')}.", fields


def human(sec):
    return f"{sec // 3600} h {sec % 3600 // 60:02d}" if sec >= 3600 else f"{max(1, sec // 60)} min"


def send_recap(db, state, now, args, settings):
    """Automatique : le lundi à partir de 9 h (Paris), une fois par semaine, sur la semaine écoulée."""
    local = dt.datetime.fromtimestamp(now, TZ)
    week = local.strftime("%G-%V")
    if local.weekday() != 0 or local.hour < 9 or state.get("recap_week") == week:
        return False
    state["recap_week"] = week  # même sans webhook ou alerte coupée : une seule tentative par semaine
    if settings.get("alert_weekly", "1") != "1":
        return False
    title, text, fields = weekly_recap(db, state, *week_bounds(now), args.pub_dir, args.status_json)
    return discord(settings.get("discord_webhook", ""), title, text, 0xC3A6FF, fields, url="https://admin.glsc.fr")


def recap_now(args, period="7j", preview=False):
    """À la demande (commande glsc-recap ou bouton de l'admin) : lit la copie publiée de la base, n'écrit rien."""
    now = int(time.time())
    start, end = week_bounds(now) if period == "semaine" else (now - 7 * 86400, now)
    pub_db = os.path.join(args.pub_dir, "metrics.db")
    if not os.path.exists(pub_db):
        raise SystemExit("Pas encore de mesures : la sonde n'a jamais tourné (deploy5).")
    db = sqlite3.connect(f"file:{pub_db}?mode=ro", uri=True)
    state = load_json(os.path.join(args.state_dir, "state.json"), {})
    title, text, fields = weekly_recap(db, state, start, end, args.pub_dir, args.status_json)
    db.close()
    if preview:
        print(title, "\n" + text)
        for name, value, _ in fields:
            print(f"\n{name}\n" + "\n".join("  " + line.replace("**", "") for line in value.splitlines()))
        return True
    hook = app_settings(args.app_db).get("discord_webhook", "")
    if not hook:
        raise SystemExit("Aucun webhook Discord : règle-le dans l'admin (Réglages).")
    return discord(hook, title, text, 0xC3A6FF, fields, url="https://admin.glsc.fr")


def www_gid():
    try:
        import grp
        return grp.getgrnam("www-data").gr_gid
    except (KeyError, ImportError):
        return None


def collect(args):
    now = int(time.time())
    os.makedirs(args.state_dir, exist_ok=True)
    os.makedirs(args.pub_dir, exist_ok=True)
    state_file = os.path.join(args.state_dir, "state.json")
    state = load_json(state_file, {})
    gid = www_gid()
    db = sqlite3.connect(os.path.join(args.state_dir, "work.db"))
    db.executescript(SCHEMA)
    pub = lambda name: os.path.join(args.pub_dir, name + ".json")  # noqa: E731

    def step(name, fn):
        try:
            return fn()
        except Exception as e:  # une étape en échec ne bloque pas les autres
            log(f"{name} : {type(e).__name__}: {e}")
            return None

    n = step("logs nginx", lambda: ingest_log(db, state, args.log))
    hl = step("santé", lambda: health(db, state, now, args))
    if hl:
        write_json(pub("health"), hl, gid)
    dk = step("docker", lambda: docker_state(db, now)) if shutil.which("docker") else None
    if dk:
        write_json(pub("docker"), dk, gid)
    accepted = step("ssh", lambda: ssh_events(db, state, now)) or []
    step("résultats des jeux", lambda: ingest_results(db, state, args.games_data, now))
    hidden = set(json.loads(app_settings(args.app_db).get("games_hidden") or "[]"))
    boards = step("classements", lambda: leaderboards(db, now, hidden))
    if boards:
        write_json(pub("leaderboard"), boards[1], gid)
        if os.path.isdir(os.path.dirname(args.leaderboard_json)):
            write_json(args.leaderboard_json, boards[0], mode=0o644)
    sec = {"at": now, "fail2ban": step("fail2ban", fail2ban)}
    write_json(pub("security"), sec, gid)
    if now - state.get("github_at", 0) >= 900 and not args.offline:
        gh = step("github", lambda: github(args.github_user))
        state["github_at"] = now  # même en échec : pas plus d'un essai par 15 min (limite de l'API)
        if gh:
            repos = gh.pop("all")
            write_json(pub("github"), {**gh, "repos": repos[:18]}, gid)
            pj = step("projets", lambda: github_projects(args.github_user, repos, state, now))
            if pj and os.path.isdir(os.path.dirname(args.projects_json)):
                write_json(args.projects_json, pj, mode=0o644)
    if now - state.get("deploys_at", 0) >= 600:
        dp = step("déploiements", lambda: deploys(state, args.backups, args.games_src, args.version_file, now))
        if dp:
            write_json(pub("deploys"), dp, gid)
            state["deploys_at"] = now
    settings = app_settings(args.app_db)
    step("alertes", lambda: alerts(state, settings, now, hl, dk, accepted))
    step("webhook status", lambda: sync_status_webhook(state, settings, args.status_webhook))
    step("récap du lundi", lambda: send_recap(db, state, now, args, settings))

    # rétention : 35 jours de requêtes, 8 jours de mesures fines
    db.execute("DELETE FROM requests WHERE ts < ?", (now - 35 * 86400,))
    db.execute("DELETE FROM health WHERE ts < ?", (now - 8 * 86400,))
    db.execute("DELETE FROM games WHERE ts < ?", (now - 8 * 86400,))
    db.execute("DELETE FROM ssh WHERE ts < ?", (now - 35 * 86400,))
    db.execute("DELETE FROM results WHERE ts < ?", (now - 400 * 86400,))
    db.commit()
    if now - state.get("vacuum_at", 0) > 7 * 86400:
        db.execute("VACUUM")
        state["vacuum_at"] = now
    db.close()
    step("publication", lambda: publish_db(os.path.join(args.state_dir, "work.db"), os.path.join(args.pub_dir, "metrics.db"), gid))
    write_json(state_file, state)
    if args.verbose:
        log(f"{n or 0} requêtes lues")


# ---------------------------------------------------------------- file d'attente
def queue(args):
    settings = app_settings(args.app_db)
    hook = settings.get("discord_webhook", "")
    for path in sorted(glob.glob(os.path.join(args.queue_dir, "*.json"))):
        try:
            if os.path.getsize(path) > 65536:
                raise ValueError("fichier trop gros")
            job = load_json(path, {})
            kind, data = job.get("type"), job.get("data") or {}
            if time.time() - int(job.get("at", 0)) > 3600:
                log("demande trop ancienne ignorée :", os.path.basename(path))
            elif kind == "recap":
                log("récap à la demande :", "envoyé" if recap_now(args, "semaine" if data.get("period") == "semaine" else "7j") else "échec")
            elif kind == "discord":
                discord(hook, str(data.get("title", ""))[:200], str(data.get("text", ""))[:1500])
            elif kind == "restart" and data.get("game") in GAMES:
                name = f"glsc-games-{data['game']}-1"
                ok = subprocess.run(["docker", "restart", name], capture_output=True, timeout=90, check=False).returncode == 0
                log(f"redémarrage de {name} :", "ok" if ok else "échec")
                if not ok:
                    discord(hook, f"⚠️ Redémarrage de {GAMES[data['game']][0]} raté", "Regarde `docker logs " + name + "` sur le serveur.", 0xEF4444)
            else:
                log("demande inconnue ignorée :", kind)
        except Exception as e:
            log("file d'attente :", os.path.basename(path), e)
        finally:
            try:
                os.remove(path)
            except OSError:
                pass

# ---------------------------------------------------------------- déploiement automatique
REPO_TGZ = os.environ.get("GLSC_DEPLOY_TGZ", "https://codeload.github.com/gabinlsc/portfolio/tar.gz/refs/heads/main")  # surchargé par les tests
DEPLOY_PLANS = {  # cible → scripts du dépôt portfolio à lancer, avec leurs variables d'environnement
    "portfolio": [("deploy/deploy3.sh", {}), ("deploy/deploy5.sh", {"GLSC_ONLY_ADMIN": "1"})],
    "portfolio-full": [("deploy/deploy5.sh", {})],
    "uno": [("deploy/deploy4.sh", {"GLSC_ONLY_GAME": "uno"})],
    "president": [("deploy/deploy4.sh", {"GLSC_ONLY_GAME": "president"})],
    "vortex": [("deploy/deploy4.sh", {"GLSC_ONLY_GAME": "vortex"})],
}
DEPLOY_STEP_TIMEOUT = 40 * 60
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def deploy_requests(args):
    """Lit et supprime les demandes en attente ; une seule exécution par cible (la plus récente gagne)."""
    wanted = {}
    for path in sorted(glob.glob(os.path.join(args.deploy_dir, "*.json"))):
        try:
            if os.path.getsize(path) > 8192:
                raise ValueError("fichier trop gros")
            req = load_json(path, {})
            target = req.get("target")
            if target not in DEPLOY_PLANS:
                log("déploiement : cible inconnue ignorée :", target)
            elif time.time() - int(req.get("at", 0)) > 6 * 3600:
                log("déploiement : demande trop ancienne ignorée")
            else:
                wanted[target] = {k: str(req.get(k, ""))[:200] for k in ("sha", "message", "by", "source")}
        except Exception as e:
            log("déploiement :", os.path.basename(path), e)
        finally:
            try:
                os.remove(path)
            except OSError:
                pass
    if "portfolio-full" in wanted:
        wanted.pop("portfolio", None)
    order = ["portfolio-full", "portfolio", "uno", "president", "vortex"]
    return [(t, wanted[t]) for t in order if t in wanted]


def deploy_publish(args, runs, gid):
    write_json(os.path.join(args.pub_dir, "deploy-runs.json"), {"at": int(time.time()), "runs": runs[:30]}, gid)
    keep = {r["id"] for r in runs[:30]}
    for p in glob.glob(os.path.join(args.pub_dir, "deploy-logs", "*.log")):
        if os.path.basename(p)[:-4] not in keep:
            os.remove(p)


def deploy_run(args, target, info, runs, gid, hook, alert_on):
    import tarfile
    import tempfile
    start = time.time()
    run_id = time.strftime("%Y%m%d-%H%M%S", time.localtime(start)) + "-" + target
    logs = os.path.join(args.pub_dir, "deploy-logs")
    os.makedirs(logs, exist_ok=True)
    gid = gid if gid is not None else -1
    os.chown(logs, 0, gid)
    os.chmod(logs, 0o750)
    log_path = os.path.join(logs, run_id + ".log")
    entry = {"id": run_id, "target": target, **info, "start": int(start), "end": None, "status": "running", "step": None}
    runs.insert(0, entry)
    deploy_publish(args, runs, gid)
    code = 0
    with open(log_path, "w", encoding="utf-8") as out, tempfile.TemporaryDirectory(prefix="glsc-deploy-") as work:
        os.chown(log_path, 0, gid)

        def note(text):
            out.write(text + "\n")
            out.flush()

        try:
            note(f"== {time.strftime('%d/%m/%Y %H:%M:%S')} · déploiement « {target} »" + (f" · {info['sha'][:7]} {info['message']}" if info.get("sha") else ""))
            note("== téléchargement du dépôt portfolio")
            tgz = os.path.join(work, "src.tgz")
            urllib.request.urlretrieve(REPO_TGZ, tgz)
            with tarfile.open(tgz) as tar:
                tar.extractall(work, filter="data")
            src = next(p for p in glob.glob(os.path.join(work, "*")) if os.path.isdir(p))
            env = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/root", "LANG": "C.UTF-8",
                   "TERM": "dumb", "GLSC_AUTO_DEPLOY": "1"}
            for script, extra in DEPLOY_PLANS[target]:
                entry["step"] = os.path.basename(script) + "".join(f" {k}={v}" for k, v in extra.items())
                deploy_publish(args, runs, gid)
                note(f"\n== {entry['step']}")
                proc = subprocess.Popen(["bash", os.path.join(src, script)], cwd=work, env={**env, **extra}, stdin=subprocess.DEVNULL,
                                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace", start_new_session=True)
                watchdog = threading.Timer(DEPLOY_STEP_TIMEOUT, lambda p=proc: os.killpg(p.pid, 9))  # script bloqué : on coupe tout
                watchdog.start()
                try:
                    for line in proc.stdout:
                        out.write(ANSI.sub("", line))
                    code = proc.wait()
                finally:
                    watchdog.cancel()
                if code == -9:
                    note(f"!! délai de {DEPLOY_STEP_TIMEOUT // 60} min dépassé, script arrêté")
                out.flush()
                if code != 0:
                    note(f"!! {os.path.basename(script)} a échoué (code {code})")
                    break
        except Exception as e:
            code = code or 1
            note(f"!! {type(e).__name__}: {e}")
    entry.update(end=int(time.time()), status="ok" if code == 0 else "fail", code=code, step=None)
    deploy_publish(args, runs, gid)
    took = entry["end"] - entry["start"]
    took_txt = f"{took // 60} min {took % 60:02d} s" if took >= 60 else f"{took} s"
    what = f"`{info['sha'][:7]}` {info['message']}" if info.get("sha") else "lancé depuis l'admin"
    log(f"déploiement {target} :", entry["status"], took_txt)
    if alert_on:
        if code == 0:
            discord(hook, f"✅ {target} déployé", f"{what}\nDurée : {took_txt}", 0x22C55E)
        else:
            try:
                with open(log_path, encoding="utf-8") as f:
                    tail = "".join(f.readlines()[-12:])[-1500:]
            except OSError:
                tail = ""
            discord(hook, f"❌ Déploiement de {target} raté", f"{what}\nJournal complet dans l'admin (GitHub & déploiements).\n```\n{tail}\n```", 0xEF4444)
    return code


def deploy(args):
    import fcntl
    gid = www_gid()
    os.makedirs("/run/lock", exist_ok=True)
    with open("/run/lock/glsc-deploy.lock", "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            log("un déploiement est déjà en cours : les demandes attendront la fin")
            return
        runs = load_json(os.path.join(args.pub_dir, "deploy-runs.json"), {}).get("runs", [])
        for r in runs:  # un déploiement interrompu (redémarrage du serveur…) n'est plus « en cours »
            if r.get("status") == "running":
                r.update(status="fail", end=r.get("end") or int(time.time()), step=None)
        while True:
            todo = deploy_requests(args)
            if not todo:
                break
            settings = app_settings(args.app_db)
            for target, info in todo:
                deploy_run(args, target, info, runs, gid, settings.get("discord_webhook", ""), settings.get("alert_deploy", "1") == "1")
        deploy_publish(args, runs, gid)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["collect", "queue", "deploy", "recap"])
    ap.add_argument("--semaine", action="store_true", help="recap : la semaine dernière complète (lundi → dimanche) au lieu des 7 derniers jours")
    ap.add_argument("--apercu", action="store_true", help="recap : affiche le récap ici sans l'envoyer sur Discord")
    ap.add_argument("--var", default="/var/lib/glsc-admin", help="dossier de données de l'admin")
    ap.add_argument("--log", default="/var/log/nginx/glsc-access.log")
    ap.add_argument("--letsencrypt", default="/etc/letsencrypt/live")
    ap.add_argument("--backups", default="/root/glsc-backups")
    ap.add_argument("--games-src", default="/opt/glsc-games/src")
    ap.add_argument("--games-data", default="/var/lib/glsc-games", help="results.jsonl de chaque jeu")
    ap.add_argument("--leaderboard-json", default="/var/www/games.glsc.fr/leaderboard.json", help="classements publics")
    ap.add_argument("--version-file", default="/etc/glsc-admin/portfolio-version.json")
    ap.add_argument("--status-webhook", default="/etc/glsc-status/discord-webhook")
    ap.add_argument("--status-json", default="/var/www/status.glsc.fr/status.json", help="incidents (récap du lundi)")
    ap.add_argument("--github-user", default="gabinlsc")
    ap.add_argument("--projects-json", default="/var/www/share.glsc.fr/github.json", help="activité publique lue par la page Projets")
    ap.add_argument("--offline", action="store_true", help="ne pas appeler GitHub (tests)")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()
    args.state_dir = os.path.join(args.var, "collector")
    args.pub_dir = os.path.join(args.var, "pub")
    args.queue_dir = os.path.join(args.var, "queue")
    args.deploy_dir = os.path.join(args.var, "deploy")
    args.app_db = os.path.join(args.var, "app", "app.db")
    os.umask(0o027)
    if args.command == "collect":
        collect(args)
    elif args.command == "deploy":
        deploy(args)
    elif args.command == "recap":
        ok = recap_now(args, "semaine" if args.semaine else "7j", args.apercu)
        print("Récap envoyé sur Discord." if ok and not args.apercu else "" if ok else "Envoi impossible (voir le message ci-dessus).")
        sys.exit(0 if ok else 1)
    else:
        queue(args)


if __name__ == "__main__":
    main()
