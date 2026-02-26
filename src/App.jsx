import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * 9th Annual Coinche Tournament (Vite single-file App.jsx)
 * ✅ Exactly 8 teams (2 pools of 4) + RR inside pools + bracket (QF/SF/Final + 3rd)
 * ✅ Admin view + Public view (read-only) + Table view (enter only your table match)
 * ✅ Live scoreboard + stats + funny stats
 * ✅ Timer (start/pause/reset) shown on Public + Table
 * ✅ Fast mode Hand Tracker:
 *    - add hands with suit dropdown + icons
 *    - auto calculates hand points and accumulates to match totals
 *    - ends match immediately at 2000+
 *    - NEW hand starts blank after add/save
 *    - past hands editable
 * ✅ Progress bars to 2000 per team for the current match
 * ✅ Team builder:
 *    - randomize teams
 *    - OR manual pick players for each team
 *    - lock team toggle (locked teams won't change on randomize)
 * ✅ Export CSV (Excel-friendly) for all tournament data
 *
 * Notes:
 * - Deploy-friendly (no shadcn)
 * - Uses localStorage
 * - Route via URL hash:
 *    #/admin
 *    #/public
 *    #/table?code=AB12  (each match has a short "table code")
 */

const LS_KEY = "coinche_tournament_vite_full_v2";
const TARGET_SCORE = 2000;

// Schedule / timer defaults
const GAME_MIN = 40;
const BREAK_MIN = 5;
const START_TIME = "10:00"; // display only (not auto-start)

function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}
function shortCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
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
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

/** Circle method RR scheduler */
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

function buildPoolAssignmentFor8(teamIdsInOrder) {
  // exactly 8 teams => 4 and 4
  return { A: teamIdsInOrder.slice(0, 4), B: teamIdsInOrder.slice(4, 8) };
}

/** ===== Fast mode scoring helpers ===== */
function roundTrickPoints(x) {
  if (x == null) return 0;
  const n = clamp(Number(x) || 0, 0, 162);
  // Approx rounding to nearest 10 (down at 5) using +4 trick approach
  return Math.floor((n + 4) / 10) * 10;
}

/**
 * Fast mode compute (kept from your previous)
 * - bidder trick points (0..162 raw)
 * - announces A/B (non-belote)
 * - belote team adds 20 to that team
 * - capot: winner gets 250 + all announces + belote + bid
 * - coinche: winner gets 160 + mult*bid + announces ; belote remains with declaring team
 * - normal:
 *    - success: bidder gets rounded tricks + bidder announces + bid (+ belote if theirs)
 *              opp gets rounded opp tricks + opp announces (+ belote if theirs)
 *    - fail: bidder gets 0 (keeps belote if theirs), opp gets 160 + bid + all announces (+ their belote if theirs)
 */
function computeFastCoincheScore({
  bidder, // "A"|"B"
  bid, // number
  suit, // "H"|"D"|"C"|"S"
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
  const bidderHasBelote = (BIDDER_IS_A && beloteTeam === "A") || (!BIDDER_IS_A && beloteTeam === "B");
  const baseMin = bidderHasBelote ? 71 : 81;
  const special80 = bidVal === 80 ? 81 : 0;

  // Announces help (fast mode)
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
    return { scoreA, scoreB, bidderSucceeded: true };
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
    return { scoreA, scoreB, bidderSucceeded };
  }

  // Normal
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

  return { scoreA, scoreB, bidderSucceeded };
}

/** ===== Routing helpers ===== */
function parseHashRoute() {
  const raw = window.location.hash || "#/admin";
  const [pathPart, queryPart] = raw.replace(/^#/, "").split("?");
  const path = pathPart || "/admin";
  const q = new URLSearchParams(queryPart || "");
  const query = Object.fromEntries(q.entries());
  return { path, query };
}

/** ===== Styles ===== */
const styles = {
  page: {
    minHeight: "100vh",
    background:
      "radial-gradient(1200px 600px at 10% 10%, rgba(99,102,241,0.25), transparent 60%), radial-gradient(1200px 600px at 90% 10%, rgba(16,185,129,0.18), transparent 55%), radial-gradient(1200px 600px at 50% 90%, rgba(244,63,94,0.12), transparent 60%), linear-gradient(180deg, #0b1220 0%, #050814 100%)",
    color: "#e5e7eb",
    padding: 16,
  },
  container: { maxWidth: 1200, margin: "0 auto", display: "flex", flexDirection: "column", gap: 14 },
  topbar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-end",
    gap: 12,
    flexWrap: "wrap",
  },
  title: { margin: 0, fontSize: 28, fontWeight: 950, letterSpacing: "-0.02em" },
  subtitle: { color: "#94a3b8", marginTop: 6, fontSize: 13 },
  pillRow: { display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" },
  pill: {
    border: "1px solid rgba(148,163,184,0.20)",
    background: "rgba(2,6,23,0.55)",
    padding: "10px 12px",
    borderRadius: 16,
  },
  section: {
    background: "rgba(2,6,23,0.55)",
    border: "1px solid rgba(148,163,184,0.18)",
    borderRadius: 18,
    padding: 14,
    boxShadow: "0 12px 40px rgba(0,0,0,0.25)",
  },
  sectionHeader: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 10 },
  h2: { margin: 0, fontSize: 16, fontWeight: 900, letterSpacing: "-0.01em" },
  small: { fontSize: 12, color: "#94a3b8" },

  btnPrimary: {
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(99,102,241,0.35)",
    background: "linear-gradient(180deg, rgba(99,102,241,0.95), rgba(79,70,229,0.9))",
    color: "#fff",
    cursor: "pointer",
    fontWeight: 900,
  },
  btnSecondary: {
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(148,163,184,0.22)",
    background: "rgba(2,6,23,0.4)",
    color: "#e5e7eb",
    cursor: "pointer",
    fontWeight: 850,
  },
  btnDanger: {
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(244,63,94,0.40)",
    background: "linear-gradient(180deg, rgba(244,63,94,0.95), rgba(190,18,60,0.9))",
    color: "#fff",
    cursor: "pointer",
    fontWeight: 900,
  },
  btnGhost: {
    padding: "8px 10px",
    borderRadius: 12,
    border: "1px solid transparent",
    background: "transparent",
    color: "#94a3b8",
    cursor: "pointer",
    fontWeight: 900,
  },
  disabled: { opacity: 0.55, cursor: "not-allowed" },

  input: (w = 240) => ({
    width: typeof w === "number" ? `${w}px` : w,
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(148,163,184,0.22)",
    background: "rgba(2,6,23,0.35)",
    color: "#e5e7eb",
    outline: "none",
    boxSizing: "border-box",
    minWidth: 0,
    display: "block",
  }),
  select: (w = 180) => ({
    width: typeof w === "number" ? `${w}px` : w,
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(148,163,184,0.22)",
    background: "rgba(2,6,23,0.35)",
    color: "#e5e7eb",
    outline: "none",
    boxSizing: "border-box",
    minWidth: 0,
    display: "block",
  }),

  grid2: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 12 },
  grid3: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 },
  grid4: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 12 },
  card: {
    background: "rgba(2,6,23,0.35)",
    border: "1px solid rgba(148,163,184,0.18)",
    borderRadius: 18,
    padding: 12,
  },

  row: { display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" },

  progressWrap: {
    height: 12,
    borderRadius: 999,
    background: "rgba(148,163,184,0.16)",
    overflow: "hidden",
    border: "1px solid rgba(148,163,184,0.14)",
  },
  progressFillA: (pct) => ({
    height: "100%",
    width: `${pct}%`,
    background: "linear-gradient(90deg, rgba(34,197,94,0.95), rgba(16,185,129,0.9))",
  }),
  progressFillB: (pct) => ({
    height: "100%",
    width: `${pct}%`,
    background: "linear-gradient(90deg, rgba(99,102,241,0.95), rgba(59,130,246,0.9))",
  }),

  bracketGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
    gap: 12,
    alignItems: "start",
  },

  handGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
    gap: 12,
    marginTop: 12,
    alignItems: "start",
  },
  handRow: {
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

  tag: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 10px",
    borderRadius: 999,
    background: "rgba(148,163,184,0.12)",
    border: "1px solid rgba(148,163,184,0.14)",
    color: "#e2e8f0",
    fontSize: 12,
    fontWeight: 800,
  },
};

function SuitIcon({ suit }) {
  const map = {
    H: { ch: "♥", color: "#fb7185", label: "Hearts" },
    D: { ch: "♦", color: "#fb7185", label: "Diamonds" },
    C: { ch: "♣", color: "#34d399", label: "Clubs" },
    S: { ch: "♠", color: "#60a5fa", label: "Spades" },
  };
  const s = map[suit] || map.S;
  return (
    <span title={s.label} style={{ fontWeight: 1000, color: s.color }}>
      {s.ch}
    </span>
  );
}

function fmtMMSS(sec) {
  const s = Math.max(0, Math.floor(sec));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

/** ===== Main App ===== */
export default function App() {
  const [route, setRoute] = useState(() => parseHashRoute());

  // Core tournament data
  const [loaded, setLoaded] = useState(false);
  const [tournamentName, setTournamentName] = useState("9th Annual Coinche Tournament");

  // Players and teams
  const [players, setPlayers] = useState([]); // {id,name}
  const [teams, setTeams] = useState([]); // {id,name,playerIds[], locked:boolean}
  const [avoidSameTeams, setAvoidSameTeams] = useState(true);
  const [pairHistory, setPairHistory] = useState([]); // ["p1|p2", ...]

  // Pools & matches
  const [poolMap, setPoolMap] = useState({ A: [], B: [] }); // {A:[teamId...], B:[teamId...]}
  const [matches, setMatches] = useState([]); // pool matches + bracket matches as separate structures
  const [bracket, setBracket] = useState([]); // bracket matches only

  // Standings scoring
  const [winThreshold, setWinThreshold] = useState(2000);
  const [winHighPts, setWinHighPts] = useState(2);
  const [winLowPts, setWinLowPts] = useState(1);

  // Timer / schedule state
  const [timerRunning, setTimerRunning] = useState(false);
  const [timerSeconds, setTimerSeconds] = useState(GAME_MIN * 60); // countdown
  const [timerMode, setTimerMode] = useState("GAME"); // "GAME" | "BREAK"
  const lastTickRef = useRef(null);

  // UI helpers
  const [newPlayerName, setNewPlayerName] = useState("");
  const inputRef = useRef(null);

  // Hash route listener
  useEffect(() => {
    const onHash = () => setRoute(parseHashRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Load localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        setTournamentName(d.tournamentName ?? "9th Annual Coinche Tournament");
        setPlayers(d.players ?? []);
        setTeams(d.teams ?? []);
        setAvoidSameTeams(Boolean(d.avoidSameTeams ?? true));
        setPairHistory(d.pairHistory ?? []);
        setPoolMap(d.poolMap ?? { A: [], B: [] });
        setMatches(d.matches ?? []);
        setBracket(d.bracket ?? []);
        setWinThreshold(d.winThreshold ?? 2000);
        setWinHighPts(d.winHighPts ?? 2);
        setWinLowPts(d.winLowPts ?? 1);

        setTimerRunning(Boolean(d.timerRunning ?? false));
        setTimerSeconds(Number.isFinite(d.timerSeconds) ? d.timerSeconds : GAME_MIN * 60);
        setTimerMode(d.timerMode ?? "GAME");
      }
    } catch {
      // ignore
    } finally {
      setLoaded(true);
    }
  }, []);

  // Persist localStorage
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
        matches,
        bracket,
        winThreshold,
        winHighPts,
        winLowPts,
        timerRunning,
        timerSeconds,
        timerMode,
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
    matches,
    bracket,
    winThreshold,
    winHighPts,
    winLowPts,
    timerRunning,
    timerSeconds,
    timerMode,
  ]);

  // Timer tick (1s)
  useEffect(() => {
    if (!timerRunning) {
      lastTickRef.current = null;
      return;
    }
    const id = setInterval(() => {
      const now = Date.now();
      if (!lastTickRef.current) lastTickRef.current = now;
      const dt = Math.floor((now - lastTickRef.current) / 1000);
      if (dt <= 0) return;
      lastTickRef.current = now;

      setTimerSeconds((prev) => {
        const next = prev - dt;
        return next <= 0 ? 0 : next;
      });
    }, 250);
    return () => clearInterval(id);
  }, [timerRunning]);

  // Auto stop when hits 0
  useEffect(() => {
    if (!timerRunning) return;
    if (timerSeconds <= 0) setTimerRunning(false);
  }, [timerSeconds, timerRunning]);

  const playerById = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);
  const teamById = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams]);

  // Team numbering (1..n) based on current teams order
  const teamNumberById = useMemo(() => {
    const m = new Map();
    teams.forEach((t, i) => m.set(t.id, i + 1));
    return m;
  }, [teams]);

  const exactly8Teams = useMemo(() => teams.length === 8, [teams.length]);

  /** ===== Reset helpers ===== */
  function defaultFastDraft() {
    return {
      bidder: "A",
      bid: "",
      suit: "S",
      coincheLevel: "NONE",
      capot: false,
      bidderTrickPoints: "",
      announceA: "0",
      announceB: "0",
      beloteTeam: "NONE",
    };
  }

  function makeEmptyMatch({ stage, pool = null, round = null, table = null, teamAId, teamBId, label }) {
    return {
      id: uid("match"),
      code: shortCode(),
      stage, // "POOL" | "BRACKET"
      pool,
      round,
      table,
      label,
      teamAId,
      teamBId,
      hands: [],
      totalA: 0,
      totalB: 0,
      winnerId: null,
      completed: false,
      matchPtsA: 0,
      matchPtsB: 0,
      fastDraft: defaultFastDraft(),
      editingHandIdx: null, // NEW
    };
  }

  function resetTournamentStructure() {
    setPoolMap({ A: [], B: [] });
    setMatches([]);
    setBracket([]);
  }

  function fullReset() {
    setTournamentName("9th Annual Coinche Tournament");
    setPlayers([]);
    setTeams([]);
    setPairHistory([]);
    resetTournamentStructure();
    setTimerRunning(false);
    setTimerMode("GAME");
    setTimerSeconds(GAME_MIN * 60);
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
    // Reset teams + tournament because membership changed
    setTeams([]);
    setPairHistory([]);
    resetTournamentStructure();
  }

  /** ===== Teams ===== */
  function ensureEightTeamsSkeleton() {
    // Create 8 empty teams if not already.
    setTeams((prev) => {
      if (prev.length === 8) return prev;
      const next = [];
      for (let i = 0; i < 8; i++) {
        next.push({
          id: uid("t"),
          name: `Team ${i + 1}`,
          playerIds: [],
          locked: false,
        });
      }
      return next;
    });
    resetTournamentStructure();
  }

  function toggleTeamLock(teamId, locked) {
    setTeams((prev) =>
      prev.map((t) => (t.id === teamId ? { ...t, locked: Boolean(locked) } : t))
    );
  }

  function setTeamPlayer(teamId, slotIdx, playerIdOrEmpty) {
    setTeams((prev) =>
      prev.map((t) => {
        if (t.id !== teamId) return t;
        const ids = [...(t.playerIds || [])];
        // Expand to 2 slots
        while (ids.length < 2) ids.push("");
        ids[slotIdx] = playerIdOrEmpty;
        // Ensure uniqueness inside same team
        if (slotIdx === 0 && ids[0] && ids[0] === ids[1]) ids[1] = "";
        if (slotIdx === 1 && ids[1] && ids[0] === ids[1]) ids[0] = "";
        return { ...t, playerIds: ids.filter(Boolean) };
      })
    );
    resetTournamentStructure();
  }

  function renameTeam(teamId, name) {
    setTeams((prev) => prev.map((t) => (t.id === teamId ? { ...t, name } : t)));
  }

  function buildRandomTeams() {
    // respects locked teams
    if (players.length < 2) return;

    // Ensure we have 8 team objects
    let currentTeams = teams;
    if (currentTeams.length !== 8) {
      currentTeams = [];
      for (let i = 0; i < 8; i++) {
        currentTeams.push({
          id: uid("t"),
          name: `Team ${i + 1}`,
          playerIds: [],
          locked: false,
        });
      }
    }

    // collect locked playerIds (flatten)
    const lockedPlayers = new Set();
    currentTeams.forEach((t) => {
      if (!t.locked) return;
      (t.playerIds || []).forEach((pid) => lockedPlayers.add(pid));
    });

    // available players not in locked
    const available = players.map((p) => p.id).filter((pid) => !lockedPlayers.has(pid));

    const tries = avoidSameTeams ? 40 : 1;
    const historySet = new Set(pairHistory);

    let best = null;

    for (let k = 0; k < tries; k++) {
      const shuffled = shuffleArray(available);
      // Build pairs for unlocked teams only (need 2 slots each)
      const pairs = [];
      for (let i = 0; i < shuffled.length; i += 2) {
        const a = shuffled[i];
        const b = shuffled[i + 1] || null;
        pairs.push([a, b]);
      }

      // count repeats only on formed pairs
      let repeats = 0;
      for (const [a, b] of pairs) {
        if (!a || !b) continue;
        const key = [a, b].sort().join("|");
        if (historySet.has(key)) repeats++;
      }

      if (!best || repeats < best.repeats) {
        best = { pairs, repeats };
        if (repeats === 0) break;
      }
    }

    const finalPairs = best?.pairs ?? [];

    // assign pairs to UNLOCKED teams, filling missing with blanks if needed
    const nextTeams = currentTeams.map((t) => ({ ...t, playerIds: [...(t.playerIds || [])] }));

    let pairIdx = 0;
    for (let i = 0; i < nextTeams.length; i++) {
      if (nextTeams[i].locked) continue;
      const pair = finalPairs[pairIdx] || [null, null];
      pairIdx++;
      nextTeams[i].playerIds = [pair[0], pair[1]].filter(Boolean);
    }

    // Update team display names to include players (optional)
    const namedTeams = nextTeams.map((t, i) => {
      const pnames = (t.playerIds || []).map((pid) => playerById.get(pid)?.name).filter(Boolean);
      const base = `Team ${i + 1}`;
      const label = pnames.length ? `${base} — ${pnames.join(" / ")}` : base;
      return { ...t, name: t.name?.startsWith("Team ") ? label : t.name || label };
    });

    // record new pair history (only for new unlocked pairs)
    const newPairs = [];
    for (const t of namedTeams) {
      if ((t.playerIds || []).length === 2) {
        newPairs.push([...t.playerIds].sort().join("|"));
      }
    }

    setTeams(namedTeams);
    setPairHistory((prev) => Array.from(new Set([...prev, ...newPairs])));
    resetTournamentStructure();
  }

  // Build list of taken players across all teams, for manual picker filtering
  const usedPlayerIds = useMemo(() => {
    const s = new Set();
    teams.forEach((t) => (t.playerIds || []).forEach((pid) => s.add(pid)));
    return s;
  }, [teams]);

  /** ===== Matches & scoring ===== */
  function recomputeMatch(m) {
    const hands = m.hands || [];
    let totalA = 0;
    let totalB = 0;
    for (const h of hands) {
      totalA += Number(h.scoreA) || 0;
      totalB += Number(h.scoreB) || 0;
    }

    const completed = totalA >= TARGET_SCORE || totalB >= TARGET_SCORE;

    let winnerId = null;
    if (completed && totalA !== totalB) {
      winnerId = totalA > totalB ? m.teamAId : m.teamBId;
    }

    // match points only make sense for POOL matches
    let matchPtsA = 0;
    let matchPtsB = 0;
    if (m.stage === "POOL") {
      const winnerScore = winnerId ? Math.max(totalA, totalB) : null;
      const mp = computeMatchPoints(winnerScore, winThreshold, winHighPts, winLowPts);
      matchPtsA = winnerId === m.teamAId ? mp : 0;
      matchPtsB = winnerId === m.teamBId ? mp : 0;
    }

    return {
      ...m,
      totalA,
      totalB,
      completed,
      winnerId,
      matchPtsA,
      matchPtsB,
    };
  }

  function updateDraft(matchId, patch) {
    setMatches((prev) =>
      prev.map((m) => {
        if (m.id !== matchId) return m;
        return { ...m, fastDraft: { ...(m.fastDraft || defaultFastDraft()), ...patch } };
      })
    );
  }

  function startEditHand(matchId, handIdx) {
    setMatches((prev) =>
      prev.map((m) => {
        if (m.id !== matchId) return m;
        const hand = (m.hands || []).find((h) => h.idx === handIdx);
        if (!hand) return m;
        const d = hand.draftSnapshot || {};
        return {
          ...m,
          editingHandIdx: handIdx,
          fastDraft: {
            bidder: d.bidder ?? "A",
            bid: String(d.bid ?? ""),
            suit: d.suit ?? "S",
            coincheLevel: d.coincheLevel ?? "NONE",
            capot: Boolean(d.capot),
            bidderTrickPoints: String(d.bidderTrickPoints ?? ""),
            announceA: String(d.announceA ?? "0"),
            announceB: String(d.announceB ?? "0"),
            beloteTeam: d.beloteTeam ?? "NONE",
          },
        };
      })
    );
  }

  function cancelEditHand(matchId) {
    setMatches((prev) =>
      prev.map((m) => (m.id === matchId ? { ...m, editingHandIdx: null, fastDraft: defaultFastDraft() } : m))
    );
  }

  function addOrSaveHand(matchId) {
    setMatches((prev) =>
      prev.map((m) => {
        if (m.id !== matchId) return m;

        const d = m.fastDraft || defaultFastDraft();

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

        // If editing: replace that hand
        if (m.editingHandIdx) {
          const nextHands = (m.hands || []).map((h) => {
            if (h.idx !== m.editingHandIdx) return h;
            return {
              ...h,
              draftSnapshot: {
                bidder: d.bidder,
                bid: bidVal,
                suit: d.suit || "S",
                coincheLevel: d.coincheLevel || "NONE",
                capot: Boolean(d.capot),
                bidderTrickPoints: trickVal,
                announceA: safeInt(d.announceA) ?? 0,
                announceB: safeInt(d.announceB) ?? 0,
                beloteTeam: d.beloteTeam || "NONE",
              },
              scoreA: res.scoreA,
              scoreB: res.scoreB,
              bidderSucceeded: res.bidderSucceeded,
            };
          });

          const next = recomputeMatch({
            ...m,
            hands: nextHands,
            fastDraft: defaultFastDraft(), // blank after save
            editingHandIdx: null,
          });
          return next;
        }

        // Normal add: don't add after match ended
        const current = recomputeMatch(m);
        if (current.completed) return current;

        const nextHand = {
          idx: (m.hands?.length || 0) + 1,
          createdAt: Date.now(),
          draftSnapshot: {
            bidder: d.bidder,
            bid: bidVal,
            suit: d.suit || "S",
            coincheLevel: d.coincheLevel || "NONE",
            capot: Boolean(d.capot),
            bidderTrickPoints: trickVal,
            announceA: safeInt(d.announceA) ?? 0,
            announceB: safeInt(d.announceB) ?? 0,
            beloteTeam: d.beloteTeam || "NONE",
          },
          scoreA: res.scoreA,
          scoreB: res.scoreB,
          bidderSucceeded: res.bidderSucceeded,
        };

        const next = recomputeMatch({
          ...m,
          hands: [...(m.hands || []), nextHand],
          fastDraft: defaultFastDraft(), // blank after add
        });

        return next;
      })
    );
  }

  function clearMatchHands(matchId) {
    setMatches((prev) =>
      prev.map((m) => (m.id === matchId ? recomputeMatch({ ...m, hands: [], editingHandIdx: null, fastDraft: defaultFastDraft() }) : m))
    );
  }

  /** ===== Scheduling for exactly 8 teams ===== */
  function createPoolsRoundRobin8() {
    if (!exactly8Teams) return;

    // Pool assignment based on team order (Team 1-4 in A, 5-8 in B)
    const ids = teams.map((t) => t.id);
    const pools = buildPoolAssignmentFor8(ids);
    setPoolMap(pools);

    const built = [];

    // For 4-team pool RR => 3 rounds, 2 matches per round
    // Tables: for 8 teams you said 4 tables total:
    // Pool A uses tables 1-2, Pool B uses tables 3-4.
    const makePoolGames = (poolName, teamIds, tableOffset) => {
      const rounds = circleRoundRobin(teamIds); // 3 rounds
      rounds.forEach((pairings, rIdx) => {
        pairings.forEach(([a, b], pIdx) => {
          built.push(
            makeEmptyMatch({
              stage: "POOL",
              pool: poolName,
              round: rIdx + 1,
              table: tableOffset + (pIdx + 1),
              teamAId: a,
              teamBId: b,
              label: `Pool ${poolName} • Round ${rIdx + 1} • Table ${tableOffset + (pIdx + 1)}`,
            })
          );
        });
      });
    };

    makePoolGames("A", pools.A, 0);
    makePoolGames("B", pools.B, 2);

    // Pre-recompute (clean)
    const computed = built.map((m) => recomputeMatch(m));
    setMatches(computed);
    setBracket([]);
  }

  /** ===== Standings (Pools) ===== */
  const poolStandings = useMemo(() => {
    const computePool = (poolName) => {
      const ids = poolMap[poolName] || [];
      const rows = ids
        .map((id) => {
          const t = teamById.get(id);
          return t ? { teamId: t.id, name: t.name, matchPoints: 0, totalGamePoints: 0, gamesPlayed: 0, wins: 0, losses: 0 } : null;
        })
        .filter(Boolean);

      const byId = new Map(rows.map((r) => [r.teamId, r]));

      matches
        .filter((m) => m.stage === "POOL" && m.pool === poolName)
        .forEach((m) => {
          const a = byId.get(m.teamAId);
          const b = byId.get(m.teamBId);
          if (!a || !b) return;

          a.totalGamePoints += Number(m.totalA) || 0;
          b.totalGamePoints += Number(m.totalB) || 0;

          if ((m.hands || []).length > 0) {
            a.gamesPlayed += 1;
            b.gamesPlayed += 1;
          }

          a.matchPoints += m.matchPtsA ?? 0;
          b.matchPoints += m.matchPtsB ?? 0;

          if (m.winnerId === m.teamAId) {
            a.wins += 1;
            b.losses += 1;
          } else if (m.winnerId === m.teamBId) {
            b.wins += 1;
            a.losses += 1;
          }
        });

      return sortStandings(rows);
    };

    return {
      A: computePool("A"),
      B: computePool("B"),
    };
  }, [matches, poolMap, teamById]);

  /** ===== Bracket build & scoring ===== */
  function propagateBracketWinners(ms) {
    const byId = new Map(ms.map((m) => [m.id, { ...m }]));
    for (const m of ms) {
      if (!m.winnerId || !m.nextMatchId) continue;
      const next = byId.get(m.nextMatchId);
      if (!next) continue;

      const slotKey = m.nextSlot === "A" ? "teamAId" : "teamBId";
      if (next[slotKey] !== m.winnerId) {
        next[slotKey] = m.winnerId;
        // Reset downstream hands when bracket participants change
        next.hands = [];
        next.totalA = 0;
        next.totalB = 0;
        next.winnerId = null;
        next.completed = false;
        next.editingHandIdx = null;
        next.fastDraft = defaultFastDraft();
      }
      byId.set(next.id, next);
    }
    return Array.from(byId.values());
  }

  function fillThirdPlace(ms) {
    const sf = ms.filter((x) => x.roundTag === "SF");
    const third = ms.find((x) => x.roundTag === "3P");
    if (!third || sf.length !== 2) return ms;

    const sf1 = sf[0];
    const sf2 = sf[1];
    if (!sf1.teamAId || !sf1.teamBId || !sf1.winnerId) return ms;
    if (!sf2.teamAId || !sf2.teamBId || !sf2.winnerId) return ms;

    const loser1 = sf1.winnerId === sf1.teamAId ? sf1.teamBId : sf1.teamAId;
    const loser2 = sf2.winnerId === sf2.teamAId ? sf2.teamBId : sf2.teamAId;

    if (third.teamAId === loser1 && third.teamBId === loser2) return ms;

    return ms.map((m) => {
      if (m.id !== third.id) return m;
      return recomputeMatch({
        ...m,
        teamAId: loser1,
        teamBId: loser2,
        hands: [],
        fastDraft: defaultFastDraft(),
        editingHandIdx: null,
      });
    });
  }

  function createBracketFromPools() {
    // need top 4 each pool
    const a = poolStandings.A.slice(0, 4).map((x) => x.teamId);
    const b = poolStandings.B.slice(0, 4).map((x) => x.teamId);
    if (a.length < 4 || b.length < 4) return;

    // QF pairings:
    // A1 vs B4, A2 vs B3, B1 vs A4, B2 vs A3
    const qf = [
      { label: "QF1", A: a[0], B: b[3] },
      { label: "QF2", A: a[1], B: b[2] },
      { label: "QF3", A: b[0], B: a[3] },
      { label: "QF4", A: b[1], B: a[2] },
    ];

    const sfIds = [uid("sf"), uid("sf")];
    const fId = uid("f");
    const thirdId = uid("3p");

    const built = [];

    qf.forEach((m, idx) => {
      const nextMatchId = idx < 2 ? sfIds[0] : sfIds[1];
      const nextSlot = idx % 2 === 0 ? "A" : "B";
      built.push({
        ...makeEmptyMatch({
          stage: "BRACKET",
          teamAId: m.A,
          teamBId: m.B,
          label: m.label,
          table: idx + 1, // bracket tables 1-4
        }),
        roundTag: "QF",
        idx,
        nextMatchId,
        nextSlot,
      });
    });

    built.push({
      ...makeEmptyMatch({ stage: "BRACKET", teamAId: null, teamBId: null, label: "SF1", table: 1 }),
      id: sfIds[0],
      roundTag: "SF",
      idx: 0,
      nextMatchId: fId,
      nextSlot: "A",
    });
    built.push({
      ...makeEmptyMatch({ stage: "BRACKET", teamAId: null, teamBId: null, label: "SF2", table: 2 }),
      id: sfIds[1],
      roundTag: "SF",
      idx: 1,
      nextMatchId: fId,
      nextSlot: "B",
    });

    built.push({
      ...makeEmptyMatch({ stage: "BRACKET", teamAId: null, teamBId: null, label: "Final", table: 1 }),
      id: fId,
      roundTag: "F",
      idx: 0,
      nextMatchId: null,
      nextSlot: null,
    });

    built.push({
      ...makeEmptyMatch({ stage: "BRACKET", teamAId: null, teamBId: null, label: "3rd Place", table: 2 }),
      id: thirdId,
      roundTag: "3P",
      idx: 0,
      nextMatchId: null,
      nextSlot: null,
    });

    // compute winners propagation based on existing bracket (fresh => none)
    const computed = built.map((m) => recomputeMatch(m));
    const propagated = fillThirdPlace(propagateBracketWinners(computed));
    setBracket(propagated);
  }

  // Keep bracket winnerId in sync: derived from totals when completed
  useEffect(() => {
    if (!bracket.length) return;
    setBracket((prev) => fillThirdPlace(propagateBracketWinners(prev.map((m) => recomputeMatch(m)))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches.length]); // light sync trigger

  function updateBracketDraft(matchId, patch) {
    setBracket((prev) =>
      prev.map((m) => (m.id === matchId ? { ...m, fastDraft: { ...(m.fastDraft || defaultFastDraft()), ...patch } } : m))
    );
  }

  function startEditBracketHand(matchId, handIdx) {
    setBracket((prev) =>
      prev.map((m) => {
        if (m.id !== matchId) return m;
        const hand = (m.hands || []).find((h) => h.idx === handIdx);
        if (!hand) return m;
        const d = hand.draftSnapshot || {};
        return {
          ...m,
          editingHandIdx: handIdx,
          fastDraft: {
            bidder: d.bidder ?? "A",
            bid: String(d.bid ?? ""),
            suit: d.suit ?? "S",
            coincheLevel: d.coincheLevel ?? "NONE",
            capot: Boolean(d.capot),
            bidderTrickPoints: String(d.bidderTrickPoints ?? ""),
            announceA: String(d.announceA ?? "0"),
            announceB: String(d.announceB ?? "0"),
            beloteTeam: d.beloteTeam ?? "NONE",
          },
        };
      })
    );
  }

  function cancelEditBracket(matchId) {
    setBracket((prev) =>
      prev.map((m) => (m.id === matchId ? { ...m, editingHandIdx: null, fastDraft: defaultFastDraft() } : m))
    );
  }

  function addOrSaveBracketHand(matchId) {
    setBracket((prev) => {
      const next = prev.map((m) => {
        if (m.id !== matchId) return m;

        // Can't play if teams not set
        if (!m.teamAId || !m.teamBId) return m;

        const d = m.fastDraft || defaultFastDraft();
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

        // If editing
        if (m.editingHandIdx) {
          const hands = (m.hands || []).map((h) => {
            if (h.idx !== m.editingHandIdx) return h;
            return {
              ...h,
              draftSnapshot: {
                bidder: d.bidder,
                bid: bidVal,
                suit: d.suit || "S",
                coincheLevel: d.coincheLevel || "NONE",
                capot: Boolean(d.capot),
                bidderTrickPoints: trickVal,
                announceA: safeInt(d.announceA) ?? 0,
                announceB: safeInt(d.announceB) ?? 0,
                beloteTeam: d.beloteTeam || "NONE",
              },
              scoreA: res.scoreA,
              scoreB: res.scoreB,
              bidderSucceeded: res.bidderSucceeded,
            };
          });

          return recomputeMatch({
            ...m,
            hands,
            fastDraft: defaultFastDraft(),
            editingHandIdx: null,
          });
        }

        const current = recomputeMatch(m);
        if (current.completed) return current;

        const hand = {
          idx: (m.hands?.length || 0) + 1,
          createdAt: Date.now(),
          draftSnapshot: {
            bidder: d.bidder,
            bid: bidVal,
            suit: d.suit || "S",
            coincheLevel: d.coincheLevel || "NONE",
            capot: Boolean(d.capot),
            bidderTrickPoints: trickVal,
            announceA: safeInt(d.announceA) ?? 0,
            announceB: safeInt(d.announceB) ?? 0,
            beloteTeam: d.beloteTeam || "NONE",
          },
          scoreA: res.scoreA,
          scoreB: res.scoreB,
          bidderSucceeded: res.bidderSucceeded,
        };

        return recomputeMatch({
          ...m,
          hands: [...(m.hands || []), hand],
          fastDraft: defaultFastDraft(),
        });
      });

      return fillThirdPlace(propagateBracketWinners(next));
    });
  }

  function clearBracketHands(matchId) {
    setBracket((prev) => fillThirdPlace(propagateBracketWinners(prev.map((m) => (m.id === matchId ? recomputeMatch({ ...m, hands: [], editingHandIdx: null, fastDraft: defaultFastDraft() }) : m)))));
  }

  /** ===== Winner board ===== */
  const winnerBoard = useMemo(() => {
    const final = bracket.find((m) => m.roundTag === "F");
    const third = bracket.find((m) => m.roundTag === "3P");

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

  /** ===== Scoreboard + stats ===== */
  const allPoolMatches = useMemo(() => matches.filter((m) => m.stage === "POOL"), [matches]);
  const allBracketMatches = useMemo(() => bracket, [bracket]);

  const globalStats = useMemo(() => {
    const completedPool = allPoolMatches.filter((m) => m.completed);
    const completedBracket = allBracketMatches.filter((m) => m.completed);

    const allCompleted = [...completedPool, ...completedBracket];

    // total hands
    const totalHands = allCompleted.reduce((acc, m) => acc + (m.hands?.length || 0), 0);

    // biggest hand swing
    let biggestHand = { pts: 0, label: "—" };
    for (const m of allCompleted) {
      for (const h of m.hands || []) {
        const swing = Math.abs((h.scoreA || 0) - (h.scoreB || 0));
        if (swing > biggestHand.pts) {
          const ta = teamById.get(m.teamAId)?.name ?? "Team A";
          const tb = teamById.get(m.teamBId)?.name ?? "Team B";
          biggestHand = { pts: swing, label: `${ta} vs ${tb} (Hand ${h.idx})` };
        }
      }
    }

    // fastest match (fewest hands) among completed
    let fastest = null;
    for (const m of allCompleted) {
      const hands = (m.hands || []).length;
      if (!hands) continue;
      if (!fastest || hands < fastest.hands) fastest = { match: m, hands };
    }

    // closest match (smallest abs diff) among completed
    let closest = null;
    for (const m of allCompleted) {
      const diff = Math.abs((m.totalA || 0) - (m.totalB || 0));
      if (!m.completed) continue;
      if (diff === 0) continue;
      if (!closest || diff < closest.diff) closest = { match: m, diff };
    }

    // Funny stats
    // - "Coinche King": most coinche/surcoinche called (as recorded in draftSnapshot)
    // - "Capot Hero": most capots
    const teamFun = new Map(); // teamId -> {coinches, surcoinches, capots, belotes}
    const bump = (tid, key, n = 1) => {
      if (!tid) return;
      const cur = teamFun.get(tid) || { coinches: 0, surcoinches: 0, capots: 0, belotes: 0 };
      cur[key] = (cur[key] || 0) + n;
      teamFun.set(tid, cur);
    };

    for (const m of allCompleted) {
      for (const h of m.hands || []) {
        const d = h.draftSnapshot || {};
        if (d.coincheLevel === "COINCHE") bump(d.bidder === "A" ? m.teamAId : m.teamBId, "coinches");
        if (d.coincheLevel === "SURCOINCHE") bump(d.bidder === "A" ? m.teamAId : m.teamBId, "surcoinches");
        if (d.capot) bump(d.bidder === "A" ? m.teamAId : m.teamBId, "capots");
        if (d.beloteTeam === "A") bump(m.teamAId, "belotes");
        if (d.beloteTeam === "B") bump(m.teamBId, "belotes");
      }
    }

    const funLeaders = (key) => {
      let best = null;
      for (const [tid, obj] of teamFun.entries()) {
        const v = obj[key] || 0;
        if (!best || v > best.v) best = { tid, v };
      }
      if (!best || best.v === 0) return { name: "—", v: 0 };
      return { name: teamById.get(best.tid)?.name ?? "—", v: best.v };
    };

    const coincheKing = funLeaders("coinches");
    const surcoincheBoss = funLeaders("surcoinches");
    const capotHero = funLeaders("capots");
    const beloteMagnet = funLeaders("belotes");

    return {
      completedPoolGames: completedPool.length,
      completedBracketGames: completedBracket.length,
      totalHands,
      biggestHand,
      fastest,
      closest,
      funny: { coincheKing, surcoincheBoss, capotHero, beloteMagnet },
    };
  }, [allPoolMatches, allBracketMatches, teamById]);

  // Scoreboard rows (aggregate across pool matches)
  const scoreboardRows = useMemo(() => {
    // Build per-team stats from pool matches only (match points)
    const rows = teams.map((t) => ({
      teamId: t.id,
      name: t.name,
      pool: poolMap.A.includes(t.id) ? "A" : poolMap.B.includes(t.id) ? "B" : "—",
      matchPoints: 0,
      wins: 0,
      losses: 0,
      totalGamePoints: 0,
      gamesPlayed: 0,
    }));

    const byId = new Map(rows.map((r) => [r.teamId, r]));

    allPoolMatches.forEach((m) => {
      const ra = byId.get(m.teamAId);
      const rb = byId.get(m.teamBId);
      if (!ra || !rb) return;

      ra.totalGamePoints += Number(m.totalA) || 0;
      rb.totalGamePoints += Number(m.totalB) || 0;

      if ((m.hands || []).length > 0) {
        ra.gamesPlayed += 1;
        rb.gamesPlayed += 1;
      }

      ra.matchPoints += m.matchPtsA ?? 0;
      rb.matchPoints += m.matchPtsB ?? 0;

      if (m.winnerId === m.teamAId) {
        ra.wins += 1;
        rb.losses += 1;
      } else if (m.winnerId === m.teamBId) {
        rb.wins += 1;
        ra.losses += 1;
      }
    });

    return [...rows].sort((a, b) => {
      if (b.matchPoints !== a.matchPoints) return b.matchPoints - a.matchPoints;
      if (b.totalGamePoints !== a.totalGamePoints) return b.totalGamePoints - a.totalGamePoints;
      return a.name.localeCompare(b.name);
    });
  }, [teams, allPoolMatches, poolMap]);

  /** ===== Public & Table links ===== */
  const publicLink = useMemo(() => `${window.location.origin}${window.location.pathname}#/public`, []);
  const tableLinks = useMemo(() => {
    // one link per pool match + bracket match (so tables can enter)
    const list = [];
    matches.forEach((m) => list.push({ label: m.label, code: m.code, href: `${window.location.origin}${window.location.pathname}#/table?code=${m.code}` }));
    bracket.forEach((m) => list.push({ label: m.label, code: m.code, href: `${window.location.origin}${window.location.pathname}#/table?code=${m.code}` }));
    return list;
  }, [matches, bracket]);

  /** ===== Export CSV ===== */
  function exportCSV() {
    // Flatten tournament to CSV rows
    const rows = [];
    const pushRow = (obj) => rows.push(obj);

    // meta
    pushRow({ TYPE: "META", tournamentName, date: new Date().toISOString() });

    // teams
    teams.forEach((t, idx) => {
      const pnames = (t.playerIds || []).map((pid) => playerById.get(pid)?.name).filter(Boolean).join(" / ");
      pushRow({ TYPE: "TEAM", teamNumber: idx + 1, teamId: t.id, teamName: t.name, players: pnames, locked: t.locked ? "YES" : "NO" });
    });

    // pool matches + hands
    const addMatchRows = (m, phase) => {
      const ta = teamById.get(m.teamAId)?.name ?? "";
      const tb = teamById.get(m.teamBId)?.name ?? "";
      pushRow({
        TYPE: "MATCH",
        phase,
        matchId: m.id,
        code: m.code,
        label: m.label,
        pool: m.pool || "",
        round: m.round || "",
        table: m.table || "",
        teamA: ta,
        teamB: tb,
        totalA: m.totalA ?? 0,
        totalB: m.totalB ?? 0,
        winner: m.winnerId ? (teamById.get(m.winnerId)?.name ?? "") : "",
        completed: m.completed ? "YES" : "NO",
      });

      (m.hands || []).forEach((h) => {
        const d = h.draftSnapshot || {};
        pushRow({
          TYPE: "HAND",
          phase,
          matchId: m.id,
          code: m.code,
          handIdx: h.idx,
          scoreA: h.scoreA,
          scoreB: h.scoreB,
          bidder: d.bidder,
          bid: d.bid,
          suit: d.suit,
          coincheLevel: d.coincheLevel,
          capot: d.capot ? "YES" : "NO",
          bidderTrickPoints: d.bidderTrickPoints,
          announceA: d.announceA,
          announceB: d.announceB,
          beloteTeam: d.beloteTeam,
          bidderSucceeded: h.bidderSucceeded ? "YES" : "NO",
        });
      });
    };

    matches.forEach((m) => addMatchRows(m, "POOL"));
    bracket.forEach((m) => addMatchRows(m, `BRACKET_${m.roundTag || ""}`));

    // Convert to CSV
    const cols = Array.from(
      rows.reduce((set, r) => {
        Object.keys(r).forEach((k) => set.add(k));
        return set;
      }, new Set())
    );

    const esc = (v) => {
      const s = String(v ?? "");
      if (s.includes('"') || s.includes(",") || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };

    const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "coinche_tournament_export.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /** ===== Schedule display (not auto start) ===== */
  const schedule = useMemo(() => {
    // Pool RR with 3 rounds => 3 game slots, then QF/SF/F/3P slots (optional)
    // We'll display suggested times starting at 10:00 with 40 + 5 breaks.
    const slots = [];

    const addSlot = (title, idx) => {
      // idx 0 => start at 10:00
      const totalMinutes = idx * (GAME_MIN + BREAK_MIN);
      const [hh, mm] = START_TIME.split(":").map((x) => Number(x));
      const start = new Date();
      start.setHours(hh, mm, 0, 0);
      start.setMinutes(start.getMinutes() + totalMinutes);
      const end = new Date(start.getTime() + GAME_MIN * 60000);

      const fmt = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      slots.push({ title, start: fmt(start), end: fmt(end) });
    };

    addSlot("Pool Round 1", 0);
    addSlot("Pool Round 2", 1);
    addSlot("Pool Round 3", 2);
    addSlot("Quarterfinals (QF)", 3);
    addSlot("Semifinals (SF)", 4);
    addSlot("Final + 3rd Place", 5);

    return slots;
  }, []);

  /** ===== Route rendering ===== */
  const { path, query } = route;

  // Helpers: find match by table code for Table View
  const tableMatch = useMemo(() => {
    const code = (query.code || "").toUpperCase();
    if (!code) return null;
    const m1 = matches.find((m) => (m.code || "").toUpperCase() === code);
    if (m1) return { kind: "POOL", match: m1 };
    const m2 = bracket.find((m) => (m.code || "").toUpperCase() === code);
    if (m2) return { kind: "BRACKET", match: m2 };
    return null;
  }, [query.code, matches, bracket]);

  // ===== Nav links =====
  const NavPills = ({ showAdmin = true }) => (
    <div style={styles.pillRow}>
      {showAdmin ? (
        <a href="#/admin" style={{ ...styles.tag, textDecoration: "none" }}>
          Admin
        </a>
      ) : null}
      <a href="#/public" style={{ ...styles.tag, textDecoration: "none" }}>
        Public View
      </a>
      <span style={styles.tag}>
        Timer: {timerMode === "GAME" ? "Game" : "Break"} • {fmtMMSS(timerSeconds)} {timerRunning ? "▶" : "⏸"}
      </span>
    </div>
  );

  /** ===== Public View ===== */
  if (path === "/public") {
    return (
      <div style={styles.page}>
        <div style={styles.container}>
          <div style={styles.topbar}>
            <div>
              <h1 style={styles.title}>{tournamentName}</h1>
              <div style={styles.subtitle}>
                Public scoreboard • Live updates • {exactly8Teams ? "8 teams" : "Set up 8 teams in Admin"}
              </div>
            </div>
            <NavPills showAdmin={true} />
          </div>

          <PublicTimerPanel
            timerMode={timerMode}
            timerRunning={timerRunning}
            timerSeconds={timerSeconds}
            onStart={() => setTimerRunning(true)}
            onPause={() => setTimerRunning(false)}
            onResetGame={() => {
              setTimerRunning(false);
              setTimerMode("GAME");
              setTimerSeconds(GAME_MIN * 60);
            }}
            onStartBreak={() => {
              setTimerRunning(false);
              setTimerMode("BREAK");
              setTimerSeconds(BREAK_MIN * 60);
            }}
          />

          <div style={styles.grid2}>
            <Section title="Schedule (display only)">
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {schedule.map((s, i) => (
                  <div key={i} style={{ ...styles.card, display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                    <div style={{ fontWeight: 900 }}>{s.title}</div>
                    <div style={{ color: "#94a3b8", fontSize: 13 }}>
                      {s.start} – {s.end} (40 min + 5 min pause)
                    </div>
                  </div>
                ))}
              </div>
            </Section>

            <Section title="Winner Board">
              <div style={styles.grid3}>
                <PodiumCard label="Champion" value={winnerBoard.champion} />
                <PodiumCard label="Runner-up" value={winnerBoard.runnerUp} />
                <PodiumCard label="3rd Place" value={winnerBoard.third} />
              </div>
              <div style={{ marginTop: 10, color: "#94a3b8", fontSize: 12 }}>
                Winner board updates when bracket matches finish.
              </div>
            </Section>
          </div>

          <Section title="Live Scoreboard (Pool games)">
            <ScoreboardTable rows={scoreboardRows} />
          </Section>

          <div style={styles.grid2}>
            <Section title="Important Stats">
              <div style={styles.grid3}>
                <StatCard label="Completed Pool Games" value={globalStats.completedPoolGames} />
                <StatCard label="Completed Bracket Games" value={globalStats.completedBracketGames} />
                <StatCard label="Total Hands Played" value={globalStats.totalHands} />
                <StatCard label="Biggest Hand Swing" value={`${globalStats.biggestHand.pts}`} sub={globalStats.biggestHand.label} />
                <StatCard
                  label="Fastest Finished Match"
                  value={globalStats.fastest ? `${globalStats.fastest.hands} hands` : "—"}
                  sub={
                    globalStats.fastest
                      ? `${teamById.get(globalStats.fastest.match.teamAId)?.name ?? ""} vs ${teamById.get(globalStats.fastest.match.teamBId)?.name ?? ""}`
                      : ""
                  }
                />
                <StatCard
                  label="Closest Finished Match"
                  value={globalStats.closest ? `${globalStats.closest.diff} pts` : "—"}
                  sub={
                    globalStats.closest
                      ? `${teamById.get(globalStats.closest.match.teamAId)?.name ?? ""} vs ${teamById.get(globalStats.closest.match.teamBId)?.name ?? ""}`
                      : ""
                  }
                />
              </div>
            </Section>

            <Section title="Funny Stats">
              <div style={styles.grid3}>
                <StatCard label="Coinche King" value={globalStats.funny.coincheKing.name} sub={`${globalStats.funny.coincheKing.v} coinches`} />
                <StatCard label="Surcoinche Boss" value={globalStats.funny.surcoincheBoss.name} sub={`${globalStats.funny.surcoincheBoss.v} surcoinches`} />
                <StatCard label="Capot Hero" value={globalStats.funny.capotHero.name} sub={`${globalStats.funny.capotHero.v} capots`} />
                <StatCard label="Belote Magnet" value={globalStats.funny.beloteMagnet.name} sub={`${globalStats.funny.beloteMagnet.v} belotes`} />
              </div>
            </Section>
          </div>

          <Section title="Bracket (visual cards)">
            {bracket.length === 0 ? (
              <div style={styles.small}>Bracket not created yet. Ask Admin to click “Create bracket”.</div>
            ) : (
              <VisualBracket bracket={bracket} teamById={teamById} onOpenTable={(code) => (window.location.hash = `#/table?code=${code}`)} />
            )}
          </Section>

          <Section title="Table Entry Links (for teams)">
            <div style={{ color: "#94a3b8", fontSize: 12, marginBottom: 10 }}>
              Each table can use their own link to enter hands/scores. (Admin can share these.)
            </div>
            <div style={styles.grid3}>
              {tableLinks.map((t) => (
                <div key={t.code} style={styles.card}>
                  <div style={{ fontWeight: 900, marginBottom: 6 }}>{t.label}</div>
                  <div style={{ color: "#94a3b8", fontSize: 12, marginBottom: 10 }}>Code: {t.code}</div>
                  <a href={t.href} style={{ ...styles.btnSecondary, display: "inline-block", textDecoration: "none" }}>
                    Open Table View
                  </a>
                </div>
              ))}
            </div>
          </Section>
        </div>
      </div>
    );
  }

  /** ===== Table View ===== */
  if (path === "/table") {
    return (
      <div style={styles.page}>
        <div style={styles.container}>
          <div style={styles.topbar}>
            <div>
              <h1 style={styles.title}>{tournamentName}</h1>
              <div style={styles.subtitle}>Table View • Enter hands for your match only</div>
            </div>
            <NavPills showAdmin={true} />
          </div>

          <PublicTimerPanel
            timerMode={timerMode}
            timerRunning={timerRunning}
            timerSeconds={timerSeconds}
            onStart={() => setTimerRunning(true)}
            onPause={() => setTimerRunning(false)}
            onResetGame={() => {
              setTimerRunning(false);
              setTimerMode("GAME");
              setTimerSeconds(GAME_MIN * 60);
            }}
            onStartBreak={() => {
              setTimerRunning(false);
              setTimerMode("BREAK");
              setTimerSeconds(BREAK_MIN * 60);
            }}
          />

          {!tableMatch ? (
            <Section title="No match found">
              <div style={styles.small}>
                This table link is missing or incorrect. Ask the organizer for the correct code.
              </div>
              <div style={{ marginTop: 10 }}>
                <a href="#/public" style={{ ...styles.btnSecondary, textDecoration: "none" }}>
                  Go to Public View
                </a>
              </div>
            </Section>
          ) : (
            <Section title={`Your Match • Code ${tableMatch.match.code}`}>
              <TableMatchPanel
                match={tableMatch.match}
                kind={tableMatch.kind}
                teamById={teamById}
                teamNumberById={teamNumberById}
                onDraftPatch={(patch) => {
                  if (tableMatch.kind === "POOL") updateDraft(tableMatch.match.id, patch);
                  else updateBracketDraft(tableMatch.match.id, patch);
                }}
                onAddHand={() => {
                  if (tableMatch.kind === "POOL") addOrSaveHand(tableMatch.match.id);
                  else addOrSaveBracketHand(tableMatch.match.id);
                }}
                onClearHands={() => {
                  if (tableMatch.kind === "POOL") clearMatchHands(tableMatch.match.id);
                  else clearBracketHands(tableMatch.match.id);
                }}
                onStartEditHand={(handIdx) => {
                  if (tableMatch.kind === "POOL") startEditHand(tableMatch.match.id, handIdx);
                  else startEditBracketHand(tableMatch.match.id, handIdx);
                }}
                onCancelEdit={() => {
                  if (tableMatch.kind === "POOL") cancelEditHand(tableMatch.match.id);
                  else cancelEditBracket(tableMatch.match.id);
                }}
              />
            </Section>
          )}

          <Section title="Live Scoreboard (read-only)">
            <ScoreboardTable rows={scoreboardRows} />
          </Section>

          <Section title="Public View Link">
            <a href={publicLink} style={{ ...styles.btnSecondary, textDecoration: "none" }}>
              Open Public View
            </a>
          </Section>
        </div>
      </div>
    );
  }

  /** ===== Admin View ===== */
  return (
    <div style={styles.page}>
      <div style={styles.container}>
        <div style={styles.topbar}>
          <div>
            <h1 style={styles.title}>{tournamentName}</h1>
            <div style={styles.subtitle}>
              Admin • Setup teams • Create schedule • Share Public/Table links • Export CSV
            </div>
          </div>
          <NavPills showAdmin={false} />
        </div>

        <Section
          title="Quick Links"
          right={
            <div style={styles.row}>
              <a href="#/public" style={{ ...styles.btnSecondary, textDecoration: "none" }}>
                Public View
              </a>
              <button style={styles.btnSecondary} onClick={exportCSV}>
                Export CSV (Excel)
              </button>
              <button
                style={styles.btnSecondary}
                onClick={() => {
                  navigator.clipboard?.writeText(publicLink);
                  alert("Public link copied!");
                }}
              >
                Copy Public Link
              </button>
            </div>
          }
        >
          <div style={styles.small}>
            Public: <span style={{ color: "#e5e7eb" }}>{publicLink}</span>
          </div>
        </Section>

        <Section
          title="Timer Controls (shown on Public + Table)"
          right={<span style={styles.tag}>Game: {GAME_MIN} min • Break: {BREAK_MIN} min</span>}
        >
          <PublicTimerPanel
            timerMode={timerMode}
            timerRunning={timerRunning}
            timerSeconds={timerSeconds}
            onStart={() => setTimerRunning(true)}
            onPause={() => setTimerRunning(false)}
            onResetGame={() => {
              setTimerRunning(false);
              setTimerMode("GAME");
              setTimerSeconds(GAME_MIN * 60);
            }}
            onStartBreak={() => {
              setTimerRunning(false);
              setTimerMode("BREAK");
              setTimerSeconds(BREAK_MIN * 60);
            }}
          />
        </Section>

        <Section
          title="Settings"
          right={
            <div style={styles.row}>
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 900 }}>
                <input type="checkbox" checked={avoidSameTeams} onChange={(e) => setAvoidSameTeams(e.target.checked)} />
                Avoid repeating pairs
              </label>
              <button style={styles.btnSecondary} onClick={resetTournamentStructure} disabled={!matches.length && !bracket.length}>
                Reset Tournament (keep teams)
              </button>
              <button style={styles.btnDanger} onClick={fullReset}>
                Full Reset
              </button>
            </div>
          }
        >
          <div style={styles.grid4}>
            <div style={styles.card}>
              <div style={styles.small}>Tournament name</div>
              <input style={styles.input("100%")} value={tournamentName} onChange={(e) => setTournamentName(e.target.value)} />
            </div>

            <div style={styles.card}>
              <div style={styles.small}>Win threshold</div>
              <input style={styles.input(140)} value={String(winThreshold)} onChange={(e) => setWinThreshold(Math.max(0, Number(e.target.value || 0)))} />
              <div style={styles.small}>Win ≥ threshold gives {winHighPts} pts</div>
            </div>

            <div style={styles.card}>
              <div style={styles.small}>Win ≥ threshold</div>
              <input style={styles.input(140)} value={String(winHighPts)} onChange={(e) => setWinHighPts(Math.max(0, Number(e.target.value || 0)))} />
              <div style={styles.small}>Match points for big win</div>
            </div>

            <div style={styles.card}>
              <div style={styles.small}>Win &lt; threshold</div>
              <input style={styles.input(140)} value={String(winLowPts)} onChange={(e) => setWinLowPts(Math.max(0, Number(e.target.value || 0)))} />
              <div style={styles.small}>Match points for small win</div>
            </div>
          </div>

          <div style={{ marginTop: 10, ...styles.small }}>
            Tiebreaker for standings = total game points.
          </div>
        </Section>

        <Section title={`Players (${players.length})`}>
          <div style={styles.row}>
            <input
              ref={inputRef}
              style={styles.input(320)}
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
            <button style={styles.btnSecondary} onClick={ensureEightTeamsSkeleton}>
              Create 8 Team Slots
            </button>
            <button style={styles.btnSecondary} onClick={buildRandomTeams} disabled={players.length < 2}>
              Randomize Teams (respects locks)
            </button>
          </div>

          <div style={{ marginTop: 12, ...styles.grid4 }}>
            {players.map((p) => (
              <div key={p.id} style={styles.card}>
                <div style={{ fontWeight: 950, display: "flex", justifyContent: "space-between", gap: 10 }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
                  <button style={{ ...styles.btnGhost, padding: 0 }} onClick={() => removePlayer(p.id)}>
                    Remove
                  </button>
                </div>
                <div style={styles.small}>ID: {p.id.slice(-6)}</div>
              </div>
            ))}
            {players.length === 0 ? <div style={styles.small}>Add players to get started (16 players recommended for 8 teams).</div> : null}
          </div>
        </Section>

        <Section
          title={`Teams (${teams.length}/8)`}
          right={
            <span style={styles.tag}>
              Exactly 8 teams required • {teams.length === 8 ? "Ready" : "Not ready"}
            </span>
          }
        >
          {teams.length !== 8 ? (
            <div style={styles.small}>
              Click <b>Create 8 Team Slots</b> then assign players manually or randomize.
            </div>
          ) : (
            <>
              <div style={{ ...styles.small, marginBottom: 10 }}>
                Manual assignment: pick players for each team (prevents overlap). Use <b>Lock</b> to keep a team fixed when randomizing.
              </div>

              <div style={styles.grid2}>
                {teams.map((t, idx) => (
                  <div key={t.id} style={styles.card}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                      <div style={{ fontWeight: 950 }}>
                        Team #{idx + 1}
                      </div>
                      <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 900, color: t.locked ? "#34d399" : "#94a3b8" }}>
                        <input type="checkbox" checked={!!t.locked} onChange={(e) => toggleTeamLock(t.id, e.target.checked)} />
                        Lock
                      </label>
                    </div>

                    <div style={{ marginTop: 10 }}>
                      <div style={styles.small}>Team name</div>
                      <input
                        style={styles.input("100%")}
                        value={t.name}
                        onChange={(e) => renameTeam(t.id, e.target.value)}
                        placeholder={`Team ${idx + 1}`}
                      />
                    </div>

                    <div style={{ marginTop: 10, ...styles.grid2 }}>
                      <div>
                        <div style={styles.small}>Player 1</div>
                        <select
                          style={styles.select("100%")}
                          value={t.playerIds?.[0] || ""}
                          onChange={(e) => setTeamPlayer(t.id, 0, e.target.value)}
                        >
                          <option value="">— Select —</option>
                          {players.map((p) => {
                            const taken = usedPlayerIds.has(p.id) && !(t.playerIds || []).includes(p.id);
                            return (
                              <option key={p.id} value={p.id} disabled={taken}>
                                {p.name}{taken ? " (used)" : ""}
                              </option>
                            );
                          })}
                        </select>
                      </div>

                      <div>
                        <div style={styles.small}>Player 2</div>
                        <select
                          style={styles.select("100%")}
                          value={t.playerIds?.[1] || ""}
                          onChange={(e) => setTeamPlayer(t.id, 1, e.target.value)}
                        >
                          <option value="">— Select —</option>
                          {players.map((p) => {
                            const taken = usedPlayerIds.has(p.id) && !(t.playerIds || []).includes(p.id);
                            return (
                              <option key={p.id} value={p.id} disabled={taken}>
                                {p.name}{taken ? " (used)" : ""}
                              </option>
                            );
                          })}
                        </select>
                      </div>
                    </div>

                    <div style={{ marginTop: 10, ...styles.small }}>
                      Members: {(t.playerIds || []).map((pid) => playerById.get(pid)?.name).filter(Boolean).join(" / ") || "—"}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </Section>

        <Section
          title="Tournament Builder (8 teams)"
          right={
            <div style={styles.row}>
              <button style={styles.btnPrimary} onClick={createPoolsRoundRobin8} disabled={!exactly8Teams}>
                Create Pools + Round Robin
              </button>
              <button style={styles.btnSecondary} onClick={createBracketFromPools} disabled={poolStandings.A.length < 4 || poolStandings.B.length < 4}>
                Create Bracket
              </button>
            </div>
          }
        >
          <div style={styles.grid2}>
            <div style={styles.card}>
              <div style={{ fontWeight: 950, marginBottom: 8 }}>Pool A (Teams 1–4)</div>
              <div style={styles.small}>
                {(poolMap.A || []).map((id) => teamById.get(id)?.name).filter(Boolean).join(" • ") || "Not created yet"}
              </div>
              <div style={{ marginTop: 10, fontWeight: 900 }}>Standings</div>
              <StandingsList rows={poolStandings.A} />
            </div>

            <div style={styles.card}>
              <div style={{ fontWeight: 950, marginBottom: 8 }}>Pool B (Teams 5–8)</div>
              <div style={styles.small}>
                {(poolMap.B || []).map((id) => teamById.get(id)?.name).filter(Boolean).join(" • ") || "Not created yet"}
              </div>
              <div style={{ marginTop: 10, fontWeight: 900 }}>Standings</div>
              <StandingsList rows={poolStandings.B} />
            </div>
          </div>

          <div style={{ marginTop: 12, ...styles.small }}>
            Tables for pool play: Pool A uses Tables 1–2, Pool B uses Tables 3–4.
          </div>
        </Section>

        <Section title="Pool Matches (Admin can also edit)">
          {!matches.length ? (
            <div style={styles.small}>No matches yet. Click “Create Pools + Round Robin”.</div>
          ) : (
            <PoolMatchesAdmin
              matches={matches}
              teamById={teamById}
              teamNumberById={teamNumberById}
              onDraftPatch={updateDraft}
              onAddHand={addOrSaveHand}
              onClearHands={clearMatchHands}
              onStartEditHand={startEditHand}
              onCancelEdit={cancelEditHand}
            />
          )}
        </Section>

        <Section title="Bracket (Admin can also edit)">
          {!bracket.length ? (
            <div style={styles.small}>No bracket yet. Click “Create Bracket”.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <VisualBracket bracket={bracket} teamById={teamById} onOpenTable={(code) => (window.location.hash = `#/table?code=${code}`)} />

              <div style={styles.grid2}>
                {bracket
                  .slice()
                  .sort((a, b) => {
                    const ord = { QF: 1, SF: 2, F: 3, "3P": 4 };
                    return (ord[a.roundTag] || 99) - (ord[b.roundTag] || 99) || (a.idx || 0) - (b.idx || 0);
                  })
                  .map((m) => (
                    <div key={m.id} style={styles.card}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
                        <div style={{ fontWeight: 950 }}>{m.label} <span style={styles.small}>({m.roundTag})</span></div>
                        <div style={{ color: m.completed ? "#34d399" : "#94a3b8", fontWeight: 950 }}>
                          {m.completed ? `Winner: ${teamById.get(m.winnerId)?.name ?? "—"}` : "In progress"}
                        </div>
                      </div>

                      <div style={{ marginTop: 10 }}>
                        <TableMatchPanel
                          match={m}
                          kind="BRACKET"
                          teamById={teamById}
                          teamNumberById={teamNumberById}
                          onDraftPatch={(patch) => updateBracketDraft(m.id, patch)}
                          onAddHand={() => addOrSaveBracketHand(m.id)}
                          onClearHands={() => clearBracketHands(m.id)}
                          onStartEditHand={(handIdx) => startEditBracketHand(m.id, handIdx)}
                          onCancelEdit={() => cancelEditBracket(m.id)}
                        />
                      </div>
                    </div>
                  ))}
              </div>

              <div style={styles.grid3}>
                <PodiumCard label="Champion" value={winnerBoard.champion} />
                <PodiumCard label="Runner-up" value={winnerBoard.runnerUp} />
                <PodiumCard label="3rd Place" value={winnerBoard.third} />
              </div>
            </div>
          )}
        </Section>

        <Section title="Scoreboard + Stats (Live)">
          <div style={styles.grid2}>
            <div style={styles.card}>
              <div style={{ fontWeight: 950, marginBottom: 8 }}>Live Scoreboard (Pool)</div>
              <ScoreboardTable rows={scoreboardRows} />
            </div>
            <div style={styles.card}>
              <div style={{ fontWeight: 950, marginBottom: 8 }}>Stats</div>
              <div style={styles.grid3}>
                <StatCard label="Completed Pool Games" value={globalStats.completedPoolGames} />
                <StatCard label="Completed Bracket Games" value={globalStats.completedBracketGames} />
                <StatCard label="Total Hands Played" value={globalStats.totalHands} />
                <StatCard label="Coinche King" value={globalStats.funny.coincheKing.name} sub={`${globalStats.funny.coincheKing.v} coinches`} />
                <StatCard label="Capot Hero" value={globalStats.funny.capotHero.name} sub={`${globalStats.funny.capotHero.v} capots`} />
                <StatCard label="Biggest Hand Swing" value={`${globalStats.biggestHand.pts}`} sub={globalStats.biggestHand.label} />
              </div>
            </div>
          </div>
        </Section>

        <Section title="Table Links (share to each table)">
          <div style={styles.small}>
            Each match has a unique code + link. Teams should open their match link to enter hands.
          </div>
          <div style={{ marginTop: 10, ...styles.grid3 }}>
            {tableLinks.map((t) => (
              <div key={t.code} style={styles.card}>
                <div style={{ fontWeight: 950, marginBottom: 6 }}>{t.label}</div>
                <div style={styles.small}>Code: {t.code}</div>
                <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <a href={t.href} style={{ ...styles.btnSecondary, textDecoration: "none" }}>
                    Open
                  </a>
                  <button
                    style={styles.btnSecondary}
                    onClick={() => {
                      navigator.clipboard?.writeText(t.href);
                      alert(`Copied link for ${t.label}`);
                    }}
                  >
                    Copy Link
                  </button>
                </div>
              </div>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}

/** ===== Components ===== */

function Section({ title, right, children }) {
  return (
    <div style={styles.section}>
      <div style={styles.sectionHeader}>
        <h2 style={styles.h2}>{title}</h2>
        <div>{right}</div>
      </div>
      {children}
    </div>
  );
}

function PodiumCard({ label, value }) {
  return (
    <div style={styles.card}>
      <div style={styles.small}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 950 }}>{value ?? "—"}</div>
    </div>
  );
}

function StatCard({ label, value, sub }) {
  return (
    <div style={styles.card}>
      <div style={styles.small}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 950 }}>{value ?? "—"}</div>
      {sub ? <div style={{ marginTop: 6, ...styles.small }}>{sub}</div> : null}
    </div>
  );
}

function ScoreboardTable({ rows }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
        <thead>
          <tr>
            {["Rank", "Team", "Pool", "Pts", "W", "L", "Game Pts"].map((h) => (
              <th key={h} style={{ textAlign: "left", padding: "10px 10px", fontSize: 12, color: "#94a3b8", borderBottom: "1px solid rgba(148,163,184,0.18)" }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.teamId}>
              <td style={{ padding: "10px 10px", borderBottom: "1px solid rgba(148,163,184,0.10)", fontWeight: 950 }}>#{i + 1}</td>
              <td style={{ padding: "10px 10px", borderBottom: "1px solid rgba(148,163,184,0.10)", fontWeight: 900 }}>{r.name}</td>
              <td style={{ padding: "10px 10px", borderBottom: "1px solid rgba(148,163,184,0.10)", color: "#94a3b8", fontWeight: 900 }}>{r.pool}</td>
              <td style={{ padding: "10px 10px", borderBottom: "1px solid rgba(148,163,184,0.10)", fontWeight: 950 }}>{r.matchPoints}</td>
              <td style={{ padding: "10px 10px", borderBottom: "1px solid rgba(148,163,184,0.10)", fontWeight: 900 }}>{r.wins}</td>
              <td style={{ padding: "10px 10px", borderBottom: "1px solid rgba(148,163,184,0.10)", fontWeight: 900 }}>{r.losses}</td>
              <td style={{ padding: "10px 10px", borderBottom: "1px solid rgba(148,163,184,0.10)", fontWeight: 900 }}>{r.totalGamePoints}</td>
            </tr>
          ))}
          {rows.length === 0 ? (
            <tr>
              <td colSpan={7} style={{ padding: 12, color: "#94a3b8" }}>
                No data yet.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function StandingsList({ rows }) {
  if (!rows.length) return <div style={styles.small}>No standings yet.</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
      {rows.map((s, idx) => (
        <div key={s.teamId} style={{ ...styles.card, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 950, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              #{idx + 1} {s.name}
            </div>
            <div style={styles.small}>Tiebreak: {s.totalGamePoints} pts</div>
          </div>
          <div style={{ fontWeight: 950 }}>Pts: {s.matchPoints}</div>
        </div>
      ))}
    </div>
  );
}

function PublicTimerPanel({ timerMode, timerRunning, timerSeconds, onStart, onPause, onResetGame, onStartBreak }) {
  return (
    <Section
      title="Tournament Timer"
      right={
        <span style={styles.tag}>
          {timerMode === "GAME" ? "Game" : "Break"} • {fmtMMSS(timerSeconds)} {timerRunning ? "▶" : "⏸"}
        </span>
      }
    >
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <button style={styles.btnPrimary} onClick={onStart} disabled={timerRunning || timerSeconds <= 0}>
          Start
        </button>
        <button style={styles.btnSecondary} onClick={onPause} disabled={!timerRunning}>
          Pause
        </button>
        <button style={styles.btnSecondary} onClick={onResetGame}>
          Reset Game ({GAME_MIN}m)
        </button>
        <button style={styles.btnSecondary} onClick={onStartBreak}>
          Start Break ({BREAK_MIN}m)
        </button>
      </div>
      <div style={{ marginTop: 10, color: "#94a3b8", fontSize: 12 }}>
        Start time is {START_TIME}. Games are {GAME_MIN} minutes with {BREAK_MIN} minutes pause. (Timer does not auto-start.)
      </div>
    </Section>
  );
}

function PoolMatchesAdmin({ matches, teamById, teamNumberById, onDraftPatch, onAddHand, onClearHands, onStartEditHand, onCancelEdit }) {
  const byPool = {
    A: matches.filter((m) => m.pool === "A").sort((a, b) => (a.round || 0) - (b.round || 0) || (a.table || 0) - (b.table || 0)),
    B: matches.filter((m) => m.pool === "B").sort((a, b) => (a.round || 0) - (b.round || 0) || (a.table || 0) - (b.table || 0)),
  };

  const roundsA = Array.from(new Set(byPool.A.map((m) => m.round))).sort((a, b) => a - b);
  const roundsB = Array.from(new Set(byPool.B.map((m) => m.round))).sort((a, b) => a - b);

  return (
    <div style={styles.grid2}>
      <div style={styles.card}>
        <div style={{ fontWeight: 950 }}>Pool A Matches</div>
        {roundsA.length === 0 ? <div style={styles.small}>No matches</div> : null}
        {roundsA.map((r) => (
          <div key={`A${r}`} style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 900, marginBottom: 8 }}>Round {r}</div>
            {byPool.A.filter((m) => m.round === r).map((m) => (
              <div key={m.id} style={{ marginBottom: 12 }}>
                <TableMatchPanel
                  match={m}
                  kind="POOL"
                  teamById={teamById}
                  teamNumberById={teamNumberById}
                  onDraftPatch={(patch) => onDraftPatch(m.id, patch)}
                  onAddHand={() => onAddHand(m.id)}
                  onClearHands={() => onClearHands(m.id)}
                  onStartEditHand={(handIdx) => onStartEditHand(m.id, handIdx)}
                  onCancelEdit={() => onCancelEdit(m.id)}
                />
                <div style={{ marginTop: 8, ...styles.small }}>
                  Table link code: <b style={{ color: "#e5e7eb" }}>{m.code}</b>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div style={styles.card}>
        <div style={{ fontWeight: 950 }}>Pool B Matches</div>
        {roundsB.length === 0 ? <div style={styles.small}>No matches</div> : null}
        {roundsB.map((r) => (
          <div key={`B${r}`} style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 900, marginBottom: 8 }}>Round {r}</div>
            {byPool.B.filter((m) => m.round === r).map((m) => (
              <div key={m.id} style={{ marginBottom: 12 }}>
                <TableMatchPanel
                  match={m}
                  kind="POOL"
                  teamById={teamById}
                  teamNumberById={teamNumberById}
                  onDraftPatch={(patch) => onDraftPatch(m.id, patch)}
                  onAddHand={() => onAddHand(m.id)}
                  onClearHands={() => onClearHands(m.id)}
                  onStartEditHand={(handIdx) => onStartEditHand(m.id, handIdx)}
                  onCancelEdit={() => onCancelEdit(m.id)}
                />
                <div style={{ marginTop: 8, ...styles.small }}>
                  Table link code: <b style={{ color: "#e5e7eb" }}>{m.code}</b>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function VisualBracket({ bracket, teamById, onOpenTable }) {
  // display by rounds
  const qf = bracket.filter((m) => m.roundTag === "QF").sort((a, b) => (a.idx || 0) - (b.idx || 0));
  const sf = bracket.filter((m) => m.roundTag === "SF").sort((a, b) => (a.idx || 0) - (b.idx || 0));
  const f = bracket.find((m) => m.roundTag === "F");
  const p3 = bracket.find((m) => m.roundTag === "3P");

  const MatchMini = ({ m }) => (
    <div style={styles.card}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <div style={{ fontWeight: 950 }}>
          {m.label} <span style={styles.small}>Code {m.code}</span>
        </div>
        <button style={styles.btnSecondary} onClick={() => onOpenTable(m.code)}>
          Open Table
        </button>
      </div>

      <div style={{ marginTop: 10 }}>
        <div style={{ fontWeight: 900 }}>{teamById.get(m.teamAId)?.name ?? "TBD"}</div>
        <div style={{ fontWeight: 900 }}>{teamById.get(m.teamBId)?.name ?? "TBD"}</div>
      </div>

      <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <span style={styles.tag}>Score: {m.totalA} – {m.totalB}</span>
        <span style={{ ...styles.tag, background: m.completed ? "rgba(34,197,94,0.12)" : "rgba(148,163,184,0.12)" }}>
          {m.completed ? `Winner: ${teamById.get(m.winnerId)?.name ?? "—"}` : "In progress"}
        </span>
      </div>
    </div>
  );

  return (
    <div style={styles.bracketGrid}>
      <div>
        <div style={{ fontWeight: 950, marginBottom: 10 }}>Quarterfinals</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {qf.map((m) => <MatchMini key={m.id} m={m} />)}
        </div>
      </div>

      <div>
        <div style={{ fontWeight: 950, marginBottom: 10 }}>Semifinals</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {sf.map((m) => <MatchMini key={m.id} m={m} />)}
        </div>
      </div>

      <div>
        <div style={{ fontWeight: 950, marginBottom: 10 }}>Final</div>
        {f ? <MatchMini m={f} /> : <div style={styles.small}>—</div>}

        <div style={{ fontWeight: 950, margin: "16px 0 10px" }}>3rd Place</div>
        {p3 ? <MatchMini m={p3} /> : <div style={styles.small}>—</div>}
      </div>
    </div>
  );
}

function TableMatchPanel({
  match,
  kind, // "POOL"|"BRACKET"
  teamById,
  teamNumberById,
  onDraftPatch,
  onAddHand,
  onClearHands,
  onStartEditHand,
  onCancelEdit,
}) {
  const ta = teamById.get(match.teamAId)?.name ?? "TBD";
  const tb = teamById.get(match.teamBId)?.name ?? "TBD";

  const numA = match.teamAId ? teamNumberById?.get(match.teamAId) ?? "?" : "?";
  const numB = match.teamBId ? teamNumberById?.get(match.teamBId) ?? "?" : "?";

  const pctA = Math.min(100, Math.round(((match.totalA || 0) / TARGET_SCORE) * 100));
  const pctB = Math.min(100, Math.round(((match.totalB || 0) / TARGET_SCORE) * 100));

  const d = match.fastDraft || {
    bidder: "A",
    bid: "",
    suit: "S",
    coincheLevel: "NONE",
    capot: false,
    bidderTrickPoints: "",
    announceA: "0",
    announceB: "0",
    beloteTeam: "NONE",
  };

  const canPlay = !!match.teamAId && !!match.teamBId;

  return (
    <div style={{ ...styles.card, borderRadius: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
        <div style={{ fontWeight: 950 }}>
          {match.label}
          {match.table ? <span style={styles.small}> • Table {match.table}</span> : null}
          {match.pool ? <span style={styles.small}> • Pool {match.pool}</span> : null}
        </div>
        <div style={{ color: match.completed ? "#34d399" : "#94a3b8", fontWeight: 950 }}>
          {match.completed ? `Winner: ${teamById.get(match.winnerId)?.name ?? "—"}` : "Live"}
        </div>
      </div>

      <div style={{ marginTop: 10, ...styles.grid2 }}>
        <div style={styles.card}>
          <div style={{ fontWeight: 900, marginBottom: 6 }}>{`Team #${numA}: ${ta}`}</div>
          <div style={styles.small}>Total: <b style={{ color: "#e5e7eb" }}>{match.totalA}</b> / {TARGET_SCORE}</div>
          <div style={{ marginTop: 8, ...styles.progressWrap }}>
            <div style={styles.progressFillA(pctA)} />
          </div>
        </div>

        <div style={styles.card}>
          <div style={{ fontWeight: 900, marginBottom: 6 }}>{`Team #${numB}: ${tb}`}</div>
          <div style={styles.small}>Total: <b style={{ color: "#e5e7eb" }}>{match.totalB}</b> / {TARGET_SCORE}</div>
          <div style={{ marginTop: 8, ...styles.progressWrap }}>
            <div style={styles.progressFillB(pctB)} />
          </div>
        </div>
      </div>

      <div style={{ marginTop: 10, ...styles.small }}>
        End immediately at <b style={{ color: "#e5e7eb" }}>{TARGET_SCORE}</b>. Add hands until one team reaches 2000+.
      </div>

      {/* Hand Tracker form */}
      <div style={{ marginTop: 14, borderTop: "1px solid rgba(148,163,184,0.18)", paddingTop: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
          <div style={{ fontWeight: 950 }}>Hand Tracker</div>
          {match.editingHandIdx ? (
            <span style={styles.tag}>Editing Hand {match.editingHandIdx}</span>
          ) : (
            <span style={styles.tag}>New Hand</span>
          )}
        </div>

        <div style={styles.handGrid}>
          <div>
            <div style={styles.small}>Bidder</div>
            <select
              style={styles.select("100%")}
              value={d.bidder}
              onChange={(e) => onDraftPatch({ bidder: e.target.value })}
              disabled={!canPlay}
            >
              <option value="A">{`Team #${numA} — ${ta}`}</option>
              <option value="B">{`Team #${numB} — ${tb}`}</option>
            </select>
          </div>

          <div>
            <div style={styles.small}>Bid</div>
            <input
              style={styles.input("100%")}
              value={d.bid}
              onChange={(e) => onDraftPatch({ bid: e.target.value })}
              placeholder="80, 90, 110..."
              inputMode="numeric"
              disabled={!canPlay}
            />
          </div>

          <div>
            <div style={styles.small}>Suit</div>
            <select
              style={styles.select("100%")}
              value={d.suit || "S"}
              onChange={(e) => onDraftPatch({ suit: e.target.value })}
              disabled={!canPlay}
            >
              <option value="H">♥ Hearts</option>
              <option value="D">♦ Diamonds</option>
              <option value="C">♣ Clubs</option>
              <option value="S">♠ Spades</option>
            </select>
          </div>

          <div>
            <div style={styles.small}>Coinche</div>
            <select
              style={styles.select("100%")}
              value={d.coincheLevel}
              onChange={(e) => onDraftPatch({ coincheLevel: e.target.value })}
              disabled={!canPlay}
            >
              <option value="NONE">None</option>
              <option value="COINCHE">Coinche (x2)</option>
              <option value="SURCOINCHE">Surcoinche (x4)</option>
            </select>
          </div>

          <div>
            <div style={styles.small}>Capot</div>
            <select
              style={styles.select("100%")}
              value={d.capot ? "YES" : "NO"}
              onChange={(e) => onDraftPatch({ capot: e.target.value === "YES" })}
              disabled={!canPlay}
            >
              <option value="NO">No</option>
              <option value="YES">Yes</option>
            </select>
          </div>

          <div>
            <div style={styles.small}>Bidder trick points (0–162)</div>
            <input
              style={styles.input("100%")}
              value={d.bidderTrickPoints}
              onChange={(e) => onDraftPatch({ bidderTrickPoints: e.target.value })}
              placeholder="ex: 81"
              inputMode="numeric"
              disabled={!canPlay}
            />
          </div>

          <div>
            <div style={styles.small}>Announces Team A (non-belote)</div>
            <input
              style={styles.input("100%")}
              value={d.announceA}
              onChange={(e) => onDraftPatch({ announceA: e.target.value })}
              inputMode="numeric"
              disabled={!canPlay}
            />
          </div>

          <div>
            <div style={styles.small}>Announces Team B (non-belote)</div>
            <input
              style={styles.input("100%")}
              value={d.announceB}
              onChange={(e) => onDraftPatch({ announceB: e.target.value })}
              inputMode="numeric"
              disabled={!canPlay}
            />
          </div>

          <div>
            <div style={styles.small}>Belote</div>
            <select
              style={styles.select("100%")}
              value={d.beloteTeam}
              onChange={(e) => onDraftPatch({ beloteTeam: e.target.value })}
              disabled={!canPlay}
            >
              <option value="NONE">None</option>
              <option value="A">{`Team #${numA}`}</option>
              <option value="B">{`Team #${numB}`}</option>
            </select>
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12, alignItems: "center" }}>
          <button style={{ ...styles.btnPrimary, ...(canPlay ? {} : styles.disabled) }} onClick={onAddHand} disabled={!canPlay}>
            {match.editingHandIdx ? `Save Changes (Hand ${match.editingHandIdx})` : "Add Hand"}
          </button>

          {match.editingHandIdx ? (
            <button style={styles.btnSecondary} onClick={onCancelEdit}>
              Cancel Edit
            </button>
          ) : null}

          <button style={styles.btnSecondary} onClick={onClearHands}>
            Clear Match Hands
          </button>

          <span style={{ ...styles.small, marginLeft: "auto" }}>
            Suit: <SuitIcon suit={d.suit || "S"} />{" "}
            {d.suit === "H" ? "Hearts" : d.suit === "D" ? "Diamonds" : d.suit === "C" ? "Clubs" : "Spades"}
          </span>
        </div>
      </div>

      {/* Hands list */}
      <div style={{ marginTop: 14 }}>
        <div style={{ fontWeight: 950, marginBottom: 10 }}>Hands Played</div>
        {(match.hands || []).length === 0 ? (
          <div style={styles.small}>No hands yet.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {(match.hands || []).map((h) => {
              const ds = h.draftSnapshot || {};
              return (
                <div key={h.idx} style={styles.handRow}>
                  <div style={{ minWidth: 180 }}>
                    <div style={{ fontWeight: 950 }}>Hand {h.idx}</div>
                    <div style={styles.small}>
                      Bid {ds.bid} <SuitIcon suit={ds.suit || "S"} /> • Bidder {ds.bidder} • {ds.coincheLevel}
                      {ds.capot ? " • Capot" : ""} • Tricks {ds.bidderTrickPoints}
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={styles.tag}>
                      +{h.scoreA} / +{h.scoreB}
                    </span>
                    <button style={styles.btnSecondary} onClick={() => onStartEditHand(h.idx)}>
                      Edit
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {kind === "POOL" ? (
        <div style={{ marginTop: 12, ...styles.small }}>
          Pool match points are calculated automatically when a winner is declared.
        </div>
      ) : (
        <div style={{ marginTop: 12, ...styles.small }}>
          Bracket winners advance automatically when a match is finished.
        </div>
      )}
    </div>
  );
}