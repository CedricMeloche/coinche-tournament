import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * 9th Annual Coinche Tournament — Vite Single-File App.jsx
 * - 8 teams fixed (2 pools of 4) + bracket (QF/SF/Final + 3rd)
 * - Admin view: manual team picker OR randomize (lock teams supported)
 * - Table view: each table enters ONLY their match
 * - Public view: read-only scoreboard + bracket + timer (projector/TV)
 * - Fast mode hand tracker: add hands, auto-calc, clears fields after add, ends at 2000 immediately
 * - Live scoreboard + stats + funny stats
 * - Export CSV (Excel-friendly) for full tournament data
 *
 * Routing via hash:
 *  - #/admin
 *  - #/public
 *  - #/table?num=1   (1..4)
 */

const LS_KEY = "coinche_tournament_vite_full_v1";

// Tournament timing
const START_TIME = "10:00"; // shown as label
const GAME_MIN = 40;
const BREAK_MIN = 5;
const TARGET_SCORE = 2000;

// Match points (like your earlier logic)
const DEFAULT_WIN_THRESHOLD = 2000;
const DEFAULT_WIN_HIGH_PTS = 2; // win >= threshold
const DEFAULT_WIN_LOW_PTS = 1; // win < threshold

const SUITS = [
  { value: "H", label: "Hearts", icon: "♥" },
  { value: "D", label: "Diamonds", icon: "♦" },
  { value: "C", label: "Clubs", icon: "♣" },
  { value: "S", label: "Spades", icon: "♠" },
];
const COINCHE_LEVELS = [
  { value: "NONE", label: "None" },
  { value: "COINCHE", label: "Coinche (x2)" },
  { value: "SURCOINCHE", label: "Surcoinche (x4)" },
];

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
function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
function pad2(n) {
  return String(n).padStart(2, "0");
}
function parseHash() {
  const raw = window.location.hash || "#/admin";
  const [pathPart, queryPart] = raw.replace(/^#/, "").split("?");
  const path = pathPart || "/admin";
  const q = new URLSearchParams(queryPart || "");
  const tableNum = Number(q.get("num") || "");
  return { path, tableNum: Number.isFinite(tableNum) ? tableNum : null };
}
function formatClock(d) {
  const hh = pad2(d.getHours());
  const mm = pad2(d.getMinutes());
  return `${hh}:${mm}`;
}

/** Circle method RR scheduler (even n) */
function circleRoundRobin(teamIds) {
  const ids = [...teamIds];
  const hasOdd = ids.length % 2 === 1;
  if (hasOdd) ids.push("BYE");

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

/** ===== Fast mode Coinche scoring =====
 * This matches your "fast mode" principles you shared earlier:
 * - Trick points rounded to nearest 10 (with +4 trick trick)
 * - Minimum needed base 81; if bidder has belote, 71; if bid=80 must be 81
 * - Announces reduce requirement (fast approximation)
 * - Capot: winner gets 250 + all announces + belote + bid
 * - Coinche/Surcoinche: winner gets 160 + mult*bid + all announces; loser 0; belote stays with declaring team
 * - Normal:
 *    - Success: bidder gets rounded tricks + their announces + belote + bid; opp gets rounded tricks + their announces + belote
 *    - Fail: opp gets 160 + bid + announces; bidder gets 0 but keeps belote if they had it
 */
function roundTrickPoints(x) {
  if (x == null) return 0;
  const n = clamp(Number(x) || 0, 0, 162);
  return Math.floor((n + 4) / 10) * 10;
}

function computeFastCoincheScore({
  bidder, // "A"|"B"
  bid, // number
  suit, // "H"|"D"|"C"|"S"
  coincheLevel, // "NONE"|"COINCHE"|"SURCOINCHE"
  capot, // boolean
  bidderTrickPoints, // 0..162 raw
  announceA, // non-belote announces A
  announceB, // non-belote announces B
  beloteTeam, // "NONE"|"A"|"B"
}) {
  const BIDDER_IS_A = bidder === "A";
  const bidVal = Math.max(0, Number(bid) || 0);

  const belotePts = beloteTeam === "NONE" ? 0 : 20;
  const beloteA = beloteTeam === "A" ? 20 : 0;
  const beloteB = beloteTeam === "B" ? 20 : 0;

  const rawBidder = clamp(Number(bidderTrickPoints) || 0, 0, 162);
  const rawOpp = 162 - rawBidder;

  const tricksBidder = roundTrickPoints(rawBidder);
  const tricksOpp = roundTrickPoints(rawOpp);

  const aAnn = Math.max(0, Number(announceA) || 0);
  const bAnn = Math.max(0, Number(announceB) || 0);

  const bidderAnn = BIDDER_IS_A ? aAnn : bAnn;

  const bidderHasBelote =
    (BIDDER_IS_A && beloteTeam === "A") || (!BIDDER_IS_A && beloteTeam === "B");
  const baseMin = bidderHasBelote ? 71 : 81;
  const special80 = bidVal === 80 ? 81 : 0;

  const announceHelp = bidderAnn + (bidderHasBelote ? 20 : 0);
  const required = Math.max(baseMin, special80, bidVal - announceHelp);

  const bidderSucceeded = capot ? true : rawBidder >= required;

  const mult = coincheLevel === "SURCOINCHE" ? 4 : coincheLevel === "COINCHE" ? 2 : 1;
  const isCoinche = coincheLevel !== "NONE";

  let scoreA = 0;
  let scoreB = 0;

  if (capot) {
    const winnerGets = 250 + aAnn + bAnn + belotePts + bidVal;
    if (BIDDER_IS_A) {
      scoreA = winnerGets;
      scoreB = 0;
    } else {
      scoreB = winnerGets;
      scoreA = 0;
    }
    return { scoreA, scoreB, bidderSucceeded: true, suit };
  }

  if (isCoinche) {
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
    return { scoreA, scoreB, bidderSucceeded, suit };
  }

  if (bidderSucceeded) {
    if (BIDDER_IS_A) {
      scoreA = tricksBidder + aAnn + beloteA + bidVal;
      scoreB = tricksOpp + bAnn + beloteB;
    } else {
      scoreB = tricksBidder + bAnn + beloteB + bidVal;
      scoreA = tricksOpp + aAnn + beloteA;
    }
  } else {
    const oppGets = 160 + bidVal + (aAnn + bAnn);
    if (BIDDER_IS_A) {
      scoreA = beloteA;
      scoreB = oppGets + beloteB;
    } else {
      scoreB = beloteB;
      scoreA = oppGets + beloteA;
    }
  }

  return { scoreA, scoreB, bidderSucceeded, suit };
}

/** ====== CSV export helpers ====== */
function csvEscape(s) {
  const str = String(s ?? "");
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** ===== Timer logic (start/pause) ===== */
function computeTimerInfo({
  startTs,
  paused,
  pausedAccumMs,
  pausedAtTs,
  nowTs,
}) {
  // If never started
  if (!startTs) {
    return {
      currentLabel: "Not started",
      currentTime: "—",
      inBreak: false,
      remainingInGame: GAME_MIN,
      remainingInBlock: GAME_MIN,
      elapsedMin: 0,
    };
  }

  const effectiveNow = nowTs;
  let elapsedMs = effectiveNow - startTs - pausedAccumMs;
  if (paused && pausedAtTs) {
    // freeze at pause moment
    elapsedMs = pausedAtTs - startTs - pausedAccumMs;
  }
  elapsedMs = Math.max(0, elapsedMs);

  const elapsedMin = Math.floor(elapsedMs / 60000);

  const blockLen = GAME_MIN + BREAK_MIN;
  const blockIndex = Math.floor(elapsedMin / blockLen); // 0-based block
  const inBlockMin = elapsedMin % blockLen;

  const inBreak = inBlockMin >= GAME_MIN;
  const remainingInGame = inBreak ? 0 : Math.max(0, GAME_MIN - inBlockMin);
  const remainingInBreak = inBreak ? Math.max(0, blockLen - inBlockMin) : BREAK_MIN;

  const currentLabel = inBreak
    ? `Break (after Round ${blockIndex + 1})`
    : `Round ${blockIndex + 1}`;

  const remainingInBlock = inBreak ? remainingInBreak : remainingInGame;

  const currentTime = formatClock(new Date(effectiveNow));

  return {
    currentLabel,
    currentTime,
    inBreak,
    remainingInGame,
    remainingInBlock,
    elapsedMin,
  };
}

/** ===== Default data builders ===== */
function defaultFastDraft() {
  return {
    bidder: "A",
    bid: "",
    suit: "S",
    coincheLevel: "NONE",
    capot: false,
    bidderTrickPoints: "",
    announceA: "",
    announceB: "",
    beloteTeam: "NONE",
  };
}

function makeEmptyMatch({ id, stage, label, pool, round, table, teamAId, teamBId }) {
  return {
    id,
    stage, // "POOL" | "BRACKET"
    label,
    pool: pool ?? null, // "A" | "B" | null
    round: round ?? null,
    table: table ?? null,
    teamAId,
    teamBId,
    hands: [], // each: {idx, draftSnapshot, scoreA, scoreB, createdAt}
    totalA: 0,
    totalB: 0,
    winnerId: null,
    completed: false,
    matchPtsA: 0,
    matchPtsB: 0,
    fastDraft: defaultFastDraft(),
  };
}

/** ===== Main App ===== */
export default function App() {
  const [route, setRoute] = useState(parseHash());

  // Basic tournament state
  const [loaded, setLoaded] = useState(false);
  const [tournamentName, setTournamentName] = useState("9th Annual Coinche Tournament");

  const [players, setPlayers] = useState([]); // {id,name}
  const [teams, setTeams] = useState([]); // {id, name, playerIds:[p1,p2], locked:boolean}

  // Pools + schedule
  const [poolMap, setPoolMap] = useState({ A: [], B: [] }); // arrays of teamIds (length 4 each)
  const [matches, setMatches] = useState([]); // all matches: pool RR + bracket
  const [bracket, setBracket] = useState([]); // bracket nodes

  // Scoring settings
  const [winThreshold, setWinThreshold] = useState(DEFAULT_WIN_THRESHOLD);
  const [winHighPts, setWinHighPts] = useState(DEFAULT_WIN_HIGH_PTS);
  const [winLowPts, setWinLowPts] = useState(DEFAULT_WIN_LOW_PTS);

  // Timer state (shared)
  const [timerStartTs, setTimerStartTs] = useState(null); // ms
  const [timerPaused, setTimerPaused] = useState(true);
  const [timerPausedAtTs, setTimerPausedAtTs] = useState(null); // ms
  const [timerPausedAccumMs, setTimerPausedAccumMs] = useState(0);

  const [nowTick, setNowTick] = useState(Date.now());

  // UI state
  const [newPlayerName, setNewPlayerName] = useState("");
  const inputRef = useRef(null);

  // Listen for hash changes
  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Timer tick
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Load persisted
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        setTournamentName(data.tournamentName ?? "9th Annual Coinche Tournament");
        setPlayers(data.players ?? []);
        setTeams(data.teams ?? []);
        setPoolMap(data.poolMap ?? { A: [], B: [] });
        setMatches(data.matches ?? []);
        setBracket(data.bracket ?? []);
        setWinThreshold(data.winThreshold ?? DEFAULT_WIN_THRESHOLD);
        setWinHighPts(data.winHighPts ?? DEFAULT_WIN_HIGH_PTS);
        setWinLowPts(data.winLowPts ?? DEFAULT_WIN_LOW_PTS);

        setTimerStartTs(data.timerStartTs ?? null);
        setTimerPaused(data.timerPaused ?? true);
        setTimerPausedAtTs(data.timerPausedAtTs ?? null);
        setTimerPausedAccumMs(data.timerPausedAccumMs ?? 0);
      }
    } catch {
      // ignore
    } finally {
      setLoaded(true);
    }
  }, []);

  // Persist
  useEffect(() => {
    if (!loaded) return;
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        tournamentName,
        players,
        teams,
        poolMap,
        matches,
        bracket,
        winThreshold,
        winHighPts,
        winLowPts,
        timerStartTs,
        timerPaused,
        timerPausedAtTs,
        timerPausedAccumMs,
      })
    );
  }, [
    loaded,
    tournamentName,
    players,
    teams,
    poolMap,
    matches,
    bracket,
    winThreshold,
    winHighPts,
    winLowPts,
    timerStartTs,
    timerPaused,
    timerPausedAtTs,
    timerPausedAccumMs,
  ]);

  const playerById = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);
  const teamById = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams]);

  const timerInfo = useMemo(
    () =>
      computeTimerInfo({
        startTs: timerStartTs,
        paused: timerPaused,
        pausedAccumMs: timerPausedAccumMs,
        pausedAtTs: timerPausedAtTs,
        nowTs: nowTick,
      }),
    [timerStartTs, timerPaused, timerPausedAccumMs, timerPausedAtTs, nowTick]
  );

  // Determine if admin has correct counts
  const teamCountOk = teams.length === 8;
  const playersCountOk = players.length >= 16; // recommended (but manual teams allows extras)
  const poolsReady = poolMap.A.length === 4 && poolMap.B.length === 4;

  /** ===== Navigation links ===== */
  const publicLink = "#/public";
  const adminLink = "#/admin";
  const tableLink = (n) => `#/table?num=${n}`;

  /** ===== Core actions ===== */
  function fullReset() {
    setTournamentName("9th Annual Coinche Tournament");
    setPlayers([]);
    setTeams([]);
    setPoolMap({ A: [], B: [] });
    setMatches([]);
    setBracket([]);
    setWinThreshold(DEFAULT_WIN_THRESHOLD);
    setWinHighPts(DEFAULT_WIN_HIGH_PTS);
    setWinLowPts(DEFAULT_WIN_LOW_PTS);

    // timer reset
    setTimerStartTs(null);
    setTimerPaused(true);
    setTimerPausedAtTs(null);
    setTimerPausedAccumMs(0);
  }

  function resetTournamentOnly() {
    setPoolMap({ A: [], B: [] });
    setMatches([]);
    setBracket([]);
    // keep players/teams
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
    // Teams likely invalid now
    setTeams([]);
    resetTournamentOnly();
  }

  /** ===== Teams builder ===== */
  function ensure8TeamsSkeleton() {
    // keep existing team ids/names/locks if possible, but ensure 8 entries
    setTeams((prev) => {
      const out = [...prev].slice(0, 8).map((t, idx) => ({
        ...t,
        name: t.name || `Team ${idx + 1}`,
        locked: Boolean(t.locked),
        playerIds: Array.isArray(t.playerIds) ? t.playerIds.slice(0, 2) : [null, null],
      }));

      while (out.length < 8) {
        out.push({
          id: uid("t"),
          name: `Team ${out.length + 1}`,
          locked: false,
          playerIds: [null, null],
        });
      }
      return out;
    });
  }

  useEffect(() => {
    // on first load, make sure teams skeleton exists for the 8-team tournament (if empty)
    if (!loaded) return;
    if (teams.length === 0) ensure8TeamsSkeleton();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  function setTeamName(teamId, name) {
    setTeams((prev) => prev.map((t) => (t.id === teamId ? { ...t, name } : t)));
  }
  function setTeamPlayer(teamId, slotIdx, playerIdOrNull) {
    setTeams((prev) =>
      prev.map((t) => {
        if (t.id !== teamId) return t;
        const next = [...t.playerIds];
        next[slotIdx] = playerIdOrNull || null;
        return { ...t, playerIds: next };
      })
    );
  }
  function toggleTeamLock(teamId) {
    setTeams((prev) => prev.map((t) => (t.id === teamId ? { ...t, locked: !t.locked } : t)));
  }

  function randomizeUnlockedTeams() {
    // Build list of available players not used in locked teams (unless duplicated)
    const locked = teams.filter((t) => t.locked);
    const unlocked = teams.filter((t) => !t.locked);

    // Collect used player ids in locked teams
    const used = new Set();
    locked.forEach((t) => (t.playerIds || []).forEach((pid) => pid && used.add(pid)));

    const available = players.map((p) => p.id).filter((id) => !used.has(id));
    const shuffled = shuffleArray(available);

    // Fill unlocked teams with pairs from shuffled
    const updates = new Map();
    let i = 0;
    unlocked.forEach((t) => {
      const a = shuffled[i++] || null;
      const b = shuffled[i++] || null;
      updates.set(t.id, [a, b]);
    });

    setTeams((prev) =>
      prev.map((t) => {
        if (!updates.has(t.id)) return t;
        return { ...t, playerIds: updates.get(t.id) };
      })
    );

    resetTournamentOnly();
  }

  const teamValidation = useMemo(() => {
    const issues = [];
    if (teams.length !== 8) issues.push("You must have exactly 8 teams.");
    teams.forEach((t, idx) => {
      const [a, b] = t.playerIds || [];
      if (!a || !b) issues.push(`Team ${idx + 1} (${t.name}) needs 2 players.`);
      if (a && b && a === b) issues.push(`Team ${idx + 1} (${t.name}) has the same player twice.`);
    });

    // detect duplicates across teams
    const seen = new Map();
    teams.forEach((t) => {
      (t.playerIds || []).forEach((pid) => {
        if (!pid) return;
        if (!seen.has(pid)) seen.set(pid, []);
        seen.get(pid).push(t.name);
      });
    });
    for (const [pid, usedIn] of seen.entries()) {
      if (usedIn.length > 1) {
        const nm = playerById.get(pid)?.name || "Player";
        issues.push(`${nm} is used in multiple teams: ${usedIn.join(", ")}`);
      }
    }

    return { ok: issues.length === 0, issues };
  }, [teams, playerById]);

  /** ===== Pools + Schedule ===== */
  function createPoolsAndRoundRobin() {
    if (!teamValidation.ok) return;

    // Split into pools of 4: first 4 => A, last 4 => B (admin can reorder teams)
    const ids = teams.map((t) => t.id);
    const A = ids.slice(0, 4);
    const B = ids.slice(4, 8);
    setPoolMap({ A, B });

    // Pool RR games: each pool has 4 teams => 3 rounds, 2 matches per round
    // Tables: Pool A uses tables 1-2; Pool B uses tables 3-4
    const built = [];

    const makePoolMatches = (poolName, teamIds, tableOffset) => {
      const rounds = circleRoundRobin(teamIds); // 3 rounds
      rounds.forEach((pairings, rIdx) => {
        pairings.forEach(([a, b], pIdx) => {
          const table = tableOffset + (pIdx + 1);
          built.push(
            makeEmptyMatch({
              id: uid(`m_pool_${poolName}`),
              stage: "POOL",
              label: `Pool ${poolName} — R${rIdx + 1}`,
              pool: poolName,
              round: rIdx + 1,
              table,
              teamAId: a,
              teamBId: b,
            })
          );
        });
      });
    };

    makePoolMatches("A", A, 0);
    makePoolMatches("B", B, 2);

    setMatches(built);
    setBracket([]);
  }

  /** ===== Match recompute (totals / winner / match points) ===== */
  function recomputeMatch(m) {
    const totalA = m.hands.reduce((s, h) => s + (Number(h.scoreA) || 0), 0);
    const totalB = m.hands.reduce((s, h) => s + (Number(h.scoreB) || 0), 0);

    let completed = m.completed;
    let winnerId = m.winnerId;

    // End immediately when someone reaches 2000 (strict)
    if (!completed) {
      if (totalA >= TARGET_SCORE || totalB >= TARGET_SCORE) {
        completed = true;
        if (totalA === totalB) {
          // should not happen, but keep winner null until admin resolves
          winnerId = null;
        } else {
          winnerId = totalA > totalB ? m.teamAId : m.teamBId;
        }
      }
    }

    // match points only when completed (or if manual totals used — but we use hands only)
    const winnerScore = winnerId ? Math.max(totalA, totalB) : null;
    const mp = winnerId ? computeMatchPoints(winnerScore, winThreshold, winHighPts, winLowPts) : 0;

    const matchPtsA = winnerId === m.teamAId ? mp : 0;
    const matchPtsB = winnerId === m.teamBId ? mp : 0;

    return { ...m, totalA, totalB, completed, winnerId, matchPtsA, matchPtsB };
  }

  function patchMatch(matchId, patch) {
    setMatches((prev) => prev.map((m) => (m.id === matchId ? recomputeMatch({ ...m, ...patch }) : m)));
  }

  /** ===== Hand add / reset draft blank after add ===== */
  function addHand(matchId) {
    setMatches((prev) =>
      prev.map((m) => {
        if (m.id !== matchId) return m;
        if (m.completed) return m;

        const d = m.fastDraft || defaultFastDraft();

        // Basic required fields (bidder, bid, trick points) — allow bid 0 if needed
        const bidVal = safeInt(d.bid);
        const trickVal = safeInt(d.bidderTrickPoints);

        if (bidVal === null || trickVal === null) return m;

        const res = computeFastCoincheScore({
          bidder: d.bidder,
          bid: bidVal,
          suit: d.suit || "S",
          coincheLevel: d.coincheLevel || "NONE",
          capot: Boolean(d.capot),
          bidderTrickPoints: trickVal,
          announceA: safeInt(d.announceA) ?? 0,
          announceB: safeInt(d.announceB) ?? 0,
          beloteTeam: d.beloteTeam || "NONE",
        });

        const hand = {
          idx: m.hands.length + 1,
          createdAt: Date.now(),
          draftSnapshot: { ...d, bid: bidVal, bidderTrickPoints: trickVal },
          scoreA: res.scoreA,
          scoreB: res.scoreB,
          bidderSucceeded: res.bidderSucceeded,
        };

        const next = {
          ...m,
          hands: [...m.hands, hand],
          // IMPORTANT: reset new hand fields blank
          fastDraft: defaultFastDraft(),
        };

        return recomputeMatch(next);
      })
    );
  }

  function clearHands(matchId) {
    patchMatch(matchId, { hands: [], totalA: 0, totalB: 0, completed: false, winnerId: null });
  }

  function updateDraft(matchId, patch) {
    setMatches((prev) =>
      prev.map((m) => {
        if (m.id !== matchId) return m;
        return { ...m, fastDraft: { ...(m.fastDraft || defaultFastDraft()), ...patch } };
      })
    );
  }

  /** ===== Standings per pool ===== */
  function poolStandings(poolName) {
    const ids = poolMap[poolName] || [];
    const rows = ids
      .map((id) => {
        const t = teamById.get(id);
        return t
          ? { teamId: t.id, name: t.name, matchPoints: 0, totalGamePoints: 0, gamesPlayed: 0, wins: 0, losses: 0 }
          : null;
      })
      .filter(Boolean);

    const byId = new Map(rows.map((r) => [r.teamId, r]));
    matches
      .filter((m) => m.stage === "POOL" && m.pool === poolName)
      .forEach((m) => {
        const a = byId.get(m.teamAId);
        const b = byId.get(m.teamBId);
        if (!a || !b) return;

        a.totalGamePoints += m.totalA || 0;
        b.totalGamePoints += m.totalB || 0;
        a.gamesPlayed += 1;
        b.gamesPlayed += 1;

        a.matchPoints += m.matchPtsA || 0;
        b.matchPoints += m.matchPtsB || 0;

        if (m.completed && m.winnerId) {
          if (m.winnerId === m.teamAId) {
            a.wins += 1;
            b.losses += 1;
          } else if (m.winnerId === m.teamBId) {
            b.wins += 1;
            a.losses += 1;
          }
        }
      });

    return sortStandings(rows);
  }

  const standingsA = useMemo(() => (poolsReady ? poolStandings("A") : []), [poolsReady, matches, poolMap, teamById]);
  const standingsB = useMemo(() => (poolsReady ? poolStandings("B") : []), [poolsReady, matches, poolMap, teamById]);

  /** ===== Bracket build + propagation ===== */
  function propagateBracketWinners(nodes) {
    const byId = new Map(nodes.map((n) => [n.id, { ...n }]));
    for (const n of nodes) {
      if (!n.winnerId || !n.nextMatchId) continue;
      const next = byId.get(n.nextMatchId);
      if (!next) continue;
      const slotKey = n.nextSlot === "A" ? "teamAId" : "teamBId";
      if (next[slotKey] !== n.winnerId) {
        next[slotKey] = n.winnerId;
        next.winnerId = null;
        byId.set(next.id, next);
      }
    }
    return Array.from(byId.values());
  }

  function fillThirdPlace(nodes) {
    const sf = nodes.filter((x) => x.round === "SF");
    const third = nodes.find((x) => x.round === "3P");
    if (!third || sf.length !== 2) return nodes;
    if (!sf[0].teamAId || !sf[0].teamBId || !sf[0].winnerId) return nodes;
    if (!sf[1].teamAId || !sf[1].teamBId || !sf[1].winnerId) return nodes;

    const loser1 = sf[0].winnerId === sf[0].teamAId ? sf[0].teamBId : sf[0].teamAId;
    const loser2 = sf[1].winnerId === sf[1].teamAId ? sf[1].teamBId : sf[1].teamAId;

    if (third.teamAId === loser1 && third.teamBId === loser2) return nodes;

    return nodes.map((n) =>
      n.id === third.id ? { ...n, teamAId: loser1, teamBId: loser2, winnerId: null } : n
    );
  }

  function createBracketFromPools() {
    if (standingsA.length < 4 || standingsB.length < 4) return;

    const a = standingsA.slice(0, 4).map((x) => x.teamId);
    const b = standingsB.slice(0, 4).map((x) => x.teamId);

    const qf = [
      { label: "QF1", A: a[0], B: b[3] },
      { label: "QF2", A: a[1], B: b[2] },
      { label: "QF3", A: b[0], B: a[3] },
      { label: "QF4", A: b[1], B: a[2] },
    ];

    const sfIds = [uid("br_sf"), uid("br_sf")];
    const fId = uid("br_f");
    const thirdId = uid("br_3p");

    const nodes = [];

    qf.forEach((m, idx) => {
      const nextMatchId = idx < 2 ? sfIds[0] : sfIds[1];
      const nextSlot = idx % 2 === 0 ? "A" : "B";
      nodes.push({
        id: uid("br_qf"),
        round: "QF",
        idx,
        label: m.label,
        teamAId: m.A,
        teamBId: m.B,
        winnerId: null,
        nextMatchId,
        nextSlot,
      });
    });

    nodes.push({
      id: sfIds[0],
      round: "SF",
      idx: 0,
      label: "SF1",
      teamAId: null,
      teamBId: null,
      winnerId: null,
      nextMatchId: fId,
      nextSlot: "A",
    });
    nodes.push({
      id: sfIds[1],
      round: "SF",
      idx: 1,
      label: "SF2",
      teamAId: null,
      teamBId: null,
      winnerId: null,
      nextMatchId: fId,
      nextSlot: "B",
    });

    nodes.push({
      id: fId,
      round: "F",
      idx: 0,
      label: "Final",
      teamAId: null,
      teamBId: null,
      winnerId: null,
      nextMatchId: null,
      nextSlot: null,
    });

    nodes.push({
      id: thirdId,
      round: "3P",
      idx: 0,
      label: "3rd Place",
      teamAId: null,
      teamBId: null,
      winnerId: null,
      nextMatchId: null,
      nextSlot: null,
    });

    const seeded = fillThirdPlace(propagateBracketWinners(nodes));
    setBracket(seeded);

    // Also create bracket matches as "matches" so they get hand tracking too
    // We'll create these in matches list if not already there
    setMatches((prev) => {
      const existingBracketIds = new Set(prev.filter((m) => m.stage === "BRACKET").map((m) => m.id));

      // map bracket node -> match id
      const built = [];
      seeded.forEach((n) => {
        const matchId = `match_${n.id}`;
        if (existingBracketIds.has(matchId)) return;

        built.push(
          makeEmptyMatch({
            id: matchId,
            stage: "BRACKET",
            label: n.label,
            pool: null,
            round: null,
            table: null, // bracket tables not fixed
            teamAId: n.teamAId,
            teamBId: n.teamBId,
          })
        );
      });

      return [...prev.filter((m) => m.stage !== "BRACKET"), ...built];
    });
  }

  function setBracketWinner(nodeId, winnerTeamId) {
    setBracket((prev) => {
      const updated = prev.map((n) => (n.id === nodeId ? { ...n, winnerId: winnerTeamId } : n));
      return fillThirdPlace(propagateBracketWinners(updated));
    });
  }

  // Sync bracket node teams into bracket matches list (so hand tracker always uses correct teams)
  useEffect(() => {
    if (bracket.length === 0) return;
    setMatches((prev) =>
      prev.map((m) => {
        if (m.stage !== "BRACKET") return m;
        const nodeId = m.id.replace(/^match_/, "");
        const node = bracket.find((n) => n.id === nodeId);
        if (!node) return m;
        if (m.teamAId === node.teamAId && m.teamBId === node.teamBId) return m;
        // if teams changed, clear hands for safety
        return recomputeMatch({
          ...m,
          teamAId: node.teamAId,
          teamBId: node.teamBId,
          hands: [],
          fastDraft: defaultFastDraft(),
          completed: false,
          winnerId: null,
        });
      })
    );
  }, [bracket]);

  // Auto-advance bracket winner when its match completes (match winner becomes node winner)
  useEffect(() => {
    if (bracket.length === 0) return;
    const byNodeId = new Map(bracket.map((n) => [n.id, n]));
    const bracketMatches = matches.filter((m) => m.stage === "BRACKET");
    let changed = false;

    bracketMatches.forEach((m) => {
      const nodeId = m.id.replace(/^match_/, "");
      const node = byNodeId.get(nodeId);
      if (!node) return;
      if (!m.completed || !m.winnerId) return;
      if (node.winnerId !== m.winnerId) {
        changed = true;
      }
    });

    if (!changed) return;

    setBracket((prev) => {
      let next = [...prev];
      bracketMatches.forEach((m) => {
        const nodeId = m.id.replace(/^match_/, "");
        const idx = next.findIndex((n) => n.id === nodeId);
        if (idx === -1) return;
        if (m.completed && m.winnerId && next[idx].winnerId !== m.winnerId) {
          next[idx] = { ...next[idx], winnerId: m.winnerId };
        }
      });
      next = fillThirdPlace(propagateBracketWinners(next));
      return next;
    });
  }, [matches, bracket.length]);

  /** ===== Winner board ===== */
  const winnerBoard = useMemo(() => {
    const final = bracket.find((n) => n.round === "F");
    const third = bracket.find((n) => n.round === "3P");

    const champId = final?.winnerId ?? null;
    const runnerId =
      final?.winnerId && final.teamAId && final.teamBId
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

  /** ===== Scoreboard summary ===== */
  const allTeamStats = useMemo(() => {
    // Aggregate across pool + bracket matches
    const byTeam = new Map();
    teams.forEach((t) => {
      byTeam.set(t.id, {
        teamId: t.id,
        name: t.name,
        matchPoints: 0,
        wins: 0,
        losses: 0,
        totalGamePoints: 0,
        totalHands: 0,
        coinches: 0,
        surcoinches: 0,
        capots: 0,
        belotes: 0,
        biggestSingleHand: 0,
      });
    });

    matches.forEach((m) => {
      const A = byTeam.get(m.teamAId);
      const B = byTeam.get(m.teamBId);
      if (!A || !B) return;

      A.totalGamePoints += m.totalA || 0;
      B.totalGamePoints += m.totalB || 0;

      A.matchPoints += m.matchPtsA || 0;
      B.matchPoints += m.matchPtsB || 0;

      A.totalHands += m.hands.length;
      B.totalHands += m.hands.length;

      if (m.completed && m.winnerId) {
        if (m.winnerId === m.teamAId) {
          A.wins += 1;
          B.losses += 1;
        } else {
          B.wins += 1;
          A.losses += 1;
        }
      }

      m.hands.forEach((h) => {
        const d = h.draftSnapshot || {};
        const lvl = d.coincheLevel || "NONE";
        if (lvl === "COINCHE") (d.bidder === "A" ? A : B).coinches += 1;
        if (lvl === "SURCOINCHE") (d.bidder === "A" ? A : B).surcoinches += 1;
        if (d.capot) (d.bidder === "A" ? A : B).capots += 1;
        if (d.beloteTeam === "A") A.belotes += 1;
        if (d.beloteTeam === "B") B.belotes += 1;

        const ha = Number(h.scoreA) || 0;
        const hb = Number(h.scoreB) || 0;
        A.biggestSingleHand = Math.max(A.biggestSingleHand, ha);
        B.biggestSingleHand = Math.max(B.biggestSingleHand, hb);
      });
    });

    return Array.from(byTeam.values()).sort((a, b) => {
      if (b.matchPoints !== a.matchPoints) return b.matchPoints - a.matchPoints;
      if (b.totalGamePoints !== a.totalGamePoints) return b.totalGamePoints - a.totalGamePoints;
      return a.name.localeCompare(b.name);
    });
  }, [teams, matches]);

  const funnyStats = useMemo(() => {
    const best = (key) => {
      let top = null;
      allTeamStats.forEach((t) => {
        if (!top || (t[key] || 0) > (top[key] || 0)) top = t;
      });
      return top;
    };

    const coincheKing = best("coinches");
    const surcoincheBoss = best("surcoinches");
    const capotMachine = best("capots");
    const beloteMagnet = best("belotes");
    const bigHand = best("biggestSingleHand");

    return [
      { label: "Coinche King", value: coincheKing ? `${coincheKing.name} (${coincheKing.coinches})` : "—" },
      { label: "Surcoinche Boss", value: surcoincheBoss ? `${surcoincheBoss.name} (${surcoincheBoss.surcoinches})` : "—" },
      { label: "Capot Machine", value: capotMachine ? `${capotMachine.name} (${capotMachine.capots})` : "—" },
      { label: "Belote Magnet", value: beloteMagnet ? `${beloteMagnet.name} (${beloteMagnet.belotes})` : "—" },
      { label: "Biggest Single Hand", value: bigHand ? `${bigHand.name} (${bigHand.biggestSingleHand})` : "—" },
    ];
  }, [allTeamStats]);

  /** ===== Table view match picker ===== */
  function getTableCurrentMatch(tableNum) {
    // Pool phase tables fixed (1-4). We show the first unfinished match for that table, else last match.
    const poolMatches = matches
      .filter((m) => m.stage === "POOL" && m.table === tableNum)
      .sort((a, b) => (a.round || 0) - (b.round || 0));

    if (poolMatches.length === 0) return null;

    const pending = poolMatches.find((m) => !m.completed);
    return pending || poolMatches[poolMatches.length - 1];
  }

  /** ===== Export CSV ===== */
  function exportCSV() {
    const lines = [];

    // Header meta
    lines.push(["Tournament", tournamentName].map(csvEscape).join(","));
    lines.push(["ExportedAt", new Date().toISOString()].map(csvEscape).join(","));
    lines.push([]);

    // Players
    lines.push(["PLAYERS"].join(","));
    lines.push(["player_id", "name"].map(csvEscape).join(","));
    players.forEach((p) => lines.push([p.id, p.name].map(csvEscape).join(",")));
    lines.push([]);

    // Teams
    lines.push(["TEAMS"].join(","));
    lines.push(["team_id", "team_name", "player1", "player2", "locked"].map(csvEscape).join(","));
    teams.forEach((t) => {
      const p1 = playerById.get(t.playerIds?.[0])?.name || "";
      const p2 = playerById.get(t.playerIds?.[1])?.name || "";
      lines.push([t.id, t.name, p1, p2, t.locked ? "YES" : "NO"].map(csvEscape).join(","));
    });
    lines.push([]);

    // Matches summary
    lines.push(["MATCHES"].join(","));
    lines.push(
      ["match_id", "stage", "label", "pool", "round", "table", "teamA", "teamB", "totalA", "totalB", "winner", "hands", "matchPtsA", "matchPtsB"]
        .map(csvEscape)
        .join(",")
    );

    matches.forEach((m) => {
      const ta = teamById.get(m.teamAId)?.name || "";
      const tb = teamById.get(m.teamBId)?.name || "";
      const winner = m.winnerId ? teamById.get(m.winnerId)?.name || "" : "";
      lines.push(
        [
          m.id,
          m.stage,
          m.label,
          m.pool || "",
          m.round || "",
          m.table || "",
          ta,
          tb,
          m.totalA || 0,
          m.totalB || 0,
          winner,
          m.hands.length,
          m.matchPtsA || 0,
          m.matchPtsB || 0,
        ]
          .map(csvEscape)
          .join(",")
      );
    });
    lines.push([]);

    // Hands (detailed)
    lines.push(["HANDS"].join(","));
    lines.push(
      [
        "match_id",
        "hand_idx",
        "createdAt",
        "bidder",
        "bid",
        "suit",
        "coincheLevel",
        "capot",
        "bidderTrickPoints",
        "announceA",
        "announceB",
        "beloteTeam",
        "scoreA",
        "scoreB",
      ]
        .map(csvEscape)
        .join(",")
    );

    matches.forEach((m) => {
      m.hands.forEach((h) => {
        const d = h.draftSnapshot || {};
        lines.push(
          [
            m.id,
            h.idx,
            new Date(h.createdAt).toISOString(),
            d.bidder || "",
            d.bid ?? "",
            d.suit || "",
            d.coincheLevel || "",
            d.capot ? "YES" : "NO",
            d.bidderTrickPoints ?? "",
            d.announceA ?? "",
            d.announceB ?? "",
            d.beloteTeam || "",
            h.scoreA ?? 0,
            h.scoreB ?? 0,
          ]
            .map(csvEscape)
            .join(",")
        );
      });
    });

    downloadTextFile(`${tournamentName.replace(/\s+/g, "_")}_export.csv`, lines.join("\n"));
  }

  /** ===== Timer controls ===== */
  function timerStartOrResume() {
    const now = Date.now();
    if (!timerStartTs) {
      setTimerStartTs(now);
      setTimerPaused(false);
      setTimerPausedAtTs(null);
      setTimerPausedAccumMs(0);
      return;
    }
    // resume
    if (timerPaused && timerPausedAtTs) {
      setTimerPaused(false);
      setTimerPausedAccumMs((prev) => prev + (now - timerPausedAtTs));
      setTimerPausedAtTs(null);
    } else {
      setTimerPaused(false);
    }
  }

  function timerPause() {
    if (!timerStartTs) return;
    if (timerPaused) return;
    const now = Date.now();
    setTimerPaused(true);
    setTimerPausedAtTs(now);
  }

  function timerReset() {
    setTimerStartTs(null);
    setTimerPaused(true);
    setTimerPausedAtTs(null);
    setTimerPausedAccumMs(0);
  }

  /** ===== Views ===== */
  const nav = (
    <div style={styles.nav}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={styles.brandDot} />
        <div style={{ fontWeight: 900, letterSpacing: 0.2 }}>{tournamentName}</div>
        <span style={styles.chip}>Target: {TARGET_SCORE}</span>
        <span style={styles.chip}>Start: {START_TIME}</span>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <a href={adminLink} style={styles.navLink}>Admin</a>
        <a href={publicLink} style={styles.navLink}>Public View</a>
        <a href={tableLink(1)} style={styles.navLink}>Table 1</a>
        <a href={tableLink(2)} style={styles.navLink}>Table 2</a>
        <a href={tableLink(3)} style={styles.navLink}>Table 3</a>
        <a href={tableLink(4)} style={styles.navLink}>Table 4</a>
      </div>
    </div>
  );

  // Choose view
  if (route.path === "/public") {
    return (
      <div style={styles.page}>
        {nav}
        <div style={styles.container}>
          <TimerBanner timerRunning={!timerPaused && !!timerStartTs} timerInfo={timerInfo} startTime={START_TIME} />

          <div style={styles.grid2}>
            <Card title="Winner Board">
              <div style={styles.podiumGrid}>
                <PodiumCard label="Champion" value={winnerBoard.champion} />
                <PodiumCard label="Runner-up" value={winnerBoard.runnerUp} />
                <PodiumCard label="3rd Place" value={winnerBoard.third} />
              </div>
            </Card>

            <Card title="Public Links (share)">
              <div style={styles.kv}>
                <div style={styles.kRow}><div style={styles.k}>Public View</div><div style={styles.v}><code style={styles.code}>{window.location.origin + window.location.pathname + "#/public"}</code></div></div>
                <div style={styles.kRow}><div style={styles.k}>Table 1</div><div style={styles.v}><code style={styles.code}>{window.location.origin + window.location.pathname + "#/table?num=1"}</code></div></div>
                <div style={styles.kRow}><div style={styles.k}>Table 2</div><div style={styles.v}><code style={styles.code}>{window.location.origin + window.location.pathname + "#/table?num=2"}</code></div></div>
                <div style={styles.kRow}><div style={styles.k}>Table 3</div><div style={styles.v}><code style={styles.code}>{window.location.origin + window.location.pathname + "#/table?num=3"}</code></div></div>
                <div style={styles.kRow}><div style={styles.k}>Table 4</div><div style={styles.v}><code style={styles.code}>{window.location.origin + window.location.pathname + "#/table?num=4"}</code></div></div>
              </div>
              <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 10 }}>
                Public view is read-only. Tables should enter scores using their Table View.
              </div>
            </Card>
          </div>

          <div style={styles.grid2}>
            <Card title="Scoreboard (All Teams)">
              <ScoreboardList rows={allTeamStats} />
            </Card>

            <Card title="Stats + Funny Stats">
              <div style={styles.statGrid}>
                <StatTile label="Teams" value={teams.length} />
                <StatTile label="Players" value={players.length} />
                <StatTile label="Matches" value={matches.length} />
                <StatTile label="Hands Logged" value={matches.reduce((s, m) => s + m.hands.length, 0)} />
              </div>

              <div style={{ height: 12 }} />

              <div style={styles.funnyGrid}>
                {funnyStats.map((s) => (
                  <div key={s.label} style={styles.funnyCard}>
                    <div style={{ color: "#94a3b8", fontSize: 12 }}>{s.label}</div>
                    <div style={{ fontWeight: 900, marginTop: 4 }}>{s.value}</div>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          <div style={styles.grid2}>
            <Card title="Pool A Standings">
              {standingsA.length === 0 ? (
                <div style={styles.muted}>Pools not created yet (Admin → Create pools).</div>
              ) : (
                <StandingsList rows={standingsA} />
              )}
            </Card>

            <Card title="Pool B Standings">
              {standingsB.length === 0 ? (
                <div style={styles.muted}>Pools not created yet (Admin → Create pools).</div>
              ) : (
                <StandingsList rows={standingsB} />
              )}
            </Card>
          </div>

          <Card title="Bracket (Visual)">
            {bracket.length === 0 ? (
              <div style={styles.muted}>Bracket not created yet (Admin → Create bracket).</div>
            ) : (
              <BracketVisual bracket={bracket} teamById={teamById} />
            )}
          </Card>
        </div>
      </div>
    );
  }

  if (route.path === "/table") {
    const tableNum = route.tableNum;
    const valid = tableNum && tableNum >= 1 && tableNum <= 4;

    const match = valid ? getTableCurrentMatch(tableNum) : null;

    return (
      <div style={styles.page}>
        {nav}
        <div style={styles.container}>
          <TimerBanner timerRunning={!timerPaused && !!timerStartTs} timerInfo={timerInfo} startTime={START_TIME} />

          <Card title={`Table View ${valid ? `— Table ${tableNum}` : ""}`}>
            {!valid ? (
              <div style={styles.muted}>
                Invalid table number. Use: <code style={styles.code}>#/table?num=1</code> (1..4)
              </div>
            ) : !match ? (
              <div style={styles.muted}>No match found for this table yet. Admin must Create pools first.</div>
            ) : (
              <TableMatchPanel
                match={match}
                teamById={teamById}
                onDraftPatch={(patch) => updateDraft(match.id, patch)}
                onAddHand={() => addHand(match.id)}
                onClearHands={() => clearHands(match.id)}
              />
            )}
          </Card>

          <div style={styles.grid2}>
            <Card title="Live Scoreboard (Read-only)">
              <ScoreboardList rows={allTeamStats} />
            </Card>

            <Card title="Pool Standings Snapshot">
              {poolsReady ? (
                <div style={styles.grid2}>
                  <div>
                    <div style={styles.subTitle}>Pool A</div>
                    <StandingsList rows={standingsA} />
                  </div>
                  <div>
                    <div style={styles.subTitle}>Pool B</div>
                    <StandingsList rows={standingsB} />
                  </div>
                </div>
              ) : (
                <div style={styles.muted}>Pools not created yet.</div>
              )}
            </Card>
          </div>
        </div>
      </div>
    );
  }

  // Admin default
  return (
    <div style={styles.page}>
      {nav}
      <div style={styles.container}>
        <div style={styles.hero}>
          <div>
            <div style={{ fontSize: 28, fontWeight: 950, letterSpacing: 0.2 }}>{tournamentName}</div>
            <div style={{ color: "#94a3b8", marginTop: 6 }}>
              Admin controls — teams, schedule, timer, export
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
            <button style={styles.btnSecondary} onClick={resetTournamentOnly} disabled={matches.length === 0 && bracket.length === 0}>
              Reset Tournament
            </button>
            <button style={styles.btnDanger} onClick={fullReset}>
              Full Reset
            </button>
          </div>
        </div>

        <Card title="Timer Controls">
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <button style={styles.btnPrimary} onClick={timerStartOrResume}>
              {timerStartTs ? (timerPaused ? "Resume Timer" : "Timer Running") : "Start Timer"}
            </button>
            <button style={styles.btnSecondary} onClick={timerPause} disabled={!timerStartTs || timerPaused}>
              Pause
            </button>
            <button style={styles.btnSecondary} onClick={timerReset}>
              Reset Timer
            </button>
            <span style={styles.chip}>Now: {timerInfo.currentTime}</span>
            <span style={styles.chip}>
              {timerInfo.currentLabel} — {timerInfo.remainingInBlock} min left
            </span>
          </div>
          <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 8 }}>
            The timer shows on Public View and Table Views. (Cross-device syncing can be added later with Supabase.)
          </div>
        </Card>

        <Card title="Settings">
          <div style={styles.responsiveRow}>
            <div style={{ flex: "1 1 320px" }}>
              <div style={styles.label}>Tournament name</div>
              <input
                style={styles.input("100%")}
                value={tournamentName}
                onChange={(e) => setTournamentName(e.target.value)}
              />
            </div>

            <div style={{ flex: "1 1 140px" }}>
              <div style={styles.label}>Win threshold</div>
              <input
                style={styles.input("100%")}
                inputMode="numeric"
                value={String(winThreshold)}
                onChange={(e) => setWinThreshold(Math.max(0, Number(e.target.value || 0)))}
              />
            </div>

            <div style={{ flex: "1 1 140px" }}>
              <div style={styles.label}>Win ≥ threshold</div>
              <input
                style={styles.input("100%")}
                inputMode="numeric"
                value={String(winHighPts)}
                onChange={(e) => setWinHighPts(Math.max(0, Number(e.target.value || 0)))}
              />
            </div>

            <div style={{ flex: "1 1 140px" }}>
              <div style={styles.label}>Win &lt; threshold</div>
              <input
                style={styles.input("100%")}
                inputMode="numeric"
                value={String(winLowPts)}
                onChange={(e) => setWinLowPts(Math.max(0, Number(e.target.value || 0)))}
              />
            </div>

            <div style={{ flex: "0 0 auto", alignSelf: "end" }}>
              <button style={styles.btnSecondary} onClick={exportCSV}>
                Export CSV (Excel)
              </button>
            </div>
          </div>
          <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 8 }}>
            Tiebreaker = total game points across matches.
          </div>
        </Card>

        <div style={styles.grid2}>
          <Card title={`Players (${players.length})`}>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <input
                ref={inputRef}
                style={styles.input(280)}
                value={newPlayerName}
                onChange={(e) => setNewPlayerName(e.target.value)}
                placeholder="Add player name"
                onKeyDown={(e) => {
                  if (e.key === "Enter") addPlayer();
                }}
              />
              <button style={styles.btnPrimary} onClick={addPlayer} disabled={!newPlayerName.trim()}>
                Add Player
              </button>
            </div>

            <div style={{ height: 12 }} />

            <div style={styles.gridCards}>
              {players.map((p) => (
                <div key={p.id} style={styles.cardRow}>
                  <div style={{ fontWeight: 800, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {p.name}
                  </div>
                  <button style={styles.linkDanger} onClick={() => removePlayer(p.id)}>Remove</button>
                </div>
              ))}
              {players.length === 0 ? <div style={styles.muted}>Add players to begin (recommended 16 for 8 teams).</div> : null}
            </div>
          </Card>

          <Card title={`Teams (8) — manual selection + lock`}>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button style={styles.btnSecondary} onClick={ensure8TeamsSkeleton}>
                Reset Team Slots (8)
              </button>
              <button style={styles.btnPrimary} onClick={randomizeUnlockedTeams} disabled={players.length < 2}>
                Randomize Unlocked Teams
              </button>
            </div>

            <div style={{ height: 12 }} />

            {!teamValidation.ok ? (
              <div style={styles.warnBox}>
                <div style={{ fontWeight: 900, marginBottom: 6 }}>Fix these before scheduling:</div>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {teamValidation.issues.slice(0, 6).map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <div style={styles.okBox}>Teams look valid ✅</div>
            )}

            <div style={{ height: 12 }} />

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
              {teams.map((t, idx) => (
                <div key={t.id} style={styles.teamCard}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                    <div style={{ fontWeight: 950 }}>{`#${idx + 1}`}</div>
                    <label style={{ display: "flex", gap: 8, alignItems: "center", color: "#e2e8f0", fontWeight: 800 }}>
                      <input
                        type="checkbox"
                        checked={Boolean(t.locked)}
                        onChange={() => toggleTeamLock(t.id)}
                      />
                      Lock
                    </label>
                  </div>

                  <div style={{ height: 10 }} />

                  <div style={styles.label}>Team name</div>
                  <input
                    style={styles.input("100%")}
                    value={t.name}
                    onChange={(e) => setTeamName(t.id, e.target.value)}
                  />

                  <div style={{ height: 10 }} />

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
                    <div>
                      <div style={styles.label}>Player 1</div>
                      <select
                        style={styles.select("100%")}
                        value={t.playerIds?.[0] || ""}
                        onChange={(e) => setTeamPlayer(t.id, 0, e.target.value || null)}
                      >
                        <option value="">— select —</option>
                        {players.map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <div style={styles.label}>Player 2</div>
                      <select
                        style={styles.select("100%")}
                        value={t.playerIds?.[1] || ""}
                        onChange={(e) => setTeamPlayer(t.id, 1, e.target.value || null)}
                      >
                        <option value="">— select —</option>
                        {players.map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div style={{ height: 8 }} />
                  <div style={{ color: "#94a3b8", fontSize: 12 }}>
                    {t.playerIds?.map((pid) => playerById.get(pid)?.name).filter(Boolean).join(" • ") || "No players selected"}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>

        <Card title="Schedule (8 teams) — Pools + Bracket">
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <button
              style={styles.btnPrimary}
              onClick={createPoolsAndRoundRobin}
              disabled={!teamValidation.ok}
            >
              Create Pools + Round Robin (Tables 1–4)
            </button>

            <button
              style={styles.btnSecondary}
              onClick={createBracketFromPools}
              disabled={standingsA.length < 4 || standingsB.length < 4}
            >
              Create Bracket (Top 4 each)
            </button>

            <span style={styles.chip}>Tables: 4</span>
            <span style={styles.chip}>Game: {GAME_MIN} min</span>
            <span style={styles.chip}>Break: {BREAK_MIN} min</span>
          </div>

          <div style={{ height: 12 }} />

          {!poolsReady ? (
            <div style={styles.muted}>
              Pools not created yet. Click “Create Pools + Round Robin”.
            </div>
          ) : (
            <div style={styles.grid2}>
              <div>
                <div style={styles.subTitle}>Pool A teams</div>
                <div style={styles.mutedSmall}>{poolMap.A.map((id) => teamById.get(id)?.name).filter(Boolean).join(" • ")}</div>
                <div style={{ height: 10 }} />
                <StandingsList rows={standingsA} />
              </div>
              <div>
                <div style={styles.subTitle}>Pool B teams</div>
                <div style={styles.mutedSmall}>{poolMap.B.map((id) => teamById.get(id)?.name).filter(Boolean).join(" • ")}</div>
                <div style={{ height: 10 }} />
                <StandingsList rows={standingsB} />
              </div>
            </div>
          )}

          <div style={{ height: 12 }} />

          <div style={styles.grid2}>
            <CardMini title="Pool Matches (Tables 1–4)">
              {matches.filter((m) => m.stage === "POOL").length === 0 ? (
                <div style={styles.muted}>No pool matches yet.</div>
              ) : (
                <MatchListCompact
                  matches={matches.filter((m) => m.stage === "POOL").sort((a, b) => (a.round || 0) - (b.round || 0) || (a.table || 0) - (b.table || 0))}
                  teamById={teamById}
                />
              )}
            </CardMini>

            <CardMini title="Bracket (Visual)">
              {bracket.length === 0 ? (
                <div style={styles.muted}>No bracket yet.</div>
              ) : (
                <BracketVisual bracket={bracket} teamById={teamById} />
              )}
            </CardMini>
          </div>
        </Card>

        <div style={styles.grid2}>
          <Card title="Live Scoreboard + Stats">
            <ScoreboardList rows={allTeamStats} />
            <div style={{ height: 12 }} />
            <div style={styles.statGrid}>
              <StatTile label="Hands Logged" value={matches.reduce((s, m) => s + m.hands.length, 0)} />
              <StatTile label="Matches Completed" value={matches.filter((m) => m.completed).length} />
              <StatTile label="Bracket Ready" value={bracket.length ? "YES" : "NO"} />
              <StatTile label="Teams Valid" value={teamValidation.ok ? "YES" : "NO"} />
            </div>
          </Card>

          <Card title="Funny Stats">
            <div style={styles.funnyGrid}>
              {funnyStats.map((s) => (
                <div key={s.label} style={styles.funnyCard}>
                  <div style={{ color: "#94a3b8", fontSize: 12 }}>{s.label}</div>
                  <div style={{ fontWeight: 950, marginTop: 4 }}>{s.value}</div>
                </div>
              ))}
            </div>
            <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 10 }}>
              These update live as tables add hands.
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

/** ===== Components ===== */

function Card({ title, children, right }) {
  return (
    <div style={styles.card}>
      <div style={styles.cardHeader}>
        <div style={{ fontWeight: 950 }}>{title}</div>
        {right ? <div>{right}</div> : null}
      </div>
      <div>{children}</div>
    </div>
  );
}

function CardMini({ title, children }) {
  return (
    <div style={styles.cardMini}>
      <div style={{ fontWeight: 950, marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}

function TimerBanner({ timerRunning, timerInfo, startTime }) {
  const label = timerRunning ? "LIVE" : "PAUSED";
  const statusColor = timerRunning ? "rgba(34,197,94,0.12)" : "rgba(148,163,184,0.10)";
  return (
    <div style={{ ...styles.card, padding: 14, background: statusColor }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span style={styles.chip}>⏱ Timer: {label}</span>
          <span style={styles.chip}>Start: {startTime}</span>
          <span style={styles.chip}>
            Now: <b style={{ marginLeft: 6 }}>{timerInfo.currentLabel}</b>{" "}
            <span style={{ opacity: 0.85 }}>({timerInfo.currentTime})</span>
          </span>
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {timerInfo.inBreak ? (
            <span style={styles.chip}>Break — <b style={{ marginLeft: 6 }}>{timerInfo.remainingInBlock} min</b> left</span>
          ) : (
            <span style={styles.chip}>Game — <b style={{ marginLeft: 6 }}>{timerInfo.remainingInBlock} min</b> left</span>
          )}
        </div>
      </div>

      <div style={{ marginTop: 8, color: "#cbd5e1", fontSize: 12 }}>
        Round length = {GAME_MIN} min game + {BREAK_MIN} min break.
      </div>
    </div>
  );
}

function PodiumCard({ label, value }) {
  return (
    <div style={styles.podiumCard}>
      <div style={{ color: "#94a3b8", fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 950, marginTop: 6 }}>{value ?? "—"}</div>
    </div>
  );
}

function StatTile({ label, value }) {
  return (
    <div style={styles.statTile}>
      <div style={{ color: "#94a3b8", fontSize: 12 }}>{label}</div>
      <div style={{ fontWeight: 950, marginTop: 6, fontSize: 18 }}>{value}</div>
    </div>
  );
}

function ScoreboardList({ rows }) {
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {rows.map((r, idx) => (
        <div key={r.teamId} style={styles.scoreRow}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0 }}>
            <div style={styles.rankBadge}>#{idx + 1}</div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 950, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</div>
              <div style={{ color: "#94a3b8", fontSize: 12 }}>
                W {r.wins} • L {r.losses} • Total pts {r.totalGamePoints}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
            <span style={styles.chip}>Match Pts: {r.matchPoints}</span>
            <span style={styles.chip}>Hands: {r.totalHands}</span>
          </div>
        </div>
      ))}
      {rows.length === 0 ? <div style={styles.muted}>No teams yet.</div> : null}
    </div>
  );
}

function StandingsList({ rows }) {
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {rows.map((r, idx) => (
        <div key={r.teamId} style={styles.standRow}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0 }}>
            <div style={styles.rankBadge}>#{idx + 1}</div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 950, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</div>
              <div style={{ color: "#94a3b8", fontSize: 12 }}>Tiebreak: {r.totalGamePoints}</div>
            </div>
          </div>
          <div style={{ fontWeight: 950 }}>Pts: {r.matchPoints}</div>
        </div>
      ))}
    </div>
  );
}

function MatchListCompact({ matches, teamById }) {
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {matches.map((m) => {
        const ta = teamById.get(m.teamAId)?.name || "—";
        const tb = teamById.get(m.teamBId)?.name || "—";
        const status = m.completed ? `Final ${m.totalA}–${m.totalB}` : `${m.totalA}–${m.totalB}`;
        return (
          <div key={m.id} style={styles.matchCompact}>
            <div style={{ fontWeight: 950 }}>
              Table {m.table} • R{m.round} • {ta} vs {tb}
            </div>
            <div style={{ color: m.completed ? "#34d399" : "#94a3b8", fontWeight: 900 }}>{status}</div>
          </div>
        );
      })}
    </div>
  );
}

function BracketVisual({ bracket, teamById }) {
  // order nodes
  const order = { QF: 1, SF: 2, F: 3, "3P": 4 };
  const nodes = [...bracket].sort(
    (a, b) => (order[a.round] ?? 99) - (order[b.round] ?? 99) || (a.idx ?? 0) - (b.idx ?? 0)
  );

  const qf = nodes.filter((n) => n.round === "QF");
  const sf = nodes.filter((n) => n.round === "SF");
  const fin = nodes.filter((n) => n.round === "F");
  const third = nodes.filter((n) => n.round === "3P");

  const Box = ({ node }) => {
    const a = node.teamAId ? teamById.get(node.teamAId)?.name : "TBD";
    const b = node.teamBId ? teamById.get(node.teamBId)?.name : "TBD";
    const w = node.winnerId ? teamById.get(node.winnerId)?.name : null;

    return (
      <div style={styles.brBox}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
          <div style={{ fontWeight: 950 }}>{node.label}</div>
          <div style={{ color: w ? "#34d399" : "#94a3b8", fontWeight: 900, fontSize: 12 }}>
            {w ? `Winner: ${w}` : "Pending"}
          </div>
        </div>
        <div style={{ height: 8 }} />
        <div style={styles.brTeam}>{a}</div>
        <div style={styles.brTeam}>{b}</div>
      </div>
    );
  };

  return (
    <div style={styles.bracketWrap}>
      <div style={styles.brCol}>
        <div style={styles.brColTitle}>Quarter Finals</div>
        {qf.map((n) => <Box key={n.id} node={n} />)}
      </div>

      <div style={styles.brCol}>
        <div style={styles.brColTitle}>Semi Finals</div>
        {sf.map((n) => <Box key={n.id} node={n} />)}
      </div>

      <div style={styles.brCol}>
        <div style={styles.brColTitle}>Final</div>
        {fin.map((n) => <Box key={n.id} node={n} />)}
        <div style={{ height: 12 }} />
        <div style={styles.brColTitle}>3rd Place</div>
        {third.map((n) => <Box key={n.id} node={n} />)}
      </div>
    </div>
  );
}

function TableMatchPanel({ match, teamById, onDraftPatch, onAddHand, onClearHands }) {
  const ta = teamById.get(match.teamAId)?.name || "—";
  const tb = teamById.get(match.teamBId)?.name || "—";

  const progressA = Math.min(100, Math.floor(((match.totalA || 0) / TARGET_SCORE) * 100));
  const progressB = Math.min(100, Math.floor(((match.totalB || 0) / TARGET_SCORE) * 100));

  const d = match.fastDraft || defaultFastDraft();

  const suitObj = SUITS.find((s) => s.value === (d.suit || "S")) || SUITS[3];

  return (
    <div>
      <div style={styles.matchHeader}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 950, fontSize: 18, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {match.label} • Table {match.table} • Round {match.round}
          </div>
          <div style={{ color: "#94a3b8", marginTop: 4 }}>
            {ta} vs {tb}
          </div>
        </div>

        <div style={{ textAlign: "right" }}>
          <div style={{ fontWeight: 950, color: match.completed ? "#34d399" : "#e2e8f0" }}>
            {match.completed ? "MATCH COMPLETE" : "IN PROGRESS"}
          </div>
          <div style={{ color: "#94a3b8", fontSize: 12 }}>
            Hands: {match.hands.length}
          </div>
        </div>
      </div>

      <div style={{ height: 12 }} />

      {/* Progress bars side-by-side */}
      <div style={styles.progressGrid}>
        <div style={styles.progressCard}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
            <div style={{ fontWeight: 950 }}>{ta}</div>
            <div style={{ fontWeight: 950 }}>{match.totalA}</div>
          </div>
          <div style={styles.progressOuter}>
            <div style={{ ...styles.progressInner, width: `${progressA}%` }} />
          </div>
          <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 6 }}>
            {progressA}% to {TARGET_SCORE}
          </div>
        </div>

        <div style={styles.progressCard}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
            <div style={{ fontWeight: 950 }}>{tb}</div>
            <div style={{ fontWeight: 950 }}>{match.totalB}</div>
          </div>
          <div style={styles.progressOuter}>
            <div style={{ ...styles.progressInner, width: `${progressB}%` }} />
          </div>
          <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 6 }}>
            {progressB}% to {TARGET_SCORE}
          </div>
        </div>
      </div>

      <div style={{ height: 14 }} />

      <div style={styles.handSectionTitle}>Hand Tracker (Fast Mode) — auto-calculates points</div>

      <div style={styles.handGrid}>
        <div>
          <div style={styles.label}>Bidder</div>
          <select
            style={styles.select("100%")}
            value={d.bidder}
            onChange={(e) => onDraftPatch({ bidder: e.target.value })}
            disabled={match.completed}
          >
            <option value="A">Team A (left)</option>
            <option value="B">Team B (right)</option>
          </select>
        </div>

        <div>
          <div style={styles.label}>Bid + Suit</div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 120px" }}>
              <input
                style={styles.input("100%")}
                inputMode="numeric"
                placeholder="80.."
                value={d.bid}
                onChange={(e) => onDraftPatch({ bid: e.target.value })}
                disabled={match.completed}
              />
            </div>
            <div style={{ flex: "1 1 180px" }}>
              <select
                style={styles.select("100%")}
                value={d.suit || "S"}
                onChange={(e) => onDraftPatch({ suit: e.target.value })}
                disabled={match.completed}
              >
                {SUITS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.icon} {s.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 6 }}>
            Selected suit: <b>{suitObj.icon} {suitObj.label}</b>
          </div>
        </div>

        <div>
          <div style={styles.label}>Coinche</div>
          <select
            style={styles.select("100%")}
            value={d.coincheLevel || "NONE"}
            onChange={(e) => onDraftPatch({ coincheLevel: e.target.value })}
            disabled={match.completed}
          >
            {COINCHE_LEVELS.map((x) => (
              <option key={x.value} value={x.value}>{x.label}</option>
            ))}
          </select>
        </div>

        <div>
          <div style={styles.label}>Capot</div>
          <label style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10, color: "#e2e8f0", fontWeight: 900 }}>
            <input
              type="checkbox"
              checked={Boolean(d.capot)}
              onChange={(e) => onDraftPatch({ capot: e.target.checked })}
              disabled={match.completed}
            />
            Capot (250)
          </label>
        </div>

        <div>
          <div style={styles.label}>Bidder trick points (0–162)</div>
          <input
            style={styles.input("100%")}
            inputMode="numeric"
            placeholder="81"
            value={d.bidderTrickPoints}
            onChange={(e) => onDraftPatch({ bidderTrickPoints: e.target.value })}
            disabled={match.completed}
          />
        </div>

        <div>
          <div style={styles.label}>Announces Team A (non-belote)</div>
          <input
            style={styles.input("100%")}
            inputMode="numeric"
            placeholder="0"
            value={d.announceA}
            onChange={(e) => onDraftPatch({ announceA: e.target.value })}
            disabled={match.completed}
          />
        </div>

        <div>
          <div style={styles.label}>Announces Team B (non-belote)</div>
          <input
            style={styles.input("100%")}
            inputMode="numeric"
            placeholder="0"
            value={d.announceB}
            onChange={(e) => onDraftPatch({ announceB: e.target.value })}
            disabled={match.completed}
          />
        </div>

        <div>
          <div style={styles.label}>Belote (who has it)</div>
          <select
            style={styles.select("100%")}
            value={d.beloteTeam || "NONE"}
            onChange={(e) => onDraftPatch({ beloteTeam: e.target.value })}
            disabled={match.completed}
          >
            <option value="NONE">None</option>
            <option value="A">Team A</option>
            <option value="B">Team B</option>
          </select>
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
        <button style={styles.btnPrimary} onClick={onAddHand} disabled={match.completed}>
          Add Hand
        </button>
        <button style={styles.btnSecondary} onClick={onClearHands}>
          Clear Match Hands
        </button>
      </div>

      {match.completed ? (
        <div style={{ marginTop: 12, ...styles.okBox }}>
          Winner declared — match ended immediately at {TARGET_SCORE}.
        </div>
      ) : null}

      <div style={{ height: 14 }} />

      <div style={styles.subTitle}>Hands Played</div>
      {match.hands.length === 0 ? (
        <div style={styles.muted}>No hands logged yet.</div>
      ) : (
        <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
          {match.hands.slice().reverse().map((h) => {
            const d = h.draftSnapshot || {};
            const suit = SUITS.find((s) => s.value === d.suit)?.icon || "";
            return (
              <div key={h.idx} style={styles.handRow}>
                <div style={{ fontWeight: 950 }}>Hand {h.idx}</div>
                <div style={{ color: "#94a3b8", fontSize: 12 }}>
                  Bidder {d.bidder} • Bid {d.bid} {suit} • {d.coincheLevel} • Tricks {d.bidderTrickPoints} • Belote {d.beloteTeam}
                </div>
                <div style={{ fontWeight: 950 }}>
                  +{h.scoreA} / +{h.scoreB}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** ===== Styles ===== */
const styles = {
  page: {
    minHeight: "100vh",
    background: "radial-gradient(1200px 600px at 15% 0%, rgba(59,130,246,0.25), rgba(15,23,42,0)) , linear-gradient(180deg, #0b1220 0%, #050914 100%)",
    color: "#e5e7eb",
  },
  container: {
    maxWidth: 1200,
    margin: "0 auto",
    padding: "16px 16px 60px",
  },
  nav: {
    position: "sticky",
    top: 0,
    zIndex: 20,
    backdropFilter: "blur(10px)",
    background: "rgba(2,6,23,0.65)",
    borderBottom: "1px solid rgba(148,163,184,0.15)",
    padding: "12px 16px",
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap",
    alignItems: "center",
  },
  brandDot: {
    width: 12,
    height: 12,
    borderRadius: 999,
    background: "linear-gradient(135deg, #60a5fa 0%, #34d399 100%)",
    boxShadow: "0 0 0 6px rgba(96,165,250,0.12)",
  },
  navLink: {
    color: "#e2e8f0",
    textDecoration: "none",
    fontWeight: 900,
    padding: "8px 10px",
    borderRadius: 12,
    border: "1px solid rgba(148,163,184,0.18)",
    background: "rgba(2,6,23,0.35)",
  },
  hero: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "end",
    gap: 12,
    flexWrap: "wrap",
    marginBottom: 14,
  },
  card: {
    border: "1px solid rgba(148,163,184,0.16)",
    background: "rgba(2,6,23,0.40)",
    borderRadius: 18,
    padding: 16,
    boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
    marginBottom: 14,
  },
  cardHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: 10,
    marginBottom: 12,
  },
  cardMini: {
    border: "1px solid rgba(148,163,184,0.16)",
    background: "rgba(2,6,23,0.35)",
    borderRadius: 18,
    padding: 14,
  },
  grid2: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
    gap: 14,
  },
  gridCards: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: 10,
  },
  responsiveRow: {
    display: "flex",
    gap: 12,
    flexWrap: "wrap",
    alignItems: "end",
  },
  label: {
    color: "#94a3b8",
    fontSize: 12,
    fontWeight: 800,
    marginBottom: 6,
  },
  input: (w = 240) => ({
    width: typeof w === "number" ? `${w}px` : w,
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(148,163,184,0.22)",
    background: "rgba(2,6,23,0.35)",
    color: "#e5e7eb",
    outline: "none",
  }),
  select: (w = 180) => ({
    width: typeof w === "number" ? `${w}px` : w,
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(148,163,184,0.22)",
    background: "rgba(2,6,23,0.35)",
    color: "#e5e7eb",
    outline: "none",
  }),
  btnPrimary: {
    border: "1px solid rgba(59,130,246,0.35)",
    background: "linear-gradient(135deg, rgba(59,130,246,0.95), rgba(34,197,94,0.85))",
    color: "#071018",
    fontWeight: 950,
    padding: "10px 12px",
    borderRadius: 14,
    cursor: "pointer",
  },
  btnSecondary: {
    border: "1px solid rgba(148,163,184,0.18)",
    background: "rgba(2,6,23,0.35)",
    color: "#e2e8f0",
    fontWeight: 900,
    padding: "10px 12px",
    borderRadius: 14,
    cursor: "pointer",
  },
  btnDanger: {
    border: "1px solid rgba(239,68,68,0.35)",
    background: "rgba(239,68,68,0.16)",
    color: "#fecaca",
    fontWeight: 950,
    padding: "10px 12px",
    borderRadius: 14,
    cursor: "pointer",
  },
  chip: {
    border: "1px solid rgba(148,163,184,0.20)",
    background: "rgba(2,6,23,0.30)",
    padding: "6px 10px",
    borderRadius: 999,
    color: "#e2e8f0",
    fontWeight: 800,
    fontSize: 12,
  },
  code: {
    padding: "2px 6px",
    borderRadius: 8,
    background: "rgba(148,163,184,0.12)",
    border: "1px solid rgba(148,163,184,0.14)",
    color: "#e2e8f0",
  },
  muted: { color: "#94a3b8" },
  mutedSmall: { color: "#94a3b8", fontSize: 12 },
  subTitle: { fontWeight: 950, marginBottom: 6 },
  podiumGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 },
  podiumCard: {
    border: "1px solid rgba(148,163,184,0.16)",
    background: "rgba(2,6,23,0.35)",
    borderRadius: 18,
    padding: 14,
  },
  statGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
    gap: 10,
  },
  statTile: {
    border: "1px solid rgba(148,163,184,0.16)",
    background: "rgba(2,6,23,0.35)",
    borderRadius: 18,
    padding: 12,
  },
  funnyGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: 10,
  },
  funnyCard: {
    border: "1px solid rgba(148,163,184,0.16)",
    background: "rgba(2,6,23,0.35)",
    borderRadius: 18,
    padding: 12,
  },
  scoreRow: {
    border: "1px solid rgba(148,163,184,0.16)",
    background: "rgba(2,6,23,0.35)",
    borderRadius: 18,
    padding: 12,
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    alignItems: "center",
    flexWrap: "wrap",
  },
  standRow: {
    border: "1px solid rgba(148,163,184,0.16)",
    background: "rgba(2,6,23,0.35)",
    borderRadius: 18,
    padding: 12,
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    alignItems: "center",
  },
  rankBadge: {
    width: 44,
    height: 34,
    borderRadius: 12,
    display: "grid",
    placeItems: "center",
    background: "rgba(59,130,246,0.16)",
    border: "1px solid rgba(59,130,246,0.22)",
    fontWeight: 950,
  },
  cardRow: {
    border: "1px solid rgba(148,163,184,0.16)",
    background: "rgba(2,6,23,0.35)",
    borderRadius: 16,
    padding: 12,
    display: "flex",
    justifyContent: "space-between",
    gap: 10,
    alignItems: "center",
  },
  linkDanger: {
    border: "none",
    background: "transparent",
    color: "#fca5a5",
    fontWeight: 950,
    cursor: "pointer",
  },
  warnBox: {
    border: "1px solid rgba(251,191,36,0.26)",
    background: "rgba(251,191,36,0.10)",
    borderRadius: 16,
    padding: 12,
    color: "#fde68a",
  },
  okBox: {
    border: "1px solid rgba(34,197,94,0.22)",
    background: "rgba(34,197,94,0.10)",
    borderRadius: 16,
    padding: 12,
    color: "#bbf7d0",
    fontWeight: 800,
  },
  teamCard: {
    border: "1px solid rgba(148,163,184,0.16)",
    background: "rgba(2,6,23,0.35)",
    borderRadius: 18,
    padding: 12,
  },
  matchCompact: {
    border: "1px solid rgba(148,163,184,0.16)",
    background: "rgba(2,6,23,0.35)",
    borderRadius: 16,
    padding: 12,
    display: "flex",
    justifyContent: "space-between",
    gap: 10,
    alignItems: "center",
    flexWrap: "wrap",
  },
  bracketWrap: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
    gap: 12,
  },
  brCol: {
    border: "1px solid rgba(148,163,184,0.14)",
    background: "rgba(2,6,23,0.30)",
    borderRadius: 18,
    padding: 12,
  },
  brColTitle: { fontWeight: 950, marginBottom: 10, color: "#e2e8f0" },
  brBox: {
    border: "1px solid rgba(148,163,184,0.16)",
    background: "rgba(2,6,23,0.35)",
    borderRadius: 16,
    padding: 12,
    marginBottom: 10,
  },
  brTeam: {
    padding: "8px 10px",
    borderRadius: 14,
    border: "1px solid rgba(148,163,184,0.14)",
    background: "rgba(2,6,23,0.25)",
    fontWeight: 900,
    marginBottom: 8,
  },
  matchHeader: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap",
    alignItems: "center",
    paddingBottom: 10,
    borderBottom: "1px solid rgba(148,163,184,0.14)",
  },
  progressGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
    gap: 12,
  },
  progressCard: {
    border: "1px solid rgba(148,163,184,0.16)",
    background: "rgba(2,6,23,0.35)",
    borderRadius: 18,
    padding: 12,
  },
  progressOuter: {
    marginTop: 10,
    height: 14,
    borderRadius: 999,
    border: "1px solid rgba(148,163,184,0.14)",
    background: "rgba(2,6,23,0.25)",
    overflow: "hidden",
  },
  progressInner: {
    height: "100%",
    borderRadius: 999,
    background: "linear-gradient(90deg, rgba(59,130,246,0.95), rgba(34,197,94,0.85))",
  },
  handSectionTitle: { fontWeight: 950, fontSize: 16 },
  handGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
    gap: 12,
    marginTop: 12,
  },
  handRow: {
    border: "1px solid rgba(148,163,184,0.16)",
    background: "rgba(2,6,23,0.35)",
    borderRadius: 16,
    padding: 12,
    display: "grid",
    gridTemplateColumns: "110px 1fr 120px",
    gap: 10,
    alignItems: "center",
  },
  kv: { display: "grid", gap: 10 },
  kRow: {
    border: "1px solid rgba(148,163,184,0.14)",
    background: "rgba(2,6,23,0.30)",
    borderRadius: 16,
    padding: 10,
    display: "grid",
    gridTemplateColumns: "120px 1fr",
    gap: 10,
    alignItems: "center",
  },
  k: { color: "#94a3b8", fontWeight: 900, fontSize: 12 },
  v: { minWidth: 0, overflow: "hidden" },
};