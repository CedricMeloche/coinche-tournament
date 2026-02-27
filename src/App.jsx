import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Coinche Scorekeeper (Vite single-file App.jsx)
 * ✅ Admin view + Public view (read-only) + Table view (enter only your table match)
 * ✅ Unlimited players, teams, tables, matches (no pools/bracket/timer)
 * ✅ Team builder: manual OR randomize (respects locks) + avoid repeating pairs
 * ✅ Assign teams to tables (matches) + share unique Table links (code)
 * ✅ Hand Tracker (Fast Mode) with suit dropdown + icons, auto totals, edit past hands
 * ✅ Live Scoreboard + stats + fun facts (blowout, comeback, etc.)
 * ✅ Full width layout, bigger totals on Table view, leading team glows green
 * ✅ Select dropdown text is black for readability
 * ✅ Auto-backup every hand to Google Sheets (queue + retry)
 *
 * Routes (hash):
 *   #/admin
 *   #/public
 *   #/table?code=AB12
 */

const LS_KEY = "coinche_scorekeeper_vite_v1";

// === Google Sheets Web App (your link) ===
const GSHEET_WEBHOOK_URL =
  "https://script.google.com/macros/s/AKfycbz-ok_dxCTExzV6LA8NixK6nYnw03MhOBZ3M6SgP_Na5-hlrhnMLX3bIUYqqq5laguSHw/exec";

/**
 * OPTIONAL: If your Apps Script expects a secret, set it here AND in Apps Script.
 * If your Apps Script does NOT use a secret, leave it as "".
 */
const GSHEET_SECRET = "";

const DEVICE_ID_KEY = "coinche_device_id_v1";
const PENDING_QUEUE_KEY = "coinche_pending_sheets_queue_v1";

const TARGET_SCORE = 2000;

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

/** ===== Fast mode scoring helpers ===== */
function roundTrickPoints(x) {
  if (x == null) return 0;
  const n = clamp(Number(x) || 0, 0, 162);
  return Math.floor((n + 4) / 10) * 10;
}

/**
 * Fast mode compute
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

function fmtMMSS(sec) {
  const s = Math.max(0, Math.floor(sec));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

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

/** ===== Styles ===== */
const styles = {
  page: {
    minHeight: "100vh",
    width: "100vw",
    margin: 0,
    background:
      "radial-gradient(1200px 600px at 10% 10%, rgba(99,102,241,0.25), transparent 60%), radial-gradient(1200px 600px at 90% 10%, rgba(16,185,129,0.18), transparent 55%), radial-gradient(1200px 600px at 50% 90%, rgba(244,63,94,0.12), transparent 60%), linear-gradient(180deg, #0b1220 0%, #050814 100%)",
    color: "#e5e7eb",
    padding: 16,
    boxSizing: "border-box",
  },

  // Full width container (no narrow max width)
  container: {
    width: "100%",
    maxWidth: "100%",
    margin: "0 auto",
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

  // Dropdowns: black text for readability
  select: (w = 180) => ({
    width: typeof w === "number" ? `${w}px` : w,
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(148,163,184,0.22)",
    background: "rgba(255,255,255,0.92)",
    color: "#000",
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

  bigTotal: {
    fontSize: 44,
    fontWeight: 1000,
    letterSpacing: "-0.03em",
    lineHeight: 1,
  },

  glowLeader: {
    boxShadow: "0 0 24px rgba(34,197,94,0.35), 0 0 64px rgba(34,197,94,0.18)",
    borderColor: "rgba(34,197,94,0.45)",
  },
};

// Small inline keyframes (so you don’t need a CSS file)
function GlobalKeyframes() {
  return (
    <style>
      {`
      @keyframes scorePop {
        0% { transform: scale(1); filter: brightness(1); }
        35% { transform: scale(1.08); filter: brightness(1.15); }
        100% { transform: scale(1); filter: brightness(1); }
      }
      `}
    </style>
  );
}

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

function makeEmptyMatch({ tableId, tableName, teamAId, teamBId }) {
  const code = shortCode();
  return {
    id: uid("match"),
    code,
    tableId,
    label: tableName ? `${tableName}` : `Table`,
    teamAId: teamAId || "",
    teamBId: teamBId || "",
    hands: [],
    totalA: 0,
    totalB: 0,
    winnerId: null,
    completed: false,
    fastDraft: defaultFastDraft(),
    editingHandIdx: null,
    // for comeback stat
    timelineDiffs: [], // array of (totalA-totalB) after each hand
  };
}

/** ===== Main App ===== */
export default function App() {
  const [route, setRoute] = useState(() => parseHashRoute());
  const [loaded, setLoaded] = useState(false);

  const [tournamentName, setTournamentName] = useState("Coinche Scorekeeper");
  const [players, setPlayers] = useState([]); // {id,name}
  const [teams, setTeams] = useState([]); // {id,name,playerIds[], locked:boolean}
  const [avoidSameTeams, setAvoidSameTeams] = useState(true);
  const [pairHistory, setPairHistory] = useState([]); // ["p1|p2", ...]

  const [tables, setTables] = useState([]); // {id,name}
  const [matches, setMatches] = useState([]); // one match per table

  // UI helpers
  const [newPlayerName, setNewPlayerName] = useState("");
  const [newTableName, setNewTableName] = useState("");
  const [teamCount, setTeamCount] = useState(8);
  const playerInputRef = useRef(null);

  // Device id for backups
  const deviceId = useMemo(() => {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = `dev_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  }, []);

  // Route listener
  useEffect(() => {
    const onHash = () => setRoute(parseHashRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Load
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        setTournamentName(d.tournamentName ?? "Coinche Scorekeeper");
        setPlayers(d.players ?? []);
        setTeams(d.teams ?? []);
        setAvoidSameTeams(Boolean(d.avoidSameTeams ?? true));
        setPairHistory(d.pairHistory ?? []);
        setTables(d.tables ?? []);
        setMatches(d.matches ?? []);
        setTeamCount(Number.isFinite(d.teamCount) ? d.teamCount : 8);
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
        avoidSameTeams,
        pairHistory,
        tables,
        matches,
        teamCount,
      })
    );
  }, [loaded, tournamentName, players, teams, avoidSameTeams, pairHistory, tables, matches, teamCount]);

  // Maps
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

  /** ===== Backup queue to Google Sheets ===== */
  function enqueueBackup(payload) {
    try {
      const raw = localStorage.getItem(PENDING_QUEUE_KEY);
      const q = raw ? JSON.parse(raw) : [];
      q.push(payload);
      localStorage.setItem(PENDING_QUEUE_KEY, JSON.stringify(q));
    } catch {
      // ignore
    }
  }

  async function flushBackupQueue() {
    let q = [];
    try {
      const raw = localStorage.getItem(PENDING_QUEUE_KEY);
      q = raw ? JSON.parse(raw) : [];
    } catch {
      q = [];
    }
    if (!q.length) return;

    const keep = [];
    for (const payload of q) {
      try {
        const res = await fetch(GSHEET_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) keep.push(payload);
      } catch {
        keep.push(payload);
      }
    }
    localStorage.setItem(PENDING_QUEUE_KEY, JSON.stringify(keep));
  }

  // Flush periodically
  useEffect(() => {
    const id = setInterval(() => {
      flushBackupQueue();
    }, 15000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function recordHandBackup({ match, hand, teamAName, teamBName }) {
    const d = hand.draftSnapshot || {};
    const payload = {
      secret: GSHEET_SECRET || undefined,
      timestamp: new Date().toISOString(),
      tournamentName,
      matchCode: match.code,
      matchLabel: match.label,
      teamA: teamAName || "",
      teamB: teamBName || "",
      handIdx: hand.idx,
      scoreA: hand.scoreA,
      scoreB: hand.scoreB,
      bidder: d.bidder,
      bid: d.bid,
      suit: d.suit,
      coincheLevel: d.coincheLevel,
      capot: !!d.capot,
      bidderTrickPoints: d.bidderTrickPoints,
      announceA: d.announceA,
      announceB: d.announceB,
      beloteTeam: d.beloteTeam,
      bidderSucceeded: !!hand.bidderSucceeded,
      totalA: match.totalA,
      totalB: match.totalB,
      deviceId,
    };

    enqueueBackup(payload);
    // fire-and-forget flush attempt (queue remains if it fails)
    flushBackupQueue();
  }

  /** ===== Helpers ===== */
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

    const completed = totalA >= TARGET_SCORE || totalB >= TARGET_SCORE;

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
    };
  }

  function addPlayer() {
    const name = newPlayerName.trim();
    if (!name) return;
    setPlayers((prev) => [...prev, { id: uid("p"), name }]);
    setNewPlayerName("");
    setTimeout(() => playerInputRef.current?.focus?.(), 0);
  }
  function removePlayer(id) {
    setPlayers((prev) => prev.filter((p) => p.id !== id));
    // if they were used, keep teams but clear references
    setTeams((prev) =>
      prev.map((t) => ({ ...t, playerIds: (t.playerIds || []).filter((pid) => pid !== id) }))
    );
  }

  function ensureTeamSkeleton(count) {
    const n = clamp(count || 0, 2, 64);
    setTeams((prev) => {
      const next = [...prev];
      // trim
      if (next.length > n) next.length = n;
      // add
      while (next.length < n) {
        next.push({ id: uid("t"), name: `Team ${next.length + 1}`, playerIds: [], locked: false });
      }
      // rename defaults if empty
      return next.map((t, idx) => ({
        ...t,
        name: t.name?.trim() ? t.name : `Team ${idx + 1}`,
      }));
    });
    // matches might reference removed teams; sanitize
    setMatches((prev) =>
      prev.map((m) => ({
        ...m,
        teamAId: "",
        teamBId: "",
        hands: [],
        totalA: 0,
        totalB: 0,
        winnerId: null,
        completed: false,
        fastDraft: defaultFastDraft(),
        editingHandIdx: null,
        timelineDiffs: [],
      }))
    );
  }

  function toggleTeamLock(teamId, locked) {
    setTeams((prev) => prev.map((t) => (t.id === teamId ? { ...t, locked: !!locked } : t)));
  }
  function renameTeam(teamId, name) {
    setTeams((prev) => prev.map((t) => (t.id === teamId ? { ...t, name } : t)));
  }
  function setTeamPlayer(teamId, slotIdx, playerIdOrEmpty) {
    setTeams((prev) =>
      prev.map((t) => {
        if (t.id !== teamId) return t;
        const ids = [...(t.playerIds || [])];
        while (ids.length < 2) ids.push("");
        ids[slotIdx] = playerIdOrEmpty;

        // no duplicates within team
        if (ids[0] && ids[0] === ids[1]) {
          if (slotIdx === 0) ids[1] = "";
          else ids[0] = "";
        }
        return { ...t, playerIds: ids.filter(Boolean) };
      })
    );
  }

  function buildRandomTeams() {
    if (players.length < 2) return;

    const currentTeams = teams.length ? teams : (() => {
      const n = clamp(teamCount || 8, 2, 64);
      return Array.from({ length: n }, (_, i) => ({
        id: uid("t"),
        name: `Team ${i + 1}`,
        playerIds: [],
        locked: false,
      }));
    })();

    // locked playerIds
    const lockedPlayers = new Set();
    currentTeams.forEach((t) => {
      if (!t.locked) return;
      (t.playerIds || []).forEach((pid) => lockedPlayers.add(pid));
    });

    const available = players.map((p) => p.id).filter((pid) => !lockedPlayers.has(pid));
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
    const nextTeams = currentTeams.map((t) => ({ ...t, playerIds: [...(t.playerIds || [])] }));

    let pairIdx = 0;
    for (let i = 0; i < nextTeams.length; i++) {
      if (nextTeams[i].locked) continue;
      const pair = finalPairs[pairIdx] || [null, null];
      pairIdx++;
      nextTeams[i].playerIds = [pair[0], pair[1]].filter(Boolean);
    }

    const namedTeams = nextTeams.map((t, i) => {
      const pnames = (t.playerIds || []).map((pid) => playerById.get(pid)?.name).filter(Boolean);
      const base = `Team ${i + 1}`;
      const label = pnames.length ? `${base} — ${pnames.join(" / ")}` : base;
      return { ...t, name: t.name?.startsWith("Team ") ? label : t.name || label };
    });

    const newPairs = [];
    for (const t of namedTeams) {
      if ((t.playerIds || []).length === 2) newPairs.push([...t.playerIds].sort().join("|"));
    }

    setTeams(namedTeams);
    setPairHistory((prev) => Array.from(new Set([...prev, ...newPairs])));
    // matches unchanged; manual match assignment still valid
  }

  /** ===== Tables & Matches ===== */
  function addTable() {
    const name = (newTableName || "").trim();
    if (!name) return;
    const t = { id: uid("table"), name };
    setTables((prev) => [...prev, t]);
    setMatches((prev) => [...prev, makeEmptyMatch({ tableId: t.id, tableName: name })]);
    setNewTableName("");
  }

  function removeTable(tableId) {
    setTables((prev) => prev.filter((t) => t.id !== tableId));
    setMatches((prev) => prev.filter((m) => m.tableId !== tableId));
  }

  function renameTable(tableId, name) {
    setTables((prev) => prev.map((t) => (t.id === tableId ? { ...t, name } : t)));
    setMatches((prev) =>
      prev.map((m) =>
        m.tableId === tableId ? { ...m, label: name || m.label } : m
      )
    );
  }

  function setMatchTeams(matchId, key, value) {
    setMatches((prev) =>
      prev.map((m) => {
        if (m.id !== matchId) return m;
        const next = { ...m, [key]: value };
        // if teams change, clear hands to prevent mixing
        return recomputeMatch({
          ...next,
          hands: [],
          fastDraft: defaultFastDraft(),
          editingHandIdx: null,
        });
      })
    );
  }

  function regenerateMatchCode(matchId) {
    setMatches((prev) => prev.map((m) => (m.id === matchId ? { ...m, code: shortCode() } : m)));
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
            capot: !!d.capot,
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
      prev.map((m) =>
        m.id === matchId ? { ...m, editingHandIdx: null, fastDraft: defaultFastDraft() } : m
      )
    );
  }

  function clearMatchHands(matchId) {
    setMatches((prev) =>
      prev.map((m) =>
        m.id === matchId
          ? recomputeMatch({ ...m, hands: [], editingHandIdx: null, fastDraft: defaultFastDraft() })
          : m
      )
    );
  }

  function addOrSaveHand(matchId) {
    // We also need to send a backup payload: we’ll build it from the updated match+hand we compute inside.
    let backupToSend = null;

    setMatches((prev) =>
      prev.map((m) => {
        if (m.id !== matchId) return m;

        // Must have teams set
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
          capot: !!d.capot,
          bidderTrickPoints: trickVal,
          announceA: safeInt(d.announceA) ?? 0,
          announceB: safeInt(d.announceB) ?? 0,
          beloteTeam: d.beloteTeam || "NONE",
        });

        // editing
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
                capot: !!d.capot,
                bidderTrickPoints: trickVal,
                announceA: safeInt(d.announceA) ?? 0,
                announceB: safeInt(d.announceB) ?? 0,
                beloteTeam: d.beloteTeam || "NONE",
              },
              scoreA: res.scoreA,
              scoreB: res.scoreB,
              bidderSucceeded: res.bidderSucceeded,
              updatedAt: Date.now(),
            };
          });

          const nextMatch = recomputeMatch({
            ...m,
            hands: nextHands,
            fastDraft: defaultFastDraft(),
            editingHandIdx: null,
          });

          // backup: store the edited hand row as well (latest snapshot)
          const edited = nextHands.find((h) => h.idx === m.editingHandIdx);
          if (edited) {
            backupToSend = { match: nextMatch, hand: edited };
          }

          return nextMatch;
        }

        // normal add: don't add after match ended
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
            capot: !!d.capot,
            bidderTrickPoints: trickVal,
            announceA: safeInt(d.announceA) ?? 0,
            announceB: safeInt(d.announceB) ?? 0,
            beloteTeam: d.beloteTeam || "NONE",
          },
          scoreA: res.scoreA,
          scoreB: res.scoreB,
          bidderSucceeded: res.bidderSucceeded,
        };

        const nextMatch = recomputeMatch({
          ...m,
          hands: [...(m.hands || []), nextHand],
          fastDraft: defaultFastDraft(),
        });

        backupToSend = { match: nextMatch, hand: nextHand };
        return nextMatch;
      })
    );

    // Send backup (outside state setter)
    // NOTE: we used closure variable backupToSend which is set synchronously above.
    setTimeout(() => {
      if (!backupToSend) return;
      const { match, hand } = backupToSend;
      const teamAName = teamById.get(match.teamAId)?.name ?? "";
      const teamBName = teamById.get(match.teamBId)?.name ?? "";
      recordHandBackup({ match, hand, teamAName, teamBName });
    }, 0);
  }

  /** ===== Export CSV / JSON ===== */
  function exportCSV() {
    const rows = [];
    const push = (obj) => rows.push(obj);

    push({ TYPE: "META", tournamentName, date: new Date().toISOString() });

    teams.forEach((t, idx) => {
      const pnames = (t.playerIds || [])
        .map((pid) => playerById.get(pid)?.name)
        .filter(Boolean)
        .join(" / ");
      push({
        TYPE: "TEAM",
        teamNumber: idx + 1,
        teamId: t.id,
        teamName: t.name,
        players: pnames,
        locked: t.locked ? "YES" : "NO",
      });
    });

    tables.forEach((tb) => push({ TYPE: "TABLE", tableId: tb.id, tableName: tb.name }));

    matches.forEach((m) => {
      const ta = teamById.get(m.teamAId)?.name ?? "";
      const tb = teamById.get(m.teamBId)?.name ?? "";
      push({
        TYPE: "MATCH",
        matchId: m.id,
        code: m.code,
        table: m.label,
        teamA: ta,
        teamB: tb,
        totalA: m.totalA ?? 0,
        totalB: m.totalB ?? 0,
        winner: m.winnerId ? teamById.get(m.winnerId)?.name ?? "" : "",
        completed: m.completed ? "YES" : "NO",
      });

      (m.hands || []).forEach((h) => {
        const d = h.draftSnapshot || {};
        push({
          TYPE: "HAND",
          matchId: m.id,
          code: m.code,
          table: m.label,
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
    });

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
    a.download = "coinche_export.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function exportJSON() {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            tournamentName,
            players,
            teams,
            avoidSameTeams,
            pairHistory,
            tables,
            matches,
            exportedAt: new Date().toISOString(),
          },
          null,
          2
        ),
      ],
      { type: "application/json;charset=utf-8" }
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "coinche_backup.json";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function importJSONFromFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const d = JSON.parse(String(reader.result || "{}"));
        setTournamentName(d.tournamentName ?? "Coinche Scorekeeper");
        setPlayers(d.players ?? []);
        setTeams(d.teams ?? []);
        setAvoidSameTeams(Boolean(d.avoidSameTeams ?? true));
        setPairHistory(d.pairHistory ?? []);
        setTables(d.tables ?? []);
        setMatches(d.matches ?? []);
      } catch {
        alert("Invalid JSON backup file.");
      }
    };
    reader.readAsText(file);
  }

  /** ===== Links ===== */
  const publicLink = useMemo(
    () => `${window.location.origin}${window.location.pathname}#/public`,
    []
  );
  const tableLinks = useMemo(() => {
    return matches.map((m) => ({
      label: m.label,
      code: m.code,
      href: `${window.location.origin}${window.location.pathname}#/table?code=${m.code}`,
    }));
  }, [matches]);

  /** ===== Scoreboard + stats ===== */
  const scoreboardRows = useMemo(() => {
    // Aggregate per-team totals across all matches
    const rows = teams.map((t) => ({
      teamId: t.id,
      name: t.name,
      matchesPlayed: 0,
      matchesWon: 0,
      matchesLost: 0,
      totalPointsFor: 0,
      totalPointsAgainst: 0,
      handsPlayed: 0,
    }));

    const byId = new Map(rows.map((r) => [r.teamId, r]));

    for (const m of matches) {
      if (!m.teamAId || !m.teamBId) continue;

      const a = byId.get(m.teamAId);
      const b = byId.get(m.teamBId);
      if (!a || !b) continue;

      const hands = (m.hands || []).length;
      a.handsPlayed += hands;
      b.handsPlayed += hands;

      a.totalPointsFor += Number(m.totalA) || 0;
      a.totalPointsAgainst += Number(m.totalB) || 0;
      b.totalPointsFor += Number(m.totalB) || 0;
      b.totalPointsAgainst += Number(m.totalA) || 0;

      // count match only if at least one hand exists
      if (hands > 0) {
        a.matchesPlayed += 1;
        b.matchesPlayed += 1;
      }

      if (m.completed && m.winnerId) {
        if (m.winnerId === m.teamAId) {
          a.matchesWon += 1;
          b.matchesLost += 1;
        } else if (m.winnerId === m.teamBId) {
          b.matchesWon += 1;
          a.matchesLost += 1;
        }
      }
    }

    return [...rows].sort((x, y) => {
      if (y.matchesWon !== x.matchesWon) return y.matchesWon - x.matchesWon;
      const diffY = (y.totalPointsFor - y.totalPointsAgainst) || 0;
      const diffX = (x.totalPointsFor - x.totalPointsAgainst) || 0;
      if (diffY !== diffX) return diffY - diffX;
      return x.name.localeCompare(y.name);
    });
  }, [teams, matches]);

  const funStats = useMemo(() => {
    const completed = matches.filter((m) => m.completed && m.teamAId && m.teamBId);

    // Biggest blowout: largest final point diff
    let biggestBlowout = { diff: 0, label: "—" };
    for (const m of completed) {
      const diff = Math.abs((m.totalA || 0) - (m.totalB || 0));
      if (diff > biggestBlowout.diff) {
        const ta = teamById.get(m.teamAId)?.name ?? "Team A";
        const tb = teamById.get(m.teamBId)?.name ?? "Team B";
        biggestBlowout = { diff, label: `${ta} vs ${tb} (${m.label})` };
      }
    }

    // Closest match
    let closest = { diff: Infinity, label: "—" };
    for (const m of completed) {
      const diff = Math.abs((m.totalA || 0) - (m.totalB || 0));
      if (diff > 0 && diff < closest.diff) {
        const ta = teamById.get(m.teamAId)?.name ?? "Team A";
        const tb = teamById.get(m.teamBId)?.name ?? "Team B";
        closest = { diff, label: `${ta} vs ${tb} (${m.label})` };
      }
    }
    if (!Number.isFinite(closest.diff)) closest = { diff: 0, label: "—" };

    // Best comeback: winner had the largest negative (or positive) deficit at any point and still won
    let bestComeback = { deficit: 0, label: "—" };
    for (const m of completed) {
      const diffs = m.timelineDiffs || [];
      if (!diffs.length) continue;

      const winnerIsA = m.winnerId === m.teamAId;
      // If A won, comeback is the minimum (most negative) diff during match.
      // If B won, comeback is the maximum (most positive) diff during match (A was leading).
      const deficit = winnerIsA ? Math.min(0, ...diffs) : Math.max(0, ...diffs);
      const comebackSize = Math.abs(deficit);

      if (comebackSize > bestComeback.deficit) {
        const ta = teamById.get(m.teamAId)?.name ?? "Team A";
        const tb = teamById.get(m.teamBId)?.name ?? "Team B";
        bestComeback = { deficit: comebackSize, label: `${ta} vs ${tb} (${m.label})` };
      }
    }

    // Funny stats (3 extra fun facts): coinche king, capot hero, belote magnet
    const teamFun = new Map(); // teamId -> {coinches,surcoinches,capots,belotes}
    const bump = (tid, key, n = 1) => {
      if (!tid) return;
      const cur = teamFun.get(tid) || { coinches: 0, surcoinches: 0, capots: 0, belotes: 0 };
      cur[key] = (cur[key] || 0) + n;
      teamFun.set(tid, cur);
    };

    for (const m of completed) {
      for (const h of m.hands || []) {
        const d = h.draftSnapshot || {};
        const bidderTeamId = d.bidder === "A" ? m.teamAId : m.teamBId;
        if (d.coincheLevel === "COINCHE") bump(bidderTeamId, "coinches");
        if (d.coincheLevel === "SURCOINCHE") bump(bidderTeamId, "surcoinches");
        if (d.capot) bump(bidderTeamId, "capots");
        if (d.beloteTeam === "A") bump(m.teamAId, "belotes");
        if (d.beloteTeam === "B") bump(m.teamBId, "belotes");
      }
    }

    const leader = (key) => {
      let best = null;
      for (const [tid, obj] of teamFun.entries()) {
        const v = obj[key] || 0;
        if (!best || v > best.v) best = { tid, v };
      }
      if (!best || best.v === 0) return { name: "—", v: 0 };
      return { name: teamById.get(best.tid)?.name ?? "—", v: best.v };
    };

    return {
      biggestBlowout,
      bestComeback,
      closest,
      coincheKing: leader("coinches"),
      capotHero: leader("capots"),
      beloteMagnet: leader("belotes"),
    };
  }, [matches, teamById]);

  /** ===== Table view match resolve ===== */
  const { path, query } = route;

  const tableMatch = useMemo(() => {
    const code = (query.code || "").toUpperCase();
    if (!code) return null;
    return matches.find((m) => (m.code || "").toUpperCase() === code) || null;
  }, [query.code, matches]);

  /** ===== Nav pills ===== */
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
    </div>
  );

  /** ===== Public View ===== */
  if (path === "/public") {
    return (
      <div style={styles.page}>
        <GlobalKeyframes />
        <div style={styles.container}>
          <div style={styles.topbar}>
            <div>
              <h1 style={styles.title}>{tournamentName}</h1>
              <div style={styles.subtitle}>Public scoreboard • Live updates</div>
            </div>
            <NavPills showAdmin={true} />
          </div>

          <div style={styles.grid2}>
            <Section title="Live Scoreboard">
              <ScoreboardTable rows={scoreboardRows} />
            </Section>

            <Section title="Fun Facts">
              <div style={styles.grid3}>
                <StatCard label="Biggest Blowout" value={`${funStats.biggestBlowout.diff} pts`} sub={funStats.biggestBlowout.label} />
                <StatCard label="Best Comeback" value={`${funStats.bestComeback.deficit} pts`} sub={funStats.bestComeback.label} />
                <StatCard label="Closest Match" value={`${funStats.closest.diff} pts`} sub={funStats.closest.label} />
                <StatCard label="Coinche King" value={funStats.coincheKing.name} sub={`${funStats.coincheKing.v} coinches`} />
                <StatCard label="Capot Hero" value={funStats.capotHero.name} sub={`${funStats.capotHero.v} capots`} />
                <StatCard label="Belote Magnet" value={funStats.beloteMagnet.name} sub={`${funStats.beloteMagnet.v} belotes`} />
              </div>
            </Section>
          </div>

          <Section title="Table Entry Links (share to each table)">
            <div style={{ color: "#94a3b8", fontSize: 12, marginBottom: 10 }}>
              Each table has a unique link to enter hands/scores.
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
              {tableLinks.length === 0 ? <div style={styles.small}>Add tables in Admin to generate table links.</div> : null}
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
        <GlobalKeyframes />
        <div style={styles.container}>
          <div style={styles.topbar}>
            <div>
              <h1 style={styles.title}>{tournamentName}</h1>
              <div style={styles.subtitle}>Table View • Enter hands for your match only</div>
            </div>
            <NavPills showAdmin={true} />
          </div>

          {!tableMatch ? (
            <Section title="No match found">
              <div style={styles.small}>This table link is missing or incorrect. Ask the organizer for the correct code.</div>
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
                bigTotals={true}
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
      <GlobalKeyframes />
      <div style={styles.container}>
        <div style={styles.topbar}>
          <div>
            <h1 style={styles.title}>{tournamentName}</h1>
            <div style={styles.subtitle}>
              Admin • Setup players/teams • Create tables • Assign matches • Share links • Export backups
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
              <button style={styles.btnSecondary} onClick={exportJSON}>
                Export JSON Backup
              </button>
              <label style={{ ...styles.btnSecondary, cursor: "pointer" }}>
                Import JSON
                <input
                  type="file"
                  accept="application/json"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) importJSONFromFile(f);
                    e.target.value = "";
                  }}
                />
              </label>
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
          <div style={{ marginTop: 10, ...styles.small }}>
            Google Sheets backup: queued writes are stored locally and retried every ~15s automatically.
          </div>
          <div style={{ marginTop: 8, display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button style={styles.btnSecondary} onClick={flushBackupQueue}>
              Flush GoogleSheet Queue Now
            </button>
            <button
              style={styles.btnSecondary}
              onClick={() => {
                const raw = localStorage.getItem(PENDING_QUEUE_KEY);
                const count = raw ? (JSON.parse(raw) || []).length : 0;
                alert(`Pending queued rows: ${count}`);
              }}
            >
              Check Pending Queue
            </button>
          </div>
        </Section>

        <Section title="Settings">
          <div style={styles.grid3}>
            <div style={styles.card}>
              <div style={styles.small}>Tournament name</div>
              <input
                style={styles.input("100%")}
                value={tournamentName}
                onChange={(e) => setTournamentName(e.target.value)}
              />
            </div>

            <div style={styles.card}>
              <div style={styles.small}>Team slots</div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <input
                  style={styles.input(140)}
                  value={String(teamCount)}
                  onChange={(e) => setTeamCount(Number(e.target.value || 0))}
                  inputMode="numeric"
                />
                <button style={styles.btnSecondary} onClick={() => ensureTeamSkeleton(teamCount)}>
                  Apply Team Count
                </button>
              </div>
              <div style={{ marginTop: 8, ...styles.small }}>Tip: 8 teams is great for 16 players.</div>
            </div>

            <div style={styles.card}>
              <div style={styles.small}>Pairing randomizer</div>
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 900 }}>
                <input
                  type="checkbox"
                  checked={avoidSameTeams}
                  onChange={(e) => setAvoidSameTeams(e.target.checked)}
                />
                Avoid repeating pairs
              </label>
              <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button style={styles.btnSecondary} onClick={buildRandomTeams} disabled={players.length < 2 || teams.length < 2}>
                  Randomize Teams (respects locks)
                </button>
              </div>
            </div>
          </div>
        </Section>

        <Section title={`Players (${players.length})`}>
          <div style={styles.row}>
            <input
              ref={playerInputRef}
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
                <div style={{ fontWeight: 950, display: "flex", justifyContent: "space-between", gap: 10 }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
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

        <Section title={`Teams (${teams.length})`}>
          {teams.length < 2 ? (
            <div style={styles.small}>Set team slots above, then assign players manually or randomize.</div>
          ) : (
            <>
              <div style={{ ...styles.small, marginBottom: 10 }}>
                Manual assignment: pick players for each team (prevents overlap). Use <b>Lock</b> to keep a team fixed when randomizing.
              </div>

              <div style={styles.grid2}>
                {teams.map((t, idx) => (
                  <div key={t.id} style={styles.card}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                      <div style={{ fontWeight: 950 }}>Team #{idx + 1}</div>
                      <label
                        style={{
                          display: "flex",
                          gap: 8,
                          alignItems: "center",
                          fontWeight: 900,
                          color: t.locked ? "#34d399" : "#94a3b8",
                        }}
                      >
                        <input type="checkbox" checked={!!t.locked} onChange={(e) => toggleTeamLock(t.id, e.target.checked)} />
                        Lock
                      </label>
                    </div>

                    <div style={{ marginTop: 10 }}>
                      <div style={styles.small}>Team name</div>
                      <input style={styles.input("100%")} value={t.name} onChange={(e) => renameTeam(t.id, e.target.value)} />
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
                            const taken = usedPlayerIds.has(p.id) && !(t.playerIds || []).includes(p.id);
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
            </>
          )}
        </Section>

        <Section title={`Tables (${tables.length})`}>
          <div style={styles.row}>
            <input
              style={styles.input(260)}
              value={newTableName}
              onChange={(e) => setNewTableName(e.target.value)}
              placeholder="Add table name (ex: Table 1)"
              onKeyDown={(e) => {
                if (e.key === "Enter") addTable();
              }}
            />
            <button style={styles.btnPrimary} onClick={addTable} disabled={!newTableName.trim()}>
              Add Table
            </button>
          </div>

          <div style={{ marginTop: 12, ...styles.grid3 }}>
            {tables.map((t) => (
              <div key={t.id} style={styles.card}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                  <div style={{ fontWeight: 950 }}>{t.name}</div>
                  <button style={styles.btnDanger} onClick={() => removeTable(t.id)}>
                    Remove
                  </button>
                </div>
                <div style={{ marginTop: 10 }}>
                  <div style={styles.small}>Rename table</div>
                  <input
                    style={styles.input("100%")}
                    value={t.name}
                    onChange={(e) => renameTable(t.id, e.target.value)}
                  />
                </div>
              </div>
            ))}
            {tables.length === 0 ? <div style={styles.small}>Add tables to create matches and table links.</div> : null}
          </div>
        </Section>

        <Section title="Matches (assign teams to each table)">
          {matches.length === 0 ? (
            <div style={styles.small}>No matches yet. Add tables above.</div>
          ) : (
            <div style={styles.grid2}>
              {matches.map((m) => (
                <div key={m.id} style={styles.card}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                    <div style={{ fontWeight: 950 }}>{m.label}</div>
                    <span style={styles.tag}>Code: {m.code}</span>
                  </div>

                  <div style={{ marginTop: 10, ...styles.grid2 }}>
                    <div>
                      <div style={styles.small}>Team A</div>
                      <select
                        style={styles.select("100%")}
                        value={m.teamAId || ""}
                        onChange={(e) => setMatchTeams(m.id, "teamAId", e.target.value)}
                      >
                        <option value="">— Select —</option>
                        {teams.map((t) => (
                          <option key={t.id} value={t.id}>
                            #{teamNumberById.get(t.id)} {t.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <div style={styles.small}>Team B</div>
                      <select
                        style={styles.select("100%")}
                        value={m.teamBId || ""}
                        onChange={(e) => setMatchTeams(m.id, "teamBId", e.target.value)}
                      >
                        <option value="">— Select —</option>
                        {teams.map((t) => (
                          <option key={t.id} value={t.id}>
                            #{teamNumberById.get(t.id)} {t.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <a
                      href={`${window.location.origin}${window.location.pathname}#/table?code=${m.code}`}
                      style={{ ...styles.btnSecondary, textDecoration: "none" }}
                    >
                      Open Table View
                    </a>
                    <button style={styles.btnSecondary} onClick={() => regenerateMatchCode(m.id)}>
                      Regenerate Code
                    </button>
                    <button
                      style={styles.btnSecondary}
                      onClick={() => {
                        const href = `${window.location.origin}${window.location.pathname}#/table?code=${m.code}`;
                        navigator.clipboard?.writeText(href);
                        alert(`Copied link for ${m.label}`);
                      }}
                    >
                      Copy Link
                    </button>
                    <button style={styles.btnSecondary} onClick={() => clearMatchHands(m.id)}>
                      Clear Hands
                    </button>
                  </div>

                  <div style={{ marginTop: 10, ...styles.small }}>
                    Current total: <b style={{ color: "#e5e7eb" }}>{m.totalA}</b> – <b style={{ color: "#e5e7eb" }}>{m.totalB}</b>{" "}
                    {m.completed ? <span style={{ color: "#34d399", fontWeight: 900 }}> • Completed</span> : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="Scoreboard + Fun Facts (Live)">
          <div style={styles.grid2}>
            <div style={styles.card}>
              <div style={{ fontWeight: 950, marginBottom: 8 }}>Live Scoreboard</div>
              <ScoreboardTable rows={scoreboardRows} />
            </div>
            <div style={styles.card}>
              <div style={{ fontWeight: 950, marginBottom: 8 }}>Fun Facts</div>
              <div style={styles.grid3}>
                <StatCard label="Biggest Blowout" value={`${funStats.biggestBlowout.diff} pts`} sub={funStats.biggestBlowout.label} />
                <StatCard label="Best Comeback" value={`${funStats.bestComeback.deficit} pts`} sub={funStats.bestComeback.label} />
                <StatCard label="Closest Match" value={`${funStats.closest.diff} pts`} sub={funStats.closest.label} />
                <StatCard label="Coinche King" value={funStats.coincheKing.name} sub={`${funStats.coincheKing.v} coinches`} />
                <StatCard label="Capot Hero" value={funStats.capotHero.name} sub={`${funStats.capotHero.v} capots`} />
                <StatCard label="Belote Magnet" value={funStats.beloteMagnet.name} sub={`${funStats.beloteMagnet.v} belotes`} />
              </div>
            </div>
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
            {["Rank", "Team", "W", "L", "Matches", "Hands", "For", "Against", "+/-"].map((h) => (
              <th
                key={h}
                style={{
                  textAlign: "left",
                  padding: "10px 10px",
                  fontSize: 12,
                  color: "#94a3b8",
                  borderBottom: "1px solid rgba(148,163,184,0.18)",
                  whiteSpace: "nowrap",
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const diff = (r.totalPointsFor || 0) - (r.totalPointsAgainst || 0);
            return (
              <tr key={r.teamId}>
                <td style={{ padding: "10px 10px", borderBottom: "1px solid rgba(148,163,184,0.10)", fontWeight: 950 }}>
                  #{i + 1}
                </td>
                <td style={{ padding: "10px 10px", borderBottom: "1px solid rgba(148,163,184,0.10)", fontWeight: 900 }}>
                  {r.name}
                </td>
                <td style={{ padding: "10px 10px", borderBottom: "1px solid rgba(148,163,184,0.10)", fontWeight: 900 }}>
                  {r.matchesWon}
                </td>
                <td style={{ padding: "10px 10px", borderBottom: "1px solid rgba(148,163,184,0.10)", fontWeight: 900 }}>
                  {r.matchesLost}
                </td>
                <td style={{ padding: "10px 10px", borderBottom: "1px solid rgba(148,163,184,0.10)", fontWeight: 900 }}>
                  {r.matchesPlayed}
                </td>
                <td style={{ padding: "10px 10px", borderBottom: "1px solid rgba(148,163,184,0.10)", fontWeight: 900 }}>
                  {r.handsPlayed}
                </td>
                <td style={{ padding: "10px 10px", borderBottom: "1px solid rgba(148,163,184,0.10)", fontWeight: 900 }}>
                  {r.totalPointsFor}
                </td>
                <td style={{ padding: "10px 10px", borderBottom: "1px solid rgba(148,163,184,0.10)", fontWeight: 900 }}>
                  {r.totalPointsAgainst}
                </td>
                <td
                  style={{
                    padding: "10px 10px",
                    borderBottom: "1px solid rgba(148,163,184,0.10)",
                    fontWeight: 950,
                    color: diff >= 0 ? "#34d399" : "#fb7185",
                  }}
                >
                  {diff >= 0 ? `+${diff}` : `${diff}`}
                </td>
              </tr>
            );
          })}
          {rows.length === 0 ? (
            <tr>
              <td colSpan={9} style={{ padding: 12, color: "#94a3b8" }}>
                No data yet.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
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
  bigTotals = false,
}) {
  const ta = teamById.get(match.teamAId)?.name ?? "TBD";
  const tb = teamById.get(match.teamBId)?.name ?? "TBD";

  const numA = match.teamAId ? teamNumberById?.get(match.teamAId) ?? "?" : "?";
  const numB = match.teamBId ? teamNumberById?.get(match.teamBId) ?? "?" : "?";

  const pctA = Math.min(100, Math.round(((match.totalA || 0) / TARGET_SCORE) * 100));
  const pctB = Math.min(100, Math.round(((match.totalB || 0) / TARGET_SCORE) * 100));

  const canPlay = !!match.teamAId && !!match.teamBId;

  const d = match.fastDraft || defaultFastDraft();

  // Leading team glow
  const aLeads = (match.totalA || 0) > (match.totalB || 0);
  const bLeads = (match.totalB || 0) > (match.totalA || 0);

  // Animate score when it updates
  const [animA, setAnimA] = useState(false);
  const [animB, setAnimB] = useState(false);
  const prevTotalsRef = useRef({ a: match.totalA || 0, b: match.totalB || 0 });

  useEffect(() => {
    const prev = prevTotalsRef.current;
    const aNow = match.totalA || 0;
    const bNow = match.totalB || 0;

    if (aNow !== prev.a) {
      setAnimA(true);
      setTimeout(() => setAnimA(false), 420);
    }
    if (bNow !== prev.b) {
      setAnimB(true);
      setTimeout(() => setAnimB(false), 420);
    }

    prevTotalsRef.current = { a: aNow, b: bNow };
  }, [match.totalA, match.totalB]);

  return (
    <div style={{ ...styles.card, borderRadius: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
        <div style={{ fontWeight: 950 }}>
          {match.label} <span style={styles.small}>• Code {match.code}</span>
        </div>
        <div style={{ color: match.completed ? "#34d399" : "#94a3b8", fontWeight: 950 }}>
          {match.completed ? `Winner: ${teamById.get(match.winnerId)?.name ?? "—"}` : "Live"}
        </div>
      </div>

      <div style={{ marginTop: 10, ...styles.grid2 }}>
        <div style={{ ...styles.card, ...(aLeads ? styles.glowLeader : {}) }}>
          <div style={{ fontWeight: 900, marginBottom: 6 }}>{`Team #${numA}: ${ta}`}</div>

          <div style={styles.small}>Total</div>
          <div
            style={{
              ...(bigTotals ? styles.bigTotal : { fontSize: 28, fontWeight: 1000 }),
              animation: animA ? "scorePop 420ms ease-out" : "none",
            }}
          >
            {match.totalA}
          </div>

          <div style={{ marginTop: 8, ...styles.small }}>
            / {TARGET_SCORE}
          </div>

          <div style={{ marginTop: 10, ...styles.progressWrap }}>
            <div style={styles.progressFillA(pctA)} />
          </div>
        </div>

        <div style={{ ...styles.card, ...(bLeads ? styles.glowLeader : {}) }}>
          <div style={{ fontWeight: 900, marginBottom: 6 }}>{`Team #${numB}: ${tb}`}</div>

          <div style={styles.small}>Total</div>
          <div
            style={{
              ...(bigTotals ? styles.bigTotal : { fontSize: 28, fontWeight: 1000 }),
              animation: animB ? "scorePop 420ms ease-out" : "none",
            }}
          >
            {match.totalB}
          </div>

          <div style={{ marginTop: 8, ...styles.small }}>
            / {TARGET_SCORE}
          </div>

          <div style={{ marginTop: 10, ...styles.progressWrap }}>
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
          {match.editingHandIdx ? <span style={styles.tag}>Editing Hand {match.editingHandIdx}</span> : <span style={styles.tag}>New Hand</span>}
        </div>

        <div style={styles.handGrid}>
          <div>
            <div style={styles.small}>Bidder</div>
            <select style={styles.select("100%")} value={d.bidder} onChange={(e) => onDraftPatch({ bidder: e.target.value })} disabled={!canPlay}>
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
            <select style={styles.select("100%")} value={d.suit || "S"} onChange={(e) => onDraftPatch({ suit: e.target.value })} disabled={!canPlay}>
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
                    <span style={styles.tag}>+{h.scoreA} / +{h.scoreB}</span>
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

      <div style={{ marginTop: 12, ...styles.small }}>
        Each hand is auto-saved locally and queued to Google Sheets (auto retry).
      </div>
    </div>
  );
}