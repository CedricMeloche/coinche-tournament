import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Coinche Tournament Manager (Vite single-file)
 * - 8 teams: Pools (A/B) RR + Bracket (QF/SF/Final + 3rd)
 * - Manual team builder + lock teams + randomize unlocked teams
 * - Public View (read-only) + Table View (table-specific entry)
 * - Live Scoreboard + Stats + Funny Stats
 * - Hand Tracker (Fast Mode) with suit dropdown + icons
 * - End immediately at 2000
 * - Export CSV (Excel-friendly)
 */

const LS_KEY = "coinche_tournament_vite_v3";
const TARGET_SCORE = 2000;
const GAME_MIN = 40;
const BREAK_MIN = 5;
const ROUND_MIN = GAME_MIN + BREAK_MIN;
const DEFAULT_START_TIME = "10:00";

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
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function pad2(n) {
  return String(n).padStart(2, "0");
}
function addMinutesToHHMM(hhmm, mins) {
  const [hh, mm] = hhmm.split(":").map((x) => Number(x) || 0);
  const base = hh * 60 + mm + mins;
  const h = Math.floor((base % (24 * 60) + 24 * 60) % (24 * 60) / 60);
  const m = ((base % 60) + 60) % 60;
  return `${pad2(h)}:${pad2(m)}`;
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

function buildPoolAssignment(teamIds) {
  // For exactly 8 teams: 4 and 4
  const shuffled = shuffleArray(teamIds);
  return { A: shuffled.slice(0, 4), B: shuffled.slice(4, 8) };
}

/** ===== Coinche scoring helpers (fast/hand mode) ===== */
function roundTrickPoints(x) {
  if (x == null) return 0;
  const n = Math.max(0, Math.min(162, Number(x) || 0));
  return Math.floor((n + 4) / 10) * 10;
}

function suitLabel(s) {
  if (s === "S") return "♠ Spades";
  if (s === "H") return "♥ Hearts";
  if (s === "D") return "♦ Diamonds";
  if (s === "C") return "♣ Clubs";
  return "—";
}

function suitSymbol(s) {
  if (s === "S") return "♠";
  if (s === "H") return "♥";
  if (s === "D") return "♦";
  if (s === "C") return "♣";
  return "•";
}

/**
 * computeFastCoincheHandScore:
 * Returns points for THIS HAND only (A,B) using simplified rules you were using previously.
 * Then we accumulate hands until someone reaches 2000.
 */
function computeFastCoincheHandScore({
  bidder, // "A"|"B"
  bid, // number
  suit, // "S"|"H"|"D"|"C"
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
    return { scoreA, scoreB, bidderSucceeded: true, suit };
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
    return { scoreA, scoreB, bidderSucceeded, suit };
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

  return { scoreA, scoreB, bidderSucceeded, suit };
}

/** ===== Styling helpers ===== */
const styles = {
  page: {
    minHeight: "100vh",
    background: "linear-gradient(180deg, #0b1220 0%, #0f172a 30%, #111827 100%)",
    padding: 18,
    color: "#e5e7eb",
    fontFamily:
      'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"',
  },
  shell: { maxWidth: 1200, margin: "0 auto" },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-end",
    gap: 12,
    marginBottom: 14,
    flexWrap: "wrap",
  },
  title: { margin: 0, fontSize: 28, letterSpacing: -0.5 },
  sub: { color: "#94a3b8", marginTop: 6, fontSize: 13 },
  nav: { display: "flex", gap: 10, flexWrap: "wrap" },
  card: {
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(148,163,184,0.18)",
    borderRadius: 18,
    padding: 16,
    marginBottom: 14,
    backdropFilter: "blur(10px)",
    boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
  },
  cardTitleRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: 12,
    marginBottom: 10,
    flexWrap: "wrap",
  },
  cardTitle: { fontSize: 18, margin: 0 },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 10px",
    borderRadius: 999,
    background: "rgba(255,255,255,0.08)",
    border: "1px solid rgba(148,163,184,0.18)",
    color: "#e5e7eb",
    fontWeight: 800,
    fontSize: 12,
  },
  btn: (kind, disabled) => {
    const base = {
      padding: "10px 12px",
      borderRadius: 14,
      border: "1px solid rgba(148,163,184,0.22)",
      cursor: disabled ? "not-allowed" : "pointer",
      fontWeight: 900,
      letterSpacing: 0.2,
      transition: "transform 0.05s ease",
      userSelect: "none",
    };
    if (disabled) return { ...base, background: "rgba(148,163,184,0.18)", color: "#94a3b8" };

    if (kind === "primary") return { ...base, background: "linear-gradient(135deg,#22c55e,#14b8a6)", color: "#04110a", border: "1px solid rgba(34,197,94,0.25)" };
    if (kind === "secondary") return { ...base, background: "rgba(255,255,255,0.06)", color: "#e5e7eb" };
    if (kind === "danger") return { ...base, background: "linear-gradient(135deg,#ef4444,#fb7185)", color: "#1f0a0a", border: "1px solid rgba(239,68,68,0.25)" };
    return { ...base, background: "rgba(255,255,255,0.06)", color: "#e5e7eb" };
  },
  input: (w = 240) => ({
    width: w,
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(148,163,184,0.22)",
    background: "rgba(2,6,23,0.35)",
    color: "#e5e7eb",
    outline: "none",
  }),
  select: (w = 180) => ({
    width: w,
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(148,163,184,0.22)",
    background: "rgba(2,6,23,0.35)",
    color: "#e5e7eb",
    outline: "none",
  }),
  hr: { border: 0, borderTop: "1px solid rgba(148,163,184,0.18)", margin: "12px 0" },
};

function Btn({ children, onClick, disabled, kind = "secondary", title }) {
  return (
    <button title={title} onClick={onClick} disabled={disabled} style={styles.btn(kind, disabled)} onMouseDown={(e) => !disabled && (e.currentTarget.style.transform = "scale(0.98)")} onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1)")}>
      {children}
    </button>
  );
}
function Input({ value, onChange, placeholder, width = 220, type = "text", disabled }) {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      style={{
        ...styles.input(width),
        opacity: disabled ? 0.6 : 1,
        cursor: disabled ? "not-allowed" : "text",
      }}
    />
  );
}
function Select({ value, onChange, options, width = 160, disabled }) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      style={{
        ...styles.select(width),
        opacity: disabled ? 0.6 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function ProgressBar({ label, value, max = TARGET_SCORE, accent = "rgba(34,197,94,0.9)" }) {
  const pct = clamp((Number(value) || 0) / max, 0, 1);
  return (
    <div style={{ width: "100%" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#cbd5e1", marginBottom: 6 }}>
        <div style={{ fontWeight: 900, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</div>
        <div style={{ fontWeight: 900 }}>{Number(value) || 0}/{max}</div>
      </div>
      <div style={{ height: 12, borderRadius: 999, background: "rgba(148,163,184,0.18)", overflow: "hidden", border: "1px solid rgba(148,163,184,0.18)" }}>
        <div style={{ height: "100%", width: `${pct * 100}%`, background: `linear-gradient(90deg, ${accent}, rgba(59,130,246,0.85))` }} />
      </div>
    </div>
  );
}

function hashRoute() {
  const h = window.location.hash || "#/";
  const [pathPart, queryPart] = h.slice(1).split("?");
  const path = pathPart || "/";
  const params = new URLSearchParams(queryPart || "");
  return { path, params };
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
/** ===== Simulation helpers (realistic tournament) ===== */
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function chance(p) {
  return Math.random() < p;
}
function clampNum(n, a, b) {
  return Math.max(a, Math.min(b, n));
}
function weightedPick(items) {
  // items: [{v, w}]
  const sum = items.reduce((s, x) => s + x.w, 0);
  let r = Math.random() * sum;
  for (const it of items) {
    r -= it.w;
    if (r <= 0) return it.v;
  }
  return items[items.length - 1].v;
}

// Make bids feel realistic (many 80/90/100/110, fewer 140/160)
function randomBid() {
  return weightedPick([
    { v: 80, w: 22 },
    { v: 90, w: 18 },
    { v: 100, w: 18 },
    { v: 110, w: 14 },
    { v: 120, w: 10 },
    { v: 130, w: 7 },
    { v: 140, w: 5 },
    { v: 150, w: 3 },
    { v: 160, w: 3 },
  ]);
}

function randomSuit() {
  return pick(["S", "H", "D", "C"]);
}

// Announces totals (non-belote) — modest most of the time
function randomAnnounceTotal() {
  if (chance(0.65)) return 0;
  if (chance(0.55)) return 20;
  if (chance(0.35)) return 50;
  if (chance(0.20)) return 70;
  return 100;
}

// Belote occurs sometimes
function randomBeloteTeam() {
  if (!chance(0.25)) return "NONE";
  return chance(0.5) ? "A" : "B";
}

// Coinche / surcoinche are rarer
function randomCoincheLevel() {
  if (!chance(0.14)) return "NONE";
  return chance(0.22) ? "SURCOINCHE" : "COINCHE";
}

// Capot very rare
function randomCapot() {
  return chance(0.02);
}

/**
 * Generates ONE hand input that tends to finish matches in ~12-20 hands.
 * It uses YOUR computeFastCoincheHandScore rules to decide success thresholds.
 */
function generateHandInputRealistic() {
  const bidder = chance(0.5) ? "A" : "B";
  const bid = randomBid();
  const suit = randomSuit();
  const coincheLevel = randomCoincheLevel();
  const capot = randomCapot();

  const beloteTeam = randomBeloteTeam();

  // Non-belote announces: both sides can have some
  const announceA = randomAnnounceTotal();
  const announceB = randomAnnounceTotal();

  // We want a healthy mix of made & failed contracts.
  // More fails at higher bids:
  const failProb = clampNum(0.18 + (bid - 80) * 0.004, 0.18, 0.50);
  const shouldFail = capot ? false : chance(failProb);

  // Compute "required" same way your engine does (so simulations match logic)
  const BIDDER_IS_A = bidder === "A";
  const bidderHasBelote =
    (BIDDER_IS_A && beloteTeam === "A") || (!BIDDER_IS_A && beloteTeam === "B");

  const baseMin = bidderHasBelote ? 71 : 81;
  const special80 = bid === 80 ? 81 : 0;

  const bidderAnn = BIDDER_IS_A ? (announceA || 0) : (announceB || 0);
  const announceHelp = bidderAnn + (bidderHasBelote ? 20 : 0);
  const required = Math.max(baseMin, special80, bid - announceHelp);

  // Pick raw trick points near success/fail threshold.
  // Keep within 0..162.
  let bidderTrickPoints;
  if (capot) {
    bidderTrickPoints = randInt(120, 162); // ignored by capot anyway
  } else if (!shouldFail) {
    // success: at least required, with some cushion
    bidderTrickPoints = clampNum(
      Math.round(required + randInt(0, 35)),
      0,
      162
    );
  } else {
    // fail: below required
    bidderTrickPoints = clampNum(
      Math.round(required - randInt(1, 25)),
      0,
      162
    );
  }

  return {
    bidder,
    bid,
    suit,
    coincheLevel,
    capot,
    bidderTrickPoints,
    announceA,
    announceB,
    beloteTeam,
  };
}

/**
 * Simulate a match with realistic hands until someone reaches TARGET_SCORE,
 * usually 12-20 hands (not guaranteed, but tuned).
 */
function simulateMatchHands({ maxHands = 30 } = {}) {
  const hands = [];
  let totalA = 0;
  let totalB = 0;

  for (let i = 0; i < maxHands; i++) {
    const h = generateHandInputRealistic();

    const res = computeFastCoincheHandScore({
      bidder: h.bidder,
      bid: h.bid,
      suit: h.suit,
      coincheLevel: h.coincheLevel,
      capot: h.capot,
      bidderTrickPoints: h.bidderTrickPoints,
      announceA: h.announceA,
      announceB: h.announceB,
      beloteTeam: h.beloteTeam,
    });

    totalA += res.scoreA;
    totalB += res.scoreB;

    hands.push({
      id: uid("h"),
      ts: Date.now() + i,
      bidder: h.bidder,
      bid: String(h.bid),
      suit: h.suit,
      coincheLevel: h.coincheLevel,
      capot: h.capot ? "YES" : "NO",
      bidderTrickPoints: String(h.bidderTrickPoints),
      announceA: String(h.announceA),
      announceB: String(h.announceB),
      beloteTeam: h.beloteTeam,
      notes: "",
      _scoreA: res.scoreA,
      _scoreB: res.scoreB,
      _bidderSucceeded: res.bidderSucceeded,
    });

    if (totalA >= TARGET_SCORE || totalB >= TARGET_SCORE) break;
  }

  return { hands, totalA, totalB, winnerSide: totalA >= TARGET_SCORE ? "A" : totalB >= TARGET_SCORE ? "B" : null };
}

/**
 * Build a full tournament state:
 * - 16 players
 * - 8 teams
 * - 2 pools + RR games
 * - simulate every pool match with realistic hands
 * - create bracket based on standings
 * - simulate bracket scores (manual totals) realistically
 */
function buildSimulatedTournamentState() {
  // players
  const players = Array.from({ length: 16 }).map((_, i) => ({
    id: uid("p"),
    name: `P${String(i + 1).padStart(2, "0")}`,
  }));

  // teams (pair sequentially)
  const teams = Array.from({ length: 8 }).map((_, i) => {
    const p1 = players[i * 2]?.id;
    const p2 = players[i * 2 + 1]?.id;
    return {
      id: uid("t"),
      name: `${players[i * 2].name} / ${players[i * 2 + 1].name}`,
      playerIds: [p1, p2],
      locked: true,
    };
  });

  // pools
  const teamIds = teams.map((t) => t.id);
  const poolMap = buildPoolAssignment(teamIds);

  // build RR games using your own scheduling function
  const games = [];
  const makePoolGames = (poolName, ids, tableOffset) => {
    const rounds = circleRoundRobin(ids);
    rounds.forEach((pairings, rIdx) => {
      pairings.forEach(([a, b], pIdx) => {
        const g = {
          id: uid(`g_${poolName}`),
          stage: "POOL",
          pool: poolName,
          round: rIdx + 1,
          table: tableOffset + (pIdx + 1),
          teamAId: a,
          teamBId: b,
          scoreA: "0",
          scoreB: "0",
          winnerId: null,
          matchPtsA: 0,
          matchPtsB: 0,
          matchEnded: false,
          hands: [],
          handDraft: null,
        };

        // simulate hands
        const sim = simulateMatchHands({ maxHands: 30 });
        g.hands = sim.hands;
        g.scoreA = String(sim.totalA);
        g.scoreB = String(sim.totalB);
        g.matchEnded = sim.winnerSide != null;

        // winner + match points
        const aScore = safeInt(g.scoreA);
        const bScore = safeInt(g.scoreB);
        if (aScore !== null && bScore !== null && aScore !== bScore) {
          g.winnerId = aScore > bScore ? g.teamAId : g.teamBId;
          const winnerScore = Math.max(aScore, bScore);
          const mp = computeMatchPoints(winnerScore, 2000, 2, 1);
          g.matchPtsA = g.winnerId === g.teamAId ? mp : 0;
          g.matchPtsB = g.winnerId === g.teamBId ? mp : 0;
        }

        games.push(g);
      });
    });
  };

  makePoolGames("A", poolMap.A, 0);
  makePoolGames("B", poolMap.B, 2);

  // helper for standings (pure, based on your rules)
  const teamById = new Map(teams.map((t) => [t.id, t]));
  function computePoolStandingsPure(poolName) {
    const ids = poolMap[poolName] || [];
    const rows = ids.map((id) => ({
      teamId: id,
      name: teamById.get(id)?.name ?? "—",
      matchPoints: 0,
      totalGamePoints: 0,
      gamesPlayed: 0,
      wins: 0,
      losses: 0,
    }));
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
          if (g.winnerId) {
            if (g.winnerId === g.teamAId) {
              a.wins += 1;
              b.losses += 1;
            } else {
              b.wins += 1;
              a.losses += 1;
            }
          }
        }

        a.matchPoints += g.matchPtsA ?? 0;
        b.matchPoints += g.matchPtsB ?? 0;
      });

    return sortStandings(rows);
  }

  const standingsA = computePoolStandingsPure("A");
  const standingsB = computePoolStandingsPure("B");

  // bracket from top4 each
  const aTop = standingsA.slice(0, 4).map((x) => x.teamId);
  const bTop = standingsB.slice(0, 4).map((x) => x.teamId);

  // Build bracket object same format as your UI uses
  const qf = [
    { label: "QF1", A: aTop[0], B: bTop[3], table: 1 },
    { label: "QF2", A: aTop[1], B: bTop[2], table: 2 },
    { label: "QF3", A: bTop[0], B: aTop[3], table: 3 },
    { label: "QF4", A: bTop[1], B: aTop[2], table: 4 },
  ];

  const sfIds = [uid("m_sf"), uid("m_sf")];
  const fId = uid("m_f");
  const thirdId = uid("m_3p");

  let bracket = [];

  qf.forEach((m, idx) => {
    const nextMatchId = idx < 2 ? sfIds[0] : sfIds[1];
    const nextSlot = idx % 2 === 0 ? "A" : "B";
    bracket.push({
      id: uid("m_qf"),
      label: m.label,
      round: "QF",
      idx,
      table: m.table,
      teamAId: m.A,
      teamBId: m.B,
      scoreA: "",
      scoreB: "",
      winnerId: null,
      nextMatchId,
      nextSlot,
    });
  });

  bracket.push({
    id: sfIds[0],
    label: "SF1",
    round: "SF",
    idx: 0,
    table: 1,
    teamAId: null,
    teamBId: null,
    scoreA: "",
    scoreB: "",
    winnerId: null,
    nextMatchId: fId,
    nextSlot: "A",
  });
  bracket.push({
    id: sfIds[1],
    label: "SF2",
    round: "SF",
    idx: 1,
    table: 2,
    teamAId: null,
    teamBId: null,
    scoreA: "",
    scoreB: "",
    winnerId: null,
    nextMatchId: fId,
    nextSlot: "B",
  });

  bracket.push({
    id: fId,
    label: "Final",
    round: "F",
    idx: 0,
    table: 1,
    teamAId: null,
    teamBId: null,
    scoreA: "",
    scoreB: "",
    winnerId: null,
    nextMatchId: null,
    nextSlot: null,
  });

  bracket.push({
    id: thirdId,
    label: "3rd Place",
    round: "3P",
    idx: 0,
    table: 2,
    teamAId: null,
    teamBId: null,
    scoreA: "",
    scoreB: "",
    winnerId: null,
    nextMatchId: null,
    nextSlot: null,
  });

  // Use your own propagation helpers to advance winners
  function scoreBracketMatch(m, aPoints, bPoints) {
    const a = String(aPoints);
    const b = String(bPoints);
    const winnerId = aPoints === bPoints ? null : aPoints > bPoints ? m.teamAId : m.teamBId;
    return { ...m, scoreA: a, scoreB: b, winnerId };
  }

  // simulate bracket scores realistically (single totals, not hands)
  function simulateBracketScoreLine() {
    // typical match ends around 2000–2600 winner, loser 1200–2200
    const winner = randInt(2000, 2650);
    const loser = randInt(1200, 2350);
    return winner === loser ? { w: winner + 10, l: loser } : { w: winner, l: loser };
  }

  // Play QFs
  bracket = bracket.map((m) => {
    if (m.round !== "QF") return m;
    const { w, l } = simulateBracketScoreLine();
    // randomize which side wins
    const aWins = chance(0.5);
    return scoreBracketMatch(m, aWins ? w : l, aWins ? l : w);
  });

  bracket = propagateBracketWinners(bracket);
  bracket = fillThirdPlace(bracket);

  // Play SFs (now teams should be filled)
  bracket = bracket.map((m) => {
    if (m.round !== "SF" || !m.teamAId || !m.teamBId) return m;
    const { w, l } = simulateBracketScoreLine();
    const aWins = chance(0.5);
    return scoreBracketMatch(m, aWins ? w : l, aWins ? l : w);
  });

  bracket = propagateBracketWinners(bracket);
  bracket = fillThirdPlace(bracket);

  // Final + 3rd
  bracket = bracket.map((m) => {
    if ((m.round !== "F" && m.round !== "3P") || !m.teamAId || !m.teamBId) return m;
    const { w, l } = simulateBracketScoreLine();
    const aWins = chance(0.5);
    return scoreBracketMatch(m, aWins ? w : l, aWins ? l : w);
  });

  bracket = propagateBracketWinners(bracket);
  bracket = fillThirdPlace(bracket);

  return { players, teams, poolMap, games, bracket };
}
export default function App() {
  const [loaded, setLoaded] = useState(false);
  const [testReport, setTestReport] = useState(null);

  const [tournamentName, setTournamentName] = useState("9th Annual Coinche Tournament");
  const [startTime, setStartTime] = useState(DEFAULT_START_TIME);

  // Timer (manual start/pause)
  const [timerRunning, setTimerRunning] = useState(false);
  const [timerStartMs, setTimerStartMs] = useState(null);
  const [timerPausedAccumMs, setTimerPausedAccumMs] = useState(0);
  const [tick, setTick] = useState(0);

  // Players
  const [players, setPlayers] = useState([]); // {id,name}
  const [newPlayerName, setNewPlayerName] = useState("");
  const inputRef = useRef(null);

  // Teams fixed at 8
  // {id,name,playerIds:[p1,p2], locked:boolean}
  const [teams, setTeams] = useState([]);

  // Tournament structure
  const [poolMap, setPoolMap] = useState({ A: [], B: [] });

  // games: pool matches only
  // {id, stage:"POOL", pool:"A"|"B", round, table, teamAId, teamBId, scoreA, scoreB, winnerId, matchPtsA, matchPtsB, matchEnded, hands:[...]}
  const [games, setGames] = useState([]);

  // bracket matches
  const [bracket, setBracket] = useState([]);

  // scoring settings
  const [winThreshold, setWinThreshold] = useState(2000);
  const [winHighPts, setWinHighPts] = useState(2);
  const [winLowPts, setWinLowPts] = useState(1);

  // routing
  const [route, setRoute] = useState(() => hashRoute());

  useEffect(() => {
    const onHash = () => setRoute(hashRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // load
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        setTournamentName(data.tournamentName ?? "9th Annual Coinche Tournament");
        setStartTime(data.startTime ?? DEFAULT_START_TIME);
        setPlayers(data.players ?? []);
        setTeams(data.teams ?? []);
        setPoolMap(data.poolMap ?? { A: [], B: [] });
        setGames(data.games ?? []);
        setBracket(data.bracket ?? []);
        setWinThreshold(data.winThreshold ?? 2000);
        setWinHighPts(data.winHighPts ?? 2);
        setWinLowPts(data.winLowPts ?? 1);

        setTimerRunning(Boolean(data.timerRunning ?? false));
        setTimerStartMs(data.timerStartMs ?? null);
        setTimerPausedAccumMs(data.timerPausedAccumMs ?? 0);
      }
    } catch {
      // ignore
    } finally {
      setLoaded(true);
    }
  }, []);

  // persist
  useEffect(() => {
    if (!loaded) return;
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        tournamentName,
        startTime,
        players,
        teams,
        poolMap,
        games,
        bracket,
        winThreshold,
        winHighPts,
        winLowPts,
        timerRunning,
        timerStartMs,
        timerPausedAccumMs,
      })
    );
  }, [
    loaded,
    tournamentName,
    startTime,
    players,
    teams,
    poolMap,
    games,
    bracket,
    winThreshold,
    winHighPts,
    winLowPts,
    timerRunning,
    timerStartMs,
    timerPausedAccumMs,
  ]);

  // timer tick
  useEffect(() => {
    if (!timerRunning) return;
    const id = setInterval(() => setTick((t) => t + 1), 500);
    return () => clearInterval(id);
  }, [timerRunning]);

  const playerById = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);
  const teamById = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams]);

  const exactly8TeamsReady = useMemo(() => {
    return teams.length === 8 && teams.every((t) => t.playerIds?.length === 2 && t.playerIds[0] && t.playerIds[1]);
  }, [teams]);

  /** ===== Tournament Schedule (times) ===== */
  const schedule = useMemo(() => {
    // For 8 teams:
    // Pools RR: 3 rounds (tables 1-4 each round)
    // Bracket: QF (4 matches), SF (2), Final+3rd (2)
    const items = [];
    let idx = 0;

    const add = (label) => {
      items.push({
        idx: idx++,
        time: addMinutesToHHMM(startTime, items.length * ROUND_MIN),
        label,
      });
    };

    add("Pool Round 1");
    add("Pool Round 2");
    add("Pool Round 3");
    add("Quarterfinals (QF)");
    add("Semifinals (SF)");
    add("Final + 3rd Place");

    return items;
  }, [startTime]);

  function timerElapsedMs() {
    if (!timerStartMs) return timerPausedAccumMs;
    if (!timerRunning) return timerPausedAccumMs;
    return timerPausedAccumMs + (Date.now() - timerStartMs);
  }

  const timerInfo = useMemo(() => {
    const elapsed = timerElapsedMs();
    const elapsedMin = Math.floor(elapsed / 60000);
    const currentBlock = Math.floor(elapsedMin / ROUND_MIN); // 0..5
    const withinBlockMin = elapsedMin % ROUND_MIN;

    const inBreak = withinBlockMin >= GAME_MIN;
    const remainingInGame = GAME_MIN - withinBlockMin;
    const remainingInBlock = ROUND_MIN - withinBlockMin;

    const current = schedule[currentBlock] ?? null;
    return {
      elapsedMin,
      currentBlock,
      withinBlockMin,
      currentLabel: current?.label ?? "—",
      currentTime: current?.time ?? "—",
      inBreak,
      remainingInGame: remainingInGame > 0 ? remainingInGame : 0,
      remainingInBlock: remainingInBlock > 0 ? remainingInBlock : 0,
      done: currentBlock >= schedule.length,
    };
  }, [tick, timerRunning, timerStartMs, timerPausedAccumMs, schedule]);

  function timerStart() {
    if (timerRunning) return;
    setTimerRunning(true);
    setTimerStartMs(Date.now());
  }
  function timerPause() {
    if (!timerRunning) return;
    const now = Date.now();
    setTimerRunning(false);
    setTimerPausedAccumMs((prev) => prev + (timerStartMs ? now - timerStartMs : 0));
    setTimerStartMs(null);
  }
  function timerReset() {
    setTimerRunning(false);
    setTimerStartMs(null);
    setTimerPausedAccumMs(0);
  }

  /** ===== Player ops ===== */
  function addPlayer() {
    const name = newPlayerName.trim();
    if (!name) return;
    setPlayers((prev) => [...prev, { id: uid("p"), name }]);
    setNewPlayerName("");
    setTimeout(() => inputRef.current?.focus?.(), 0);
  }
  function removePlayer(id) {
    setPlayers((prev) => prev.filter((p) => p.id !== id));
    // Also remove from teams selections
    setTeams((prev) =>
      prev.map((t) => ({
        ...t,
        playerIds: t.playerIds.map((pid) => (pid === id ? "" : pid)),
      }))
    );
  }

  /** ===== Team builder (8 slots) ===== */
  function ensure8TeamsSlots() {
    setTeams((prev) => {
      let out = [...prev];
      while (out.length < 8) {
        out.push({
          id: uid("t"),
          name: `Team ${out.length + 1}`,
          playerIds: ["", ""],
          locked: false,
        });
      }
      if (out.length > 8) out = out.slice(0, 8);
      // normalize fields
      out = out.map((t, idx) => ({
        id: t.id ?? uid("t"),
        name: t.name ?? `Team ${idx + 1}`,
        playerIds: Array.isArray(t.playerIds) ? [t.playerIds[0] || "", t.playerIds[1] || ""] : ["", ""],
        locked: Boolean(t.locked),
      }));
      return out;
    });
  }

  useEffect(() => {
    ensure8TeamsSlots();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setTeamName(teamId, name) {
    setTeams((prev) => prev.map((t) => (t.id === teamId ? { ...t, name } : t)));
  }
  function setTeamPlayer(teamId, slotIdx, playerId) {
    setTeams((prev) =>
      prev.map((t) => {
        if (t.id !== teamId) return t;
        const next = [...t.playerIds];
        next[slotIdx] = playerId;
        return { ...t, playerIds: next };
      })
    );
  }
  function toggleTeamLock(teamId, locked) {
    setTeams((prev) => prev.map((t) => (t.id === teamId ? { ...t, locked } : t)));
  }

  function randomizeTeamsUnlocked() {
    // Randomize players into unlocked team slots, leaving locked slots as-is
    const allPlayerIds = players.map((p) => p.id);
    if (allPlayerIds.length < 16) return;

    setTeams((prev) => {
      const lockedPlayers = new Set();
      prev.forEach((t) => {
        if (t.locked) {
          t.playerIds.forEach((pid) => pid && lockedPlayers.add(pid));
        }
      });

      const available = allPlayerIds.filter((id) => !lockedPlayers.has(id));
      const shuffled = shuffleArray(available);

      const nextTeams = prev.map((t) => {
        if (t.locked) return t;
        return { ...t, playerIds: ["", ""] };
      });

      let ptr = 0;
      for (const t of nextTeams) {
        if (t.locked) continue;
        t.playerIds = [shuffled[ptr] || "", shuffled[ptr + 1] || ""];
        ptr += 2;
      }

      // auto-name based on players if empty/default
      return nextTeams.map((t, idx) => {
        const p1 = playerById.get(t.playerIds[0])?.name;
        const p2 = playerById.get(t.playerIds[1])?.name;
        const defaultName = `Team ${idx + 1}`;
        const shouldAutoName = !t.name || t.name === defaultName || t.name.startsWith("Team ");
        return {
          ...t,
          name: shouldAutoName && p1 && p2 ? `${p1} / ${p2}` : (t.name || defaultName),
        };
      });
    });

    // Reset tournament structure because teams changed
    resetTournamentStructure();
  }

  function resetTournamentStructure() {
    setPoolMap({ A: [], B: [] });
    setGames([]);
    setBracket([]);
  }

  function fullReset() {
    setTournamentName("9th Annual Coinche Tournament");
    setStartTime(DEFAULT_START_TIME);
    setPlayers([]);
    setTeams([]);
    setPoolMap({ A: [], B: [] });
    setGames([]);
    setBracket([]);
    setWinThreshold(2000);
    setWinHighPts(2);
    setWinLowPts(1);
    setTimerRunning(false);
    setTimerStartMs(null);
    setTimerPausedAccumMs(0);
    setTimeout(() => ensure8TeamsSlots(), 0);
  }

  /** ===== Scheduling: pools RR ===== */
  function createPoolsRoundRobin() {
    if (!exactly8TeamsReady) return;
    const teamIds = teams.map((t) => t.id);
    const pools = buildPoolAssignment(teamIds);
    setPoolMap(pools);

    const built = [];

    const makePoolGames = (poolName, ids, tableOffset) => {
      const rounds = circleRoundRobin(ids); // for 4 teams = 3 rounds
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
            matchEnded: false,
            hands: [],
            handDraft: makeBlankHandDraft(),
          });
        });
      });
    };

    makePoolGames("A", pools.A, 0);
    makePoolGames("B", pools.B, 2);

    setGames(built);
    setBracket([]);
  }

  function makeBlankHandDraft() {
    return {
      bidder: "A",
      bid: "",
      suit: "S",
      coincheLevel: "NONE",
      capot: "NO",
      bidderTrickPoints: "",
      announceA: "",
      announceB: "",
      beloteTeam: "NONE",
      notes: "",
    };
  }

  /** ===== Hand Tracker: recompute totals per game ===== */
  function computeGameTotalsFromHands(hands) {
    let totalA = 0;
    let totalB = 0;
    let ended = false;
    let winnerSide = null;

    const handComputed = hands.map((h) => {
      const res = computeFastCoincheHandScore({
        bidder: h.bidder,
        bid: Number(h.bid) || 0,
        suit: h.suit,
        coincheLevel: h.coincheLevel,
        capot: h.capot === "YES",
        bidderTrickPoints: Number(h.bidderTrickPoints) || 0,
        announceA: Number(h.announceA) || 0,
        announceB: Number(h.announceB) || 0,
        beloteTeam: h.beloteTeam,
      });
      totalA += res.scoreA;
      totalB += res.scoreB;

      if (!ended && (totalA >= TARGET_SCORE || totalB >= TARGET_SCORE)) {
        ended = true;
        winnerSide = totalA >= TARGET_SCORE ? "A" : "B";
      }

      return { ...h, _scoreA: res.scoreA, _scoreB: res.scoreB, _bidderSucceeded: res.bidderSucceeded };
    });

    return { totalA, totalB, ended, winnerSide, handComputed };
  }

  function recomputeGameOutcome(g) {
    const a = safeInt(g.scoreA);
    const b = safeInt(g.scoreB);

    if (a === null || b === null) {
      return { ...g, winnerId: null, matchPtsA: 0, matchPtsB: 0 };
    }
    if (a === b) {
      return { ...g, winnerId: null, matchPtsA: 0, matchPtsB: 0 };
    }

    const winnerId = a > b ? g.teamAId : g.teamBId;
    const winnerScore = Math.max(a, b);
    const mp = computeMatchPoints(winnerScore, winThreshold, winHighPts, winLowPts);

    return {
      ...g,
      winnerId,
      matchPtsA: winnerId === g.teamAId ? mp : 0,
      matchPtsB: winnerId === g.teamBId ? mp : 0,
    };
  }

  function syncGameFromHands(gameId) {
    setGames((prev) =>
      prev.map((g) => {
        if (g.id !== gameId) return g;
        const { totalA, totalB, ended, winnerSide, handComputed } = computeGameTotalsFromHands(g.hands || []);
        const updated = {
          ...g,
          hands: handComputed.map((h) => {
            // keep any extra UI fields
            const { _scoreA, _scoreB, _bidderSucceeded, ...rest } = h;
            return { ...rest, _scoreA, _scoreB, _bidderSucceeded };
          }),
          scoreA: String(totalA),
          scoreB: String(totalB),
          matchEnded: ended,
        };
        const withOutcome = recomputeGameOutcome(updated);
        // If ended, lock winner based on totals (avoid tie corner)
        if (ended) {
          const winnerId = winnerSide === "A" ? g.teamAId : g.teamBId;
          return { ...withOutcome, winnerId };
        }
        return withOutcome;
      })
    );
  }

  function updateHandDraft(gameId, patch) {
    setGames((prev) =>
      prev.map((g) => (g.id === gameId ? { ...g, handDraft: { ...g.handDraft, ...patch } } : g))
    );
  }

  function addHand(gameId) {
    setGames((prev) =>
      prev.map((g) => {
        if (g.id !== gameId) return g;
        if (g.matchEnded) return g;

        const d = g.handDraft || makeBlankHandDraft();
        // minimal validation: bid & trick points required
        const bidNum = safeInt(d.bid);
        const tpNum = safeInt(d.bidderTrickPoints);
        if (bidNum === null || tpNum === null) return g;

        const newHand = {
          id: uid("h"),
          ts: Date.now(),
          bidder: d.bidder,
          bid: String(bidNum),
          suit: d.suit,
          coincheLevel: d.coincheLevel,
          capot: d.capot,
          bidderTrickPoints: String(clamp(tpNum, 0, 162)),
          announceA: String(safeInt(d.announceA) ?? 0),
          announceB: String(safeInt(d.announceB) ?? 0),
          beloteTeam: d.beloteTeam,
          notes: d.notes || "",
        };

        // reset draft blank after add (your request)
        return { ...g, hands: [...(g.hands || []), newHand], handDraft: makeBlankHandDraft() };
      })
    );
    // compute totals + end at 2000
    setTimeout(() => syncGameFromHands(gameId), 0);
  }

  function removeHand(gameId, handId) {
    setGames((prev) =>
      prev.map((g) => {
        if (g.id !== gameId) return g;
        const nextHands = (g.hands || []).filter((h) => h.id !== handId);
        return { ...g, hands: nextHands, matchEnded: false };
      })
    );
    setTimeout(() => syncGameFromHands(gameId), 0);
  }

  function clearGame(gameId) {
    setGames((prev) =>
      prev.map((g) =>
        g.id === gameId
          ? {
              ...g,
              scoreA: "0",
              scoreB: "0",
              winnerId: null,
              matchPtsA: 0,
              matchPtsB: 0,
              matchEnded: false,
              hands: [],
              handDraft: makeBlankHandDraft(),
            }
          : g
      )
    );
  }

  /** ===== Standings ===== */
  function poolStandings(poolName) {
    const ids = poolMap[poolName] || [];
    const rows = ids
      .map((id) => {
        const t = teamById.get(id);
        return t ? { teamId: t.id, name: t.name, matchPoints: 0, totalGamePoints: 0, gamesPlayed: 0, wins: 0, losses: 0 } : null;
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
          if (g.winnerId) {
            if (g.winnerId === g.teamAId) {
              a.wins += 1;
              b.losses += 1;
            } else {
              b.wins += 1;
              a.losses += 1;
            }
          }
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
    return ms.map((m) => (m.id === third.id ? { ...m, teamAId: loser1, teamBId: loser2, winnerId: null, scoreA: "", scoreB: "" } : m));
  }

  function buildBracketFromPools() {
    const a = standingsA.slice(0, 4).map((x) => x.teamId);
    const b = standingsB.slice(0, 4).map((x) => x.teamId);
    if (a.length < 4 || b.length < 4) return;

    const qf = [
      { label: "QF1", A: a[0], B: b[3], table: 1 },
      { label: "QF2", A: a[1], B: b[2], table: 2 },
      { label: "QF3", A: b[0], B: a[3], table: 3 },
      { label: "QF4", A: b[1], B: a[2], table: 4 },
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
        table: m.table,
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
      table: 1,
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
      table: 2,
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
      table: 1,
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
      table: 2,
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
      const updated = prev.map((m) => (m.id === matchId ? { ...m, [side === "A" ? "scoreA" : "scoreB"]: value } : m));
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
      const cleared = prev.map((m) => (m.id === matchId ? { ...m, scoreA: "", scoreB: "", winnerId: null } : m));
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

  /** ===== Live Scoreboard / Stats ===== */
  const allGamesCompleted = useMemo(() => games.length > 0 && games.every((g) => safeInt(g.scoreA) !== null && safeInt(g.scoreB) !== null && g.winnerId), [games]);

  const globalScoreboard = useMemo(() => {
    // Combine pool standings into one list
    const map = new Map();
    teams.forEach((t) => {
      map.set(t.id, {
        teamId: t.id,
        name: t.name,
        mp: 0,
        gp: 0,
        wins: 0,
        losses: 0,
        hands: 0,
        coinches: 0,
        surcoinches: 0,
        capots: 0,
        highestBid: 0,
      });
    });

    games.forEach((g) => {
      const rowA = map.get(g.teamAId);
      const rowB = map.get(g.teamBId);
      if (!rowA || !rowB) return;

      const sa = safeInt(g.scoreA);
      const sb = safeInt(g.scoreB);
      if (sa !== null && sb !== null) {
        rowA.gp += sa;
        rowB.gp += sb;
      }
      rowA.mp += g.matchPtsA ?? 0;
      rowB.mp += g.matchPtsB ?? 0;

      if (g.winnerId) {
        if (g.winnerId === g.teamAId) {
          rowA.wins += 1;
          rowB.losses += 1;
        } else {
          rowB.wins += 1;
          rowA.losses += 1;
        }
      }

      const hands = g.hands || [];
      rowA.hands += hands.length;
      rowB.hands += hands.length;

      hands.forEach((h) => {
        if (h.coincheLevel === "COINCHE") {
          rowA.coinches += 0; // count globally below via bidder side? keep simple overall counts
          rowB.coinches += 0;
        }
        const bid = Number(h.bid) || 0;
        rowA.highestBid = Math.max(rowA.highestBid, bid);
        rowB.highestBid = Math.max(rowB.highestBid, bid);
      });

      // count coinches more meaningfully: per team if they were bidder and coinche used
      hands.forEach((h) => {
        const bidderTeam = h.bidder === "A" ? g.teamAId : g.teamBId;
        const r = map.get(bidderTeam);
        if (!r) return;
        if (h.coincheLevel === "COINCHE") r.coinches += 1;
        if (h.coincheLevel === "SURCOINCHE") r.surcoinches += 1;
        if (h.capot === "YES") r.capots += 1;
        r.highestBid = Math.max(r.highestBid, Number(h.bid) || 0);
      });
    });

    const rows = Array.from(map.values());
    rows.sort((a, b) => {
      if (b.mp !== a.mp) return b.mp - a.mp;
      if (b.gp !== a.gp) return b.gp - a.gp;
      return a.name.localeCompare(b.name);
    });
    return rows;
  }, [teams, games]);

  const funnyStats = useMemo(() => {
    // Biggest blowout (largest point diff in a match)
    let biggest = null;
    let fastest = null;
    let mostCoinches = null;
    let highestBid = { bid: 0, teamName: null };
    let mostHands = null;

    games.forEach((g) => {
      const sa = safeInt(g.scoreA) ?? 0;
      const sb = safeInt(g.scoreB) ?? 0;
      const diff = Math.abs(sa - sb);
      if (!biggest || diff > biggest.diff) {
        biggest = {
          diff,
          label: `${teamById.get(g.teamAId)?.name ?? "Team A"} vs ${teamById.get(g.teamBId)?.name ?? "Team B"} (Table ${g.table})`,
          score: `${sa}-${sb}`,
        };
      }

      const handsCount = (g.hands || []).length;
      if (g.matchEnded) {
        if (!fastest || handsCount < fastest.hands) {
          fastest = {
            hands: handsCount,
            label: `${teamById.get(g.winnerId)?.name ?? "Winner"} won on Table ${g.table}`,
          };
        }
      }
      if (!mostHands || handsCount > mostHands.hands) {
        mostHands = {
          hands: handsCount,
          label: `Table ${g.table}: ${teamById.get(g.teamAId)?.name ?? ""} vs ${teamById.get(g.teamBId)?.name ?? ""}`,
        };
      }

      (g.hands || []).forEach((h) => {
        const bidderTeamId = h.bidder === "A" ? g.teamAId : g.teamBId;
        const bidderName = teamById.get(bidderTeamId)?.name ?? "—";
        const bid = Number(h.bid) || 0;
        if (bid > highestBid.bid) highestBid = { bid, teamName: bidderName, suit: h.suit, coinche: h.coincheLevel };
      });
    });

    globalScoreboard.forEach((r) => {
      if (!mostCoinches || (r.coinches + r.surcoinches) > (mostCoinches.coinches + mostCoinches.surcoinches)) {
        mostCoinches = r;
      }
    });

    return {
      biggest,
      fastest,
      mostCoinches,
      highestBid,
      mostHands,
    };
  }, [games, teamById, globalScoreboard]);

  /** ===== Export CSV (Excel-friendly) ===== */
  function exportCSV() {
    const lines = [];
    lines.push(["Tournament", tournamentName].join(","));
    lines.push(["StartTime", startTime].join(","));
    lines.push("");

    lines.push("TEAMS");
    lines.push("Team,Player1,Player2,Locked");
    teams.forEach((t) => {
      const p1 = playerById.get(t.playerIds[0])?.name ?? "";
      const p2 = playerById.get(t.playerIds[1])?.name ?? "";
      lines.push([csv(t.name), csv(p1), csv(p2), t.locked ? "YES" : "NO"].join(","));
    });
    lines.push("");

    lines.push("POOL GAMES");
    lines.push("Pool,Round,Table,TeamA,TeamB,ScoreA,ScoreB,Winner");
    games.forEach((g) => {
      lines.push([
        g.pool,
        g.round,
        g.table,
        csv(teamById.get(g.teamAId)?.name ?? ""),
        csv(teamById.get(g.teamBId)?.name ?? ""),
        safeInt(g.scoreA) ?? "",
        safeInt(g.scoreB) ?? "",
        csv(teamById.get(g.winnerId)?.name ?? ""),
      ].join(","));
    });
    lines.push("");

    lines.push("HANDS");
    lines.push("Pool,Round,Table,TeamA,TeamB,Hand#,Bidder,Bid,Suit,Coinche,Capot,BidderTricks,AnnA,AnnB,Belote,HandScoreA,HandScoreB,Notes");
    games.forEach((g) => {
      (g.hands || []).forEach((h, idx) => {
        lines.push([
          g.pool,
          g.round,
          g.table,
          csv(teamById.get(g.teamAId)?.name ?? ""),
          csv(teamById.get(g.teamBId)?.name ?? ""),
          idx + 1,
          h.bidder,
          h.bid,
          suitLabel(h.suit),
          h.coincheLevel,
          h.capot,
          h.bidderTrickPoints,
          h.announceA,
          h.announceB,
          h.beloteTeam,
          h._scoreA ?? "",
          h._scoreB ?? "",
          csv(h.notes || ""),
        ].join(","));
      });
    });
    lines.push("");

    lines.push("SCOREBOARD");
    lines.push("Rank,Team,MatchPts,GamePts,Wins,Losses,Hands,Coinches,Surcoinches,Capots,HighestBid");
    globalScoreboard.forEach((r, i) => {
      lines.push([i + 1, csv(r.name), r.mp, r.gp, r.wins, r.losses, r.hands, r.coinches, r.surcoinches, r.capots, r.highestBid].join(","));
    });

    downloadTextFile("coinche_tournament_export.csv", lines.join("\n"));
  }

  function csv(s) {
    const str = String(s ?? "");
    if (str.includes(",") || str.includes('"') || str.includes("\n")) return `"${str.replace(/"/g, '""')}"`;
    return str;
  }

  /** ===== Views ===== */
  const view = route.path; // "/", "/public", "/table"
  const tableParam = route.params.get("n");
  const tableNumber = tableParam ? Number(tableParam) : null;

  // table view: find relevant match (pool first, else bracket match)
  const tablePoolMatch = useMemo(() => {
    if (!tableNumber) return null;
    return games.find((g) => g.table === tableNumber) ?? null;
  }, [tableNumber, games]);

  const tableBracketMatch = useMemo(() => {
    if (!tableNumber) return null;
    return bracket.find((m) => m.table === tableNumber) ?? null;
  }, [tableNumber, bracket]);

  /** ===== Visual Bracket Layout ===== */
  const bracketByRound = useMemo(() => {
    const order = { QF: 1, SF: 2, F: 3, "3P": 4 };
    return [...bracket].sort((a, b) => (order[a.round] ?? 99) - (order[b.round] ?? 99) || (a.idx ?? 0) - (b.idx ?? 0));
  }, [bracket]);

  /** ===== Public View (read-only) ===== */
  if (view === "/public") {
    return (
      <div style={styles.page}>
        <div style={styles.shell}>
          <div style={styles.header}>
            <div>
              <h1 style={styles.title}>{tournamentName} — Public View</h1>
              <div style={styles.sub}>Live scoreboard + pools + bracket (read-only). Refresh not needed (updates instantly on this device).</div>
            </div>
            <div style={styles.nav}>
              <a href="#/" style={{ ...styles.chip, textDecoration: "none" }}>← Admin View</a>
            </div>
          </div>

          <ScoreboardCard globalScoreboard={globalScoreboard} winnerBoard={winnerBoard} />
          <StatsCard funnyStats={funnyStats} />

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <PoolCard title="Pool A" poolMap={poolMap.A} games={games} pool="A" teamById={teamById} readOnly />
            <PoolCard title="Pool B" poolMap={poolMap.B} games={games} pool="B" teamById={teamById} readOnly />
          </div>

          <BracketVisual bracket={bracketByRound} teamById={teamById} onScore={null} onClear={null} readOnly />

          <div style={{ marginTop: 12, color: "#94a3b8", fontSize: 12 }}>
            Tip: For a table-specific entry screen, use <b>Table View</b> on another device (later, when you add Supabase, it’ll sync live across devices).
          </div>
        </div>
      </div>
    );
  }

  /** ===== Table View ===== */
  if (view === "/table") {
    return (
      <div style={styles.page}>
        <div style={styles.shell}>
          <div style={styles.header}>
            <div>
              <h1 style={styles.title}>{tournamentName} — Table View</h1>
              <div style={styles.sub}>
                Enter <b>?n=1..4</b> in the URL hash, example: <span style={styles.chip}>#/table?n=2</span>
              </div>
            </div>
            <div style={styles.nav}>
              <a href="#/public" style={{ ...styles.chip, textDecoration: "none" }}>Public View</a>
              <a href="#/" style={{ ...styles.chip, textDecoration: "none" }}>Admin View</a>
            </div>
          </div>

          <div style={styles.card}>
            <div style={styles.cardTitleRow}>
              <h2 style={styles.cardTitle}>Choose table</h2>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <Select
                  value={tableNumber ? String(tableNumber) : ""}
                  onChange={(v) => (window.location.hash = `#/table?n=${v}`)}
                  options={[
                    { value: "", label: "Select a table…" },
                    { value: "1", label: "Table 1" },
                    { value: "2", label: "Table 2" },
                    { value: "3", label: "Table 3" },
                    { value: "4", label: "Table 4" },
                  ]}
                  width={180}
                />
              </div>
            </div>

            {(!tableNumber || (!tablePoolMatch && !tableBracketMatch)) ? (
              <div style={{ color: "#94a3b8" }}>
                If you don’t see a match, it means the schedule hasn’t been created yet (Admin View → “Create pools + round robin”).
              </div>
            ) : (
              <>
                {tablePoolMatch ? (
                  <TableMatchEntry
                    kind="POOL"
                    match={tablePoolMatch}
                    teamById={teamById}
                    onDraftPatch={(patch) => updateHandDraft(tablePoolMatch.id, patch)}
                    onAddHand={() => addHand(tablePoolMatch.id)}
                    onRemoveHand={(handId) => removeHand(tablePoolMatch.id, handId)}
                    onClear={() => clearGame(tablePoolMatch.id)}
                  />
                ) : null}

                {tableBracketMatch ? (
                  <BracketMatchEntry
                    match={tableBracketMatch}
                    teamById={teamById}
                    onScore={(side, v) => setBracketScore(tableBracketMatch.id, side, v)}
                    onClear={() => clearBracketMatch(tableBracketMatch.id)}
                  />
                ) : null}
              </>
            )}
          </div>

          <ScoreboardCard globalScoreboard={globalScoreboard} winnerBoard={winnerBoard} compact />
        </div>
      </div>
    );
  }

  /** ===== Admin View ===== */
  return (
    <div style={styles.page}>
      <div style={styles.shell}>
        <div style={styles.header}>
          <div>
            <h1 style={styles.title}>{tournamentName}</h1>
            <div style={styles.sub}>
              Admin view • Exactly 8 teams • Pools + bracket • Hand tracking to {TARGET_SCORE}
            </div>
          </div>
          <div style={styles.nav}>
            <a href="#/public" style={{ ...styles.chip, textDecoration: "none" }}>Public View</a>
            <a href="#/table" style={{ ...styles.chip, textDecoration: "none" }}>Table View</a>
            <Btn kind="secondary" onClick={exportCSV}>Export CSV (Excel)</Btn>
            <Btn kind="secondary" onClick={resetTournamentStructure} disabled={games.length === 0 && bracket.length === 0}>
              Reset tournament
            </Btn>
            <Btn kind="danger" onClick={fullReset}>
              Full reset
            </Btn>
          </div>
        </div>

        {/* Timer / Schedule */}
        <div style={styles.card}>
          <div style={styles.cardTitleRow}>
            <h2 style={styles.cardTitle}>Schedule + Timer</h2>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <Btn kind="primary" onClick={timerStart} disabled={timerRunning}>Start</Btn>
              <Btn kind="secondary" onClick={timerPause} disabled={!timerRunning}>Pause</Btn>
              <Btn kind="secondary" onClick={timerReset}>Reset</Btn>
            </div>
          </div>

          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 12, color: "#94a3b8" }}>Start time</div>
              <Input value={startTime} onChange={setStartTime} width={120} placeholder="10:00" />
            </div>

            <div style={styles.chip}>
              <span style={{ opacity: 0.85 }}>Now:</span>
              <b>{timerInfo.currentLabel}</b>
              <span style={{ opacity: 0.85 }}>({timerInfo.currentTime})</span>
              <span style={{ opacity: 0.85 }}>•</span>
              {timerInfo.inBreak ? (
                <span><b>Break</b> — {timerInfo.remainingInBlock} min left</span>
              ) : (
                <span><b>Game</b> — {timerInfo.remainingInGame} min left</span>
              )}
            </div>
          </div>

          <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
            {schedule.map((s, i) => (
              <div key={s.idx} style={{ padding: 12, borderRadius: 16, border: "1px solid rgba(148,163,184,0.18)", background: i === timerInfo.currentBlock ? "rgba(34,197,94,0.12)" : "rgba(255,255,255,0.04)" }}>
                <div style={{ fontWeight: 900 }}>{s.time}</div>
                <div style={{ color: "#cbd5e1", marginTop: 4 }}>{s.label}</div>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 10, color: "#94a3b8", fontSize: 12 }}>
            Each round is {GAME_MIN} min game + {BREAK_MIN} min break = {ROUND_MIN} min. Timer does not auto-start games; you control start/pause.
          </div>
        </div>

        {/* Settings */}
        <div style={styles.card}>
          <div style={styles.cardTitleRow}>
            <h2 style={styles.cardTitle}>Settings</h2>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <span style={styles.chip}>End match at {TARGET_SCORE}</span>
              <span style={styles.chip}>Tables: 4</span>
            </div>
          </div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 12, color: "#94a3b8" }}>Tournament name</div>
              <Input value={tournamentName} onChange={setTournamentName} width={340} />
            </div>
            <div>
              <div style={{ fontSize: 12, color: "#94a3b8" }}>Win threshold</div>
              <Input value={String(winThreshold)} onChange={(v) => setWinThreshold(Math.max(0, Number(v || 0)))} width={130} />
            </div>
            <div>
              <div style={{ fontSize: 12, color: "#94a3b8" }}>Win ≥ threshold</div>
              <Input value={String(winHighPts)} onChange={(v) => setWinHighPts(Math.max(0, Number(v || 0)))} width={130} />
            </div>
            <div>
              <div style={{ fontSize: 12, color: "#94a3b8" }}>Win &lt; threshold</div>
              <Input value={String(winLowPts)} onChange={(v) => setWinLowPts(Math.max(0, Number(v || 0)))} width={130} />
            </div>
          </div>
          <div style={{ marginTop: 8, color: "#94a3b8", fontSize: 12 }}>
            Tiebreaker: total game points across pool matches.
          </div>
        </div>

        {/* Players */}
        <div style={styles.card}>
          <div style={styles.cardTitleRow}>
            <h2 style={styles.cardTitle}>Players ({players.length})</h2>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <Btn kind="secondary" onClick={randomizeTeamsUnlocked} disabled={players.length < 16} title={players.length < 16 ? "Need at least 16 players for 8 teams" : ""}>
                Randomize unlocked teams
              </Btn>
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <Input
              value={newPlayerName}
              onChange={setNewPlayerName}
              placeholder="Add player name"
              width={260}
            />
            <Btn kind="primary" onClick={addPlayer} disabled={!newPlayerName.trim()}>
              Add player
            </Btn>
          </div>

          <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
            {players.map((p) => (
              <div key={p.id} style={{ border: "1px solid rgba(148,163,184,0.18)", borderRadius: 16, padding: 12, background: "rgba(255,255,255,0.04)", display: "flex", justifyContent: "space-between", gap: 8 }}>
                <div style={{ fontWeight: 900, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                <button onClick={() => removePlayer(p.id)} style={{ border: "none", background: "transparent", color: "#fb7185", fontWeight: 900, cursor: "pointer" }}>
                  Remove
                </button>
              </div>
            ))}
            {players.length === 0 && <div style={{ color: "#94a3b8" }}>Add players to get started.</div>}
          </div>
        </div>

        {/* Teams */}
        <div style={styles.card}>
          <div style={styles.cardTitleRow}>
            <h2 style={styles.cardTitle}>Teams (8)</h2>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <span style={styles.chip}>Need 16 players</span>
              <span style={styles.chip}>{exactly8TeamsReady ? "✅ Teams ready" : "⚠️ Select players for all teams"}</span>
            </div>
          </div>

          <div style={{ color: "#94a3b8", fontSize: 12, marginBottom: 10 }}>
            You can **manually choose** the players for each team, and **lock** teams you don’t want randomization to change.
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
            {teams.map((t, idx) => {
              const p1 = t.playerIds[0];
              const p2 = t.playerIds[1];
              const usedElsewhere = new Set();
              teams.forEach((x) => {
                if (x.id !== t.id) {
                  x.playerIds.forEach((pid) => pid && usedElsewhere.add(pid));
                }
              });

              const opts = [{ value: "", label: "Select player…" }].concat(
                players.map((p) => ({
                  value: p.id,
                  label: (usedElsewhere.has(p.id) && p.id !== p1 && p.id !== p2) ? `⚠️ ${p.name} (already used)` : p.name,
                }))
              );

              return (
                <div key={t.id} style={{ border: "1px solid rgba(148,163,184,0.18)", borderRadius: 18, padding: 14, background: "rgba(255,255,255,0.04)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                    <div style={{ fontWeight: 900 }}>Team {idx + 1}</div>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 900, color: "#cbd5e1" }}>
                      <input type="checkbox" checked={t.locked} onChange={(e) => toggleTeamLock(t.id, e.target.checked)} />
                      Lock
                    </label>
                  </div>

                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 12, color: "#94a3b8" }}>Team name</div>
                    <Input value={t.name} onChange={(v) => setTeamName(t.id, v)} width={240} />
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
                    <div>
                      <div style={{ fontSize: 12, color: "#94a3b8" }}>Player 1</div>
                      <Select value={p1} onChange={(v) => setTeamPlayer(t.id, 0, v)} options={opts} width={230} />
                    </div>
                    <div>
                      <div style={{ fontSize: 12, color: "#94a3b8" }}>Player 2</div>
                      <Select value={p2} onChange={(v) => setTeamPlayer(t.id, 1, v)} options={opts} width={230} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ marginTop: 12, color: "#94a3b8", fontSize: 12 }}>
            If you see ⚠️ “already used”, that means the same player is assigned to multiple teams (not allowed). Fix by changing one slot.
          </div>
        </div>

        {/* Controls: schedule + bracket creation */}
        <div style={styles.card}>
          <div style={styles.cardTitleRow}>
            <h2 style={styles.cardTitle}>Tournament Controls</h2>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <Btn kind="primary" onClick={createPoolsRoundRobin} disabled={!exactly8TeamsReady}>
                Create 2 pools + Round Robin
              </Btn>
              <Btn kind="secondary" onClick={buildBracketFromPools} disabled={standingsA.length < 4 || standingsB.length < 4}>
                Create Bracket (QF/SF/Final)
              </Btn>
            </div>
          </div>

          {!exactly8TeamsReady ? (
            <div style={{ color: "#94a3b8" }}>
              Select 2 players per team for all 8 teams, then create pools.
            </div>
          ) : (
            <div style={{ color: "#94a3b8" }}>
              Pool stage is 3 rounds. Scores update the standings automatically. Once standings are ready, create the bracket.
            </div>
          )}
        </div>

        {/* Live Scoreboard + Stats */}
        <ScoreboardCard globalScoreboard={globalScoreboard} winnerBoard={winnerBoard} />
        <StatsCard funnyStats={funnyStats} />

        {/* Pools */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <PoolCard
            title="Pool A"
            poolMap={poolMap.A}
            games={games}
            pool="A"
            teamById={teamById}
            readOnly={false}
            onDraftPatch={updateHandDraft}
            onAddHand={addHand}
            onRemoveHand={removeHand}
            onClearGame={clearGame}
          />
          <PoolCard
            title="Pool B"
            poolMap={poolMap.B}
            games={games}
            pool="B"
            teamById={teamById}
            readOnly={false}
            onDraftPatch={updateHandDraft}
            onAddHand={addHand}
            onRemoveHand={removeHand}
            onClearGame={clearGame}
          />
        </div>

        {/* Bracket */}
        <BracketVisual
          bracket={bracketByRound}
          teamById={teamById}
          onScore={setBracketScore}
          onClear={clearBracketMatch}
          readOnly={false}
        />

        <div style={{ marginTop: 12, color: "#94a3b8", fontSize: 12 }}>
          Public link: <span style={styles.chip}>#/public</span> • Table view: <span style={styles.chip}>#/table?n=1</span> … <span style={styles.chip}>#/table?n=4</span>
        </div>
      </div>
    </div>
  );
}

/** ===== Components ===== */

function ScoreboardCard({ globalScoreboard, winnerBoard, compact }) {
  return (
    <div style={styles.card}>
      <div style={styles.cardTitleRow}>
        <h2 style={styles.cardTitle}>Live Scoreboard</h2>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <span style={styles.chip}>Champion: {winnerBoard.champion ?? "—"}</span>
          {!compact ? <span style={styles.chip}>Runner-up: {winnerBoard.runnerUp ?? "—"}</span> : null}
          {!compact ? <span style={styles.chip}>3rd: {winnerBoard.third ?? "—"}</span> : null}
        </div>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#cbd5e1", fontSize: 12 }}>
              {["Rank", "Team", "MP", "GP", "W-L", "Hands", "Coinches", "Surcoinches", "Capots", "High Bid"].map((h) => (
                <th key={h} style={{ padding: "10px 8px", borderBottom: "1px solid rgba(148,163,184,0.18)" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {globalScoreboard.map((r, idx) => (
              <tr key={r.teamId} style={{ background: idx % 2 === 0 ? "rgba(255,255,255,0.03)" : "transparent" }}>
                <td style={{ padding: "10px 8px", fontWeight: 900 }}>{idx + 1}</td>
                <td style={{ padding: "10px 8px", fontWeight: 900 }}>{r.name}</td>
                <td style={{ padding: "10px 8px", fontWeight: 900 }}>{r.mp}</td>
                <td style={{ padding: "10px 8px" }}>{r.gp}</td>
                <td style={{ padding: "10px 8px" }}>{r.wins}-{r.losses}</td>
                <td style={{ padding: "10px 8px" }}>{r.hands}</td>
                <td style={{ padding: "10px 8px" }}>{r.coinches}</td>
                <td style={{ padding: "10px 8px" }}>{r.surcoinches}</td>
                <td style={{ padding: "10px 8px" }}>{r.capots}</td>
                <td style={{ padding: "10px 8px" }}>{r.highestBid}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
        <PodiumCard label="Champion" value={winnerBoard.champion} />
        <PodiumCard label="Runner-up" value={winnerBoard.runnerUp} />
        <PodiumCard label="3rd Place" value={winnerBoard.third} />
      </div>
    </div>
  );
}

function StatsCard({ funnyStats }) {
  return (
    <div style={styles.card}>
      <div style={styles.cardTitleRow}>
        <h2 style={styles.cardTitle}>Stats + Funny Stats</h2>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <span style={styles.chip}>🏆 Biggest blowout</span>
          <span style={styles.chip}>😈 Most coinches</span>
          <span style={styles.chip}>🚀 Highest bid</span>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
        <StatTile
          title="Biggest blowout"
          value={funnyStats.biggest ? `${funnyStats.biggest.diff} pts` : "—"}
          sub={funnyStats.biggest ? `${funnyStats.biggest.label} • ${funnyStats.biggest.score}` : "No matches yet"}
        />
        <StatTile
          title="Fastest match (fewest hands)"
          value={funnyStats.fastest ? `${funnyStats.fastest.hands} hands` : "—"}
          sub={funnyStats.fastest ? funnyStats.fastest.label : "No finished match yet"}
        />
        <StatTile
          title="Most coinches (bidder used coinche)"
          value={funnyStats.mostCoinches ? `${funnyStats.mostCoinches.coinches + funnyStats.mostCoinches.surcoinches}` : "—"}
          sub={funnyStats.mostCoinches ? funnyStats.mostCoinches.name : "—"}
        />
        <StatTile
          title="Highest bid so far"
          value={funnyStats.highestBid?.bid ? `${funnyStats.highestBid.bid} ${funnyStats.highestBid.suit ? suitSymbol(funnyStats.highestBid.suit) : ""}` : "—"}
          sub={funnyStats.highestBid?.teamName ? `${funnyStats.highestBid.teamName} • ${funnyStats.highestBid.coinche}` : "—"}
        />
        <StatTile
          title="Longest table (most hands)"
          value={funnyStats.mostHands ? `${funnyStats.mostHands.hands} hands` : "—"}
          sub={funnyStats.mostHands ? funnyStats.mostHands.label : "—"}
        />
      </div>
    </div>
  );
}

function StatTile({ title, value, sub }) {
  return (
    <div style={{ border: "1px solid rgba(148,163,184,0.18)", borderRadius: 18, padding: 14, background: "rgba(255,255,255,0.04)" }}>
      <div style={{ color: "#94a3b8", fontSize: 12 }}>{title}</div>
      <div style={{ fontSize: 20, fontWeight: 1000, marginTop: 6 }}>{value}</div>
      <div style={{ color: "#cbd5e1", fontSize: 12, marginTop: 6 }}>{sub}</div>
    </div>
  );
}

function PodiumCard({ label, value }) {
  return (
    <div style={{ border: "1px solid rgba(148,163,184,0.18)", borderRadius: 18, padding: 14, background: "rgba(255,255,255,0.04)" }}>
      <div style={{ color: "#94a3b8", fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 1000, marginTop: 6 }}>{value ?? "—"}</div>
    </div>
  );
}

function PoolCard({
  title,
  poolMap,
  games,
  pool,
  teamById,
  readOnly,
  onDraftPatch,
  onAddHand,
  onRemoveHand,
  onClearGame,
}) {
  const poolGames = useMemo(() => games.filter((g) => g.stage === "POOL" && g.pool === pool).sort((a, b) => a.round - b.round || a.table - b.table), [games, pool]);

  const teamNames = poolMap.map((id) => teamById.get(id)?.name).filter(Boolean).join(" • ");

  return (
    <div style={styles.card}>
      <div style={styles.cardTitleRow}>
        <h2 style={styles.cardTitle}>{title}</h2>
        <span style={styles.chip}>Teams: {teamNames || "—"}</span>
      </div>

      {poolGames.length === 0 ? (
        <div style={{ color: "#94a3b8" }}>Create pools to see games.</div>
      ) : (
        <>
          {Array.from(new Set(poolGames.map((g) => g.round))).map((r) => (
            <div key={r} style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <div style={{ fontWeight: 1000 }}>Round {r}</div>
                <span style={styles.chip}>Tables: {poolGames.filter((g) => g.round === r).length}</span>
              </div>
              <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr", gap: 12 }}>
                {poolGames.filter((g) => g.round === r).map((g) => (
                  <GameCard
                    key={g.id}
                    g={g}
                    teamById={teamById}
                    readOnly={readOnly}
                    onDraftPatch={onDraftPatch}
                    onAddHand={onAddHand}
                    onRemoveHand={onRemoveHand}
                    onClear={() => onClearGame?.(g.id)}
                  />
                ))}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function GameCard({ g, teamById, readOnly, onDraftPatch, onAddHand, onRemoveHand, onClear }) {
  const teamA = teamById.get(g.teamAId)?.name ?? "—";
  const teamB = teamById.get(g.teamBId)?.name ?? "—";
  const scoreA = safeInt(g.scoreA) ?? 0;
  const scoreB = safeInt(g.scoreB) ?? 0;
  const pending = !g.winnerId;

  return (
    <div style={{ border: "1px solid rgba(148,163,184,0.18)", borderRadius: 18, padding: 14, background: "rgba(2,6,23,0.25)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <div style={{ fontWeight: 1000 }}>
          Table {g.table} • {teamA} vs {teamB}
        </div>
        <div style={{ color: pending ? "#94a3b8" : "#34d399", fontWeight: 1000 }}>
          {pending ? "Pending" : `Winner: ${teamById.get(g.winnerId)?.name ?? "—"}`}
        </div>
      </div>

      <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <ProgressBar label={teamA} value={scoreA} accent="rgba(59,130,246,0.9)" />
        <ProgressBar label={teamB} value={scoreB} accent="rgba(251,113,133,0.95)" />
      </div>

      <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <span style={styles.chip}>Score: {scoreA} – {scoreB}</span>
        <span style={styles.chip}>Match pts: A +{g.matchPtsA} / B +{g.matchPtsB}</span>
        {g.matchEnded ? <span style={styles.chip}>✅ Ended at {TARGET_SCORE}</span> : <span style={styles.chip}>Hands: {(g.hands || []).length}</span>}

        {!readOnly ? (
          <button onClick={onClear} style={{ marginLeft: "auto", border: "none", background: "transparent", color: "#94a3b8", fontWeight: 1000, cursor: "pointer" }}>
            Clear match
          </button>
        ) : null}
      </div>

      {/* Hand tracker */}
      <div style={{ marginTop: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <div style={{ fontWeight: 1000 }}>Hand Tracker</div>
          <div style={{ color: "#94a3b8", fontSize: 12 }}>
            Add hands until someone reaches {TARGET_SCORE} (auto ends).
          </div>
        </div>

        {!readOnly ? (
          <HandEntry
            g={g}
            teamA={teamA}
            teamB={teamB}
            onPatch={(patch) => onDraftPatch?.(g.id, patch)}
            onAdd={() => onAddHand?.(g.id)}
            disabled={g.matchEnded}
          />
        ) : null}

        <HandsList
          g={g}
          teamA={teamA}
          teamB={teamB}
          onRemove={(handId) => onRemoveHand?.(g.id, handId)}
          readOnly={readOnly}
        />
      </div>
    </div>
  );
}

function HandEntry({ g, teamA, teamB, onPatch, onAdd, disabled }) {
  const d = g.handDraft || {};
  const suitOptions = [
    { value: "S", label: "♠ Spades" },
    { value: "H", label: "♥ Hearts" },
    { value: "D", label: "♦ Diamonds" },
    { value: "C", label: "♣ Clubs" },
  ];

  return (
    <div style={{ marginTop: 10, border: "1px solid rgba(148,163,184,0.18)", borderRadius: 18, padding: 12, background: "rgba(255,255,255,0.03)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10 }}>
        <div>
          <div style={{ fontSize: 12, color: "#94a3b8" }}>Bidder</div>
          <Select
            value={d.bidder || "A"}
            onChange={(v) => onPatch({ bidder: v })}
            options={[
              { value: "A", label: `Team A (left): ${teamA}` },
              { value: "B", label: `Team B (right): ${teamB}` },
            ]}
            width={260}
            disabled={disabled}
          />
        </div>

        <div>
          <div style={{ fontSize: 12, color: "#94a3b8" }}>Bid</div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <Input value={d.bid ?? ""} onChange={(v) => onPatch({ bid: v })} width={110} placeholder="80.." disabled={disabled} />
            <Select value={d.suit || "S"} onChange={(v) => onPatch({ suit: v })} options={suitOptions} width={150} disabled={disabled} />
          </div>
        </div>

        <div>
          <div style={{ fontSize: 12, color: "#94a3b8" }}>Coinche</div>
          <Select
            value={d.coincheLevel || "NONE"}
            onChange={(v) => onPatch({ coincheLevel: v })}
            options={[
              { value: "NONE", label: "None" },
              { value: "COINCHE", label: "Coinche (x2)" },
              { value: "SURCOINCHE", label: "Surcoinche (x4)" },
            ]}
            width={190}
            disabled={disabled}
          />
        </div>

        <div>
          <div style={{ fontSize: 12, color: "#94a3b8" }}>Capot</div>
          <Select
            value={d.capot || "NO"}
            onChange={(v) => onPatch({ capot: v })}
            options={[
              { value: "NO", label: "No" },
              { value: "YES", label: "Yes" },
            ]}
            width={120}
            disabled={disabled}
          />
        </div>

        <div>
          <div style={{ fontSize: 12, color: "#94a3b8" }}>Bidder trick points (0–162)</div>
          <Input value={d.bidderTrickPoints ?? ""} onChange={(v) => onPatch({ bidderTrickPoints: v })} width={190} placeholder="ex: 91" disabled={disabled} />
        </div>

        <div>
          <div style={{ fontSize: 12, color: "#94a3b8" }}>Announces Team A (non-belote)</div>
          <Input value={d.announceA ?? ""} onChange={(v) => onPatch({ announceA: v })} width={190} placeholder="0" disabled={disabled} />
        </div>

        <div>
          <div style={{ fontSize: 12, color: "#94a3b8" }}>Announces Team B (non-belote)</div>
          <Input value={d.announceB ?? ""} onChange={(v) => onPatch({ announceB: v })} width={190} placeholder="0" disabled={disabled} />
        </div>

        <div>
          <div style={{ fontSize: 12, color: "#94a3b8" }}>Belote (who has it)</div>
          <Select
            value={d.beloteTeam || "NONE"}
            onChange={(v) => onPatch({ beloteTeam: v })}
            options={[
              { value: "NONE", label: "None" },
              { value: "A", label: "Team A" },
              { value: "B", label: "Team B" },
            ]}
            width={150}
            disabled={disabled}
          />
        </div>

        <div style={{ gridColumn: "1/-1" }}>
          <div style={{ fontSize: 12, color: "#94a3b8" }}>Notes (optional)</div>
          <Input value={d.notes ?? ""} onChange={(v) => onPatch({ notes: v })} width={560} placeholder="ex: big announce / funny moment" disabled={disabled} />
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
        <Btn kind="primary" onClick={onAdd} disabled={disabled || !String(d.bid ?? "").trim() || !String(d.bidderTrickPoints ?? "").trim()} title="Adds hand and clears the fields">
          ➕ Add Hand
        </Btn>
      </div>

      {disabled ? <div style={{ marginTop: 8, color: "#34d399", fontWeight: 900 }}>Match ended (reached {TARGET_SCORE}).</div> : null}
    </div>
  );
}

function HandsList({ g, teamA, teamB, onRemove, readOnly }) {
  const hands = g.hands || [];
  if (hands.length === 0) {
    return <div style={{ marginTop: 10, color: "#94a3b8" }}>No hands yet.</div>;
  }

  return (
    <div style={{ marginTop: 10, overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
        <thead>
          <tr style={{ textAlign: "left", color: "#cbd5e1", fontSize: 12 }}>
            {["#", "Bidder", "Bid", "Suit", "Coinche", "Capot", "Bidder Tricks", "Ann A", "Ann B", "Belote", `Hand A`, `Hand B`, "Notes", ""].map((h) => (
              <th key={h} style={{ padding: "10px 8px", borderBottom: "1px solid rgba(148,163,184,0.18)" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {hands.map((h, idx) => (
            <tr key={h.id} style={{ background: idx % 2 === 0 ? "rgba(255,255,255,0.03)" : "transparent" }}>
              <td style={{ padding: "10px 8px", fontWeight: 900 }}>{idx + 1}</td>
              <td style={{ padding: "10px 8px" }}>{h.bidder === "A" ? `A: ${teamA}` : `B: ${teamB}`}</td>
              <td style={{ padding: "10px 8px", fontWeight: 900 }}>{h.bid}</td>
              <td style={{ padding: "10px 8px", fontWeight: 1000 }}>{suitSymbol(h.suit)} {suitLabel(h.suit).replace(/^.\s/, "")}</td>
              <td style={{ padding: "10px 8px" }}>{h.coincheLevel}</td>
              <td style={{ padding: "10px 8px" }}>{h.capot}</td>
              <td style={{ padding: "10px 8px" }}>{h.bidderTrickPoints}</td>
              <td style={{ padding: "10px 8px" }}>{h.announceA}</td>
              <td style={{ padding: "10px 8px" }}>{h.announceB}</td>
              <td style={{ padding: "10px 8px" }}>{h.beloteTeam}</td>
              <td style={{ padding: "10px 8px", fontWeight: 900, color: "#93c5fd" }}>{h._scoreA ?? ""}</td>
              <td style={{ padding: "10px 8px", fontWeight: 900, color: "#fda4af" }}>{h._scoreB ?? ""}</td>
              <td style={{ padding: "10px 8px" }}>{h.notes || ""}</td>
              <td style={{ padding: "10px 8px" }}>
                {!readOnly ? (
                  <button onClick={() => onRemove(h.id)} style={{ border: "none", background: "transparent", color: "#fb7185", fontWeight: 1000, cursor: "pointer" }}>
                    Remove
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BracketVisual({ bracket, teamById, onScore, onClear, readOnly }) {
  return (
    <div style={styles.card}>
      <div style={styles.cardTitleRow}>
        <h2 style={styles.cardTitle}>Bracket (Visual)</h2>
        <span style={styles.chip}>QF → SF → Final (+ 3rd)</span>
      </div>

      {bracket.length === 0 ? (
        <div style={{ color: "#94a3b8" }}>Create the bracket once Pool standings have top 4 each.</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 12 }}>
          {bracket.map((m) => (
            <div key={m.id} style={{ border: "1px solid rgba(148,163,184,0.18)", borderRadius: 18, padding: 14, background: "rgba(2,6,23,0.25)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 10 }}>
                <div style={{ fontWeight: 1000 }}>
                  {m.label} <span style={{ color: "#94a3b8", fontWeight: 900 }}>({m.round})</span>
                </div>
                <span style={styles.chip}>Table {m.table}</span>
              </div>

              <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
                <TeamRow name={teamById.get(m.teamAId)?.name ?? "TBD"} isWinner={m.winnerId === m.teamAId} />
                <TeamRow name={teamById.get(m.teamBId)?.name ?? "TBD"} isWinner={m.winnerId === m.teamBId} />
              </div>

              <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <Input value={m.scoreA} onChange={(v) => onScore?.(m.id, "A", v)} width={90} placeholder="A pts" disabled={readOnly || !m.teamAId || !m.teamBId} />
                <span style={{ color: "#94a3b8" }}>vs</span>
                <Input value={m.scoreB} onChange={(v) => onScore?.(m.id, "B", v)} width={90} placeholder="B pts" disabled={readOnly || !m.teamAId || !m.teamBId} />
                {!readOnly ? (
                  <button onClick={() => onClear?.(m.id)} style={{ marginLeft: "auto", border: "none", background: "transparent", color: "#94a3b8", fontWeight: 1000, cursor: "pointer" }}>
                    Clear
                  </button>
                ) : null}
              </div>

              <div style={{ marginTop: 8, color: "#94a3b8", fontSize: 12 }}>
                {m.winnerId ? `Winner: ${teamById.get(m.winnerId)?.name ?? "—"}` : "Pending"}{" "}
                {m.nextMatchId ? `• Advances to next match (slot ${m.nextSlot})` : ""}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TeamRow({ name, isWinner }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 12px", borderRadius: 14, border: "1px solid rgba(148,163,184,0.18)", background: isWinner ? "rgba(34,197,94,0.12)" : "rgba(255,255,255,0.03)" }}>
      <div style={{ fontWeight: 1000, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
      <div style={{ fontWeight: 1000, color: isWinner ? "#34d399" : "#94a3b8" }}>{isWinner ? "WIN" : ""}</div>
    </div>
  );
}

function TableMatchEntry({ kind, match, teamById, onDraftPatch, onAddHand, onRemoveHand, onClear }) {
  const teamA = teamById.get(match.teamAId)?.name ?? "—";
  const teamB = teamById.get(match.teamBId)?.name ?? "—";
  const scoreA = safeInt(match.scoreA) ?? 0;
  const scoreB = safeInt(match.scoreB) ?? 0;

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 1000 }}>Pool Match • Table {match.table} • Round {match.round}</div>
        <span style={styles.chip}>{match.matchEnded ? "✅ Match ended" : "Live entry"}</span>
      </div>

      <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <ProgressBar label={teamA} value={scoreA} accent="rgba(59,130,246,0.9)" />
        <ProgressBar label={teamB} value={scoreB} accent="rgba(251,113,133,0.95)" />
      </div>

      <div style={{ marginTop: 12 }}>
        <HandEntry
          g={match}
          teamA={teamA}
          teamB={teamB}
          onPatch={onDraftPatch}
          onAdd={onAddHand}
          disabled={match.matchEnded}
        />

        <HandsList
          g={match}
          teamA={teamA}
          teamB={teamB}
          onRemove={onRemoveHand}
          readOnly={false}
        />

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
          <Btn kind="secondary" onClick={onClear}>Clear match</Btn>
        </div>
      </div>
    </div>
  );
}

function BracketMatchEntry({ match, teamById, onScore, onClear }) {
  const teamA = teamById.get(match.teamAId)?.name ?? "TBD";
  const teamB = teamById.get(match.teamBId)?.name ?? "TBD";
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 1000 }}>{match.label} ({match.round}) • Table {match.table}</div>
        <span style={styles.chip}>{match.winnerId ? `Winner: ${teamById.get(match.winnerId)?.name ?? "—"}` : "Pending"}</span>
      </div>

      <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
        <TeamRow name={teamA} isWinner={match.winnerId === match.teamAId} />
        <TeamRow name={teamB} isWinner={match.winnerId === match.teamBId} />
      </div>

      <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <Input value={match.scoreA} onChange={(v) => onScore("A", v)} width={90} placeholder="A pts" disabled={!match.teamAId || !match.teamBId} />
        <span style={{ color: "#94a3b8" }}>vs</span>
        <Input value={match.scoreB} onChange={(v) => onScore("B", v)} width={90} placeholder="B pts" disabled={!match.teamAId || !match.teamBId} />
        <Btn kind="secondary" onClick={onClear}>Clear</Btn>
      </div>

      <div style={{ marginTop: 10, color: "#94a3b8", fontSize: 12 }}>
        Bracket matches are manual score entry (hand tracking currently only in pool matches).
      </div>
    </div>
  );
}