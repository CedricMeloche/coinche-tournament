import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * 9th Annual Coinche Tournament — Vite-friendly single file
 * - Exactly 8 teams (2 pools of 4) → pool round robin → bracket QF/SF/Final + 3rd
 * - Admin view (edit everything), Public view (read-only TV), Table view (enter hands for one match)
 * - Fast mode upgraded: track every hand; auto-calc; running total; winner immediately at >= 2000
 * - Live scoreboard + stats (live within same browser). Supabase later for multi-device live.
 */

const LS_KEY = "coinche_tournament_vite_v2_hand_tracker";
const GAME_MINUTES = 40;
const BREAK_MINUTES = 5;
const SLOT_MINUTES = GAME_MINUTES + BREAK_MINUTES; // 45
const START_TIME_STR = "10:00"; // display only
const DEFAULT_TARGET = 2000;

function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function safeInt(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[^0-9\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/** Circle method RR scheduler */
function circleRoundRobin(teamIds) {
  const ids = [...teamIds];
  if (ids.length % 2 === 1) ids.push("BYE");

  const n = ids.length;
  const rounds = n - 1;

  let left = ids.slice(0, n / 2);
  let right = ids.slice(n / 2).reverse();

  const out = [];
  for (let r = 0; r < rounds; r++) {
    const pairings = [];
    for (let i = 0; i < left.length; i++) {
      const a = left[i];
      const b = right[i];
      if (a !== "BYE" && b !== "BYE") pairings.push([a, b]);
    }
    out.push(pairings);

    // rotate (keep first fixed)
    const fixed = left[0];
    const movedFromLeft = left.pop();
    const movedFromRight = right.shift();
    left = [fixed, movedFromRight, ...left.slice(1)];
    right = [...right, movedFromLeft];
  }
  return out;
}

function computeMatchPoints(scoreWinner, threshold2000, highPts, lowPts) {
  if (scoreWinner === null) return 0;
  return scoreWinner >= threshold2000 ? highPts : lowPts;
}

function sortStandings(rows) {
  return [...rows].sort((a, b) => {
    if (b.matchPoints !== a.matchPoints) return b.matchPoints - a.matchPoints;
    if (b.totalGamePoints !== a.totalGamePoints) return b.totalGamePoints - a.totalGamePoints;
    return a.name.localeCompare(b.name);
  });
}

/** ===== Fast mode Coinche scoring helpers ===== */
function roundTrickPoints(x) {
  if (x == null) return 0;
  const n = clamp(Number(x) || 0, 0, 162);
  // nearest 10 with .5 down (approx using +4 then floor)
  return Math.floor((n + 4) / 10) * 10;
}

/**
 * Returns hand score for A and B for ONE hand.
 * (This matches the simplified "fast mode" rules you provided previously.)
 */
function computeFastCoincheHandScore({
  bidder, // "A"|"B"
  bid, // number
  coincheLevel, // "NONE"|"COINCHE"|"SURCOINCHE"
  capot, // boolean
  bidderTrickPoints, // 0..162 raw
  announceA, // non-belote announces total A
  announceB, // non-belote announces total B
  beloteTeam, // "NONE"|"A"|"B"
}) {
  const BIDDER_IS_A = bidder === "A";
  const bidVal = Number(bid) || 0;

  const belotePts = beloteTeam === "NONE" ? 0 : 20;
  const beloteA = beloteTeam === "A" ? 20 : 0;
  const beloteB = beloteTeam === "B" ? 20 : 0;

  const rawBidder = clamp(Number(bidderTrickPoints) || 0, 0, 162);
  const rawOpp = 162 - rawBidder;

  const tricksBidder = roundTrickPoints(rawBidder);
  const tricksOpp = roundTrickPoints(rawOpp);

  const aAnn = Number(announceA) || 0;
  const bAnn = Number(announceB) || 0;

  const bidderAnn = BIDDER_IS_A ? aAnn : bAnn;

  // Minimum needed: base 81. If bidder has belote: 71. If bid==80 must be 81.
  const bidderHasBelote =
    (BIDDER_IS_A && beloteTeam === "A") || (!BIDDER_IS_A && beloteTeam === "B");
  const baseMin = bidderHasBelote ? 71 : 81;
  const special80 = bidVal === 80 ? 81 : 0;

  // Announces help (simple fast mode): allow them to reduce requirement.
  const announceHelp = bidderAnn + (bidderHasBelote ? 20 : 0);
  const required = Math.max(baseMin, special80, bidVal - announceHelp);

  const bidderSucceeded = capot ? true : rawBidder >= required;

  const mult = coincheLevel === "SURCOINCHE" ? 4 : coincheLevel === "COINCHE" ? 2 : 1;
  const isCoinche = coincheLevel !== "NONE";

  let scoreA = 0;
  let scoreB = 0;

  if (capot) {
    // winner gets 250 + all announces (incl belote) + bid; loser 0
    const winnerGets = 250 + aAnn + bAnn + belotePts + bidVal;
    if (BIDDER_IS_A) {
      scoreA = winnerGets;
      scoreB = 0;
    } else {
      scoreB = winnerGets;
      scoreA = 0;
    }
    return { scoreA, scoreB, bidderSucceeded: true };
  }

  if (isCoinche) {
    // winner gets 160 + (mult*bid) + all announces; loser 0; belote stays with declaring team
    const winnerNonBelote = 160 + mult * bidVal + (aAnn + bAnn);
    if (bidderSucceeded) {
      if (BIDDER_IS_A) {
        scoreA = winnerNonBelote + beloteA;
        scoreB = beloteB;
      } else {
        scoreB = winnerNonBelote + beloteB;
        scoreA = beloteA;
      }
    } else {
      if (BIDDER_IS_A) {
        scoreB = winnerNonBelote + beloteB;
        scoreA = beloteA;
      } else {
        scoreA = winnerNonBelote + beloteA;
        scoreB = beloteB;
      }
    }
    return { scoreA, scoreB, bidderSucceeded };
  }

  // Normal scoring
  if (bidderSucceeded) {
    // bidder: rounded tricks + their announces + bid (+ belote); opp: rounded tricks + their announces (+ belote)
    if (BIDDER_IS_A) {
      scoreA = tricksBidder + aAnn + beloteA + bidVal;
      scoreB = tricksOpp + bAnn + beloteB;
    } else {
      scoreB = tricksBidder + bAnn + beloteB + bidVal;
      scoreA = tricksOpp + aAnn + beloteA;
    }
  } else {
    // fail: bidder gets 0 but keeps belote; opponents get 160 + bid + announces (non-belote); belote stays with declaring team
    const oppGets = 160 + bidVal + (aAnn + bAnn);
    if (BIDDER_IS_A) {
      scoreA = beloteA;
      scoreB = oppGets + beloteB;
    } else {
      scoreB = beloteB;
      scoreA = oppGets + beloteA;
    }
  }

  return { scoreA, scoreB, bidderSucceeded };
}

/** ===== UI Styling (simple but much prettier) ===== */
const UI = {
  bg: "#0b1220",
  panel: "rgba(255,255,255,0.06)",
  panel2: "rgba(255,255,255,0.09)",
  border: "rgba(255,255,255,0.12)",
  text: "rgba(255,255,255,0.92)",
  muted: "rgba(255,255,255,0.65)",
  faint: "rgba(255,255,255,0.45)",
  good: "#22c55e",
  warn: "#f59e0b",
  bad: "#ef4444",
  chip: "rgba(255,255,255,0.10)",
  accent: "#60a5fa",
};

function Chip({ children, tone = "neutral" }) {
  const bg =
    tone === "good"
      ? "rgba(34,197,94,0.18)"
      : tone === "warn"
      ? "rgba(245,158,11,0.18)"
      : tone === "bad"
      ? "rgba(239,68,68,0.18)"
      : UI.chip;
  const border =
    tone === "good"
      ? "rgba(34,197,94,0.35)"
      : tone === "warn"
      ? "rgba(245,158,11,0.35)"
      : tone === "bad"
      ? "rgba(239,68,68,0.35)"
      : UI.border;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 10px",
        borderRadius: 999,
        border: `1px solid ${border}`,
        background: bg,
        color: UI.text,
        fontWeight: 700,
        fontSize: 12,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function Card({ title, right, children }) {
  return (
    <div
      style={{
        background: UI.panel,
        border: `1px solid ${UI.border}`,
        borderRadius: 16,
        padding: 14,
        boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
      }}
    >
      {(title || right) && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            gap: 10,
            marginBottom: 10,
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 900, color: UI.text }}>{title}</div>
          <div>{right}</div>
        </div>
      )}
      {children}
    </div>
  );
}

function Btn({ children, onClick, disabled, kind = "primary", small = false }) {
  const padding = small ? "8px 10px" : "10px 12px";
  const bg =
    kind === "primary"
      ? "linear-gradient(135deg, rgba(96,165,250,0.95), rgba(34,211,238,0.75))"
      : kind === "danger"
      ? "linear-gradient(135deg, rgba(239,68,68,0.95), rgba(244,63,94,0.75))"
      : kind === "ghost"
      ? "transparent"
      : UI.panel2;

  const border =
    kind === "ghost" ? `1px solid ${UI.border}` : `1px solid rgba(255,255,255,0.14)`;

  const color = kind === "ghost" ? UI.text : "#06101f";

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding,
        borderRadius: 14,
        border,
        background: disabled ? "rgba(255,255,255,0.08)" : bg,
        color: disabled ? UI.faint : color,
        cursor: disabled ? "not-allowed" : "pointer",
        fontWeight: 900,
        letterSpacing: 0.2,
      }}
    >
      {children}
    </button>
  );
}

function TextInput({ value, onChange, placeholder, width = 220, type = "text" }) {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width,
        padding: "10px 12px",
        borderRadius: 14,
        border: `1px solid ${UI.border}`,
        background: "rgba(0,0,0,0.20)",
        color: UI.text,
        outline: "none",
      }}
    />
  );
}

function Select({ value, onChange, options, width = 180 }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width,
        padding: "10px 12px",
        borderRadius: 14,
        border: `1px solid ${UI.border}`,
        background: "rgba(0,0,0,0.20)",
        color: UI.text,
        outline: "none",
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} style={{ color: "#111" }}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Divider() {
  return <div style={{ height: 1, background: UI.border, margin: "12px 0" }} />;
}

/** ===== Simple hash router (#/admin, #/public, #/table) ===== */
function getRoute() {
  const h = (window.location.hash || "#/admin").replace("#", "");
  const [path, queryString] = h.split("?");
  const q = {};
  if (queryString) {
    queryString.split("&").forEach((kv) => {
      const [k, v] = kv.split("=");
      q[decodeURIComponent(k)] = decodeURIComponent(v || "");
    });
  }
  return { path: path || "/admin", q };
}

function setRoute(path, q = {}) {
  const qs = Object.keys(q).length
    ? "?" +
      Object.entries(q)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&")
    : "";
  window.location.hash = `#${path}${qs}`;
}

function formatMinutes(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** ===== App ===== */
export default function App() {
  const [loaded, setLoaded] = useState(false);

  // router state
  const [route, setRouteState] = useState(getRoute());
  useEffect(() => {
    const onHash = () => setRouteState(getRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // core
  const [tournamentName, setTournamentName] = useState("9th Annual Coinche Tournament");

  // players
  const [players, setPlayers] = useState([]); // {id,name}
  const [newPlayerName, setNewPlayerName] = useState("");
  const inputRef = useRef(null);

  // teams (exactly 8)
  const [teams, setTeams] = useState([]); // {id,name,playerIds:[p1,p2], locked:boolean}
  const [avoidSameTeams, setAvoidSameTeams] = useState(true);
  const [pairHistory, setPairHistory] = useState([]); // pair keys

  // tournament structure
  const [poolMap, setPoolMap] = useState({ A: [], B: [] });

  /**
   * games:
   * {
   *  id, stage:"POOL", pool:"A"|"B", round, table,
   *  teamAId, teamBId,
   *  scoreA, scoreB, winnerId, matchPtsA, matchPtsB,
   *  tableTarget: 2000,
   *  hands: [ {id, createdAt, ...handInput, scoreA, scoreB} ]
   * }
   */
  const [games, setGames] = useState([]);

  // bracket
  const [bracket, setBracket] = useState([]); // QF/SF/F/3P matches

  // scoring settings
  const [winThreshold, setWinThreshold] = useState(2000);
  const [winHighPts, setWinHighPts] = useState(2);
  const [winLowPts, setWinLowPts] = useState(1);

  // schedule/timer (manual start/pause)
  const [timerRunning, setTimerRunning] = useState(false);
  const [timerStartEpoch, setTimerStartEpoch] = useState(null); // ms
  const [timerElapsedMs, setTimerElapsedMs] = useState(0); // ms accumulated while paused
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!timerRunning) return;
    const t = setInterval(() => forceTick((x) => x + 1), 250);
    return () => clearInterval(t);
  }, [timerRunning]);

  const nowMs = Date.now();
  const timerLiveMs = timerRunning && timerStartEpoch ? timerElapsedMs + (nowMs - timerStartEpoch) : timerElapsedMs;

  // load
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        setTournamentName(data.tournamentName ?? "9th Annual Coinche Tournament");
        setPlayers(data.players ?? []);
        setTeams(data.teams ?? []);
        setAvoidSameTeams(Boolean(data.avoidSameTeams ?? true));
        setPairHistory(data.pairHistory ?? []);
        setPoolMap(data.poolMap ?? { A: [], B: [] });
        setGames(data.games ?? []);
        setBracket(data.bracket ?? []);
        setWinThreshold(data.winThreshold ?? 2000);
        setWinHighPts(data.winHighPts ?? 2);
        setWinLowPts(data.winLowPts ?? 1);

        setTimerRunning(Boolean(data.timerRunning ?? false));
        setTimerStartEpoch(data.timerStartEpoch ?? null);
        setTimerElapsedMs(data.timerElapsedMs ?? 0);
      } else {
        // initialize 8 empty teams by default (nice UX)
        initEmptyTeams();
      }
    } catch {
      // ignore
    } finally {
      setLoaded(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // persist
  useEffect(() => {
    if (!loaded) return;
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        tournamentName,
        players,
        teams,
        avoidSameTeams,
        pairHistory,
        poolMap,
        games,
        bracket,
        winThreshold,
        winHighPts,
        winLowPts,
        timerRunning,
        timerStartEpoch,
        timerElapsedMs,
      })
    );
  }, [
    loaded,
    tournamentName,
    players,
    teams,
    avoidSameTeams,
    pairHistory,
    poolMap,
    games,
    bracket,
    winThreshold,
    winHighPts,
    winLowPts,
    timerRunning,
    timerStartEpoch,
    timerElapsedMs,
  ]);

  const playerById = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);
  const teamById = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams]);

  const realTeams = useMemo(() => teams.filter((t) => !t.isBye), [teams]);
  const tournamentReady = useMemo(() => realTeams.length === 8 && realTeams.every((t) => t.playerIds?.length === 2), [realTeams]);

  /** ===== Basic actions ===== */
  function resetTournamentStructure() {
    setPoolMap({ A: [], B: [] });
    setGames([]);
    setBracket([]);
    // timer stays
  }

  function fullReset() {
    setTournamentName("9th Annual Coinche Tournament");
    setPlayers([]);
    setTeams([]);
    setPairHistory([]);
    setPoolMap({ A: [], B: [] });
    setGames([]);
    setBracket([]);
    setTimerRunning(false);
    setTimerStartEpoch(null);
    setTimerElapsedMs(0);
    initEmptyTeams();
  }

  function initEmptyTeams() {
    setTeams(
      Array.from({ length: 8 }).map((_, i) => ({
        id: uid("t"),
        name: `Team ${i + 1}`,
        playerIds: ["", ""],
        locked: false,
        isBye: false,
      }))
    );
  }

  /** ===== Players ===== */
  function addPlayer() {
    const name = newPlayerName.trim();
    if (!name) return;
    setPlayers((prev) => [...prev, { id: uid("p"), name }]);
    setNewPlayerName("");
    setTimeout(() => inputRef.current?.focus?.(), 0);
  }

  function removePlayer(id) {
    setPlayers((prev) => prev.filter((p) => p.id !== id));
    // also remove from teams if used
    setTeams((prev) =>
      prev.map((t) => ({
        ...t,
        playerIds: (t.playerIds || []).map((pid) => (pid === id ? "" : pid)),
      }))
    );
    resetTournamentStructure();
  }

  /** ===== Teams: manual picking + randomize unlocked ===== */
  function setTeamPlayer(teamId, slotIdx, playerId) {
    setTeams((prev) =>
      prev.map((t) => {
        if (t.id !== teamId) return t;
        const next = [...(t.playerIds || ["", ""])];
        next[slotIdx] = playerId;
        const p1 = playerById.get(next[0])?.name || "—";
        const p2 = playerById.get(next[1])?.name || "—";
        const name = next[0] && next[1] ? `${p1} / ${p2}` : t.name;
        return { ...t, playerIds: next, name };
      })
    );
    resetTournamentStructure();
  }

  function toggleTeamLock(teamId) {
    setTeams((prev) => prev.map((t) => (t.id === teamId ? { ...t, locked: !t.locked } : t)));
  }

  function randomizeUnlockedTeams() {
    // Pick from players not already assigned OR allow reuse? We'll enforce no duplicates across all teams.
    const used = new Set();
    teams.forEach((t) => (t.playerIds || []).forEach((pid) => pid && used.add(pid)));

    // Build pool of available players (unassigned) + allow reassignment for unlocked teams by clearing them first
    const clearedTeams = teams.map((t) => {
      if (t.locked) return t;
      return { ...t, playerIds: ["", ""], name: t.name };
    });

    const usedAfterClear = new Set();
    clearedTeams.forEach((t) => (t.playerIds || []).forEach((pid) => pid && usedAfterClear.add(pid)));

    const available = players.map((p) => p.id).filter((id) => !usedAfterClear.has(id));
    const shuffled = shuffleArray(available);

    // history logic (reduce repeats) only when fully building new pairs for unlocked teams
    const historySet = new Set(pairHistory);
    const tries = avoidSameTeams ? 30 : 1;

    let best = null;

    const unlockedTeamIds = clearedTeams.filter((t) => !t.locked).map((t) => t.id);
    const unlockedCount = unlockedTeamIds.length;

    // Need 2 players per unlocked team
    if (shuffled.length < unlockedCount * 2) {
      alert("Not enough unassigned players to fill unlocked teams. Add more players or unlock fewer teams.");
      return;
    }

    for (let attempt = 0; attempt < tries; attempt++) {
      const s = attempt === 0 ? shuffled : shuffleArray(shuffled);
      const pairs = [];
      for (let i = 0; i < unlockedCount * 2; i += 2) {
        pairs.push([s[i], s[i + 1]]);
      }

      let repeats = 0;
      for (const [a, b] of pairs) {
        const key = [a, b].sort().join("|");
        if (historySet.has(key)) repeats++;
      }

      if (!best || repeats < best.repeats) {
        best = { pairs, repeats };
        if (repeats === 0) break;
      }
    }

    const chosenPairs = best?.pairs ?? [];

    const updated = clearedTeams.map((t) => {
      if (t.locked) return t;
      const idx = unlockedTeamIds.indexOf(t.id);
      const pair = chosenPairs[idx];
      if (!pair) return t;

      const p1 = playerById.get(pair[0])?.name || "P1";
      const p2 = playerById.get(pair[1])?.name || "P2";
      return { ...t, playerIds: [pair[0], pair[1]], name: `${p1} / ${p2}` };
    });

    const newPairs = [];
    updated.forEach((t) => {
      if (t.playerIds?.length === 2 && t.playerIds[0] && t.playerIds[1]) {
        newPairs.push([...t.playerIds].sort().join("|"));
      }
    });

    setTeams(updated);
    setPairHistory((prev) => Array.from(new Set([...prev, ...newPairs])));
    resetTournamentStructure();
  }

  /** ===== Scheduling: pools ===== */
  function buildPoolAssignmentExact8(teamIds) {
    // deterministic-ish split after shuffle: 4 and 4
    const shuffled = shuffleArray(teamIds);
    return { A: shuffled.slice(0, 4), B: shuffled.slice(4, 8) };
  }

  function createPoolsRoundRobin() {
    if (!tournamentReady) {
      alert("You need exactly 8 teams with 2 players each.");
      return;
    }

    const teamIds = realTeams.map((t) => t.id);
    const pools = buildPoolAssignmentExact8(teamIds);
    setPoolMap(pools);

    const built = [];
    const makePoolGames = (poolName, ids, tableOffset) => {
      const rounds = circleRoundRobin(ids); // for 4 teams => 3 rounds, 2 matches each round
      rounds.forEach((pairings, rIdx) => {
        pairings.forEach(([a, b], pIdx) => {
          built.push({
            id: uid(`g_${poolName}`),
            stage: "POOL",
            pool: poolName,
            round: rIdx + 1,
            table: tableOffset + (pIdx + 1), // Pool A tables 1-2, Pool B tables 3-4
            teamAId: a,
            teamBId: b,
            scoreA: "0",
            scoreB: "0",
            winnerId: null,
            matchPtsA: 0,
            matchPtsB: 0,
            tableTarget: DEFAULT_TARGET,
            hands: [],
          });
        });
      });
    };

    makePoolGames("A", pools.A, 0);
    makePoolGames("B", pools.B, 2);

    setGames(built);
    setBracket([]);
  }

  /** ===== Game scoring (totals) ===== */
  function recomputeGameOutcome(game) {
    const a = safeInt(game.scoreA);
    const b = safeInt(game.scoreB);

    if (a === null || b === null) {
      return { ...game, winnerId: null, matchPtsA: 0, matchPtsB: 0 };
    }
    if (a === b) {
      return { ...game, winnerId: null, matchPtsA: 0, matchPtsB: 0 };
    }

    // Winner immediately at >= target (your rule)
    const target = Number(game.tableTarget) || DEFAULT_TARGET;
    const aReached = a >= target;
    const bReached = b >= target;
    const winnerId =
      aReached && !bReached ? game.teamAId : bReached && !aReached ? game.teamBId : a > b ? game.teamAId : game.teamBId;

    const winnerScore = Math.max(a, b);
    const mp = computeMatchPoints(winnerScore, winThreshold, winHighPts, winLowPts);

    return {
      ...game,
      winnerId,
      matchPtsA: winnerId === game.teamAId ? mp : 0,
      matchPtsB: winnerId === game.teamBId ? mp : 0,
    };
  }

  function recomputeFromHands(game) {
    const totalA = (game.hands || []).reduce((s, h) => s + (Number(h.scoreA) || 0), 0);
    const totalB = (game.hands || []).reduce((s, h) => s + (Number(h.scoreB) || 0), 0);
    const updated = { ...game, scoreA: String(totalA), scoreB: String(totalB) };
    return recomputeGameOutcome(updated);
  }

  function setGameTarget(gameId, target) {
    setGames((prev) =>
      prev.map((g) => {
        if (g.id !== gameId) return g;
        const updated = { ...g, tableTarget: clamp(Number(target) || DEFAULT_TARGET, 100, 99999) };
        return recomputeFromHands(updated);
      })
    );
  }

  function clearGame(gameId) {
    setGames((prev) =>
      prev.map((g) =>
        g.id === gameId
          ? recomputeGameOutcome({
              ...g,
              hands: [],
              scoreA: "0",
              scoreB: "0",
              winnerId: null,
              matchPtsA: 0,
              matchPtsB: 0,
            })
          : g
      )
    );
  }

  /** ===== Hands: add/edit/delete ===== */
  function addHand(gameId, handInput) {
    setGames((prev) =>
      prev.map((g) => {
        if (g.id !== gameId) return g;

        const res = computeFastCoincheHandScore(handInput);
        const newHand = {
          id: uid("hand"),
          createdAt: Date.now(),
          ...handInput,
          scoreA: res.scoreA,
          scoreB: res.scoreB,
        };

        const updated = { ...g, hands: [...(g.hands || []), newHand] };
        return recomputeFromHands(updated);
      })
    );
  }

  function updateHand(gameId, handId, patch) {
    setGames((prev) =>
      prev.map((g) => {
        if (g.id !== gameId) return g;

        const hands = (g.hands || []).map((h) => {
          if (h.id !== handId) return h;
          const next = { ...h, ...patch };
          const res = computeFastCoincheHandScore(next);
          return { ...next, scoreA: res.scoreA, scoreB: res.scoreB };
        });

        return recomputeFromHands({ ...g, hands });
      })
    );
  }

  function deleteHand(gameId, handId) {
    setGames((prev) =>
      prev.map((g) => {
        if (g.id !== gameId) return g;
        const hands = (g.hands || []).filter((h) => h.id !== handId);
        return recomputeFromHands({ ...g, hands });
      })
    );
  }

  /** ===== Standings ===== */
  function poolStandings(poolName) {
    const ids = poolMap[poolName] || [];
    const rows = ids
      .map((id) => {
        const t = teamById.get(id);
        return t ? { teamId: t.id, name: t.name, matchPoints: 0, totalGamePoints: 0, gamesPlayed: 0 } : null;
      })
      .filter(Boolean);

    const byId = new Map(rows.map((r) => [r.teamId, r]));

    games
      .filter((g) => g.stage === "POOL" && g.pool === poolName)
      .forEach((g) => {
        const a = byId.get(g.teamAId);
        const b = byId.get(g.teamBId);
        if (!a || !b) return;

        const sa = safeInt(g.scoreA);
        const sb = safeInt(g.scoreB);
        if (sa !== null && sb !== null) {
          a.totalGamePoints += sa;
          b.totalGamePoints += sb;
          a.gamesPlayed += 1;
          b.gamesPlayed += 1;
        }
        a.matchPoints += g.matchPtsA ?? 0;
        b.matchPoints += g.matchPtsB ?? 0;
      });

    return sortStandings(rows);
  }

  const standingsA = useMemo(() => (poolMap.A.length ? poolStandings("A") : []), [games, poolMap, teamById]);
  const standingsB = useMemo(() => (poolMap.B.length ? poolStandings("B") : []), [games, poolMap, teamById]);

  /** ===== Bracket ===== */
  function propagateBracketWinners(ms) {
    const byId = new Map(ms.map((m) => [m.id, { ...m }]));
    for (const m of ms) {
      if (!m.winnerId || !m.nextMatchId) continue;
      const next = byId.get(m.nextMatchId);
      if (!next) continue;
      const slotKey = m.nextSlot === "A" ? "teamAId" : "teamBId";
      if (next[slotKey] !== m.winnerId) {
        next[slotKey] = m.winnerId;
        next.winnerId = null;
        next.scoreA = "";
        next.scoreB = "";
      }
      byId.set(next.id, next);
    }
    return Array.from(byId.values());
  }

  function fillThirdPlace(ms) {
    const sf = ms.filter((x) => x.round === "SF");
    const third = ms.find((x) => x.round === "3P");
    if (!third || sf.length !== 2) return ms;
    if (!sf[0].teamAId || !sf[0].teamBId || !sf[0].winnerId) return ms;
    if (!sf[1].teamAId || !sf[1].teamBId || !sf[1].winnerId) return ms;

    const loser1 = sf[0].winnerId === sf[0].teamAId ? sf[0].teamBId : sf[0].teamAId;
    const loser2 = sf[1].winnerId === sf[1].teamAId ? sf[1].teamBId : sf[1].teamAId;

    if (third.teamAId === loser1 && third.teamBId === loser2) return ms;
    return ms.map((m) =>
      m.id === third.id ? { ...m, teamAId: loser1, teamBId: loser2, winnerId: null, scoreA: "", scoreB: "" } : m
    );
  }

  function buildBracketFromPools() {
    const a = standingsA.slice(0, 4).map((x) => x.teamId);
    const b = standingsB.slice(0, 4).map((x) => x.teamId);
    if (a.length < 4 || b.length < 4) {
      alert("Need pool standings with top 4 from each pool (enter some scores first).");
      return;
    }

    const qf = [
      { label: "QF1", A: a[0], B: b[3] },
      { label: "QF2", A: a[1], B: b[2] },
      { label: "QF3", A: b[0], B: a[3] },
      { label: "QF4", A: b[1], B: a[2] },
    ];

    const sfIds = [uid("m_sf"), uid("m_sf")];
    const fId = uid("m_f");
    const thirdId = uid("m_3p");

    const newBracket = [];

    qf.forEach((m, idx) => {
      const nextMatchId = idx < 2 ? sfIds[0] : sfIds[1];
      const nextSlot = idx % 2 === 0 ? "A" : "B";
      newBracket.push({
        id: uid("m_qf"),
        label: m.label,
        round: "QF",
        idx,
        teamAId: m.A,
        teamBId: m.B,
        scoreA: "",
        scoreB: "",
        winnerId: null,
        nextMatchId,
        nextSlot,
      });
    });

    newBracket.push({
      id: sfIds[0],
      label: "SF1",
      round: "SF",
      idx: 0,
      teamAId: null,
      teamBId: null,
      scoreA: "",
      scoreB: "",
      winnerId: null,
      nextMatchId: fId,
      nextSlot: "A",
    });
    newBracket.push({
      id: sfIds[1],
      label: "SF2",
      round: "SF",
      idx: 1,
      teamAId: null,
      teamBId: null,
      scoreA: "",
      scoreB: "",
      winnerId: null,
      nextMatchId: fId,
      nextSlot: "B",
    });

    newBracket.push({
      id: fId,
      label: "Final",
      round: "F",
      idx: 0,
      teamAId: null,
      teamBId: null,
      scoreA: "",
      scoreB: "",
      winnerId: null,
      nextMatchId: null,
      nextSlot: null,
    });

    newBracket.push({
      id: thirdId,
      label: "3rd Place",
      round: "3P",
      idx: 0,
      teamAId: null,
      teamBId: null,
      scoreA: "",
      scoreB: "",
      winnerId: null,
      nextMatchId: null,
      nextSlot: null,
    });

    setBracket(fillThirdPlace(propagateBracketWinners(newBracket)));
  }

  function setBracketScore(matchId, side, value) {
    setBracket((prev) => {
      const updated = prev.map((m) =>
        m.id === matchId ? { ...m, [side === "A" ? "scoreA" : "scoreB"]: value } : m
      );
      const withWinners = updated.map((m) => {
        if (m.id !== matchId) return m;
        if (!m.teamAId || !m.teamBId) return { ...m, winnerId: null };
        const a = safeInt(m.scoreA);
        const b = safeInt(m.scoreB);
        if (a === null || b === null) return { ...m, winnerId: null };
        if (a === b) return { ...m, winnerId: null };
        return { ...m, winnerId: a > b ? m.teamAId : m.teamBId };
      });
      return fillThirdPlace(propagateBracketWinners(withWinners));
    });
  }

  function clearBracketMatch(matchId) {
    setBracket((prev) => {
      const cleared = prev.map((m) =>
        m.id === matchId ? { ...m, scoreA: "", scoreB: "", winnerId: null } : m
      );
      return fillThirdPlace(propagateBracketWinners(cleared));
    });
  }

  /** ===== Winner board ===== */
  const winnerBoard = useMemo(() => {
    const final = bracket.find((m) => m.round === "F");
    const third = bracket.find((m) => m.round === "3P");

    const champId = final?.winnerId ?? null;
    const runnerId = final?.winnerId
      ? final.winnerId === final.teamAId
        ? final.teamBId
        : final.teamAId
      : null;
    const thirdId = third?.winnerId ?? null;

    return {
      champion: champId ? teamById.get(champId)?.name : null,
      runnerUp: runnerId ? teamById.get(runnerId)?.name : null,
      third: thirdId ? teamById.get(thirdId)?.name : null,
    };
  }, [bracket, teamById]);

  /** ===== Scoreboard: global standings across all pool games ===== */
  const overallScoreboard = useMemo(() => {
    const rows = realTeams.map((t) => ({
      teamId: t.id,
      name: t.name,
      matchPoints: 0,
      totalGamePoints: 0,
      gamesPlayed: 0,
      wins: 0,
      losses: 0,
      hands: 0,
      coinches: 0,
      surcoinches: 0,
      capots: 0,
      belotes: 0,
    }));

    const byId = new Map(rows.map((r) => [r.teamId, r]));

    games.forEach((g) => {
      const aRow = byId.get(g.teamAId);
      const bRow = byId.get(g.teamBId);
      if (!aRow || !bRow) return;

      const sa = safeInt(g.scoreA);
      const sb = safeInt(g.scoreB);

      if (sa !== null && sb !== null) {
        aRow.totalGamePoints += sa;
        bRow.totalGamePoints += sb;
        aRow.gamesPlayed += 1;
        bRow.gamesPlayed += 1;

        if (g.winnerId) {
          if (g.winnerId === g.teamAId) {
            aRow.wins += 1;
            bRow.losses += 1;
          } else {
            bRow.wins += 1;
            aRow.losses += 1;
          }
        }
      }

      aRow.matchPoints += g.matchPtsA ?? 0;
      bRow.matchPoints += g.matchPtsB ?? 0;

      const hands = g.hands || [];
      aRow.hands += hands.length;
      bRow.hands += hands.length;

      hands.forEach((h) => {
        if (h.coincheLevel === "COINCHE") {
          aRow.coinches += 1;
          bRow.coinches += 1;
        }
        if (h.coincheLevel === "SURCOINCHE") {
          aRow.surcoinches += 1;
          bRow.surcoinches += 1;
        }
        if (h.capot) {
          aRow.capots += 1;
          bRow.capots += 1;
        }
        if (h.beloteTeam === "A") aRow.belotes += 1;
        if (h.beloteTeam === "B") bRow.belotes += 1;
      });
    });

    // sort by matchPoints then totalGamePoints
    return sortStandings(rows);
  }, [realTeams, games]);

  /** ===== Stats + funny stats ===== */
  const stats = useMemo(() => {
    const allHands = games.flatMap((g) => (g.hands || []).map((h) => ({ ...h, gameId: g.id })));
    const totalHands = allHands.length;

    let biggestHand = null; // {score, hand, game}
    let biggestSwing = null; // abs(scoreA-scoreB)
    let highestBid = null;

    let totalPointsA = 0;
    let totalPointsB = 0;

    games.forEach((g) => {
      totalPointsA += Number(g.scoreA) || 0;
      totalPointsB += Number(g.scoreB) || 0;
    });

    allHands.forEach((h) => {
      const ha = Number(h.scoreA) || 0;
      const hb = Number(h.scoreB) || 0;
      const sum = ha + hb;
      const swing = Math.abs(ha - hb);

      if (!biggestHand || sum > biggestHand.sum) biggestHand = { sum, ha, hb, h };
      if (!biggestSwing || swing > biggestSwing.swing) biggestSwing = { swing, ha, hb, h };

      const bid = Number(h.bid) || 0;
      if (!highestBid || bid > highestBid.bid) highestBid = { bid, h };
    });

    // Funny awards based on scoreboard
    const topPoints = overallScoreboard[0] || null;
    const mostHands = [...overallScoreboard].sort((a, b) => (b.hands || 0) - (a.hands || 0))[0] || null;
    const mostBelotes = [...overallScoreboard].sort((a, b) => (b.belotes || 0) - (a.belotes || 0))[0] || null;
    const mostCoinches = [...overallScoreboard].sort(
      (a, b) => (b.coinches + b.surcoinches) - (a.coinches + a.surcoinches)
    )[0] || null;
    const capotKing = [...overallScoreboard].sort((a, b) => (b.capots || 0) - (a.capots || 0))[0] || null;

    return {
      totalHands,
      totalTablePoints: totalPointsA + totalPointsB,
      biggestHand,
      biggestSwing,
      highestBid,
      funny: {
        pointVacuum: topPoints ? { title: "Point Vacuum", team: topPoints.name, value: `${topPoints.totalGamePoints} pts` } : null,
        marathonTable: mostHands ? { title: "Marathon Hands", team: mostHands.name, value: `${mostHands.hands} hands` } : null,
        beloteBandit: mostBelotes ? { title: "Belote Bandit", team: mostBelotes.name, value: `${mostBelotes.belotes} belotes` } : null,
        coincheMonster: mostCoinches ? { title: "Coinche Monster", team: mostCoinches.name, value: `${mostCoinches.coinches + mostCoinches.surcoinches} coinches` } : null,
        capotKing: capotKing ? { title: "Capot King", team: capotKing.name, value: `${capotKing.capots} capots` } : null,
      },
    };
  }, [games, overallScoreboard]);

  /** ===== Schedule blocks ===== */
  const schedule = useMemo(() => {
    // Pools (3 rounds), then QF, SF, Final+3P
    const blocks = [
      { key: "P1", label: "Pool Round 1", tables: 4 },
      { key: "P2", label: "Pool Round 2", tables: 4 },
      { key: "P3", label: "Pool Round 3", tables: 4 },
      { key: "QF", label: "Quarterfinals (4 matches)", tables: 4 },
      { key: "SF", label: "Semifinals (2 matches)", tables: 2 },
      { key: "F", label: "Final + 3rd Place (2 matches)", tables: 2 },
    ];
    return blocks.map((b, idx) => {
      const startMin = idx * SLOT_MINUTES;
      const endMin = startMin + GAME_MINUTES;
      return { ...b, slotIndex: idx, startMin, endMin };
    });
  }, []);

  const currentSlot = useMemo(() => {
    const slotMs = SLOT_MINUTES * 60 * 1000;
    const idx = Math.floor(timerLiveMs / slotMs);
    return schedule[idx] || null;
  }, [timerLiveMs, schedule]);

  function timerStart() {
    if (timerRunning) return;
    setTimerRunning(true);
    setTimerStartEpoch(Date.now());
  }
  function timerPause() {
    if (!timerRunning) return;
    const now = Date.now();
    setTimerElapsedMs((prev) => prev + (timerStartEpoch ? now - timerStartEpoch : 0));
    setTimerRunning(false);
    setTimerStartEpoch(null);
  }
  function timerReset() {
    setTimerRunning(false);
    setTimerStartEpoch(null);
    setTimerElapsedMs(0);
  }

  /** ===== Views: Admin/Public/Table ===== */
  const isPublic = route.path === "/public";
  const isTable = route.path === "/table";
  const isAdmin = !isPublic && !isTable;

  const publicLink = `${window.location.origin}${window.location.pathname}#/public`;
  const tableLink = `${window.location.origin}${window.location.pathname}#/table`;

  /** ===== Table View selector ===== */
  const tableGames = useMemo(() => {
    // for 8-team pools we have tables 1..4 per round. We'll show all pool games (and later we can add bracket)
    return [...games].sort((a, b) => (a.round || 0) - (b.round || 0) || (a.table || 0) - (b.table || 0));
  }, [games]);

  const selectedTable = route.q.table ? Number(route.q.table) : 1;
  const selectedRound = route.q.round ? Number(route.q.round) : 1;
  const selectedPool = route.q.pool ? route.q.pool : "A";

  const tableMatch = useMemo(() => {
    // Find match by pool+round+table
    return games.find(
      (g) => g.stage === "POOL" && g.pool === selectedPool && g.round === selectedRound && g.table === selectedTable
    );
  }, [games, selectedPool, selectedRound, selectedTable]);

  /** ===== Bracket sorting + visual layout ===== */
  const bracketByRound = useMemo(() => {
    const qf = bracket.filter((m) => m.round === "QF").sort((a, b) => a.idx - b.idx);
    const sf = bracket.filter((m) => m.round === "SF").sort((a, b) => a.idx - b.idx);
    const f = bracket.filter((m) => m.round === "F");
    const p3 = bracket.filter((m) => m.round === "3P");
    return { qf, sf, f: f[0] || null, p3: p3[0] || null };
  }, [bracket]);

  /** ===== Helper UI ===== */
  function TeamName({ id }) {
    const nm = id ? teamById.get(id)?.name : null;
    return <span style={{ fontWeight: 900 }}>{nm || "TBD"}</span>;
  }

  function SectionTitle({ children, sub }) {
    return (
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
        <div style={{ fontSize: 18, fontWeight: 1000, color: UI.text }}>{children}</div>
        {sub ? <div style={{ color: UI.muted, fontWeight: 800, fontSize: 12 }}>{sub}</div> : null}
      </div>
    );
  }

  /** ===== RENDER ===== */
  return (
    <div style={{ minHeight: "100vh", background: UI.bg, color: UI.text }}>
      {/* top bar */}
      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 10,
          background: "linear-gradient(180deg, rgba(11,18,32,0.96), rgba(11,18,32,0.86))",
          borderBottom: `1px solid ${UI.border}`,
          backdropFilter: "blur(10px)",
        }}
      >
        <div style={{ maxWidth: 1200, margin: "0 auto", padding: "14px 14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <div>
              <div style={{ fontWeight: 1000, fontSize: isPublic ? 22 : 20 }}>{tournamentName}</div>
              <div style={{ color: UI.muted, fontWeight: 800, fontSize: 12, marginTop: 2 }}>
                {isAdmin ? "Admin" : isPublic ? "Public View (read-only)" : "Table View (enter hands)"}
                {" • "}
                {tournamentReady ? "8 teams ready" : "Setup: add players + assign teams"}
              </div>
            </div>

            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <Chip tone={timerRunning ? "good" : "warn"}>{timerRunning ? "LIVE TIMER" : "TIMER PAUSED"}</Chip>
              <Chip>
                {formatMinutes(timerLiveMs)}{" "}
                <span style={{ color: UI.muted, fontWeight: 900 }}>
                  ({START_TIME_STR} start plan)
                </span>
              </Chip>

              {currentSlot ? <Chip tone="warn">Now: {currentSlot.label}</Chip> : <Chip tone="neutral">Now: —</Chip>}

              <Btn kind="ghost" small onClick={() => setRoute("/admin")}>Admin</Btn>
              <Btn kind="ghost" small onClick={() => setRoute("/public")}>Public</Btn>
              <Btn kind="ghost" small onClick={() => setRoute("/table")}>Table</Btn>
            </div>
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 1200, margin: "0 auto", padding: 14 }}>
        {/* PUBLIC VIEW */}
        {isPublic ? (
          <PublicView
            overallScoreboard={overallScoreboard}
            standingsA={standingsA}
            standingsB={standingsB}
            bracketByRound={bracketByRound}
            teamById={teamById}
            winnerBoard={winnerBoard}
            stats={stats}
            schedule={schedule}
          />
        ) : null}

        {/* TABLE VIEW */}
        {isTable ? (
          <TableView
            tableLink={tableLink}
            games={games}
            teamById={teamById}
            selectedPool={selectedPool}
            selectedRound={selectedRound}
            selectedTable={selectedTable}
            tableMatch={tableMatch}
            onPick={(pool, round, table) => setRoute("/table", { pool, round, table })}
            onSetTarget={setGameTarget}
            onAddHand={addHand}
            onUpdateHand={updateHand}
            onDeleteHand={deleteHand}
            onClearGame={clearGame}
          />
        ) : null}

        {/* ADMIN VIEW */}
        {isAdmin ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 14 }}>
            {/* Links + timer + schedule */}
            <Card
              title="Quick Links + Schedule Timer"
              right={
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <Btn kind="ghost" onClick={() => navigator.clipboard?.writeText(publicLink)}>Copy Public Link</Btn>
                  <Btn kind="ghost" onClick={() => navigator.clipboard?.writeText(tableLink)}>Copy Table Link</Btn>
                </div>
              }
            >
              <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 12 }}>
                <div>
                  <div style={{ color: UI.muted, fontWeight: 900, fontSize: 12 }}>Public View</div>
                  <div style={{ fontWeight: 900, overflowWrap: "anywhere" }}>{publicLink}</div>
                  <div style={{ height: 8 }} />
                  <div style={{ color: UI.muted, fontWeight: 900, fontSize: 12 }}>Table View</div>
                  <div style={{ fontWeight: 900, overflowWrap: "anywhere" }}>{tableLink}</div>

                  <Divider />

                  <SectionTitle sub="Start/Pause any time (no auto-start)">Timer Controls</SectionTitle>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
                    <Btn onClick={timerStart} disabled={timerRunning}>Start</Btn>
                    <Btn kind="secondary" onClick={timerPause} disabled={!timerRunning}>Pause</Btn>
                    <Btn kind="danger" onClick={timerReset}>Reset</Btn>
                  </div>
                  <div style={{ marginTop: 10, color: UI.muted, fontWeight: 800 }}>
                    Slot length: {GAME_MINUTES} min game + {BREAK_MINUTES} min break = {SLOT_MINUTES} minutes
                  </div>
                </div>

                <div>
                  <SectionTitle sub={`${START_TIME_STR} planned start`}>Schedule</SectionTitle>
                  <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
                    {schedule.map((s) => (
                      <div
                        key={s.key}
                        style={{
                          border: `1px solid ${UI.border}`,
                          borderRadius: 14,
                          padding: 10,
                          background: currentSlot?.key === s.key ? "rgba(96,165,250,0.14)" : UI.panel2,
                          display: "flex",
                          justifyContent: "space-between",
                          gap: 10,
                        }}
                      >
                        <div style={{ fontWeight: 950 }}>{s.label}</div>
                        <div style={{ color: UI.muted, fontWeight: 900 }}>
                          Tables: {s.tables} • Slot #{s.slotIndex + 1}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </Card>

            {/* Settings */}
            <Card title="Tournament Settings">
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                <div>
                  <div style={{ color: UI.muted, fontWeight: 900, fontSize: 12 }}>Tournament name</div>
                  <TextInput value={tournamentName} onChange={setTournamentName} width={380} />
                </div>

                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 900 }}>
                    <input
                      type="checkbox"
                      checked={avoidSameTeams}
                      onChange={(e) => setAvoidSameTeams(e.target.checked)}
                    />
                    Avoid repeating teams when randomizing
                  </label>
                </div>
              </div>

              <Divider />

              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <SettingBox label="Win threshold (points)" value={winThreshold} onChange={(v) => setWinThreshold(clamp(Number(v || 0), 0, 99999))} />
                <SettingBox label="Match points (win ≥ threshold)" value={winHighPts} onChange={(v) => setWinHighPts(clamp(Number(v || 0), 0, 99))} />
                <SettingBox label="Match points (win < threshold)" value={winLowPts} onChange={(v) => setWinLowPts(clamp(Number(v || 0), 0, 99))} />
              </div>

              <div style={{ marginTop: 10, color: UI.muted, fontWeight: 800, fontSize: 12 }}>
                Standings tiebreaker: total game points (sum of table totals).
              </div>
            </Card>

            {/* Players */}
            <Card title={`Players (${players.length})`}>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <TextInput
                  value={newPlayerName}
                  onChange={setNewPlayerName}
                  placeholder="Add player name"
                  width={260}
                />
                <Btn onClick={addPlayer} disabled={!newPlayerName.trim()}>Add player</Btn>
              </div>

              <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 10 }}>
                {players.map((p) => (
                  <div
                    key={p.id}
                    style={{
                      border: `1px solid ${UI.border}`,
                      borderRadius: 14,
                      padding: 12,
                      background: UI.panel2,
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 10,
                      alignItems: "center",
                    }}
                  >
                    <div style={{ fontWeight: 950, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {p.name}
                    </div>
                    <Btn kind="danger" small onClick={() => removePlayer(p.id)}>Remove</Btn>
                  </div>
                ))}
                {players.length === 0 ? <div style={{ color: UI.muted, fontWeight: 800 }}>Add players to get started.</div> : null}
              </div>
            </Card>

            {/* Teams */}
            <Card
              title="Teams (exactly 8)"
              right={
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <Btn kind="secondary" onClick={randomizeUnlockedTeams} disabled={players.length < 16}>
                    Randomize UNLOCKED teams
                  </Btn>
                  <Btn kind="ghost" onClick={initEmptyTeams}>Reset teams to Team 1…8</Btn>
                </div>
              }
            >
              <div style={{ color: UI.muted, fontWeight: 800, marginBottom: 10 }}>
                Tip: assign players manually OR lock some teams then randomize the rest. (Needs 16 players to fill all teams.)
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(290px, 1fr))", gap: 10 }}>
                {teams.map((t, idx) => (
                  <div
                    key={t.id}
                    style={{
                      border: `1px solid ${UI.border}`,
                      borderRadius: 16,
                      padding: 12,
                      background: t.locked ? "rgba(34,197,94,0.08)" : UI.panel2,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
                      <div style={{ fontWeight: 1000 }}>
                        {t.name || `Team ${idx + 1}`}{" "}
                        {t.locked ? <Chip tone="good">LOCKED</Chip> : <Chip>UNLOCKED</Chip>}
                      </div>
                      <Btn kind="ghost" small onClick={() => toggleTeamLock(t.id)}>
                        {t.locked ? "Unlock" : "Lock"}
                      </Btn>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
                      <div>
                        <div style={{ color: UI.muted, fontWeight: 900, fontSize: 12 }}>Player 1</div>
                        <Select
                          value={t.playerIds?.[0] || ""}
                          onChange={(v) => setTeamPlayer(t.id, 0, v)}
                          options={[
                            { value: "", label: "— Select —" },
                            ...players.map((p) => ({ value: p.id, label: p.name })),
                          ]}
                          width={220}
                        />
                      </div>
                      <div>
                        <div style={{ color: UI.muted, fontWeight: 900, fontSize: 12 }}>Player 2</div>
                        <Select
                          value={t.playerIds?.[1] || ""}
                          onChange={(v) => setTeamPlayer(t.id, 1, v)}
                          options={[
                            { value: "", label: "— Select —" },
                            ...players.map((p) => ({ value: p.id, label: p.name })),
                          ]}
                          width={220}
                        />
                      </div>
                    </div>

                    <div style={{ marginTop: 10, color: UI.muted, fontWeight: 800, fontSize: 12 }}>
                      When both players are set, the team name updates automatically.
                    </div>
                  </div>
                ))}
              </div>

              <Divider />

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                {tournamentReady ? <Chip tone="good">8 teams ready ✅</Chip> : <Chip tone="warn">Need 8 teams filled (16 players) ⚠️</Chip>}
                <Chip>Tables: 4</Chip>
                <Chip>Target: {DEFAULT_TARGET}</Chip>
              </div>
            </Card>

            {/* Tournament Controls */}
            <Card
              title="Tournament Builder"
              right={
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <Btn onClick={createPoolsRoundRobin} disabled={!tournamentReady}>
                    Create Pools + Round Robin
                  </Btn>
                  <Btn kind="secondary" onClick={buildBracketFromPools} disabled={standingsA.length < 4 || standingsB.length < 4}>
                    Create Bracket
                  </Btn>
                  <Btn kind="danger" onClick={resetTournamentStructure} disabled={games.length === 0 && bracket.length === 0}>
                    Clear tournament
                  </Btn>
                </div>
              }
            >
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <ScoreboardCard overallScoreboard={overallScoreboard} stats={stats} />
                <WinnerBoardCard winnerBoard={winnerBoard} />
              </div>

              <Divider />

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <PoolCard
                  title="Pool A"
                  poolKey="A"
                  poolMap={poolMap}
                  teamById={teamById}
                  standings={standingsA}
                  games={games}
                  onPickTable={(pool, round, table) => setRoute("/table", { pool, round, table })}
                  onSetTarget={setGameTarget}
                  onAddHand={addHand}
                  onUpdateHand={updateHand}
                  onDeleteHand={deleteHand}
                  onClearGame={clearGame}
                />
                <PoolCard
                  title="Pool B"
                  poolKey="B"
                  poolMap={poolMap}
                  teamById={teamById}
                  standings={standingsB}
                  games={games}
                  onPickTable={(pool, round, table) => setRoute("/table", { pool, round, table })}
                  onSetTarget={setGameTarget}
                  onAddHand={addHand}
                  onUpdateHand={updateHand}
                  onDeleteHand={deleteHand}
                  onClearGame={clearGame}
                />
              </div>

              <Divider />

              <Card title="Bracket (visual)">
                <BracketVisual
                  bracketByRound={bracketByRound}
                  teamById={teamById}
                  onScore={setBracketScore}
                  onClear={clearBracketMatch}
                />
              </Card>

              <Divider />

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ color: UI.muted, fontWeight: 900 }}>
                  Public & Table views are read-only / table-only inside THIS device (localStorage). Supabase later makes it live for everyone.
                </div>
                <Btn kind="danger" onClick={fullReset}>FULL RESET (everything)</Btn>
              </div>
            </Card>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** ===== Subcomponents ===== */

function SettingBox({ label, value, onChange }) {
  return (
    <div style={{ minWidth: 240 }}>
      <div style={{ color: UI.muted, fontWeight: 900, fontSize: 12 }}>{label}</div>
      <TextInput value={String(value)} onChange={onChange} width={180} />
    </div>
  );
}

function ScoreboardCard({ overallScoreboard, stats }) {
  return (
    <Card title="Live Scoreboard + Stats" right={<Chip tone="good">LIVE</Chip>}>
      <div style={{ color: UI.muted, fontWeight: 900, marginBottom: 10 }}>
        Sort: match points, then total points.
      </div>

      <div style={{ display: "grid", gap: 8 }}>
        {overallScoreboard.slice(0, 8).map((s, idx) => (
          <div
            key={s.teamId}
            style={{
              border: `1px solid ${UI.border}`,
              borderRadius: 14,
              padding: 10,
              background: idx === 0 ? "rgba(34,197,94,0.08)" : UI.panel2,
              display: "flex",
              justifyContent: "space-between",
              gap: 10,
              alignItems: "center",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 1000, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                #{idx + 1} {s.name}
              </div>
              <div style={{ color: UI.muted, fontWeight: 800, fontSize: 12 }}>
                W-L: {s.wins}-{s.losses} • Total pts: {s.totalGamePoints} • Hands: {s.hands}
              </div>
            </div>
            <Chip tone="warn">MP: {s.matchPoints}</Chip>
          </div>
        ))}
      </div>

      <Divider />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <StatMini label="Total hands played" value={stats.totalHands} />
        <StatMini label="Total table points" value={stats.totalTablePoints} />

        <StatMini
          label="Biggest hand (A+B)"
          value={stats.biggestHand ? `${stats.biggestHand.sum} pts` : "—"}
          sub={stats.biggestHand ? `A ${stats.biggestHand.ha} / B ${stats.biggestHand.hb}` : ""}
        />
        <StatMini
          label="Biggest swing"
          value={stats.biggestSwing ? `${stats.biggestSwing.swing} pts` : "—"}
          sub={stats.biggestSwing ? `A ${stats.biggestSwing.ha} / B ${stats.biggestSwing.hb}` : ""}
        />
      </div>

      <Divider />

      <div style={{ fontWeight: 1000, marginBottom: 8 }}>Funny Awards</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {Object.values(stats.funny)
          .filter(Boolean)
          .map((a) => (
            <div key={a.title} style={{ border: `1px solid ${UI.border}`, borderRadius: 14, padding: 10, background: UI.panel2 }}>
              <div style={{ color: UI.muted, fontWeight: 900, fontSize: 12 }}>{a.title}</div>
              <div style={{ fontWeight: 1000 }}>{a.team}</div>
              <div style={{ color: UI.muted, fontWeight: 900, fontSize: 12 }}>{a.value}</div>
            </div>
          ))}
      </div>
    </Card>
  );
}

function StatMini({ label, value, sub }) {
  return (
    <div style={{ border: `1px solid ${UI.border}`, borderRadius: 14, padding: 10, background: UI.panel2 }}>
      <div style={{ color: UI.muted, fontWeight: 900, fontSize: 12 }}>{label}</div>
      <div style={{ fontWeight: 1100, fontSize: 18 }}>{value}</div>
      {sub ? <div style={{ color: UI.muted, fontWeight: 900, fontSize: 12 }}>{sub}</div> : null}
    </div>
  );
}

function WinnerBoardCard({ winnerBoard }) {
  return (
    <Card title="Winner Board">
      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10 }}>
        <Podium label="Champion" value={winnerBoard.champion} tone="good" />
        <Podium label="Runner-up" value={winnerBoard.runnerUp} tone="warn" />
        <Podium label="3rd Place" value={winnerBoard.third} tone="neutral" />
      </div>

      <Divider />
      <div style={{ color: UI.muted, fontWeight: 900 }}>
        When bracket is completed, winners appear here automatically.
      </div>
    </Card>
  );
}

function Podium({ label, value, tone }) {
  return (
    <div style={{ border: `1px solid ${UI.border}`, borderRadius: 14, padding: 12, background: UI.panel2 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
        <div style={{ color: UI.muted, fontWeight: 900, fontSize: 12 }}>{label}</div>
        <Chip tone={tone}>{value ? "SET" : "—"}</Chip>
      </div>
      <div style={{ fontSize: 18, fontWeight: 1100 }}>{value || "—"}</div>
    </div>
  );
}

function PoolCard({
  title,
  poolKey,
  poolMap,
  teamById,
  standings,
  games,
  onPickTable,
  onSetTarget,
  onAddHand,
  onUpdateHand,
  onDeleteHand,
  onClearGame,
}) {
  const poolTeams = poolMap[poolKey] || [];
  const poolGames = games
    .filter((g) => g.stage === "POOL" && g.pool === poolKey)
    .sort((a, b) => a.round - b.round || a.table - b.table);

  return (
    <Card
      title={title}
      right={<Chip>{poolTeams.length ? `Teams: ${poolTeams.length}` : "Not created"}</Chip>}
    >
      <div style={{ color: UI.muted, fontWeight: 900, marginBottom: 10 }}>
        {poolTeams.length
          ? poolTeams.map((id) => teamById.get(id)?.name).filter(Boolean).join(" • ")
          : "Create pools to assign teams."}
      </div>

      <Divider />

      <div style={{ fontWeight: 1000, marginBottom: 8 }}>Standings</div>
      <div style={{ display: "grid", gap: 8 }}>
        {standings.map((s, idx) => (
          <div
            key={s.teamId}
            style={{
              border: `1px solid ${UI.border}`,
              borderRadius: 14,
              padding: 10,
              background: idx === 0 ? "rgba(96,165,250,0.12)" : UI.panel2,
              display: "flex",
              justifyContent: "space-between",
              gap: 10,
              alignItems: "center",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 1000, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                #{idx + 1} {s.name}
              </div>
              <div style={{ color: UI.muted, fontWeight: 900, fontSize: 12 }}>Tiebreak pts: {s.totalGamePoints}</div>
            </div>
            <Chip tone="warn">MP: {s.matchPoints}</Chip>
          </div>
        ))}
        {standings.length === 0 ? <div style={{ color: UI.muted, fontWeight: 900 }}>Standings appear after schedule.</div> : null}
      </div>

      <Divider />

      <div style={{ fontWeight: 1000, marginBottom: 8 }}>Matches</div>

      {poolGames.length === 0 ? (
        <div style={{ color: UI.muted, fontWeight: 900 }}>Create pools to see matches.</div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {Array.from(new Set(poolGames.map((g) => g.round))).map((r) => (
            <div key={r} style={{ border: `1px solid ${UI.border}`, borderRadius: 16, padding: 10, background: "rgba(0,0,0,0.14)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
                <div style={{ fontWeight: 1100 }}>Round {r}</div>
                <Chip>Tables: {poolGames.filter((g) => g.round === r).length}</Chip>
              </div>

              <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
                {poolGames
                  .filter((g) => g.round === r)
                  .map((g) => (
                    <MatchMini
                      key={g.id}
                      g={g}
                      teamById={teamById}
                      onPickTable={() => onPickTable(g.pool, g.round, g.table)}
                      onSetTarget={(t) => onSetTarget(g.id, t)}
                      onAddHand={(hand) => onAddHand(g.id, hand)}
                      onUpdateHand={(handId, patch) => onUpdateHand(g.id, handId, patch)}
                      onDeleteHand={(handId) => onDeleteHand(g.id, handId)}
                      onClear={() => onClearGame(g.id)}
                    />
                  ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function MatchMini({ g, teamById, onPickTable, onSetTarget, onAddHand, onUpdateHand, onDeleteHand, onClear }) {
  const aName = teamById.get(g.teamAId)?.name || "—";
  const bName = teamById.get(g.teamBId)?.name || "—";
  const aScore = Number(g.scoreA) || 0;
  const bScore = Number(g.scoreB) || 0;
  const target = Number(g.tableTarget) || DEFAULT_TARGET;

  const pending = !g.winnerId;
  const winner = g.winnerId ? teamById.get(g.winnerId)?.name : null;

  const tone = !pending ? "good" : aScore || bScore ? "warn" : "neutral";

  return (
    <div style={{ border: `1px solid ${UI.border}`, borderRadius: 16, padding: 12, background: UI.panel2 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <div style={{ fontWeight: 1100 }}>
          <Chip>Table {g.table}</Chip>{" "}
          <span style={{ color: UI.muted, fontWeight: 900 }}>•</span>{" "}
          {aName} <span style={{ color: UI.muted }}>vs</span> {bName}
        </div>
        <Chip tone={tone}>{pending ? "In progress" : `Winner: ${winner}`}</Chip>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10, alignItems: "center" }}>
        <Chip tone={aScore >= target ? "good" : "neutral"}>A: {aScore}</Chip>
        <Chip tone={bScore >= target ? "good" : "neutral"}>B: {bScore}</Chip>
        <Chip>Target: {target}</Chip>
        <Chip tone="warn">MP A +{g.matchPtsA} / B +{g.matchPtsB}</Chip>

        <Btn kind="ghost" small onClick={onPickTable} style={{ marginLeft: "auto" }}>
          Open Table View
        </Btn>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10, alignItems: "center" }}>
        <div style={{ color: UI.muted, fontWeight: 900, fontSize: 12 }}>Edit target</div>
        <TextInput value={String(g.tableTarget || DEFAULT_TARGET)} onChange={(v) => onSetTarget(v)} width={120} />
        <Btn kind="ghost" small onClick={onClear}>Clear match</Btn>
      </div>

      <Divider />

      <HandsEditor
        compact
        target={target}
        totalA={aScore}
        totalB={bScore}
        hands={g.hands || []}
        onAdd={onAddHand}
        onUpdate={onUpdateHand}
        onDelete={onDeleteHand}
      />
    </div>
  );
}

function BracketVisual({ bracketByRound, teamById, onScore, onClear }) {
  const { qf, sf, f, p3 } = bracketByRound;

  if ((!qf || qf.length === 0) && !f && !p3) {
    return <div style={{ color: UI.muted, fontWeight: 900 }}>Create bracket to see it here.</div>;
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
      <BracketCol title="Quarterfinals">
        {qf.map((m) => (
          <BracketMatch key={m.id} m={m} teamById={teamById} onScore={onScore} onClear={onClear} />
        ))}
      </BracketCol>

      <BracketCol title="Semifinals">
        {sf.map((m) => (
          <BracketMatch key={m.id} m={m} teamById={teamById} onScore={onScore} onClear={onClear} />
        ))}
      </BracketCol>

      <BracketCol title="Finals">
        {f ? <BracketMatch m={f} teamById={teamById} onScore={onScore} onClear={onClear} big /> : null}
        {p3 ? (
          <div style={{ marginTop: 10 }}>
            <div style={{ color: UI.muted, fontWeight: 900, marginBottom: 6 }}>3rd Place</div>
            <BracketMatch m={p3} teamById={teamById} onScore={onScore} onClear={onClear} />
          </div>
        ) : null}
      </BracketCol>
    </div>
  );
}

function BracketCol({ title, children }) {
  return (
    <div style={{ border: `1px solid ${UI.border}`, borderRadius: 16, padding: 12, background: "rgba(0,0,0,0.14)" }}>
      <div style={{ fontWeight: 1100, marginBottom: 10 }}>{title}</div>
      <div style={{ display: "grid", gap: 10 }}>{children}</div>
    </div>
  );
}

function BracketMatch({ m, teamById, onScore, onClear, big }) {
  const aName = m.teamAId ? teamById.get(m.teamAId)?.name : "TBD";
  const bName = m.teamBId ? teamById.get(m.teamBId)?.name : "TBD";
  const pending = !m.winnerId;
  const winner = m.winnerId ? teamById.get(m.winnerId)?.name : null;

  return (
    <div style={{ border: `1px solid ${UI.border}`, borderRadius: 16, padding: 12, background: UI.panel2 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
        <div style={{ fontWeight: 1200, fontSize: big ? 16 : 14 }}>
          {m.label} <span style={{ color: UI.muted, fontWeight: 900 }}>({m.round})</span>
        </div>
        <Chip tone={pending ? "warn" : "good"}>{pending ? "Pending" : `Winner: ${winner}`}</Chip>
      </div>

      <div style={{ marginTop: 8, fontWeight: 1000 }}>{aName}</div>
      <div style={{ marginTop: 2, fontWeight: 1000 }}>{bName}</div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 10 }}>
        <TextInput value={m.scoreA} onChange={(v) => onScore(m.id, "A", v)} width={90} placeholder="A pts" />
        <span style={{ color: UI.muted, fontWeight: 900 }}>vs</span>
        <TextInput value={m.scoreB} onChange={(v) => onScore(m.id, "B", v)} width={90} placeholder="B pts" />
        <Btn kind="ghost" small onClick={() => onClear(m.id)} style={{ marginLeft: "auto" }}>
          Clear
        </Btn>
      </div>

      {m.nextMatchId ? (
        <div style={{ marginTop: 8, color: UI.muted, fontWeight: 900, fontSize: 12 }}>
          Winner advances → slot {m.nextSlot}
        </div>
      ) : null}
    </div>
  );
}

function HandsEditor({ compact, target, totalA, totalB, hands, onAdd, onUpdate, onDelete }) {
  const [form, setForm] = useState({
    bidder: "A",
    bid: 80,
    coincheLevel: "NONE",
    capot: false,
    bidderTrickPoints: 81,
    announceA: 0,
    announceB: 0,
    beloteTeam: "NONE",
  });

  const winnerA = totalA >= target;
  const winnerB = totalB >= target;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ fontWeight: 1100 }}>Hand-by-hand tracker</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Chip tone={winnerA ? "good" : "neutral"}>A total: {totalA}</Chip>
          <Chip tone={winnerB ? "good" : "neutral"}>B total: {totalB}</Chip>
          <Chip>First to {target}</Chip>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: compact ? "repeat(auto-fit, minmax(160px, 1fr))" : "repeat(auto-fit, minmax(190px, 1fr))", gap: 10, marginTop: 10 }}>
        <Field label="Bidder">
          <Select
            value={form.bidder}
            onChange={(v) => setForm((p) => ({ ...p, bidder: v }))}
            options={[
              { value: "A", label: "Team A (left)" },
              { value: "B", label: "Team B (right)" },
            ]}
            width={compact ? 170 : 190}
          />
        </Field>

        <Field label="Bid">
          <TextInput value={String(form.bid)} onChange={(v) => setForm((p) => ({ ...p, bid: Number(v || 0) }))} width={compact ? 120 : 150} />
        </Field>

        <Field label="Coinche">
          <Select
            value={form.coincheLevel}
            onChange={(v) => setForm((p) => ({ ...p, coincheLevel: v }))}
            options={[
              { value: "NONE", label: "None" },
              { value: "COINCHE", label: "Coinche (x2)" },
              { value: "SURCOINCHE", label: "Surcoinche (x4)" },
            ]}
            width={compact ? 170 : 190}
          />
        </Field>

        <Field label="Capot">
          <Select
            value={form.capot ? "YES" : "NO"}
            onChange={(v) => setForm((p) => ({ ...p, capot: v === "YES" }))}
            options={[
              { value: "NO", label: "No" },
              { value: "YES", label: "Yes" },
            ]}
            width={compact ? 120 : 150}
          />
        </Field>

        <Field label="Bidder trick pts (0–162)">
          <TextInput
            value={String(form.bidderTrickPoints)}
            onChange={(v) => setForm((p) => ({ ...p, bidderTrickPoints: Number(v || 0) }))}
            width={compact ? 140 : 170}
          />
        </Field>

        <Field label="Announces A (non-belote)">
          <TextInput value={String(form.announceA)} onChange={(v) => setForm((p) => ({ ...p, announceA: Number(v || 0) }))} width={compact ? 140 : 170} />
        </Field>

        <Field label="Announces B (non-belote)">
          <TextInput value={String(form.announceB)} onChange={(v) => setForm((p) => ({ ...p, announceB: Number(v || 0) }))} width={compact ? 140 : 170} />
        </Field>

        <Field label="Belote (who has it)">
          <Select
            value={form.beloteTeam}
            onChange={(v) => setForm((p) => ({ ...p, beloteTeam: v }))}
            options={[
              { value: "NONE", label: "None" },
              { value: "A", label: "Team A" },
              { value: "B", label: "Team B" },
            ]}
            width={compact ? 160 : 190}
          />
        </Field>
      </div>

      <div style={{ display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
        <Btn
          onClick={() => {
            onAdd(form);
          }}
          disabled={winnerA || winnerB}
        >
          Add Hand
        </Btn>
        {winnerA || winnerB ? (
          <Chip tone="good">Match ended (winner reached {target})</Chip>
        ) : (
          <Chip tone="warn">Match live</Chip>
        )}
        <div style={{ color: UI.muted, fontWeight: 900, fontSize: 12 }}>
          You can edit any hand below — totals recalc automatically.
        </div>
      </div>

      <Divider />

      {hands.length === 0 ? (
        <div style={{ color: UI.muted, fontWeight: 900 }}>No hands yet. Add the first hand above.</div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {hands
            .slice()
            .sort((a, b) => a.createdAt - b.createdAt)
            .map((h, idx) => (
              <HandRow
                key={h.id}
                idx={idx}
                h={h}
                onUpdate={(patch) => onUpdate(h.id, patch)}
                onDelete={() => onDelete(h.id)}
              />
            ))}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <div style={{ color: UI.muted, fontWeight: 900, fontSize: 12, marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  );
}

function HandRow({ idx, h, onUpdate, onDelete }) {
  return (
    <div style={{ border: `1px solid ${UI.border}`, borderRadius: 16, padding: 12, background: "rgba(0,0,0,0.14)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
        <div style={{ fontWeight: 1100 }}>
          Hand #{idx + 1}{" "}
          <span style={{ color: UI.muted, fontWeight: 900 }}>
            • Bidder {h.bidder} • Bid {h.bid} • {h.coincheLevel}
            {h.capot ? " • Capot" : ""}
          </span>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Chip>A +{Number(h.scoreA) || 0}</Chip>
          <Chip>B +{Number(h.scoreB) || 0}</Chip>
          <Btn kind="danger" small onClick={onDelete}>Delete</Btn>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginTop: 10 }}>
        <Field label="Bidder">
          <Select
            value={h.bidder}
            onChange={(v) => onUpdate({ bidder: v })}
            options={[
              { value: "A", label: "A" },
              { value: "B", label: "B" },
            ]}
            width={160}
          />
        </Field>

        <Field label="Bid">
          <TextInput value={String(h.bid)} onChange={(v) => onUpdate({ bid: Number(v || 0) })} width={130} />
        </Field>

        <Field label="Coinche">
          <Select
            value={h.coincheLevel}
            onChange={(v) => onUpdate({ coincheLevel: v })}
            options={[
              { value: "NONE", label: "None" },
              { value: "COINCHE", label: "Coinche (x2)" },
              { value: "SURCOINCHE", label: "Surcoinche (x4)" },
            ]}
            width={180}
          />
        </Field>

        <Field label="Capot">
          <Select
            value={h.capot ? "YES" : "NO"}
            onChange={(v) => onUpdate({ capot: v === "YES" })}
            options={[
              { value: "NO", label: "No" },
              { value: "YES", label: "Yes" },
            ]}
            width={130}
          />
        </Field>

        <Field label="Bidder trick pts">
          <TextInput
            value={String(h.bidderTrickPoints)}
            onChange={(v) => onUpdate({ bidderTrickPoints: Number(v || 0) })}
            width={150}
          />
        </Field>

        <Field label="Announce A">
          <TextInput value={String(h.announceA)} onChange={(v) => onUpdate({ announceA: Number(v || 0) })} width={150} />
        </Field>

        <Field label="Announce B">
          <TextInput value={String(h.announceB)} onChange={(v) => onUpdate({ announceB: Number(v || 0) })} width={150} />
        </Field>

        <Field label="Belote">
          <Select
            value={h.beloteTeam}
            onChange={(v) => onUpdate({ beloteTeam: v })}
            options={[
              { value: "NONE", label: "None" },
              { value: "A", label: "Team A" },
              { value: "B", label: "Team B" },
            ]}
            width={160}
          />
        </Field>
      </div>
    </div>
  );
}

function PublicView({ overallScoreboard, standingsA, standingsB, bracketByRound, teamById, winnerBoard, stats, schedule }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 14 }}>
      <Card
        title="Public Scoreboard (TV Mode)"
        right={
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <Chip tone="good">LIVE</Chip>
            <Chip>8 teams</Chip>
            <Chip>{GAME_MINUTES}m game + {BREAK_MINUTES}m break</Chip>
          </div>
        }
      >
        <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 12 }}>
          <div>
            <div style={{ fontWeight: 1100, marginBottom: 10 }}>Overall</div>
            <div style={{ display: "grid", gap: 10 }}>
              {overallScoreboard.map((s, idx) => (
                <div
                  key={s.teamId}
                  style={{
                    border: `1px solid ${UI.border}`,
                    borderRadius: 16,
                    padding: 12,
                    background: idx === 0 ? "rgba(34,197,94,0.10)" : UI.panel2,
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 10,
                    alignItems: "center",
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 1200, fontSize: 18, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      #{idx + 1} {s.name}
                    </div>
                    <div style={{ color: UI.muted, fontWeight: 900 }}>
                      MP {s.matchPoints} • Total {s.totalGamePoints} • W-L {s.wins}-{s.losses}
                    </div>
                  </div>
                  <Chip tone="warn">MP {s.matchPoints}</Chip>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div style={{ fontWeight: 1100, marginBottom: 10 }}>Winner Board</div>
            <div style={{ display: "grid", gap: 10 }}>
              <Podium label="Champion" value={winnerBoard.champion} tone="good" />
              <Podium label="Runner-up" value={winnerBoard.runnerUp} tone="warn" />
              <Podium label="3rd Place" value={winnerBoard.third} tone="neutral" />
            </div>

            <Divider />

            <div style={{ fontWeight: 1100, marginBottom: 10 }}>Quick Stats</div>
            <div style={{ display: "grid", gap: 10 }}>
              <StatMini label="Hands played" value={stats.totalHands} />
              <StatMini label="Total table points" value={stats.totalTablePoints} />
              <StatMini label="Biggest hand" value={stats.biggestHand ? `${stats.biggestHand.sum}` : "—"} sub={stats.biggestHand ? `A ${stats.biggestHand.ha} / B ${stats.biggestHand.hb}` : ""} />
              <StatMini label="Biggest swing" value={stats.biggestSwing ? `${stats.biggestSwing.swing}` : "—"} sub={stats.biggestSwing ? `A ${stats.biggestSwing.ha} / B ${stats.biggestSwing.hb}` : ""} />
            </div>
          </div>
        </div>
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <Card title="Pool A Standings">{standingsA.length ? standingsA.map((s, i) => <PublicStandRow key={s.teamId} s={s} i={i} />) : <div style={{ color: UI.muted, fontWeight: 900 }}>Not started yet.</div>}</Card>
        <Card title="Pool B Standings">{standingsB.length ? standingsB.map((s, i) => <PublicStandRow key={s.teamId} s={s} i={i} />) : <div style={{ color: UI.muted, fontWeight: 900 }}>Not started yet.</div>}</Card>
      </div>

      <Card title="Bracket">
        <BracketVisual bracketByRound={bracketByRound} teamById={teamById} onScore={() => {}} onClear={() => {}} />
        <div style={{ marginTop: 10, color: UI.muted, fontWeight: 900, fontSize: 12 }}>
          (Public view is read-only)
        </div>
      </Card>

      <Card title="Schedule (planned)">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 10 }}>
          {schedule.map((s) => (
            <div key={s.key} style={{ border: `1px solid ${UI.border}`, borderRadius: 16, padding: 12, background: UI.panel2 }}>
              <div style={{ fontWeight: 1100 }}>{s.label}</div>
              <div style={{ color: UI.muted, fontWeight: 900 }}>Tables: {s.tables} • Slot #{s.slotIndex + 1}</div>
              <div style={{ color: UI.muted, fontWeight: 900, marginTop: 6 }}>
                {GAME_MINUTES} min play + {BREAK_MINUTES} min break
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function PublicStandRow({ s, i }) {
  return (
    <div style={{ border: `1px solid ${UI.border}`, borderRadius: 16, padding: 12, background: i === 0 ? "rgba(96,165,250,0.12)" : UI.panel2, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 10 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 1100, fontSize: 16, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          #{i + 1} {s.name}
        </div>
        <div style={{ color: UI.muted, fontWeight: 900, fontSize: 12 }}>Tiebreak: {s.totalGamePoints}</div>
      </div>
      <Chip tone="warn">MP {s.matchPoints}</Chip>
    </div>
  );
}

function TableView({
  tableLink,
  games,
  teamById,
  selectedPool,
  selectedRound,
  selectedTable,
  tableMatch,
  onPick,
  onSetTarget,
  onAddHand,
  onUpdateHand,
  onDeleteHand,
  onClearGame,
}) {
  const rounds = [1, 2, 3]; // pool rounds for 4 teams
  const pools = ["A", "B"];
  const tables = [1, 2, 3, 4];

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 14 }}>
      <Card
        title="Table View (enter your hands only)"
        right={
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <Btn kind="ghost" onClick={() => navigator.clipboard?.writeText(tableLink)}>Copy Table Link</Btn>
          </div>
        }
      >
        <div style={{ color: UI.muted, fontWeight: 900 }}>
          Pick your match (pool + round + table). Then enter hands. Totals & winner update instantly.
        </div>

        <Divider />

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <Field label="Pool">
            <Select
              value={selectedPool}
              onChange={(v) => onPick(v, selectedRound, selectedTable)}
              options={pools.map((p) => ({ value: p, label: `Pool ${p}` }))}
              width={140}
            />
          </Field>

          <Field label="Round">
            <Select
              value={String(selectedRound)}
              onChange={(v) => onPick(selectedPool, Number(v), selectedTable)}
              options={rounds.map((r) => ({ value: String(r), label: `Round ${r}` }))}
              width={140}
            />
          </Field>

          <Field label="Table">
            <Select
              value={String(selectedTable)}
              onChange={(v) => onPick(selectedPool, selectedRound, Number(v))}
              options={tables.map((t) => ({ value: String(t), label: `Table ${t}` }))}
              width={140}
            />
          </Field>
        </div>
      </Card>

      {!tableMatch ? (
        <Card title="No match found">
          <div style={{ color: UI.muted, fontWeight: 900 }}>
            Create Pools + Round Robin in Admin first.
          </div>
        </Card>
      ) : (
        <Card
          title={`Pool ${tableMatch.pool} • Round ${tableMatch.round} • Table ${tableMatch.table}`}
          right={
            <Chip tone={tableMatch.winnerId ? "good" : "warn"}>
              {tableMatch.winnerId ? `Winner: ${teamById.get(tableMatch.winnerId)?.name ?? "—"}` : "In progress"}
            </Chip>
          }
        >
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <Chip>
              {teamById.get(tableMatch.teamAId)?.name ?? "—"} vs {teamById.get(tableMatch.teamBId)?.name ?? "—"}
            </Chip>
            <Chip tone="warn">MP A +{tableMatch.matchPtsA} / B +{tableMatch.matchPtsB}</Chip>
            <Btn kind="danger" small onClick={() => onClearGame(tableMatch.id)}>Clear match</Btn>
          </div>

          <Divider />

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <Field label="Target">
              <TextInput value={String(tableMatch.tableTarget || DEFAULT_TARGET)} onChange={(v) => onSetTarget(tableMatch.id, v)} width={140} />
            </Field>
            <Chip tone={(Number(tableMatch.scoreA) || 0) >= (Number(tableMatch.tableTarget) || DEFAULT_TARGET) ? "good" : "neutral"}>
              A total: {Number(tableMatch.scoreA) || 0}
            </Chip>
            <Chip tone={(Number(tableMatch.scoreB) || 0) >= (Number(tableMatch.tableTarget) || DEFAULT_TARGET) ? "good" : "neutral"}>
              B total: {Number(tableMatch.scoreB) || 0}
            </Chip>
          </div>

          <Divider />

          <HandsEditor
            target={Number(tableMatch.tableTarget) || DEFAULT_TARGET}
            totalA={Number(tableMatch.scoreA) || 0}
            totalB={Number(tableMatch.scoreB) || 0}
            hands={tableMatch.hands || []}
            onAdd={(hand) => onAddHand(tableMatch.id, hand)}
            onUpdate={(handId, patch) => onUpdateHand(tableMatch.id, handId, patch)}
            onDelete={(handId) => onDeleteHand(tableMatch.id, handId)}
          />
        </Card>
      )}

      <Card title="Reminder">
        <div style={{ color: UI.muted, fontWeight: 900 }}>
          Without Supabase, each phone/table has its own data. When you’re ready, we’ll add Supabase so all tables update the same live scoreboard.
        </div>
      </Card>
    </div>
  );
}