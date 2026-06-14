#!/usr/bin/env python3
"""
Clubhouse simulator relay.

Sits between the launch monitor (Uneekor, etc.) and GSPro on a bay PC,
speaking GSPro's OpenAPI Connect protocol. Every shot is forwarded to
GSPro untouched AND written to Supabase against the player currently
signed in at this bay.

Topology
--------
    [Launch Monitor] --LM_PORT--> [relay.py] --GSPRO_PORT--> [GSPro]
                                       |
                                       +--HTTPS--> Supabase

The relay also serves a small local web UI on UI_PORT for picking the
current player and ending sessions. Open it on the sim PC, a tablet, or
a phone on the same LAN.

Single file, Python 3.8+, stdlib only. Run with `python relay.py`.
Configuration via environment or a sibling `.env` file (see `.env.example`).
"""

import json
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer


# ── config ────────────────────────────────────────────────────────────────

def load_env_file(path):
    if not os.path.exists(path):
        return
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, _, val = line.partition('=')
            val = val.strip().strip('"').strip("'")
            os.environ.setdefault(key.strip(), val)


HERE = os.path.dirname(os.path.abspath(__file__))
load_env_file(os.path.join(HERE, '.env'))

LM_PORT     = int(os.environ.get('CLUBHOUSE_LM_PORT', '9999'))
GSPRO_HOST  = os.environ.get('CLUBHOUSE_GSPRO_HOST', '127.0.0.1')
GSPRO_PORT  = int(os.environ.get('CLUBHOUSE_GSPRO_PORT', '921'))
UI_PORT     = int(os.environ.get('CLUBHOUSE_UI_PORT', '8080'))
BAY_NUMBER  = int(os.environ.get('CLUBHOUSE_BAY_NUMBER', '1'))
SUPA_URL    = os.environ.get('CLUBHOUSE_SUPABASE_URL', '').rstrip('/')
SUPA_KEY    = os.environ.get('CLUBHOUSE_SUPABASE_SERVICE_KEY', '')
SESSION_TIMEOUT_MIN = int(os.environ.get('CLUBHOUSE_SESSION_TIMEOUT_MIN', '45'))


def require_env():
    missing = []
    if not SUPA_URL: missing.append('CLUBHOUSE_SUPABASE_URL')
    if not SUPA_KEY: missing.append('CLUBHOUSE_SUPABASE_SERVICE_KEY')
    if missing:
        print(f'[relay] missing required env: {", ".join(missing)}', file=sys.stderr)
        print( '[relay] copy .env.example to .env and fill in the values', file=sys.stderr)
        raise SystemExit(1)


# ── supabase rest client ──────────────────────────────────────────────────

def supa(method, path, payload=None, params=None):
    url = SUPA_URL + '/rest/v1' + path
    if params:
        url += '?' + urllib.parse.urlencode(params)
    body = json.dumps(payload).encode('utf-8') if payload is not None else None
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header('apikey', SUPA_KEY)
    req.add_header('Authorization', f'Bearer {SUPA_KEY}')
    req.add_header('Content-Type', 'application/json')
    req.add_header('Prefer', 'return=representation')
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = resp.read()
        return json.loads(data) if data else None


# ── per-bay session state ─────────────────────────────────────────────────

state_lock = threading.Lock()
state = {
    'player_id': None,
    'player_name': None,
    'session_id': None,
    'shot_count': 0,
    'last_shot_at': None,   # unix seconds, for inactivity timer
    'started_at': None,     # ISO 8601, persisted on the session row
}


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def _end_session_locked():
    sid = state['session_id']
    if not sid:
        return
    try:
        supa('PATCH', '/sessions',
             payload={'ended_at': now_iso(), 'shot_count': state['shot_count']},
             params={'id': f'eq.{sid}'})
        print(f'[session] ended {sid} after {state["shot_count"]} shots')
    except Exception as e:
        print(f'[session] failed to close {sid}: {e}', file=sys.stderr)
    state['session_id']   = None
    state['shot_count']   = 0
    state['last_shot_at'] = None
    state['started_at']   = None


def sign_in(player_id, player_name):
    with state_lock:
        if state['session_id']:
            _end_session_locked()
        state['player_id']   = player_id
        state['player_name'] = player_name
    print(f'[session] signed in: {player_name} ({player_id})')


def sign_out():
    with state_lock:
        _end_session_locked()
        state['player_id']   = None
        state['player_name'] = None


def inactivity_watcher():
    while True:
        time.sleep(60)
        with state_lock:
            if state['session_id'] and state['last_shot_at']:
                idle_min = (time.time() - state['last_shot_at']) / 60
                if idle_min > SESSION_TIMEOUT_MIN:
                    print(f'[session] inactivity timeout after {idle_min:.0f}m')
                    _end_session_locked()
                    state['player_id']   = None
                    state['player_name'] = None


# ── shot ingestion ────────────────────────────────────────────────────────

def record_shot(shot):
    """Called for each LM->GSPro JSON message that contains ball data."""
    with state_lock:
        player_id = state['player_id']
        if not player_id:
            print('[shot] dropped: no player signed in')
            return

        if not state['session_id']:
            started = now_iso()
            try:
                rows = supa('POST', '/sessions', payload={
                    'player_id':  player_id,
                    'bay_number': BAY_NUMBER,
                    'started_at': started,
                })
                state['session_id'] = rows[0]['id']
                state['started_at'] = started
                print(f'[session] started {state["session_id"]} for {state["player_name"]}')
            except Exception as e:
                print(f'[shot] dropped: could not open session: {e}', file=sys.stderr)
                return

        ball = shot.get('BallData') or {}
        club = shot.get('ClubData') or {}
        try:
            supa('POST', '/shots', payload={
                'session_id':       state['session_id'],
                'player_id':        player_id,
                'shot_number':      shot.get('ShotNumber'),
                'units':            shot.get('Units'),
                'device_id':        shot.get('DeviceID'),
                'ball_speed':       ball.get('Speed'),
                'carry_distance':   ball.get('CarryDistance'),
                'total_spin':       ball.get('TotalSpin'),
                'back_spin':        ball.get('BackSpin'),
                'side_spin':        ball.get('SideSpin'),
                'spin_axis':        ball.get('SpinAxis'),
                'launch_angle':     ball.get('VLA'),
                'launch_direction': ball.get('HLA'),
                'club_speed':       club.get('Speed'),
                'angle_of_attack':  club.get('AngleOfAttack'),
                'face_to_target':   club.get('FaceToTarget'),
                'club_path':        club.get('Path'),
                'club_loft':        club.get('Loft'),
                'raw':              shot,
            })
            state['shot_count']   += 1
            state['last_shot_at']  = time.time()
            carry = ball.get('CarryDistance', '?')
            bspd  = ball.get('Speed', '?')
            print(f'[shot] #{state["shot_count"]} {state["player_name"]}: {carry}yd carry / {bspd}mph')
        except Exception as e:
            print(f'[shot] write failed: {e}', file=sys.stderr)


# ── tcp proxy (LM <-> GSPro) ──────────────────────────────────────────────

def proxy_stream(src, dst, on_message=None):
    """Forward bytes src->dst. If on_message is given, also parse
    newline-delimited JSON from src and call on_message(obj) per object."""
    buf = b''
    try:
        while True:
            data = src.recv(8192)
            if not data:
                break
            try:
                dst.sendall(data)
            except OSError:
                break
            if on_message:
                buf += data
                while b'\n' in buf:
                    line, buf = buf.split(b'\n', 1)
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    try:
                        on_message(obj)
                    except Exception as e:
                        print(f'[proxy] on_message error: {e}', file=sys.stderr)
    finally:
        try: src.shutdown(socket.SHUT_RD)
        except OSError: pass
        try: dst.shutdown(socket.SHUT_WR)
        except OSError: pass


def handle_lm_connection(lm_sock, lm_addr):
    print(f'[proxy] LM connected from {lm_addr[0]}:{lm_addr[1]}')
    try:
        gs_sock = socket.create_connection((GSPRO_HOST, GSPRO_PORT), timeout=5)
    except OSError as e:
        print(f'[proxy] cannot reach GSPro at {GSPRO_HOST}:{GSPRO_PORT}: {e}', file=sys.stderr)
        lm_sock.close()
        return

    def on_lm_message(msg):
        opts = msg.get('ShotDataOptions') or {}
        if opts.get('IsHeartBeat'):
            return
        if opts.get('ContainsBallData'):
            record_shot(msg)

    t1 = threading.Thread(target=proxy_stream, args=(lm_sock, gs_sock, on_lm_message), daemon=True)
    t2 = threading.Thread(target=proxy_stream, args=(gs_sock, lm_sock, None), daemon=True)
    t1.start(); t2.start()
    t1.join(); t2.join()

    try: lm_sock.close()
    except OSError: pass
    try: gs_sock.close()
    except OSError: pass
    print(f'[proxy] LM disconnected from {lm_addr[0]}:{lm_addr[1]}')


def start_tcp_server():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(('0.0.0.0', LM_PORT))
    s.listen(5)
    print(f'[proxy] listening on :{LM_PORT} → {GSPRO_HOST}:{GSPRO_PORT}')
    while True:
        c, addr = s.accept()
        threading.Thread(target=handle_lm_connection, args=(c, addr), daemon=True).start()


# ── local web ui ──────────────────────────────────────────────────────────

INDEX_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>clubhouse bay relay</title>
<style>
:root { --green:#0d2618; --green2:#14331f; --cream:#ede4cf; --maroon:#5b1d1d; --blue:#b6d3df; }
* { box-sizing:border-box; margin:0; padding:0; }
body { background:var(--green); color:var(--cream); font-family: system-ui, sans-serif; padding:24px; min-height:100vh; }
h1 { text-transform:uppercase; letter-spacing:-1px; font-size:32px; }
.sub { opacity:.55; font-size:11px; letter-spacing:2px; text-transform:uppercase; margin: 4px 0 24px; }
.card { background:var(--green2); border-radius:12px; padding:20px; margin-bottom:16px; }
.label { font-size:9px; letter-spacing:2.5px; text-transform:uppercase; opacity:.55; margin-bottom:6px; }
.value { font-size:24px; font-weight:600; }
.meta  { margin-top:8px; font-size:13px; opacity:.6; }
input[type=text] { width:100%; background:transparent; border:1px solid rgba(237,228,207,.2); color:var(--cream); padding:12px 14px; border-radius:8px; font-size:15px; margin-bottom:12px; }
input[type=text]:focus { outline:none; border-color:var(--cream); }
.player { padding:12px 14px; background:var(--green); border-radius:8px; cursor:pointer; margin-bottom:6px; display:flex; justify-content:space-between; align-items:center; }
.player:hover { background:#0a1e12; }
.player .em { opacity:.5; font-size:10px; letter-spacing:1.5px; text-transform:uppercase; }
button { background:var(--maroon); color:var(--cream); border:0; padding:12px 22px; border-radius:50px; font-size:11px; letter-spacing:2px; text-transform:uppercase; cursor:pointer; margin-top:8px; }
.empty { opacity:.5; font-size:13px; padding:8px 0; }
.err { color: #f4b6b6; font-size:13px; padding:8px 0; }
</style>
</head>
<body>
<h1>bay <span id="bay">?</span></h1>
<div class="sub">clubhouse simulator relay</div>

<div class="card">
  <div class="label">currently playing</div>
  <div class="value" id="player">—</div>
  <div class="meta" id="meta">no one signed in</div>
  <div id="actions"></div>
</div>

<div class="card">
  <div class="label">sign in a player</div>
  <input type="text" id="search" placeholder="search by name…" autocomplete="off">
  <div id="results"><div class="empty">start typing to search…</div></div>
</div>

<script>
async function refresh() {
  try {
    const r = await fetch('/status').then(r => r.json());
    document.getElementById('bay').textContent = r.bay_number;
    document.getElementById('player').textContent = r.player_name || '—';
    if (r.player_name) {
      const since = r.started_at ? ' · since ' + new Date(r.started_at).toLocaleTimeString() : '';
      document.getElementById('meta').textContent = `${r.shot_count} shots${since}`;
      document.getElementById('actions').innerHTML = '<button onclick="endSession()">end session</button>';
    } else {
      document.getElementById('meta').textContent = 'no one signed in';
      document.getElementById('actions').innerHTML = '';
    }
  } catch (e) {}
}
let searchTimer;
async function doSearch(q) {
  const el = document.getElementById('results');
  if (!q) { el.innerHTML = '<div class="empty">start typing to search…</div>'; return; }
  try {
    const rows = await fetch('/players?q=' + encodeURIComponent(q)).then(r => r.json());
    if (!rows.length) { el.innerHTML = '<div class="empty">no matches</div>'; return; }
    el.innerHTML = '';
    for (const p of rows) {
      const row = document.createElement('div');
      row.className = 'player';
      row.innerHTML = `<span></span><span class="em">tap to start</span>`;
      row.firstChild.textContent = p.display_name;
      row.onclick = () => signIn(p.id, p.display_name);
      el.appendChild(row);
    }
  } catch (e) {
    el.innerHTML = '<div class="err">' + (e.message || e) + '</div>';
  }
}
async function signIn(id, name) {
  await fetch('/session/start', { method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ player_id: id, display_name: name }) });
  document.getElementById('search').value = '';
  doSearch('');
  refresh();
}
async function endSession() {
  await fetch('/session/end', { method: 'POST' });
  refresh();
}
document.getElementById('search').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => doSearch(e.target.value.trim()), 200);
});
refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>"""


class UIHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return  # quiet

    def _json(self, code, payload):
        body = json.dumps(payload).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send(self, code, ctype, body):
        if isinstance(body, str):
            body = body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == '/':
            return self._send(200, 'text/html; charset=utf-8', INDEX_HTML)
        if u.path == '/status':
            with state_lock:
                return self._json(200, {
                    'bay_number':  BAY_NUMBER,
                    'player_id':   state['player_id'],
                    'player_name': state['player_name'],
                    'session_id':  state['session_id'],
                    'shot_count':  state['shot_count'],
                    'started_at':  state['started_at'],
                })
        if u.path == '/players':
            q = (urllib.parse.parse_qs(u.query).get('q') or [''])[0].strip()
            params = {'select': 'id,display_name', 'order': 'display_name.asc', 'limit': '20'}
            if q:
                params['display_name'] = f'ilike.%{q}%'
            try:
                rows = supa('GET', '/players', params=params)
            except urllib.error.HTTPError as e:
                return self._json(e.code, {'error': e.read().decode('utf-8', 'ignore')})
            except Exception as e:
                return self._json(500, {'error': str(e)})
            return self._json(200, rows or [])
        return self._send(404, 'text/plain', 'not found')

    def do_POST(self):
        length = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(length) if length else b''
        try:
            payload = json.loads(body) if body else {}
        except json.JSONDecodeError:
            return self._json(400, {'error': 'invalid json'})
        if self.path == '/session/start':
            pid  = payload.get('player_id')
            name = payload.get('display_name') or 'player'
            if not pid:
                return self._json(400, {'error': 'player_id required'})
            sign_in(pid, name)
            return self._json(200, {'ok': True})
        if self.path == '/session/end':
            sign_out()
            return self._json(200, {'ok': True})
        return self._send(404, 'text/plain', 'not found')


def start_ui_server():
    srv = HTTPServer(('0.0.0.0', UI_PORT), UIHandler)
    print(f'[ui] http://localhost:{UI_PORT}')
    srv.serve_forever()


# ── entrypoint ────────────────────────────────────────────────────────────

def main():
    require_env()
    print(f'[relay] bay {BAY_NUMBER} starting')
    threading.Thread(target=start_ui_server, daemon=True).start()
    threading.Thread(target=inactivity_watcher, daemon=True).start()
    try:
        start_tcp_server()
    except KeyboardInterrupt:
        print('[relay] shutting down')
        sign_out()


if __name__ == '__main__':
    main()
