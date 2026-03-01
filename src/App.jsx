import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Coinche Scorekeeper (Vite single-file App.jsx)
 * - Admin view / Public view / Table view
 * - Unlimited players/teams/matches
 * - Fast-mode hand tracker
 * - Winner celebration: confetti + fireworks (3 seconds)
 * - Google Sheets backup: APPENDS ONE ROW PER HAND (matches your Apps Script doPost)
 *
 * Routes:
 *   #/admin
 *   #/public
 *   #/table?code=AB12
 */

const LS_KEY = "coinche_scorekeeper_v1";
const TARGET_SCORE = 2000;

// Your Google Apps Script Web App endpoint:
const BACKUP_URL =
  "https://script.google.com/macros/s/AKfycbz-ok_dxCTExzV6LA8NixK6nYnw03MhOBZ3M6SgP_Na5-hlrhnMLX3bIUYqqq5laguSHw/exec";

// MUST match your Apps Script SECRET:
const BACKUP_SECRET = "CHANGE_ME_TO_A_LONG_RANDOM_STRING";

// Celebration duration
const CELEBRATION_MS = 3000;

// Local device id (helps you debug rows)
const DEVICE_ID_KEY = "coinche_device_id_v1";

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

/** ===== Global CSS (confetti + fireworks) ===== */
function ensureGlobalCSS() {
  if (typeof document === "undefined") return;
  if (document.getElementById("coinche_global_css")) return;
  const el = document.createElement("style");
  el.id = "coinche_global_css";
  el.innerHTML = `
@keyframes confettiDrop {
  0%   { transform: translateY(0) rotate(0deg); opacity: 1; }
  100% { transform: translateY(320px) rotate(280deg); opacity: 0; }
}

@keyframes fireworkRise {
  0%   { transform: translate(-50%, 0) scale(0.9); opacity: 0.0; }
  12%  { opacity: 1; }
  55%  { transform: translate(-50%, -90px) scale(1.0); opacity: 1; }
  100% { transform: translate(-50%, -120px) scale(1.0); opacity: 0; }
}

@keyframes sparkBurst {
  0%   { transform: translate(0,0) scale(1); opacity: 1; }
  70%  { opacity: 1; }
  100% { transform: translate(var(--dx), var(--dy)) scale(0.7); opacity: 0; }
}
`;
  document.head.appendChild(el);
}

/** ===== Fast mode scoring helpers ===== */
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

  const bidderHasBelote =
    (BIDDER_IS_A && beloteTeam === "A") || (!BIDDER_IS_A && beloteTeam === "B");
  const baseMin = bidderHasBelote ? 71 : 81;
  const special80 = bidVal === 80 ? 81 : 0;

  const announceHelp = bidderAnn + (bidderHasBelote ? 20 : 0);
  const required = Math.max(baseMin, special80, bidVal - announceHelp);

  const bidderSucceeded = capot ? true : rawBidder >= required;

  const mult =
    coincheLevel === "SURCOINCHE" ? 4 : coincheLevel === "COINCHE" ? 2 : 1;
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
  container: {
    width: "100%",
    maxWidth: "none",
    margin: "0",
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },
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
  section: {
    background: "rgba(2,6,23,0.55)",
    border: "1px solid rgba(148,163,184,0.18)",
    borderRadius: 18,
    padding: 14,
    boxShadow: "0 12px 40px rgba(0,0,0,0.25)",
  },
  sectionHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: 10,
    flexWrap: "wrap",
    marginBottom: 10,
  },
  h2: { margin: 0, fontSize: 16, fontWeight: 900, letterSpacing: "-0.01em" },
  small: { fontSize: 12, color: "#94a3b8" },

  btnPrimary: {
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(99,102,241,0.35)",
    background:
      "linear-gradient(180deg, rgba(99,102,241,0.95), rgba(79,70,229,0.9))",
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
    background:
      "linear-gradient(180deg, rgba(244,63,94,0.95), rgba(190,18,60,0.9))",
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
    background: "rgba(255,255,255,0.92)",
    color: "#0b1220",
    outline: "none",
    boxSizing: "border-box",
    minWidth: 0,
    display: "block",
    fontWeight: 700,
  }),
  select: (w = 180) => ({
    width: typeof w === "number" ? `${w}px` : w,
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(148,163,184,0.22)",
    background: "rgba(255,255,255,0.92)",
    color: "#0b1220",
    outline: "none",
    boxSizing: "border-box",
    minWidth: 0,
    display: "block",
    fontWeight: 800,
  }),

  grid2: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
    gap: 12,
  },
  grid3: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
    gap: 12,
  },
  grid4: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
    gap: 12,
  },
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
    background:
      "linear-gradient(90deg, rgba(34,197,94,0.95), rgba(16,185,129,0.9))",
  }),
  progressFillB: (pct) => ({
    height: "100%",
    width: `${pct}%`,
    background:
      "linear-gradient(90deg, rgba(99,102,241,0.95), rgba(59,130,246,0.9))",
  }),

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

  leaderGlow: {
    boxShadow:
      "0 0 20px rgba(34,197,94,0.35), 0 0 50px rgba(34,197,94,0.18)",
    border: "1px solid rgba(34,197,94,0.35)",
  },

  winnerGlow: {
    boxShadow:
      "0 0 28px rgba(34,197,94,0.55), 0 0 90px rgba(34,197,94,0.28), 0 0 140px rgba(34,197,94,0.16)",
    border: "2px solid rgba(34,197,94,0.55)",
  },

  trophyBadge: {
    position: "absolute",
    top: 10,
    right: 10,
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 10px",
    borderRadius: 999,
    background: "rgba(34,197,94,0.18)",
    border: "1px solid rgba(34,197,94,0.40)",
    color: "#eafff3",
    fontWeight: 1000,
    letterSpacing: "-0.02em",
    zIndex: 4,
  },

  trophyCircle: {
    width: 26,
    height: 26,
    borderRadius: 999,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(34,197,94,0.25)",
    border: "1px solid rgba(34,197,94,0.45)",
    fontWeight: 1000,
  },

  confettiWrap: {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    overflow: "hidden",
    borderRadius: 18,
    zIndex: 2,
  },

  confettiPiece: (i) => ({
    position: "absolute",
    left: `${(i * 11) % 100}%`,
    top: "-12px",
    width: `${6 + ((i * 7) % 6)}px`,
    height: `${10 + ((i * 5) % 10)}px`,
    borderRadius: 3,
    background: `hsla(${(i * 37) % 360}, 90%, 60%, 0.95)`,
    transform: `rotate(${(i * 23) % 180}deg)`,
    animation: `confettiDrop ${CELEBRATION_MS}ms ease-out forwards`,
    animationDelay: `${(i % 10) * 25}ms`,
    opacity: 0.95,
  }),

  fireworksWrap: {
    position: "absolute",
    left: "50%",
    top: "-8px",
    transform: "translateX(-50%)",
    pointerEvents: "none",
    width: "200px",
    height: "140px",
    zIndex: 3,
    overflow: "visible",
  },

  bigTotal: {
    fontSize: 52,
    fontWeight: 1000,
    letterSpacing: "-0.03em",
    lineHeight: 1.0,
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

/** ===== Fireworks Component ===== */
function Fireworks({ on }) {
  if (!on) return null;

  // Create a few bursts
  const bursts = [
    { x: 55, y: 60, delay: 0 },
    { x: 90, y: 75, delay: 220 },
    { x: 20, y: 80, delay: 420 },
  ];

  return (
    <div style={styles.fireworksWrap}>
      {bursts.map((b, bi) => (
        <div
          key={bi}
          style={{
            position: "absolute",
            left: `${b.x}%`,
            top: `${b.y}%`,
            width: 0,
            height: 0,
            animation: `fireworkRise ${CELEBRATION_MS}ms ease-out forwards`,
            animationDelay: `${b.delay}ms`,
            opacity: 0,
          }}
        >
          {/* Sparks */}
          {Array.from({ length: 12 }).map((_, i) => {
            const angle = (Math.PI * 2 * i) / 12;
            const dist = 56 + ((i * 9) % 22);
            const dx = Math.round(Math.cos(angle) * dist);
            const dy = Math.round(Math.sin(angle) * dist);
            return (
              <span
                key={i}
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: `hsla(${(i * 35 + bi * 70) % 360}, 90%, 65%, 0.95)`,
                  boxShadow: "0 0 10px rgba(255,255,255,0.35)",
                  animation: `sparkBurst ${900}ms ease-out forwards`,
                  animationDelay: `${b.delay + 520}ms`,
                  ["--dx"]: `${dx}px`,
                  ["--dy"]: `${dy}px`,
                }}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** ===== Main App ===== */
export default function App() {
  const [route, setRoute] = useState(() => parseHashRoute());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    ensureGlobalCSS();
  }, []);

  // Device id
  const deviceId = useMemo(() => {
    try {
      let v = localStorage.getItem(DEVICE_ID_KEY);
      if (!v) {
        v = uid("dev");
        localStorage.setItem(DEVICE_ID_KEY, v);
      }
      return v;
    } catch {
      return uid("dev");
    }
  }, []);

  // Core data
  const [appName, setAppName] = useState("Coinche Scorekeeper");
  const [players, setPlayers] = useState([]); // {id,name}
  const [teams, setTeams] = useState([]); // {id,name,playerIds[], locked:boolean}
  const [avoidSameTeams, setAvoidSameTeams] = useState(true);
  const [pairHistory, setPairHistory] = useState([]); // ["p1|p2", ...]

  // Matches
  const [matches, setMatches] = useState([]);

  // UI
  const [newPlayerName, setNewPlayerName] = useState("");
  const [newTeamName, setNewTeamName] = useState("");
  const [newTableName, setNewTableName] = useState("Table 1");
  const [newMatchLabel, setNewMatchLabel] = useState("Match 1");

  const inputRef = useRef(null);

  // Backup UI state
  const [backupState, setBackupState] = useState({
    lastOk: null,
    lastErr: null,
    queued: 0,
    lastErrMsg: "",
    lastOkMsg: "",
  });

  // Hand backup queue (appendRow style)
  const [handQueue, setHandQueue] = useState([]);
  const flushingRef = useRef(false);

  // route listener
  useEffect(() => {
    const onHash = () => setRoute(parseHashRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  function defaultFastDraft() {
    return {
      bidder: "A",
      bid: "",
      suit: "S",
      coincheLevel: "NONE",
      capot: false,

      bidderTrickPoints: "",
      nonBidderTrickPoints: "",
      trickSource: "", // "" | "BIDDER" | "NON"

      announceA: "0",
      announceB: "0",
      beloteTeam: "NONE",
    };
  }

  function makeEmptyMatch({ tableName, teamAId, teamBId, label }) {
    return {
      id: uid("match"),
      code: shortCode(),
      tableName: tableName || "Table",
      label: label || "Match",
      teamAId: teamAId || null,
      teamBId: teamBId || null,
      hands: [],
      totalA: 0,
      totalB: 0,
      winnerId: null,
      completed: false,
      forcedComplete: false,
      fastDraft: defaultFastDraft(),
      editingHandIdx: null,
      timelineDiffs: [],
      lastUpdatedAt: Date.now(),
    };
  }

  function recomputeMatch(m) {
    const hands = m.hands || [];
    let totalA = 0;
    let totalB = 0;
    const diffs = [];
    for (const h of hands) {
      totalA += Number(h.scoreA) || 0;
      totalB += Number(h.scoreB) || 0;
      diffs.push(totalA - totalB);
    }

    const forced = Boolean(m.forcedComplete);
    const reached = totalA >= TARGET_SCORE || totalB >= TARGET_SCORE;
    const completed = forced || reached;

    let winnerId = null;
    if (completed && totalA !== totalB) {
      winnerId = totalA > totalB ? m.teamAId : m.teamBId;
    }

    return {
      ...m,
      totalA,
      totalB,
      completed,
      winnerId,
      timelineDiffs: diffs,
      lastUpdatedAt: Date.now(),
    };
  }

  // localStorage load
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        setAppName(d.appName ?? "Coinche Scorekeeper");
        setPlayers(d.players ?? []);
        setTeams(d.teams ?? []);
        setAvoidSameTeams(Boolean(d.avoidSameTeams ?? true));
        setPairHistory(d.pairHistory ?? []);
        setMatches(d.matches ?? []);
      }
    } catch {
      // ignore
    } finally {
      setLoaded(true);
    }
  }, []);

  // localStorage persist
  useEffect(() => {
    if (!loaded) return;
    const payload = {
      appName,
      players,
      teams,
      avoidSameTeams,
      pairHistory,
      matches,
      savedAt: Date.now(),
    };
    localStorage.setItem(LS_KEY, JSON.stringify(payload));
  }, [loaded, appName, players, teams, avoidSameTeams, pairHistory, matches]);

  const playerById = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);
  const teamById = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams]);

  const teamNumberById = useMemo(() => {
    const m = new Map();
    teams.forEach((t, i) => m.set(t.id, i + 1));
    return m;
  }, [teams]);

  const usedPlayerIds = useMemo(() => {
    const s = new Set();
    teams.forEach((t) => (t.playerIds || []).forEach((pid) => s.add(pid)));
    return s;
  }, [teams]);

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
    setTeams([]);
    setPairHistory([]);
    setMatches([]);
  }

  /** ===== Teams ===== */
  function addTeam() {
    const name = (newTeamName || "").trim();
    const teamName = name || `Team ${teams.length + 1}`;
    setTeams((prev) => [
      ...prev,
      { id: uid("t"), name: teamName, playerIds: [], locked: false },
    ]);
    setNewTeamName("");
  }

  function removeTeam(teamId) {
    setTeams((prev) => prev.filter((t) => t.id !== teamId));
    setMatches((prev) =>
      prev.map((m) => {
        const next = { ...m };
        if (next.teamAId === teamId) next.teamAId = null;
        if (next.teamBId === teamId) next.teamBId = null;
        return recomputeMatch({
          ...next,
          hands: [],
          forcedComplete: false,
          editingHandIdx: null,
          fastDraft: defaultFastDraft(),
        });
      })
    );
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
        while (ids.length < 2) ids.push("");
        ids[slotIdx] = playerIdOrEmpty;
        if (slotIdx === 0 && ids[0] && ids[0] === ids[1]) ids[1] = "";
        if (slotIdx === 1 && ids[1] && ids[0] === ids[1]) ids[0] = "";
        return { ...t, playerIds: ids.filter(Boolean) };
      })
    );
  }

  function renameTeam(teamId, name) {
    setTeams((prev) => prev.map((t) => (t.id === teamId ? { ...t, name } : t)));
  }

  function buildRandomTeams() {
    if (players.length < 2) return;

    const lockedPlayers = new Set();
    teams.forEach((t) => {
      if (!t.locked) return;
      (t.playerIds || []).forEach((pid) => lockedPlayers.add(pid));
    });

    const available = players
      .map((p) => p.id)
      .filter((pid) => !lockedPlayers.has(pid));
    const tries = avoidSameTeams ? 40 : 1;
    const historySet = new Set(pairHistory);
    let best = null;

    for (let k = 0; k < tries; k++) {
      const shuffled = shuffleArray(available);
      const pairs = [];
      for (let i = 0; i < shuffled.length; i += 2) {
        const a = shuffled[i];
        const b = shuffled[i + 1] || null;
        pairs.push([a, b]);
      }

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
    const nextTeams = teams.map((t) => ({ ...t, playerIds: [...(t.playerIds || [])] }));

    let pairIdx = 0;
    for (let i = 0; i < nextTeams.length; i++) {
      if (nextTeams[i].locked) continue;
      const pair = finalPairs[pairIdx] || [null, null];
      pairIdx++;
      nextTeams[i].playerIds = [pair[0], pair[1]].filter(Boolean);
    }

    const newPairs = [];
    for (const t of nextTeams) {
      if ((t.playerIds || []).length === 2)
        newPairs.push([...t.playerIds].sort().join("|"));
    }

    setTeams(nextTeams);
    setPairHistory((prev) => Array.from(new Set([...prev, ...newPairs])));
    setMatches((prev) =>
      prev.map((m) =>
        recomputeMatch({
          ...m,
          hands: [],
          forcedComplete: false,
          editingHandIdx: null,
          fastDraft: defaultFastDraft(),
        })
      )
    );
  }

  /** ===== Matches / Tables ===== */
  function addMatch() {
    if (!teams.length) return;
    setMatches((prev) => [
      ...prev,
      recomputeMatch(
        makeEmptyMatch({
          tableName: newTableName.trim() || `Table ${prev.length + 1}`,
          teamAId: null,
          teamBId: null,
          label: newMatchLabel.trim() || `Match ${prev.length + 1}`,
        })
      ),
    ]);
  }

  function removeMatch(matchId) {
    setMatches((prev) => prev.filter((m) => m.id !== matchId));
  }

  function setMatchTeam(matchId, side, teamIdOrEmpty) {
    setMatches((prev) =>
      prev.map((m) => {
        if (m.id !== matchId) return m;
        const next = { ...m, [side]: teamIdOrEmpty || null };
        return recomputeMatch({
          ...next,
          hands: [],
          forcedComplete: false,
          editingHandIdx: null,
          fastDraft: defaultFastDraft(),
        });
      })
    );
  }

  function renameMatch(matchId, patch) {
    setMatches((prev) =>
      prev.map((m) =>
        m.id === matchId ? { ...m, ...patch, lastUpdatedAt: Date.now() } : m
      )
    );
  }

  function finishMatchNow(matchId) {
    setMatches((prev) =>
      prev.map((m) => {
        if (m.id !== matchId) return m;
        const a = Number(m.totalA) || 0;
        const b = Number(m.totalB) || 0;

        let winnerId = null;
        if (a !== b) winnerId = a > b ? m.teamAId : m.teamBId;

        return {
          ...m,
          forcedComplete: true,
          completed: true,
          winnerId,
          lastUpdatedAt: Date.now(),
        };
      })
    );
  }

  /** ===== Hand tracker for a match ===== */
  function updateDraft(matchId, patch) {
    setMatches((prev) =>
      prev.map((m) => {
        if (m.id !== matchId) return m;
        return {
          ...m,
          fastDraft: { ...(m.fastDraft || defaultFastDraft()), ...patch },
        };
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
            nonBidderTrickPoints: String(d.nonBidderTrickPoints ?? ""),
            trickSource: d.trickSource ?? "",

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
      prev.map((m) =>
        m.id === matchId
          ? { ...m, editingHandIdx: null, fastDraft: defaultFastDraft() }
          : m
      )
    );
  }

  function queueHandBackup(payload) {
    setHandQueue((prev) => [...prev, payload]);
    setBackupState((s) => ({ ...s, queued: (s.queued || 0) + 1 }));
  }

  function normalizeBidAndCapot(d) {
    // If user types "capot" in bid field => bid = 250 AND capot = true
    const raw = String(d.bid ?? "").trim();
    if (raw && raw.toLowerCase() === "capot") {
      return { bidVal: 250, capotForced: true };
    }
    const bidVal = safeInt(raw);
    return { bidVal, capotForced: false };
  }

  function addOrSaveHand(matchId) {
    setMatches((prev) =>
      prev.map((m) => {
        if (m.id !== matchId) return m;

        const canPlay = !!m.teamAId && !!m.teamBId;
        if (!canPlay) return m;

        const d = m.fastDraft || defaultFastDraft();

        const { bidVal, capotForced } = normalizeBidAndCapot(d);

        // derive bidder trick points from whichever box is the source
        let trickVal = null;
        const bidderTP = safeInt(d.bidderTrickPoints);
        const nonBidderTP = safeInt(d.nonBidderTrickPoints);

        if (d.trickSource === "BIDDER") {
          if (bidderTP === null) return m;
          trickVal = bidderTP;
        } else if (d.trickSource === "NON") {
          if (nonBidderTP === null) return m;
          trickVal = 162 - nonBidderTP;
        } else {
          if (bidderTP !== null) trickVal = bidderTP;
          else if (nonBidderTP !== null) trickVal = 162 - nonBidderTP;
        }

        if (bidVal === null || trickVal === null) return m;
        trickVal = clamp(trickVal, 0, 162);

        const capotFlag = Boolean(d.capot) || capotForced;

        const res = computeFastCoincheScore({
          bidder: d.bidder,
          bid: bidVal,
          suit: d.suit || "S",
          coincheLevel: d.coincheLevel || "NONE",
          capot: capotFlag,
          bidderTrickPoints: trickVal,
          announceA: safeInt(d.announceA) ?? 0,
          announceB: safeInt(d.announceB) ?? 0,
          beloteTeam: d.beloteTeam || "NONE",
        });

        const snap = {
          bidder: d.bidder,
          bid: bidVal,
          suit: d.suit || "S",
          coincheLevel: d.coincheLevel || "NONE",
          capot: capotFlag,

          bidderTrickPoints: trickVal,
          nonBidderTrickPoints:
            d.trickSource === "NON"
              ? clamp(nonBidderTP ?? (162 - trickVal), 0, 162)
              : clamp(162 - trickVal, 0, 162),
          trickSource: d.trickSource || (nonBidderTP !== null ? "NON" : "BIDDER"),

          announceA: safeInt(d.announceA) ?? 0,
          announceB: safeInt(d.announceB) ?? 0,
          beloteTeam: d.beloteTeam || "NONE",
        };

        const base = recomputeMatch(m);

        // editing existing hand
        if (m.editingHandIdx) {
          const nextHands = (m.hands || []).map((h) => {
            if (h.idx !== m.editingHandIdx) return h;
            return {
              ...h,
              draftSnapshot: snap,
              scoreA: res.scoreA,
              scoreB: res.scoreB,
              bidderSucceeded: res.bidderSucceeded,
            };
          });

          const nextMatch = recomputeMatch({
            ...m,
            hands: nextHands,
            fastDraft: defaultFastDraft(),
            editingHandIdx: null,
          });

          // queue backup (edited hand)
          const ta = teamById.get(nextMatch.teamAId)?.name ?? "";
          const tb = teamById.get(nextMatch.teamBId)?.name ?? "";
          queueHandBackup({
            timestamp: new Date().toISOString(),
            tournamentName: appName,
            matchCode: nextMatch.code,
            matchLabel: nextMatch.label,
            teamA: ta,
            teamB: tb,
            handIdx: m.editingHandIdx,
            scoreA: res.scoreA,
            scoreB: res.scoreB,
            bidder: snap.bidder,
            bid: snap.bid,
            suit: snap.suit,
            coincheLevel: snap.coincheLevel,
            capot: snap.capot,
            bidderTrickPoints: snap.bidderTrickPoints,
            announceA: snap.announceA,
            announceB: snap.announceB,
            beloteTeam: snap.beloteTeam,
            bidderSucceeded: res.bidderSucceeded,
            totalA: nextMatch.totalA,
            totalB: nextMatch.totalB,
            deviceId,
          });

          return nextMatch;
        }

        if (base.completed) return base;

        const nextHand = {
          idx: (m.hands?.length || 0) + 1,
          createdAt: Date.now(),
          draftSnapshot: snap,
          scoreA: res.scoreA,
          scoreB: res.scoreB,
          bidderSucceeded: res.bidderSucceeded,
        };

        const nextMatch = recomputeMatch({
          ...m,
          hands: [...(m.hands || []), nextHand],
          fastDraft: defaultFastDraft(),
        });

        // queue backup (new hand)
        const ta = teamById.get(nextMatch.teamAId)?.name ?? "";
        const tb = teamById.get(nextMatch.teamBId)?.name ?? "";
        queueHandBackup({
          timestamp: new Date().toISOString(),
          tournamentName: appName,
          matchCode: nextMatch.code,
          matchLabel: nextMatch.label,
          teamA: ta,
          teamB: tb,
          handIdx: nextHand.idx,
          scoreA: res.scoreA,
          scoreB: res.scoreB,
          bidder: snap.bidder,
          bid: snap.bid,
          suit: snap.suit,
          coincheLevel: snap.coincheLevel,
          capot: snap.capot,
          bidderTrickPoints: snap.bidderTrickPoints,
          announceA: snap.announceA,
          announceB: snap.announceB,
          beloteTeam: snap.beloteTeam,
          bidderSucceeded: res.bidderSucceeded,
          totalA: nextMatch.totalA,
          totalB: nextMatch.totalB,
          deviceId,
        });

        return nextMatch;
      })
    );
  }

  function clearMatchHands(matchId) {
    setMatches((prev) =>
      prev.map((m) =>
        m.id === matchId
          ? recomputeMatch({
              ...m,
              hands: [],
              forcedComplete: false,
              editingHandIdx: null,
              fastDraft: defaultFastDraft(),
            })
          : m
      )
    );
  }

  /** ===== Google Sheets Hand Append Backup (matches your doPost schema) ===== */
  async function postHandToSheets(handPayload) {
    const body = {
      secret: BACKUP_SECRET,
      ...handPayload,
    };

    // 1) Try normal fetch (best: we can read response)
    try {
      const res = await fetch(BACKUP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        redirect: "follow",
        body: JSON.stringify(body),
      });
      const txt = await res.text().catch(() => "");
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
      return { ok: true, msg: txt?.slice(0, 120) || "OK" };
    } catch (e) {
      // 2) If CORS blocks reading response, still try to SEND the request:
      //    - sendBeacon (fire-and-forget, usually succeeds)
      //    - fallback fetch no-cors
      const payloadStr = JSON.stringify(body);

      try {
        if (navigator.sendBeacon) {
          const blob = new Blob([payloadStr], { type: "application/json" });
          const ok = navigator.sendBeacon(BACKUP_URL, blob);
          if (ok) return { ok: true, msg: "Sent via sendBeacon (no response)" };
        }
      } catch {
        // ignore
      }

      try {
        await fetch(BACKUP_URL, {
          method: "POST",
          mode: "no-cors",
          headers: { "Content-Type": "application/json" },
          body: payloadStr,
        });
        return { ok: true, msg: "Sent no-cors (no response)" };
      } catch (e2) {
        return { ok: false, err: String(e2 || e) };
      }
    }
  }

  async function flushHandQueue() {
    if (flushingRef.current) return;
    flushingRef.current = true;

    try {
      while (true) {
        const next = handQueueRef.current?.[0];
        if (!next) break;

        const result = await postHandToSheets(next);

        if (result.ok) {
          setBackupState((s) => ({
            ...s,
            lastOk: Date.now(),
            lastErr: null,
            lastErrMsg: "",
            lastOkMsg: result.msg || "OK",
          }));
          // dequeue 1
          setHandQueue((prev) => prev.slice(1));
          setBackupState((s) => ({
            ...s,
            queued: Math.max(0, (s.queued || 1) - 1),
          }));
        } else {
          setBackupState((s) => ({
            ...s,
            lastErr: Date.now(),
            lastErrMsg: result.err || "Backup failed",
          }));
          // stop and retry later
          break;
        }
      }
    } finally {
      flushingRef.current = false;
    }
  }

  const handQueueRef = useRef(handQueue);
  useEffect(() => {
    handQueueRef.current = handQueue;
  }, [handQueue]);

  // When queue changes, attempt flush
  useEffect(() => {
    if (!loaded) return;
    if (handQueue.length === 0) return;
    void flushHandQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handQueue.length, loaded]);

  // Retry periodically if there is an error and queued items exist
  useEffect(() => {
    if (!loaded) return;
    if (handQueue.length === 0) return;

    const t = setInterval(() => {
      if (handQueueRef.current.length > 0) void flushHandQueue();
    }, 2500);

    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handQueue.length, loaded]);

  useEffect(() => {
    const onOnline = () => {
      if (handQueueRef.current.length > 0) void flushHandQueue();
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, []);

  /** ===== Scoreboard (aggregate across all matches) ===== */
  const scoreboardRows = useMemo(() => {
    const rows = teams.map((t) => ({
      teamId: t.id,
      name: t.name,
      matchesPlayed: 0,
      wins: 0,
      losses: 0,
      pointsFor: 0,
      pointsAgainst: 0,
    }));
    const byId = new Map(rows.map((r) => [r.teamId, r]));

    for (const m of matches) {
      if (!m.teamAId || !m.teamBId) continue;
      const a = byId.get(m.teamAId);
      const b = byId.get(m.teamBId);
      if (!a || !b) continue;

      a.pointsFor += Number(m.totalA) || 0;
      a.pointsAgainst += Number(m.totalB) || 0;
      b.pointsFor += Number(m.totalB) || 0;
      b.pointsAgainst += Number(m.totalA) || 0;

      if ((m.hands || []).length > 0) {
        a.matchesPlayed += 1;
        b.matchesPlayed += 1;
      }

      if (m.winnerId === m.teamAId) {
        a.wins += 1;
        b.losses += 1;
      } else if (m.winnerId === m.teamBId) {
        b.wins += 1;
        a.losses += 1;
      }
    }

    return rows.sort((x, y) => {
      if (y.wins !== x.wins) return y.wins - x.wins;
      const dx = x.pointsFor - x.pointsAgainst;
      const dy = y.pointsFor - y.pointsAgainst;
      if (dy !== dx) return dy - dx;
      if (y.pointsFor !== x.pointsFor) return y.pointsFor - x.pointsFor;
      return x.name.localeCompare(y.name);
    });
  }, [teams, matches]);

  /** ===== Links ===== */
  const publicLink = useMemo(
    () => `${window.location.origin}${window.location.pathname}#/public`,
    []
  );
  const tableLinks = useMemo(() => {
    return matches.map((m) => ({
      label: `${m.tableName} • ${m.label}`,
      code: m.code,
      href: `${window.location.origin}${window.location.pathname}#/table?code=${m.code}`,
    }));
  }, [matches]);

  /** ===== Routing ===== */
  const { path, query } = route;

  const tableMatch = useMemo(() => {
    const code = (query.code || "").toUpperCase();
    if (!code) return null;
    const m = matches.find((x) => (x.code || "").toUpperCase() === code);
    return m || null;
  }, [query.code, matches]);

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
        Backup:{" "}
        {backupState.lastOk
          ? `OK (${new Date(backupState.lastOk).toLocaleTimeString()})`
          : "—"}
        {backupState.lastErr ? ` • retrying…` : ""}
        {backupState.queued ? ` • queued: ${backupState.queued}` : ""}
      </span>
    </div>
  );

  /** ===== Public View ===== */
  if (path === "/public") {
    const liveMatches = matches
      .filter((m) => m.teamAId && m.teamBId)
      .filter((m) => !m.completed);

    return (
      <div style={styles.page}>
        <div style={styles.container}>
          <div style={styles.topbar}>
            <div>
              <h1 style={styles.title}>{appName}</h1>
              <div style={styles.subtitle}>
                Public scoreboard • Live updates • Tables: {matches.length}
              </div>
            </div>
            <NavPills showAdmin={true} />
          </div>

          <div style={styles.grid2}>
            <Section title="Live Scoreboard">
              <ScoreboardTable rows={scoreboardRows} />
            </Section>

            <Section
              title="Live Matches (in progress)"
              right={<span style={styles.small}>{liveMatches.length} live</span>}
            >
              {liveMatches.length === 0 ? (
                <div style={styles.small}>No matches currently in progress.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {liveMatches.map((m) => {
                    const ta = teamById.get(m.teamAId)?.name ?? "Team A";
                    const tb = teamById.get(m.teamBId)?.name ?? "Team B";
                    const pctA = Math.min(
                      100,
                      Math.round(((m.totalA || 0) / TARGET_SCORE) * 100)
                    );
                    const pctB = Math.min(
                      100,
                      Math.round(((m.totalB || 0) / TARGET_SCORE) * 100)
                    );
                    return (
                      <div key={m.id} style={styles.card}>
                        <div style={{ fontWeight: 950, marginBottom: 8 }}>
                          {m.tableName} • {m.label}{" "}
                          <span style={styles.small}>({m.code})</span>
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                          <div>
                            <div style={{ fontWeight: 900, marginBottom: 6 }}>
                              {ta}: <span style={{ color: "#e5e7eb" }}>{m.totalA}</span>
                            </div>
                            <div style={styles.progressWrap}>
                              <div style={styles.progressFillA(pctA)} />
                            </div>
                          </div>
                          <div>
                            <div style={{ fontWeight: 900, marginBottom: 6 }}>
                              {tb}: <span style={{ color: "#e5e7eb" }}>{m.totalB}</span>
                            </div>
                            <div style={styles.progressWrap}>
                              <div style={styles.progressFillB(pctB)} />
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Section>
          </div>

          <Section title="Table Entry Links">
            <div style={{ color: "#94a3b8", fontSize: 12, marginBottom: 10 }}>
              Each table uses their own link to enter hands/scores.
            </div>
            <div style={styles.grid3}>
              {tableLinks.map((t) => (
                <div key={t.code} style={styles.card}>
                  <div style={{ fontWeight: 900, marginBottom: 6 }}>{t.label}</div>
                  <div style={{ color: "#94a3b8", fontSize: 12, marginBottom: 10 }}>
                    Code: {t.code}
                  </div>
                  <a
                    href={t.href}
                    style={{
                      ...styles.btnSecondary,
                      display: "inline-block",
                      textDecoration: "none",
                    }}
                  >
                    Open Table View
                  </a>
                </div>
              ))}
              {tableLinks.length === 0 ? (
                <div style={styles.small}>No matches yet. Add matches in Admin.</div>
              ) : null}
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
              <h1 style={styles.title}>{appName}</h1>
              <div style={styles.subtitle}>Table View • Enter hands for your match only</div>
            </div>
            <NavPills showAdmin={true} />
          </div>

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
            <Section title={`Your Match • Code ${tableMatch.code}`}>
              <TableMatchPanel
                match={tableMatch}
                teamById={teamById}
                teamNumberById={teamNumberById}
                onDraftPatch={(patch) => updateDraft(tableMatch.id, patch)}
                onAddHand={() => addOrSaveHand(tableMatch.id)}
                onClearHands={() => clearMatchHands(tableMatch.id)}
                onStartEditHand={(handIdx) => startEditHand(tableMatch.id, handIdx)}
                onCancelEdit={() => cancelEditHand(tableMatch.id)}
                onFinishNow={() => finishMatchNow(tableMatch.id)}
                bigTotals
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
            <h1 style={styles.title}>{appName}</h1>
            <div style={styles.subtitle}>
              Admin • Setup players/teams • Create table matches • Share links • Google Sheet per-hand backup
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
          <div style={{ marginTop: 8, ...styles.small }}>
            Backup status:{" "}
            {backupState.lastOk ? "✅ OK" : "—"}{" "}
            {backupState.lastErr ? "• ❌ error (retrying…)" : ""}{" "}
            {backupState.queued ? `• queued: ${backupState.queued}` : ""}
            {backupState.lastErrMsg ? (
              <div style={{ marginTop: 6, color: "#fca5a5" }}>
                Last error: {backupState.lastErrMsg}
              </div>
            ) : null}
          </div>
        </Section>

        <Section
          title="Settings"
          right={
            <div style={styles.row}>
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 900 }}>
                <input
                  type="checkbox"
                  checked={avoidSameTeams}
                  onChange={(e) => setAvoidSameTeams(e.target.checked)}
                />
                Avoid repeating pairs
              </label>

              <button
                style={styles.btnSecondary}
                onClick={() => {
                  if (handQueueRef.current.length > 0) void flushHandQueue();
                  else alert("No pending hand backups in queue.");
                }}
              >
                Retry Backup Now
              </button>

              <button
                style={styles.btnDanger}
                onClick={() => {
                  if (!confirm("Full reset? This clears everything.")) return;
                  setAppName("Coinche Scorekeeper");
                  setPlayers([]);
                  setTeams([]);
                  setPairHistory([]);
                  setMatches([]);
                  setHandQueue([]);
                  setBackupState({ lastOk: null, lastErr: null, queued: 0, lastErrMsg: "", lastOkMsg: "" });
                }}
              >
                Full Reset
              </button>
            </div>
          }
        >
          <div style={styles.grid3}>
            <div style={styles.card}>
              <div style={styles.small}>App name</div>
              <input
                style={styles.input("100%")}
                value={appName}
                onChange={(e) => setAppName(e.target.value)}
              />
            </div>

            <div style={styles.card}>
              <div style={styles.small}>Target score</div>
              <div style={{ fontWeight: 950, fontSize: 18 }}>{TARGET_SCORE}</div>
              <div style={styles.small}>Match ends immediately at {TARGET_SCORE}+.</div>
            </div>

            <div style={styles.card}>
              <div style={styles.small}>Backup endpoint</div>
              <div
                style={{
                  fontWeight: 900,
                  fontSize: 12,
                  color: "#cbd5e1",
                  wordBreak: "break-all",
                }}
              >
                {BACKUP_URL}
              </div>
              <div style={{ marginTop: 6, ...styles.small }}>
                Device ID: <span style={{ color: "#e5e7eb" }}>{deviceId.slice(-10)}</span>
              </div>
            </div>
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
          </div>

          <div style={{ marginTop: 12, ...styles.grid4 }}>
            {players.map((p) => (
              <div key={p.id} style={styles.card}>
                <div
                  style={{
                    fontWeight: 950,
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 10,
                  }}
                >
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {p.name}
                  </span>
                  <button style={{ ...styles.btnGhost, padding: 0 }} onClick={() => removePlayer(p.id)}>
                    Remove
                  </button>
                </div>
                <div style={styles.small}>ID: {p.id.slice(-6)}</div>
              </div>
            ))}
            {players.length === 0 ? <div style={styles.small}>Add players to get started.</div> : null}
          </div>
        </Section>

        <Section
          title={`Teams (${teams.length})`}
          right={
            <div style={styles.row}>
              <input
                style={styles.input(220)}
                value={newTeamName}
                onChange={(e) => setNewTeamName(e.target.value)}
                placeholder="Optional team name"
              />
              <button style={styles.btnPrimary} onClick={addTeam}>
                Add Team
              </button>
              <button
                style={styles.btnSecondary}
                onClick={buildRandomTeams}
                disabled={players.length < 2 || teams.length < 1}
              >
                Randomize Teams (respects locks)
              </button>
            </div>
          }
        >
          {teams.length === 0 ? (
            <div style={styles.small}>Add teams, then assign players.</div>
          ) : (
            <div style={styles.grid2}>
              {teams.map((t, idx) => (
                <div key={t.id} style={styles.card}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 10,
                      alignItems: "center",
                      flexWrap: "wrap",
                    }}
                  >
                    <div style={{ fontWeight: 950 }}>Team #{idx + 1}</div>
                    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                      <label
                        style={{
                          display: "flex",
                          gap: 8,
                          alignItems: "center",
                          fontWeight: 900,
                          color: t.locked ? "#34d399" : "#94a3b8",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={!!t.locked}
                          onChange={(e) => toggleTeamLock(t.id, e.target.checked)}
                        />
                        Lock
                      </label>
                      <button style={styles.btnGhost} onClick={() => removeTeam(t.id)}>
                        Remove
                      </button>
                    </div>
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
                          const taken =
                            usedPlayerIds.has(p.id) && !(t.playerIds || []).includes(p.id);
                          return (
                            <option key={p.id} value={p.id} disabled={taken}>
                              {p.name}
                              {taken ? " (used)" : ""}
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
                          const taken =
                            usedPlayerIds.has(p.id) && !(t.playerIds || []).includes(p.id);
                          return (
                            <option key={p.id} value={p.id} disabled={taken}>
                              {p.name}
                              {taken ? " (used)" : ""}
                            </option>
                          );
                        })}
                      </select>
                    </div>
                  </div>

                  <div style={{ marginTop: 10, ...styles.small }}>
                    Members:{" "}
                    {(t.playerIds || [])
                      .map((pid) => playerById.get(pid)?.name)
                      .filter(Boolean)
                      .join(" / ") || "—"}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section
          title={`Tables / Matches (${matches.length})`}
          right={
            <div style={styles.row}>
              <input
                style={styles.input(180)}
                value={newTableName}
                onChange={(e) => setNewTableName(e.target.value)}
                placeholder="Table name"
              />
              <input
                style={styles.input(180)}
                value={newMatchLabel}
                onChange={(e) => setNewMatchLabel(e.target.value)}
                placeholder="Match label"
              />
              <button style={styles.btnPrimary} onClick={addMatch} disabled={teams.length < 1}>
                Add Match
              </button>
            </div>
          }
        >
          {matches.length === 0 ? (
            <div style={styles.small}>Add a match, then assign Team A / Team B.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {matches.map((m) => (
                <div key={m.id} style={styles.card}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 10,
                      flexWrap: "wrap",
                      alignItems: "baseline",
                    }}
                  >
                    <div style={{ fontWeight: 950 }}>
                      {m.tableName} • {m.label}{" "}
                      <span style={styles.small}>• Code {m.code}</span>
                    </div>
                    <div style={styles.row}>
                      <a
                        href={`#/table?code=${m.code}`}
                        style={{ ...styles.btnSecondary, textDecoration: "none" }}
                      >
                        Open Table
                      </a>
                      <button
                        style={styles.btnSecondary}
                        onClick={() => {
                          const href = `${window.location.origin}${window.location.pathname}#/table?code=${m.code}`;
                          navigator.clipboard?.writeText(href);
                          alert("Table link copied!");
                        }}
                      >
                        Copy Link
                      </button>
                      <button style={styles.btnDanger} onClick={() => removeMatch(m.id)}>
                        Remove
                      </button>
                    </div>
                  </div>

                  <div style={{ marginTop: 10, ...styles.grid3 }}>
                    <div style={styles.card}>
                      <div style={styles.small}>Table name</div>
                      <input
                        style={styles.input("100%")}
                        value={m.tableName}
                        onChange={(e) => renameMatch(m.id, { tableName: e.target.value })}
                      />
                    </div>
                    <div style={styles.card}>
                      <div style={styles.small}>Match label</div>
                      <input
                        style={styles.input("100%")}
                        value={m.label}
                        onChange={(e) => renameMatch(m.id, { label: e.target.value })}
                      />
                    </div>
                    <div style={styles.card}>
                      <div style={styles.small}>Quick status</div>
                      <div style={{ fontWeight: 950, color: m.completed ? "#34d399" : "#94a3b8" }}>
                        {m.completed
                          ? `Completed • Winner: ${teamById.get(m.winnerId)?.name ?? "—"}`
                          : "In progress"}
                      </div>
                      <div style={styles.small}>
                        Score: {m.totalA} – {m.totalB}
                      </div>
                    </div>
                  </div>

                  <div style={{ marginTop: 12, ...styles.grid2 }}>
                    <div>
                      <div style={styles.small}>Team A</div>
                      <select
                        style={styles.select("100%")}
                        value={m.teamAId || ""}
                        onChange={(e) => setMatchTeam(m.id, "teamAId", e.target.value)}
                      >
                        <option value="">— Select —</option>
                        {teams.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <div style={styles.small}>Team B</div>
                      <select
                        style={styles.select("100%")}
                        value={m.teamBId || ""}
                        onChange={(e) => setMatchTeam(m.id, "teamBId", e.target.value)}
                      >
                        <option value="">— Select —</option>
                        {teams.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div style={{ marginTop: 12 }}>
                    <TableMatchPanel
                      match={m}
                      teamById={teamById}
                      teamNumberById={teamNumberById}
                      onDraftPatch={(patch) => updateDraft(m.id, patch)}
                      onAddHand={() => addOrSaveHand(m.id)}
                      onClearHands={() => clearMatchHands(m.id)}
                      onStartEditHand={(handIdx) => startEditHand(m.id, handIdx)}
                      onCancelEdit={() => cancelEditHand(m.id)}
                      onFinishNow={() => finishMatchNow(m.id)}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
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

function ScoreboardTable({ rows }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
        <thead>
          <tr>
            {["Rank", "Team", "MP", "W", "L", "PF", "PA", "+/-"].map((h) => (
              <th
                key={h}
                style={{
                  textAlign: "left",
                  padding: "10px 10px",
                  fontSize: 12,
                  color: "#94a3b8",
                  borderBottom: "1px solid rgba(148,163,184,0.18)",
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const diff = (r.pointsFor || 0) - (r.pointsAgainst || 0);
            return (
              <tr key={r.teamId}>
                <td style={tdStrong}>#{i + 1}</td>
                <td style={tdBold}>{r.name}</td>
                <td style={td}>{r.matchesPlayed}</td>
                <td style={td}>{r.wins}</td>
                <td style={td}>{r.losses}</td>
                <td style={td}>{r.pointsFor}</td>
                <td style={td}>{r.pointsAgainst}</td>
                <td style={tdBold}>{diff}</td>
              </tr>
            );
          })}
          {rows.length === 0 ? (
            <tr>
              <td colSpan={8} style={{ padding: 12, color: "#94a3b8" }}>
                No data yet.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

const td = {
  padding: "10px 10px",
  borderBottom: "1px solid rgba(148,163,184,0.10)",
  fontWeight: 800,
};
const tdBold = { ...td, fontWeight: 950 };
const tdStrong = { ...td, fontWeight: 1000 };

function AnimatedNumber({ value }) {
  const [bump, setBump] = useState(false);
  const prevRef = useRef(value);

  useEffect(() => {
    if (prevRef.current !== value) {
      setBump(true);
      const t = setTimeout(() => setBump(false), 220);
      prevRef.current = value;
      return () => clearTimeout(t);
    }
  }, [value]);

  return (
    <span
      style={{
        display: "inline-block",
        transform: bump ? "scale(1.06)" : "scale(1)",
        transition: "transform 220ms ease",
      }}
    >
      {value}
    </span>
  );
}

function TableMatchPanel({
  match,
  teamById,
  teamNumberById,
  onDraftPatch,
  onAddHand,
  onClearHands,
  onStartEditHand,
  onCancelEdit,
  onFinishNow,
  bigTotals = false,
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
    nonBidderTrickPoints: "",
    trickSource: "",
    announceA: "0",
    announceB: "0",
    beloteTeam: "NONE",
  };

  const canPlay = !!match.teamAId && !!match.teamBId;
  const leader =
    match.totalA === match.totalB ? null : match.totalA > match.totalB ? "A" : "B";

  const winnerSide =
    match.completed && match.winnerId
      ? match.winnerId === match.teamAId
        ? "A"
        : match.winnerId === match.teamBId
        ? "B"
        : null
      : null;

  const [celebrateOn, setCelebrateOn] = useState(false);
  const prevWinnerRef = useRef(null);

  useEffect(() => {
    const prev = prevWinnerRef.current;
    if (!prev && winnerSide) {
      setCelebrateOn(true);
      const t = setTimeout(() => setCelebrateOn(false), CELEBRATION_MS);
      prevWinnerRef.current = winnerSide;
      return () => clearTimeout(t);
    }
    prevWinnerRef.current = winnerSide;
  }, [winnerSide]);

  const suitLabel =
    d.suit === "H" ? "Hearts" : d.suit === "D" ? "Diamonds" : d.suit === "C" ? "Clubs" : "Spades";

  // Hand-tracker label style (+6 font size)
  const fieldLabelStyle = {
    color: "#cbd5e1",
    fontSize: 18,
    fontWeight: 900,
    marginBottom: 6,
  };

  // Shorter fields (visual half-length)
  const handInput = {
    ...styles.input("100%"),
    padding: "8px 10px",
    borderRadius: 12,
  };
  const handSelect = {
    ...styles.select("100%"),
    padding: "8px 10px",
    borderRadius: 12,
  };

  return (
    <div style={{ ...styles.card, borderRadius: 18 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 10,
          flexWrap: "wrap",
          alignItems: "baseline",
        }}
      >
        <div style={{ fontWeight: 950 }}>
          {match.tableName} • {match.label}
        </div>
        <div style={{ color: match.completed ? "#34d399" : "#94a3b8", fontWeight: 950 }}>
          {match.completed ? `Winner: ${teamById.get(match.winnerId)?.name ?? "—"}` : "Live"}
        </div>
      </div>

      <div style={{ marginTop: 10, ...styles.grid2 }}>
        {/* Team A box */}
        <div
          style={{
            ...styles.card,
            position: "relative",
            ...(leader === "A" ? styles.leaderGlow : {}),
            ...(winnerSide === "A" ? styles.winnerGlow : {}),
          }}
        >
          {winnerSide === "A" ? (
            <div style={styles.trophyBadge}>
              <span style={styles.trophyCircle}>🏆</span>
              <span>1</span>
            </div>
          ) : null}

          {celebrateOn && winnerSide === "A" ? (
            <>
              <Fireworks on />
              <div style={styles.confettiWrap}>
                {Array.from({ length: 30 }).map((_, i) => (
                  <span key={i} style={styles.confettiPiece(i)} />
                ))}
              </div>
            </>
          ) : null}

          <div style={{ fontWeight: 900, marginBottom: 6 }}>{`Team #${numA}: ${ta}`}</div>

          {bigTotals ? (
            <div style={styles.bigTotal}>
              <AnimatedNumber value={match.totalA} />
            </div>
          ) : (
            <div style={styles.small}>
              Total: <b style={{ color: "#e5e7eb" }}>{match.totalA}</b> / {TARGET_SCORE}
            </div>
          )}

          <div style={{ marginTop: 8, ...styles.progressWrap }}>
            <div style={styles.progressFillA(pctA)} />
          </div>
        </div>

        {/* Team B box */}
        <div
          style={{
            ...styles.card,
            position: "relative",
            ...(leader === "B" ? styles.leaderGlow : {}),
            ...(winnerSide === "B" ? styles.winnerGlow : {}),
          }}
        >
          {winnerSide === "B" ? (
            <div style={styles.trophyBadge}>
              <span style={styles.trophyCircle}>🏆</span>
              <span>1</span>
            </div>
          ) : null}

          {celebrateOn && winnerSide === "B" ? (
            <>
              <Fireworks on />
              <div style={styles.confettiWrap}>
                {Array.from({ length: 30 }).map((_, i) => (
                  <span key={i} style={styles.confettiPiece(i)} />
                ))}
              </div>
            </>
          ) : null}

          <div style={{ fontWeight: 900, marginBottom: 6 }}>{`Team #${numB}: ${tb}`}</div>

          {bigTotals ? (
            <div style={styles.bigTotal}>
              <AnimatedNumber value={match.totalB} />
            </div>
          ) : (
            <div style={styles.small}>
              Total: <b style={{ color: "#e5e7eb" }}>{match.totalB}</b> / {TARGET_SCORE}
            </div>
          )}

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
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 10,
            flexWrap: "wrap",
            alignItems: "baseline",
          }}
        >
          <div style={{ fontWeight: 950 }}>Hand Tracker</div>
          {match.editingHandIdx ? (
            <span style={styles.tag}>Editing Hand {match.editingHandIdx}</span>
          ) : (
            <span style={styles.tag}>New Hand</span>
          )}
        </div>

        {/* ✅ EXACT layout requested: 3 rows */}
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 12 }}>
          {/* Row 1: Bidder, Bid, Suit, Coinche, Capot */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(5, minmax(140px, 1fr))",
              gap: 10,
              alignItems: "start",
            }}
          >
            <div>
              <div style={fieldLabelStyle}>Bidder</div>
              <select
                style={handSelect}
                value={d.bidder}
                onChange={(e) => onDraftPatch({ bidder: e.target.value })}
                disabled={!canPlay}
              >
                <option value="A">{`Team #${numA} — ${ta}`}</option>
                <option value="B">{`Team #${numB} — ${tb}`}</option>
              </select>
            </div>

            <div>
              <div style={fieldLabelStyle}>Bid</div>
              <input
                style={handInput}
                value={d.bid}
                onChange={(e) => onDraftPatch({ bid: e.target.value })}
                placeholder='80, 90, 110... or "capot"'
                disabled={!canPlay}
              />
            </div>

            <div>
              <div style={fieldLabelStyle}>Suit</div>
              <select
                style={handSelect}
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
              <div style={fieldLabelStyle}>Coinche</div>
              <select
                style={handSelect}
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
              <div style={fieldLabelStyle}>Capot</div>
              <select
                style={handSelect}
                value={d.capot ? "YES" : "NO"}
                onChange={(e) => onDraftPatch({ capot: e.target.value === "YES" })}
                disabled={!canPlay}
              >
                <option value="NO">No</option>
                <option value="YES">Yes</option>
              </select>
            </div>
          </div>

          {/* Row 2: Announces A/B */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, minmax(180px, 1fr))",
              gap: 10,
              alignItems: "start",
            }}
          >
            <div>
              <div style={fieldLabelStyle}>Announces Team A (non-belote)</div>
              <input
                style={handInput}
                value={d.announceA}
                onChange={(e) => onDraftPatch({ announceA: e.target.value })}
                inputMode="numeric"
                disabled={!canPlay}
              />
            </div>

            <div>
              <div style={fieldLabelStyle}>Announces Team B (non-belote)</div>
              <input
                style={handInput}
                value={d.announceB}
                onChange={(e) => onDraftPatch({ announceB: e.target.value })}
                inputMode="numeric"
                disabled={!canPlay}
              />
            </div>
          </div>

          {/* Row 3: Belote + trick points */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(180px, 1fr))",
              gap: 10,
              alignItems: "start",
            }}
          >
            <div>
              <div style={fieldLabelStyle}>Belote</div>
              <select
                style={handSelect}
                value={d.beloteTeam}
                onChange={(e) => onDraftPatch({ beloteTeam: e.target.value })}
                disabled={!canPlay}
              >
                <option value="NONE">None</option>
                <option value="A">{`Team #${numA}`}</option>
                <option value="B">{`Team #${numB}`}</option>
              </select>
            </div>

            <div>
              <div style={fieldLabelStyle}>Bidder trick points (0–162)</div>
              <input
                style={handInput}
                value={d.bidderTrickPoints}
                onChange={(e) => {
                  const raw = e.target.value;
                  if (raw.trim() === "") {
                    onDraftPatch({
                      bidderTrickPoints: "",
                      nonBidderTrickPoints: "",
                      trickSource: "",
                    });
                    return;
                  }
                  const n = safeInt(raw);
                  if (n === null) {
                    onDraftPatch({ bidderTrickPoints: raw, trickSource: "BIDDER" });
                    return;
                  }
                  const v = clamp(n, 0, 162);
                  onDraftPatch({
                    bidderTrickPoints: String(v),
                    nonBidderTrickPoints: String(162 - v),
                    trickSource: "BIDDER",
                  });
                }}
                placeholder="ex: 81"
                inputMode="numeric"
                disabled={!canPlay || d.trickSource === "NON"}
              />
            </div>

            <div>
              <div style={fieldLabelStyle}>Non-bidder trick points (0–162)</div>
              <input
                style={handInput}
                value={d.nonBidderTrickPoints}
                onChange={(e) => {
                  const raw = e.target.value;
                  if (raw.trim() === "") {
                    onDraftPatch({
                      bidderTrickPoints: "",
                      nonBidderTrickPoints: "",
                      trickSource: "",
                    });
                    return;
                  }
                  const n = safeInt(raw);
                  if (n === null) {
                    onDraftPatch({ nonBidderTrickPoints: raw, trickSource: "NON" });
                    return;
                  }
                  const v = clamp(n, 0, 162);
                  onDraftPatch({
                    nonBidderTrickPoints: String(v),
                    bidderTrickPoints: String(162 - v),
                    trickSource: "NON",
                  });
                }}
                placeholder="ex: 81"
                inputMode="numeric"
                disabled={!canPlay || d.trickSource === "BIDDER"}
              />
            </div>
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

          {!match.completed ? (
            <button
              style={{ ...styles.btnDanger, ...(canPlay ? {} : styles.disabled) }}
              onClick={() => {
                if (!canPlay) return;
                if (!confirm("Finish this game now? Winner will be the higher total score.")) return;
                onFinishNow?.();
              }}
              disabled={!canPlay}
            >
              Finish Game Now
            </button>
          ) : null}

          <span style={{ ...styles.small, marginLeft: "auto" }}>
            Suit: <SuitIcon suit={d.suit || "S"} /> {suitLabel}
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
              const nonBidder =
                typeof ds.nonBidderTrickPoints !== "undefined" && ds.nonBidderTrickPoints !== ""
                  ? ds.nonBidderTrickPoints
                  : clamp(162 - (Number(ds.bidderTrickPoints) || 0), 0, 162);
              return (
                <div key={h.idx} style={styles.handRow}>
                  <div style={{ minWidth: 200 }}>
                    <div style={{ fontWeight: 950 }}>Hand {h.idx}</div>
                    <div style={styles.small}>
                      Bid {ds.bid} <SuitIcon suit={ds.suit || "S"} /> • Bidder {ds.bidder} • {ds.coincheLevel}
                      {ds.capot ? " • Capot" : ""} • Bidder tricks {ds.bidderTrickPoints} • Non-bidder tricks {nonBidder}
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
    </div>
  );
}