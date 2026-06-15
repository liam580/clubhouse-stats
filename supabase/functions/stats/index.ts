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
  best_carry: number | null;
  best_carry_club: string | null;
  total_carry: number | null;
  total_shots: number;
  sparkline_max_carry: number[];                 // last 6 sessions of max carry
  delta_vs_previous_session: number | null;      // best_carry delta vs prev session
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

interface TakeawayBlock {
  peak_smash: number | null;
  peak_smash_club: string | null;
  longest_club: string | null;
  longest_carry: number | null;
  longest_club_avg_face: number | null;
  longest_club_face_word: string | null;
  most_hit_club: string | null;
  most_hit_shots: number | null;
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
const IS_PROD = (Deno.env.get("DENO_DEPLOYMENT_ID") ?? "") !== "" ||
  (Deno.env.get("ENVIRONMENT") ?? "") === "production";

const ALLOWED_ORIGINS = new Set<string>([
  "https://liam580.github.io",
  "https://stats.clubhousegolf.nyc",
  "http://localhost:8000",
  "null",
]);

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

function errorResponse(req: Request, status: number, code: string, internalDetail?: unknown): Response {
  // Never leak raw error.message in production responses; just log it.
  if (internalDetail !== undefined) {
    console.error(`[stats] error ${status} ${code}:`, internalDetail);
  }
  const body: Record<string, unknown> = { error: code };
  if (!IS_PROD && internalDetail !== undefined) {
    body.detail = String(internalDetail);
  } else {
    body.detail = "internal error";
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
        display_name?: string | null;
      };
    };
  };
  errors?: unknown;
}

async function validateOptixToken(
  token: string,
  claimedUserId: string,
): Promise<{ ok: true; userId: string; displayName: string | null } | { ok: false; reason: string }> {
  try {
    const res = await fetch(OPTIX_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        query: "query { me { user { user_id display_name } } }",
      }),
    });

    if (!res.ok) {
      return { ok: false, reason: `optix_status_${res.status}` };
    }

    const payload = (await res.json()) as OptixMeResponse;
    const verifiedId = payload?.data?.me?.user?.user_id;
    const displayName = payload?.data?.me?.user?.display_name ?? null;

    if (!verifiedId) {
      return { ok: false, reason: "no_user_id_in_optix_response" };
    }
    if (String(verifiedId) !== String(claimedUserId)) {
      return { ok: false, reason: "user_id_mismatch" };
    }
    return { ok: true, userId: String(verifiedId), displayName };
  } catch (err) {
    return { ok: false, reason: `optix_fetch_failed:${(err as Error).message}` };
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

// ---------------------------------------------------------------------------
// Raw shot row + inline aggregation
// ---------------------------------------------------------------------------

interface ShotRow {
  club: string | null;
  carry_distance: number | null;
  ball_speed: number | null;
  vla: number | null;
  smash: number | null;
  club_path: number | null;
  face_to_target: number | null;
  face_to_path: number | null;
  created_at?: string | null;
}

async function shotsForSession(
  sb: SupabaseClient,
  sessionId: string,
): Promise<ShotRow[]> {
  const { data, error } = await sb
    .from("shots")
    .select(
      "club, carry_distance, ball_speed, vla, smash, club_path, face_to_target, face_to_path, created_at",
    )
    .eq("session_id", sessionId);
  if (error) {
    console.error("[stats] shots query failed", error);
    return [];
  }
  return (data ?? []) as ShotRow[];
}

interface SessionAggregateRow {
  total_shots: number;
  total_carry: number | null;
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

  const carryVals = filtered.map((s) => s.carry_distance).filter((v): v is number => v != null);
  const ballSpeedVals = filtered.map((s) => s.ball_speed).filter((v): v is number => v != null);
  const vlaVals = filtered.map((s) => s.vla).filter((v): v is number => v != null);
  const smashVals = filtered.map((s) => s.smash).filter((v): v is number => v != null);
  const pathVals = filtered.map((s) => s.club_path).filter((v): v is number => v != null);
  const faceToPathVals = filtered
    .map((s) => (s.face_to_path != null ? s.face_to_path : (s.face_to_target != null && s.club_path != null ? s.face_to_target - s.club_path : null)))
    .filter((v): v is number => v != null);

  const bestCarry = maxOrNull(carryVals);
  let bestCarryClub: string | null = null;
  let bestSeen = -Infinity;
  for (const s of filtered) {
    if (s.carry_distance != null && s.carry_distance > bestSeen) {
      bestSeen = s.carry_distance;
      bestCarryClub = s.club ?? null;
    }
  }

  // Peak smash + club
  let peakSmash: number | null = null;
  let peakSmashClub: string | null = null;
  let peakSeen = -Infinity;
  for (const s of filtered) {
    if (s.smash != null && s.smash > peakSeen) {
      peakSeen = s.smash;
      peakSmash = s.smash;
      peakSmashClub = s.club ?? null;
    }
  }

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

async function getCanonicalSession(
  sb: SupabaseClient,
  optixUserId: string,
): Promise<{ player: { id: string; display_name: string | null }; session: any | null } | null> {
  const { data: player } = await sb
    .from("players")
    .select("id, display_name")
    .eq("optix_user_id", optixUserId)
    .maybeSingle();

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

  const { data: lastRow } = await sb
    .from("sessions")
    .select("id, player_id, bay_number, optix_booking_id, started_at, ended_at, shot_count")
    .eq("player_id", player.id)
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
      best_carry: null,
      best_carry_club: null,
      total_carry: null,
      total_shots: 0,
      sparkline_max_carry: [],
      delta_vs_previous_session: null,
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
      fallback_text: fallback,
    },
  };
}

async function handleSession(
  req: Request,
  sb: SupabaseClient,
  optixUserId: string,
  optixDisplayName: string | null,
  club: string,
): Promise<Response> {
  const resolved = await getCanonicalSession(sb, optixUserId);
  if (!resolved) {
    return jsonResponse(
      req,
      emptySessionResponse(
        optixUserId,
        optixDisplayName,
        club,
        "No shots logged yet — hit a few balls to see your stats.",
      ),
    );
  }

  const { player, session } = resolved;
  if (!session) {
    return jsonResponse(
      req,
      emptySessionResponse(
        optixUserId,
        optixDisplayName ?? player.display_name ?? null,
        club,
        "No sessions yet — your first booking will show up here.",
      ),
    );
  }

  const clubFilter = club === "all" ? null : club;

  const shots = await shotsForSession(sb, session.id);
  const agg = aggregateShots(shots, clubFilter);
  const byClub = byClubForShots(shots);
  const clubsUsed = Array.from(
    new Set(shots.map((s) => s.club).filter((c): c is string => !!c)),
  );

  const prev = await previousSession(sb, player.id, session.started_at);
  let prevAgg: SessionAggregateRow | null = null;
  if (prev) {
    const prevShots = await shotsForSession(sb, prev.id);
    prevAgg = aggregateShots(prevShots, clubFilter);
  }

  const sparkline = await sparklineMaxCarry(
    sb,
    player.id,
    session.started_at,
    clubFilter,
    6,
  );

  let fallback: string | null = null;
  const totalShots = agg.total_shots;
  if (totalShots < 5) {
    fallback = "Hit a few more shots to unlock your session takeaway.";
  } else if (!agg.longest_club && !agg.peak_smash_club && !agg.most_hit_club) {
    fallback = "Not enough club data to surface a takeaway yet.";
  }

  const response: SessionResponse = {
    player: {
      display_name: optixDisplayName ?? player.display_name ?? null,
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
      best_carry: round1(agg.best_carry),
      best_carry_club: agg.best_carry_club,
      total_carry: round0(agg.total_carry),
      total_shots: totalShots,
      sparkline_max_carry: sparkline,
      delta_vs_previous_session: safeDelta(agg.best_carry, prevAgg?.best_carry ?? null),
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
  const { data: player } = await sb
    .from("players")
    .select("id")
    .eq("optix_user_id", optixUserId)
    .maybeSingle();

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
  const { data: player } = await sb
    .from("players")
    .select("id")
    .eq("optix_user_id", optixUserId)
    .maybeSingle();

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
    let q = sb.from("shots").select("carry_distance, ball_speed, smash, club").eq("session_id", sess.id);
    if (clubFilter) q = q.eq("club", clubFilter);
    const { data: shots } = await q;
    const rows = (shots ?? []) as ShotRow[];
    const carries = rows.map((r) => r.carry_distance).filter((v): v is number => v != null);
    const speeds = rows.map((r) => r.ball_speed).filter((v): v is number => v != null);
    const smashes = rows.map((r) => r.smash).filter((v): v is number => v != null);
    points.push({
      date: sess.started_at.slice(0, 10),
      carry: maxOrNull(carries),
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
    const userId = url.searchParams.get("user_id");
    const club = url.searchParams.get("club") ?? "all";

    // Token comes from Authorization: Bearer <token> header only.
    const authHeader = req.headers.get("Authorization") ?? req.headers.get("authorization") ?? "";
    const token = authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim()
      : "";

    if (!token || !userId) {
      return errorResponse(req, 400, "missing_required_params");
    }
    if (!["session", "history", "trends"].includes(view)) {
      return errorResponse(req, 400, "unknown_view");
    }

    const auth = await validateOptixToken(token, userId);
    if (!auth.ok) {
      return errorResponse(req, 401, "unauthorized", auth.reason);
    }

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    if (view === "session") {
      return await handleSession(req, sb, auth.userId, auth.displayName, club);
    }
    if (view === "history") {
      return await handleHistory(req, sb, auth.userId);
    }
    return await handleTrends(req, sb, auth.userId, club);
  } catch (err) {
    return errorResponse(req, 500, "internal_error", (err as Error).message);
  }
});
