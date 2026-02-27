import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Coinche Scorekeeper (Vite single-file App.jsx)
 * ✅ Admin view + Public view (read-only) + Table view (enter only your table match)
 * ✅ Unlimited players + unlimited teams
 * ✅ Admin creates matches (tables) manually (no pools/bracket/timer)
 * ✅ Fast mode Hand Tracker (same scoring logic)
 * ✅ Live scoreboard + stats + funny stats + fun facts (blowout/comeback/etc.)
 * ✅ Leading team glows green + score pop animation on update
 * ✅ Fullscreen layout + dropdown/input black text
 * ✅ Uses localStorage
 * ✅ Routes via URL hash:
 *    #/admin
 *    #/public
 *    #/table?code=AB12
 */

const LS_KEY = "coinche_scorekeeper_vite_fullscreen_v1";
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

function roundTrickPoints(x) {
  if (x == null) return 0;
  const n = clamp(Number(x) || 0, 0, 162);
  return Math.floor((n + 4) / 10) * 10;
}

/**
 * Fast mode compute (kept from your previous)
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

/** ===== Styles ===== */
const styles = {
  page: {
    minHeight: "100vh",
    width: "100vw",
    boxSizing: "border-box",
    background:
      "radial-gradient(1200px 600px at 10% 10%, rgba(99,102,241,0.25), transparent 60%), radial-gradient(1200px 600px at 90% 10%, rgba(16,185,129,0.18), transparent 55%), radial-gradient(1200px 600px at 50% 90%, rgba(244,63,94,0.12), transparent 60%), linear-gradient(180deg, #0b1220 0%, #050814 100%)",
    color: "#e5e7eb",
    padding: 8,
  },
  container: {
    width: "100%",
    maxWidth: "100%",
    margin: "0 auto",
    display: "flex",
    flexDirection: "column",
    gap: 16,
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

  // Black text inputs/selects
  input: (w = 240) => ({
    width: typeof w === "number" ? `${w}px` : w,
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(148,163,184,0.22)",
    background: "#ffffff",
    color: "#000000",
    fontWeight: 600,
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
    background: "#ffffff",
    color: "#000000",
    fontWeight: 600,
    outline: "none",
    boxSizing: "border-box",
    minWidth: 0,
    display: "block",
  }),

  grid2: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(450px, 1fr))",
    gap: 16,
  },
  grid3: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(350px, 1fr))",
    gap: 16,
  },
  grid4: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
    gap: 16,
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
};

function GlobalAnimStyles() {
  return (
    <style>{`
      @keyframes scorePop {
        0%   { transform: scale(1); }
        35%  { transform: scale(1.18); }
        100% { transform: scale(1); }
      }
    `}</style>
  );
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

/** ===== Stats helpers ===== */
function matchLabel(match, teamById) {
  const ta = teamById.get(match.teamAId)?.name ?? "Team A";
  const tb = teamById.get(match.teamBId)?.name ?? "Team B";
  return `${ta} vs ${tb}`;
}

function matchStoryStats(match) {
  const hands = match.hands || [];
  let a = 0;
  let b = 0;

  let maxLeadA = 0;
  let maxLeadB = 0;

  let leadChanges = 0;
  let lastLeader = 0; // 1 A, -1 B, 0 tie

  const diffs = [0];
  let momentum2Swing = 0;

  let perfectDefenseA = 0;
  let perfectDefenseB = 0;

  hands.forEach((h) => {
    const sA = Number(h.scoreA) || 0;
    const sB = Number(h.scoreB) || 0;

    a += sA;
    b += sB;

    if (sA > 0 && sB === 0) perfectDefenseA += 1;
    if (sB > 0 && sA === 0) perfectDefenseB += 1;

    const diff = a - b;
    diffs.push(diff);

    maxLeadA = Math.max(maxLeadA, diff);
    maxLeadB = Math.max(maxLeadB, -diff);

    const leaderNow = diff === 0 ? 0 : diff > 0 ? 1 : -1;
    if (leaderNow !== 0 && lastLeader !== 0 && leaderNow !== lastLeader) leadChanges += 1;
    if (leaderNow !== 0) lastLeader = leaderNow;

    if (diffs.length >= 3) {
      const prev2 = diffs[diffs.length - 3];
      const swing2 = Math.abs(diff - prev2);
      if (swing2 > momentum2Swing) momentum2Swing = swing2;
    }
  });

  const finalDiff = Math.abs((match.totalA || 0) - (match.totalB || 0));

  let comebackDeficit = 0;
  if (match.winnerId) {
    const winnerIsA = match.winnerId === match.teamAId;
    comebackDeficit = winnerIsA ? maxLeadB : maxLeadA;
  }

  let clutchMinDiff = null;
  if (hands.length > 0) {
    const startIdx = Math.max(0, diffs.length - 1 - 3);
    for (let i = startIdx; i < diffs.length; i++) {
      const d = Math.abs(diffs[i]);
      clutchMinDiff = clutchMinDiff === null ? d : Math.min(clutchMinDiff, d);
    }
  }

  return {
    finalDiff,
    comebackDeficit,
    leadChanges,
    momentum2Swing,
    clutchMinDiff: clutchMinDiff ?? 0,
    perfectDefenseA,
    perfectDefenseB,
  };
}

/** ===== Main App ===== */
export default function App() {
  const [route, setRoute] = useState(() => parseHashRoute());
  const [loaded, setLoaded] = useState(false);

  const [eventName, setEventName] = useState("Coinche Scorekeeper");

  const [players, setPlayers] = useState([]); // {id,name}
  const [teams, setTeams] = useState([]); // {id,name,playerIds[]}
  const [matches, setMatches] = useState([]); // {id,code,table,label,teamAId,teamBId,hands,totalA,totalB,winnerId,completed,fastDraft,editingHandIdx}

  const [newPlayerName, setNewPlayerName] = useState("");
  const [newTeamName, setNewTeamName] = useState("");
  const [newMatchTable, setNewMatchTable] = useState("1");
  const [newMatchTeamA, setNewMatchTeamA] = useState("");
  const [newMatchTeamB, setNewMatchTeamB] = useState("");

  const inputRef = useRef(null);

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

    return { ...m, totalA, totalB, completed, winnerId };
  }

  // Load localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        setEventName(d.eventName ?? "Coinche Scorekeeper");
        setPlayers(d.players ?? []);
        setTeams(d.teams ?? []);
        setMatches(d.matches ?? []);
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
        eventName,
        players,
        teams,
        matches,
      })
    );
  }, [loaded, eventName, players, teams, matches]);

  const playerById = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);
  const teamById = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams]);

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
    // also remove from teams
    setTeams((prev) =>
      prev.map((t) => ({ ...t, playerIds: (t.playerIds || []).filter((pid) => pid !== id) }))
    );
  }

  /** ===== Teams ===== */
  function addTeam() {
    const name = newTeamName.trim();
    if (!name) return;
    setTeams((prev) => [...prev, { id: uid("t"), name, playerIds: [] }]);
    setNewTeamName("");
  }
  function removeTeam(teamId) {
    setTeams((prev) => prev.filter((t) => t.id !== teamId));
    // remove/clear matches referencing this team
    setMatches((prev) =>
      prev.map((m) => {
        if (m.teamAId === teamId || m.teamBId === teamId) {
          return recomputeMatch({
            ...m,
            teamAId: m.teamAId === teamId ? "" : m.teamAId,
            teamBId: m.teamBId === teamId ? "" : m.teamBId,
            hands: [],
            fastDraft: defaultFastDraft(),
            editingHandIdx: null,
          });
        }
        return m;
      })
    );
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

        if (slotIdx === 0 && ids[0] && ids[0] === ids[1]) ids[1] = "";
        if (slotIdx === 1 && ids[1] && ids[0] === ids[1]) ids[0] = "";

        return { ...t, playerIds: ids.filter(Boolean) };
      })
    );
  }

  const usedPlayerIds = useMemo(() => {
    const s = new Set();
    teams.forEach((t) => (t.playerIds || []).forEach((pid) => s.add(pid)));
    return s;
  }, [teams]);

  /** ===== Matches (Tables) ===== */
  function addMatch() {
    if (!newMatchTeamA || !newMatchTeamB) return;
    if (newMatchTeamA === newMatchTeamB) return;

    const tableNum = safeInt(newMatchTable) ?? 1;

    const label = `Table ${tableNum}`;
    const m = {
      id: uid("match"),
      code: shortCode(),
      table: tableNum,
      label,
      teamAId: newMatchTeamA,
      teamBId: newMatchTeamB,
      hands: [],
      totalA: 0,
      totalB: 0,
      winnerId: null,
      completed: false,
      fastDraft: defaultFastDraft(),
      editingHandIdx: null,
    };
    setMatches((prev) => [...prev, recomputeMatch(m)].sort((a, b) => (a.table || 0) - (b.table || 0)));
  }

  function removeMatch(matchId) {
    setMatches((prev) => prev.filter((m) => m.id !== matchId));
  }

  function updateMatchDraft(matchId, patch) {
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

          return recomputeMatch({
            ...m,
            hands: nextHands,
            fastDraft: defaultFastDraft(),
            editingHandIdx: null,
          });
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

  /** ===== Links ===== */
  const publicLink = useMemo(() => `${window.location.origin}${window.location.pathname}#/public`, []);
  const tableLinks = useMemo(() => {
    return matches.map((m) => ({
      label: `${m.label} • ${teamById.get(m.teamAId)?.name ?? "TBD"} vs ${teamById.get(m.teamBId)?.name ?? "TBD"}`,
      code: m.code,
      href: `${window.location.origin}${window.location.pathname}#/table?code=${m.code}`,
    }));
  }, [matches, teamById]);

  /** ===== Table lookup ===== */
  const { path, query } = route;
  const tableMatch = useMemo(() => {
    const code = (query.code || "").toUpperCase();
    if (!code) return null;
    const m = matches.find((x) => (x.code || "").toUpperCase() === code);
    return m || null;
  }, [query.code, matches]);

  /** ===== Scoreboard rows (across all matches) ===== */
  const scoreboardRows = useMemo(() => {
    const rows = teams.map((t) => ({
      teamId: t.id,
      name: t.name,
      wins: 0,
      losses: 0,
      gamesPlayed: 0,
      pointsFor: 0,
      pointsAgainst: 0,
      completedGames: 0,
    }));

    const byId = new Map(rows.map((r) => [r.teamId, r]));

    matches.forEach((m) => {
      if (!m.teamAId || !m.teamBId) return;
      const a = byId.get(m.teamAId);
      const b = byId.get(m.teamBId);
      if (!a || !b) return;

      a.pointsFor += Number(m.totalA) || 0;
      a.pointsAgainst += Number(m.totalB) || 0;
      b.pointsFor += Number(m.totalB) || 0;
      b.pointsAgainst += Number(m.totalA) || 0;

      if ((m.hands || []).length > 0) {
        a.gamesPlayed += 1;
        b.gamesPlayed += 1;
      }

      if (m.completed) {
        a.completedGames += 1;
        b.completedGames += 1;

        if (m.winnerId === m.teamAId) {
          a.wins += 1;
          b.losses += 1;
        } else if (m.winnerId === m.teamBId) {
          b.wins += 1;
          a.losses += 1;
        }
      }
    });

    return [...rows].sort((x, y) => {
      if (y.wins !== x.wins) return y.wins - x.wins;
      const xDiff = x.pointsFor - x.pointsAgainst;
      const yDiff = y.pointsFor - y.pointsAgainst;
      if (yDiff !== xDiff) return yDiff - xDiff;
      if (y.pointsFor !== x.pointsFor) return y.pointsFor - x.pointsFor;
      return x.name.localeCompare(y.name);
    });
  }, [teams, matches]);

  /** ===== Global stats + fun facts ===== */
  const globalStats = useMemo(() => {
    const completed = matches.filter((m) => m.completed);

    const totalHands = completed.reduce((acc, m) => acc + (m.hands?.length || 0), 0);

    // biggest hand swing
    let biggestHand = { pts: 0, label: "—" };
    for (const m of completed) {
      for (const h of m.hands || []) {
        const swing = Math.abs((h.scoreA || 0) - (h.scoreB || 0));
        if (swing > biggestHand.pts) {
          biggestHand = { pts: swing, label: `${matchLabel(m, teamById)} (Hand ${h.idx})` };
        }
      }
    }

    // fastest match (fewest hands)
    let fastest = null;
    for (const m of completed) {
      const hands = (m.hands || []).length;
      if (!hands) continue;
      if (!fastest || hands < fastest.hands) fastest = { match: m, hands };
    }

    // closest match (smallest abs diff)
    let closest = null;
    for (const m of completed) {
      const diff = Math.abs((m.totalA || 0) - (m.totalB || 0));
      if (diff === 0) continue;
      if (!closest || diff < closest.diff) closest = { match: m, diff };
    }

    // Funny stats (coinche/capot/belote)
    const teamFun = new Map(); // teamId -> {coinches, surcoinches, capots, belotes}
    const bump = (tid, key, n = 1) => {
      if (!tid) return;
      const cur = teamFun.get(tid) || { coinches: 0, surcoinches: 0, capots: 0, belotes: 0 };
      cur[key] = (cur[key] || 0) + n;
      teamFun.set(tid, cur);
    };

    for (const m of completed) {
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

    // Fun facts
    let biggestBlowout = { diff: 0, label: "—" };
    let bestComeback = { deficit: 0, label: "—" };
    let mostBackAndForth = { changes: 0, label: "—" };

    let clutchFinish = { diff: 0, label: "—" }; // smallest is best (we store min)
    let momentumMonster = { swing: 0, label: "—" };

    const pdByTeam = new Map();
    const bumpPD = (teamId, n) => {
      if (!teamId || !n) return;
      pdByTeam.set(teamId, (pdByTeam.get(teamId) || 0) + n);
    };

    for (const m of completed) {
      const s = matchStoryStats(m);
      const label = matchLabel(m, teamById);

      if (s.finalDiff > biggestBlowout.diff) biggestBlowout = { diff: s.finalDiff, label };
      if (s.comebackDeficit > bestComeback.deficit) bestComeback = { deficit: s.comebackDeficit, label };
      if (s.leadChanges > mostBackAndForth.changes) mostBackAndForth = { changes: s.leadChanges, label };

      // clutch: smallest non-zero is best
      if (s.clutchMinDiff > 0) {
        if (clutchFinish.label === "—" || s.clutchMinDiff < clutchFinish.diff) {
          clutchFinish = { diff: s.clutchMinDiff, label };
        }
      }

      if (s.momentum2Swing > momentumMonster.swing) {
        momentumMonster = { swing: s.momentum2Swing, label };
      }

      bumpPD(m.teamAId, s.perfectDefenseA);
      bumpPD(m.teamBId, s.perfectDefenseB);
    }

    let bestPD = { teamId: null, v: 0 };
    for (const [teamId, v] of pdByTeam.entries()) {
      if (v > bestPD.v) bestPD = { teamId, v };
    }
    const perfectDefense =
      bestPD.v > 0
        ? { name: teamById.get(bestPD.teamId)?.name ?? "—", v: bestPD.v }
        : { name: "—", v: 0 };

    return {
      completedGames: completed.length,
      totalHands,
      biggestHand,
      fastest,
      closest,
      funny: { coincheKing, surcoincheBoss, capotHero, beloteMagnet },
      biggestBlowout,
      bestComeback,
      mostBackAndForth,
      clutchFinish,
      momentumMonster,
      perfectDefense,
    };
  }, [matches, teamById]);

  /** ===== Export CSV ===== */
  function exportCSV() {
    const rows = [];
    const pushRow = (obj) => rows.push(obj);

    pushRow({ TYPE: "META", eventName, date: new Date().toISOString() });

    teams.forEach((t) => {
      const pnames = (t.playerIds || [])
        .map((pid) => playerById.get(pid)?.name)
        .filter(Boolean)
        .join(" / ");
      pushRow({ TYPE: "TEAM", teamId: t.id, teamName: t.name, players: pnames });
    });

    matches.forEach((m) => {
      const ta = teamById.get(m.teamAId)?.name ?? "";
      const tb = teamById.get(m.teamBId)?.name ?? "";
      pushRow({
        TYPE: "MATCH",
        matchId: m.id,
        code: m.code,
        table: m.table ?? "",
        label: m.label,
        teamA: ta,
        teamB: tb,
        totalA: m.totalA ?? 0,
        totalB: m.totalB ?? 0,
        winner: m.winnerId ? teamById.get(m.winnerId)?.name ?? "" : "",
        completed: m.completed ? "YES" : "NO",
      });

      (m.hands || []).forEach((h) => {
        const d = h.draftSnapshot || {};
        pushRow({
          TYPE: "HAND",
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
    a.download = "coinche_scorekeeper_export.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

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
        <div style={styles.container}>
          <div style={styles.topbar}>
            <div>
              <h1 style={styles.title}>{eventName}</h1>
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
                <StatCard
                  label="Biggest Blowout"
                  value={globalStats.biggestBlowout.diff ? `${globalStats.biggestBlowout.diff} pts` : "—"}
                  sub={globalStats.biggestBlowout.label}
                />
                <StatCard
                  label="Best Comeback"
                  value={globalStats.bestComeback.deficit ? `${globalStats.bestComeback.deficit} pts` : "—"}
                  sub={globalStats.bestComeback.label}
                />
                <StatCard
                  label="Most Back-and-Forth"
                  value={globalStats.mostBackAndForth.changes ? `${globalStats.mostBackAndForth.changes} lead changes` : "—"}
                  sub={globalStats.mostBackAndForth.label}
                />
                <StatCard
                  label="Clutch Finish (last 3 hands)"
                  value={globalStats.clutchFinish.label !== "—" ? `${globalStats.clutchFinish.diff} pts` : "—"}
                  sub={globalStats.clutchFinish.label}
                />
                <StatCard
                  label="Momentum Monster (2 hands)"
                  value={globalStats.momentumMonster.swing ? `${globalStats.momentumMonster.swing} swing` : "—"}
                  sub={globalStats.momentumMonster.label}
                />
                <StatCard
                  label="Perfect Defense"
                  value={globalStats.perfectDefense.name}
                  sub={globalStats.perfectDefense.v ? `${globalStats.perfectDefense.v} zero-hands forced` : ""}
                />
              </div>
            </Section>
          </div>

          <div style={styles.grid2}>
            <Section title="Funny Stats">
              <div style={styles.grid3}>
                <StatCard label="Coinche King" value={globalStats.funny.coincheKing.name} sub={`${globalStats.funny.coincheKing.v} coinches`} />
                <StatCard label="Surcoinche Boss" value={globalStats.funny.surcoincheBoss.name} sub={`${globalStats.funny.surcoincheBoss.v} surcoinches`} />
                <StatCard label="Capot Hero" value={globalStats.funny.capotHero.name} sub={`${globalStats.funny.capotHero.v} capots`} />
                <StatCard label="Belote Magnet" value={globalStats.funny.beloteMagnet.name} sub={`${globalStats.funny.beloteMagnet.v} belotes`} />
              </div>
            </Section>

            <Section title="Table Entry Links">
              <div style={{ color: "#94a3b8", fontSize: 12, marginBottom: 10 }}>
                Each table uses their own link to enter hands/scores.
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
                {tableLinks.length === 0 ? <div style={styles.small}>No matches created yet (Admin creates tables).</div> : null}
              </div>
            </Section>
          </div>
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
              <h1 style={styles.title}>{eventName}</h1>
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
                onDraftPatch={(patch) => updateMatchDraft(tableMatch.id, patch)}
                onAddHand={() => addOrSaveHand(tableMatch.id)}
                onClearHands={() => clearMatchHands(tableMatch.id)}
                onStartEditHand={(handIdx) => startEditHand(tableMatch.id, handIdx)}
                onCancelEdit={() => cancelEditHand(tableMatch.id)}
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
            <h1 style={styles.title}>{eventName}</h1>
            <div style={styles.subtitle}>Admin • Setup players/teams • Create table matches • Share links • Export CSV</div>
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
              <button
                style={styles.btnDanger}
                onClick={() => {
                  if (!confirm("Reset everything? This clears players, teams and matches.")) return;
                  setPlayers([]);
                  setTeams([]);
                  setMatches([]);
                }}
              >
                Full Reset
              </button>
            </div>
          }
        >
          <div style={styles.grid4}>
            <div style={styles.card}>
              <div style={styles.small}>Event name</div>
              <input style={styles.input("100%")} value={eventName} onChange={(e) => setEventName(e.target.value)} />
            </div>
            <div style={styles.card}>
              <div style={styles.small}>Target score</div>
              <div style={{ fontSize: 18, fontWeight: 950 }}>{TARGET_SCORE}</div>
              <div style={styles.small}>Match completes when a team reaches {TARGET_SCORE}+.</div>
            </div>
            <div style={styles.card}>
              <div style={styles.small}>Created matches</div>
              <div style={{ fontSize: 18, fontWeight: 950 }}>{matches.length}</div>
              <div style={styles.small}>Each match has a table code link.</div>
            </div>
            <div style={styles.card}>
              <div style={styles.small}>Completed games</div>
              <div style={{ fontSize: 18, fontWeight: 950 }}>{globalStats.completedGames}</div>
              <div style={styles.small}>Total hands: {globalStats.totalHands}</div>
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
          <div style={styles.row}>
            <input
              style={styles.input(320)}
              value={newTeamName}
              onChange={(e) => setNewTeamName(e.target.value)}
              placeholder="New team name"
              onKeyDown={(e) => {
                if (e.key === "Enter") addTeam();
              }}
            />
            <button style={styles.btnPrimary} onClick={addTeam} disabled={!newTeamName.trim()}>
              Add Team
            </button>
          </div>

          <div style={{ marginTop: 12, ...styles.grid2 }}>
            {teams.map((t) => (
              <div key={t.id} style={styles.card}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                  <div style={{ fontWeight: 950 }}>Team</div>
                  <button style={styles.btnDanger} onClick={() => removeTeam(t.id)}>
                    Delete Team
                  </button>
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
                  Members: {(t.playerIds || []).map((pid) => playerById.get(pid)?.name).filter(Boolean).join(" / ") || "—"}
                </div>
              </div>
            ))}
            {teams.length === 0 ? <div style={styles.small}>Add teams to create matches (tables).</div> : null}
          </div>
        </Section>

        <Section title="Create a Match (Table)">
          <div style={styles.grid4}>
            <div style={styles.card}>
              <div style={styles.small}>Table #</div>
              <input style={styles.input("100%")} value={newMatchTable} onChange={(e) => setNewMatchTable(e.target.value)} inputMode="numeric" />
            </div>

            <div style={styles.card}>
              <div style={styles.small}>Team A</div>
              <select style={styles.select("100%")} value={newMatchTeamA} onChange={(e) => setNewMatchTeamA(e.target.value)}>
                <option value="">— Select —</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>

            <div style={styles.card}>
              <div style={styles.small}>Team B</div>
              <select style={styles.select("100%")} value={newMatchTeamB} onChange={(e) => setNewMatchTeamB(e.target.value)}>
                <option value="">— Select —</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>

            <div style={styles.card}>
              <div style={styles.small}>Create</div>
              <button
                style={styles.btnPrimary}
                onClick={addMatch}
                disabled={!newMatchTeamA || !newMatchTeamB || newMatchTeamA === newMatchTeamB}
              >
                Add Match
              </button>
              <div style={{ marginTop: 8, ...styles.small }}>Creates a unique table code link.</div>
            </div>
          </div>
        </Section>

        <Section title="Matches (Admin can edit)">
          {!matches.length ? (
            <div style={styles.small}>No matches yet. Create table matches above.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {matches
                .slice()
                .sort((a, b) => (a.table || 0) - (b.table || 0))
                .map((m) => {
                  const href = `${window.location.origin}${window.location.pathname}#/table?code=${m.code}`;
                  return (
                    <div key={m.id} style={styles.card}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
                        <div style={{ fontWeight: 950 }}>
                          {m.label} <span style={styles.small}>• Code {m.code}</span>
                        </div>
                        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                          <a href={href} style={{ ...styles.btnSecondary, textDecoration: "none" }}>
                            Open Table
                          </a>
                          <button
                            style={styles.btnSecondary}
                            onClick={() => {
                              navigator.clipboard?.writeText(href);
                              alert("Table link copied!");
                            }}
                          >
                            Copy Link
                          </button>
                          <button style={styles.btnDanger} onClick={() => removeMatch(m.id)}>
                            Delete Match
                          </button>
                        </div>
                      </div>

                      <div style={{ marginTop: 10 }}>
                        <TableMatchPanel
                          match={m}
                          teamById={teamById}
                          onDraftPatch={(patch) => updateMatchDraft(m.id, patch)}
                          onAddHand={() => addOrSaveHand(m.id)}
                          onClearHands={() => clearMatchHands(m.id)}
                          onStartEditHand={(handIdx) => startEditHand(m.id, handIdx)}
                          onCancelEdit={() => cancelEditHand(m.id)}
                        />
                      </div>
                    </div>
                  );
                })}
            </div>
          )}
        </Section>

        <Section title="Live Scoreboard + Stats">
          <div style={styles.grid2}>
            <div style={styles.card}>
              <div style={{ fontWeight: 950, marginBottom: 8 }}>Live Scoreboard</div>
              <ScoreboardTable rows={scoreboardRows} />
            </div>

            <div style={styles.card}>
              <div style={{ fontWeight: 950, marginBottom: 8 }}>Fun Facts</div>
              <div style={styles.grid3}>
                <StatCard label="Biggest Blowout" value={globalStats.biggestBlowout.diff ? `${globalStats.biggestBlowout.diff} pts` : "—"} sub={globalStats.biggestBlowout.label} />
                <StatCard label="Best Comeback" value={globalStats.bestComeback.deficit ? `${globalStats.bestComeback.deficit} pts` : "—"} sub={globalStats.bestComeback.label} />
                <StatCard label="Most Back-and-Forth" value={globalStats.mostBackAndForth.changes ? `${globalStats.mostBackAndForth.changes} lead changes` : "—"} sub={globalStats.mostBackAndForth.label} />
                <StatCard label="Clutch Finish (last 3 hands)" value={globalStats.clutchFinish.label !== "—" ? `${globalStats.clutchFinish.diff} pts` : "—"} sub={globalStats.clutchFinish.label} />
                <StatCard label="Momentum Monster (2 hands)" value={globalStats.momentumMonster.swing ? `${globalStats.momentumMonster.swing} swing` : "—"} sub={globalStats.momentumMonster.label} />
                <StatCard label="Perfect Defense" value={globalStats.perfectDefense.name} sub={globalStats.perfectDefense.v ? `${globalStats.perfectDefense.v} zero-hands forced` : ""} />
              </div>

              <div style={{ marginTop: 12, fontWeight: 950 }}>Funny Stats</div>
              <div style={{ marginTop: 10, ...styles.grid3 }}>
                <StatCard label="Coinche King" value={globalStats.funny.coincheKing.name} sub={`${globalStats.funny.coincheKing.v} coinches`} />
                <StatCard label="Surcoinche Boss" value={globalStats.funny.surcoincheBoss.name} sub={`${globalStats.funny.surcoincheBoss.v} surcoinches`} />
                <StatCard label="Capot Hero" value={globalStats.funny.capotHero.name} sub={`${globalStats.funny.capotHero.v} capots`} />
                <StatCard label="Belote Magnet" value={globalStats.funny.beloteMagnet.name} sub={`${globalStats.funny.beloteMagnet.v} belotes`} />
              </div>
            </div>
          </div>
        </Section>

        <Section title="Table Links (share to each table)">
          <div style={styles.small}>Each match has a unique code + link. Teams should open their match link to enter hands.</div>
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
            {tableLinks.length === 0 ? <div style={styles.small}>No matches yet.</div> : null}
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
            {["Rank", "Team", "W", "L", "PF", "PA", "Diff"].map((h) => (
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
                <td style={{ padding: "10px 10px", borderBottom: "1px solid rgba(148,163,184,0.10)", fontWeight: 950 }}>#{i + 1}</td>
                <td style={{ padding: "10px 10px", borderBottom: "1px solid rgba(148,163,184,0.10)", fontWeight: 900 }}>{r.name}</td>
                <td style={{ padding: "10px 10px", borderBottom: "1px solid rgba(148,163,184,0.10)", fontWeight: 900 }}>{r.wins}</td>
                <td style={{ padding: "10px 10px", borderBottom: "1px solid rgba(148,163,184,0.10)", fontWeight: 900 }}>{r.losses}</td>
                <td style={{ padding: "10px 10px", borderBottom: "1px solid rgba(148,163,184,0.10)", fontWeight: 900 }}>{r.pointsFor}</td>
                <td style={{ padding: "10px 10px", borderBottom: "1px solid rgba(148,163,184,0.10)", fontWeight: 900 }}>{r.pointsAgainst}</td>
                <td style={{ padding: "10px 10px", borderBottom: "1px solid rgba(148,163,184,0.10)", fontWeight: 900 }}>
                  {diff >= 0 ? `+${diff}` : diff}
                </td>
              </tr>
            );
          })}
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

function TableMatchPanel({
  match,
  teamById,
  onDraftPatch,
  onAddHand,
  onClearHands,
  onStartEditHand,
  onCancelEdit,
}) {
  const ta = teamById.get(match.teamAId)?.name ?? "TBD";
  const tb = teamById.get(match.teamBId)?.name ?? "TBD";

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

  // Glow leader (ignore ties)
  const aLeads = (match.totalA || 0) > (match.totalB || 0);
  const bLeads = (match.totalB || 0) > (match.totalA || 0);

  const leaderCardStyle = (isLeader) =>
    isLeader
      ? {
          border: "1px solid rgba(34,197,94,0.55)",
          boxShadow: "0 0 0 1px rgba(34,197,94,0.25), 0 0 28px rgba(34,197,94,0.28)",
          background: "linear-gradient(180deg, rgba(34,197,94,0.14), rgba(2,6,23,0.35))",
        }
      : {};

  // Animate totals on change
  const [popA, setPopA] = useState(false);
  const [popB, setPopB] = useState(false);
  const lastARef = useRef(match.totalA || 0);
  const lastBRef = useRef(match.totalB || 0);

  useEffect(() => {
    const a = match.totalA || 0;
    if (a !== lastARef.current) {
      lastARef.current = a;
      setPopA(true);
      const t = setTimeout(() => setPopA(false), 320);
      return () => clearTimeout(t);
    }
  }, [match.totalA]);

  useEffect(() => {
    const b = match.totalB || 0;
    if (b !== lastBRef.current) {
      lastBRef.current = b;
      setPopB(true);
      const t = setTimeout(() => setPopB(false), 320);
      return () => clearTimeout(t);
    }
  }, [match.totalB]);

  return (
    <div style={{ ...styles.card, borderRadius: 18 }}>
      <GlobalAnimStyles />

      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
        <div style={{ fontWeight: 950 }}>
          {match.label}
          {match.table ? <span style={styles.small}> • Table {match.table}</span> : null}
        </div>
        <div style={{ color: match.completed ? "#34d399" : "#94a3b8", fontWeight: 950 }}>
          {match.completed ? `Winner: ${teamById.get(match.winnerId)?.name ?? "—"}` : "Live"}
        </div>
      </div>

      <div style={{ marginTop: 10, ...styles.grid2 }}>
        <div style={{ ...styles.card, ...leaderCardStyle(aLeads) }}>
          <div style={{ fontWeight: 900, marginBottom: 6 }}>{`Team A: ${ta}`}</div>

          <div style={{ marginTop: 6 }}>
            <div
              style={{
                fontSize: 42,
                fontWeight: 1000,
                lineHeight: 1,
                display: "inline-block",
                animation: popA ? "scorePop 320ms ease-out" : "none",
              }}
            >
              {match.totalA}
            </div>
            <div style={{ fontSize: 12, color: "#94a3b8" }}>/ {TARGET_SCORE}</div>
          </div>

          <div style={{ marginTop: 8, ...styles.progressWrap }}>
            <div style={styles.progressFillA(pctA)} />
          </div>
        </div>

        <div style={{ ...styles.card, ...leaderCardStyle(bLeads) }}>
          <div style={{ fontWeight: 900, marginBottom: 6 }}>{`Team B: ${tb}`}</div>

          <div style={{ marginTop: 6 }}>
            <div
              style={{
                fontSize: 42,
                fontWeight: 1000,
                lineHeight: 1,
                display: "inline-block",
                animation: popB ? "scorePop 320ms ease-out" : "none",
              }}
            >
              {match.totalB}
            </div>
            <div style={{ fontSize: 12, color: "#94a3b8" }}>/ {TARGET_SCORE}</div>
          </div>

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
              <option value="A">{`Team A — ${ta}`}</option>
              <option value="B">{`Team B — ${tb}`}</option>
            </select>
          </div>

          <div>
            <div style={styles.small}>Bid</div>
            <input style={styles.input("100%")} value={d.bid} onChange={(e) => onDraftPatch({ bid: e.target.value })} placeholder="80, 90, 110..." inputMode="numeric" disabled={!canPlay} />
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
            <select style={styles.select("100%")} value={d.coincheLevel} onChange={(e) => onDraftPatch({ coincheLevel: e.target.value })} disabled={!canPlay}>
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
            <input style={styles.input("100%")} value={d.bidderTrickPoints} onChange={(e) => onDraftPatch({ bidderTrickPoints: e.target.value })} placeholder="ex: 81" inputMode="numeric" disabled={!canPlay} />
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
              <option value="A">Team A</option>
              <option value="B">Team B</option>
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

      <div style={{ marginTop: 12, ...styles.small }}>This match is scorekeeping-only (no tournament logic).</div>
    </div>
  );
}