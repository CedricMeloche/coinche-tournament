import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Coinche Scorekeeper (Vite single-file App.jsx)
 * Routes:
 *   #/admin
 *   #/public
 *   #/table?code=AB12
 */

const LS_KEY = "coinche_scorekeeper_v1";
const TARGET_SCORE = 2000;

// ✅ Your Google Apps Script Web App endpoint:
const BACKUP_URL =
  "https://script.google.com/macros/s/AKfycbz-ok_dxCTExzV6LA8NixK6nYnw03MhOBZ3M6SgP_Na5-hlrhnMLX3bIUYqqq5laguSHw/exec";

// ✅ MUST match Apps Script SECRET
const BACKUP_SECRET = "CHANGE_ME_TO_A_LONG_RANDOM_STRING";

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

function normalizeScanCardCount(n) {
  const x = Number(n) || 0;
  return clamp(Math.round(x), 0, 32);
}

function getDeviceId() {
  try {
    const key = "coinche_device_id";
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const id = uid("dev");
    localStorage.setItem(key, id);
    return id;
  } catch {
    return `dev_${Date.now()}`;
  }
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
    <span title={s.label} style={{ fontWeight: 900, color: s.color, marginLeft: 4 }}>
      {s.ch}
    </span>
  );
}

/** ===== image helpers (camera scan) ===== */
function dataURLtoBlob(dataUrl) {
  const [meta, b64] = String(dataUrl).split(",");
  const mime = (meta.match(/data:(.*?);base64/) || [])[1] || "image/jpeg";
  const binStr = atob(b64);
  const len = binStr.length;
  const arr = new Uint8Array(len);
  for (let i = 0; i < len; i++) arr[i] = binStr.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

async function postScanToApi({ imageDataUrl, trumpSuit, pileSide, lastTrick }) {
  const form = new FormData();
  form.append("image", dataURLtoBlob(imageDataUrl), "hand.jpg");
  form.append("trumpSuit", trumpSuit || "S");
  form.append("pileSide", pileSide || "BIDDER");
  form.append("lastTrick", lastTrick ? "1" : "0");

  const res = await fetch("/api/scan-cards", { method: "POST", body: form });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Scan failed (${res.status}) ${t}`);
  }
  return await res.json();
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
  100% { transform: translateY(420px) rotate(520deg); opacity: 0; }
}
@keyframes fireworkParticle {
  0%   { transform: translate(0px, 0px) scale(1); opacity: 1; }
  100% { transform: translate(var(--dx), var(--dy)) scale(0.2); opacity: 0; }
}
@keyframes fireworkGlow {
  0%   { transform: scale(0.4); opacity: 0; }
  15%  { transform: scale(1); opacity: 1; }
  100% { transform: scale(1.1); opacity: 0; }
}
`;
  document.head.appendChild(el);
}

/** ===== scoring helpers ===== */
function roundTrickPointsPair(rawBidderPoints) {
  const bidderRaw = clamp(Number(rawBidderPoints) || 0, 0, 162);
  const oppRaw = 162 - bidderRaw;

  const bidderOnes = bidderRaw % 10;

  if (bidderOnes === 5) {
    return {
      bidderRounded: bidderRaw - 5,
      oppRounded: oppRaw + 5,
    };
  }

  if (bidderOnes === 6) {
    return {
      bidderRounded: bidderRaw + 4,
      oppRounded: oppRaw + 4,
    };
  }

  const bidderRounded = Math.round(bidderRaw / 10) * 10;
  const oppOnes = oppRaw % 10;
  const oppRounded =
    oppOnes === 5 ? oppRaw - 5 : oppOnes === 6 ? oppRaw + 4 : Math.round(oppRaw / 10) * 10;

  return { bidderRounded, oppRounded };
}

function computeFastCoincheScore({
  bidder,
  bid,
  coincheLevel,
  capot,
  bidderTrickPoints,
  announceA,
  announceB,
  beloteTeam,
}) {
  const bidderIsA = bidder === "A";
  const bidVal = Number(bid) || 0;

  const aAnn = Number(announceA) || 0;
  const bAnn = Number(announceB) || 0;

  const beloteA = beloteTeam === "A" ? 20 : 0;
  const beloteB = beloteTeam === "B" ? 20 : 0;
  const totalAnnounces = aAnn + bAnn;

  const rawBidder = clamp(Number(bidderTrickPoints) || 0, 0, 162);
  const { bidderRounded, oppRounded } = roundTrickPointsPair(rawBidder);

  const bidderHasBelote =
    (bidderIsA && beloteTeam === "A") || (!bidderIsA && beloteTeam === "B");
  const bidderAnn = bidderIsA ? aAnn : bAnn;

  const minRequired = bidderHasBelote ? 71 : 81;
  const special80 = bidVal === 80 ? 81 : 0;
  const required = Math.max(minRequired, special80, bidVal - bidderAnn - (bidderHasBelote ? 20 : 0));

  const bidderSucceeded = capot ? true : rawBidder >= required;
  const isCoinche = coincheLevel !== "NONE";
  const mult =
    coincheLevel === "SURCOINCHE" ? 4 : coincheLevel === "COINCHE" ? 2 : 1;

  let scoreA = 0;
  let scoreB = 0;

  if (capot) {
    const winnerTotal = 250 + totalAnnounces + beloteA + beloteB + bidVal;
    if (bidderIsA) {
      scoreA = winnerTotal;
      scoreB = 0;
    } else {
      scoreB = winnerTotal;
      scoreA = 0;
    }
    return { scoreA, scoreB, bidderSucceeded: true };
  }

  if (isCoinche) {
    const winnerTotal = 160 + totalAnnounces + mult * bidVal;
    if (bidderSucceeded) {
      if (bidderIsA) {
        scoreA = winnerTotal + beloteA;
        scoreB = beloteB;
      } else {
        scoreB = winnerTotal + beloteB;
        scoreA = beloteA;
      }
    } else {
      if (bidderIsA) {
        scoreA = beloteA;
        scoreB = winnerTotal + beloteB;
      } else {
        scoreB = beloteB;
        scoreA = winnerTotal + beloteA;
      }
    }
    return { scoreA, scoreB, bidderSucceeded };
  }

  if (bidderSucceeded) {
    if (bidderIsA) {
      scoreA = bidderRounded + aAnn + beloteA + bidVal;
      scoreB = oppRounded + bAnn + beloteB;
    } else {
      scoreB = bidderRounded + bAnn + beloteB + bidVal;
      scoreA = oppRounded + aAnn + beloteA;
    }
  } else {
    const oppGets = 160 + bidVal + totalAnnounces;
    if (bidderIsA) {
      scoreA = beloteA;
      scoreB = oppGets + beloteB;
    } else {
      scoreB = beloteB;
      scoreA = oppGets + beloteA;
    }
  }

  return { scoreA, scoreB, bidderSucceeded };
}

/** ===== routing ===== */
function parseHashRoute() {
  const raw = window.location.hash || "#/admin";
  const [pathPart, queryPart] = raw.replace(/^#/, "").split("?");
  const path = pathPart || "/admin";
  const q = new URLSearchParams(queryPart || "");
  const query = Object.fromEntries(q.entries());
  return { path, query };
}

function navigateHash(nextHash) {
  if (window.location.hash === nextHash) {
    try {
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    } catch {
      window.dispatchEvent(new Event("hashchange"));
    }
    return;
  }
  window.location.hash = nextHash;
}

/** ===== shared helpers ===== */
function sumAnnounces(d, side) {
  const v1 = safeInt(d?.[`announce${side}1`]) ?? 0;
  const v2 = safeInt(d?.[`announce${side}2`]) ?? 0;
  return v1 + v2;
}

function getTeamPlayers(team, playerById) {
  return (team?.playerIds || []).map((pid) => playerById.get(pid)).filter(Boolean);
}

function getCurrentShufflerName(match, playerById) {
  const order = match.tableOrderPlayerIds || [];
  const first = match.firstShufflerPlayerId || "";
  if (!order.length || !first) return "";

  const startIdx = order.findIndex((id) => id === first);
  if (startIdx < 0) return "";

  const handCount = (match.hands || []).length;
  const idx = (startIdx + handCount) % order.length;
  return playerById.get(order[idx])?.name || "";
}

/** ===== styles ===== */
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
    margin: 0,
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
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
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
    background: "rgba(255,255,255,0.92)",
    overflow: "hidden",
    border: "1px solid rgba(255,255,255,0.6)",
  },
  progressFillA: (pct) => ({
    height: "100%",
    width: `${pct}%`,
    background:
      "linear-gradient(90deg, rgba(34,197,94,0.98), rgba(16,185,129,0.95))",
  }),
  progressFillB: (pct) => ({
    height: "100%",
    width: `${pct}%`,
    background:
      "linear-gradient(90deg, rgba(99,102,241,0.98), rgba(59,130,246,0.95))",
  }),

  handRow1: {
    display: "grid",
    gridTemplateColumns: "repeat(5, minmax(160px, 1fr))",
    gap: 10,
    marginTop: 12,
    alignItems: "start",
  },
  handRow2: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(280px, 1fr))",
    gap: 10,
    marginTop: 10,
    alignItems: "start",
  },
  handRow3: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(180px, 1fr))",
    gap: 10,
    marginTop: 10,
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
    animation: `confettiDrop 6000ms ease-out forwards`,
    animationDelay: `${(i % 10) * 30}ms`,
    opacity: 0.95,
  }),

  fireworksWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    top: -60,
    height: 90,
    pointerEvents: "none",
    zIndex: 3,
    overflow: "visible",
  },
  fireworksGlow: (xPct, delayMs) => ({
    position: "absolute",
    left: `${xPct}%`,
    top: 48,
    width: 10,
    height: 10,
    borderRadius: 999,
    transform: "translate(-50%, -50%)",
    background: "rgba(255,255,255,0.85)",
    filter: "blur(0.4px)",
    animation: `fireworkGlow 6000ms ease-out forwards`,
    animationDelay: `${delayMs}ms`,
    boxShadow: "0 0 18px rgba(255,255,255,0.45)",
    opacity: 0,
  }),
  fireworkParticle: (xPct, delayMs, dx, dy, hue) => ({
    position: "absolute",
    left: `${xPct}%`,
    top: 48,
    width: 6,
    height: 6,
    borderRadius: 999,
    transform: "translate(-50%, -50%)",
    background: `hsla(${hue}, 90%, 60%, 0.95)`,
    animation: `fireworkParticle 6000ms ease-out forwards`,
    animationDelay: `${delayMs}ms`,
    opacity: 0,
    ["--dx"]: `${dx}px`,
    ["--dy"]: `${dy}px`,
    boxShadow: "0 0 10px rgba(255,255,255,0.22)",
  }),

  bigTotal: {
    fontSize: 52,
    fontWeight: 1000,
    letterSpacing: "-0.03em",
    lineHeight: 1.0,
  },
};

export default function App() {
  const [route, setRoute] = useState(() => parseHashRoute());
  const [loaded, setLoaded] = useState(false);
  const [tableMissingDelayDone, setTableMissingDelayDone] = useState(false);

  useEffect(() => {
    ensureGlobalCSS();
  }, []);

  const [appName, setAppName] = useState("Coinche Scorekeeper");
  const [players, setPlayers] = useState([]);
  const [teams, setTeams] = useState([]);
  const [avoidSameTeams, setAvoidSameTeams] = useState(true);
  const [pairHistory, setPairHistory] = useState([]);
  const [matches, setMatches] = useState([]);

  const [newPlayerName, setNewPlayerName] = useState("");
  const [newTeamName, setNewTeamName] = useState("");
  const [newTableName, setNewTableName] = useState("Table 1");
  const [newMatchLabel, setNewMatchLabel] = useState("Match 1");

  const inputRef = useRef(null);

  const [backupState, setBackupState] = useState({
    lastOk: null,
    lastErr: null,
    queued: 0,
  });

  const deviceIdRef = useRef(getDeviceId());
  const backupQueueRef = useRef([]);
  const backupSendingRef = useRef(false);
  const sentHandKeysRef = useRef(new Set());

  useEffect(() => {
    const syncRoute = () => setRoute(parseHashRoute());
    window.addEventListener("hashchange", syncRoute);
    window.addEventListener("popstate", syncRoute);
    syncRoute();
    return () => {
      window.removeEventListener("hashchange", syncRoute);
      window.removeEventListener("popstate", syncRoute);
    };
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
      trickSource: "",
      announceA1: "",
      announceA1PlayerId: "",
      announceA2: "",
      announceA2PlayerId: "",
      announceB1: "",
      announceB1PlayerId: "",
      announceB2: "",
      announceB2PlayerId: "",
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
      tableOrderPlayerIds: [],
      firstShufflerPlayerId: "",
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

  function persistNow(next = {}) {
    try {
      const payload = {
        appName: next.appName ?? appName,
        players: next.players ?? players,
        teams: next.teams ?? teams,
        avoidSameTeams: next.avoidSameTeams ?? avoidSameTeams,
        pairHistory: next.pairHistory ?? pairHistory,
        matches: next.matches ?? matches,
        savedAt: Date.now(),
      };
      localStorage.setItem(LS_KEY, JSON.stringify(payload));
    } catch {
      // ignore
    }
  }

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
        setMatches(
          (d.matches ?? []).map((m) => ({
            ...m,
            fastDraft: { ...defaultFastDraft(), ...(m.fastDraft || {}) },
            tableOrderPlayerIds: m.tableOrderPlayerIds || [],
            firstShufflerPlayerId: m.firstShufflerPlayerId || "",
          }))
        );
      }
    } catch {
      // ignore
    } finally {
      setLoaded(true);
    }
  }, []);

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

  const usedPlayerIds = useMemo(() => {
    const s = new Set();
    teams.forEach((t) => (t.playerIds || []).forEach((pid) => s.add(pid)));
    return s;
  }, [teams]);

  useEffect(() => {
    const current = parseHashRoute();
    const wantedCode = (current.query.code || "").toUpperCase();
    if (!wantedCode) return;
    const exists = matches.some((m) => (m.code || "").toUpperCase() === wantedCode);
    if (exists) setRoute(current);
  }, [matches]);

  useEffect(() => {
    if (route.path !== "/table") {
      setTableMissingDelayDone(false);
      return;
    }
    if ((route.query.code || "").trim() === "") {
      setTableMissingDelayDone(true);
      return;
    }
    const t = setTimeout(() => setTableMissingDelayDone(true), 350);
    return () => clearTimeout(t);
  }, [route.path, route.query.code]);

  function enqueueHandBackup(row) {
    backupQueueRef.current.push(row);
    setBackupState((s) => ({ ...s, queued: (s.queued || 0) + 1 }));
    void flushHandBackupQueue();
  }

  async function flushHandBackupQueue() {
    if (backupSendingRef.current) return;
    if (backupQueueRef.current.length === 0) return;
    backupSendingRef.current = true;

    try {
      while (backupQueueRef.current.length > 0) {
        const row = backupQueueRef.current[0];
        await sendHandRow(row);
        backupQueueRef.current.shift();
        setBackupState((s) => ({
          ...s,
          lastOk: Date.now(),
          lastErr: null,
          queued: Math.max(0, (s.queued || 1) - 1),
        }));
      }
    } catch {
      setBackupState((s) => ({
        ...s,
        lastErr: Date.now(),
      }));
      setTimeout(() => {
        backupSendingRef.current = false;
        void flushHandBackupQueue();
      }, 2000);
      return;
    } finally {
      backupSendingRef.current = false;
    }
  }

  async function sendHandRow(row) {
    const body = { ...row, secret: BACKUP_SECRET };
    const res = await fetch(BACKUP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`Backup HTTP ${res.status}`);

    try {
      const j = await res.json();
      if (j && j.ok === false) throw new Error(j.error || "Backup failed");
    } catch {
      // ignore parse errors
    }
  }

  useEffect(() => {
    if (!loaded) return;

    for (const m of matches) {
      if (!m || !m.code) continue;
      if (!m.teamAId || !m.teamBId) continue;

      const teamAName = teamById.get(m.teamAId)?.name ?? "Team A";
      const teamBName = teamById.get(m.teamBId)?.name ?? "Team B";

      for (const h of m.hands || []) {
        const editStamp = h.editedAt || 0;
        const handKey = `${m.code}|${h.idx}|${h.createdAt || 0}|${editStamp}`;
        if (sentHandKeysRef.current.has(handKey)) continue;

        sentHandKeysRef.current.add(handKey);

        const ds = h.draftSnapshot || {};
        enqueueHandBackup({
          timestamp: new Date().toISOString(),
          tournamentName: appName || "Coinche Scorekeeper",
          matchCode: m.code,
          matchLabel: `${m.tableName || ""} • ${m.label || ""}`.trim(),
          teamA: teamAName,
          teamB: teamBName,
          handIdx: h.idx ?? "",
          scoreA: h.scoreA ?? "",
          scoreB: h.scoreB ?? "",
          bidder: ds.bidder || "",
          bid: ds.bid ?? "",
          suit: ds.suit || "",
          coincheLevel: ds.coincheLevel || "",
          capot: !!ds.capot,
          bidderTrickPoints: ds.bidderTrickPoints ?? "",
          announceA: sumAnnounces(ds, "A"),
          announceB: sumAnnounces(ds, "B"),
          beloteTeam: ds.beloteTeam || "",
          bidderSucceeded: !!h.bidderSucceeded,
          totalA: m.totalA ?? "",
          totalB: m.totalB ?? "",
          deviceId: deviceIdRef.current,
        });
      }
    }
  }, [loaded, matches, teamById, appName]);

  useEffect(() => {
    const onOnline = () => void flushHandBackupQueue();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, []);

  function addPlayer() {
    const name = newPlayerName.trim();
    if (!name) return;
    const nextPlayers = [...players, { id: uid("p"), name }];
    setPlayers(nextPlayers);
    persistNow({ players: nextPlayers });
    setNewPlayerName("");
    setTimeout(() => inputRef.current?.focus?.(), 0);
  }

  function removePlayer(id) {
    const nextPlayers = players.filter((p) => p.id !== id);
    setPlayers(nextPlayers);
    setTeams([]);
    setPairHistory([]);
    setMatches([]);
    persistNow({
      players: nextPlayers,
      teams: [],
      pairHistory: [],
      matches: [],
    });
  }

  function addTeam() {
    const name = (newTeamName || "").trim();
    const teamName = name || `Team ${teams.length + 1}`;
    const nextTeams = [
      ...teams,
      { id: uid("t"), name: teamName, playerIds: [], locked: false },
    ];
    setTeams(nextTeams);
    persistNow({ teams: nextTeams });
    setNewTeamName("");
  }

  function removeTeam(teamId) {
    const nextTeams = teams.filter((t) => t.id !== teamId);
    const nextMatches = matches.map((m) => {
      const next = { ...m };
      if (next.teamAId === teamId) next.teamAId = null;
      if (next.teamBId === teamId) next.teamBId = null;
      return recomputeMatch({
        ...next,
        hands: [],
        forcedComplete: false,
        editingHandIdx: null,
        fastDraft: defaultFastDraft(),
        tableOrderPlayerIds: [],
        firstShufflerPlayerId: "",
      });
    });

    setTeams(nextTeams);
    setMatches(nextMatches);
    persistNow({ teams: nextTeams, matches: nextMatches });
  }

  function toggleTeamLock(teamId, locked) {
    const nextTeams = teams.map((t) =>
      t.id === teamId ? { ...t, locked: Boolean(locked) } : t
    );
    setTeams(nextTeams);
    persistNow({ teams: nextTeams });
  }

  function setTeamPlayer(teamId, slotIdx, playerIdOrEmpty) {
    const nextTeams = teams.map((t) => {
      if (t.id !== teamId) return t;
      const ids = [...(t.playerIds || [])];
      while (ids.length < 2) ids.push("");
      ids[slotIdx] = playerIdOrEmpty;
      if (slotIdx === 0 && ids[0] && ids[0] === ids[1]) ids[1] = "";
      if (slotIdx === 1 && ids[1] && ids[0] === ids[1]) ids[0] = "";
      return { ...t, playerIds: ids.filter(Boolean) };
    });
    setTeams(nextTeams);
    persistNow({ teams: nextTeams });
  }

  function renameTeam(teamId, name) {
    const nextTeams = teams.map((t) => (t.id === teamId ? { ...t, name } : t));
    setTeams(nextTeams);
    persistNow({ teams: nextTeams });
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
    const nextTeams = teams.map((t) => ({
      ...t,
      playerIds: [...(t.playerIds || [])],
    }));

    let pairIdx = 0;
    for (let i = 0; i < nextTeams.length; i++) {
      if (nextTeams[i].locked) continue;
      const pair = finalPairs[pairIdx] || [null, null];
      pairIdx++;
      nextTeams[i].playerIds = [pair[0], pair[1]].filter(Boolean);
    }

    const newPairs = [];
    for (const t of nextTeams) {
      if ((t.playerIds || []).length === 2) {
        newPairs.push([...t.playerIds].sort().join("|"));
      }
    }

    const nextPairHistory = Array.from(new Set([...pairHistory, ...newPairs]));
    const nextMatches = matches.map((m) =>
      recomputeMatch({
        ...m,
        hands: [],
        forcedComplete: false,
        editingHandIdx: null,
        fastDraft: defaultFastDraft(),
        tableOrderPlayerIds: [],
        firstShufflerPlayerId: "",
      })
    );

    setTeams(nextTeams);
    setPairHistory(nextPairHistory);
    setMatches(nextMatches);
    persistNow({
      teams: nextTeams,
      pairHistory: nextPairHistory,
      matches: nextMatches,
    });
  }

  function addMatch() {
    if (!teams.length) return;

    const nextMatch = recomputeMatch(
      makeEmptyMatch({
        tableName: newTableName.trim() || `Table ${matches.length + 1}`,
        teamAId: null,
        teamBId: null,
        label: newMatchLabel.trim() || `Match ${matches.length + 1}`,
      })
    );

    const nextMatches = [...matches, nextMatch];
    setMatches(nextMatches);
    persistNow({ matches: nextMatches });
  }

  function removeMatch(matchId) {
    const nextMatches = matches.filter((m) => m.id !== matchId);
    setMatches(nextMatches);
    persistNow({ matches: nextMatches });
  }

  function setMatchTeam(matchId, side, teamIdOrEmpty) {
    const nextMatches = matches.map((m) => {
      if (m.id !== matchId) return m;
      const next = { ...m, [side]: teamIdOrEmpty || null };
      return recomputeMatch({
        ...next,
        hands: [],
        forcedComplete: false,
        editingHandIdx: null,
        fastDraft: defaultFastDraft(),
        tableOrderPlayerIds: [],
        firstShufflerPlayerId: "",
      });
    });

    setMatches(nextMatches);
    persistNow({ matches: nextMatches });
  }

  function renameMatch(matchId, patch) {
    const nextMatches = matches.map((m) =>
      m.id === matchId ? { ...m, ...patch, lastUpdatedAt: Date.now() } : m
    );
    setMatches(nextMatches);
    persistNow({ matches: nextMatches });
  }

  function updateTableSetup(matchId, patch) {
    const nextMatches = matches.map((m) =>
      m.id === matchId ? { ...m, ...patch, lastUpdatedAt: Date.now() } : m
    );
    setMatches(nextMatches);
    persistNow({ matches: nextMatches });
  }

  function finishMatchNow(matchId) {
    const nextMatches = matches.map((m) => {
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
    });

    setMatches(nextMatches);
    persistNow({ matches: nextMatches });
  }

  function updateDraft(matchId, patch) {
    const nextMatches = matches.map((m) => {
      if (m.id !== matchId) return m;
      return {
        ...m,
        fastDraft: { ...(m.fastDraft || defaultFastDraft()), ...patch },
      };
    });

    setMatches(nextMatches);
    persistNow({ matches: nextMatches });
  }

  function startEditHand(matchId, handIdx) {
    const nextMatches = matches.map((m) => {
      if (m.id !== matchId) return m;
      const hand = (m.hands || []).find((h) => h.idx === handIdx);
      if (!hand) return m;
      const d = hand.draftSnapshot || {};
      return {
        ...m,
        editingHandIdx: handIdx,
        fastDraft: {
          ...defaultFastDraft(),
          bidder: d.bidder ?? "A",
          bid: String(d.bid ?? ""),
          suit: d.suit ?? "S",
          coincheLevel: d.coincheLevel ?? "NONE",
          capot: Boolean(d.capot),
          bidderTrickPoints: String(d.bidderTrickPoints ?? ""),
          nonBidderTrickPoints: String(d.nonBidderTrickPoints ?? ""),
          trickSource: d.trickSource ?? "",
          announceA1: String(d.announceA1 ?? ""),
          announceA1PlayerId: d.announceA1PlayerId ?? "",
          announceA2: String(d.announceA2 ?? ""),
          announceA2PlayerId: d.announceA2PlayerId ?? "",
          announceB1: String(d.announceB1 ?? ""),
          announceB1PlayerId: d.announceB1PlayerId ?? "",
          announceB2: String(d.announceB2 ?? ""),
          announceB2PlayerId: d.announceB2PlayerId ?? "",
          beloteTeam: d.beloteTeam ?? "NONE",
        },
      };
    });

    setMatches(nextMatches);
    persistNow({ matches: nextMatches });
  }

  function cancelEditHand(matchId) {
    const nextMatches = matches.map((m) =>
      m.id === matchId
        ? { ...m, editingHandIdx: null, fastDraft: defaultFastDraft() }
        : m
    );

    setMatches(nextMatches);
    persistNow({ matches: nextMatches });
  }

  function parseBidValue(bidStr) {
    const s = String(bidStr || "").trim().toLowerCase();
    if (s === "capot") return 250;
    const n = safeInt(bidStr);
    return n;
  }

  function addOrSaveHand(matchId) {
    const nextMatches = matches.map((m) => {
      if (m.id !== matchId) return m;

      const canPlay = !!m.teamAId && !!m.teamBId;
      const d = m.fastDraft || defaultFastDraft();

      const setupOrderOk = Array.isArray(m.tableOrderPlayerIds) && m.tableOrderPlayerIds.length === 4;
      const firstShufflerOk = Boolean(m.firstShufflerPlayerId);

      if (!canPlay || !setupOrderOk || !firstShufflerOk) return m;

      const bidVal = parseBidValue(d.bid);
      const bidIsCapotWord = String(d.bid || "").trim().toLowerCase() === "capot";
      const capotFlag = Boolean(d.capot) || bidIsCapotWord;

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

      const announceA = sumAnnounces(d, "A");
      const announceB = sumAnnounces(d, "B");

      const res = computeFastCoincheScore({
        bidder: d.bidder,
        bid: bidVal,
        coincheLevel: d.coincheLevel || "NONE",
        capot: capotFlag,
        bidderTrickPoints: trickVal,
        announceA,
        announceB,
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
        announceA1: safeInt(d.announceA1) ?? 0,
        announceA1PlayerId: d.announceA1PlayerId || "",
        announceA2: safeInt(d.announceA2) ?? 0,
        announceA2PlayerId: d.announceA2PlayerId || "",
        announceB1: safeInt(d.announceB1) ?? 0,
        announceB1PlayerId: d.announceB1PlayerId || "",
        announceB2: safeInt(d.announceB2) ?? 0,
        announceB2PlayerId: d.announceB2PlayerId || "",
        announceA,
        announceB,
        beloteTeam: d.beloteTeam || "NONE",
      };

      if (m.editingHandIdx) {
        const nextHands = (m.hands || []).map((h) => {
          if (h.idx !== m.editingHandIdx) return h;
          return {
            ...h,
            draftSnapshot: snap,
            scoreA: res.scoreA,
            scoreB: res.scoreB,
            bidderSucceeded: res.bidderSucceeded,
            editedAt: Date.now(),
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
        draftSnapshot: snap,
        scoreA: res.scoreA,
        scoreB: res.scoreB,
        bidderSucceeded: res.bidderSucceeded,
      };

      return recomputeMatch({
        ...m,
        hands: [...(m.hands || []), nextHand],
        fastDraft: defaultFastDraft(),
      });
    });

    setMatches(nextMatches);
    persistNow({ matches: nextMatches });
  }

  function clearMatchHands(matchId) {
    const nextMatches = matches.map((m) =>
      m.id === matchId
        ? recomputeMatch({
            ...m,
            hands: [],
            forcedComplete: false,
            editingHandIdx: null,
            fastDraft: defaultFastDraft(),
          })
        : m
    );

    setMatches(nextMatches);
    persistNow({ matches: nextMatches });
  }

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

  const funStats = useMemo(() => {
    const completed = matches.filter((m) => m.completed && m.teamAId && m.teamBId);

    let biggestBlowout = { diff: 0, label: "—" };
    for (const m of completed) {
      const diff = Math.abs((m.totalA || 0) - (m.totalB || 0));
      if (diff > biggestBlowout.diff) {
        const ta = teamById.get(m.teamAId)?.name ?? "Team A";
        const tb = teamById.get(m.teamBId)?.name ?? "Team B";
        biggestBlowout = { diff, label: `${ta} vs ${tb} (${m.label})` };
      }
    }

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

    const defenseCounts = new Map();
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

    const teamFun = new Map();
    const announceCountByPlayer = new Map();
    const announceTotalByPlayer = new Map();

    const bump = (tid, key, n = 1) => {
      if (!tid) return;
      const cur = teamFun.get(tid) || { coinches: 0, surcoinches: 0