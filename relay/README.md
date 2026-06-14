# clubhouse simulator relay

Runs on each bay PC. Captures every shot from the launch monitor by
proxying GSPro's OpenAPI Connect protocol, and writes the shots to the
clubhouse Supabase project so they show up in the player-facing stats
canvas inside the Optix app.

```
[Uneekor LM] --:9999--> [relay.py] --:921--> [GSPro]
                            |
                            +--HTTPS--> Supabase  (sessions, shots)
                            |
                            +--http://localhost:8080  (player sign-in UI)
```

The launch monitor still talks GSPro OpenAPI Connect — it just sends to
the relay instead of directly to GSPro. The relay forwards every byte to
GSPro untouched, so the simulator round behaves exactly the same. Shots
are silently logged in the background under whichever player is signed in
at this bay.

Single-file Python (stdlib only). No `pip install` needed.

## Prereqs

- Windows 10/11 (the bay PCs).
- Python 3.8+ on PATH (`python --version` should work in PowerShell).
  Install from python.org and tick "Add Python to PATH".
- GSPro installed and configured to use the OpenAPI Connect server on
  port 921 (the default). Confirm in GSPro Settings → Game → "Open API
  Server" is on.
- A `display_name` row in the Supabase `players` table for every member
  who'll be signing in. (Players show up via Optix membership in the
  normal flow; if your sync is wired up they should already be there.)

## Install

1. Copy the entire `relay/` folder to the bay PC. Anywhere is fine, e.g.
   `C:\clubhouse-relay\`.
2. Duplicate `.env.example` as `.env` next to `relay.py`.
3. Open `.env` and fill in:
   - `CLUBHOUSE_SUPABASE_SERVICE_KEY` — Supabase project Settings → API →
     `service_role` key. **Do not** commit this file.
   - `CLUBHOUSE_BAY_NUMBER` — the bay number for this PC (1, 2, 3, …).
4. Point the launch monitor at the relay instead of GSPro:
   - **Uneekor View** → Settings → 3rd Party → GSPro: change host/port to
     `127.0.0.1:9999` (or wherever `CLUBHOUSE_LM_PORT` is bound). Leave
     GSPro itself on `127.0.0.1:921`.
   - GSPro stays as-is — it keeps listening on 921.

## Run it

From PowerShell in the relay folder:

```powershell
python relay.py
```

You should see:

```
[relay] bay 1 starting
[ui] http://localhost:8080
[proxy] listening on :9999 → 127.0.0.1:921
```

Open `http://localhost:8080` on the sim PC (or any device on the bay LAN),
search for the player, tap them — that's it. Every shot from that point
on lands in Supabase under their `player_id`. Tap "end session" when they
finish, or let the inactivity timer (default 45 min) close it.

## Run on startup (Windows scheduled task)

Open PowerShell **as Administrator** in the relay folder and run:

```powershell
.\install.ps1
```

This creates a `ClubhouseRelay` scheduled task that runs at system
startup as SYSTEM and auto-restarts every minute if it crashes. To stop:

```powershell
Stop-ScheduledTask -TaskName ClubhouseRelay
Unregister-ScheduledTask -TaskName ClubhouseRelay -Confirm:$false
```

Logs from a SYSTEM-run task go to the Event Viewer / Task Scheduler's
own history. For richer logs, wrap the task action in a redirect (edit
the task in Task Scheduler, append ` *> C:\clubhouse-relay\relay.log` to
the arguments).

## What ends up in Supabase

The relay writes two tables. Column names match what `stats.html`
already reads, but adjust them if your project's schema is different —
the mapping lives at the top of `record_shot()` in `relay.py`.

- `sessions`: one row per player sign-in.
  - `player_id`, `bay_number`, `started_at`, `ended_at`, `shot_count`
- `shots`: one row per swing.
  - `session_id`, `player_id`, `shot_number`, `ball_speed`,
    `carry_distance`, `total_spin`, `back_spin`, `side_spin`,
    `spin_axis`, `launch_angle`, `launch_direction`, `club_speed`,
    `angle_of_attack`, `face_to_target`, `club_path`, `club_loft`,
    `device_id`, `units`, plus a `raw` jsonb of the full shot payload.

## Round / hole data

GSPro's OpenAPI Connect protocol only sends per-shot data outward; it
doesn't push hole / round context. If you want score per hole later,
two options:

1. Parse GSPro's local shot log file (path varies by build) on the same
   PC and stitch it to the relay's session by timestamp.
2. Read scorecards from the GSPro Roundfile after each round finishes.

Both are write-ups for later — the per-shot stream is enough for the
current canvas.

## Troubleshooting

- **"cannot reach GSPro at 127.0.0.1:921"** — GSPro isn't running or the
  OpenAPI server is off. Open GSPro, check the green "API" indicator.
- **"no player signed in" in logs, shots not landing** — the launch
  monitor is connected and shots are flowing through to GSPro fine, but
  nobody's tapped a player in the local UI. Open `http://localhost:8080`.
- **"http 401" / "http 403"** from Supabase — wrong service_role key in
  `.env`, or you're using the `anon` key by mistake.
- **GSPro shows shots but nothing logs** — Uneekor is still pointing at
  GSPro directly. Update its GSPro target host:port to the relay.
- **Relay logs every shot twice** — there are two LM-side connections,
  most likely Uneekor + Awesome Golf both pointing at the relay. Only
  one should.
