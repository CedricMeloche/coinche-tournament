import React, { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabaseClient";

/**
 * Coinche Scorekeeper (Supabase live version)
 * Routes:
 *   #/admin
 *   #/public
 *   #/table?code=AB12
 */

const LS_KEY = "coinche_scorekeeper_local_admin_v2";
const TARGET_SCORE = 2000;

/* =========================
   Helpers
========================= */

const uid = (prefix = "id") =>
  `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;

function shortCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const safeInt = (v) => {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[^0-9\-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

const clamp = (n, lo, hi) => {
  const x = Number(n);
  return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : lo;
};

const num = (v, d = 0) => safeInt(v) ?? d;
const normalizeScanCardCount = (n) => clamp(Math.round(Number(n) || 0), 0, 32);
const parseBidValue = (v) => (String(v || "").trim().toLowerCase() === "capot" ? 250 : safeInt(v));

function SuitIcon({ suit }) {
  const map = {
    H: { ch: "♥", color: "#fb7185", label: "Hearts" },
    D: { ch: "♦", color: "#fb7185", label: "Diamonds" },
    C: { ch: "♣", color: "#34d399", label: "Clubs" },
    S: { ch: "♠", color: "#60a5fa", label: "Spades" },
  };
  const s = map[suit] || map.S;
  return (
    <span title={s.label} style={{ fontWeight: 900, color: s.color }}>
      {s.ch}
    </span>
  );
}

/* =========================
   Camera helpers
========================= */

function dataURLtoBlob(dataUrl) {
  const [meta, b64] = String(dataUrl).split(",");
  const mime = (meta.match(/data:(.*?);base64/) || [])[1] || "image/jpeg";
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
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
  return res.json();
}

/* =========================
   Global CSS
========================= */

function ensureGlobalCSS() {
  if (typeof document === "undefined") return;
  if (document.getElementById("coinche_global_css")) return;
  const el = document.createElement("style");
  el.id = "coinche_global_css";
  el.innerHTML = `
@keyframes confettiDrop {
  0% { transform: translateY(0) rotate(0deg); opacity: 1; }
  100% { transform: translateY(420px) rotate(520deg); opacity: 0; }
}
@keyframes fireworkParticle {
  0% { transform: translate(0px,0px) scale(1); opacity: 1; }
  100% { transform: translate(var(--dx), var(--dy)) scale(0.2); opacity: 0; }
}
@keyframes fireworkGlow {
  0% { transform: scale(0.4); opacity: 0; }
  15% { transform: scale(1); opacity: 1; }
  100% { transform: scale(1.1); opacity: 0; }
}`;
  document.head.appendChild(el);
}

/* =========================
   Scoring
========================= */

function roundTrickPointsPair(rawBidderPoints) {
  const bidderRaw = clamp(Number(rawBidderPoints) || 0, 0, 162);
  const oppRaw = 162 - bidderRaw;
  const bidderOnes = bidderRaw % 10;

  if (bidderOnes === 5) return { bidderRounded: bidderRaw - 5, oppRounded: oppRaw + 5 };
  if (bidderOnes === 6) return { bidderRounded: bidderRaw + 4, oppRounded: oppRaw + 4 };

  const bidderRounded = Math.round(bidderRaw / 10) * 10;
  const oppOnes = oppRaw % 10;
  const oppRounded =
    oppOnes === 5 ? oppRaw - 5 : oppOnes === 6 ? oppRaw + 4 : Math.round(oppRaw / 10) * 10;

  return { bidderRounded, oppRounded };
}

function resolveAnnounces({
  bidder,
  announceA,
  announceB,
  announceWinner,
  beloteTeam,
}) {
  const validAnnounceA = announceWinner === "A" ? Number(announceA) || 0 : 0;
  const validAnnounceB = announceWinner === "B" ? Number(announceB) || 0 : 0;
  const totalValidAnnounces = validAnnounceA + validAnnounceB;

  const bidderValidAnnounces = bidder === "A" ? validAnnounceA : validAnnounceB;

  const beloteA = beloteTeam === "A" ? 20 : 0;
  const beloteB = beloteTeam === "B" ? 20 : 0;
  const bidderBelote = bidder === "A" ? beloteA : beloteB;

  return {
    validAnnounceA,
    validAnnounceB,
    totalValidAnnounces,
    beloteA,
    beloteB,
    bidderValidAnnounces,
    bidderBelote,
  };
}

function computeFastCoincheScore({
  bidder,
  bid,
  coincheLevel,
  capot,
  bidderTrickPoints,
  announceA,
  announceB,
  announceWinner,
  beloteTeam,
}) {
  const bidderIsA = bidder === "A";
  const bidVal = Number(bid) || 0;
  const rawBidder = clamp(Number(bidderTrickPoints) || 0, 0, 162);
  const { bidderRounded, oppRounded } = roundTrickPointsPair(rawBidder);
  const {
    validAnnounceA,
    validAnnounceB,
    totalValidAnnounces,
    beloteA,
    beloteB,
    bidderValidAnnounces,
    bidderBelote,
  } = resolveAnnounces({
    bidder,
    announceA,
    announceB,
    announceWinner,
    beloteTeam,
  });

  const minRequired = bidderBelote > 0 ? 71 : 81;
  const special80 = bidVal === 80 ? 81 : 0;
  const required = Math.max(minRequired, special80, bidVal - bidderValidAnnounces - bidderBelote);

  const bidderSucceeded = capot ? true : rawBidder >= required;
  const mult = coincheLevel === "SURCOINCHE" ? 4 : coincheLevel === "COINCHE" ? 2 : 1;
  const isCoinche = coincheLevel !== "NONE";

  let scoreA = 0;
  let scoreB = 0;

  if (capot) {
    const winnerTotal = 250 + totalValidAnnounces + beloteA + beloteB + bidVal;
    return bidderIsA
      ? { scoreA: winnerTotal, scoreB: 0, bidderSucceeded: true }
      : { scoreA: 0, scoreB: winnerTotal, bidderSucceeded: true };
  }

  if (isCoinche) {
    const winnerTotal = 160 + totalValidAnnounces + mult * bidVal;
    if (bidderSucceeded) {
      scoreA = bidderIsA ? winnerTotal + beloteA : beloteA;
      scoreB = bidderIsA ? beloteB : winnerTotal + beloteB;
    } else {
      scoreA = bidderIsA ? beloteA : winnerTotal + beloteA;
      scoreB = bidderIsA ? winnerTotal + beloteB : beloteB;
    }
    return { scoreA, scoreB, bidderSucceeded };
  }

  if (bidderSucceeded) {
    scoreA = bidderIsA
      ? bidderRounded + validAnnounceA + beloteA + bidVal
      : oppRounded + validAnnounceA + beloteA;
    scoreB = bidderIsA
      ? oppRounded + validAnnounceB + beloteB
      : bidderRounded + validAnnounceB + beloteB + bidVal;
  } else {
    const oppGets = 160 + bidVal + totalValidAnnounces;
    scoreA = bidderIsA ? beloteA : oppGets + beloteA;
    scoreB = bidderIsA ? oppGets + beloteB : beloteB;
  }

  return { scoreA, scoreB, bidderSucceeded };
}

/* =========================
   Routing
========================= */

function parseHashRoute() {
  const raw = window.location.hash || "#/admin";
  const [pathPart, queryPart] = raw.replace(/^#/, "").split("?");
  const path = pathPart || "/admin";
  const query = Object.fromEntries(new URLSearchParams(queryPart || "").entries());
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

/* =========================
   Match helpers
========================= */

const defaultFastDraft = () => ({
  bidder: "A",
  bid: "",
  suit: "S",
  coincheLevel: "NONE",
  capot: false,
  bidderTrickPoints: "",
  nonBidderTrickPoints: "",
  trickSource: "",
  beloteTeam: "NONE",
  announceWinner: "NONE",
  announceA1: "",
  announceA1PlayerId: "",
  announceA2: "",
  announceA2PlayerId: "",
  announceB1: "",
  announceB1PlayerId: "",
  announceB2: "",
  announceB2PlayerId: "",
});

const normalizeLoadedMatch = (m) => ({
  ...m,
  fastDraft: { ...defaultFastDraft(), ...(m.fastDraft || {}) },
  tableOrderPlayerIds: m.tableOrderPlayerIds ?? [],
  firstShufflerPlayerId: m.firstShufflerPlayerId ?? "",
});

function makeEmptyMatch({ tableName, teamAId, teamBId, label }) {
  return {
    id: uid("match"),
    code: shortCode(),
    tableName: tableName || "Table",
    label: label || "Match",
    teamAId: teamAId || null,
    teamBId: teamBId || null,
    teamAName: "",
    teamBName: "",
    teamAPlayers: [],
    teamBPlayers: [],
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
  let totalA = 0;
  let totalB = 0;
  const diffs = [];
  for (const h of m.hands || []) {
    totalA += Number(h.scoreA) || 0;
    totalB += Number(h.scoreB) || 0;
    diffs.push(totalA - totalB);
  }
  const completed = Boolean(m.forcedComplete) || totalA >= TARGET_SCORE || totalB >= TARGET_SCORE;
  const winnerId = completed && totalA !== totalB ? (totalA > totalB ? m.teamAId : m.teamBId) : null;
  return { ...m, totalA, totalB, completed, winnerId, timelineDiffs: diffs, lastUpdatedAt: Date.now() };
}

const sumAnnounces = (d, side) => num(d?.[`announce${side}1`]) + num(d?.[`announce${side}2`]);

const getTeamPlayers = (team, playerById) =>
  (team?.playerIds || []).map((id) => playerById.get(id)).filter(Boolean);

function getTeamNameForMatch(match, side, teamById) {
  const id = side === "A" ? match.teamAId : match.teamBId;
  const localTeam = id ? teamById.get(id) : null;
  if (localTeam?.name) return localTeam.name;
  return side === "A" ? match.teamAName || "Team A" : match.teamBName || "Team B";
}

function getMatchSidePlayers(match, side, teamById, playerById) {
  const id = side === "A" ? match.teamAId : match.teamBId;
  const localTeam = id ? teamById.get(id) : null;
  if (localTeam) return getTeamPlayers(localTeam, playerById);
  const arr = side === "A" ? match.teamAPlayers : match.teamBPlayers;
  return (arr || []).map((p) => ({ id: p.id, name: p.name })).filter((p) => p.id || p.name);
}

function getCurrentShufflerInfo(match, playerById) {
  const order = match.tableOrderPlayerIds || [];
  if (!order.length || !match.firstShufflerPlayerId) return { playerId: "", name: "" };
  const startIdx = order.findIndex((id) => id === match.firstShufflerPlayerId);
  if (startIdx < 0) return { playerId: "", name: "" };
  const idx = (startIdx + (match.hands || []).length) % order.length;
  const playerId = order[idx] || "";
  const snapPlayers = [...(match.teamAPlayers || []), ...(match.teamBPlayers || [])];
  return {
    playerId,
    name:
      playerById.get(playerId)?.name ||
      snapPlayers.find((p) => p.id === playerId)?.name ||
      "",
  };
}

/* =========================
   Styles
========================= */

const bg = "rgba(2,6,23,0.35)";
const bd = "1px solid rgba(148,163,184,0.18)";
const inputBase = {
  borderRadius: 14,
  border: "1px solid rgba(148,163,184,0.22)",
  background: "rgba(255,255,255,0.92)",
  color: "#0b1220",
  outline: "none",
  boxSizing: "border-box",
  minWidth: 0,
  display: "block",
  fontWeight: 800,
};

const styles = {
  page: {
    minHeight: "100vh",
    background:
      "radial-gradient(1200px 600px at 10% 10%, rgba(99,102,241,0.25), transparent 60%), radial-gradient(1200px 600px at 90% 10%, rgba(16,185,129,0.18), transparent 55%), radial-gradient(1200px 600px at 50% 90%, rgba(244,63,94,0.12), transparent 60%), linear-gradient(180deg, #0b1220 0%, #050814 100%)",
    color: "#e5e7eb",
    padding: 16,
  },
  container: { width: "100%", maxWidth: "none", margin: 0, display: "flex", flexDirection: "column", gap: 14 },
  topbar: { display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 12, flexWrap: "wrap" },
  title: { margin: 0, fontSize: 28, fontWeight: 950, letterSpacing: "-0.02em" },
  subtitle: { color: "#94a3b8", marginTop: 6, fontSize: 13 },
  pillRow: { display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" },
  section: {
    background: "rgba(2,6,23,0.55)",
    border: bd,
    borderRadius: 18,
    padding: 14,
    boxShadow: "0 12px 40px rgba(0,0,0,0.25)",
  },
  sectionHeader: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 10 },
  h2: { margin: 0, fontSize: 16, fontWeight: 900, letterSpacing: "-0.01em" },
  small: { fontSize: 12, color: "#94a3b8" },
  row: { display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" },
  card: { background: bg, border: bd, borderRadius: 18, padding: 12 },
  grid2: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: 12 },
  grid3: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 },
  grid4: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 },
  handRow1: { display: "grid", gridTemplateColumns: "repeat(5, minmax(160px, 1fr))", gap: 10, marginTop: 12, alignItems: "start" },
  handRow2: { display: "grid", gridTemplateColumns: "repeat(2, minmax(280px, 1fr))", gap: 10, marginTop: 10, alignItems: "start" },
  handRow3: { display: "grid", gridTemplateColumns: "repeat(4, minmax(180px, 1fr))", gap: 10, marginTop: 10, alignItems: "start" },
  handRow: { border: "1px solid rgba(148,163,184,0.16)", background: bg, borderRadius: 16, padding: 12, display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" },
  input: (w = 240) => ({ ...inputBase, width: typeof w === "number" ? `${w}px` : w, padding: "10px 12px" }),
  select: (w = 180) => ({ ...inputBase, width: typeof w === "number" ? `${w}px` : w, padding: "10px 12px" }),
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
  btnGhost: { padding: "8px 10px", borderRadius: 12, border: "1px solid transparent", background: "transparent", color: "#94a3b8", cursor: "pointer", fontWeight: 900 },
  disabled: { opacity: 0.55, cursor: "not-allowed" },
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
  progressWrap: { height: 12, borderRadius: 999, background: "rgba(255,255,255,0.95)", overflow: "hidden", border: "1px solid rgba(255,255,255,0.7)" },
  progressFillA: (pct) => ({ height: "100%", width: `${pct}%`, background: "linear-gradient(90deg, rgba(34,197,94,0.98), rgba(16,185,129,0.95))" }),
  progressFillB: (pct) => ({ height: "100%", width: `${pct}%`, background: "linear-gradient(90deg, rgba(99,102,241,0.98), rgba(59,130,246,0.95))" }),
  leaderGlow: { boxShadow: "0 0 20px rgba(34,197,94,0.35), 0 0 50px rgba(34,197,94,0.18)", border: "1px solid rgba(34,197,94,0.35)" },
  winnerGlow: { boxShadow: "0 0 28px rgba(34,197,94,0.55), 0 0 90px rgba(34,197,94,0.28), 0 0 140px rgba(34,197,94,0.16)", border: "2px solid rgba(34,197,94,0.55)" },
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
    zIndex: 4,
  },
  trophyCircle: { width: 26, height: 26, borderRadius: 999, display: "inline-flex", alignItems: "center", justifyContent: "center", background: "rgba(34,197,94,0.25)", border: "1px solid rgba(34,197,94,0.45)", fontWeight: 1000 },
  confettiWrap: { position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden", borderRadius: 18, zIndex: 2 },
  confettiPiece: (i) => ({
    position: "absolute",
    left: `${(i * 11) % 100}%`,
    top: "-12px",
    width: `${6 + ((i * 7) % 6)}px`,
    height: `${10 + ((i * 5) % 10)}px`,
    borderRadius: 3,
    background: `hsla(${(i * 37) % 360},90%,60%,0.95)`,
    transform: `rotate(${(i * 23) % 180}deg)`,
    animation: `confettiDrop 6000ms ease-out forwards`,
    animationDelay: `${(i % 10) * 30}ms`,
    opacity: 0.95,
  }),
  fireworksWrap: { position: "absolute", left: 0, right: 0, top: -60, height: 90, pointerEvents: "none", zIndex: 3, overflow: "visible" },
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
    background: `hsla(${hue},90%,60%,0.95)`,
    animation: `fireworkParticle 6000ms ease-out forwards`,
    animationDelay: `${delayMs}ms`,
    opacity: 0,
    ["--dx"]: `${dx}px`,
    ["--dy"]: `${dy}px`,
    boxShadow: "0 0 10px rgba(255,255,255,0.22)",
  }),
  bigTotal: { fontSize: 52, fontWeight: 1000, letterSpacing: "-0.03em", lineHeight: 1.0 },
};

const td = { padding: "10px 10px", borderBottom: "1px solid rgba(148,163,184,0.10)", fontWeight: 800 };
const tdBold = { ...td, fontWeight: 950 };
const tdStrong = { ...td, fontWeight: 1000 };

/* =========================
   App
========================= */

export default function App() {
  const [route, setRoute] = useState(() => parseHashRoute());
  const [loaded, setLoaded] = useState(false);
  const [tableMissingDelayDone, setTableMissingDelayDone] = useState(false);

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

  useEffect(() => ensureGlobalCSS(), []);

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

  const playerById = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);
  const teamById = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams]);

  function persistLocal(next = {}) {
    try {
      localStorage.setItem(
        LS_KEY,
        JSON.stringify({
          appName: next.appName ?? appName,
          players: next.players ?? players,
          teams: next.teams ?? teams,
          avoidSameTeams: next.avoidSameTeams ?? avoidSameTeams,
          pairHistory: next.pairHistory ?? pairHistory,
          savedAt: Date.now(),
        })
      );
    } catch {}
  }

  function hydrateLocalAdmin() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      setAppName(d.appName ?? "Coinche Scorekeeper");
      setPlayers(d.players ?? []);
      setTeams(d.teams ?? []);
      setAvoidSameTeams(Boolean(d.avoidSameTeams ?? true));
      setPairHistory(d.pairHistory ?? []);
    } catch {}
  }

  function snapshotTeam(teamId, fallbackName = "", fallbackPlayers = []) {
    const team = teamId ? teamById.get(teamId) : null;
    if (!team) {
      return {
        name: fallbackName || "",
        players: fallbackPlayers || [],
      };
    }
    return {
      name: team.name || fallbackName || "",
      players: getTeamPlayers(team, playerById).map((p) => ({ id: p.id, name: p.name })),
    };
  }

  function matchToRow(m) {
    const snapA = snapshotTeam(m.teamAId, m.teamAName, m.teamAPlayers);
    const snapB = snapshotTeam(m.teamBId, m.teamBName, m.teamBPlayers);

    return {
      id: m.id,
      code: m.code,
      app_name: appName || "Coinche Scorekeeper",
      table_name: m.tableName,
      label: m.label,
      team_a_id: m.teamAId,
      team_b_id: m.teamBId,
      team_a_name: snapA.name || "",
      team_b_name: snapB.name || "",
      team_a_players: snapA.players || [],
      team_b_players: snapB.players || [],
      total_a: m.totalA || 0,
      total_b: m.totalB || 0,
      winner_id: m.winnerId,
      completed: !!m.completed,
      forced_complete: !!m.forcedComplete,
      table_order_player_ids: m.tableOrderPlayerIds || [],
      first_shuffler_player_id: m.firstShufflerPlayerId || "",
      updated_at: new Date().toISOString(),
    };
  }

  async function loadMatchesFromSupabase() {
    const { data, error } = await supabase
      .from("matches")
      .select("*")
      .order("updated_at", { ascending: true });

    if (error) {
      console.error("Failed to load matches:", error);
      return [];
    }
    return data || [];
  }

  async function loadHandsFromSupabase() {
    const { data, error } = await supabase
      .from("hands")
      .select("*")
      .order("match_id", { ascending: true })
      .order("hand_idx", { ascending: true });

    if (error) {
      console.error("Failed to load hands:", error);
      return [];
    }
    return data || [];
  }

  async function refreshFromSupabase() {
    const [matchRows, handRows] = await Promise.all([
      loadMatchesFromSupabase(),
      loadHandsFromSupabase(),
    ]);

    const handsByMatch = new Map();

    for (const row of handRows) {
      if (!handsByMatch.has(row.match_id)) handsByMatch.set(row.match_id, []);
      handsByMatch.get(row.match_id).push({
        idx: row.hand_idx,
        scoreA: row.score_a,
        scoreB: row.score_b,
        bidderSucceeded: !!row.bidder_succeeded,
        draftSnapshot: row.draft_snapshot || {},
        createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
        editedAt: row.edited_at ? new Date(row.edited_at).getTime() : undefined,
      });
    }

    const rebuiltMatches = matchRows.map((row) =>
      recomputeMatch(
        normalizeLoadedMatch({
          id: row.id,
          code: row.code,
          tableName: row.table_name,
          label: row.label,
          teamAId: row.team_a_id,
          teamBId: row.team_b_id,
          teamAName: row.team_a_name || "",
          teamBName: row.team_b_name || "",
          teamAPlayers: row.team_a_players || [],
          teamBPlayers: row.team_b_players || [],
          totalA: row.total_a || 0,
          totalB: row.total_b || 0,
          winnerId: row.winner_id,
          completed: !!row.completed,
          forcedComplete: !!row.forced_complete,
          tableOrderPlayerIds: row.table_order_player_ids || [],
          firstShufflerPlayerId: row.first_shuffler_player_id || "",
          lastUpdatedAt: row.updated_at ? new Date(row.updated_at).getTime() : Date.now(),
          hands: handsByMatch.get(row.id) || [],
          fastDraft: defaultFastDraft(),
          editingHandIdx: null,
        })
      )
    );

    setMatches(rebuiltMatches);
    if (matchRows[0]?.app_name) setAppName(matchRows[0].app_name);
  }

  async function saveMatchToSupabase(match) {
    const { error } = await supabase.from("matches").upsert(matchToRow(match));
    if (error) console.error("Failed to save match:", error);
  }

  async function deleteMatchFromSupabase(matchId) {
    const { error } = await supabase.from("matches").delete().eq("id", matchId);
    if (error) console.error("Failed to delete match:", error);
  }

  async function saveHandToSupabase(matchId, hand) {
    const { error } = await supabase.from("hands").upsert({
      match_id: matchId,
      hand_idx: hand.idx,
      score_a: hand.scoreA,
      score_b: hand.scoreB,
      bidder_succeeded: !!hand.bidderSucceeded,
      draft_snapshot: hand.draftSnapshot || {},
      created_at: hand.createdAt ? new Date(hand.createdAt).toISOString() : new Date().toISOString(),
      edited_at: hand.editedAt ? new Date(hand.editedAt).toISOString() : null,
    });
    if (error) console.error("Failed to save hand:", error);
  }

  async function clearHandsFromSupabase(matchId) {
    const { error } = await supabase.from("hands").delete().eq("match_id", matchId);
    if (error) console.error("Failed to clear hands:", error);
  }

  useEffect(() => {
    let active = true;
    hydrateLocalAdmin();

    (async () => {
      try {
        await refreshFromSupabase();
      } catch (err) {
        console.error("Initial Supabase load failed:", err);
      } finally {
        if (active) setLoaded(true);
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const channel = supabase
      .channel("coinche-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "matches" }, async () => {
        await refreshFromSupabase();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "hands" }, async () => {
        await refreshFromSupabase();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    if (!loaded || !matches.length) return;
    Promise.all(matches.map((m) => saveMatchToSupabase(m))).catch(console.error);
  }, [appName]);

  useEffect(() => {
    const current = parseHashRoute();
    const wantedCode = (current.query.code || "").toUpperCase();
    if (!wantedCode) return;
    if (matches.some((m) => (m.code || "").toUpperCase() === wantedCode)) setRoute(current);
  }, [matches]);

  useEffect(() => {
    if (route.path !== "/table") {
      setTableMissingDelayDone(false);
      return;
    }
    if (!(route.query.code || "").trim()) {
      setTableMissingDelayDone(true);
      return;
    }
    const t = setTimeout(() => setTableMissingDelayDone(true), 350);
    return () => clearTimeout(t);
  }, [route.path, route.query.code]);

  useEffect(() => {
    if (route.path !== "/table") return;
    const code = String(route.query.code || "").toUpperCase();
    if (!code) return;
    if (matches.some((m) => (m.code || "").toUpperCase() === code)) return;
    void refreshFromSupabase();
  }, [route.path, route.query.code]);

  function openTableRoute(code) {
    navigateHash(`#/table?code=${code}`);
  }

  const usedPlayerIds = useMemo(() => {
    const s = new Set();
    teams.forEach((t) => (t.playerIds || []).forEach((pid) => s.add(pid)));
    return s;
  }, [teams]);

  const setLocalField = (setter, key, value) => {
    setter(value);
    persistLocal({ [key]: value });
  };

  const updateMatchesLocalOnly = (updater) => {
    setMatches((prev) => (typeof updater === "function" ? updater(prev) : updater));
  };

  const resetMatchState = (m) =>
    recomputeMatch({
      ...m,
      hands: [],
      forcedComplete: false,
      editingHandIdx: null,
      fastDraft: defaultFastDraft(),
      tableOrderPlayerIds: [],
      firstShufflerPlayerId: "",
    });

  const addPlayer = () => {
    const name = newPlayerName.trim();
    if (!name) return;
    const nextPlayers = [...players, { id: uid("p"), name }];
    setPlayers(nextPlayers);
    persistLocal({ players: nextPlayers });
    setNewPlayerName("");
    setTimeout(() => inputRef.current?.focus?.(), 0);
  };

  const removePlayer = (id) => {
    const nextPlayers = players.filter((p) => p.id !== id);
    setPlayers(nextPlayers);
    setTeams([]);
    setPairHistory([]);
    persistLocal({ players: nextPlayers, teams: [], pairHistory: [] });
  };

  const addTeam = () => {
    const nextTeams = [
      ...teams,
      { id: uid("t"), name: (newTeamName || "").trim() || `Team ${teams.length + 1}`, playerIds: [], locked: false },
    ];
    setTeams(nextTeams);
    persistLocal({ teams: nextTeams });
  };

  const removeTeam = (teamId) => {
    const nextTeams = teams.filter((t) => t.id !== teamId);
    setTeams(nextTeams);
    persistLocal({ teams: nextTeams });
  };

  const toggleTeamLock = (teamId, locked) => {
    const nextTeams = teams.map((t) => (t.id === teamId ? { ...t, locked: Boolean(locked) } : t));
    setTeams(nextTeams);
    persistLocal({ teams: nextTeams });
  };

  function setTeamPlayer(teamId, slotIdx, value) {
    const nextTeams = teams.map((t) => {
      if (t.id !== teamId) return t;
      const ids = [...(t.playerIds || [])];
      while (ids.length < 2) ids.push("");
      ids[slotIdx] = value;
      if (ids[0] && ids[0] === ids[1]) ids[slotIdx === 0 ? 1 : 0] = "";
      return { ...t, playerIds: ids.filter(Boolean) };
    });
    setTeams(nextTeams);
    persistLocal({ teams: nextTeams });
  }

  const renameTeam = (teamId, name) => {
    const nextTeams = teams.map((t) => (t.id === teamId ? { ...t, name } : t));
    setTeams(nextTeams);
    persistLocal({ teams: nextTeams });
  };

  function buildRandomTeams() {
    if (players.length < 2) return;
    const lockedPlayers = new Set(
      teams.flatMap((t) => (t.locked ? t.playerIds || [] : []))
    );
    const available = players.map((p) => p.id).filter((id) => !lockedPlayers.has(id));
    const historySet = new Set(pairHistory);
    let best = null;

    for (let k = 0; k < (avoidSameTeams ? 40 : 1); k++) {
      const shuffled = shuffleArray(available);
      const pairs = [];
      for (let i = 0; i < shuffled.length; i += 2) pairs.push([shuffled[i], shuffled[i + 1] || null]);
      const repeats = pairs.reduce((acc, [a, b]) => {
        if (!a || !b) return acc;
        return acc + (historySet.has([a, b].sort().join("|")) ? 1 : 0);
      }, 0);
      if (!best || repeats < best.repeats) best = { pairs, repeats };
      if (best?.repeats === 0) break;
    }

    let pairIdx = 0;
    const nextTeams = teams.map((t) =>
      t.locked ? t : { ...t, playerIds: (best?.pairs?.[pairIdx++] || []).filter(Boolean) }
    );

    const nextPairHistory = Array.from(
      new Set([
        ...pairHistory,
        ...nextTeams
          .filter((t) => (t.playerIds || []).length === 2)
          .map((t) => [...t.playerIds].sort().join("|")),
      ])
    );

    setTeams(nextTeams);
    setPairHistory(nextPairHistory);
    persistLocal({ teams: nextTeams, pairHistory: nextPairHistory });
  }

  const addMatch = async () => {
    if (!teams.length) return;
    const nextMatch = recomputeMatch(
      makeEmptyMatch({
        tableName: newTableName.trim() || `Table ${matches.length + 1}`,
        label: newMatchLabel.trim() || `Match ${matches.length + 1}`,
      })
    );
    await saveMatchToSupabase(nextMatch);
    await refreshFromSupabase();
  };

  const removeMatch = async (matchId) => {
    await deleteMatchFromSupabase(matchId);
    await refreshFromSupabase();
  };

  const setMatchTeam = async (matchId, side, value) => {
    const match = matches.find((m) => m.id === matchId);
    if (!match) return;
    const next = resetMatchState({ ...match, [side]: value || null });
    await saveMatchToSupabase(next);
    await clearHandsFromSupabase(matchId);
    await refreshFromSupabase();
  };

  const renameMatch = async (matchId, patch) => {
    const match = matches.find((m) => m.id === matchId);
    if (!match) return;
    const next = recomputeMatch({ ...match, ...patch, lastUpdatedAt: Date.now() });
    await saveMatchToSupabase(next);
    await refreshFromSupabase();
  };

  const updateTableSetup = async (matchId, patch) => {
    const match = matches.find((m) => m.id === matchId);
    if (!match) return;
    const next = recomputeMatch({ ...match, ...patch, lastUpdatedAt: Date.now() });
    await saveMatchToSupabase(next);
    await refreshFromSupabase();
  };

  const finishMatchNow = async (matchId) => {
    const match = matches.find((m) => m.id === matchId);
    if (!match) return;
    const a = Number(match.totalA) || 0;
    const b = Number(match.totalB) || 0;
    const next = {
      ...match,
      forcedComplete: true,
      completed: true,
      winnerId: a === b ? null : a > b ? match.teamAId : match.teamBId,
      lastUpdatedAt: Date.now(),
    };
    await saveMatchToSupabase(next);
    await refreshFromSupabase();
  };

  const updateDraft = (matchId, patch) =>
    updateMatchesLocalOnly((prev) =>
      prev.map((m) =>
        m.id === matchId ? { ...m, fastDraft: { ...(m.fastDraft || defaultFastDraft()), ...patch } } : m
      )
    );

  function startEditHand(matchId, handIdx) {
    updateMatchesLocalOnly((prev) =>
      prev.map((m) => {
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
            announceWinner: d.announceWinner ?? "NONE",
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
      })
    );
  }

  const cancelEditHand = (matchId) =>
    updateMatchesLocalOnly((prev) =>
      prev.map((m) =>
        m.id === matchId ? { ...m, editingHandIdx: null, fastDraft: defaultFastDraft() } : m
      )
    );

  async function addOrSaveHand(matchId) {
    const match = matches.find((m) => m.id === matchId);
    if (!match) return;

    const d = match.fastDraft || defaultFastDraft();
    const canPlay = !!match.teamAId && !!match.teamBId;
    const setupReady =
      canPlay &&
      Array.isArray(match.tableOrderPlayerIds) &&
      match.tableOrderPlayerIds.length === 4 &&
      !!match.firstShufflerPlayerId;

    if (!setupReady) return;

    const bidVal = parseBidValue(d.bid);
    const capotFlag = Boolean(d.capot) || String(d.bid || "").trim().toLowerCase() === "capot";

    let trickVal = null;
    const bidderTP = safeInt(d.bidderTrickPoints);
    const nonBidderTP = safeInt(d.nonBidderTrickPoints);

    if (d.trickSource === "BIDDER") {
      if (bidderTP === null) return;
      trickVal = bidderTP;
    } else if (d.trickSource === "NON") {
      if (nonBidderTP === null) return;
      trickVal = 162 - nonBidderTP;
    } else {
      trickVal = bidderTP !== null ? bidderTP : nonBidderTP !== null ? 162 - nonBidderTP : null;
    }

    if (bidVal === null || trickVal === null) return;
    trickVal = clamp(trickVal, 0, 162);

    const announceA = sumAnnounces(d, "A");
    const announceB = sumAnnounces(d, "B");
    const shuffler = getCurrentShufflerInfo(match, playerById);

    const res = computeFastCoincheScore({
      bidder: d.bidder,
      bid: bidVal,
      coincheLevel: d.coincheLevel || "NONE",
      capot: capotFlag,
      bidderTrickPoints: trickVal,
      announceA,
      announceB,
      announceWinner: d.announceWinner || "NONE",
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
      announceWinner: d.announceWinner || "NONE",
      announceA1: num(d.announceA1),
      announceA1PlayerId: d.announceA1PlayerId || "",
      announceA2: num(d.announceA2),
      announceA2PlayerId: d.announceA2PlayerId || "",
      announceB1: num(d.announceB1),
      announceB1PlayerId: d.announceB1PlayerId || "",
      announceB2: num(d.announceB2),
      announceB2PlayerId: d.announceB2PlayerId || "",
      announceA,
      announceB,
      beloteTeam: d.beloteTeam || "NONE",
      shufflerPlayerId: shuffler.playerId,
      shufflerName: shuffler.name,
    };

    if (match.editingHandIdx) {
      const existingHand = (match.hands || []).find((h) => h.idx === match.editingHandIdx);
      if (!existingHand) return;

      await saveHandToSupabase(match.id, {
        ...existingHand,
        idx: match.editingHandIdx,
        draftSnapshot: snap,
        scoreA: res.scoreA,
        scoreB: res.scoreB,
        bidderSucceeded: res.bidderSucceeded,
        editedAt: Date.now(),
      });
    } else {
      const nextHand = {
        idx: (match.hands?.length || 0) + 1,
        createdAt: Date.now(),
        draftSnapshot: snap,
        scoreA: res.scoreA,
        scoreB: res.scoreB,
        bidderSucceeded: res.bidderSucceeded,
      };
      await saveHandToSupabase(match.id, nextHand);
    }

    await refreshFromSupabase();

    const refreshed = await loadMatchesFromSupabase();
    const row = refreshed.find((r) => r.id === match.id);

    const updatedMatch = recomputeMatch(
      normalizeLoadedMatch({
        id: row?.id || match.id,
        code: row?.code || match.code,
        tableName: row?.table_name || match.tableName,
        label: row?.label || match.label,
        teamAId: row?.team_a_id || match.teamAId,
        teamBId: row?.team_b_id || match.teamBId,
        teamAName: row?.team_a_name || match.teamAName,
        teamBName: row?.team_b_name || match.teamBName,
        teamAPlayers: row?.team_a_players || match.teamAPlayers || [],
        teamBPlayers: row?.team_b_players || match.teamBPlayers || [],
        totalA: row?.total_a || 0,
        totalB: row?.total_b || 0,
        winnerId: row?.winner_id || null,
        completed: !!row?.completed,
        forcedComplete: !!row?.forced_complete,
        tableOrderPlayerIds: row?.table_order_player_ids || match.tableOrderPlayerIds || [],
        firstShufflerPlayerId: row?.first_shuffler_player_id || match.firstShufflerPlayerId || "",
        hands: [],
        fastDraft: defaultFastDraft(),
        editingHandIdx: null,
      })
    );

    await saveMatchToSupabase({
      ...updatedMatch,
      fastDraft: defaultFastDraft(),
      editingHandIdx: null,
    });
    await refreshFromSupabase();
  }

  const clearMatchHands = async (matchId) => {
    const match = matches.find((m) => m.id === matchId);
    if (!match) return;

    await clearHandsFromSupabase(matchId);

    const reset = recomputeMatch({
      ...match,
      hands: [],
      totalA: 0,
      totalB: 0,
      winnerId: null,
      completed: false,
      forcedComplete: false,
      editingHandIdx: null,
      fastDraft: defaultFastDraft(),
      lastUpdatedAt: Date.now(),
    });

    await saveMatchToSupabase(reset);
    await refreshFromSupabase();
  };

  const scoreboardRows = useMemo(() => {
    const byId = new Map();

    const touchTeam = (id, name) => {
      const key = id || name || uid("anonteam");
      if (!byId.has(key)) {
        byId.set(key, {
          teamId: key,
          name: name || "Team",
          matchesPlayed: 0,
          wins: 0,
          losses: 0,
          pointsFor: 0,
          pointsAgainst: 0,
        });
      }
      return byId.get(key);
    };

    for (const m of matches) {
      if (!m.teamAId || !m.teamBId) continue;
      const a = touchTeam(m.teamAId, getTeamNameForMatch(m, "A", teamById));
      const b = touchTeam(m.teamBId, getTeamNameForMatch(m, "B", teamById));

      a.pointsFor += Number(m.totalA) || 0;
      a.pointsAgainst += Number(m.totalB) || 0;
      b.pointsFor += Number(m.totalB) || 0;
      b.pointsAgainst += Number(m.totalA) || 0;

      if ((m.hands || []).length) {
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

    return [...byId.values()].sort((x, y) => {
      if (y.wins !== x.wins) return y.wins - x.wins;
      const dx = x.pointsFor - x.pointsAgainst;
      const dy = y.pointsFor - y.pointsAgainst;
      if (dy !== dx) return dy - dx;
      if (y.pointsFor !== x.pointsFor) return y.pointsFor - x.pointsFor;
      return x.name.localeCompare(y.name);
    });
  }, [matches, teamById]);

  const funStats = useMemo(() => {
    const completed = matches.filter((m) => m.completed && m.teamAId && m.teamBId);
    const labelFor = (m) =>
      `${getTeamNameForMatch(m, "A", teamById)} vs ${getTeamNameForMatch(m, "B", teamById)} (${m.label})`;

    let biggestBlowout = { diff: 0, label: "—" };
    let closest = { diff: Infinity, label: "—" };
    let bestComeback = { deficit: 0, label: "—" };
    let clutchFinish = { diff: Infinity, label: "—" };
    let momentumMonster = { swing: 0, label: "—" };

    for (const m of completed) {
      const diff = Math.abs((m.totalA || 0) - (m.totalB || 0));
      if (diff > biggestBlowout.diff) biggestBlowout = { diff, label: labelFor(m) };
      if (diff > 0 && diff < closest.diff) closest = { diff, label: labelFor(m) };

      const diffs = m.timelineDiffs || [];
      if (diffs.length) {
        const comebackSize = Math.abs(m.winnerId === m.teamAId ? Math.min(0, ...diffs) : Math.max(0, ...diffs));
        if (comebackSize > bestComeback.deficit) bestComeback = { deficit: comebackSize, label: labelFor(m) };

        for (let i = Math.max(0, diffs.length - 3); i < diffs.length; i++) {
          const absDiff = Math.abs(diffs[i]);
          if (absDiff < clutchFinish.diff) clutchFinish = { diff: absDiff, label: labelFor(m) };
        }
      }
    }

    for (const m of matches.filter((x) => x.teamAId && x.teamBId)) {
      const diffs = m.timelineDiffs || [];
      for (let i = 2; i < diffs.length; i++) {
        const swing = Math.abs(diffs[i] - diffs[i - 2]);
        if (swing > momentumMonster.swing) momentumMonster = { swing, label: labelFor(m) };
      }
    }

    if (!Number.isFinite(closest.diff)) closest = { diff: 0, label: "—" };
    if (!Number.isFinite(clutchFinish.diff)) clutchFinish = { diff: 0, label: "—" };

    const defenseCounts = new Map();
    for (const m of matches.filter((x) => x.teamAId && x.teamBId)) {
      for (const h of m.hands || []) {
        if ((Number(h.scoreA) || 0) > 0 && (Number(h.scoreB) || 0) === 0) defenseCounts.set(m.teamAId, (defenseCounts.get(m.teamAId) || 0) + 1);
        if ((Number(h.scoreB) || 0) > 0 && (Number(h.scoreA) || 0) === 0) defenseCounts.set(m.teamBId, (defenseCounts.get(m.teamBId) || 0) + 1);
      }
    }

    let perfectDefense = { name: "—", count: 0 };
    for (const [tid, count] of defenseCounts.entries()) {
      const refMatch = matches.find((m) => m.teamAId === tid || m.teamBId === tid);
      const name =
        refMatch?.teamAId === tid
          ? getTeamNameForMatch(refMatch, "A", teamById)
          : refMatch
          ? getTeamNameForMatch(refMatch, "B", teamById)
          : "—";
      if (count > perfectDefense.count) perfectDefense = { name, count };
    }

    const teamFun = new Map();
    const announceCountByPlayer = new Map();
    const announceTotalByPlayer = new Map();

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

        [
          [d.announceA1PlayerId, d.announceA1, d.announceA1PlayerName],
          [d.announceA2PlayerId, d.announceA2, d.announceA2PlayerName],
          [d.announceB1PlayerId, d.announceB1, d.announceB1PlayerName],
          [d.announceB2PlayerId, d.announceB2, d.announceB2PlayerName],
        ].forEach(([pid, val]) => {
          const pts = Number(val) || 0;
          if (!pid || pts <= 0) return;
          announceCountByPlayer.set(pid, (announceCountByPlayer.get(pid) || 0) + 1);
          announceTotalByPlayer.set(pid, (announceTotalByPlayer.get(pid) || 0) + pts);
        });
      }
    }

    const leader = (key) => {
      let best = null;
      for (const [tid, obj] of teamFun.entries()) {
        const v = obj[key] || 0;
        if (!best || v > best.v) best = { tid, v };
      }
      if (!best || best.v === 0) return { name: "—", v: 0 };
      const refMatch = matches.find((m) => m.teamAId === best.tid || m.teamBId === best.tid);
      const name =
        refMatch?.teamAId === best.tid
          ? getTeamNameForMatch(refMatch, "A", teamById)
          : refMatch
          ? getTeamNameForMatch(refMatch, "B", teamById)
          : "—";
      return { name, v: best.v };
    };

    let mostAnnounces = { name: "—", v: 0 };
    let highestAnnounces = { name: "—", v: 0 };

    for (const [pid, v] of announceCountByPlayer.entries()) {
      const snapName =
        matches
          .flatMap((m) => m.hands || [])
          .flatMap((h) => {
            const d = h.draftSnapshot || {};
            return [
              [d.announceA1PlayerId, d.announceA1PlayerName],
              [d.announceA2PlayerId, d.announceA2PlayerName],
              [d.announceB1PlayerId, d.announceB1PlayerName],
              [d.announceB2PlayerId, d.announceB2PlayerName],
            ];
          })
          .find(([id]) => id === pid)?.[1] || playerById.get(pid)?.name || "—";
      if (v > mostAnnounces.v) mostAnnounces = { name: snapName, v };
    }

    for (const [pid, v] of announceTotalByPlayer.entries()) {
      const snapName =
        matches
          .flatMap((m) => m.hands || [])
          .flatMap((h) => {
            const d = h.draftSnapshot || {};
            return [
              [d.announceA1PlayerId, d.announceA1PlayerName],
              [d.announceA2PlayerId, d.announceA2PlayerName],
              [d.announceB1PlayerId, d.announceB1PlayerName],
              [d.announceB2PlayerId, d.announceB2PlayerName],
            ];
          })
          .find(([id]) => id === pid)?.[1] || playerById.get(pid)?.name || "—";
      if (v > highestAnnounces.v) highestAnnounces = { name: snapName, v };
    }

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
      mostAnnounces,
      highestAnnounces,
    };
  }, [matches, teamById, playerById]);

  const publicLink = useMemo(() => `${window.location.origin}${window.location.pathname}#/public`, []);
  const tableLinks = useMemo(
    () =>
      matches.map((m) => ({
        label: `${m.tableName} • ${m.label}`,
        code: m.code,
        href: `${window.location.origin}${window.location.pathname}#/table?code=${m.code}`,
      })),
    [matches]
  );

  const { path, query } = route;
  const tableMatch = useMemo(() => {
    const code = (query.code || "").toUpperCase();
    if (!code) return null;
    return matches.find((m) => (m.code || "").toUpperCase() === code) || null;
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
      <span style={styles.tag}>Live: Supabase</span>
    </div>
  );

  /* =========================
     Public View
  ========================= */

  if (path === "/public") {
    const liveMatches = matches
      .filter((m) => m.teamAId && m.teamBId && !m.completed)
      .sort((a, b) => (b.lastUpdatedAt || 0) - (a.lastUpdatedAt || 0));

    return (
      <div style={styles.page}>
        <div style={styles.container}>
          <Header title={appName} subtitle={`Public scoreboard • Live updates • Tables: ${matches.length}`} right={<NavPills showAdmin />} />

          <div style={styles.grid2}>
            <Section title="Live Scoreboard">
              <ScoreboardTable rows={scoreboardRows} />
            </Section>

            <Section title="Fun Facts">
              <FunStatsGrid funStats={funStats} />
            </Section>
          </div>

          <Section title="Live Matches (Now Playing)">
            {!liveMatches.length ? (
              <div style={styles.small}>No matches currently in progress.</div>
            ) : (
              <div style={styles.grid3}>
                {liveMatches.map((m) => (
                  <LiveMatchCard key={m.id} match={m} teamById={teamById} onOpen={() => openTableRoute(m.code)} />
                ))}
              </div>
            )}
          </Section>

          <Section title="Table Entry Links">
            <div style={{ color: "#94a3b8", fontSize: 12, marginBottom: 10 }}>
              Each table uses their own link to enter hands and scores.
            </div>
            <div style={styles.grid3}>
              {tableLinks.map((t) => (
                <div key={t.code} style={styles.card}>
                  <div style={{ fontWeight: 900, marginBottom: 6 }}>{t.label}</div>
                  <div style={{ color: "#94a3b8", fontSize: 12, marginBottom: 10 }}>Code: {t.code}</div>
                  <button type="button" style={styles.btnSecondary} onClick={() => openTableRoute(t.code)}>
                    Open Table View
                  </button>
                </div>
              ))}
              {!tableLinks.length ? <div style={styles.small}>No matches yet. Add matches in Admin.</div> : null}
            </div>
          </Section>
        </div>
      </div>
    );
  }

  /* =========================
     Table View
  ========================= */

  if (path === "/table") {
    const hasRequestedCode = Boolean((query.code || "").trim());

    return (
      <div style={styles.page}>
        <div style={styles.container}>
          <Header title={appName} subtitle="Table View • Enter hands for your match only" right={<NavPills showAdmin />} />

          {!tableMatch ? (
            <Section title={hasRequestedCode && !tableMissingDelayDone ? "Loading match..." : "No match found"}>
              <div style={styles.small}>
                {hasRequestedCode && !tableMissingDelayDone
                  ? "Opening the table..."
                  : "This table link is missing or incorrect. Ask the organizer for the correct code."}
              </div>
              {(!hasRequestedCode || tableMissingDelayDone) && (
                <div style={{ marginTop: 10 }}>
                  <a href="#/public" style={{ ...styles.btnSecondary, textDecoration: "none" }}>
                    Go to Public View
                  </a>
                </div>
              )}
            </Section>
          ) : (
            <Section title={`Your Match • Code ${tableMatch.code}`}>
              <TableMatchPanel
                match={tableMatch}
                teamById={teamById}
                playerById={playerById}
                onTableSetupPatch={(patch) => updateTableSetup(tableMatch.id, patch)}
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

  /* =========================
     Admin View
  ========================= */

  return (
    <div style={styles.page}>
      <div style={styles.container}>
        <Header
          title={appName}
          subtitle="Admin • Setup players/teams • Create table matches • Share links • Live sync with Supabase"
          right={<NavPills showAdmin={false} />}
        />

        <Section
          title="Quick Links"
          collapsible
          defaultCollapsed
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
        </Section>

        <Section
          title="Settings"
          collapsible
          defaultCollapsed
          right={
            <div style={styles.row}>
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 900 }}>
                <input
                  type="checkbox"
                  checked={avoidSameTeams}
                  onChange={(e) => setLocalField(setAvoidSameTeams, "avoidSameTeams", e.target.checked)}
                />
                Avoid repeating pairs
              </label>

              <button
                style={styles.btnDanger}
                onClick={async () => {
                  if (!confirm("Full reset? This clears local players/teams and all live matches/hands.")) return;
                  setAppName("Coinche Scorekeeper");
                  setPlayers([]);
                  setTeams([]);
                  setPairHistory([]);
                  persistLocal({
                    appName: "Coinche Scorekeeper",
                    players: [],
                    teams: [],
                    pairHistory: [],
                  });

                  for (const m of matches) {
                    await deleteMatchFromSupabase(m.id);
                  }
                  await refreshFromSupabase();
                }}
              >
                Full Reset
              </button>
            </div>
          }
        >
          <div style={styles.grid3}>
            <InfoCard title="App name">
              <input
                style={styles.input("100%")}
                value={appName}
                onChange={(e) => setLocalField(setAppName, "appName", e.target.value)}
              />
            </InfoCard>
            <InfoCard title="Target score">
              <div style={{ fontWeight: 950, fontSize: 18 }}>{TARGET_SCORE}</div>
              <div style={styles.small}>Match ends immediately at {TARGET_SCORE}+.</div>
            </InfoCard>
            <InfoCard title="Live backend">
              <div style={{ fontWeight: 900, fontSize: 12, color: "#cbd5e1" }}>Supabase realtime</div>
            </InfoCard>
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
              onKeyDown={(e) => e.key === "Enter" && addPlayer()}
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
            {!players.length ? <div style={styles.small}>Add players to get started.</div> : null}
          </div>
        </Section>

        <Section
          title={`Teams (${teams.length})`}
          right={
            <div style={styles.row}>
              <input style={styles.input(220)} value={newTeamName} onChange={(e) => setNewTeamName(e.target.value)} placeholder="Optional team name" />
              <button
                style={styles.btnPrimary}
                onClick={() => {
                  addTeam();
                  setNewTeamName("");
                }}
              >
                Add Team
              </button>
              <button style={styles.btnSecondary} onClick={buildRandomTeams} disabled={players.length < 2 || teams.length < 1}>
                Randomize Teams (respects locks)
              </button>
            </div>
          }
        >
          {!teams.length ? (
            <div style={styles.small}>Add teams, then assign players.</div>
          ) : (
            <div style={styles.grid2}>
              {teams.map((t, idx) => (
                <TeamCard
                  key={t.id}
                  team={t}
                  idx={idx}
                  players={players}
                  usedPlayerIds={usedPlayerIds}
                  playerById={playerById}
                  onToggleLock={(locked) => toggleTeamLock(t.id, locked)}
                  onRemove={() => removeTeam(t.id)}
                  onRename={(name) => renameTeam(t.id, name)}
                  onSetPlayer={(slot, value) => setTeamPlayer(t.id, slot, value)}
                />
              ))}
            </div>
          )}
        </Section>

        <Section
          title={`Tables / Matches (${matches.length})`}
          right={
            <div style={styles.row}>
              <input style={styles.input(180)} value={newTableName} onChange={(e) => setNewTableName(e.target.value)} placeholder="Table name" />
              <input style={styles.input(180)} value={newMatchLabel} onChange={(e) => setNewMatchLabel(e.target.value)} placeholder="Match label" />
              <button style={styles.btnPrimary} onClick={addMatch} disabled={teams.length < 1}>
                Add Match
              </button>
            </div>
          }
        >
          {!matches.length ? (
            <div style={styles.small}>Add a match, then assign Team A / Team B.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {matches.map((m) => (
                <CollapsibleMatchCard
                  key={m.id}
                  match={m}
                  teamById={teamById}
                  playerById={playerById}
                  teams={teams}
                  onOpenTable={() => openTableRoute(m.code)}
                  onCopyLink={() => {
                    const href = `${window.location.origin}${window.location.pathname}#/table?code=${m.code}`;
                    navigator.clipboard?.writeText(href);
                    alert("Table link copied!");
                  }}
                  onRemove={() => removeMatch(m.id)}
                  onRenameMatch={(patch) => renameMatch(m.id, patch)}
                  onSetMatchTeam={(side, value) => setMatchTeam(m.id, side, value)}
                  onTableSetupPatch={(patch) => updateTableSetup(m.id, patch)}
                  onDraftPatch={(patch) => updateDraft(m.id, patch)}
                  onAddHand={() => addOrSaveHand(m.id)}
                  onClearHands={() => clearMatchHands(m.id)}
                  onStartEditHand={(handIdx) => startEditHand(m.id, handIdx)}
                  onCancelEdit={() => cancelEditHand(m.id)}
                  onFinishNow={() => finishMatchNow(m.id)}
                />
              ))}
            </div>
          )}
        </Section>

        <Section title="Scoreboard + Fun Facts (Live)" collapsible defaultCollapsed>
          <div style={styles.grid2}>
            <div style={styles.card}>
              <div style={{ fontWeight: 950, marginBottom: 8 }}>Live Scoreboard</div>
              <ScoreboardTable rows={scoreboardRows} />
            </div>
            <div style={styles.card}>
              <div style={{ fontWeight: 950, marginBottom: 8 }}>Fun Facts</div>
              <FunStatsGrid funStats={funStats} />
            </div>
          </div>
        </Section>

        <Section title="Table Links (share to each table)">
          <div style={styles.small}>
            Each match has a unique code and link. Teams should open their match link to enter hands.
          </div>
          <div style={{ marginTop: 10, ...styles.grid3 }}>
            {tableLinks.map((t) => (
              <div key={t.code} style={styles.card}>
                <div style={{ fontWeight: 950, marginBottom: 6 }}>{t.label}</div>
                <div style={styles.small}>Code: {t.code}</div>
                <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <button type="button" style={styles.btnSecondary} onClick={() => openTableRoute(t.code)}>
                    Open
                  </button>
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

/* =========================
   Shared UI
========================= */

function Header({ title, subtitle, right }) {
  return (
    <div style={styles.topbar}>
      <div>
        <h1 style={styles.title}>{title}</h1>
        <div style={styles.subtitle}>{subtitle}</div>
      </div>
      {right}
    </div>
  );
}

function Section({ title, right, children, collapsible = false, defaultCollapsed = false }) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  return (
    <div style={styles.section}>
      <div style={styles.sectionHeader}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h2 style={styles.h2}>{title}</h2>
          {collapsible && (
            <button
              type="button"
              onClick={() => setCollapsed((v) => !v)}
              style={{
                ...styles.btnGhost,
                padding: "6px 10px",
                border: "1px solid rgba(148,163,184,0.18)",
                borderRadius: 10,
                color: "#cbd5e1",
                background: "rgba(255,255,255,0.03)",
              }}
            >
              {collapsed ? "Expand" : "Collapse"}
            </button>
          )}
        </div>
        <div>{right}</div>
      </div>
      {!collapsed ? children : null}
    </div>
  );
}

function InfoCard({ title, children }) {
  return (
    <div style={styles.card}>
      <div style={styles.small}>{title}</div>
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

function FunStatsGrid({ funStats }) {
  const items = [
    ["Biggest Blowout", `${funStats.biggestBlowout.diff} pts`, funStats.biggestBlowout.label],
    ["Best Comeback", `${funStats.bestComeback.deficit} pts`, funStats.bestComeback.label],
    ["Closest Match", `${funStats.closest.diff} pts`, funStats.closest.label],
    ["Clutch Finish (last 3 hands)", `${funStats.clutchFinish.diff} pts`, funStats.clutchFinish.label],
    ["Momentum Monster", `${funStats.momentumMonster.swing} pts`, funStats.momentumMonster.label],
    ["Perfect Defense", funStats.perfectDefense.name, `${funStats.perfectDefense.count} shutout hands`],
    ["Coinche King", funStats.coincheKing.name, `${funStats.coincheKing.v} coinches`],
    ["Capot Hero", funStats.capotHero.name, `${funStats.capotHero.v} capots`],
    ["Belote Magnet", funStats.beloteMagnet.name, `${funStats.beloteMagnet.v} belotes`],
    ["Most Announces", funStats.mostAnnounces.name, `${funStats.mostAnnounces.v} announces`],
    ["Highest Announces", funStats.highestAnnounces.name, `${funStats.highestAnnounces.v} pts announced`],
  ];
  return (
    <div style={styles.grid3}>
      {items.map(([label, value, sub]) => (
        <StatCard key={label} label={label} value={value} sub={sub} />
      ))}
    </div>
  );
}

function ScoreboardTable({ rows }) {
  const headers = ["Rank", "Team", "MP", "W", "L", "PF", "PA", "+/-"];
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
        <thead>
          <tr>
            {headers.map((h) => (
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
          {!rows.length && (
            <tr>
              <td colSpan={8} style={{ padding: 12, color: "#94a3b8" }}>
                No data yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

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
  return <span style={{ display: "inline-block", transform: bump ? "scale(1.06)" : "scale(1)", transition: "transform 220ms ease" }}>{value}</span>;
}

function Fireworks({ seed = 0 }) {
  const bursts = [
    { x: 25 + (seed % 7) * 2, delay: 0 },
    { x: 50 + (seed % 5) * 2, delay: 140 },
    { x: 75 - (seed % 6) * 2, delay: 260 },
  ];
  const particlesPerBurst = 14;
  const radius = 46;

  return (
    <div style={styles.fireworksWrap}>
      {bursts.map((b, bi) => {
        const hueBase = (seed * 53 + bi * 70) % 360;
        return (
          <React.Fragment key={bi}>
            <span style={styles.fireworksGlow(b.x, b.delay)} />
            {Array.from({ length: particlesPerBurst }).map((_, pi) => {
              const ang = (Math.PI * 2 * pi) / particlesPerBurst;
              const dx = Math.cos(ang) * (radius + (pi % 3) * 10);
              const dy = Math.sin(ang) * (radius + (pi % 4) * 8);
              const hue = (hueBase + pi * 18) % 360;
              return <span key={`${bi}_${pi}`} style={styles.fireworkParticle(b.x, b.delay + (pi % 6) * 35, dx, dy, hue)} />;
            })}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function ScoreCard({ name, score, pct, winner, leader, variant = "A", bigTotals = false, celebrateOn = false, seed = 0 }) {
  const fill = variant === "A" ? styles.progressFillA : styles.progressFillB;
  return (
    <div style={{ ...styles.card, position: "relative", ...(leader ? styles.leaderGlow : {}), ...(winner ? styles.winnerGlow : {}) }}>
      {winner ? (
        <div style={styles.trophyBadge}>
          <span style={styles.trophyCircle}>🏆</span>
          <span>1</span>
        </div>
      ) : null}
      {winner && celebrateOn ? (
        <>
          <Fireworks seed={seed} />
          <div style={styles.confettiWrap}>
            {Array.from({ length: 30 }).map((_, i) => (
              <span key={i} style={styles.confettiPiece(i)} />
            ))}
          </div>
        </>
      ) : null}

      <div style={{ fontWeight: 900, marginBottom: 6 }}>{name}</div>
      {bigTotals ? (
        <div style={styles.bigTotal}>
          <AnimatedNumber value={score} />
        </div>
      ) : (
        <div style={styles.small}>
          Total: <b style={{ color: "#e5e7eb" }}>{score}</b> / {TARGET_SCORE}
        </div>
      )}

      <div style={{ marginTop: 8, ...styles.progressWrap }}>
        <div style={fill(pct)} />
      </div>
    </div>
  );
}

function LiveMatchCard({ match, teamById, onOpen }) {
  const ta = getTeamNameForMatch(match, "A", teamById);
  const tb = getTeamNameForMatch(match, "B", teamById);
  const pctA = Math.min(100, Math.round(((match.totalA || 0) / TARGET_SCORE) * 100));
  const pctB = Math.min(100, Math.round(((match.totalB || 0) / TARGET_SCORE) * 100));

  return (
    <div style={styles.card}>
      <div style={{ fontWeight: 950, marginBottom: 6 }}>{match.tableName} • {match.label}</div>

      <div style={{ marginTop: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontWeight: 900 }}>
          <span>{ta}</span>
          <span>{match.totalA}</span>
        </div>
        <div style={{ marginTop: 6, ...styles.progressWrap }}>
          <div style={styles.progressFillA(pctA)} />
        </div>
      </div>

      <div style={{ marginTop: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontWeight: 900 }}>
          <span>{tb}</span>
          <span>{match.totalB}</span>
        </div>
        <div style={{ marginTop: 6, ...styles.progressWrap }}>
          <div style={styles.progressFillB(pctB)} />
        </div>
      </div>

      <div style={{ marginTop: 10 }}>
        <button type="button" style={styles.btnSecondary} onClick={onOpen}>
          Open Table
        </button>
      </div>
    </div>
  );
}

function TeamCard({
  team,
  idx,
  players,
  usedPlayerIds,
  playerById,
  onToggleLock,
  onRemove,
  onRename,
  onSetPlayer,
}) {
  const selectOptions = () =>
    players.map((p) => {
      const taken = usedPlayerIds.has(p.id) && !(team.playerIds || []).includes(p.id);
      return (
        <option key={p.id} value={p.id} disabled={taken}>
          {p.name}
          {taken ? " (used)" : ""}
        </option>
      );
    });

  return (
    <div style={styles.card}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ fontWeight: 950 }}>Team #{idx + 1}</div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 900, color: team.locked ? "#34d399" : "#94a3b8" }}>
            <input type="checkbox" checked={!!team.locked} onChange={(e) => onToggleLock(e.target.checked)} />
            Lock
          </label>
          <button style={styles.btnGhost} onClick={onRemove}>
            Remove
          </button>
        </div>
      </div>

      <div style={{ marginTop: 10 }}>
        <div style={styles.small}>Team name</div>
        <input style={styles.input("100%")} value={team.name} onChange={(e) => onRename(e.target.value)} placeholder={`Team ${idx + 1}`} />
      </div>

      <div style={{ marginTop: 10, ...styles.grid2 }}>
        {[0, 1].map((slotIdx) => (
          <div key={slotIdx}>
            <div style={styles.small}>Player {slotIdx + 1}</div>
            <select style={styles.select("100%")} value={team.playerIds?.[slotIdx] || ""} onChange={(e) => onSetPlayer(slotIdx, e.target.value)}>
              <option value="">— Select —</option>
              {selectOptions()}
            </select>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 10, ...styles.small }}>
        Members: {(team.playerIds || []).map((pid) => playerById.get(pid)?.name).filter(Boolean).join(" / ") || "—"}
      </div>
    </div>
  );
}

/* =========================
   Scanner modal
========================= */

function ScanPointsModal({ open, onClose, trumpSuit, onApplyPoints }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);

  const [pileSide, setPileSide] = useState("BIDDER");
  const [lastTrick, setLastTrick] = useState(false);
  const [captured, setCaptured] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState(null);
  const [manualPoints, setManualPoints] = useState("");
  const [confidence, setConfidence] = useState(null);
  const [cardCount, setCardCount] = useState(0);

  useEffect(() => {
    if (!open) return;
    setErr("");
    setCaptured(null);
    setResult(null);
    setBusy(false);
    setManualPoints("");
    setConfidence(null);
    setCardCount(0);

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
      } catch {
        setErr("Camera permission denied or not available in this browser.");
      }
    })();

    return () => {
      try {
        streamRef.current?.getTracks().forEach((t) => t.stop());
      } catch {}
      streamRef.current = null;
    };
  }, [open]);

  function captureFrame() {
    setErr("");
    setResult(null);
    setManualPoints("");
    setConfidence(null);
    setCardCount(0);
    const v = videoRef.current;
    if (!v) return;
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth || 1280;
    canvas.height = v.videoHeight || 720;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    setCaptured(canvas.toDataURL("image/jpeg", 0.85));
  }

  async function submitToScan() {
    if (!captured) return setErr("Please capture a photo first.");
    setBusy(true);
    setErr("");
    setResult(null);
    setConfidence(null);
    setCardCount(0);

    try {
      const j = await postScanToApi({ imageDataUrl: captured, trumpSuit: trumpSuit || "S", pileSide, lastTrick });
      if (!j || j.ok === false) throw new Error(j?.error || "Scan error");
      setResult(j);
      setConfidence(typeof j.confidence === "number" ? j.confidence : null);
      setCardCount(normalizeScanCardCount(j.cardCount || j.cards?.length || 0));
      setManualPoints(typeof j.points === "number" && Number.isFinite(j.points) ? String(clamp(j.points, 0, 162)) : "");
    } catch (e) {
      setErr(e?.message || "Scan failed.");
    } finally {
      setBusy(false);
    }
  }

  function applyDetectedPoints() {
    const p = safeInt(manualPoints);
    if (p === null) return setErr("Enter valid points before applying.");
    onApplyPoints?.({ pileSide, points: clamp(p, 0, 162) });
    onClose?.();
  }

  if (!open) return null;

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 14 }}
      onClick={(e) => e.target === e.currentTarget && onClose?.()}
    >
      <div style={{ width: "min(980px, 96vw)", background: "rgba(2,6,23,0.95)", border: bd, borderRadius: 18, boxShadow: "0 18px 60px rgba(0,0,0,0.45)", overflow: "hidden" }}>
        <div style={{ padding: 12, display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", borderBottom: "1px solid rgba(148,163,184,0.18)" }}>
          <div style={{ fontWeight: 950 }}>
            Scan cards → compute trick points <span style={{ color: "#94a3b8", fontWeight: 800 }}>(Trump: <SuitIcon suit={trumpSuit || "S"} />)</span>
          </div>
          <button style={styles.btnSecondary} onClick={onClose}>Close</button>
        </div>

        <div style={{ padding: 12, display: "grid", gridTemplateColumns: "1fr 340px", gap: 12 }}>
          <div style={{ ...styles.card, borderRadius: 16 }}>
            {!captured ? (
              <>
                <div style={{ color: "#94a3b8", fontSize: 12, marginBottom: 8 }}>
                  Tip: lay cards flat, avoid glare, keep all cards visible. Supports scans from 4 to 32 cards.
                </div>
                <video
                  ref={videoRef}
                  playsInline
                  muted
                  style={{ width: "100%", borderRadius: 14, background: "rgba(0,0,0,0.35)", maxHeight: "62vh", objectFit: "cover" }}
                />
                <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <button style={styles.btnPrimary} onClick={captureFrame} disabled={!!err}>Capture Photo</button>
                  <button style={styles.btnSecondary} onClick={onClose}>Cancel</button>
                </div>
              </>
            ) : (
              <>
                <img src={captured} alt="Captured" style={{ width: "100%", borderRadius: 14, maxHeight: "62vh", objectFit: "contain", background: "rgba(0,0,0,0.25)" }} />
                <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <button style={styles.btnSecondary} onClick={() => setCaptured(null)} disabled={busy}>Retake</button>
                  <button style={styles.btnPrimary} onClick={submitToScan} disabled={busy}>{busy ? "Scanning…" : "Use Photo & Calculate"}</button>
                </div>
              </>
            )}
            {err ? <div style={{ marginTop: 10, color: "#fb7185", fontWeight: 900 }}>{err}</div> : null}
          </div>

          <div style={{ ...styles.card, borderRadius: 16 }}>
            <div style={{ fontWeight: 950, marginBottom: 10 }}>Scan options</div>

            <div style={{ marginBottom: 10 }}>
              <div style={styles.small}>Which pile is this photo?</div>
              <select style={styles.select("100%")} value={pileSide} onChange={(e) => setPileSide(e.target.value)} disabled={busy}>
                <option value="BIDDER">Bidder pile</option>
                <option value="NON">Non-bidder pile</option>
              </select>
            </div>

            <label style={{ display: "flex", gap: 10, alignItems: "center", fontWeight: 900 }}>
              <input type="checkbox" checked={lastTrick} onChange={(e) => setLastTrick(e.target.checked)} disabled={busy} />
              This pile includes last trick (+10)
            </label>

            <div style={{ marginTop: 12, borderTop: "1px solid rgba(148,163,184,0.18)", paddingTop: 12 }}>
              <div style={{ fontWeight: 950, marginBottom: 8 }}>Result</div>

              {!result ? (
                <div style={styles.small}>No scan result yet.</div>
              ) : (
                <>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <div style={{ fontSize: 20, fontWeight: 1000 }}>
                      Points: <span style={{ color: "#34d399" }}>{manualPoints || "—"}</span>
                    </div>
                    <span style={styles.tag}>{cardCount} cards</span>
                    {confidence !== null && <span style={styles.tag}>Confidence {Math.round(confidence * 100)}%</span>}
                  </div>

                  <div style={{ marginTop: 10 }}>
                    <div style={styles.small}>Adjust points before applying</div>
                    <input style={styles.input("100%")} value={manualPoints} onChange={(e) => setManualPoints(e.target.value)} inputMode="numeric" placeholder="0-162" />
                  </div>

                  {Array.isArray(result.warnings) && result.warnings.length ? (
                    <div style={{ marginTop: 8 }}>
                      {result.warnings.map((w, i) => (
                        <div key={i} style={{ color: "#fbbf24", fontWeight: 900, fontSize: 12 }}>⚠ {w}</div>
                      ))}
                    </div>
                  ) : null}

                  {Array.isArray(result.cards) && result.cards.length ? (
                    <div style={{ marginTop: 10, fontSize: 12, color: "#94a3b8" }}>
                      Detected cards ({result.cards.length}):{" "}
                      <span style={{ color: "#e5e7eb", fontWeight: 900 }}>
                        {result.cards.slice(0, 32).map((c) => c.displayCode || `${c.rank}${c.suit}`).join(" ")}
                      </span>
                    </div>
                  ) : null}

                  <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <button style={styles.btnPrimary} onClick={applyDetectedPoints}>Apply Points</button>
                  </div>
                </>
              )}
            </div>

            <div style={{ marginTop: 12, ...styles.small }}>
              Best results come from bright light, no glare, and all cards fully visible.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* =========================
   Match cards
========================= */

function CollapsibleMatchCard({
  match,
  teamById,
  playerById,
  teams,
  onOpenTable,
  onCopyLink,
  onRemove,
  onRenameMatch,
  onSetMatchTeam,
  onTableSetupPatch,
  onDraftPatch,
  onAddHand,
  onClearHands,
  onStartEditHand,
  onCancelEdit,
  onFinishNow,
}) {
  const [collapsed, setCollapsed] = useState(true);

  return (
    <div style={styles.card}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ fontWeight: 950 }}>
          {match.tableName} • {match.label} <span style={styles.small}>• Code {match.code}</span>
        </div>
        <div style={styles.row}>
          <button type="button" style={styles.btnSecondary} onClick={onOpenTable}>Open Table</button>
          <button type="button" style={styles.btnGhost} onClick={() => setCollapsed((v) => !v)}>{collapsed ? "Expand" : "Collapse"}</button>
        </div>
      </div>

      <div style={{ marginTop: 12, ...styles.grid2 }}>
        <InfoCard title="Table name">
          <input style={styles.input("100%")} value={match.tableName} onChange={(e) => onRenameMatch({ tableName: e.target.value })} />
        </InfoCard>
        <InfoCard title="Match label">
          <input style={styles.input("100%")} value={match.label} onChange={(e) => onRenameMatch({ label: e.target.value })} />
        </InfoCard>

        {["teamAId", "teamBId"].map((side, i) => (
          <div key={side}>
            <div style={styles.small}>Team {i === 0 ? "A" : "B"}</div>
            <select style={styles.select("100%")} value={match[side] || ""} onChange={(e) => onSetMatchTeam(side, e.target.value)}>
              <option value="">— Select —</option>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
        ))}
      </div>

      {!collapsed && (
        <>
          <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button style={styles.btnSecondary} onClick={onCopyLink}>Copy Link</button>
            <button style={styles.btnDanger} onClick={onRemove}>Remove</button>
          </div>

          <div style={{ marginTop: 10, ...styles.card }}>
            <div style={{ fontWeight: 950, color: match.completed ? "#34d399" : "#94a3b8" }}>
              {match.completed ? `Completed • Winner: ${match.winnerId === match.teamAId ? getTeamNameForMatch(match, "A", teamById) : getTeamNameForMatch(match, "B", teamById)}` : "In progress"}
            </div>
            <div style={styles.small}>Score: {match.totalA} – {match.totalB}</div>
          </div>

          <div style={{ marginTop: 12 }}>
            <TableMatchPanel
              match={match}
              teamById={teamById}
              playerById={playerById}
              onTableSetupPatch={onTableSetupPatch}
              onDraftPatch={onDraftPatch}
              onAddHand={onAddHand}
              onClearHands={onClearHands}
              onStartEditHand={onStartEditHand}
              onCancelEdit={onCancelEdit}
              onFinishNow={onFinishNow}
            />
          </div>
        </>
      )}
    </div>
  );
}

/* =========================
   Main match panel
========================= */

function TableMatchPanel({
  match,
  teamById,
  playerById,
  onTableSetupPatch,
  onDraftPatch,
  onAddHand,
  onClearHands,
  onStartEditHand,
  onCancelEdit,
  onFinishNow,
  bigTotals = false,
}) {
  const ta = getTeamNameForMatch(match, "A", teamById);
  const tb = getTeamNameForMatch(match, "B", teamById);
  const playersA = getMatchSidePlayers(match, "A", teamById, playerById);
  const playersB = getMatchSidePlayers(match, "B", teamById, playerById);
  const allTablePlayers = [...playersA, ...playersB];

  const pctA = Math.min(100, Math.round(((match.totalA || 0) / TARGET_SCORE) * 100));
  const pctB = Math.min(100, Math.round(((match.totalB || 0) / TARGET_SCORE) * 100));

  const d = match.fastDraft || defaultFastDraft();
  const canPlay = !!match.teamAId && !!match.teamBId;
  const setupReady = canPlay && Array.isArray(match.tableOrderPlayerIds) && match.tableOrderPlayerIds.length === 4 && !!match.firstShufflerPlayerId;
  const leader = match.totalA === match.totalB ? null : match.totalA > match.totalB ? "A" : "B";
  const winnerSide = !match.completed || !match.winnerId ? null : match.winnerId === match.teamAId ? "A" : match.winnerId === match.teamBId ? "B" : null;

  const [celebrateOn, setCelebrateOn] = useState(false);
  const prevWinnerRef = useRef(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [setupCollapsed, setSetupCollapsed] = useState(setupReady);
  const setupAutoCollapsedRef = useRef(false);

  useEffect(() => {
    setSetupCollapsed(setupReady);
    setupAutoCollapsedRef.current = Boolean(setupReady);
  }, [match.id]);

  useEffect(() => {
    if (setupReady && !setupAutoCollapsedRef.current) {
      setSetupCollapsed(true);
      setupAutoCollapsedRef.current = true;
    }
    if (!setupReady) {
      setSetupCollapsed(false);
      setupAutoCollapsedRef.current = false;
    }
  }, [setupReady]);

  useEffect(() => {
    const prev = prevWinnerRef.current;
    if (!prev && winnerSide) {
      setCelebrateOn(true);
      const t = setTimeout(() => setCelebrateOn(false), 6000);
      prevWinnerRef.current = winnerSide;
      return () => clearTimeout(t);
    }
    prevWinnerRef.current = winnerSide;
  }, [winnerSide]);

  const suitLabel =
    d.suit === "H" ? "Hearts" : d.suit === "D" ? "Diamonds" : d.suit === "C" ? "Clubs" : "Spades";
  const fieldLabelStyle = { fontSize: 18, color: "#cbd5e1", fontWeight: 950, marginBottom: 6 };
  const handInput = { ...styles.input("100%"), padding: "8px 10px" };
  const handSelect = { ...styles.select("100%"), padding: "8px 10px" };
  const currentShuffler = getCurrentShufflerInfo(match, playerById);
  const seatOrderNames = (match.tableOrderPlayerIds || [])
    .map((pid) => playerById.get(pid)?.name || [...playersA, ...playersB].find((p) => p.id === pid)?.name)
    .filter(Boolean);

  function setSeat(slotIdx, value) {
    const next = [...(match.tableOrderPlayerIds || [])];
    while (next.length < 4) next.push("");
    next[slotIdx] = value || "";
    const unique = [];
    for (const id of next.filter(Boolean)) if (!unique.includes(id)) unique.push(id);
    onTableSetupPatch({
      tableOrderPlayerIds: unique,
      firstShufflerPlayerId: unique.includes(match.firstShufflerPlayerId) ? match.firstShufflerPlayerId : "",
    });
  }

  function playerName(pid, fallback) {
    return playerById.get(pid)?.name || [...playersA, ...playersB].find((p) => p.id === pid)?.name || fallback;
  }

  function renderAnnounceBlock(side, label, teamPlayers) {
    const keys = {
      a1: `announce${side}1`,
      a2: `announce${side}2`,
      p1: `announce${side}1PlayerId`,
      p2: `announce${side}2PlayerId`,
    };

    return (
      <div style={styles.card}>
        <div style={{ fontWeight: 950, marginBottom: 10 }}>{label}</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {[
            [keys.a1, keys.p1, "Announce 1"],
            [keys.a2, keys.p2, "Announce 2"],
          ].map(([amountKey, playerKey, title]) => (
            <React.Fragment key={amountKey}>
              <div>
                <div style={styles.small}>{title}</div>
                <input style={handInput} value={d[amountKey]} onChange={(e) => onDraftPatch({ [amountKey]: e.target.value })} inputMode="numeric" disabled={!setupReady} />
              </div>
              <div>
                <div style={styles.small}>Player</div>
                <select style={handSelect} value={d[playerKey] || ""} onChange={(e) => onDraftPatch({ [playerKey]: e.target.value })} disabled={!setupReady}>
                  <option value="">— Select —</option>
                  {teamPlayers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            </React.Fragment>
          ))}
        </div>
        <div style={{ marginTop: 8, ...styles.small }}>
          Total announces: <span style={{ color: "#e5e7eb", fontWeight: 900 }}>{sumAnnounces(d, side)}</span>
        </div>
      </div>
    );
  }

  const announceWinnerLabel =
    d.announceWinner === "A" ? ta : d.announceWinner === "B" ? tb : "None / tie";

  return (
    <div style={{ ...styles.card, borderRadius: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ fontWeight: 950 }}>{match.tableName} • {match.label}</div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div style={{ color: match.completed ? "#34d399" : "#94a3b8", fontWeight: 950 }}>
            {match.completed ? `Winner: ${winnerSide === "A" ? ta : tb}` : "Live"}
          </div>

          {!match.completed && (
            <button
              style={{ ...styles.btnDanger, ...(setupReady ? {} : styles.disabled) }}
              onClick={() => {
                if (!setupReady) return;
                if (!confirm("Finish this game now? Winner will be the higher total score.")) return;
                onFinishNow?.();
              }}
              disabled={!setupReady}
            >
              Finish Game Now
            </button>
          )}
        </div>
      </div>

      <div style={{ marginTop: 14, borderTop: "1px solid rgba(148,163,184,0.18)", paddingTop: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
          <div style={{ fontWeight: 950 }}>Table Setup</div>
          {canPlay && <button type="button" style={styles.btnSecondary} onClick={() => setSetupCollapsed((v) => !v)}>{setupCollapsed ? "Expand Setup" : "Collapse Setup"}</button>}
        </div>

        {!canPlay ? (
          <div style={styles.small}>Select both teams first.</div>
        ) : setupCollapsed ? (
          <div style={styles.card}>
            <div style={{ ...styles.small, marginBottom: 6 }}>Table setup completed. Expand to edit if needed.</div>
            {seatOrderNames.length === 4 && <div style={{ fontWeight: 900 }}>Order: <span style={{ color: "#e5e7eb" }}>{seatOrderNames.join(" → ")}</span></div>}
            {match.firstShufflerPlayerId && (
              <div style={{ marginTop: 6, ...styles.small }}>
                First shuffler: <span style={{ color: "#e5e7eb", fontWeight: 900 }}>{playerName(match.firstShufflerPlayerId, "—")}</span>
              </div>
            )}
          </div>
        ) : (
          <>
            <div style={{ ...styles.small, marginBottom: 10 }}>Choose the 4 players in table order, then select who shuffles first.</div>

            <div style={styles.grid4}>
              {[0, 1, 2, 3].map((idx) => (
                <div key={idx}>
                  <div style={fieldLabelStyle}>Seat {idx + 1}</div>
                  <select style={handSelect} value={match.tableOrderPlayerIds?.[idx] || ""} onChange={(e) => setSeat(idx, e.target.value)} disabled={(match.hands || []).length > 0}>
                    <option value="">— Select —</option>
                    {allTablePlayers.map((p) => {
                      const taken = (match.tableOrderPlayerIds || []).includes(p.id) && (match.tableOrderPlayerIds || [])[idx] !== p.id;
                      return <option key={p.id} value={p.id} disabled={taken}>{p.name}</option>;
                    })}
                  </select>
                </div>
              ))}
            </div>

            <div style={{ marginTop: 10, maxWidth: 320 }}>
              <div style={fieldLabelStyle}>First player to shuffle</div>
              <select
                style={handSelect}
                value={match.firstShufflerPlayerId || ""}
                onChange={(e) => onTableSetupPatch({ firstShufflerPlayerId: e.target.value })}
                disabled={(match.hands || []).length > 0 || (match.tableOrderPlayerIds || []).length !== 4}
              >
                <option value="">— Select —</option>
                {(match.tableOrderPlayerIds || []).map((pid) => {
                  const name = playerName(pid, "");
                  return name ? <option key={pid} value={pid}>{name}</option> : null;
                })}
              </select>
            </div>

            {seatOrderNames.length === 4 && (
              <div style={{ marginTop: 10, ...styles.small }}>
                Order: <span style={{ color: "#e5e7eb" }}>{seatOrderNames.join(" → ")}</span>
              </div>
            )}
          </>
        )}
      </div>

      <div style={{ marginTop: 10, ...styles.grid2 }}>
        <ScoreCard name={ta} score={match.totalA} pct={pctA} leader={leader === "A"} winner={winnerSide === "A"} variant="A" bigTotals={bigTotals} celebrateOn={celebrateOn} seed={(match.id || "").length + (match.totalA || 0)} />
        <ScoreCard name={tb} score={match.totalB} pct={pctB} leader={leader === "B"} winner={winnerSide === "B"} variant="B" bigTotals={bigTotals} celebrateOn={celebrateOn} seed={(match.id || "").length + (match.totalB || 0) + 7} />
      </div>

      <div style={{ marginTop: 10, ...styles.small }}>
        End immediately at <b style={{ color: "#e5e7eb" }}>{TARGET_SCORE}</b>. Add hands until one team reaches 2000+.
      </div>

      <div style={{ marginTop: 14, borderTop: "1px solid rgba(148,163,184,0.18)", paddingTop: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
          <div style={{ fontWeight: 950 }}>Hand Tracker</div>
          <span style={styles.tag}>{match.editingHandIdx ? `Editing Hand ${match.editingHandIdx}` : "New Hand"}</span>
        </div>

        <div style={{ marginTop: 10, padding: 12, borderRadius: 16, background: "rgba(250,204,21,0.08)", border: "1px solid rgba(250,204,21,0.28)" }}>
          <div style={{ fontSize: 22, fontWeight: 950, lineHeight: 1.1, color: "#e5e7eb" }}>Shuffle Order</div>

          <div style={{ marginTop: 6, fontSize: 26, fontWeight: 950, lineHeight: 1.05, color: "#e5e7eb" }}>
            {seatOrderNames.length === 4 ? seatOrderNames.join(" → ") : "Set the 4-player order first"}
          </div>

          <div style={{ marginTop: 8, fontSize: 28, fontWeight: 1000, lineHeight: 1.05 }}>
            <span style={{ color: "#e5e7eb" }}>Now shuffling: </span>
            <span style={{ color: "#facc15", fontSize: 30 }}>
              {setupReady && currentShuffler.name ? currentShuffler.name : "Complete table setup before starting"}
            </span>
          </div>
        </div>

        <div style={styles.handRow1}>
          <Field label="Bidder" labelStyle={fieldLabelStyle}>
            <select style={handSelect} value={d.bidder} onChange={(e) => onDraftPatch({ bidder: e.target.value })} disabled={!setupReady}>
              <option value="A">{ta}</option>
              <option value="B">{tb}</option>
            </select>
          </Field>

          <Field label="Bid" labelStyle={fieldLabelStyle}>
            <input style={handInput} value={d.bid} onChange={(e) => onDraftPatch({ bid: e.target.value })} placeholder='80, 90, 110... or "capot"' disabled={!setupReady} />
          </Field>

          <Field label="Suit" labelStyle={fieldLabelStyle}>
            <select style={handSelect} value={d.suit || "S"} onChange={(e) => onDraftPatch({ suit: e.target.value })} disabled={!setupReady}>
              <option value="H">♥ Hearts</option>
              <option value="D">♦ Diamonds</option>
              <option value="C">♣ Clubs</option>
              <option value="S">♠ Spades</option>
            </select>
          </Field>

          <Field label="Coinche" labelStyle={fieldLabelStyle}>
            <select style={handSelect} value={d.coincheLevel} onChange={(e) => onDraftPatch({ coincheLevel: e.target.value })} disabled={!setupReady}>
              <option value="NONE">None</option>
              <option value="COINCHE">Coinche (x2)</option>
              <option value="SURCOINCHE">Surcoinche (x4)</option>
            </select>
          </Field>

          <Field label="Capot" labelStyle={fieldLabelStyle}>
            <select style={handSelect} value={d.capot ? "YES" : "NO"} onChange={(e) => onDraftPatch({ capot: e.target.value === "YES" })} disabled={!setupReady}>
              <option value="NO">No</option>
              <option value="YES">Yes</option>
            </select>
          </Field>
        </div>

        <div style={styles.handRow2}>
          {renderAnnounceBlock("A", ta, playersA)}
          {renderAnnounceBlock("B", tb, playersB)}
        </div>

        <div style={styles.handRow3}>
          <Field label="Announce winner" labelStyle={fieldLabelStyle}>
            <select
              style={handSelect}
              value={d.announceWinner}
              onChange={(e) => onDraftPatch({ announceWinner: e.target.value })}
              disabled={!setupReady}
            >
              <option value="NONE">None / tie</option>
              <option value="A">{ta}</option>
              <option value="B">{tb}</option>
            </select>
          </Field>

          <Field label="Belote" labelStyle={fieldLabelStyle}>
            <select style={handSelect} value={d.beloteTeam} onChange={(e) => onDraftPatch({ beloteTeam: e.target.value })} disabled={!setupReady}>
              <option value="NONE">None</option>
              <option value="A">{ta}</option>
              <option value="B">{tb}</option>
            </select>
          </Field>

          <Field label="Bidder trick points (0–162)" labelStyle={fieldLabelStyle}>
            <input
              style={handInput}
              value={d.bidderTrickPoints}
              onChange={(e) => {
                const raw = e.target.value;
                if (!raw.trim()) return onDraftPatch({ bidderTrickPoints: "", nonBidderTrickPoints: "", trickSource: "" });
                const n = safeInt(raw);
                if (n === null) return onDraftPatch({ bidderTrickPoints: raw, trickSource: "BIDDER" });
                const v = clamp(n, 0, 162);
                onDraftPatch({ bidderTrickPoints: String(v), nonBidderTrickPoints: String(162 - v), trickSource: "BIDDER" });
              }}
              placeholder="ex: 81"
              inputMode="numeric"
              disabled={!setupReady || d.trickSource === "NON"}
            />
          </Field>

          <Field label="Non-bidder trick points (0–162)" labelStyle={fieldLabelStyle}>
            <input
              style={handInput}
              value={d.nonBidderTrickPoints}
              onChange={(e) => {
                const raw = e.target.value;
                if (!raw.trim()) return onDraftPatch({ bidderTrickPoints: "", nonBidderTrickPoints: "", trickSource: "" });
                const n = safeInt(raw);
                if (n === null) return onDraftPatch({ nonBidderTrickPoints: raw, trickSource: "NON" });
                const v = clamp(n, 0, 162);
                onDraftPatch({ nonBidderTrickPoints: String(v), bidderTrickPoints: String(162 - v), trickSource: "NON" });
              }}
              placeholder="ex: 81"
              inputMode="numeric"
              disabled={!setupReady || d.trickSource === "BIDDER"}
            />
          </Field>
        </div>

        <div style={{ marginTop: 8, ...styles.small }}>
          Valid announce side for this hand: <span style={{ color: "#e5e7eb", fontWeight: 900 }}>{announceWinnerLabel}</span>
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12, alignItems: "center" }}>
          <button style={{ ...styles.btnPrimary, ...(setupReady ? {} : styles.disabled) }} onClick={onAddHand} disabled={!setupReady}>
            {match.editingHandIdx ? `Save Changes (Hand ${match.editingHandIdx})` : "Add Hand"}
          </button>

          {match.editingHandIdx && <button style={styles.btnSecondary} onClick={onCancelEdit}>Cancel Edit</button>}

          <button style={{ ...styles.btnSecondary, ...(setupReady ? {} : styles.disabled) }} onClick={() => setScanOpen(true)} disabled={!setupReady}>
            Calculate points with picture
          </button>

          <button style={styles.btnSecondary} onClick={onClearHands}>Clear Match Hands</button>

          <span style={{ ...styles.small, marginLeft: "auto" }}>
            Suit: <SuitIcon suit={d.suit || "S"} /> {suitLabel}
          </span>
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <div style={{ fontWeight: 950, marginBottom: 10 }}>Hands Played</div>
        {!(match.hands || []).length ? (
          <div style={styles.small}>No hands yet.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {(match.hands || []).map((h) => {
              const ds = h.draftSnapshot || {};
              const announceParts = [
                [ds.announceA1PlayerId, ds.announceA1, ta],
                [ds.announceA2PlayerId, ds.announceA2, ta],
                [ds.announceB1PlayerId, ds.announceB1, tb],
                [ds.announceB2PlayerId, ds.announceB2, tb],
              ]
                .filter(([, pts]) => (Number(pts) || 0) > 0)
                .map(([pid, pts, fallback]) => `${playerName(pid, fallback)}: ${pts}`);

              const announceWinnerText =
                ds.announceWinner === "A" ? ta : ds.announceWinner === "B" ? tb : "None / tie";

              return (
                <div key={h.idx} style={styles.handRow}>
                  <div style={{ minWidth: 260 }}>
                    <div style={{ fontWeight: 950 }}>Hand {h.idx}</div>
                    <div style={styles.small}>
                      Bid {ds.bid} <SuitIcon suit={ds.suit || "S"} /> • Bidder {ds.bidder === "A" ? ta : tb} • {ds.coincheLevel}
                      {ds.capot ? " • Capot" : ""} • Bidder tricks {ds.bidderTrickPoints} • Non-bidder tricks{" "}
                      {ds.nonBidderTrickPoints !== "" && ds.nonBidderTrickPoints !== undefined
                        ? ds.nonBidderTrickPoints
                        : clamp(162 - (Number(ds.bidderTrickPoints) || 0), 0, 162)}
                    </div>

                    <div style={{ marginTop: 6, ...styles.small }}>
                      Announces valid for: <span style={{ color: "#e5e7eb" }}>{announceWinnerText}</span>
                      {ds.beloteTeam && ds.beloteTeam !== "NONE" ? (
                        <>
                          {" "}• Belote: <span style={{ color: "#e5e7eb" }}>{ds.beloteTeam === "A" ? ta : tb}</span>
                        </>
                      ) : null}
                    </div>

                    {announceParts.length ? (
                      <div style={{ marginTop: 6, ...styles.small }}>
                        Announces entered: <span style={{ color: "#e5e7eb" }}>{announceParts.join(" • ")}</span>
                      </div>
                    ) : null}

                    {ds.shufflerName ? (
                      <div style={{ marginTop: 6, ...styles.small }}>
                        Shuffler: <span style={{ color: "#e5e7eb" }}>{ds.shufflerName}</span>
                      </div>
                    ) : null}
                  </div>

                  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={styles.tag}>+{h.scoreA} / +{h.scoreB}</span>
                    <button style={styles.btnSecondary} onClick={() => onStartEditHand(h.idx)}>Edit</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <ScanPointsModal
        open={scanOpen}
        onClose={() => setScanOpen(false)}
        trumpSuit={d.suit || "S"}
        onApplyPoints={({ pileSide, points }) => {
          const p = clamp(Number(points) || 0, 0, 162);
          onDraftPatch(
            pileSide === "BIDDER"
              ? { bidderTrickPoints: String(p), nonBidderTrickPoints: String(162 - p), trickSource: "BIDDER" }
              : { nonBidderTrickPoints: String(p), bidderTrickPoints: String(162 - p), trickSource: "NON" }
          );
        }}
      />
    </div>
  );
}

function Field({ label, labelStyle, children }) {
  return (
    <div>
      <div style={labelStyle}>{label}</div>
      {children}
    </div>
  );
}