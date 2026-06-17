// Supabase Edge Function: stats
//
// Single endpoint backing the public stats canvas at stats.clubhousegolf.nyc.
// Authenticates with an Optix user token (anti-spoof: token's user_id must
// match ?user_id), then reads from Supabase using the service_role key and
// returns one of three view shapes: session | history | trends.
//
// Query params:
//   view    = 'session' | 'history' | 'trends'   (required)
//   user_id = Optix user_id (anti-spoof)          (required)
//   club    = club code or 'all'                  (optional, defaults to 'all')
//
// Token is read from the Authorization: Bearer <token> request header — NEVER
// from the URL query string (avoids leaking to logs, history, referrers).
//
// All aggregation is inlined as direct PostgREST queries — no RPCs assumed to
// exist on the database.

// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// ---------------------------------------------------------------------------
// Types — response shapes the canvas consumes
// ---------------------------------------------------------------------------

interface Player {
  display_name: string | null;
  optix_user_id: string;
}

interface SessionMeta {
  id: string;                       // canonical sessions row (latest matching booking)
  bay_number: number | null;
  started_at: string;               // ISO
  ended_at: string | null;          // ISO or null = still open
  shot_count: number;
  optix_booking_id: string | null;
  session_open: boolean;
  duration_minutes: number | null;  // null when still open
  clubs_used: string[];             // distinct, null bucket excluded
}

interface HeroBlock {
  selected_club: "all" | string;
  avg_carry: number | null;                      // headline carry — mean across filtered shots
  best_carry: number | null;                     // retained for back-compat; still useful in by-club
  best_carry_club: string | null;
  total_carry: number | null;
  total_shots: number;
  sparkline_max_carry: number[];                 // last 6 sessions of max carry
  delta_vs_previous_session: number | null;      // avg_carry delta vs prev session
  // "Club of the day" — same shape as the takeaway STRENGTH line. When set,
  // the canvas swaps the AVG-CARRY hero for a big club-name display + the
  // observation text. Re-uses pickTakeawayObservations so the threshold
  // logic stays in one place.
  featured_strength: TakeawayLine | null;
}

interface StatWithDelta {
  avg: number | null;
  delta: number | null;
}

interface StatWithWord {
  avg: number | null;
  word: string | null;   // e.g. "in-to-out", "square"
}

interface StatsBlock {
  ball_speed: StatWithDelta;
  vla: StatWithDelta;
  smash: StatWithDelta;
  club_path: StatWithWord;
  face_to_path: StatWithWord;
}

interface ByClubRow {
  club: string | null;       // null bucket appended last
  shots: number;
  max_carry: number | null;
  avg_carry: number | null;
  smash_avg: number | null;
  face_avg: number | null;
}

interface TakeawayLine {
  club: string;        // club code (e.g., "IRON7"); canvas formats display name
  text: string;        // pre-formatted; "{club}" placeholder for client-side label substitution
}

interface TakeawayBlock {
  peak_smash: number | null;
  peak_smash_club: string | null;
  longest_club: string | null;
  longest_carry: number | null;
  longest_club_avg_face: number | null;
  longest_club_face_word: string | null;
  most_hit_club: string | null;
  most_hit_shots: number | null;
  // Physics-based observations. Both nullable — when no club has 5+ shots,
  // or when no candidate observation crosses its trigger threshold, the
  // corresponding line is omitted entirely (no forced compliment / nag).
  strength: TakeawayLine | null;
  watch: TakeawayLine | null;
  fallback_text: string | null;   // shown when we don't have enough data
}

interface SessionResponse {
  player: Player;
  session: SessionMeta | null;
  hero: HeroBlock;
  stats: StatsBlock;
  by_club: ByClubRow[];
  takeaway: TakeawayBlock;
}

// ----- Per-club detail view ---------------------------------------------------

interface ClubMetric {
  avg: number | null;
  // Position vs benchmark window: "in" (inside), "above" / "below" (outside),
  // "n/a" (no benchmark for this club, or no shot data).
  status: "in" | "above" | "below" | "n/a";
}

interface ClubDetailShot {
  shot_number: number;          // 1-indexed for display order
  recorded_at: string | null;
  carry_distance: number | null;
  ball_speed: number | null;
  club_speed: number | null;
  vla: number | null;
  smash: number | null;
  attack_angle: number | null;
  total_spin: number | null;
  club_path: number | null;
  face_to_target: number | null;
  face_to_path: number | null;
}

interface ClubDetailResponse {
  player: Player;
  club: string;                 // club code, canvas formats display name
  total_shots: number;
  avg_carry: number | null;
  best_carry: number | null;
  carry_std_dev: number | null;
  avg_ball_speed: number | null;
  avg_club_speed: number | null;
  avg_total_spin: number | null;
  metrics: {
    smash: ClubMetric;
    launch: ClubMetric;
    attack: ClubMetric;
    spin: ClubMetric;
  };
  benchmarks: {
    smash: [number, number] | null;
    launch: [number, number] | null;
    attack: [number, number] | null;
    spin: [number, number] | null;
  };
  narrative: string | null;     // {club} placeholder substituted client-side
  shots: ClubDetailShot[];      // newest-first
}

interface HistorySessionRow {
  booking_id: string;                   // optix_booking_id (the dedup key); null rows are dropped
  started_at: string;                   // ISO of earliest session row for this booking
  ended_at: string | null;              // ISO of latest ended_at, null if any still open
  bay_number: number | null;
  shot_count: number;                   // SUM across grouped rows
  max_carry: number | null;
  sparkline: number[];                  // up to 6 shot carry samples for this booking
  shots_logged_clubs: string[];
}

interface HistoryResponse {
  sessions: HistorySessionRow[];
}

interface TrendsSeriesPoint {
  date: string;     // ISO date (yyyy-mm-dd)
  value: number;
}

interface TrendsChart {
  series: TrendsSeriesPoint[];
  current: number | null;
  delta_vs_previous: number | null;
}

interface LifetimeClubRow {
  club: string;
  shots: number;
}

interface TrendsReadyResponse {
  ready: true;
  total_sessions: number;
  selected_club: "all" | string;
  lifetime_clubs: LifetimeClubRow[];
  charts: {
    carry: TrendsChart;
    ball_speed: TrendsChart;
    smash: TrendsChart;
  };
}

interface TrendsNotReadyResponse {
  ready: false;
  total_sessions: number;
  selected_club: "all" | string;
  lifetime_clubs: LifetimeClubRow[];
}

type TrendsResponse = TrendsReadyResponse | TrendsNotReadyResponse;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPTIX_GRAPHQL_URL = "https://api.optixapp.com/graphql";
// Item #8 — default closed. DENO_DEPLOYMENT_ID is not reliably populated on
// Supabase Edge Functions, so falling back on it leaked raw error.message in
// prod. Treat anything except an explicit `ENVIRONMENT=development` as prod.
const IS_PROD = (Deno.env.get("ENVIRONMENT") ?? "production") !== "development";

// Item #14 — cap the Optix token-validation call so a slow Optix can't pin a
// stats request to the 60s function ceiling.
const OPTIX_TIMEOUT_MS = 4000;

// Item #15 — "null" origin is for file:// during local dev; never accept it
// in production. Build the allowlist conditionally on IS_PROD.
const ALLOWED_ORIGINS = new Set<string>(
  [
    "https://liam580.github.io",
    "https://stats.clubhousegolf.nyc",
    "http://localhost:8000",
    !IS_PROD ? "null" : null,
  ].filter((s): s is string => s !== null),
);

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const base: Record<string, string> = {
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
  };
  if (ALLOWED_ORIGINS.has(origin)) {
    base["Access-Control-Allow-Origin"] = origin;
  }
  return base;
}

function jsonResponse(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(req) },
  });
}

// Whitelist of safe-to-expose reason codes for unauthorized failures.
// validateOptixToken() emits these — they're enum values with no user data,
// so it's safe to surface them in the response body (helps in-app diagnostics
// since Supabase function logs are dashboard-only). The `optix_fetch_failed:`
// variant carries an exception message; we strip everything after the colon.
const SAFE_AUTH_REASONS = new Set([
  "no_user_id_in_optix_response",
  "user_id_mismatch",
  "optix_timeout",
  "optix_fetch_failed",
]);

function sanitizeReason(raw: unknown): string {
  const s = String(raw ?? "");
  if (s.startsWith("optix_status_")) return s; // optix_status_XXX is safe
  const head = s.split(":")[0];
  return SAFE_AUTH_REASONS.has(head) ? head : "unknown";
}

function errorResponse(
  req: Request,
  status: number,
  code: string,
  internalDetail?: unknown,
  extras?: Record<string, unknown>,
): Response {
  // Never leak raw error.message in production responses; just log it.
  if (internalDetail !== undefined) {
    console.error(`[stats] error ${status} ${code}:`, internalDetail, extras ?? "");
  }
  const body: Record<string, unknown> = { error: code };
  if (!IS_PROD && internalDetail !== undefined) {
    body.detail = String(internalDetail);
  } else {
    body.detail = "internal error";
  }
  // For 401 unauthorized, also expose a short sanitized reason_code so the
  // canvas can show why auth failed (dashboard logs aren't always available).
  if (status === 401 && code === "unauthorized" && internalDetail !== undefined) {
    body.reason_code = sanitizeReason(internalDetail);
  }
  if (extras) {
    for (const [k, v] of Object.entries(extras)) {
      body[k] = v;
    }
  }
  return jsonResponse(req, body, status);
}

// ---------------------------------------------------------------------------
// Optix token validation (anti-spoof)
// ---------------------------------------------------------------------------

interface OptixMeResponse {
  data?: {
    me?: {
      user?: {
        user_id?: string;
      };
    };
  };
  errors?: unknown;
}

// Resolve the canvas viewer's identity from the bearer token, not from the
// URL. Optix's `{user_id}` URL macro isn't reliably substituted (we've seen
// it pass through as the literal string "{user_id}"), so trusting the URL
// param means the DB lookup whiffs every time. Calling Optix's `me` query
// with the token returns the actual logged-in user's user_id — that's the
// value the relay stores as `players.optix_user_id`, so the lookup hits.
//
// This is also the v1 behavior: v1's README explicitly described "validates
// the token server-side and returns the player's stats", which is what's
// happening here.
async function validateOptixToken(
  token: string,
): Promise<{ ok: true; userId: string } | { ok: false; reason: string }> {
  // Item #14 — bound the call so a slow Optix doesn't hang every stats request.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPTIX_TIMEOUT_MS);
  try {
    const res = await fetch(OPTIX_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        query: "query { me { user { user_id } } }",
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      return { ok: false, reason: `optix_status_${res.status}` };
    }

    const payload = (await res.json()) as OptixMeResponse;
    const verifiedId = payload?.data?.me?.user?.user_id;
    if (!verifiedId) {
      return { ok: false, reason: "no_user_id_in_optix_response" };
    }
    return { ok: true, userId: String(verifiedId) };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return { ok: false, reason: "optix_timeout" };
    }
    return { ok: false, reason: `optix_fetch_failed:${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Numeric / formatting helpers
// ---------------------------------------------------------------------------

function pathWord(degrees: number | null): string | null {
  if (degrees === null || degrees === undefined || Number.isNaN(degrees)) return null;
  if (Math.abs(degrees) < 0.5) return "square";
  return degrees < 0 ? "out-to-in" : "in-to-out";
}

function faceToPathWord(degrees: number | null): string | null {
  if (degrees === null || degrees === undefined || Number.isNaN(degrees)) return null;
  if (Math.abs(degrees) < 0.5) return "square";
  return degrees < 0 ? "closed" : "open";
}

function round1(n: number | null | undefined): number | null {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  return Math.round(n * 10) / 10;
}

function round0(n: number | null | undefined): number | null {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  return Math.round(n);
}

function minutesBetween(startIso: string, endIso: string | null): number | null {
  if (!endIso) return null;
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, Math.round((end - start) / 60000));
}

function safeDelta(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  return round1(current - previous);
}

function mean(xs: number[]): number | null {
  if (!xs.length) return null;
  let s = 0;
  for (const v of xs) s += v;
  return s / xs.length;
}

function maxOrNull(xs: number[]): number | null {
  if (!xs.length) return null;
  let m = -Infinity;
  for (const v of xs) if (v > m) m = v;
  return Number.isFinite(m) ? m : null;
}

function sumOrNull(xs: number[]): number | null {
  if (!xs.length) return null;
  let s = 0;
  for (const v of xs) s += v;
  return s;
}

function stdDev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  let sq = 0;
  for (const v of xs) sq += (v - m) * (v - m);
  return Math.sqrt(sq / xs.length);
}

function signedFixed(n: number, digits: number): string {
  const s = n.toFixed(digits);
  return n > 0 ? `+${s}` : s;
}

// ---------------------------------------------------------------------------
// Per-club benchmarks + STRENGTH/WATCH observation picker
//
// Benchmarks are population averages cited across launch-monitor / instruction
// literature (smash factor windows, optimal launch/spin windows, attack-angle
// direction). They are NOT player-specific — they describe what physics
// rewards on average. We use them only to make objective "in/out of window"
// claims, never to characterize a player's swing or shape.
// ---------------------------------------------------------------------------

interface ClubBench {
  smash: [number, number];    // efficiency window
  launch: [number, number];   // vertical launch angle window (degrees)
  attack: [number, number];   // attack angle window (degrees; sign matters)
  spin: [number, number];     // total spin window (RPM)
}

// Smash windows aligned to published PGA Tour averages (per the Practical Golf /
// Rapsodo / Tee It Up tables): each window = [Good-Range lower bound, Elite/Tour
// upper bound]. Iron/wedge values exceeding the upper bound are themselves a
// flag — they typically indicate strong-lofted "game improvement" irons, hot
// faces, or delofting at impact — so we WATCH that direction too (handled in
// generateCandidates). For a driver, 1.50 is the USGA legal ceiling; nothing
// above is physically possible without a calibration error.
function clubBenchmark(club: string | null): ClubBench | null {
  if (!club) return null;
  const c = club.toUpperCase();
  // Spin windows (RPM) cited across launch-monitor literature:
  //   driver       2200–2800   (low spin = max distance for given launch)
  //   3-wood       3000–3500
  //   hybrid/long  4500–6000
  //   mid iron     5500–7500   (7i ~6000–7000 per the Gemini PDF)
  //   9i/PW        8000–10000
  //   wedge        9000–12000  (spin is the whole point on scoring clubs)
  if (c === "DRIVER") return { smash: [1.45, 1.50], launch: [12, 17], attack: [2, 5],   spin: [2200, 2800] };
  if (c.startsWith("WOOD")) return { smash: [1.42, 1.48], launch: [11, 15], attack: [-1, 2], spin: [3000, 3500] };
  if (c.startsWith("HYBRID") || c === "IRON3" || c === "IRON4" || c === "IRON5") {
    return { smash: [1.36, 1.44], launch: [16, 21], attack: [-4, -2], spin: [4500, 6000] };
  }
  if (c === "IRON6" || c === "IRON7" || c === "IRON8") {
    return { smash: [1.30, 1.38], launch: [18, 23], attack: [-5, -3], spin: [5500, 7500] };
  }
  if (c === "IRON9" || c === "PW") {
    return { smash: [1.23, 1.32], launch: [24, 30], attack: [-6, -4], spin: [8000, 10000] };
  }
  if (c === "GW" || c === "SW" || c === "LW" || c === "WEDGE") {
    return { smash: [1.10, 1.25], launch: [28, 34], attack: [-8, -5], spin: [9000, 12000] };
  }
  return null;
}

// Whether the club is "irons or wedges" — these have an upper smash bound
// where exceeding it is itself a signal (delofting / hot face / strong lofts),
// unlike driver where higher is unambiguously better up to 1.50.
function isIronOrWedge(club: string): boolean {
  const c = club.toUpperCase();
  return c.startsWith("HYBRID") || c.startsWith("IRON") ||
    c === "PW" || c === "GW" || c === "SW" || c === "LW" || c === "WEDGE";
}

interface PerClubAgg {
  club: string;
  shots: number;
  avgSmash: number | null;
  avgLaunch: number | null;
  avgAttack: number | null;
  avgSpin: number | null;
  ballSpeedStdDev: number | null;
  carryStdDev: number | null;
}

function aggregatePerClub(shots: ShotRow[]): PerClubAgg[] {
  const groups = new Map<string, ShotRow[]>();
  for (const s of shots) {
    if (!s.club) continue;
    const list = groups.get(s.club) ?? [];
    list.push(s);
    groups.set(s.club, list);
  }
  const out: PerClubAgg[] = [];
  for (const [club, list] of groups) {
    const smashes = list.map((s) => s.smash).filter((v): v is number => v != null);
    const launches = list.map((s) => s.vla).filter((v): v is number => v != null);
    const attacks = list.map((s) => s.attack_angle).filter((v): v is number => v != null);
    const spins = list.map((s) => s.total_spin).filter((v): v is number => v != null);
    const speeds = list.map((s) => s.ball_speed).filter((v): v is number => v != null);
    const carries = list.map((s) => s.carry_distance).filter((v): v is number => v != null);
    out.push({
      club,
      shots: list.length,
      avgSmash: mean(smashes),
      avgLaunch: mean(launches),
      avgAttack: mean(attacks),
      avgSpin: mean(spins),
      ballSpeedStdDev: stdDev(speeds),
      carryStdDev: stdDev(carries),
    });
  }
  return out;
}

type Candidate = {
  kind: "strength" | "watch";
  club: string;
  text: string;     // "{club}" gets replaced client-side with the readable club label
  score: number;   // higher = more notable; used to pick top STRENGTH and top WATCH
};

function generateCandidates(agg: PerClubAgg, bench: ClubBench): Candidate[] {
  const out: Candidate[] = [];
  const c = agg.club;
  const n = agg.shots;

  // ===== STRENGTH candidates =====================================

  // Smash inside window — score by closeness to upper bound (i.e. "tour" end)
  if (agg.avgSmash != null) {
    const [lo, hi] = bench.smash;
    if (agg.avgSmash >= lo) {
      const inWindow = Math.min(agg.avgSmash, hi);
      const proximity = (inWindow - lo) / Math.max(0.001, hi - lo); // 0–1
      out.push({
        kind: "strength",
        club: c,
        text: `{club} smash factor ${agg.avgSmash.toFixed(2)} across ${n} shots — in the ${lo.toFixed(2)}–${hi.toFixed(2)} benchmark.`,
        score: 0.70 + proximity * 0.30,
      });
    }
  }

  // Attack angle in correct direction & inside window
  if (agg.avgAttack != null) {
    const [lo, hi] = bench.attack;
    if (agg.avgAttack >= lo && agg.avgAttack <= hi) {
      out.push({
        kind: "strength",
        club: c,
        text: `{club} attack angle ${signedFixed(agg.avgAttack, 1)}° avg across ${n} shots — in the ${signedFixed(lo, 0)} to ${signedFixed(hi, 0)}° window.`,
        score: 0.65,
      });
    }
  }

  // Launch angle inside window
  if (agg.avgLaunch != null) {
    const [lo, hi] = bench.launch;
    if (agg.avgLaunch >= lo && agg.avgLaunch <= hi) {
      const center = (lo + hi) / 2;
      const halfWidth = Math.max(0.001, (hi - lo) / 2);
      const proximity = 1 - Math.abs(agg.avgLaunch - center) / halfWidth;
      out.push({
        kind: "strength",
        club: c,
        text: `{club} launched ${agg.avgLaunch.toFixed(1)}° avg across ${n} shots — in the ${lo}–${hi}° window.`,
        score: 0.55 + proximity * 0.20,
      });
    }
  }

  // Repeatable ball speed (≥5 shots, std dev < 2 mph)
  if (agg.ballSpeedStdDev != null && n >= 5 && agg.ballSpeedStdDev < 2.0) {
    out.push({
      kind: "strength",
      club: c,
      text: `{club} ball speed varied ±${agg.ballSpeedStdDev.toFixed(1)} mph across ${n} shots — repeatable contact.`,
      score: 0.80 - (agg.ballSpeedStdDev / 2.0) * 0.20,
    });
  }

  // ===== WATCH candidates ========================================

  // Wrong-direction attack angle: club expects positive but result is negative
  // (or expects negative but result is positive). Deterministic geometry.
  if (agg.avgAttack != null) {
    const [aLo, aHi] = bench.attack;
    if (aLo >= 0 && agg.avgAttack < 0) {
      out.push({
        kind: "watch",
        club: c,
        text: `{club} attack angle ${signedFixed(agg.avgAttack, 1)}° avg across ${n} shots — hitting down on a club that benefits from an upward strike.`,
        score: 1.0,
      });
    } else if (aHi <= 0 && agg.avgAttack > 0) {
      out.push({
        kind: "watch",
        club: c,
        text: `{club} attack angle ${signedFixed(agg.avgAttack, 1)}° avg across ${n} shots — hitting up on a club that benefits from a downward strike.`,
        score: 1.0,
      });
    }
  }

  // Smash >0.10 below window low — off-center / energy-leaking contact
  if (agg.avgSmash != null) {
    const [lo, hi] = bench.smash;
    const gap = lo - agg.avgSmash;
    if (gap > 0.10) {
      out.push({
        kind: "watch",
        club: c,
        text: `{club} smash factor ${agg.avgSmash.toFixed(2)} across ${n} shots — well below the ${lo.toFixed(2)}–${hi.toFixed(2)} benchmark.`,
        score: 0.70 + Math.min(0.30, gap),
      });
    }
  }

  // Iron/wedge smash ABOVE the tour-elite upper bound. Cited cause profile
  // (per PGA Tour data tables): strong-lofted "game improvement" irons, a
  // hot/active face, or delofting the club at impact. None of these are
  // judgment calls about the player — they're the known mechanisms that
  // produce a smash factor above tour elite on an iron or wedge.
  if (agg.avgSmash != null && isIronOrWedge(c)) {
    const [lo, hi] = bench.smash;
    const over = agg.avgSmash - hi;
    if (over > 0.02) {
      out.push({
        kind: "watch",
        club: c,
        text: `{club} smash factor ${agg.avgSmash.toFixed(2)} across ${n} shots — above the ${lo.toFixed(2)}–${hi.toFixed(2)} tour-elite window. Common causes: strong-lofted irons, a hot face, or delofting at impact.`,
        score: 0.85 + Math.min(0.15, over),
      });
    }
  }

  // Launch >5° outside window
  if (agg.avgLaunch != null) {
    const [lo, hi] = bench.launch;
    if (agg.avgLaunch < lo - 5) {
      out.push({
        kind: "watch",
        club: c,
        text: `{club} launched ${agg.avgLaunch.toFixed(1)}° avg across ${n} shots — well below the ${lo}–${hi}° window.`,
        score: 0.80,
      });
    } else if (agg.avgLaunch > hi + 5) {
      out.push({
        kind: "watch",
        club: c,
        text: `{club} launched ${agg.avgLaunch.toFixed(1)}° avg across ${n} shots — well above the ${lo}–${hi}° window.`,
        score: 0.80,
      });
    }
  }

  // High carry dispersion (≥5 shots, std dev > 15 yds)
  if (agg.carryStdDev != null && n >= 5 && agg.carryStdDev > 15) {
    out.push({
      kind: "watch",
      club: c,
      text: `{club} carry varied ±${agg.carryStdDev.toFixed(0)} yds across ${n} shots — inconsistent contact-to-contact.`,
      score: 0.60 + Math.min(0.30, (agg.carryStdDev - 15) / 30),
    });
  }

  // Spin in window → STRENGTH; meaningfully outside → WATCH with context.
  if (agg.avgSpin != null) {
    const [lo, hi] = bench.spin;
    const v = agg.avgSpin;
    if (v >= lo && v <= hi) {
      const center = (lo + hi) / 2;
      const halfWidth = Math.max(1, (hi - lo) / 2);
      const proximity = 1 - Math.abs(v - center) / halfWidth;
      out.push({
        kind: "strength",
        club: c,
        text: `{club} spin ${Math.round(v)} rpm avg across ${n} shots — in the ${lo}–${hi} window.`,
        score: 0.60 + proximity * 0.20,
      });
    } else if (v < lo) {
      // Below window
      const ironLike = isIronOrWedge(c);
      const consequence = ironLike
        ? " — ball won't hold a green from approach"
        : " — flatter, longer-rolling flight";
      out.push({
        kind: "watch",
        club: c,
        text: `{club} spin ${Math.round(v)} rpm avg across ${n} shots — below the ${lo}–${hi} window${consequence}.`,
        score: 0.70,
      });
    } else {
      // Above window
      const ironLike = isIronOrWedge(c);
      const isDriver = c.toUpperCase() === "DRIVER";
      let consequence = "";
      if (isDriver) consequence = " — distance lost to lift, ball climbs and falls short";
      else if (ironLike) consequence = " — ballooning flight, shorter carry than ball speed implies";
      out.push({
        kind: "watch",
        club: c,
        text: `{club} spin ${Math.round(v)} rpm avg across ${n} shots — above the ${lo}–${hi} window${consequence}.`,
        score: 0.75,
      });
    }
  }

  return out;
}

function pickTakeawayObservations(shots: ShotRow[]): {
  strength: TakeawayLine | null;
  watch: TakeawayLine | null;
} {
  const aggs = aggregatePerClub(shots);
  const all: Candidate[] = [];
  for (const agg of aggs) {
    if (agg.shots < 5) continue; // need ≥5 same-club shots for any observation
    const bench = clubBenchmark(agg.club);
    if (!bench) continue;
    all.push(...generateCandidates(agg, bench));
  }
  const strengths = all.filter((c) => c.kind === "strength").sort((a, b) => b.score - a.score);
  const watches = all.filter((c) => c.kind === "watch").sort((a, b) => b.score - a.score);
  return {
    strength: strengths[0] ? { club: strengths[0].club, text: strengths[0].text } : null,
    watch: watches[0] ? { club: watches[0].club, text: watches[0].text } : null,
  };
}

// ---------------------------------------------------------------------------
// Raw shot row + inline aggregation
// ---------------------------------------------------------------------------

interface ShotRow {
  club: string | null;
  carry_distance: number | null;
  ball_speed: number | null;
  vla: number | null;
  smash: number | null;
  attack_angle: number | null;
  total_spin: number | null;
  club_path: number | null;
  face_to_target: number | null;
  face_to_path: number | null;
  created_at?: string | null;
}

// Multi-session variant — used when the canvas pins to a booking that may
// span more than one Supabase session (split-session legacy data).
async function shotsForSessionIds(
  sb: SupabaseClient,
  sessionIds: string[],
): Promise<ShotRow[]> {
  if (sessionIds.length === 0) return [];
  const { data, error } = await sb
    .from("shots")
    .select(
      "club, carry_distance, ball_speed, vla, club_speed, attack_angle, total_spin, face_to_target, path, recorded_at",
    )
    .in("session_id", sessionIds);
  if (error) {
    console.error("[stats] shots multi query failed", error);
    return [];
  }
  return (data ?? []).map((r: Record<string, unknown>): ShotRow => {
    const ballSpeed = r.ball_speed as number | null | undefined;
    const clubSpeed = r.club_speed as number | null | undefined;
    const faceToTarget = r.face_to_target as number | null | undefined;
    const path = r.path as number | null | undefined;
    return {
      club: (r.club as string | null) ?? null,
      carry_distance: (r.carry_distance as number | null) ?? null,
      ball_speed: ballSpeed ?? null,
      vla: (r.vla as number | null) ?? null,
      smash: ballSpeed != null && clubSpeed != null && clubSpeed > 0
        ? ballSpeed / clubSpeed
        : null,
      attack_angle: (r.attack_angle as number | null) ?? null,
      total_spin: (r.total_spin as number | null) ?? null,
      club_path: path ?? null,
      face_to_target: faceToTarget ?? null,
      face_to_path: faceToTarget != null && path != null
        ? faceToTarget - path
        : null,
      created_at: (r.recorded_at as string | null) ?? null,
    };
  });
}

async function shotsForSession(
  sb: SupabaseClient,
  sessionId: string,
): Promise<ShotRow[]> {
  // Real shots-table columns are: ball_speed, vla, carry_distance,
  // club_speed, face_to_target, path, club, recorded_at (+ others).
  // `smash`, `club_path`, `face_to_path` and `created_at` don't exist;
  // selecting them errored silently → 0 shots → empty canvas. Pull the
  // real columns and derive the others.
  const { data, error } = await sb
    .from("shots")
    .select(
      "club, carry_distance, ball_speed, vla, club_speed, attack_angle, total_spin, face_to_target, path, recorded_at",
    )
    .eq("session_id", sessionId);
  if (error) {
    console.error("[stats] shots query failed", error);
    return [];
  }
  return (data ?? []).map((r: Record<string, unknown>): ShotRow => {
    const ballSpeed = r.ball_speed as number | null | undefined;
    const clubSpeed = r.club_speed as number | null | undefined;
    const faceToTarget = r.face_to_target as number | null | undefined;
    const path = r.path as number | null | undefined;
    return {
      club: (r.club as string | null) ?? null,
      carry_distance: (r.carry_distance as number | null) ?? null,
      ball_speed: ballSpeed ?? null,
      vla: (r.vla as number | null) ?? null,
      smash: ballSpeed != null && clubSpeed != null && clubSpeed > 0
        ? ballSpeed / clubSpeed
        : null,
      attack_angle: (r.attack_angle as number | null) ?? null,
      total_spin: (r.total_spin as number | null) ?? null,
      club_path: path ?? null,
      face_to_target: faceToTarget ?? null,
      face_to_path: faceToTarget != null && path != null
        ? faceToTarget - path
        : null,
      created_at: (r.recorded_at as string | null) ?? null,
    };
  });
}

// Returns every shot of a given club across the supplied session ids,
// ordered newest-first, with the richer per-shot fields needed for the
// club-detail view. Distinct from shotsForSessionIds (which discards a
// few raw fields and ditches order).
async function shotsForClubAcrossSessions(
  sb: SupabaseClient,
  sessionIds: string[],
  club: string,
): Promise<ClubDetailShot[]> {
  if (sessionIds.length === 0) return [];
  const { data, error } = await sb
    .from("shots")
    .select(
      "carry_distance, ball_speed, vla, club_speed, attack_angle, total_spin, face_to_target, path, recorded_at",
    )
    .in("session_id", sessionIds)
    .eq("club", club)
    .order("recorded_at", { ascending: false });
  if (error) {
    console.error("[stats] club shots query failed", error);
    return [];
  }
  return (data ?? []).map((r: Record<string, unknown>, idx: number): ClubDetailShot => {
    const ballSpeed = r.ball_speed as number | null | undefined;
    const clubSpeed = r.club_speed as number | null | undefined;
    const faceToTarget = r.face_to_target as number | null | undefined;
    const path = r.path as number | null | undefined;
    return {
      shot_number: idx + 1, // display index, newest-first numbering
      recorded_at: (r.recorded_at as string | null) ?? null,
      carry_distance: (r.carry_distance as number | null) ?? null,
      ball_speed: ballSpeed ?? null,
      club_speed: clubSpeed ?? null,
      vla: (r.vla as number | null) ?? null,
      smash: ballSpeed != null && clubSpeed != null && clubSpeed > 0
        ? ballSpeed / clubSpeed
        : null,
      attack_angle: (r.attack_angle as number | null) ?? null,
      total_spin: (r.total_spin as number | null) ?? null,
      club_path: path ?? null,
      face_to_target: faceToTarget ?? null,
      face_to_path: faceToTarget != null && path != null
        ? faceToTarget - path
        : null,
    };
  });
}

// Classifies a metric value vs its benchmark window.
function classifyMetric(value: number | null, window: [number, number] | null): "in" | "above" | "below" | "n/a" {
  if (value == null || window == null) return "n/a";
  const [lo, hi] = window;
  if (value < lo) return "below";
  if (value > hi) return "above";
  return "in";
}

// Cross-metric narrative for a single club. Strictly factual: cites
// avg carry + avg ball speed + smash relative to benchmark + launch
// status. For iron/wedge cases where smash exceeds tour elite, lists
// the published cause profile (strong-lofted irons, hot face, delofted
// impact). Returns null if we have too little to say.
function buildClubNarrative(
  club: string,
  avgCarry: number | null,
  avgBallSpeed: number | null,
  bench: ClubBench | null,
  smashStatus: "in" | "above" | "below" | "n/a",
  avgSmash: number | null,
  launchStatus: "in" | "above" | "below" | "n/a",
  avgLaunch: number | null,
  spinStatus: "in" | "above" | "below" | "n/a",
  avgSpin: number | null,
  totalShots: number,
): string | null {
  if (totalShots < 3) return null;
  if (avgCarry == null && avgBallSpeed == null && avgSmash == null) return null;

  const parts: string[] = [];
  // Lead with carry + ball speed + smash + spin since they ground the rest.
  const carryFrag = avgCarry != null ? `${Math.round(avgCarry)} yd avg carry` : null;
  const speedFrag = avgBallSpeed != null ? `${avgBallSpeed.toFixed(1)} mph avg ball speed` : null;
  const smashFrag = avgSmash != null ? `smash ${avgSmash.toFixed(2)}` : null;
  const spinFrag  = avgSpin  != null ? `${Math.round(avgSpin)} rpm spin` : null;
  const lead = [carryFrag, speedFrag, smashFrag, spinFrag].filter(Boolean).join(" · ");
  if (lead) parts.push(`{club}: ${lead}.`);

  // Smash interpretation (factual, benchmark-anchored).
  if (bench && smashStatus !== "n/a") {
    const [lo, hi] = bench.smash;
    if (smashStatus === "in") {
      parts.push(`Smash inside the ${lo.toFixed(2)}–${hi.toFixed(2)} window — efficient strike.`);
    } else if (smashStatus === "below") {
      parts.push(`Smash below the ${lo.toFixed(2)}–${hi.toFixed(2)} window — energy loss at contact (off-center / glancing).`);
    } else if (smashStatus === "above" && isIronOrWedge(club)) {
      parts.push(`Smash above the ${lo.toFixed(2)}–${hi.toFixed(2)} tour-elite window — typical of strong-lofted irons, a hot face, or delofting at impact.`);
    } else if (smashStatus === "above" && club.toUpperCase() === "DRIVER") {
      parts.push(`Smash above the ${lo.toFixed(2)}–${hi.toFixed(2)} window — at or near the USGA 1.50 legal ceiling.`);
    }
  }

  // Launch interpretation (only when meaningfully outside).
  if (bench && launchStatus !== "n/a" && launchStatus !== "in" && avgLaunch != null) {
    const [lo, hi] = bench.launch;
    if (launchStatus === "below") {
      parts.push(`Launch ${avgLaunch.toFixed(1)}° is below the ${lo}–${hi}° window — lower trajectory, less peak height.`);
    } else {
      parts.push(`Launch ${avgLaunch.toFixed(1)}° is above the ${lo}–${hi}° window — high trajectory, more peak height and descent.`);
    }
  }

  // Spin interpretation. Above-window on driver → distance loss; below on
  // irons/wedges → won't hold a green; above on irons/wedges → ballooning.
  if (bench && spinStatus !== "n/a" && spinStatus !== "in" && avgSpin != null) {
    const [lo, hi] = bench.spin;
    const c = club.toUpperCase();
    if (spinStatus === "below") {
      if (isIronOrWedge(c)) {
        parts.push(`Spin ${Math.round(avgSpin)} rpm is below the ${lo}–${hi} window — ball won't hold a green from approach.`);
      } else {
        parts.push(`Spin ${Math.round(avgSpin)} rpm is below the ${lo}–${hi} window — flatter, longer-rolling flight.`);
      }
    } else {
      if (c === "DRIVER") {
        parts.push(`Spin ${Math.round(avgSpin)} rpm is above the ${lo}–${hi} window — distance lost to lift, ball climbs and falls short.`);
      } else if (isIronOrWedge(c)) {
        parts.push(`Spin ${Math.round(avgSpin)} rpm is above the ${lo}–${hi} window — ballooning flight, shorter carry than ball speed implies.`);
      } else {
        parts.push(`Spin ${Math.round(avgSpin)} rpm is above the ${lo}–${hi} window.`);
      }
    }
  }

  return parts.join(" ");
}

async function handleClubDetail(
  req: Request,
  sb: SupabaseClient,
  optixUserId: string,
  club: string,
  bookingId: string | null,
): Promise<Response> {
  const clubCode = club.toUpperCase();
  const player = await lookupPlayer(sb, optixUserId);

  const emptyResponse: ClubDetailResponse = {
    player: { display_name: null, optix_user_id: optixUserId },
    club: clubCode,
    total_shots: 0,
    avg_carry: null,
    best_carry: null,
    carry_std_dev: null,
    avg_ball_speed: null,
    avg_club_speed: null,
    avg_total_spin: null,
    metrics: {
      smash: { avg: null, status: "n/a" },
      launch: { avg: null, status: "n/a" },
      attack: { avg: null, status: "n/a" },
      spin: { avg: null, status: "n/a" },
    },
    benchmarks: { smash: null, launch: null, attack: null, spin: null },
    narrative: null,
    shots: [],
  };

  if (!player) return jsonResponse(req, emptyResponse);
  emptyResponse.player.display_name = player.display_name ?? null;

  // Resolve session scope, same logic as handleSession.
  let sessionIds: string[] = [];
  if (bookingId) {
    const resolved = await getSessionsForBooking(sb, player.id, bookingId);
    if (resolved) sessionIds = resolved.sessionIds;
  } else {
    const resolved = await getCanonicalSession(sb, optixUserId);
    if (resolved?.session) sessionIds = [resolved.session.id];
  }
  if (sessionIds.length === 0) return jsonResponse(req, emptyResponse);

  const shots = await shotsForClubAcrossSessions(sb, sessionIds, clubCode);
  if (shots.length === 0) return jsonResponse(req, emptyResponse);

  // Aggregates.
  const carries = shots.map((s) => s.carry_distance).filter((v): v is number => v != null);
  const ballSpeeds = shots.map((s) => s.ball_speed).filter((v): v is number => v != null);
  const clubSpeeds = shots.map((s) => s.club_speed).filter((v): v is number => v != null);
  const smashes = shots.map((s) => s.smash).filter((v): v is number => v != null);
  const launches = shots.map((s) => s.vla).filter((v): v is number => v != null);
  const attacks = shots.map((s) => s.attack_angle).filter((v): v is number => v != null);
  const spins = shots.map((s) => s.total_spin).filter((v): v is number => v != null);

  const avgCarry = mean(carries);
  const bestCarry = maxOrNull(carries);
  const carryStdDev = stdDev(carries);
  const avgBallSpeed = mean(ballSpeeds);
  const avgClubSpeed = mean(clubSpeeds);
  const avgSmash = mean(smashes);
  const avgLaunch = mean(launches);
  const avgAttack = mean(attacks);
  const avgSpin = mean(spins);

  const bench = clubBenchmark(clubCode);
  const smashStatus = classifyMetric(avgSmash, bench?.smash ?? null);
  const launchStatus = classifyMetric(avgLaunch, bench?.launch ?? null);
  const attackStatus = classifyMetric(avgAttack, bench?.attack ?? null);
  const spinStatus = classifyMetric(avgSpin, bench?.spin ?? null);

  const narrative = buildClubNarrative(
    clubCode,
    avgCarry,
    avgBallSpeed,
    bench,
    smashStatus,
    avgSmash,
    launchStatus,
    avgLaunch,
    spinStatus,
    avgSpin,
    shots.length,
  );

  const response: ClubDetailResponse = {
    player: { display_name: player.display_name ?? null, optix_user_id: optixUserId },
    club: clubCode,
    total_shots: shots.length,
    avg_carry: round1(avgCarry),
    best_carry: round1(bestCarry),
    carry_std_dev: carryStdDev != null ? round1(carryStdDev) : null,
    avg_ball_speed: round1(avgBallSpeed),
    avg_club_speed: round1(avgClubSpeed),
    avg_total_spin: avgSpin != null ? Math.round(avgSpin) : null,
    metrics: {
      smash: { avg: avgSmash != null ? Number(avgSmash.toFixed(2)) : null, status: smashStatus },
      launch: { avg: round1(avgLaunch), status: launchStatus },
      attack: { avg: round1(avgAttack), status: attackStatus },
      spin: { avg: avgSpin != null ? Math.round(avgSpin) : null, status: spinStatus },
    },
    benchmarks: {
      smash: bench?.smash ?? null,
      launch: bench?.launch ?? null,
      attack: bench?.attack ?? null,
      spin: bench?.spin ?? null,
    },
    narrative,
    shots: shots.map((s) => ({
      ...s,
      smash: s.smash != null ? Number(s.smash.toFixed(2)) : null,
    })),
  };

  return jsonResponse(req, response);
}

interface SessionAggregateRow {
  total_shots: number;
  total_carry: number | null;
  avg_carry: number | null;
  best_carry: number | null;
  best_carry_club: string | null;
  ball_speed_avg: number | null;
  vla_avg: number | null;
  smash_avg: number | null;
  club_path_avg: number | null;
  face_to_path_avg: number | null;
  peak_smash: number | null;
  peak_smash_club: string | null;
  longest_club: string | null;
  longest_carry: number | null;
  longest_club_avg_face: number | null;
  most_hit_club: string | null;
  most_hit_shots: number | null;
}

function aggregateShots(
  shots: ShotRow[],
  clubFilter: string | null,
): SessionAggregateRow {
  const filtered = clubFilter
    ? shots.filter((s) => s.club === clubFilter)
    : shots;

  // Item #10 — best_carry and longest_club must derive from the SAME shot set,
  // otherwise the hero can claim "best carry 250 yds" while the takeaway shows
  // "longest 230 yds". The takeaway search excludes null-club shots, so we
  // mirror that filter for the hero best-carry derivation. The session-level
  // total_carry / total_shots still come from ALL filtered shots.
  const namedClubShots = filtered.filter((s) => s.club != null);

  const carryVals = filtered.map((s) => s.carry_distance).filter((v): v is number => v != null);
  const namedCarryVals = namedClubShots.map((s) => s.carry_distance).filter((v): v is number => v != null);
  const ballSpeedVals = filtered.map((s) => s.ball_speed).filter((v): v is number => v != null);
  const vlaVals = filtered.map((s) => s.vla).filter((v): v is number => v != null);
  const smashVals = filtered.map((s) => s.smash).filter((v): v is number => v != null);
  const pathVals = filtered.map((s) => s.club_path).filter((v): v is number => v != null);
  const faceToPathVals = filtered
    .map((s) => (s.face_to_path != null ? s.face_to_path : (s.face_to_target != null && s.club_path != null ? s.face_to_target - s.club_path : null)))
    .filter((v): v is number => v != null);

  // Hero best_carry is the max over NAMED clubs only — same shot set used to
  // pick longest_club below, so the two can never disagree.
  const bestCarry = maxOrNull(namedCarryVals);
  let bestCarryClub: string | null = null;
  let bestSeen = -Infinity;
  for (const s of namedClubShots) {
    if (s.carry_distance != null && s.carry_distance > bestSeen) {
      bestSeen = s.carry_distance;
      bestCarryClub = s.club ?? null;
    }
  }

  // Peak smash + club (named clubs only, same rationale)
  let peakSmash: number | null = null;
  let peakSmashClub: string | null = null;
  let peakSeen = -Infinity;
  for (const s of namedClubShots) {
    if (s.smash != null && s.smash > peakSeen) {
      peakSeen = s.smash;
      peakSmash = s.smash;
      peakSmashClub = s.club ?? null;
    }
  }
  // Silence the unused-var linter for carryVals: kept for total_carry below.
  void carryVals;

  // Per-club rollup (for longest / most-hit)
  const byClub = new Map<string, {
    shots: number;
    carries: number[];
    faces: number[];
    maxCarry: number;
  }>();
  for (const s of filtered) {
    if (s.club == null) continue;
    const cur = byClub.get(s.club) ?? { shots: 0, carries: [], faces: [], maxCarry: -Infinity };
    cur.shots += 1;
    if (s.carry_distance != null) {
      cur.carries.push(s.carry_distance);
      if (s.carry_distance > cur.maxCarry) cur.maxCarry = s.carry_distance;
    }
    const ftp = s.face_to_path != null
      ? s.face_to_path
      : (s.face_to_target != null && s.club_path != null ? s.face_to_target - s.club_path : null);
    if (ftp != null) cur.faces.push(ftp);
    byClub.set(s.club, cur);
  }

  let longestClub: string | null = null;
  let longestCarry: number | null = null;
  let longestClubAvgFace: number | null = null;
  for (const [club, agg] of byClub) {
    if (agg.maxCarry > (longestCarry ?? -Infinity)) {
      longestCarry = agg.maxCarry;
      longestClub = club;
      longestClubAvgFace = mean(agg.faces);
    }
  }

  let mostHitClub: string | null = null;
  let mostHitShots: number | null = null;
  for (const [club, agg] of byClub) {
    if (mostHitShots == null || agg.shots > mostHitShots) {
      mostHitShots = agg.shots;
      mostHitClub = club;
    }
  }

  return {
    total_shots: filtered.length,
    total_carry: sumOrNull(carryVals),
    avg_carry: mean(carryVals),
    best_carry: bestCarry,
    best_carry_club: bestCarryClub,
    ball_speed_avg: mean(ballSpeedVals),
    vla_avg: mean(vlaVals),
    smash_avg: mean(smashVals),
    club_path_avg: mean(pathVals),
    face_to_path_avg: mean(faceToPathVals),
    peak_smash: peakSmash,
    peak_smash_club: peakSmashClub,
    longest_club: longestClub,
    longest_carry: longestCarry,
    longest_club_avg_face: longestClubAvgFace,
    most_hit_club: mostHitClub,
    most_hit_shots: mostHitShots,
  };
}

function byClubForShots(shots: ShotRow[]): ByClubRow[] {
  const buckets = new Map<string | null, {
    shots: number;
    carries: number[];
    smashes: number[];
    faces: number[];
    maxCarry: number;
  }>();
  for (const s of shots) {
    const k = s.club ?? null;
    const cur = buckets.get(k) ?? { shots: 0, carries: [], smashes: [], faces: [], maxCarry: -Infinity };
    cur.shots += 1;
    if (s.carry_distance != null) {
      cur.carries.push(s.carry_distance);
      if (s.carry_distance > cur.maxCarry) cur.maxCarry = s.carry_distance;
    }
    if (s.smash != null) cur.smashes.push(s.smash);
    const ftp = s.face_to_path != null
      ? s.face_to_path
      : (s.face_to_target != null && s.club_path != null ? s.face_to_target - s.club_path : null);
    if (ftp != null) cur.faces.push(ftp);
    buckets.set(k, cur);
  }
  const rows: ByClubRow[] = [];
  for (const [club, agg] of buckets) {
    rows.push({
      club,
      shots: agg.shots,
      max_carry: round1(Number.isFinite(agg.maxCarry) ? agg.maxCarry : null),
      avg_carry: round1(mean(agg.carries)),
      smash_avg: round1(mean(agg.smashes)),
      face_avg: round1(mean(agg.faces)),
    });
  }
  const known = rows.filter((r) => r.club !== null).sort((a, b) => b.shots - a.shots);
  const nullBucket = rows.find((r) => r.club === null);
  return nullBucket ? [...known, nullBucket] : known;
}

// Optix's canvas URL macro may substitute either booking.user.user_id (which
// the relay stores as optix_user_id) or booking.account_id (stored as
// optix_member_id) — the two are different ID spaces. Look up by user_id
// first, then fall back to member_id so we hit the row regardless.
async function lookupPlayer(
  sb: SupabaseClient,
  optixId: string,
): Promise<{ id: string; display_name: string | null } | null> {
  const { data: byUser } = await sb
    .from("players")
    .select("id, display_name")
    .eq("optix_user_id", optixId)
    .maybeSingle();
  if (byUser) return byUser;
  const { data: byMember } = await sb
    .from("players")
    .select("id, display_name")
    .eq("optix_member_id", optixId)
    .maybeSingle();
  return byMember ?? null;
}

// Returns the set of Supabase sessions that belong to a single Optix booking
// (split sessions are possible pre-pivot), plus a synthetic "session" object
// that aggregates their bay/start/end/shot_count so the rest of the response
// builder can treat them as a single entity. Returns null if the booking has
// no sessions for this player.
async function getSessionsForBooking(
  sb: SupabaseClient,
  playerId: string,
  bookingId: string,
): Promise<{ sessionIds: string[]; synthetic: {
  id: string;
  bay_number: number | null;
  started_at: string;
  ended_at: string | null;
  shot_count: number;
  optix_booking_id: string;
} } | null> {
  const { data, error } = await sb
    .from("sessions")
    .select("id, bay_number, started_at, ended_at, shot_count, optix_booking_id")
    .eq("player_id", playerId)
    .eq("optix_booking_id", bookingId)
    .order("started_at", { ascending: true });
  if (error || !data || data.length === 0) return null;

  const earliest = data[0];
  const latest = data[data.length - 1];
  // ended_at: keep null if any sub-session is still open; otherwise latest end.
  const anyOpen = data.some((s) => s.ended_at === null);
  return {
    sessionIds: data.map((s) => s.id as string),
    synthetic: {
      id: earliest.id as string,
      bay_number: earliest.bay_number as number | null,
      started_at: earliest.started_at as string,
      ended_at: anyOpen ? null : (latest.ended_at as string | null),
      shot_count: data.reduce((sum, s) => sum + (s.shot_count ?? 0), 0),
      optix_booking_id: bookingId,
    },
  };
}

async function getCanonicalSession(
  sb: SupabaseClient,
  optixUserId: string,
): Promise<{ player: { id: string; display_name: string | null }; session: any | null } | null> {
  const player = await lookupPlayer(sb, optixUserId);

  if (!player) return null;

  const { data: openRow } = await sb
    .from("sessions")
    .select("id, player_id, bay_number, optix_booking_id, started_at, ended_at, shot_count")
    .eq("player_id", player.id)
    .is("ended_at", null)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (openRow) return { player, session: openRow };

  // Closed-session fallback. Require shot_count > 0 so we skip sessions
  // whose shots got cleaned up in DB maintenance — those would otherwise
  // render an "empty session" card with no actual shots behind it.
  const { data: lastRow } = await sb
    .from("sessions")
    .select("id, player_id, bay_number, optix_booking_id, started_at, ended_at, shot_count")
    .eq("player_id", player.id)
    .gt("shot_count", 0)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return { player, session: lastRow ?? null };
}

async function previousSession(
  sb: SupabaseClient,
  playerId: string,
  beforeStartedAt: string,
): Promise<{ id: string; started_at: string } | null> {
  const { data } = await sb
    .from("sessions")
    .select("id, started_at")
    .eq("player_id", playerId)
    .lt("started_at", beforeStartedAt)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

async function sparklineMaxCarry(
  sb: SupabaseClient,
  playerId: string,
  uptoStartedAt: string,
  clubFilter: string | null,
  limit = 6,
): Promise<number[]> {
  const { data: sessions, error } = await sb
    .from("sessions")
    .select("id, started_at")
    .eq("player_id", playerId)
    .lte("started_at", uptoStartedAt)
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error || !sessions) return [];

  const ordered = [...sessions].reverse(); // oldest -> newest

  const out: number[] = [];
  for (const sess of ordered) {
    let q = sb.from("shots").select("carry_distance, club").eq("session_id", sess.id);
    if (clubFilter) q = q.eq("club", clubFilter);
    const { data: shots } = await q;
    const carries = (shots ?? [])
      .map((s) => (s as ShotRow).carry_distance)
      .filter((v): v is number => v != null);
    const mx = maxOrNull(carries);
    if (mx != null) out.push(Math.round(mx * 10) / 10);
  }
  return out;
}

// ---------------------------------------------------------------------------
// View: session
// ---------------------------------------------------------------------------

function emptySessionResponse(
  optixUserId: string,
  displayName: string | null,
  club: string,
  fallback: string,
): SessionResponse {
  return {
    player: { display_name: displayName, optix_user_id: optixUserId },
    session: null,
    hero: {
      selected_club: club === "all" ? "all" : club,
      avg_carry: null,
      best_carry: null,
      best_carry_club: null,
      total_carry: null,
      total_shots: 0,
      sparkline_max_carry: [],
      delta_vs_previous_session: null,
      featured_strength: null,
    },
    stats: {
      ball_speed: { avg: null, delta: null },
      vla: { avg: null, delta: null },
      smash: { avg: null, delta: null },
      club_path: { avg: null, word: null },
      face_to_path: { avg: null, word: null },
    },
    by_club: [],
    takeaway: {
      peak_smash: null,
      peak_smash_club: null,
      longest_club: null,
      longest_carry: null,
      longest_club_avg_face: null,
      longest_club_face_word: null,
      most_hit_club: null,
      most_hit_shots: null,
      strength: null,
      watch: null,
      fallback_text: fallback,
    },
  };
}

async function handleSession(
  req: Request,
  sb: SupabaseClient,
  optixUserId: string,
  club: string,
  bookingId: string | null = null,
): Promise<Response> {
  // Resolve player up front — both modes need it.
  const player = await lookupPlayer(sb, optixUserId);
  if (!player) {
    return jsonResponse(
      req,
      emptySessionResponse(
        optixUserId,
        null,
        club,
        "No shots logged yet — hit a few balls to see your stats.",
      ),
    );
  }

  // Two modes:
  //   - canonical: most recent open/closed session (default)
  //   - booking-pinned: caller passed ?booking_id=<X> from the history list
  let session: any | null = null;
  let sessionIds: string[] = [];
  let pinnedMode = false;
  if (bookingId) {
    const resolved = await getSessionsForBooking(sb, player.id, bookingId);
    if (resolved) {
      session = resolved.synthetic;
      sessionIds = resolved.sessionIds;
      pinnedMode = true;
    }
  } else {
    const resolved = await getCanonicalSession(sb, optixUserId);
    if (resolved?.session) {
      session = resolved.session;
      sessionIds = [resolved.session.id];
    }
  }

  if (!session || sessionIds.length === 0) {
    return jsonResponse(
      req,
      emptySessionResponse(
        optixUserId,
        player.display_name ?? null,
        club,
        pinnedMode
          ? "Couldn't find that session."
          : "No sessions yet — your first booking will show up here.",
      ),
    );
  }

  const clubFilter = club === "all" ? null : club;

  const shots = await shotsForSessionIds(sb, sessionIds);
  const agg = aggregateShots(shots, clubFilter);
  const byClub = byClubForShots(shots);
  const clubsUsed = Array.from(
    new Set(shots.map((s) => s.club).filter((c): c is string => !!c)),
  );

  // Delta vs previous + sparkline only make sense in canonical mode. In
  // pinned mode we're looking at a past booking — "previous" is ambiguous
  // and a leading-window sparkline would mix this booking into itself.
  let prevAgg: SessionAggregateRow | null = null;
  let sparkline: number[] = [];
  if (!pinnedMode) {
    const prev = await previousSession(sb, player.id, session.started_at);
    if (prev) {
      const prevShots = await shotsForSession(sb, prev.id);
      prevAgg = aggregateShots(prevShots, clubFilter);
    }
    sparkline = await sparklineMaxCarry(
      sb,
      player.id,
      session.started_at,
      clubFilter,
      6,
    );
  }

  let fallback: string | null = null;
  const totalShots = agg.total_shots;
  if (totalShots < 5) {
    fallback = "Hit a few more shots to unlock your session takeaway.";
  } else if (!agg.longest_club && !agg.peak_smash_club && !agg.most_hit_club) {
    fallback = "Not enough club data to surface a takeaway yet.";
  }

  // Physics-based observations. Each requires ≥5 same-club shots, so this
  // returns nulls for low-data sessions; the canvas hides empty rows.
  const observations = pickTakeawayObservations(shots);

  const response: SessionResponse = {
    player: {
      display_name: player.display_name ?? null,
      optix_user_id: optixUserId,
    },
    session: {
      id: session.id,
      bay_number: session.bay_number ?? null,
      started_at: session.started_at,
      ended_at: session.ended_at,
      shot_count: session.shot_count ?? totalShots,
      optix_booking_id: session.optix_booking_id ?? null,
      session_open: session.ended_at === null,
      duration_minutes: minutesBetween(session.started_at, session.ended_at),
      clubs_used: clubsUsed,
    },
    hero: {
      selected_club: club === "all" ? "all" : club,
      avg_carry: round1(agg.avg_carry),
      best_carry: round1(agg.best_carry),
      best_carry_club: agg.best_carry_club,
      total_carry: round0(agg.total_carry),
      total_shots: totalShots,
      sparkline_max_carry: sparkline,
      delta_vs_previous_session: safeDelta(agg.avg_carry, prevAgg?.avg_carry ?? null),
      featured_strength: observations.strength,
    },
    stats: {
      ball_speed: {
        avg: round1(agg.ball_speed_avg),
        delta: safeDelta(agg.ball_speed_avg, prevAgg?.ball_speed_avg ?? null),
      },
      vla: {
        avg: round1(agg.vla_avg),
        delta: safeDelta(agg.vla_avg, prevAgg?.vla_avg ?? null),
      },
      smash: {
        avg: round1(agg.smash_avg),
        delta: safeDelta(agg.smash_avg, prevAgg?.smash_avg ?? null),
      },
      club_path: {
        avg: round1(agg.club_path_avg),
        word: pathWord(agg.club_path_avg),
      },
      face_to_path: {
        avg: round1(agg.face_to_path_avg),
        word: faceToPathWord(agg.face_to_path_avg),
      },
    },
    by_club: byClub,
    takeaway: {
      peak_smash: round1(agg.peak_smash),
      peak_smash_club: agg.peak_smash_club,
      longest_club: agg.longest_club,
      longest_carry: round1(agg.longest_carry),
      longest_club_avg_face: round1(agg.longest_club_avg_face),
      longest_club_face_word: faceToPathWord(agg.longest_club_avg_face),
      most_hit_club: agg.most_hit_club,
      most_hit_shots: agg.most_hit_shots,
      strength: observations.strength,
      watch: observations.watch,
      fallback_text: fallback,
    },
  };

  return jsonResponse(req, response);
}

// ---------------------------------------------------------------------------
// View: history
// ---------------------------------------------------------------------------

async function handleHistory(
  req: Request,
  sb: SupabaseClient,
  optixUserId: string,
): Promise<Response> {
  const player = await lookupPlayer(sb, optixUserId);

  if (!player) return jsonResponse(req, <HistoryResponse>{ sessions: [] });

  // Embed shots into the sessions query. Rows with null optix_booking_id are
  // dropped entirely so the dedup-by-booking key never collapses unrelated
  // legacy rows on started_at.
  const { data, error } = await sb
    .from("sessions")
    .select(
      "id, started_at, ended_at, bay_number, shot_count, optix_booking_id, shots:shots(carry_distance, club)",
    )
    .eq("player_id", player.id)
    .not("optix_booking_id", "is", null)
    .order("started_at", { ascending: false })
    .limit(50);

  if (error) {
    return errorResponse(req, 500, "history_query_failed", error.message);
  }

  type Row = {
    id: string;
    started_at: string;
    ended_at: string | null;
    bay_number: number | null;
    shot_count: number | null;
    optix_booking_id: string;
    shots: { carry_distance: number | null; club: string | null }[] | null;
  };

  // Group by booking_id
  const grouped = new Map<string, {
    booking_id: string;
    started_at: string;
    ended_at: string | null;
    bay_number: number | null;
    shot_count: number;
    max_carry: number | null;
    carries: number[];
    clubs: Set<string>;
  }>();

  for (const r of (data ?? []) as Row[]) {
    const key = r.optix_booking_id;
    const shotsArr = r.shots ?? [];
    const carries = shotsArr.map((s) => s.carry_distance).filter((v): v is number => v != null);
    const localMax = maxOrNull(carries);
    const localCount = (r.shot_count != null && r.shot_count > 0) ? r.shot_count : shotsArr.length;

    const existing = grouped.get(key);
    if (!existing) {
      const set = new Set<string>();
      for (const s of shotsArr) if (s.club) set.add(s.club);
      grouped.set(key, {
        booking_id: key,
        started_at: r.started_at,
        ended_at: r.ended_at,
        bay_number: r.bay_number,
        shot_count: localCount,
        max_carry: localMax,
        carries: [...carries],
        clubs: set,
      });
    } else {
      existing.shot_count += localCount;
      if (new Date(r.started_at) < new Date(existing.started_at)) {
        existing.started_at = r.started_at;
      }
      // ended_at: prefer the latest non-null, but if any row still open, keep null
      if (existing.ended_at !== null) {
        if (r.ended_at === null) {
          existing.ended_at = null;
        } else if (new Date(r.ended_at) > new Date(existing.ended_at)) {
          existing.ended_at = r.ended_at;
        }
      }
      if (localMax != null && (existing.max_carry == null || localMax > existing.max_carry)) {
        existing.max_carry = localMax;
      }
      existing.carries.push(...carries);
      for (const s of shotsArr) if (s.club) existing.clubs.add(s.club);
    }
  }

  const sessions: HistorySessionRow[] = [...grouped.values()]
    .filter((g) => g.shot_count > 0)
    .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())
    .map((g) => {
      // Sparkline: take up to 6 evenly-sampled carries from this booking.
      const carries = g.carries;
      let sparkline: number[] = [];
      if (carries.length <= 6) {
        sparkline = carries.map((v) => Math.round(v * 10) / 10);
      } else {
        const step = (carries.length - 1) / 5;
        for (let i = 0; i < 6; i++) {
          const idx = Math.round(i * step);
          sparkline.push(Math.round(carries[idx] * 10) / 10);
        }
      }
      return {
        booking_id: g.booking_id,
        started_at: g.started_at,
        ended_at: g.ended_at,
        bay_number: g.bay_number,
        shot_count: g.shot_count,
        max_carry: round1(g.max_carry),
        sparkline,
        shots_logged_clubs: [...g.clubs],
      };
    });

  return jsonResponse(req, <HistoryResponse>{ sessions });
}

// ---------------------------------------------------------------------------
// View: trends
// ---------------------------------------------------------------------------

async function lifetimeClubsFor(
  sb: SupabaseClient,
  playerId: string,
): Promise<LifetimeClubRow[]> {
  // Pull all sessions for this player + their embedded shots.club.
  const { data, error } = await sb
    .from("sessions")
    .select("id, shots:shots(club)")
    .eq("player_id", playerId);
  if (error || !data) return [];
  const tally = new Map<string, number>();
  for (const sess of data as { id: string; shots: { club: string | null }[] | null }[]) {
    for (const s of sess.shots ?? []) {
      if (!s.club) continue;
      tally.set(s.club, (tally.get(s.club) ?? 0) + 1);
    }
  }
  return [...tally.entries()]
    .map(([club, shots]) => ({ club, shots }))
    .sort((a, b) => b.shots - a.shots);
}

async function handleTrends(
  req: Request,
  sb: SupabaseClient,
  optixUserId: string,
  club: string,
): Promise<Response> {
  const player = await lookupPlayer(sb, optixUserId);

  if (!player) {
    return jsonResponse(req, <TrendsNotReadyResponse>{
      ready: false,
      total_sessions: 0,
      selected_club: club === "all" ? "all" : club,
      lifetime_clubs: [],
    });
  }

  const { count: sessionCount } = await sb
    .from("sessions")
    .select("id", { count: "exact", head: true })
    .eq("player_id", player.id);

  const total = sessionCount ?? 0;
  const lifetimeClubs = await lifetimeClubsFor(sb, player.id);

  if (total < 3) {
    return jsonResponse(req, <TrendsNotReadyResponse>{
      ready: false,
      total_sessions: total,
      selected_club: club === "all" ? "all" : club,
      lifetime_clubs: lifetimeClubs,
    });
  }

  const clubFilter = club === "all" ? null : club;

  // Last 6 sessions, oldest -> newest.
  const { data: sessions, error: sessErr } = await sb
    .from("sessions")
    .select("id, started_at")
    .eq("player_id", player.id)
    .order("started_at", { ascending: false })
    .limit(6);
  if (sessErr) {
    return errorResponse(req, 500, "trends_query_failed", sessErr.message);
  }
  const ordered = [...(sessions ?? [])].reverse();

  type Point = { date: string; carry: number | null; ball_speed: number | null; smash: number | null };
  const points: Point[] = [];

  for (const sess of ordered) {
    // Same column-name fix as shotsForSession — `smash` doesn't exist
    // on the table, derive it from ball_speed / club_speed.
    let q = sb.from("shots").select("carry_distance, ball_speed, club_speed, club").eq("session_id", sess.id);
    if (clubFilter) q = q.eq("club", clubFilter);
    const { data: shots } = await q;
    const rows = (shots ?? []) as Array<{
      carry_distance: number | null;
      ball_speed: number | null;
      club_speed: number | null;
      club: string | null;
    }>;
    const carries = rows.map((r) => r.carry_distance).filter((v): v is number => v != null);
    const speeds = rows.map((r) => r.ball_speed).filter((v): v is number => v != null);
    const smashes = rows
      .map((r) => (r.ball_speed != null && r.club_speed != null && r.club_speed > 0
        ? r.ball_speed / r.club_speed
        : null))
      .filter((v): v is number => v != null);
    points.push({
      date: sess.started_at.slice(0, 10),
      carry: mean(carries),     // session avg carry; "max per session" wasn't useful as a trend
      ball_speed: mean(speeds),
      smash: mean(smashes),
    });
  }

  const buildSeries = (key: "carry" | "ball_speed" | "smash"): TrendsChart => {
    const series: TrendsSeriesPoint[] = points
      .filter((p) => p[key] != null)
      .map((p) => ({ date: p.date, value: Math.round((p[key] as number) * 10) / 10 }));
    const current = series.length ? series[series.length - 1].value : null;
    const prev = series.length >= 2 ? series[series.length - 2].value : null;
    return {
      series,
      current,
      delta_vs_previous: safeDelta(current, prev),
    };
  };

  return jsonResponse(req, <TrendsReadyResponse>{
    ready: true,
    total_sessions: total,
    selected_club: club === "all" ? "all" : club,
    lifetime_clubs: lifetimeClubs,
    charts: {
      carry: buildSeries("carry"),
      ball_speed: buildSeries("ball_speed"),
      smash: buildSeries("smash"),
    },
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(req) });
  }

  try {
    const url = new URL(req.url);
    const view = url.searchParams.get("view") ?? "session";
    const club = url.searchParams.get("club") ?? "all";
    const bookingId = url.searchParams.get("booking_id");

    // Token comes from Authorization: Bearer <token> header only. The
    // `?user_id=` URL param is no longer required or trusted — see
    // validateOptixToken() comment for why.
    const authHeader = req.headers.get("Authorization") ?? req.headers.get("authorization") ?? "";
    const token = authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim()
      : "";

    if (!token) {
      return errorResponse(req, 400, "missing_required_params");
    }
    if (!["session", "history", "trends", "club"].includes(view)) {
      return errorResponse(req, 400, "unknown_view");
    }
    if (view === "club" && (club === "all" || !club)) {
      return errorResponse(req, 400, "missing_required_params");
    }

    const auth = await validateOptixToken(token);
    if (!auth.ok) {
      return errorResponse(req, 401, "unauthorized", auth.reason);
    }
    const verifiedUserId = auth.userId;

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    if (view === "session") {
      return await handleSession(req, sb, verifiedUserId, club, bookingId);
    }
    if (view === "history") {
      return await handleHistory(req, sb, verifiedUserId);
    }
    if (view === "club") {
      return await handleClubDetail(req, sb, verifiedUserId, club, bookingId);
    }
    return await handleTrends(req, sb, verifiedUserId, club);
  } catch (err) {
    return errorResponse(req, 500, "internal_error", (err as Error).message);
  }
});
