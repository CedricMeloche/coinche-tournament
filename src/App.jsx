import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Coinche Scorekeeper (Vite single-file App.jsx)
 * ✅ Admin view (edit everything)
 * ✅ Public view (read-only scoreboard + fun stats)
 * ✅ Table view (per-table entry link, only that match)
 * ✅ Add unlimited players, teams, and tables/matches
 * ✅ Fast-mode Hand Tracker (same logic)
 * ✅ Live scoreboard + fun stats (Biggest blowout, best comeback, closest match,
 *    Clutch Finish, Momentum Monster, Perfect Defense, Coinche King, Capot Hero, Belote Magnet)
 * ✅ Full-screen layout (wide)
 * ✅ Dropdowns / inputs use black text for readability
 * ✅ Table view: bigger totals + leader glow + animated score updates
 * ✅ Auto-backup to your Google Sheets Web App (fires on every change + retries)
 *
 * Routes (URL hash):
 *   #/admin
 *   #/public
 *   #/table?code=AB12
 */

const LS_KEY = "coinche_scorekeeper_v1";
const TARGET_SCORE = 2000;

// Your Google Apps Script Web App endpoint:
const BACKUP_URL =
  "https://script.google.com/macros/s/AKfycbz-ok_dxCTExzV6LA8NixK6nYnw03MhOBZ3M6SgP_Na5-hlrhnMLX3bIUYqqq5laguSHw/exec";

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
 * Fast mode compute (kept from your version)
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
  // FULL SCREEN / WIDE:
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

  // BLACK TEXT for inputs/selects (your request)
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

  leaderGlow: {
    boxShadow: "0 0 20px rgba(34,197,94,0.35), 0 0 50px rgba(34,197,94,0.18)",
    border: "1px solid rgba(34,197,94,0.35)",
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

/** ===== Main App ===== */
export default function App() {
  const [route, setRoute] = useState(() => parseHashRoute());

  const [loaded, setLoaded] = useState(false);

  // Core data
  const [appName, setAppName] = useState("Coinche Scorekeeper");
  const [players, setPlayers] = useState([]); // {id,name}
  const [teams, setTeams] = useState([]); // {id,name,playerIds[], locked:boolean}
  const [avoidSameTeams, setAvoidSameTeams] = useState(true);
  const [pairHistory, setPairHistory] = useState([]); // ["p1|p2", ...]

  // Tables/Matches
  // match = {id, code, tableName, teamAId, teamBId, label, hands[], totalA,totalB, completed,winnerId, fastDraft, editingHandIdx, timelineDiffs[] }
  const [matches, setMatches] = useState([]);

  // UI
  const [newPlayerName, setNewPlayerName] = useState("");
  const [newTeamName, setNewTeamName] = useState("");
  const [newTableName, setNewTableName] = useState("Table 1");
  const [newMatchLabel, setNewMatchLabel] = useState("Match 1");

  const inputRef = useRef(null);

  // Backup queue
  const [backupState, setBackupState] = useState({ lastOk: null, lastErr: null, queued: 0 });
  const backupTimerRef = useRef(null);
  const pendingBackupRef = useRef(false);
  const lastBackupHashRef = useRef("");

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
    scheduleBackup(payload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  /** ===== Backup (Google Sheets Web App) =====
   * Sends full state snapshot. We debounce to avoid hammering.
   * Also retries if offline / network fails.
   */
  function stableStringify(obj) {
    return JSON.stringify(obj);
  }

  function scheduleBackup(payload) {
    // Hash the payload to avoid resending identical snapshot spam
    const hash = stableStringify({
      appName: payload.appName,
      playersLen: payload.players?.length || 0,
      teamsLen: payload.teams?.length || 0,
      matchesLen: payload.matches?.length || 0,
      savedAt: payload.savedAt,
      // include lastUpdatedAt from matches to reflect real changes
      lastUpdatedAtMax: Math.max(0, ...(payload.matches || []).map((m) => m.lastUpdatedAt || 0)),
    });

    if (hash === lastBackupHashRef.current) return;
    lastBackupHashRef.current = hash;

    pendingBackupRef.current = true;

    if (backupTimerRef.current) clearTimeout(backupTimerRef.current);
    backupTimerRef.current = setTimeout(() => {
      void flushBackup(payload);
    }, 600); // debounce
  }

  async function flushBackup(payload) {
    if (!pendingBackupRef.current) return;
    pendingBackupRef.current = false;

    try {
      const res = await fetch(BACKUP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // include a type so your Apps Script can route it
        body: JSON.stringify({ type: "SNAPSHOT", payload }),
      });
      // Some Apps Script responses are 302/redirect-ish; treat ok-ish if 200-399
      if (!res.ok && (res.status < 200 || res.status >= 400)) {
        throw new Error(`Backup HTTP ${res.status}`);
      }

      setBackupState((s) => ({ ...s, lastOk: Date.now(), lastErr: null, queued: 0 }));
    } catch (e) {
      // Retry later
      setBackupState((s) => ({
        ...s,
        lastErr: Date.now(),
        queued: (s.queued || 0) + 1,
      }));

      // re-arm retry
      pendingBackupRef.current = true;
      if (backupTimerRef.current) clearTimeout(backupTimerRef.current);
      backupTimerRef.current = setTimeout(() => {
        void flushBackup({
          appName,
          players,
          teams,
          avoidSameTeams,
          pairHistory,
          matches,
          savedAt: Date.now(),
        });
      }, 2500);
    }
  }

  useEffect(() => {
    // try again when coming back online
    const onOnline = () => {
      if (pendingBackupRef.current) {
        void flushBackup({
          appName,
          players,
          teams,
          avoidSameTeams,
          pairHistory,
          matches,
          savedAt: Date.now(),
        });
      }
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appName, players, teams, avoidSameTeams, pairHistory, matches]);

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
    // reset teams & matches if roster changes (safer)
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
    // remove team from matches
    setMatches((prev) =>
      prev.map((m) => {
        const next = { ...m };
        if (next.teamAId === teamId) next.teamAId = null;
        if (next.teamBId === teamId) next.teamBId = null;
        return recomputeMatch({ ...next, hands: [] });
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

    // Ensure even pairing: if odd players, last will be alone.
    const lockedPlayers = new Set();
    teams.forEach((t) => {
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
      if ((t.playerIds || []).length === 2) newPairs.push([...t.playerIds].sort().join("|"));
    }

    setTeams(nextTeams);
    setPairHistory((prev) => Array.from(new Set([...prev, ...newPairs])));
    // Keep matches, but reset hands (safer if teams changed)
    setMatches((prev) => prev.map((m) => recomputeMatch({ ...m, hands: [] })));
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
        // reset hands when teams change
        return recomputeMatch({ ...next, hands: [], editingHandIdx: null, fastDraft: defaultFastDraft() });
      })
    );
  }

  function renameMatch(matchId, patch) {
    setMatches((prev) =>
      prev.map((m) => (m.id === matchId ? { ...m, ...patch, lastUpdatedAt: Date.now() } : m))
    );
  }

  /** ===== Hand tracker for a match ===== */
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
      prev.map((m) =>
        m.id === matchId ? { ...m, editingHandIdx: null, fastDraft: defaultFastDraft() } : m
      )
    );
  }

  function addOrSaveHand(matchId) {
    setMatches((prev) =>
      prev.map((m) => {
        if (m.id !== matchId) return m;

        const canPlay = !!m.teamAId && !!m.teamBId;
        if (!canPlay) return m;

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
            hands: nextHands,
            fastDraft: defaultFastDraft(),
            editingHandIdx: null,
          });
        }

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

        return recomputeMatch({
          ...m,
          hands: [...(m.hands || []), nextHand],
          fastDraft: defaultFastDraft(),
        });
      })
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

  /** ===== Fun stats ===== */
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

    // Best comeback: winner had the largest deficit at any point and still won
    let bestComeback = { deficit: 0, label: "—" };
    for (const m of completed) {
      const diffs = m.timelineDiffs || [];
      if (!diffs.length) continue;

      const winnerIsA = m.winnerId === m.teamAId;
      const deficit = winnerIsA ? Math.min(0, ...diffs) : Math.max(0, ...diffs);
      const comebackSize = Math.abs(deficit);

      if (comebackSize > bestComeback.deficit) {
        const ta = teamById.get(m.teamAId)?.name ?? "Team A";
        const tb = teamById.get(m.teamBId)?.name ?? "Team B";
        bestComeback = { deficit: comebackSize, label: `${ta} vs ${tb} (${m.label})` };
      }
    }

    // Clutch Finish (last 3 hands): closest score difference at any moment during the last 3 hands
    let clutchFinish = { diff: Infinity, label: "—" };
    for (const m of completed) {
      const diffs = m.timelineDiffs || [];
      if (diffs.length < 1) continue;
      const startIdx = Math.max(0, diffs.length - 3);
      for (let i = startIdx; i < diffs.length; i++) {
        const absDiff = Math.abs(diffs[i]);
        if (absDiff < clutchFinish.diff) {
          const ta = teamById.get(m.teamAId)?.name ?? "Team A";
          const tb = teamById.get(m.teamBId)?.name ?? "Team B";
          clutchFinish = { diff: absDiff, label: `${ta} vs ${tb} (${m.label})` };
        }
      }
    }
    if (!Number.isFinite(clutchFinish.diff)) clutchFinish = { diff: 0, label: "—" };

    // Momentum Monster: biggest swing in the score difference over 2 consecutive hands
    let momentumMonster = { swing: 0, label: "—" };
    for (const m of matches.filter((x) => x.teamAId && x.teamBId)) {
      const diffs = m.timelineDiffs || [];
      if (diffs.length < 3) continue;
      for (let i = 2; i < diffs.length; i++) {
        const swing = Math.abs(diffs[i] - diffs[i - 2]);
        if (swing > momentumMonster.swing) {
          const ta = teamById.get(m.teamAId)?.name ?? "Team A";
          const tb = teamById.get(m.teamBId)?.name ?? "Team B";
          momentumMonster = { swing, label: `${ta} vs ${tb} (${m.label})` };
        }
      }
    }

    // Perfect Defense: most times a team’s opponent scored 0 on a hand (while they scored > 0)
    const defenseCounts = new Map(); // teamId -> count
    const bumpDefense = (teamId) => {
      if (!teamId) return;
      defenseCounts.set(teamId, (defenseCounts.get(teamId) || 0) + 1);
    };

    for (const m of matches.filter((x) => x.teamAId && x.teamBId)) {
      for (const h of m.hands || []) {
        const a = Number(h.scoreA) || 0;
        const b = Number(h.scoreB) || 0;
        if (a > 0 && b === 0) bumpDefense(m.teamAId);
        if (b > 0 && a === 0) bumpDefense(m.teamBId);
      }
    }

    let perfectDefense = { name: "—", count: 0 };
    for (const [tid, count] of defenseCounts.entries()) {
      if (count > perfectDefense.count) {
        perfectDefense = { name: teamById.get(tid)?.name ?? "—", count };
      }
    }

    // Coinche/capot/belote fun leaders (completed matches)
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
      clutchFinish,
      momentumMonster,
      perfectDefense,
      coincheKing: leader("coinches"),
      capotHero: leader("capots"),
      beloteMagnet: leader("belotes"),
    };
  }, [matches, teamById]);

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

            <Section title="Fun Facts">
              <div style={styles.grid3}>
                <StatCard
                  label="Biggest Blowout"
                  value={`${funStats.biggestBlowout.diff} pts`}
                  sub={funStats.biggestBlowout.label}
                />
                <StatCard
                  label="Best Comeback"
                  value={`${funStats.bestComeback.deficit} pts`}
                  sub={funStats.bestComeback.label}
                />
                <StatCard
                  label="Closest Match"
                  value={`${funStats.closest.diff} pts`}
                  sub={funStats.closest.label}
                />

                <StatCard
                  label="Clutch Finish (last 3 hands)"
                  value={`${funStats.clutchFinish.diff} pts`}
                  sub={funStats.clutchFinish.label}
                />
                <StatCard
                  label="Momentum Monster"
                  value={`${funStats.momentumMonster.swing} pts`}
                  sub={funStats.momentumMonster.label}
                />
                <StatCard
                  label="Perfect Defense"
                  value={funStats.perfectDefense.name}
                  sub={`${funStats.perfectDefense.count} shutout hands`}
                />

                <StatCard
                  label="Coinche King"
                  value={funStats.coincheKing.name}
                  sub={`${funStats.coincheKing.v} coinches`}
                />
                <StatCard
                  label="Capot Hero"
                  value={funStats.capotHero.name}
                  sub={`${funStats.capotHero.v} capots`}
                />
                <StatCard
                  label="Belote Magnet"
                  value={funStats.beloteMagnet.name}
                  sub={`${funStats.beloteMagnet.v} belotes`}
                />
              </div>
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
              Admin • Setup players/teams • Create table matches • Share links • Auto-backup to Google Sheet
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
            GoogleSheet backup: {backupState.lastOk ? "✅ OK" : "—"}{" "}
            {backupState.lastErr ? "• retrying…" : ""}{" "}
            {backupState.queued ? `• retries queued: ${backupState.queued}` : ""}
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
                  // force a backup immediately
                  pendingBackupRef.current = true;
                  void flushBackup({
                    appName,
                    players,
                    teams,
                    avoidSameTeams,
                    pairHistory,
                    matches,
                    savedAt: Date.now(),
                  });
                }}
              >
                Backup Now
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
              <div style={{ fontWeight: 900, fontSize: 12, color: "#cbd5e1", wordBreak: "break-all" }}>
                {BACKUP_URL}
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
                <div style={{ fontWeight: 950, display: "flex", justifyContent: "space-between", gap: 10 }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {p.name}
                  </span>
                  <button style={{ ...styles.btnGhost, padding: 0 }} onClick={() => removePlayer(p.id)}>
                    Remove
                  </button>
                </div>
                <div style={styles.small}>ID: {p.id.slice(-6)}</div>
              </div>
            ))}
            {players.length === 0 ? (
              <div style={styles.small}>Add players to get started.</div>
            ) : null}
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
              <button style={styles.btnSecondary} onClick={buildRandomTeams} disabled={players.length < 2 || teams.length < 1}>
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
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <div style={{ fontWeight: 950 }}>Team #{idx + 1}</div>
                    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                      <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 900, color: t.locked ? "#34d399" : "#94a3b8" }}>
                        <input type="checkbox" checked={!!t.locked} onChange={(e) => toggleTeamLock(t.id, e.target.checked)} />
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
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
                    <div style={{ fontWeight: 950 }}>
                      {m.tableName} • {m.label} <span style={styles.small}>• Code {m.code}</span>
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
                        {m.completed ? `Completed • Winner: ${teamById.get(m.winnerId)?.name ?? "—"}` : "In progress"}
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
                    />
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
                <StatCard
                  label="Biggest Blowout"
                  value={`${funStats.biggestBlowout.diff} pts`}
                  sub={funStats.biggestBlowout.label}
                />
                <StatCard
                  label="Best Comeback"
                  value={`${funStats.bestComeback.deficit} pts`}
                  sub={funStats.bestComeback.label}
                />
                <StatCard
                  label="Closest Match"
                  value={`${funStats.closest.diff} pts`}
                  sub={funStats.closest.label}
                />
                <StatCard
                  label="Clutch Finish (last 3 hands)"
                  value={`${funStats.clutchFinish.diff} pts`}
                  sub={funStats.clutchFinish.label}
                />
                <StatCard
                  label="Momentum Monster"
                  value={`${funStats.momentumMonster.swing} pts`}
                  sub={funStats.momentumMonster.label}
                />
                <StatCard
                  label="Perfect Defense"
                  value={funStats.perfectDefense.name}
                  sub={`${funStats.perfectDefense.count} shutout hands`}
                />
                <StatCard
                  label="Coinche King"
                  value={funStats.coincheKing.name}
                  sub={`${funStats.coincheKing.v} coinches`}
                />
                <StatCard
                  label="Capot Hero"
                  value={funStats.capotHero.name}
                  sub={`${funStats.capotHero.v} capots`}
                />
                <StatCard
                  label="Belote Magnet"
                  value={funStats.beloteMagnet.name}
                  sub={`${funStats.beloteMagnet.v} belotes`}
                />
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
  bigTotals = false,
}) {
  const ta = teamById.get(match.teamAId)?.name ?? "TBD";
  const tb = teamById.get(match.teamBId)?.name ?? "TBD";

  const numA = match.teamAId ? teamNumberById?.get(match.teamAId) ?? "?" : "?";
  const numB = match.teamBId ? teamNumberById?.get(match.teamBId) ?? "?" : "?";

  const pctA = Math.min(100, Math.round(((match.totalA || 0) / TARGET_SCORE) * 100));
  const pctB = Math.min(100, Math.round(((match.totalB || 0) / TARGET_SCORE) * 100));

  const d =
    match.fastDraft || {
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

  const leader = match.totalA === match.totalB ? null : match.totalA > match.totalB ? "A" : "B";

  return (
    <div style={{ ...styles.card, borderRadius: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
        <div style={{ fontWeight: 950 }}>
          {match.tableName} • {match.label}
        </div>
        <div style={{ color: match.completed ? "#34d399" : "#94a3b8", fontWeight: 950 }}>
          {match.completed ? `Winner: ${teamById.get(match.winnerId)?.name ?? "—"}` : "Live"}
        </div>
      </div>

      <div style={{ marginTop: 10, ...styles.grid2 }}>
        <div style={{ ...styles.card, ...(leader === "A" ? styles.leaderGlow : {}) }}>
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

        <div style={{ ...styles.card, ...(leader === "B" ? styles.leaderGlow : {}) }}>
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
            <select style={styles.select("100%")} value={d.capot ? "YES" : "NO"} onChange={(e) => onDraftPatch({ capot: e.target.value === "YES" })} disabled={!canPlay}>
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
            <input style={styles.input("100%")} value={d.announceA} onChange={(e) => onDraftPatch({ announceA: e.target.value })} inputMode="numeric" disabled={!canPlay} />
          </div>

          <div>
            <div style={styles.small}>Announces Team B (non-belote)</div>
            <input style={styles.input("100%")} value={d.announceB} onChange={(e) => onDraftPatch({ announceB: e.target.value })} inputMode="numeric" disabled={!canPlay} />
          </div>

          <div>
            <div style={styles.small}>Belote</div>
            <select style={styles.select("100%")} value={d.beloteTeam} onChange={(e) => onDraftPatch({ beloteTeam: e.target.value })} disabled={!canPlay}>
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
                  <div style={{ minWidth: 200 }}>
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
    </div>
  );
}