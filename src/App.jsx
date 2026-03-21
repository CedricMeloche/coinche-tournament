import React, { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabaseClient";

/**
 * Coinche Scorekeeper
 * Routes:
 *   #/admin
 *   #/public
 *   #/table?code=AB12
 */

const LS_KEY = "coinche_scorekeeper_v1";
const TARGET_SCORE = 2000;
const APP_UPDATED_EVENT = "coinche_state_updated";

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
const parseBidValue = (v) =>
  String(v || "").trim().toLowerCase() === "capot" ? 250 : safeInt(v);

const jsonSafe = (v, fallback) => {
  try {
    if (v === null || v === undefined) return fallback;
    if (typeof v === "string") return JSON.parse(v);
    return v;
  } catch {
    return fallback;
  }
};

function excelEscape(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildWorksheetXml(name, rows) {
  const safeRows = rows?.length ? rows : [[]];

  const rowXml = safeRows
    .map(
      (row) =>
        `<Row>${(row || [])
          .map((cell) => {
            const value = cell ?? "";
            const isNumber =
              typeof value === "number" && Number.isFinite(value);

            return isNumber
              ? `<Cell><Data ss:Type="Number">${value}</Data></Cell>`
              : `<Cell><Data ss:Type="String">${excelEscape(value)}</Data></Cell>`;
          })
          .join("")}</Row>`
    )
    .join("");

  return `
    <Worksheet ss:Name="${excelEscape(name)}">
      <Table>
        ${rowXml}
      </Table>
    </Worksheet>
  `;
}

function exportCoincheExcel({
  appName,
  matches,
  teamById,
  playerById,
  scoreboardRows = [],
  teamStatsRows = [],
  funStats = {},
}) {
  const matchesRows = [
    [
      "Match ID",
      "Code",
      "Table Name",
      "Match Label",
      "Team A",
      "Team B",
      "Total A",
      "Total B",
      "Winner",
      "Completed",
      "Forced Complete",
      "Hands Played",
      "First Shuffler",
      "Table Order",
      "Last Updated",
    ],
    ...matches.map((m) => {
      const teamAName = teamById.get(m.teamAId)?.name || "";
      const teamBName = teamById.get(m.teamBId)?.name || "";
      const winnerName = teamById.get(m.winnerId)?.name || "";
      const firstShufflerName = playerById.get(m.firstShufflerPlayerId)?.name || "";
      const tableOrderNames = (m.tableOrderPlayerIds || [])
        .map((pid) => playerById.get(pid)?.name || pid)
        .join(" -> ");

      return [
        m.id,
        m.code,
        m.tableName,
        m.label,
        teamAName,
        teamBName,
        Number(m.totalA) || 0,
        Number(m.totalB) || 0,
        winnerName,
        m.completed ? "Yes" : "No",
        m.forcedComplete ? "Yes" : "No",
        (m.hands || []).length,
        firstShufflerName,
        tableOrderNames,
        m.lastUpdatedAt ? new Date(m.lastUpdatedAt).toISOString() : "",
      ];
    }),
  ];

  const handsRows = [
    [
      "Match ID",
      "Match Code",
      "Table Name",
      "Match Label",
      "Hand #",
      "Created At",
      "Edited At",
      "Score A",
      "Score B",
      "Bidder Succeeded",
      "Skipped Hand",
      "Bidder Side",
      "Bid",
      "Suit",
      "Coinche Level",
      "Capot",
      "Bidder Trick Points",
      "Non-bidder Trick Points",
      "Trick Source",
      "Belote Team",
      "Announce A1",
      "Announce A1 Player",
      "Announce A2",
      "Announce A2 Player",
      "Announce B1",
      "Announce B1 Player",
      "Announce B2",
      "Announce B2 Player",
      "Announce A Total",
      "Announce B Total",
      "Dealer",
    ],
    ...matches.flatMap((m) =>
      (m.hands || []).map((h) => {
        const ds = h.draftSnapshot || {};
        return [
          m.id,
          m.code,
          m.tableName,
          m.label,
          h.idx,
          h.createdAt ? new Date(h.createdAt).toISOString() : "",
          h.editedAt ? new Date(h.editedAt).toISOString() : "",
          Number(h.scoreA) || 0,
          Number(h.scoreB) || 0,
          h.bidderSucceeded ? "Yes" : "No",
          ds.skippedHand ? "Yes" : "No",
          ds.bidder || "",
          ds.bid ?? "",
          ds.suit || "",
          ds.coincheLevel || "",
          ds.capot ? "Yes" : "No",
          ds.bidderTrickPoints ?? "",
          ds.nonBidderTrickPoints ?? "",
          ds.trickSource || "",
          ds.beloteTeam || "",
          ds.announceA1 ?? "",
          ds.announceA1PlayerName || playerById.get(ds.announceA1PlayerId)?.name || "",
          ds.announceA2 ?? "",
          ds.announceA2PlayerName || playerById.get(ds.announceA2PlayerId)?.name || "",
          ds.announceB1 ?? "",
          ds.announceB1PlayerName || playerById.get(ds.announceB1PlayerId)?.name || "",
          ds.announceB2 ?? "",
          ds.announceB2PlayerName || playerById.get(ds.announceB2PlayerId)?.name || "",
          ds.announceA ?? "",
          ds.announceB ?? "",
          ds.shufflerName || "",
        ];
      })
    ),
  ];

  const standingsRows = [
    ["Rank", "Team", "MP", "W", "L", "P", "PF", "PA", "Diff"],
    ...scoreboardRows.map((r, idx) => [
      idx + 1,
      r.name,
      Number(r.matchesPlayed) || 0,
      Number(r.wins) || 0,
      Number(r.losses) || 0,
      Number(r.standingPoints) || 0,
      Number(r.pointsFor) || 0,
      Number(r.pointsAgainst) || 0,
      (Number(r.pointsFor) || 0) - (Number(r.pointsAgainst) || 0),
    ]),
  ];

  const teamStatsSheetRows = [
    [
      "Team",
      "Avg Pts/Hand",
      "Avg Pts/Match",
      "Allowed/Hand",
      "Bid %",
      "Coinche %",
      "Announce Pts",
      "Capots",
      "Comebacks",
      "Shutouts",
      "Best Hand",
      "Worst Hand",
    ],
    ...teamStatsRows.map((r) => [
      r.name,
      Number(r.avgPointsPerHand) || 0,
      Number(r.avgPointsPerMatch) || 0,
      Number(r.avgPointsAllowedPerHand) || 0,
      Number(r.bidSuccessPct) || 0,
      Number(r.coincheSuccessPct) || 0,
      Number(r.totalAnnouncePoints) || 0,
      Number(r.capotsMade) || 0,
      Number(r.comebackWins) || 0,
      Number(r.shutoutHandsForced) || 0,
      Number(r.bestSingleHand) || 0,
      Number(r.worstSingleHand) || 0,
    ]),
  ];

  const funStatsRows = [
    ["Metric", "Value", "Details"],
    ["Biggest Blowout", funStats?.biggestBlowout?.diff ?? 0, funStats?.biggestBlowout?.label ?? ""],
    ["Best Comeback", funStats?.bestComeback?.deficit ?? 0, funStats?.bestComeback?.label ?? ""],
    ["Closest Match", funStats?.closest?.diff ?? 0, funStats?.closest?.label ?? ""],
    ["Clutch Finish", funStats?.clutchFinish?.diff ?? 0, funStats?.clutchFinish?.label ?? ""],
    ["Momentum Monster", funStats?.momentumMonster?.swing ?? 0, funStats?.momentumMonster?.label ?? ""],
    ["Most Points by a Team in a Match", funStats?.mostPointsGame?.points ?? 0, funStats?.mostPointsGame?.label ?? ""],
    ["Least Points by a Team in a Match", funStats?.leastPointsGame?.points ?? 0, funStats?.leastPointsGame?.label ?? ""],
    ["Highest Scoring Hand", funStats?.highestScoringHand?.points ?? 0, funStats?.highestScoringHand?.label ?? ""],
    ["Best Avg Score / Hand", funStats?.averageScorePerHand?.value ?? 0, funStats?.averageScorePerHand?.label ?? ""],
    [
      "Best Successful Bid %",
      funStats?.bestSuccessfulBidRateTeam?.pct ?? 0,
      `${funStats?.bestSuccessfulBidRateTeam?.name ?? ""} (${funStats?.bestSuccessfulBidRateTeam?.made ?? 0}/${funStats?.bestSuccessfulBidRateTeam?.total ?? 0})`,
    ],
    [
      "Best Coinche Success %",
      funStats?.bestCoincheRateTeam?.pct ?? 0,
      `${funStats?.bestCoincheRateTeam?.name ?? ""} (${funStats?.bestCoincheRateTeam?.made ?? 0}/${funStats?.bestCoincheRateTeam?.total ?? 0})`,
    ],
    [
      "Longest Hand Win Streak",
      funStats?.longestHandWinStreak?.streak ?? 0,
      funStats?.longestHandWinStreak?.name ?? "",
    ],
    ["Capot Count by Team", funStats?.capotCountByTeam?.v ?? 0, funStats?.capotCountByTeam?.name ?? ""],
    ["Capot Count by Player", funStats?.capotCountByPlayer?.v ?? 0, funStats?.capotCountByPlayer?.name ?? ""],
    ["Perfect Defense", funStats?.perfectDefense?.count ?? 0, funStats?.perfectDefense?.name ?? ""],
    ["Coinche King", funStats?.coincheKing?.v ?? 0, funStats?.coincheKing?.name ?? ""],
    ["Capot Hero", funStats?.capotHero?.v ?? 0, funStats?.capotHero?.name ?? ""],
    ["Belote Magnet", funStats?.beloteMagnet?.v ?? 0, funStats?.beloteMagnet?.name ?? ""],
    ["Most Announces", funStats?.mostAnnounces?.v ?? 0, funStats?.mostAnnounces?.name ?? ""],
    ["Highest Announces", funStats?.highestAnnounces?.v ?? 0, funStats?.highestAnnounces?.name ?? ""],
  ];

  const handAuditRows = [
    [
      "Match Code",
      "Table Name",
      "Match Label",
      "Hand #",
      "Created At",
      "Edited At",
      "Dealer",
      "Bidder",
      "Bid",
      "Suit",
      "Coinche",
      "Capot",
      "Belote Team",
      "Announce A Total",
      "Announce B Total",
      "Bidder Trick Points",
      "Non-bidder Trick Points",
      "Score A",
      "Score B",
      "Bidder Succeeded",
      "Skipped",
    ],
    ...matches.flatMap((m) =>
      (m.hands || []).map((h) => {
        const ds = h.draftSnapshot || {};
        const teamAName = teamById.get(m.teamAId)?.name || "Team A";
        const teamBName = teamById.get(m.teamBId)?.name || "Team B";

        return [
          m.code || "",
          m.tableName || "",
          m.label || "",
          Number(h.idx) || 0,
          h.createdAt ? new Date(h.createdAt).toISOString() : "",
          h.editedAt ? new Date(h.editedAt).toISOString() : "",
          ds.shufflerName || "",
          ds.bidder === "A" ? teamAName : ds.bidder === "B" ? teamBName : "",
          ds.bid ?? "",
          ds.suit || "",
          ds.coincheLevel || "",
          ds.capot ? "Yes" : "No",
          ds.beloteTeam === "A" ? teamAName : ds.beloteTeam === "B" ? teamBName : "",
          Number(ds.announceA) || 0,
          Number(ds.announceB) || 0,
          ds.bidderTrickPoints ?? "",
          ds.nonBidderTrickPoints ?? "",
          Number(h.scoreA) || 0,
          Number(h.scoreB) || 0,
          h.bidderSucceeded ? "Yes" : "No",
          ds.skippedHand ? "Yes" : "No",
        ];
      })
    ),
  ];

  const workbookXml = `<?xml version="1.0"?>
<Workbook
  xmlns="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:o="urn:schemas-microsoft-com:office:office"
  xmlns:x="urn:schemas-microsoft-com:office:excel"
  xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:html="http://www.w3.org/TR/REC-html40">
  <DocumentProperties xmlns="urn:schemas-microsoft-com:office:office">
    <Author>ChatGPT</Author>
    <Title>${excelEscape(appName || "Coinche Scorekeeper Export")}</Title>
    <Created>${new Date().toISOString()}</Created>
  </DocumentProperties>
  <ExcelWorkbook xmlns="urn:schemas-microsoft-com:office:excel">
    <ProtectStructure>False</ProtectStructure>
    <ProtectWindows>False</ProtectWindows>
  </ExcelWorkbook>
  ${buildWorksheetXml("Standings", standingsRows)}
  ${buildWorksheetXml("Team Stats", teamStatsSheetRows)}
  ${buildWorksheetXml("Fun Stats", funStatsRows)}
  ${buildWorksheetXml("Hand Audit Log", handAuditRows)}
  ${buildWorksheetXml("Matches", matchesRows)}
  ${buildWorksheetXml("Hands", handsRows)}
</Workbook>`;

  const blob = new Blob([workbookXml], {
    type: "application/vnd.ms-excel;charset=utf-8;",
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  a.href = url;
  a.download = `coinche-export-${stamp}.xls`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
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

function roundBelotePoints(raw) {
  const n = clamp(Number(raw) || 0, 0, 162);
  const ones = n % 10;

  if (ones <= 5) return n - ones;
  return n + (10 - ones);
}

function roundTrickPointsPair(rawBidderPoints) {
  const bidderRaw = clamp(Number(rawBidderPoints) || 0, 0, 162);
  const oppRaw = 162 - bidderRaw;

  return {
    bidderRounded: roundBelotePoints(bidderRaw),
    oppRounded: roundBelotePoints(oppRaw),
  };
}

function computeContractRequirement({ bid, bidder, announceA, announceB, beloteTeam }) {
  const bidVal = Number(bid) || 0;
  const aAnn = Number(announceA) || 0;
  const bAnn = Number(announceB) || 0;

  const bidderHasBelote =
    (bidder === "A" && beloteTeam === "A") || (bidder === "B" && beloteTeam === "B");

  const bidderAnnounces = bidder === "A" ? aAnn : bAnn;
  const beloteReduction = bidderHasBelote ? 20 : 0;

  // Announces can reduce the contract, but never below 81.
  // Belote is the only announce that can reduce it to 71.
  const floor = bidderHasBelote ? 71 : 81;
  const reduction = bidderAnnounces + beloteReduction;

  return Math.max(floor, bidVal - reduction);
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

  const rawBidder = clamp(Number(bidderTrickPoints) || 0, 0, 162);
  const { bidderRounded, oppRounded } = roundTrickPointsPair(rawBidder);

  const required = computeContractRequirement({
    bid: bidVal,
    bidder,
    announceA: aAnn,
    announceB: bAnn,
    beloteTeam,
  });

  const bidderSucceeded = rawBidder >= required;
  const isCoinche = coincheLevel !== "NONE";
  const mult =
    coincheLevel === "SURCOINCHE" ? 4 : coincheLevel === "COINCHE" ? 2 : 1;

  let scoreA = 0;
  let scoreB = 0;

  if (capot) {
    const winnerTotal = 250 + bidVal + aAnn + bAnn + beloteA + beloteB;
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
    const winnerTotal = 160 + aAnn + bAnn + mult * bidVal;

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
      scoreA = bidderRounded + aAnn + bidVal + beloteA;
      scoreB = oppRounded + bAnn + beloteB;
    } else {
      scoreB = bidderRounded + bAnn + bidVal + beloteB;
      scoreA = oppRounded + aAnn + beloteA;
    }
  } else {
    const stolenAnnounces = aAnn + bAnn;
    if (bidderIsA) {
      scoreA = beloteA;
      scoreB = 160 + bidVal + stolenAnnounces + beloteB;
    } else {
      scoreB = beloteB;
      scoreA = 160 + bidVal + stolenAnnounces + beloteA;
    }
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
  skippedHand: false,
  beloteTeam: "NONE",
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
  hands: (m.hands || []).map((h) => ({
    ...h,
    draftSnapshot: { ...defaultFastDraft(), ...(h.draftSnapshot || {}) },
  })),
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

const sumAnnounces = (d, side) => num(d?.[`announce${side}1`]) + num(d?.[`announce${side}2`]);

const getTeamPlayers = (team, playerById) =>
  (team?.playerIds || []).map((id) => playerById.get(id)).filter(Boolean);

function getCurrentDealerInfo(match, playerById) {
  const order = match.tableOrderPlayerIds || [];
  if (!order.length || !match.firstShufflerPlayerId) return { playerId: "", name: "" };
  const startIdx = order.findIndex((id) => id === match.firstShufflerPlayerId);
  if (startIdx < 0) return { playerId: "", name: "" };
  const idx = (startIdx + (match.hands || []).length) % order.length;
  const playerId = order[idx] || "";
  return { playerId, name: playerById.get(playerId)?.name || "" };
}

/* =========================
   Supabase mapping
========================= */

function matchToRow(match, teamById, playerById, appName) {
  const teamA = teamById.get(match.teamAId) || null;
  const teamB = teamById.get(match.teamBId) || null;
  const teamAPlayers = getTeamPlayers(teamA, playerById).map((p) => ({ id: p.id, name: p.name }));
  const teamBPlayers = getTeamPlayers(teamB, playerById).map((p) => ({ id: p.id, name: p.name }));

  return {
    id: match.id,
    code: match.code,
    table_name: match.tableName,
    label: match.label,
    team_a_id: match.teamAId,
    team_b_id: match.teamBId,
    total_a: match.totalA,
    total_b: match.totalB,
    winner_id: match.winnerId,
    completed: !!match.completed,
    forced_complete: !!match.forcedComplete,
    editing_hand_idx: match.editingHandIdx,
    last_updated_at: new Date(match.lastUpdatedAt || Date.now()).toISOString(),
    table_order_player_ids: match.tableOrderPlayerIds || [],
    first_shuffler_player_id: match.firstShufflerPlayerId || "",
    fast_draft: match.fastDraft || defaultFastDraft(),
    app_name: appName || "Coinche Scorekeeper",
    team_a_name: teamA?.name || "",
    team_b_name: teamB?.name || "",
    team_a_players: teamAPlayers,
    team_b_players: teamBPlayers,
  };
}

function handToRow(match, hand) {
  return {
    id: `${match.id}_${hand.idx}`,
    match_id: match.id,
    hand_idx: hand.idx,
    created_at_ts: hand.createdAt || Date.now(),
    edited_at: hand.editedAt ? new Date(hand.editedAt).toISOString() : null,
    score_a: hand.scoreA,
    score_b: hand.scoreB,
    bidder_succeeded: !!hand.bidderSucceeded,
    draft_snapshot: hand.draftSnapshot || {},
  };
}

function rowToMatch(row) {
  return normalizeLoadedMatch({
    id: row.id,
    code: row.code,
    tableName: row.table_name || "Table",
    label: row.label || "Match",
    teamAId: row.team_a_id || null,
    teamBId: row.team_b_id || null,
    hands: [],
    totalA: Number(row.total_a) || 0,
    totalB: Number(row.total_b) || 0,
    winnerId: row.winner_id || null,
    completed: !!row.completed,
    forcedComplete: !!row.forced_complete,
    fastDraft: jsonSafe(row.fast_draft, defaultFastDraft()),
    editingHandIdx: row.editing_hand_idx ?? null,
    timelineDiffs: [],
    lastUpdatedAt: row.last_updated_at ? new Date(row.last_updated_at).getTime() : Date.now(),
    tableOrderPlayerIds: jsonSafe(row.table_order_player_ids, []),
    firstShufflerPlayerId: row.first_shuffler_player_id || "",
  });
}

function rowToHand(row) {
  return {
    idx: Number(row.hand_idx) || 0,
    createdAt: Number(row.created_at_ts) || Date.now(),
    editedAt: row.edited_at ? new Date(row.edited_at).getTime() : null,
    scoreA: Number(row.score_a) || 0,
    scoreB: Number(row.score_b) || 0,
    bidderSucceeded: !!row.bidder_succeeded,
    draftSnapshot: { ...defaultFastDraft(), ...jsonSafe(row.draft_snapshot, {}) },
  };
}

function derivePeopleAndTeams(matchRows) {
  const playersMap = new Map();
  const teamsMap = new Map();

  for (const row of matchRows) {
    const aPlayers = jsonSafe(row.team_a_players, []);
    const bPlayers = jsonSafe(row.team_b_players, []);

    if (row.team_a_id) {
      teamsMap.set(row.team_a_id, {
        id: row.team_a_id,
        name: row.team_a_name || "Team A",
        playerIds: aPlayers.map((p) => p.id).filter(Boolean),
        locked: false,
      });
    }

    if (row.team_b_id) {
      teamsMap.set(row.team_b_id, {
        id: row.team_b_id,
        name: row.team_b_name || "Team B",
        playerIds: bPlayers.map((p) => p.id).filter(Boolean),
        locked: false,
      });
    }

    [...aPlayers, ...bPlayers].forEach((p) => {
      if (p?.id && p?.name) playersMap.set(p.id, { id: p.id, name: p.name });
    });
  }

  return {
    players: Array.from(playersMap.values()),
    teams: Array.from(teamsMap.values()),
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
  handRow1: { display: "grid", gridTemplateColumns: "repeat(4, minmax(160px, 1fr))", gap: 10, marginTop: 12, alignItems: "start" },
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

function extractTableAndMatchOrder(match) {
  const tableText = String(match?.tableName || "");
  const labelText = String(match?.label || "");

  const tableMatch = tableText.match(/(\d+)/);
  const labelMatch = labelText.match(/(\d+)/);

  const tableNumber = tableMatch ? Number(tableMatch[1]) : 999999;
  const matchNumber = labelMatch ? Number(labelMatch[1]) : 999999;

  return { tableNumber, matchNumber };
}

function compareMatchesByTournamentOrder(a, b) {
  const aOrder = extractTableAndMatchOrder(a);
  const bOrder = extractTableAndMatchOrder(b);

  // First sort by match number: Match 1, Match 2, Match 3...
  if (aOrder.matchNumber !== bOrder.matchNumber) {
    return aOrder.matchNumber - bOrder.matchNumber;
  }

  // Then sort by table number: Table 1, Table 2, Table 3...
  if (aOrder.tableNumber !== bOrder.tableNumber) {
    return aOrder.tableNumber - bOrder.tableNumber;
  }

  // Stable fallback by code
  const codeA = String(a?.code || "");
  const codeB = String(b?.code || "");
  return codeA.localeCompare(codeB, undefined, { numeric: true, sensitivity: "base" });
}

export default function App() {
  const [route, setRoute] = useState(() => parseHashRoute());
  const [tableMissingDelayDone, setTableMissingDelayDone] = useState(false);
  const [syncStatus, setSyncStatus] = useState("Connecting…");

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

  const [editingPlayerId, setEditingPlayerId] = useState(null);
  const [editingPlayerName, setEditingPlayerName] = useState("");

  const inputRef = useRef(null);
  const lastSavedAtRef = useRef(0);
  const isPushingRef = useRef(false);
  const handSaveLocksRef = useRef(new Set());
  const routeRefreshAttemptRef = useRef("");

  useEffect(() => ensureGlobalCSS(), []);

  const persistNow = (next = {}) => {
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
      lastSavedAtRef.current = payload.savedAt;
      localStorage.setItem(LS_KEY, JSON.stringify(payload));
      window.dispatchEvent(new CustomEvent(APP_UPDATED_EVENT, { detail: { savedAt: payload.savedAt } }));
    } catch {}
  };

  const saveField = (setter, key, value) => {
    setter(value);
    persistNow({ [key]: value });
  };

  const hydrateFromPayload = (d) => {
    const savedAt = Number(d?.savedAt) || 0;
    if (savedAt) lastSavedAtRef.current = savedAt;
    setAppName(d.appName ?? "Coinche Scorekeeper");
    setPlayers(d.players ?? []);
    setTeams(d.teams ?? []);
    setAvoidSameTeams(Boolean(d.avoidSameTeams ?? true));
    setPairHistory(d.pairHistory ?? []);
    setMatches((d.matches ?? []).map(normalizeLoadedMatch));
  };

  const maybeHydrateLatest = () => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return false;
      const d = JSON.parse(raw);
      const savedAt = Number(d?.savedAt) || 0;
      if (savedAt && savedAt <= lastSavedAtRef.current) return false;
      hydrateFromPayload(d);
      return true;
    } catch {
      return false;
    }
  };

  const playerById = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);
  const teamById = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams]);

  const hydrateFromRemote = (matchRows, handRows) => {
    const baseMatches = (matchRows || []).map(rowToMatch);
    const handsByMatchId = new Map();

    (handRows || []).forEach((row) => {
      const arr = handsByMatchId.get(row.match_id) || [];
      arr.push(rowToHand(row));
      handsByMatchId.set(row.match_id, arr);
    });

    const fullMatches = baseMatches.map((m) =>
      recomputeMatch({
        ...m,
        hands: (handsByMatchId.get(m.id) || []).sort((a, b) => a.idx - b.idx),
      })
    );

    const derived = derivePeopleAndTeams(matchRows || []);
    const payload = {
      appName: matchRows?.[0]?.app_name || appName || "Coinche Scorekeeper",
      players: derived.players.length ? derived.players : players,
      teams: derived.teams.length ? derived.teams : teams,
      avoidSameTeams,
      pairHistory,
      matches: fullMatches,
      savedAt: Date.now(),
    };

    hydrateFromPayload(payload);
    persistNow(payload);
  };

  const refreshFromSupabase = async () => {
    try {
      const [{ data: matchRows, error: matchErr }, { data: handRows, error: handErr }] = await Promise.all([
        supabase.from("matches").select("*").order("last_updated_at", { ascending: false }),
        supabase.from("hands").select("*").order("match_id", { ascending: true }).order("hand_idx", { ascending: true }),
      ]);

      if (matchErr) throw matchErr;
      if (handErr) throw handErr;

      hydrateFromRemote(matchRows || [], handRows || []);
      setSyncStatus("Live: Supabase");
      return { matchRows: matchRows || [], handRows: handRows || [] };
    } catch (err) {
      console.error("Refresh from Supabase failed:", err);
      setSyncStatus("Local fallback");
      maybeHydrateLatest();
      return null;
    }
  };

  const saveMatchBundleToSupabase = async (nextMatch, nextAppName = appName) => {
    isPushingRef.current = true;
    try {
      const matchRow = matchToRow(nextMatch, teamById, playerById, nextAppName);
      const { error: matchErr } = await supabase.from("matches").upsert(matchRow, { onConflict: "id" });
      if (matchErr) throw matchErr;

      const nextHandRows = (nextMatch.hands || []).map((h) => handToRow(nextMatch, h));

      if (nextHandRows.length) {
        const { error: handsErr } = await supabase
          .from("hands")
          .upsert(nextHandRows, { onConflict: "id" });
        if (handsErr) throw handsErr;
      }

      const { data: existingHands, error: existingErr } = await supabase
        .from("hands")
        .select("id, hand_idx")
        .eq("match_id", nextMatch.id);

      if (existingErr) throw existingErr;

      const nextIds = new Set(nextHandRows.map((r) => r.id));
      const staleIds = (existingHands || []).map((r) => r.id).filter((id) => !nextIds.has(id));

      if (!nextHandRows.length) {
        const { error: deleteAllErr } = await supabase.from("hands").delete().eq("match_id", nextMatch.id);
        if (deleteAllErr) throw deleteAllErr;
      } else if (staleIds.length) {
        const { error: deleteStaleErr } = await supabase.from("hands").delete().in("id", staleIds);
        if (deleteStaleErr) throw deleteStaleErr;
      }

      setSyncStatus("Live: Supabase");
    } finally {
      isPushingRef.current = false;
    }
  };

  const deleteMatchFromSupabase = async (matchId) => {
  isPushingRef.current = true;
  try {
    const { error: handsErr } = await supabase
      .from("hands")
      .delete()
      .eq("match_id", matchId);
    if (handsErr) throw handsErr;

    const { error: matchErr } = await supabase
      .from("matches")
      .delete()
      .eq("id", matchId);
    if (matchErr) throw matchErr;

    setSyncStatus("Live: Supabase");
  } finally {
    isPushingRef.current = false;
  }
};

const deleteAllSupabaseData = async () => {
  isPushingRef.current = true;
  try {
    const { error: handsErr } = await supabase.from("hands").delete().not("id", "is", null);
    if (handsErr) throw handsErr;

    const { error: matchesErr } = await supabase.from("matches").delete().not("id", "is", null);
    if (matchesErr) throw matchesErr;

    setSyncStatus("Live: Supabase");
  } finally {
    isPushingRef.current = false;
  }
};

const clearAllLocalTournamentData = () => {
  setPlayers([]);
  setTeams([]);
  setPairHistory([]);
  setMatches([]);
  setEditingPlayerId(null);
  setEditingPlayerName("");
  persistNow({
    players: [],
    teams: [],
    pairHistory: [],
    matches: [],
  });
};

  const syncMatchLocalAndRemote = async (nextMatch, nextMatches, nextAppName = appName) => {
    setMatches(nextMatches);
    persistNow({ matches: nextMatches, appName: nextAppName });
    try {
      await saveMatchBundleToSupabase(nextMatch, nextAppName);
    } catch (err) {
      console.error("Failed to save match:", err);
      alert(`Failed to save match: ${err.message || "Unknown error"}`);
    }
  };

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

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) hydrateFromPayload(JSON.parse(raw));
    } catch {}
    void refreshFromSupabase();
  }, []);

  useEffect(() => {
    const onStorage = (e) => {
      if (!e || e.key === LS_KEY) maybeHydrateLatest();
    };
    const onAppUpdated = () => maybeHydrateLatest();

    window.addEventListener("storage", onStorage);
    window.addEventListener(APP_UPDATED_EVENT, onAppUpdated);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(APP_UPDATED_EVENT, onAppUpdated);
    };
  }, []);

  useEffect(() => {
    const channel = supabase
      .channel("coinche-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "matches" }, () => {
        if (!isPushingRef.current) void refreshFromSupabase();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "hands" }, () => {
        if (!isPushingRef.current) void refreshFromSupabase();
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") setSyncStatus("Live: Supabase");
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [appName, players, teams, avoidSameTeams, pairHistory]);

  const usedPlayerIds = useMemo(() => {
    const s = new Set();
    teams.forEach((t) => (t.playerIds || []).forEach((pid) => s.add(pid)));
    return s;
  }, [teams]);

  useEffect(() => {
    const current = parseHashRoute();
    const wantedCode = (current.query.code || "").toUpperCase();
    if (!wantedCode) return;
    if (matches.some((m) => (m.code || "").toUpperCase() === wantedCode)) {
      setRoute(current);
      routeRefreshAttemptRef.current = "";
    }
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
    const wantedCode = (route.query.code || "").trim().toUpperCase();
    if (!wantedCode) return;
    if (matches.some((m) => (m.code || "").toUpperCase() === wantedCode)) return;

    let cancelled = false;
    let tries = 0;
    const routeKey = `table:${wantedCode}`;
    routeRefreshAttemptRef.current = routeKey;

    const run = async () => {
      while (!cancelled && tries < 8) {
        tries += 1;
        await refreshFromSupabase();

        const latestRaw = localStorage.getItem(LS_KEY);
        if (latestRaw) {
          try {
            const parsed = JSON.parse(latestRaw);
            const found = (parsed.matches || []).some(
              (m) => (m.code || "").toUpperCase() === wantedCode
            );
            if (found) {
              if (!cancelled) setRoute(parseHashRoute());
              return;
            }
          } catch {}
        }

        if (!cancelled) {
          await new Promise((resolve) => setTimeout(resolve, tries < 3 ? 180 : 350));
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [route.path, route.query.code, matches]);

  function openTableRoute(code) {
    const nextHash = `#/table?code=${code}`;
    persistNow();
    window.dispatchEvent(new CustomEvent(APP_UPDATED_EVENT, { detail: { code } }));
    setRoute({ path: "/table", query: { code } });
    navigateHash(nextHash);
  }

  const addPlayer = () => {
    const name = newPlayerName.trim();
    if (!name) return;
    saveField(setPlayers, "players", [...players, { id: uid("p"), name }]);
    setNewPlayerName("");
    setTimeout(() => inputRef.current?.focus?.(), 0);
  };

    const startEditPlayer = (player) => {
    setEditingPlayerId(player.id);
    setEditingPlayerName(player.name || "");
  };

const cancelEditPlayer = () => {
  setEditingPlayerId(null);
  setEditingPlayerName("");
};

const saveEditPlayer = () => {
  const name = editingPlayerName.trim();
  if (!name || !editingPlayerId) return;

  const nextPlayers = players.map((p) =>
    p.id === editingPlayerId ? { ...p, name } : p
  );

  setPlayers(nextPlayers);
  persistNow({ players: nextPlayers });

  setEditingPlayerId(null);
  setEditingPlayerName("");
};

const removePlayer = async (id) => {
  const playerName = players.find((p) => p.id === id)?.name || "this player";
  if (
    !window.confirm(
      `Are you sure you want to remove ${playerName}? This will also reset teams, pair history, matches, and remote live data.`
    )
  ) {
    return;
  }

  try {
    await deleteAllSupabaseData();

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

    if (editingPlayerId === id) {
      setEditingPlayerId(null);
      setEditingPlayerName("");
    }
  } catch (err) {
    console.error("Remove player failed:", err);
    alert(`Remove player failed: ${err.message || "Unknown error"}`);
  }
};

  const addTeam = () =>
    saveField(setTeams, "teams", [
      ...teams,
      {
        id: uid("t"),
        name: (newTeamName || "").trim() || `Team ${teams.length + 1}`,
        playerIds: [],
        locked: false,
      },
    ]);

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

    const removeTeam = async (teamId) => {
  const teamName = teams.find((t) => t.id === teamId)?.name || "this team";
  if (
    !window.confirm(
      `Are you sure you want to remove ${teamName}? This will also reset matches and remote live data.`
    )
  ) {
    return;
  }

  try {
    await deleteAllSupabaseData();

    const nextTeams = teams.filter((t) => t.id !== teamId);
    setTeams(nextTeams);
    setPairHistory([]);
    setMatches([]);
    persistNow({
      teams: nextTeams,
      pairHistory: [],
      matches: [],
    });
  } catch (err) {
    console.error("Remove team failed:", err);
    alert(`Remove team failed: ${err.message || "Unknown error"}`);
  }
};

  const toggleTeamLock = (teamId, locked) =>
    saveField(
      setTeams,
      "teams",
      teams.map((t) => (t.id === teamId ? { ...t, locked: Boolean(locked) } : t))
    );

  function setTeamPlayer(teamId, slotIdx, value) {
    saveField(
      setTeams,
      "teams",
      teams.map((t) => {
        if (t.id !== teamId) return t;
        const ids = [...(t.playerIds || [])];
        while (ids.length < 2) ids.push("");
        ids[slotIdx] = value;
        if (ids[0] && ids[0] === ids[1]) ids[slotIdx === 0 ? 1 : 0] = "";
        return { ...t, playerIds: ids.filter(Boolean) };
      })
    );
  }

  const renameTeam = (teamId, name) =>
    saveField(
      setTeams,
      "teams",
      teams.map((t) => (t.id === teamId ? { ...t, name } : t))
    );

async function buildRandomTeams() {
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
    for (let i = 0; i < shuffled.length; i += 2) {
      pairs.push([shuffled[i], shuffled[i + 1] || null]);
    }

    const repeats = pairs.reduce((acc, [a, b]) => {
      if (!a || !b) return acc;
      return acc + (historySet.has([a, b].sort().join("|")) ? 1 : 0);
    }, 0);

    if (!best || repeats < best.repeats) best = { pairs, repeats };
    if (best?.repeats === 0) break;
  }

let pairIdx = 0;
const nextTeams = teams.map((t) =>
  t.locked
    ? t
    : { ...t, playerIds: (best?.pairs?.[pairIdx++] || []).filter(Boolean) }
);

  const nextPairHistory = Array.from(
    new Set([
      ...pairHistory,
      ...nextTeams
        .filter((t) => (t.playerIds || []).length === 2)
        .map((t) => [...t.playerIds].sort().join("|")),
    ])
  );

  try {
    await deleteAllSupabaseData();

    setTeams(nextTeams);
    setPairHistory(nextPairHistory);
    setMatches([]);
    persistNow({
      teams: nextTeams,
      pairHistory: nextPairHistory,
      matches: [],
    });
  } catch (err) {
    console.error("Randomize teams failed:", err);
    alert(`Randomize teams failed: ${err.message || "Unknown error"}`);
  }
}

  const addMatch = async () => {
    if (!teams.length) return;
    const nextMatch = recomputeMatch(
      makeEmptyMatch({
        tableName: newTableName.trim() || `Table ${matches.length + 1}`,
        label: newMatchLabel.trim() || `Match ${matches.length + 1}`,
      })
    );
    const nextMatches = [...matches, nextMatch];
    await syncMatchLocalAndRemote(nextMatch, nextMatches);
  };

  const removeMatch = async (matchId) => {
    const nextMatches = matches.filter((m) => m.id !== matchId);
    setMatches(nextMatches);
    persistNow({ matches: nextMatches });
    try {
      await deleteMatchFromSupabase(matchId);
    } catch (err) {
      console.error("Failed to delete match:", err);
      alert(`Failed to delete match: ${err.message || "Unknown error"}`);
    }
  };

  const setMatchTeam = async (matchId, side, value) => {
    const nextMatches = matches.map((m) =>
      m.id === matchId ? resetMatchState({ ...m, [side]: value || null }) : m
    );
    const nextMatch = nextMatches.find((m) => m.id === matchId);
    await syncMatchLocalAndRemote(nextMatch, nextMatches);
  };

  const renameMatch = async (matchId, patch) => {
    const nextMatches = matches.map((m) =>
      m.id === matchId ? { ...m, ...patch, lastUpdatedAt: Date.now() } : m
    );
    const nextMatch = nextMatches.find((m) => m.id === matchId);
    await syncMatchLocalAndRemote(nextMatch, nextMatches);
  };

  const updateTableSetup = (matchId, patch) => renameMatch(matchId, patch);

  const finishMatchNow = async (matchId) => {
    const nextMatches = matches.map((m) => {
      if (m.id !== matchId) return m;
      const a = Number(m.totalA) || 0;
      const b = Number(m.totalB) || 0;
      return {
        ...m,
        forcedComplete: true,
        completed: true,
        winnerId: a === b ? null : a > b ? m.teamAId : m.teamBId,
        lastUpdatedAt: Date.now(),
      };
    });
    const nextMatch = nextMatches.find((m) => m.id === matchId);
    await syncMatchLocalAndRemote(nextMatch, nextMatches);
  };

  // local-only draft updates to prevent typing glitch during realtime sync
  const updateDraft = (matchId, patch) => {
    const nextMatches = matches.map((m) =>
      m.id === matchId
        ? {
            ...m,
            fastDraft: { ...(m.fastDraft || defaultFastDraft()), ...patch },
            lastUpdatedAt: Date.now(),
          }
        : m
    );
    setMatches(nextMatches);
    persistNow({ matches: nextMatches });
  };

  async function startEditHand(matchId, handIdx) {
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
          skippedHand: Boolean(d.skippedHand),
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
    const nextMatch = nextMatches.find((m) => m.id === matchId);
    await syncMatchLocalAndRemote(nextMatch, nextMatches);
  }

  const cancelEditHand = async (matchId) => {
    const nextMatches = matches.map((m) =>
      m.id === matchId ? { ...m, editingHandIdx: null, fastDraft: defaultFastDraft() } : m
    );
    const nextMatch = nextMatches.find((m) => m.id === matchId);
    await syncMatchLocalAndRemote(nextMatch, nextMatches);
  };

  async function addOrSaveHand(matchId) {
    if (handSaveLocksRef.current.has(matchId)) return;
    handSaveLocksRef.current.add(matchId);

    try {
      const nextMatches = matches.map((m) => {
        if (m.id !== matchId) return m;

        const d = m.fastDraft || defaultFastDraft();
        const canPlay = !!m.teamAId && !!m.teamBId;
        const setupReady =
          canPlay &&
          Array.isArray(m.tableOrderPlayerIds) &&
          m.tableOrderPlayerIds.length === 4 &&
          !!m.firstShufflerPlayerId;

        if (!setupReady) return m;

        const bidVal = parseBidValue(d.bid);
        if (bidVal === null) return m;

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

        if (trickVal === null) return m;
        trickVal = clamp(trickVal, 0, 162);

        const announceA = sumAnnounces(d, "A");
        const announceB = sumAnnounces(d, "B");
        const dealer = getCurrentDealerInfo(m, playerById);
        const playersA = getTeamPlayers(teamById.get(m.teamAId), playerById);
        const playersB = getTeamPlayers(teamById.get(m.teamBId), playerById);

        const capotFlag = Boolean(d.capot);

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
          skippedHand: false,
          bidderTrickPoints: trickVal,
          nonBidderTrickPoints:
            d.trickSource === "NON"
              ? clamp(nonBidderTP ?? (162 - trickVal), 0, 162)
              : clamp(162 - trickVal, 0, 162),
          trickSource: d.trickSource || (nonBidderTP !== null ? "NON" : "BIDDER"),
          announceA1: num(d.announceA1),
          announceA1PlayerId: d.announceA1PlayerId || "",
          announceA1PlayerName: playersA.find((p) => p.id === d.announceA1PlayerId)?.name || "",
          announceA2: num(d.announceA2),
          announceA2PlayerId: d.announceA2PlayerId || "",
          announceA2PlayerName: playersA.find((p) => p.id === d.announceA2PlayerId)?.name || "",
          announceB1: num(d.announceB1),
          announceB1PlayerId: d.announceB1PlayerId || "",
          announceB1PlayerName: playersB.find((p) => p.id === d.announceB1PlayerId)?.name || "",
          announceB2: num(d.announceB2),
          announceB2PlayerId: d.announceB2PlayerId || "",
          announceB2PlayerName: playersB.find((p) => p.id === d.announceB2PlayerId)?.name || "",
          announceA,
          announceB,
          beloteTeam: d.beloteTeam || "NONE",
          shufflerPlayerId: dealer.playerId,
          shufflerName: dealer.name,
        };

        if (m.editingHandIdx) {
          return recomputeMatch({
            ...m,
            hands: (m.hands || []).map((h) =>
              h.idx !== m.editingHandIdx
                ? h
                : {
                    ...h,
                    draftSnapshot: snap,
                    scoreA: res.scoreA,
                    scoreB: res.scoreB,
                    bidderSucceeded: res.bidderSucceeded,
                    editedAt: Date.now(),
                  }
            ),
            fastDraft: defaultFastDraft(),
            editingHandIdx: null,
          });
        }

        if (recomputeMatch(m).completed) return recomputeMatch(m);

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

      const nextMatch = nextMatches.find((m) => m.id === matchId);
      await syncMatchLocalAndRemote(nextMatch, nextMatches);
    } finally {
      setTimeout(() => {
        handSaveLocksRef.current.delete(matchId);
      }, 250);
    }
  }

  async function skipHandNoPoints(matchId) {
    const lockKey = `${matchId}__skip`;
    if (handSaveLocksRef.current.has(lockKey) || handSaveLocksRef.current.has(matchId)) return;
    handSaveLocksRef.current.add(lockKey);

    try {
      const nextMatches = matches.map((m) => {
        if (m.id !== matchId) return m;

        const canPlay = !!m.teamAId && !!m.teamBId;
        const setupReady =
          canPlay &&
          Array.isArray(m.tableOrderPlayerIds) &&
          m.tableOrderPlayerIds.length === 4 &&
          !!m.firstShufflerPlayerId;

        if (!setupReady) return m;
        if (recomputeMatch(m).completed) return recomputeMatch(m);

        const dealer = getCurrentDealerInfo(m, playerById);

        const nextHand = {
          idx: (m.hands?.length || 0) + 1,
          createdAt: Date.now(),
          draftSnapshot: {
            ...defaultFastDraft(),
            bid: "SKIP",
            trickSource: "SKIP",
            skippedHand: true,
            shufflerPlayerId: dealer.playerId,
            shufflerName: dealer.name,
          },
          scoreA: 0,
          scoreB: 0,
          bidderSucceeded: false,
        };

        return recomputeMatch({
          ...m,
          hands: [...(m.hands || []), nextHand],
          fastDraft: defaultFastDraft(),
          editingHandIdx: null,
        });
      });

      const nextMatch = nextMatches.find((m) => m.id === matchId);
      await syncMatchLocalAndRemote(nextMatch, nextMatches);
    } finally {
      setTimeout(() => {
        handSaveLocksRef.current.delete(lockKey);
      }, 250);
    }
  }

  const clearMatchHands = async (matchId) => {
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
    const nextMatch = nextMatches.find((m) => m.id === matchId);
    await syncMatchLocalAndRemote(nextMatch, nextMatches);
  };

  const scoreboardRows = useMemo(() => {
    const rows = teams.map((t) => ({
      teamId: t.id,
      name: t.name,
      matchesPlayed: 0,
      wins: 0,
      losses: 0,
      standingPoints: 0,
      pointsFor: 0,
      pointsAgainst: 0,
    }));

    const byId = new Map(rows.map((r) => [r.teamId, r]));

    for (const m of matches) {
      if (!m.teamAId || !m.teamBId) continue;

      if (!byId.has(m.teamAId)) {
        byId.set(m.teamAId, {
          teamId: m.teamAId,
          name: teamById.get(m.teamAId)?.name || "Team A",
          matchesPlayed: 0,
          wins: 0,
          losses: 0,
          standingPoints: 0,
          pointsFor: 0,
          pointsAgainst: 0,
        });
      }

      if (!byId.has(m.teamBId)) {
        byId.set(m.teamBId, {
          teamId: m.teamBId,
          name: teamById.get(m.teamBId)?.name || "Team B",
          matchesPlayed: 0,
          wins: 0,
          losses: 0,
          standingPoints: 0,
          pointsFor: 0,
          pointsAgainst: 0,
        });
      }

      const a = byId.get(m.teamAId);
      const b = byId.get(m.teamBId);

      const totalA = Number(m.totalA) || 0;
      const totalB = Number(m.totalB) || 0;
      const hasHands = (m.hands || []).length > 0;

      a.pointsFor += totalA;
      a.pointsAgainst += totalB;
      b.pointsFor += totalB;
      b.pointsAgainst += totalA;

      if (hasHands) {
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

      if (m.completed && m.winnerId) {
        const winnerReachedTarget =
          totalA >= TARGET_SCORE || totalB >= TARGET_SCORE;

        const awardedPoints = winnerReachedTarget ? 2 : 1;

        if (m.winnerId === m.teamAId) {
          a.standingPoints += awardedPoints;
        } else if (m.winnerId === m.teamBId) {
          b.standingPoints += awardedPoints;
        }
      }
    }

    return Array.from(byId.values()).sort((x, y) => {
      if (y.standingPoints !== x.standingPoints) {
        return y.standingPoints - x.standingPoints;
      }
      if (y.wins !== x.wins) return y.wins - x.wins;

      const dx = x.pointsFor - x.pointsAgainst;
      const dy = y.pointsFor - y.pointsAgainst;
      if (dy !== dx) return dy - dx;

      if (y.pointsFor !== x.pointsFor) return y.pointsFor - x.pointsFor;
      return x.name.localeCompare(y.name);
    });
  }, [teams, matches, teamById]);

  const teamStatsRows = useMemo(() => {
  const rows = new Map();

  const ensureRow = (teamId) => {
    if (!teamId) return null;
    if (!rows.has(teamId)) {
      rows.set(teamId, {
        teamId,
        name: teamById.get(teamId)?.name || "Team",
        totalPoints: 0,
        totalPointsAllowed: 0,
        handsPlayed: 0,
        matchesPlayed: 0,
        bidsMade: 0,
        bidsWon: 0,
        coinchesCalled: 0,
        coinchesWon: 0,
        totalAnnouncePoints: 0,
        capotsMade: 0,
        comebackWins: 0,
        shutoutHandsForced: 0,
        bestSingleHand: 0,
        worstSingleHand: null,
      });
    }
    return rows.get(teamId);
  };

  const completedMatches = matches.filter((m) => m.completed && m.teamAId && m.teamBId);

  for (const m of matches) {
    if (!m.teamAId || !m.teamBId) continue;

    const a = ensureRow(m.teamAId);
    const b = ensureRow(m.teamBId);

    a.totalPoints += Number(m.totalA) || 0;
    a.totalPointsAllowed += Number(m.totalB) || 0;
    b.totalPoints += Number(m.totalB) || 0;
    b.totalPointsAllowed += Number(m.totalA) || 0;

    if ((m.hands || []).length) {
      a.matchesPlayed += 1;
      b.matchesPlayed += 1;
    }

    for (const h of m.hands || []) {
      const d = h.draftSnapshot || {};

      const scoreA = Number(h.scoreA) || 0;
      const scoreB = Number(h.scoreB) || 0;

      a.handsPlayed += 1;
      b.handsPlayed += 1;

      if (scoreA > a.bestSingleHand) a.bestSingleHand = scoreA;
      if (scoreB > b.bestSingleHand) b.bestSingleHand = scoreB;

      if (a.worstSingleHand === null || scoreA < a.worstSingleHand) a.worstSingleHand = scoreA;
      if (b.worstSingleHand === null || scoreB < b.worstSingleHand) b.worstSingleHand = scoreB;

      if (scoreA > 0 && scoreB === 0) a.shutoutHandsForced += 1;
      if (scoreB > 0 && scoreA === 0) b.shutoutHandsForced += 1;

      const announceA = Number(d.announceA) || 0;
      const announceB = Number(d.announceB) || 0;
      a.totalAnnouncePoints += announceA;
      b.totalAnnouncePoints += announceB;

      const bidderTeamId = d.bidder === "A" ? m.teamAId : m.teamBId;
      const bidderRow = ensureRow(bidderTeamId);

      if (!d.skippedHand && d.bid !== "SKIP" && d.bid !== "" && d.bid != null) {
        bidderRow.bidsMade += 1;
        if (h.bidderSucceeded) bidderRow.bidsWon += 1;
      }

      if (d.coincheLevel === "COINCHE" || d.coincheLevel === "SURCOINCHE") {
        bidderRow.coinchesCalled += 1;
        if (h.bidderSucceeded) bidderRow.coinchesWon += 1;
      }

      if (d.capot) {
        bidderRow.capotsMade += 1;
      }
    }
  }

  for (const m of completedMatches) {
    const diffs = m.timelineDiffs || [];
    if (!diffs.length || !m.winnerId) continue;

    if (m.winnerId === m.teamAId) {
      const trailedBy = Math.abs(Math.min(0, ...diffs));
      if (trailedBy > 0) {
        ensureRow(m.teamAId).comebackWins += 1;
      }
    } else if (m.winnerId === m.teamBId) {
      const trailedBy = Math.max(0, ...diffs);
      if (trailedBy > 0) {
        ensureRow(m.teamBId).comebackWins += 1;
      }
    }
  }

  return Array.from(rows.values())
    .map((r) => ({
      ...r,
      avgPointsPerHand: r.handsPlayed ? Number((r.totalPoints / r.handsPlayed).toFixed(1)) : 0,
      avgPointsPerMatch: r.matchesPlayed ? Number((r.totalPoints / r.matchesPlayed).toFixed(1)) : 0,
      avgPointsAllowedPerHand: r.handsPlayed
        ? Number((r.totalPointsAllowed / r.handsPlayed).toFixed(1))
        : 0,
      bidSuccessPct: r.bidsMade ? Number(((r.bidsWon / r.bidsMade) * 100).toFixed(1)) : 0,
      coincheSuccessPct: r.coinchesCalled
        ? Number(((r.coinchesWon / r.coinchesCalled) * 100).toFixed(1))
        : 0,
      worstSingleHand: r.worstSingleHand ?? 0,
    }))
    .sort((a, b) => {
      if (b.avgPointsPerMatch !== a.avgPointsPerMatch) {
        return b.avgPointsPerMatch - a.avgPointsPerMatch;
      }
      return a.name.localeCompare(b.name);
    });
}, [matches, teamById]);

  const funStats = useMemo(() => {
    const completed = matches.filter((m) => m.completed && m.teamAId && m.teamBId);

    const labelFor = (m) =>
      `${teamById.get(m.teamAId)?.name ?? "Team A"} vs ${
        teamById.get(m.teamBId)?.name ?? "Team B"
      } (${m.label})`;

    const handLabelFor = (m, h) =>
      `${labelFor(m)} • Hand ${h.idx}`;

    let biggestBlowout = { diff: 0, label: "—" };
    let closest = { diff: Infinity, label: "—" };
    let bestComeback = { deficit: 0, label: "—" };
    let clutchFinish = { diff: Infinity, label: "—" };
    let momentumMonster = { swing: 0, label: "—" };
    let mostPointsGame = { points: 0, label: "—" };
    let leastPointsGame = { points: Infinity, label: "—" };

    let highestScoringHand = { points: 0, label: "—" };
    let lowestScoringHand = { points: Infinity, label: "—" };
    let averageScorePerHand = { value: 0, label: "—" };
    let bestSuccessfulBidRateTeam = { pct: 0, name: "—", made: 0, total: 0 };
    let bestCoincheRateTeam = { pct: 0, name: "—", made: 0, total: 0 };

    const defenseCounts = new Map();
    const teamFun = new Map();
    const announceCountByPlayer = new Map();
    const announceTotalByPlayer = new Map();
    const teamStatMap = new Map();
    const playerCapotCounts = new Map();

    const ensureTeamStats = (tid) => {
      if (!tid) return null;
      if (!teamStatMap.has(tid)) {
        teamStatMap.set(tid, {
          bidsMade: 0,
          bidsWon: 0,
          coinchesCalled: 0,
          coinchesWon: 0,
          capots: 0,
          totalHandPoints: 0,
          handsCount: 0,
          longestWinStreak: 0,
          currentWinStreak: 0,
        });
      }
      return teamStatMap.get(tid);
    };

    const bumpFun = (tid, key, n = 1) => {
      if (!tid) return;
      const cur = teamFun.get(tid) || {
        coinches: 0,
        surcoinches: 0,
        capots: 0,
        belotes: 0,
      };
      cur[key] = (cur[key] || 0) + n;
      teamFun.set(tid, cur);
    };

    for (const m of completed) {
      const totalA = Number(m.totalA) || 0;
      const totalB = Number(m.totalB) || 0;
      const combinedPoints = totalA + totalB;
const highestTeamScore = Math.max(totalA, totalB);
const lowestTeamScore = Math.min(totalA, totalB);
const diff = Math.abs(totalA - totalB);

if (diff > biggestBlowout.diff) {
  biggestBlowout = { diff, label: labelFor(m) };
}

if (diff > 0 && diff < closest.diff) {
  closest = { diff, label: labelFor(m) };
}

if (highestTeamScore > mostPointsGame.points) {
  mostPointsGame = { points: highestTeamScore, label: labelFor(m) };
}

if (lowestTeamScore < leastPointsGame.points) {
  leastPointsGame = { points: lowestTeamScore, label: labelFor(m) };
}

      const diffs = m.timelineDiffs || [];
      if (diffs.length) {
        const comebackSize = Math.abs(
          m.winnerId === m.teamAId ? Math.min(0, ...diffs) : Math.max(0, ...diffs)
        );

        if (comebackSize > bestComeback.deficit) {
          bestComeback = { deficit: comebackSize, label: labelFor(m) };
        }

        for (let i = Math.max(0, diffs.length - 3); i < diffs.length; i++) {
          const absDiff = Math.abs(diffs[i]);
          if (absDiff < clutchFinish.diff) {
            clutchFinish = { diff: absDiff, label: labelFor(m) };
          }
        }
      }

      const teamAStats = ensureTeamStats(m.teamAId);
      const teamBStats = ensureTeamStats(m.teamBId);

      for (const h of m.hands || []) {
        const d = h.draftSnapshot || {};
        const handTotal = (Number(h.scoreA) || 0) + (Number(h.scoreB) || 0);

        if (handTotal > highestScoringHand.points) {
          highestScoringHand = { points: handTotal, label: handLabelFor(m, h) };
        }

        if (handTotal < lowestScoringHand.points) {
          lowestScoringHand = { points: handTotal, label: handLabelFor(m, h) };
        }

        teamAStats.totalHandPoints += Number(h.scoreA) || 0;
        teamAStats.handsCount += 1;
        teamBStats.totalHandPoints += Number(h.scoreB) || 0;
        teamBStats.handsCount += 1;

        const handWinner =
          (Number(h.scoreA) || 0) === (Number(h.scoreB) || 0)
            ? null
            : (Number(h.scoreA) || 0) > (Number(h.scoreB) || 0)
            ? "A"
            : "B";

        if (handWinner === "A") {
          teamAStats.currentWinStreak += 1;
          teamAStats.longestWinStreak = Math.max(
            teamAStats.longestWinStreak,
            teamAStats.currentWinStreak
          );
          teamBStats.currentWinStreak = 0;
        } else if (handWinner === "B") {
          teamBStats.currentWinStreak += 1;
          teamBStats.longestWinStreak = Math.max(
            teamBStats.longestWinStreak,
            teamBStats.currentWinStreak
          );
          teamAStats.currentWinStreak = 0;
        } else {
          teamAStats.currentWinStreak = 0;
          teamBStats.currentWinStreak = 0;
        }

        const bidderTeamId = d.bidder === "A" ? m.teamAId : m.teamBId;
        const bidderStats = ensureTeamStats(bidderTeamId);

        if (!d.skippedHand && d.bid !== "SKIP") {
          bidderStats.bidsMade += 1;
          if (h.bidderSucceeded) bidderStats.bidsWon += 1;
        }

        if (d.coincheLevel === "COINCHE" || d.coincheLevel === "SURCOINCHE") {
          bidderStats.coinchesCalled += 1;
          if (h.bidderSucceeded) bidderStats.coinchesWon += 1;
        }

        if ((Number(h.scoreA) || 0) > 0 && (Number(h.scoreB) || 0) === 0) {
          defenseCounts.set(m.teamAId, (defenseCounts.get(m.teamAId) || 0) + 1);
        }
        if ((Number(h.scoreB) || 0) > 0 && (Number(h.scoreA) || 0) === 0) {
          defenseCounts.set(m.teamBId, (defenseCounts.get(m.teamBId) || 0) + 1);
        }

        if (d.coincheLevel === "COINCHE") bumpFun(bidderTeamId, "coinches");
        if (d.coincheLevel === "SURCOINCHE") bumpFun(bidderTeamId, "surcoinches");
        if (d.capot) {
          bumpFun(bidderTeamId, "capots");
          bidderStats.capots += 1;

          const capotPlayers =
            d.bidder === "A"
              ? (teamById.get(m.teamAId)?.playerIds || [])
              : (teamById.get(m.teamBId)?.playerIds || []);

          capotPlayers.forEach((pid) => {
            playerCapotCounts.set(pid, (playerCapotCounts.get(pid) || 0) + 1);
          });
        }
        if (d.beloteTeam === "A") bumpFun(m.teamAId, "belotes");
        if (d.beloteTeam === "B") bumpFun(m.teamBId, "belotes");

        [
          [d.announceA1PlayerId, d.announceA1],
          [d.announceA2PlayerId, d.announceA2],
          [d.announceB1PlayerId, d.announceB1],
          [d.announceB2PlayerId, d.announceB2],
        ].forEach(([pid, val]) => {
          const pts = Number(val) || 0;
          if (!pid || pts <= 0) return;
          announceCountByPlayer.set(pid, (announceCountByPlayer.get(pid) || 0) + 1);
          announceTotalByPlayer.set(pid, (announceTotalByPlayer.get(pid) || 0) + pts);
        });
      }
    }

    for (const m of matches.filter((x) => x.teamAId && x.teamBId)) {
      const diffs = m.timelineDiffs || [];
      for (let i = 2; i < diffs.length; i++) {
        const swing = Math.abs(diffs[i] - diffs[i - 2]);
        if (swing > momentumMonster.swing) {
          momentumMonster = { swing, label: labelFor(m) };
        }
      }
    }

    if (!Number.isFinite(closest.diff)) {
      closest = { diff: 0, label: "—" };
    }

    if (!Number.isFinite(clutchFinish.diff)) {
      clutchFinish = { diff: 0, label: "—" };
    }

    if (!Number.isFinite(leastPointsGame.points)) {
      leastPointsGame = { points: 0, label: "—" };
    }

    if (!Number.isFinite(lowestScoringHand.points)) {
      lowestScoringHand = { points: 0, label: "—" };
    }

    let perfectDefense = { name: "—", count: 0 };
    for (const [tid, count] of defenseCounts.entries()) {
      if (count > perfectDefense.count) {
        perfectDefense = { name: teamById.get(tid)?.name ?? "—", count };
      }
    }

    const leader = (key) => {
      let best = null;
      for (const [tid, obj] of teamFun.entries()) {
        const v = obj[key] || 0;
        if (!best || v > best.v) best = { tid, v };
      }
      return !best || best.v === 0
        ? { name: "—", v: 0 }
        : { name: teamById.get(best.tid)?.name ?? "—", v: best.v };
    };

    let mostAnnounces = { name: "—", v: 0 };
    let highestAnnounces = { name: "—", v: 0 };
    let longestHandWinStreak = { name: "—", streak: 0 };
    let capotCountByTeam = { name: "—", v: 0 };
    let capotCountByPlayer = { name: "—", v: 0 };

    for (const [pid, v] of announceCountByPlayer.entries()) {
      if (v > mostAnnounces.v) {
        mostAnnounces = { name: playerById.get(pid)?.name ?? "—", v };
      }
    }

    for (const [pid, v] of announceTotalByPlayer.entries()) {
      if (v > highestAnnounces.v) {
        highestAnnounces = { name: playerById.get(pid)?.name ?? "—", v };
      }
    }

    for (const [tid, stats] of teamStatMap.entries()) {
      const teamName = teamById.get(tid)?.name ?? "—";

      const avg = stats.handsCount
        ? Number((stats.totalHandPoints / stats.handsCount).toFixed(1))
        : 0;

      if (avg > averageScorePerHand.value) {
        averageScorePerHand = { value: avg, label: teamName };
      }

      const bidPct = stats.bidsMade
        ? Number(((stats.bidsWon / stats.bidsMade) * 100).toFixed(1))
        : 0;

      if (
        stats.bidsMade > 0 &&
        (bidPct > bestSuccessfulBidRateTeam.pct ||
          (bidPct === bestSuccessfulBidRateTeam.pct &&
            stats.bidsWon > bestSuccessfulBidRateTeam.made))
      ) {
        bestSuccessfulBidRateTeam = {
          pct: bidPct,
          name: teamName,
          made: stats.bidsWon,
          total: stats.bidsMade,
        };
      }

      const coinchePct = stats.coinchesCalled
        ? Number(((stats.coinchesWon / stats.coinchesCalled) * 100).toFixed(1))
        : 0;

      if (
        stats.coinchesCalled > 0 &&
        (coinchePct > bestCoincheRateTeam.pct ||
          (coinchePct === bestCoincheRateTeam.pct &&
            stats.coinchesWon > bestCoincheRateTeam.made))
      ) {
        bestCoincheRateTeam = {
          pct: coinchePct,
          name: teamName,
          made: stats.coinchesWon,
          total: stats.coinchesCalled,
        };
      }

      if (stats.longestWinStreak > longestHandWinStreak.streak) {
        longestHandWinStreak = {
          name: teamName,
          streak: stats.longestWinStreak,
        };
      }

      if (stats.capots > capotCountByTeam.v) {
        capotCountByTeam = { name: teamName, v: stats.capots };
      }
    }

    for (const [pid, count] of playerCapotCounts.entries()) {
      if (count > capotCountByPlayer.v) {
        capotCountByPlayer = {
          name: playerById.get(pid)?.name ?? "—",
          v: count,
        };
      }
    }

    return {
      biggestBlowout,
      bestComeback,
      closest,
      clutchFinish,
      momentumMonster,
      mostPointsGame,
      leastPointsGame,
      highestScoringHand,
      lowestScoringHand,
      averageScorePerHand,
      bestSuccessfulBidRateTeam,
      bestCoincheRateTeam,
      longestHandWinStreak,
      capotCountByTeam,
      capotCountByPlayer,
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

    const direct = matches.find((m) => (m.code || "").toUpperCase() === code);
    if (direct) return direct;

    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return (parsed.matches || []).find((m) => (m.code || "").toUpperCase() === code) || null;
    } catch {
      return null;
    }
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
      <span style={styles.tag}>{syncStatus}</span>
    </div>
  );

if (path === "/public") {
const liveMatches = matches
  .filter((m) => m.teamAId && m.teamBId && !m.completed)
  .sort((a, b) => (b.lastUpdatedAt || 0) - (a.lastUpdatedAt || 0));

const completedMatchRecaps = matches
  .filter((m) => m.teamAId && m.teamBId && m.completed)
  .sort(compareMatchesByTournamentOrder);

  return (
    <div style={styles.page}>
      <div style={styles.container}>
        <Header
          title={appName}
          subtitle={`Public scoreboard • Live updates • Tables: ${matches.length}`}
          right={<NavPills showAdmin />}
        />

        <Section title="Live Scoreboard">
          <ScoreboardTable rows={scoreboardRows} />
        </Section>

        <Section title="Live Matches (Now Playing)">
          {!liveMatches.length ? (
            <div style={styles.small}>No matches currently in progress.</div>
          ) : (
            <div style={styles.grid3}>
              {liveMatches.map((m) => (
                <LiveMatchCard
                  key={m.id}
                  match={m}
                  teamById={teamById}
                  onOpen={() => openTableRoute(m.code)}
                />
              ))}
            </div>
          )}
        </Section>

        <Section title="Match Recaps">
  {!completedMatchRecaps.length ? (
    <div style={styles.small}>No completed matches yet.</div>
  ) : (
    <div style={styles.grid3}>
      {completedMatchRecaps.map((m) => (
        <LiveMatchCard
          key={m.id}
          match={m}
          teamById={teamById}
          hideOpenButton
          recapMode
        />
      ))}
    </div>
  )}
</Section>

        <Section title="Team Stats">
          <TeamStatsTable rows={teamStatsRows} />
        </Section>

<Section title="Tournament Highlights & Awards">
  <FunStatsGrid funStats={funStats} />
</Section>
      </div>
    </div>
  );
}

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
                onSkipHand={() => skipHandNoPoints(tableMatch.id)}
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

          <Section title="Other Tables Live Scores">
            {matches.filter((m) => m.teamAId && m.teamBId && !m.completed).length ? (
              <div style={styles.grid3}>
                {matches
                  .filter((m) => m.teamAId && m.teamBId && !m.completed)
                  .sort((a, b) => (b.lastUpdatedAt || 0) - (a.lastUpdatedAt || 0))
                  .map((m) => (
                    <LiveMatchCard
                      key={m.id}
                      match={m}
                      teamById={teamById}
                      hideOpenButton
                    />
                  ))}
              </div>
            ) : (
              <div style={styles.small}>No live matches right now.</div>
            )}
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

      <button
  style={styles.btnPrimary}
  onClick={() =>
    exportCoincheExcel({
      appName,
      matches,
      teamById,
      playerById,
      scoreboardRows,
      teamStatsRows,
      funStats,
    })
  }
  disabled={!matches.length}
>
  Export Excel
</button>
    </div>
  }
>
  <div style={styles.small}>
    Public: <span style={{ color: "#e5e7eb" }}>{publicLink}</span>
  </div>
  <div style={{ marginTop: 8, ...styles.small }}>
    Sync: <span style={{ color: "#e5e7eb" }}>{syncStatus}</span>
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
        onChange={(e) => saveField(setAvoidSameTeams, "avoidSameTeams", e.target.checked)}
      />
      Avoid repeating pairs
    </label>

    <button
      style={styles.btnSecondary}
      onClick={() => {
        void refreshFromSupabase();
      }}
    >
      Refresh Live Data
    </button>

    <button
      style={styles.btnDanger}
      onClick={async () => {
        if (
          !confirm(
            "Full reset? This will permanently delete all players, teams, matches, and hands from this device and Supabase."
          )
        ) {
          return;
        }

        try {
          await deleteAllSupabaseData();

          setAppName("Coinche Scorekeeper");
          setPlayers([]);
          setTeams([]);
          setPairHistory([]);
          setMatches([]);
          setEditingPlayerId(null);
          setEditingPlayerName("");

          persistNow({
            appName: "Coinche Scorekeeper",
            players: [],
            teams: [],
            pairHistory: [],
            matches: [],
          });
        } catch (err) {
          console.error("Full reset failed:", err);
          alert(`Full reset failed: ${err.message || "Unknown error"}`);
        }
      }}
    >
      Full Reset
    </button>
  </div>
}
        >
          <div style={styles.grid3}>
            <InfoCard title="App name">
              <input style={styles.input("100%")} value={appName} onChange={(e) => saveField(setAppName, "appName", e.target.value)} />
            </InfoCard>
            <InfoCard title="Target score">
              <div style={{ fontWeight: 950, fontSize: 18 }}>{TARGET_SCORE}</div>
              <div style={styles.small}>Match ends immediately at {TARGET_SCORE}+.</div>
            </InfoCard>
            <InfoCard title="Live storage">
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
            {players.map((p) => {
  const isEditing = editingPlayerId === p.id;

  return (
    <div key={p.id} style={styles.card}>
      <div
        style={{
          fontWeight: 950,
          display: "flex",
          justifyContent: "space-between",
          gap: 10,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        {!isEditing ? (
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
              minWidth: 0,
            }}
          >
            {p.name}
          </span>
        ) : (
          <input
            style={styles.input("100%")}
            value={editingPlayerName}
            onChange={(e) => setEditingPlayerName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveEditPlayer();
              if (e.key === "Escape") cancelEditPlayer();
            }}
            autoFocus
          />
        )}

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          {!isEditing ? (
            <>
              <button
                style={{ ...styles.btnGhost, padding: 0 }}
                onClick={() => startEditPlayer(p)}
              >
                Edit
              </button>
              <button
                style={{ ...styles.btnGhost, padding: 0 }}
                onClick={() => removePlayer(p.id)}
              >
                Remove
              </button>
            </>
          ) : (
            <>
              <button
                style={{ ...styles.btnGhost, padding: 0 }}
                onClick={saveEditPlayer}
                disabled={!editingPlayerName.trim()}
              >
                Save
              </button>
              <button
                style={{ ...styles.btnGhost, padding: 0 }}
                onClick={cancelEditPlayer}
              >
                Cancel
              </button>
            </>
          )}
        </div>
      </div>

      <div style={styles.small}>ID: {p.id.slice(-6)}</div>
    </div>
  );
})}
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
                  onSkipHand={() => skipHandNoPoints(m.id)}
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

<Section title="Team Stats (Live)" collapsible defaultCollapsed>
  <TeamStatsTable rows={teamStatsRows} />
</Section>

        <Section title="Table Links (share to each table)">
          <div style={styles.small}>Each match has a unique code + link. Teams should open their match link to enter hands.</div>
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
  const sections = [
    {
      title: "Tournament Highlights",
      items: [
        ["Biggest Blowout", `${funStats.biggestBlowout.diff} pts`, funStats.biggestBlowout.label],
        ["Best Comeback", `${funStats.bestComeback.deficit} pts`, funStats.bestComeback.label],
        ["Closest Match", `${funStats.closest.diff} pts`, funStats.closest.label],
        ["Clutch Finish (last 3 hands)", `${funStats.clutchFinish.diff} pts`, funStats.clutchFinish.label],
        [
          "Momentum Monster (biggest 3-hand swing)",
          `${funStats.momentumMonster.swing} pts`,
          funStats.momentumMonster.label,
        ],
        ["Most Points by a Team in a Match", `${funStats.mostPointsGame.points} pts`, funStats.mostPointsGame.label],
        ["Least Points by a Team in a Match", `${funStats.leastPointsGame.points} pts`, funStats.leastPointsGame.label],
        ["Highest Scoring Hand", `${funStats.highestScoringHand.points} pts`, funStats.highestScoringHand.label],
      ],
    },
    {
      title: "Team Awards",
      items: [
        ["Best Avg Score / Hand", `${funStats.averageScorePerHand.value} pts`, funStats.averageScorePerHand.label],
        [
          "Best Successful Bid %",
          `${funStats.bestSuccessfulBidRateTeam.pct}%`,
          `${funStats.bestSuccessfulBidRateTeam.name} (${funStats.bestSuccessfulBidRateTeam.made}/${funStats.bestSuccessfulBidRateTeam.total})`,
        ],
        [
          "Best Coinche Success %",
          `${funStats.bestCoincheRateTeam.pct}%`,
          `${funStats.bestCoincheRateTeam.name} (${funStats.bestCoincheRateTeam.made}/${funStats.bestCoincheRateTeam.total})`,
        ],
        [
          "Longest Hand Win Streak",
          `${funStats.longestHandWinStreak.streak} hands`,
          funStats.longestHandWinStreak.name,
        ],
        ["Capot Count by Team", funStats.capotCountByTeam.name, `${funStats.capotCountByTeam.v} capots`],
        ["Perfect Defense", funStats.perfectDefense.name, `${funStats.perfectDefense.count} shutout hands`],
        ["Coinche King", funStats.coincheKing.name, `${funStats.coincheKing.v} coinches`],
        ["Capot Hero", funStats.capotHero.name, `${funStats.capotHero.v} capots`],
        ["Belote Magnet", funStats.beloteMagnet.name, `${funStats.beloteMagnet.v} belotes`],
      ],
    },
    {
      title: "Player Awards",
      items: [
        ["Capot Count by Player", funStats.capotCountByPlayer.name, `${funStats.capotCountByPlayer.v} capots`],
        ["Most Announces", funStats.mostAnnounces.name, `${funStats.mostAnnounces.v} announces`],
        ["Highest Announces", funStats.highestAnnounces.name, `${funStats.highestAnnounces.v} pts announced`],
      ],
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {sections.map((section) => (
        <div key={section.title} style={styles.card}>
          <div
            style={{
              fontWeight: 950,
              fontSize: 15,
              marginBottom: 10,
              color: "#e5e7eb",
            }}
          >
            {section.title}
          </div>

          <div style={styles.grid3}>
            {section.items.map(([label, value, sub]) => (
              <StatCard key={label} label={label} value={value} sub={sub} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ScoreboardTable({ rows }) {
  const headers = ["Rank", "Team", "MP", "W", "L", "P", "PF", "PA", "Diff"];

  const getRankStyle = (idx) => {
    if (idx === 0) {
      return {
        background: "rgba(250,204,21,0.14)",
        boxShadow: "inset 0 0 0 1px rgba(250,204,21,0.30)",
      };
    }
    if (idx === 1) {
      return {
        background: "rgba(226,232,240,0.10)",
        boxShadow: "inset 0 0 0 1px rgba(226,232,240,0.20)",
      };
    }
    if (idx === 2) {
      return {
        background: "rgba(251,146,60,0.10)",
        boxShadow: "inset 0 0 0 1px rgba(251,146,60,0.20)",
      };
    }
    return {};
  };

  const getRankBadge = (idx) => {
    if (idx === 0) return "🥇";
    if (idx === 1) return "🥈";
    if (idx === 2) return "🥉";
    return `#${idx + 1}`;
  };

  return (
    <div style={{ overflowX: "auto" }}>
      <table
        style={{
          width: "100%",
          borderCollapse: "separate",
          borderSpacing: 0,
          minWidth: 940,
        }}
      >
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
                  whiteSpace: "nowrap",
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>

        <tbody>
          {rows.map((r, idx) => {
            const diff = (Number(r.pointsFor) || 0) - (Number(r.pointsAgainst) || 0);
            const undefeated = r.matchesPlayed > 0 && r.losses === 0;

            return (
              <tr key={r.teamId} style={getRankStyle(idx)}>
                <td style={tdStrong}>{getRankBadge(idx)}</td>

                <td style={tdBold}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span>{r.name}</span>
                    {idx === 0 ? (
                      <span
                        style={{
                          ...styles.tag,
                          background: "rgba(250,204,21,0.16)",
                          border: "1px solid rgba(250,204,21,0.28)",
                          color: "#fde68a",
                        }}
                      >
                        Leader
                      </span>
                    ) : null}
                    {undefeated ? (
                      <span
                        style={{
                          ...styles.tag,
                          background: "rgba(34,197,94,0.14)",
                          border: "1px solid rgba(34,197,94,0.28)",
                          color: "#bbf7d0",
                        }}
                      >
                        Undefeated
                      </span>
                    ) : null}
                  </div>
                </td>

                <td style={td}>{r.matchesPlayed}</td>
                <td style={td}>{r.wins}</td>
                <td style={td}>{r.losses}</td>
                <td style={tdStrong}>{r.standingPoints}</td>
                <td style={td}>{r.pointsFor}</td>
                <td style={td}>{r.pointsAgainst}</td>
                <td style={tdStrong}>{diff > 0 ? `+${diff}` : diff}</td>
              </tr>
            );
          })}

          {!rows.length && (
            <tr>
              <td colSpan={9} style={{ padding: 12, color: "#94a3b8" }}>
                No scoreboard data yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function TeamStatsTable({ rows }) {
  const headers = [
    "Team",
    "Avg Pts/Hand",
    "Avg Pts/Match",
    "Allowed Pts/Hand",
    "Bid %",
    "Coinche %",
    "Announce Pts",
    "Capots",
    "Comebacks",
    "Shutouts",
    "Best Hand",
    "Worst Hand",
  ];

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, minWidth: 1200 }}>
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
                  whiteSpace: "nowrap",
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.teamId}>
              <td style={tdBold}>{r.name}</td>
              <td style={td}>{r.avgPointsPerHand}</td>
              <td style={td}>{r.avgPointsPerMatch}</td>
              <td style={td}>{r.avgPointsAllowedPerHand}</td>
              <td style={td}>{r.bidSuccessPct}%</td>
              <td style={td}>{r.coincheSuccessPct}%</td>
              <td style={td}>{r.totalAnnouncePoints}</td>
              <td style={td}>{r.capotsMade}</td>
              <td style={td}>{r.comebackWins}</td>
              <td style={td}>{r.shutoutHandsForced}</td>
              <td style={td}>{r.bestSingleHand}</td>
              <td style={td}>{r.worstSingleHand}</td>
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={12} style={{ padding: 12, color: "#94a3b8" }}>
                No team stats yet.
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

function MatchScoreLinesChart({
  hands = [],
  teamAName = "Team A",
  teamBName = "Team B",
  colorA = "#1664d9",
  colorB = "#d90429",
  height = 170,
}) {
  if (!hands.length) {
    return <div style={styles.small}>No hand chart yet.</div>;
  }

  const width = 320;
  const padLeft = 34;
  const padRight = 12;
  const padTop = 18;
  const padBottom = 28;

  let runningA = 0;
  let runningB = 0;

  const seriesA = [{ hand: 0, score: 0 }];
  const seriesB = [{ hand: 0, score: 0 }];

  for (let i = 0; i < hands.length; i++) {
    runningA += Number(hands[i]?.scoreA) || 0;
    runningB += Number(hands[i]?.scoreB) || 0;
    seriesA.push({ hand: i + 1, score: runningA });
    seriesB.push({ hand: i + 1, score: runningB });
  }

  const allScores = [...seriesA.map((p) => p.score), ...seriesB.map((p) => p.score)];
  const maxScore = Math.max(...allScores, 1);
  const stepCount = 5;
  const graphHeight = height - padTop - padBottom;
  const graphWidth = width - padLeft - padRight;

  const yMaxRaw = maxScore;
  const yMax = Math.max(10, Math.ceil(yMaxRaw / stepCount / 10) * stepCount * 10 / stepCount * stepCount);
  const finalYMax = Math.max(yMax, Math.ceil(maxScore / 10) * 10);

  const xFor = (hand) =>
    padLeft + (hand * graphWidth) / Math.max(seriesA.length - 1, 1);

  const yFor = (score) =>
    padTop + graphHeight - (score / Math.max(finalYMax, 1)) * graphHeight;

  const toPoints = (series) =>
    series.map((p) => `${xFor(p.hand)},${yFor(p.score)}`).join(" ");

  const gridValues = Array.from({ length: stepCount + 1 }, (_, i) =>
    Math.round((finalYMax / stepCount) * i)
  );

  const leadChanges = (() => {
    let count = 0;
    for (let i = 1; i < seriesA.length; i++) {
      const prevDiff = seriesA[i - 1].score - seriesB[i - 1].score;
      const curDiff = seriesA[i].score - seriesB[i].score;
      if ((prevDiff > 0 && curDiff < 0) || (prevDiff < 0 && curDiff > 0)) count += 1;
    }
    return count;
  })();

  let biggestSwing = 0;
  let biggestSwingHand = 1;
  for (let i = 1; i < seriesA.length; i++) {
    const handTotal =
      (seriesA[i].score - seriesA[i - 1].score) +
      (seriesB[i].score - seriesB[i - 1].score);
    if (handTotal > biggestSwing) {
      biggestSwing = handTotal;
      biggestSwingHand = i;
    }
  }

  const finalPushStart = Math.max(0, seriesA.length - 3);
  const finalPushA = seriesA[seriesA.length - 1].score - seriesA[finalPushStart].score;
  const finalPushB = seriesB[seriesB.length - 1].score - seriesB[finalPushStart].score;
  const finalPushWinner = finalPushA === finalPushB ? "Tie" : finalPushA > finalPushB ? teamAName : teamBName;
  const finalPushValue = Math.max(finalPushA, finalPushB, 0);

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ ...styles.small, marginBottom: 8 }}>
        Lead changes: <span style={{ color: "#e5e7eb", fontWeight: 900 }}>{leadChanges}</span>
        {" • "}
        Biggest hand: <span style={{ color: "#e5e7eb", fontWeight: 900 }}>Hand {biggestSwingHand}</span>
        {" • "}
        Final push: <span style={{ color: "#e5e7eb", fontWeight: 900 }}>{finalPushWinner} +{finalPushValue}</span>
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{
          width: "100%",
          height,
          display: "block",
          borderRadius: 12,
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(148,163,184,0.12)",
        }}
      >
        {gridValues.map((v, idx) => {
          const y = yFor(v);
          return (
            <g key={idx}>
              <line
                x1={padLeft}
                x2={width - padRight}
                y1={y}
                y2={y}
                stroke="rgba(148,163,184,0.25)"
                strokeWidth="1"
              />
              <text
                x={padLeft - 6}
                y={y + 4}
                fontSize="10"
                textAnchor="end"
                fill="#94a3b8"
              >
                {v}
              </text>
            </g>
          );
        })}

        {seriesA.map((p, idx) => {
          if (idx === 0) return null;
          return (
            <text
              key={`x-${idx}`}
              x={xFor(p.hand)}
              y={height - 8}
              fontSize="10"
              textAnchor="middle"
              fill="#94a3b8"
            >
              H{p.hand}
            </text>
          );
        })}

        <polyline
          fill="none"
          stroke={colorA}
          strokeWidth="3"
          strokeLinejoin="round"
          strokeLinecap="round"
          points={toPoints(seriesA)}
        />
        <polyline
          fill="none"
          stroke={colorB}
          strokeWidth="3"
          strokeLinejoin="round"
          strokeLinecap="round"
          points={toPoints(seriesB)}
        />

        {seriesA.map((p, idx) => (
          <circle
            key={`a-${idx}`}
            cx={xFor(p.hand)}
            cy={yFor(p.score)}
            r={idx === biggestSwingHand ? 4.5 : 3.5}
            fill={colorA}
            stroke="#ffffff"
            strokeWidth="1.5"
          />
        ))}

        {seriesB.map((p, idx) => (
          <circle
            key={`b-${idx}`}
            cx={xFor(p.hand)}
            cy={yFor(p.score)}
            r={idx === biggestSwingHand ? 4.5 : 3.5}
            fill={colorB}
            stroke="#ffffff"
            strokeWidth="1.5"
          />
        ))}
      </svg>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              width: 12,
              height: 12,
              borderRadius: 999,
              background: colorA,
              display: "inline-block",
            }}
          />
          <span style={{ fontWeight: 900 }}>{teamAName}</span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              width: 12,
              height: 12,
              borderRadius: 999,
              background: colorB,
              display: "inline-block",
            }}
          />
          <span style={{ fontWeight: 900 }}>{teamBName}</span>
        </div>
      </div>
    </div>
  );
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

function MatchBadges({ match, teamById }) {
  const ta = teamById.get(match.teamAId)?.name ?? "Team A";
  const tb = teamById.get(match.teamBId)?.name ?? "Team B";
  const totalA = Number(match.totalA) || 0;
  const totalB = Number(match.totalB) || 0;
  const hands = match.hands || [];
  const diff = Math.abs(totalA - totalB);
  const leadingTeam = totalA === totalB ? null : totalA > totalB ? ta : tb;
  const maxScore = Math.max(totalA, totalB);
  const racePct = Math.min(100, Math.round((maxScore / TARGET_SCORE) * 100));

  const biggestHand = hands.reduce(
    (best, h) => {
      const total = (Number(h?.scoreA) || 0) + (Number(h?.scoreB) || 0);
      return total > best ? total : best;
    },
    0
  );

  const totalMatchPoints = totalA + totalB;

  let hasCoinche = false;
  let hasSurcoinche = false;
  let hasCapot = false;

  for (const h of hands) {
    const d = h?.draftSnapshot || {};
    if (d.coincheLevel === "COINCHE") hasCoinche = true;
    if (d.coincheLevel === "SURCOINCHE") hasSurcoinche = true;
    if (d.capot) hasCapot = true;
  }

  let comebackWatch = false;
  if (!match.completed && Array.isArray(match.timelineDiffs) && match.timelineDiffs.length >= 2) {
    const lastDiff = match.timelineDiffs[match.timelineDiffs.length - 1] || 0;
    const biggestTrailA = Math.abs(Math.min(0, ...match.timelineDiffs));
    const biggestTrailB = Math.max(0, ...match.timelineDiffs);

    if (lastDiff > 0 && biggestTrailA >= 150) comebackWatch = true;
    if (lastDiff < 0 && biggestTrailB >= 150) comebackWatch = true;
  }

  const badges = [];

  // Lead badge
  if (leadingTeam) {
    badges.push({
      label: `Lead: ${leadingTeam} +${diff}`,
      tone: diff >= 300 ? "success" : "neutral",
    });
  } else {
    badges.push({
      label: "Tied",
      tone: "neutral",
    });
  }

  // Finished early badge only
  if (match.completed && match.forcedComplete) {
    badges.push({
      label: "Finished Early",
      tone: "danger",
    });
  }

  // Big hand badge
  if (biggestHand > 0) {
    badges.push({
      label: `Big Hand ${biggestHand}`,
      tone: biggestHand >= 250 ? "warning" : "neutral",
    });
  }

  // Comeback badge
  if (comebackWatch) {
    badges.push({
      label: "Comeback Watch",
      tone: "warning",
    });
  }

  // Race-to-2000 badge
  badges.push({
    label: `Race ${racePct}%`,
    tone: racePct >= 85 ? "danger" : racePct >= 65 ? "warning" : "neutral",
  });

  // High scoring badge
  if (totalMatchPoints >= 2500) {
    badges.push({
      label: `High Scoring ${totalMatchPoints}`,
      tone: "success",
    });
  }

  // Coinche / Surcoinche badge
  if (hasSurcoinche) {
    badges.push({
      label: "Surcoinche",
      tone: "danger",
    });
  } else if (hasCoinche) {
    badges.push({
      label: "Coinche",
      tone: "info",
    });
  }

  // Capot badge
  if (hasCapot) {
    badges.push({
      label: "Capot",
      tone: "warning",
    });
  }

  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
      {badges.map((badge, idx) => (
        <StatusBadge key={`${badge.label}_${idx}`} tone={badge.tone}>
          {badge.label}
        </StatusBadge>
      ))}
    </div>
  );
}

function StatusBadge({ children, tone = "neutral" }) {
  const toneStyles = {
    neutral: {
      background: "rgba(148,163,184,0.14)",
      border: "1px solid rgba(148,163,184,0.24)",
      color: "#e2e8f0",
    },
    info: {
      background: "rgba(59,130,246,0.16)",
      border: "1px solid rgba(59,130,246,0.30)",
      color: "#dbeafe",
    },
    success: {
      background: "rgba(34,197,94,0.16)",
      border: "1px solid rgba(34,197,94,0.30)",
      color: "#dcfce7",
    },
    warning: {
      background: "rgba(250,204,21,0.16)",
      border: "1px solid rgba(250,204,21,0.30)",
      color: "#fef3c7",
    },
    danger: {
      background: "rgba(244,63,94,0.16)",
      border: "1px solid rgba(244,63,94,0.30)",
      color: "#ffe4e6",
    },
  };

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "6px 10px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 900,
        letterSpacing: "0.02em",
        lineHeight: 1,
        ...toneStyles[tone],
      }}
    >
      {children}
    </span>
  );
}

function LiveMatchCard({ match, teamById, onOpen, hideOpenButton = false, recapMode = false }) {
  const ta = teamById.get(match.teamAId)?.name ?? "Team A";
  const tb = teamById.get(match.teamBId)?.name ?? "Team B";
  const totalA = Number(match.totalA) || 0;
  const totalB = Number(match.totalB) || 0;
  const pctA = Math.min(100, Math.round((totalA / TARGET_SCORE) * 100));
  const pctB = Math.min(100, Math.round((totalB / TARGET_SCORE) * 100));

  const winnerSide =
    !match.completed || !match.winnerId
      ? null
      : match.winnerId === match.teamAId
      ? "A"
      : match.winnerId === match.teamBId
      ? "B"
      : null;

  const recapRowBase = {
    marginTop: 10,
    borderRadius: 14,
    padding: recapMode ? "10px 12px" : "0px",
    transition: "all 180ms ease",
  };

  const recapWinnerGlow = {
    boxShadow: "0 0 18px rgba(34,197,94,0.35), 0 0 36px rgba(34,197,94,0.16)",
    border: "1px solid rgba(34,197,94,0.45)",
    background: "rgba(34,197,94,0.10)",
  };

  const recapScoreText = {
    fontWeight: 1000,
    fontSize: 24,
    lineHeight: 1.1,
  };

  const recapNameText = {
    fontWeight: 950,
    fontSize: 18,
    lineHeight: 1.15,
  };

  return (
    <div style={styles.card}>
      <div style={{ fontWeight: 950, marginBottom: 6 }}>
        {match.label}
      </div>

      <MatchBadges match={match} teamById={teamById} />

      <div
        style={{
          ...recapRowBase,
          ...(recapMode && winnerSide === "A" ? recapWinnerGlow : {}),
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 10,
            alignItems: "center",
          }}
        >
          <span style={recapNameText}>{ta}</span>
          <span style={recapScoreText}>{totalA}</span>
        </div>
        {!recapMode && (
          <div style={{ marginTop: 6, ...styles.progressWrap }}>
            <div style={styles.progressFillA(pctA)} />
          </div>
        )}
      </div>

      <div
        style={{
          ...recapRowBase,
          ...(recapMode && winnerSide === "B" ? recapWinnerGlow : {}),
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 10,
            alignItems: "center",
          }}
        >
          <span style={recapNameText}>{tb}</span>
          <span style={recapScoreText}>{totalB}</span>
        </div>
        {!recapMode && (
          <div style={{ marginTop: 6, ...styles.progressWrap }}>
            <div style={styles.progressFillB(pctB)} />
          </div>
        )}
      </div>

      <MatchScoreLinesChart
        hands={match.hands || []}
        teamAName={ta}
        teamBName={tb}
        colorA="rgba(34,197,94,0.98)"
        colorB="rgba(99,102,241,0.98)"
      />

      {!hideOpenButton && onOpen ? (
        <div style={{ marginTop: 10 }}>
          <button type="button" style={styles.btnSecondary} onClick={onOpen}>
            Open Table
          </button>
        </div>
      ) : null}
    </div>
  );
}

function TeamCard({ team, idx, players, usedPlayerIds, playerById, onToggleLock, onRemove, onRename, onSetPlayer }) {
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
        <input
          style={styles.input("100%")}
          value={team.name}
          onChange={(e) => onRename(e.target.value)}
          placeholder={`Team ${idx + 1}`}
        />
      </div>

      <div style={{ marginTop: 10, ...styles.grid2 }}>
        {[0, 1].map((slotIdx) => (
          <div key={slotIdx}>
            <div style={styles.small}>Player {slotIdx + 1}</div>
            <select
              style={styles.select("100%")}
              value={team.playerIds?.[slotIdx] || ""}
              onChange={(e) => onSetPlayer(slotIdx, e.target.value)}
            >
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
          <button style={styles.btnSecondary} onClick={onClose}>
            Close
          </button>
        </div>

        <div style={{ padding: 12, display: "grid", gridTemplateColumns: "1fr 340px", gap: 12 }}>
          <div style={{ ...styles.card, borderRadius: 16 }}>
            {!captured ? (
              <>
                <div style={{ color: "#94a3b8", fontSize: 12, marginBottom: 8 }}>
                  Tip: lay cards flat, avoid glare, keep all cards visible. Supports scans from 4 to 32 cards.
                </div>
                <video ref={videoRef} playsInline muted style={{ width: "100%", borderRadius: 14, background: "rgba(0,0,0,0.35)", maxHeight: "62vh", objectFit: "cover" }} />
                <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <button style={styles.btnPrimary} onClick={captureFrame} disabled={!!err}>
                    Capture Photo
                  </button>
                  <button style={styles.btnSecondary} onClick={onClose}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <img src={captured} alt="Captured" style={{ width: "100%", borderRadius: 14, maxHeight: "62vh", objectFit: "contain", background: "rgba(0,0,0,0.25)" }} />
                <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <button style={styles.btnSecondary} onClick={() => setCaptured(null)} disabled={busy}>
                    Retake
                  </button>
                  <button style={styles.btnPrimary} onClick={submitToScan} disabled={busy}>
                    {busy ? "Scanning…" : "Use Photo & Calculate"}
                  </button>
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
                        <div key={i} style={{ color: "#fbbf24", fontWeight: 900, fontSize: 12 }}>
                          ⚠ {w}
                        </div>
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
                    <button style={styles.btnPrimary} onClick={applyDetectedPoints}>
                      Apply Points
                    </button>
                  </div>
                </>
              )}
            </div>

            <div style={{ marginTop: 12, ...styles.small }}>Best results come from bright light, no glare, and all cards fully visible.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

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
  onSkipHand,
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
          <button type="button" style={styles.btnSecondary} onClick={onOpenTable}>
            Open Table
          </button>
          <button type="button" style={styles.btnGhost} onClick={() => setCollapsed((v) => !v)}>
            {collapsed ? "Expand" : "Collapse"}
          </button>
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
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>

      {!collapsed && (
        <>
          <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button style={styles.btnSecondary} onClick={onCopyLink}>
              Copy Link
            </button>
            <button style={styles.btnDanger} onClick={onRemove}>
              Remove
            </button>
          </div>

          <div style={{ marginTop: 10, ...styles.card }}>
            <div style={{ fontWeight: 950, color: match.completed ? "#34d399" : "#94a3b8" }}>
              {match.completed ? `Completed • Winner: ${teamById.get(match.winnerId)?.name ?? "—"}` : "In progress"}
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
              onSkipHand={onSkipHand}
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

function TableMatchPanel({
  match,
  teamById,
  playerById,
  onTableSetupPatch,
  onDraftPatch,
  onAddHand,
  onSkipHand,
  onClearHands,
  onStartEditHand,
  onCancelEdit,
  onFinishNow,
  bigTotals = false,
}) {
  const teamA = teamById.get(match.teamAId) || null;
  const teamB = teamById.get(match.teamBId) || null;
  const ta = teamA?.name ?? "TBD";
  const tb = teamB?.name ?? "TBD";
  const playersA = getTeamPlayers(teamA, playerById);
  const playersB = getTeamPlayers(teamB, playerById);
  const allTablePlayers = [...playersA, ...playersB];

  const pctA = Math.min(100, Math.round(((match.totalA || 0) / TARGET_SCORE) * 100));
  const pctB = Math.min(100, Math.round(((match.totalB || 0) / TARGET_SCORE) * 100));

  const d = match.fastDraft || defaultFastDraft();
  const canPlay = !!match.teamAId && !!match.teamBId;
  const setupReady =
    canPlay &&
    Array.isArray(match.tableOrderPlayerIds) &&
    match.tableOrderPlayerIds.length === 4 &&
    !!match.firstShufflerPlayerId;

  const leader = match.totalA === match.totalB ? null : match.totalA > match.totalB ? "A" : "B";
  const winnerSide =
    !match.completed || !match.winnerId
      ? null
      : match.winnerId === match.teamAId
      ? "A"
      : match.winnerId === match.teamBId
      ? "B"
      : null;

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

  const suitLabel = d.suit === "H" ? "Hearts" : d.suit === "D" ? "Diamonds" : d.suit === "C" ? "Clubs" : "Spades";
  const fieldLabelStyle = { fontSize: 18, color: "#cbd5e1", fontWeight: 950, marginBottom: 6 };
  const handInput = { ...styles.input("100%"), padding: "8px 10px" };
  const handSelect = { ...styles.select("100%"), padding: "8px 10px" };

  const currentDealer = getCurrentDealerInfo(match, playerById);
  const seatOrderIds = match.tableOrderPlayerIds || [];
  const seatOrderPlayers = seatOrderIds
    .map((pid) => ({ id: pid, name: playerById.get(pid)?.name || "" }))
    .filter((p) => p.name);
  const seatOrderNames = seatOrderPlayers.map((p) => p.name);

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
                <input
                  style={handInput}
                  value={d[amountKey]}
                  onChange={(e) => onDraftPatch({ [amountKey]: e.target.value })}
                  inputMode="numeric"
                  disabled={!setupReady}
                />
              </div>
              <div>
                <div style={styles.small}>Player</div>
                <select
                  style={handSelect}
                  value={d[playerKey] || ""}
                  onChange={(e) => onDraftPatch({ [playerKey]: e.target.value })}
                  disabled={!setupReady}
                >
                  <option value="">— Select —</option>
                  {teamPlayers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
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

  return (
    <div style={{ ...styles.card, borderRadius: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ fontWeight: 950 }}>
          {match.tableName} • {match.label}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div style={{ color: match.completed ? "#34d399" : "#94a3b8", fontWeight: 950 }}>
            {match.completed ? `Winner: ${teamById.get(match.winnerId)?.name ?? "—"}` : "Live"}
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
          {canPlay && (
            <button type="button" style={styles.btnSecondary} onClick={() => setSetupCollapsed((v) => !v)}>
              {setupCollapsed ? "Expand Setup" : "Collapse Setup"}
            </button>
          )}
        </div>

        {!canPlay ? (
          <div style={styles.small}>Select both teams first.</div>
        ) : setupCollapsed ? (
          <div style={styles.card}>
            <div style={{ ...styles.small, marginBottom: 6 }}>Table setup completed. Expand to edit if needed.</div>
            {seatOrderNames.length === 4 && (
              <div style={{ fontWeight: 900 }}>
                Order: <span style={{ color: "#e5e7eb" }}>{seatOrderNames.join(" → ")}</span>
              </div>
            )}
            {match.firstShufflerPlayerId && (
              <div style={{ marginTop: 6, ...styles.small }}>
                First dealer: <span style={{ color: "#e5e7eb", fontWeight: 900 }}>{playerById.get(match.firstShufflerPlayerId)?.name || "—"}</span>
              </div>
            )}
          </div>
        ) : (
          <>
            <div style={{ ...styles.small, marginBottom: 10 }}>Choose the 4 players in table order, then select who deals first.</div>

            <div style={styles.grid4}>
              {[0, 1, 2, 3].map((idx) => (
                <div key={idx}>
                  <div style={fieldLabelStyle}>Seat {idx + 1}</div>
                  <select
                    style={handSelect}
                    value={match.tableOrderPlayerIds?.[idx] || ""}
                    onChange={(e) => setSeat(idx, e.target.value)}
                    disabled={(match.hands || []).length > 0}
                  >
                    <option value="">— Select —</option>
                    {allTablePlayers.map((p) => {
                      const taken =
                        (match.tableOrderPlayerIds || []).includes(p.id) &&
                        (match.tableOrderPlayerIds || [])[idx] !== p.id;
                      return (
                        <option key={p.id} value={p.id} disabled={taken}>
                          {p.name}
                        </option>
                      );
                    })}
                  </select>
                </div>
              ))}
            </div>

            <div style={{ marginTop: 10, maxWidth: 320 }}>
              <div style={fieldLabelStyle}>First player to deal</div>
              <select
                style={handSelect}
                value={match.firstShufflerPlayerId || ""}
                onChange={(e) => onTableSetupPatch({ firstShufflerPlayerId: e.target.value })}
                disabled={(match.hands || []).length > 0 || (match.tableOrderPlayerIds || []).length !== 4}
              >
                <option value="">— Select —</option>
                {(match.tableOrderPlayerIds || []).map((pid) => {
                  const p = playerById.get(pid);
                  return p ? (
                    <option key={pid} value={pid}>
                      {p.name}
                    </option>
                  ) : null;
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
          <div style={{ fontSize: 20, fontWeight: 950, lineHeight: 1.1, color: "#e5e7eb" }}>Dealing Order</div>

          <div style={{ marginTop: 6, fontSize: 24, fontWeight: 950, lineHeight: 1.05 }}>
            {seatOrderPlayers.length === 4 ? (
              seatOrderPlayers.map((p, idx) => (
                <React.Fragment key={p.id}>
                  <span style={{ color: p.id === currentDealer.playerId ? "#facc15" : "#e5e7eb" }}>
                    {p.name}
                  </span>
                  {idx < seatOrderPlayers.length - 1 ? (
                    <span style={{ color: "#e5e7eb" }}> {"→"} </span>
                  ) : null}
                </React.Fragment>
              ))
            ) : (
              <span style={{ color: "#e5e7eb" }}>Set the 4-player order first</span>
            )}
          </div>

          <div style={{ marginTop: 8, fontSize: 24, fontWeight: 1000, lineHeight: 1.05 }}>
            <span style={{ color: "#e5e7eb" }}>Now dealing: </span>
            <span style={{ color: "#facc15", fontSize: 26 }}>
              {setupReady && currentDealer.name ? currentDealer.name : "Complete table setup before starting"}
            </span>
          </div>
        </div>

        <div style={styles.handRow1}>
          <Field label="Bidder" labelStyle={fieldLabelStyle}>
            <select
              style={handSelect}
              value={d.bidder}
              onChange={(e) => onDraftPatch({ bidder: e.target.value })}
              disabled={!setupReady}
            >
              <option value="A">{ta}</option>
              <option value="B">{tb}</option>
            </select>
          </Field>

          <Field label="Bid" labelStyle={fieldLabelStyle}>
            <input
              style={handInput}
              value={d.bid}
              onChange={(e) => onDraftPatch({ bid: e.target.value })}
              placeholder='80, 90, 110... or "250"'
              disabled={!setupReady}
            />
          </Field>

          <Field label="Suit" labelStyle={fieldLabelStyle}>
            <select
              style={handSelect}
              value={d.suit || "S"}
              onChange={(e) => onDraftPatch({ suit: e.target.value })}
              disabled={!setupReady}
            >
              <option value="H">♥ Hearts</option>
              <option value="D">♦ Diamonds</option>
              <option value="C">♣ Clubs</option>
              <option value="S">♠ Spades</option>
            </select>
          </Field>

          <Field label="Coinche" labelStyle={fieldLabelStyle}>
            <select
              style={handSelect}
              value={d.coincheLevel}
              onChange={(e) => onDraftPatch({ coincheLevel: e.target.value })}
              disabled={!setupReady}
            >
              <option value="NONE">None</option>
              <option value="COINCHE">Coinche (x2)</option>
              <option value="SURCOINCHE">Surcoinche (x4)</option>
            </select>
          </Field>
        </div>

        <div style={styles.handRow2}>
          {renderAnnounceBlock("A", ta, playersA)}
          {renderAnnounceBlock("B", tb, playersB)}
        </div>

        <div style={styles.handRow3}>
          <Field label="Belote Made" labelStyle={fieldLabelStyle}>
            <select
              style={handSelect}
              value={d.beloteTeam}
              onChange={(e) => onDraftPatch({ beloteTeam: e.target.value })}
              disabled={!setupReady}
            >
              <option value="NONE">None</option>
              <option value="A">{ta}</option>
              <option value="B">{tb}</option>
            </select>
          </Field>

          <Field label="Capot Made" labelStyle={fieldLabelStyle}>
            <select
              style={handSelect}
              value={d.capot ? "YES" : "NO"}
              onChange={(e) => onDraftPatch({ capot: e.target.value === "YES" })}
              disabled={!setupReady}
            >
              <option value="NO">No</option>
              <option value="YES">Yes</option>
            </select>
          </Field>

          <Field label="Bidder trick points (0–162)" labelStyle={fieldLabelStyle}>
            <input
              style={handInput}
              value={d.bidderTrickPoints}
              onChange={(e) => {
                const raw = e.target.value;
                if (!raw.trim()) {
                  onDraftPatch({ bidderTrickPoints: "", nonBidderTrickPoints: "", trickSource: "", skippedHand: false });
                  return;
                }
                const n = safeInt(raw);
                if (n === null) {
                  onDraftPatch({ bidderTrickPoints: raw, trickSource: "BIDDER", skippedHand: false });
                  return;
                }
                const v = clamp(n, 0, 162);
                onDraftPatch({
                  bidderTrickPoints: String(v),
                  nonBidderTrickPoints: String(162 - v),
                  trickSource: "BIDDER",
                  skippedHand: false,
                });
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
                if (!raw.trim()) {
                  onDraftPatch({ bidderTrickPoints: "", nonBidderTrickPoints: "", trickSource: "", skippedHand: false });
                  return;
                }
                const n = safeInt(raw);
                if (n === null) {
                  onDraftPatch({ nonBidderTrickPoints: raw, trickSource: "NON", skippedHand: false });
                  return;
                }
                const v = clamp(n, 0, 162);
                onDraftPatch({
                  nonBidderTrickPoints: String(v),
                  bidderTrickPoints: String(162 - v),
                  trickSource: "NON",
                  skippedHand: false,
                });
              }}
              placeholder="ex: 81"
              inputMode="numeric"
              disabled={!setupReady || d.trickSource === "BIDDER"}
            />
          </Field>
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12, alignItems: "center" }}>
          <button style={{ ...styles.btnPrimary, ...(setupReady ? {} : styles.disabled) }} onClick={onAddHand} disabled={!setupReady}>
            {match.editingHandIdx ? `Save Changes (Hand ${match.editingHandIdx})` : "Add Hand"}
          </button>

          {match.editingHandIdx && <button style={styles.btnSecondary} onClick={onCancelEdit}>Cancel Edit</button>}

          <button style={{ ...styles.btnSecondary, ...(setupReady ? {} : styles.disabled) }} onClick={() => setScanOpen(true)} disabled={!setupReady}>
            Calculate points with picture
          </button>

          <button
            style={{ ...styles.btnSecondary, ...(setupReady && !match.editingHandIdx ? {} : styles.disabled) }}
            onClick={onSkipHand}
            disabled={!setupReady || !!match.editingHandIdx}
          >
            Skip Hand - No Points
          </button>

<span style={{ ...styles.small, marginLeft: "auto" }}>
  Suit: <SuitIcon suit={d.suit || "S"} /> {suitLabel}
</span>

<button
  style={styles.btnDanger}
  onClick={() => {
    if (!confirm("Are you sure you want to clear all hands for this match?")) return;
    onClearHands();
  }}
>
  Clear Match Hands
</button>
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
                [ds.announceA1PlayerName || playerById.get(ds.announceA1PlayerId)?.name || ta, ds.announceA1],
                [ds.announceA2PlayerName || playerById.get(ds.announceA2PlayerId)?.name || ta, ds.announceA2],
                [ds.announceB1PlayerName || playerById.get(ds.announceB1PlayerId)?.name || tb, ds.announceB1],
                [ds.announceB2PlayerName || playerById.get(ds.announceB2PlayerId)?.name || tb, ds.announceB2],
              ]
                .filter(([, pts]) => (Number(pts) || 0) > 0)
                .map(([name, pts]) => `${name}: ${pts}`);

              return (
                <div key={h.idx} style={styles.handRow}>
                  <div style={{ minWidth: 260 }}>
                    <div style={{ fontWeight: 950 }}>Hand {h.idx}</div>
                    <div style={styles.small}>
                      {ds.skippedHand ? (
                        <>Skipped hand • No points awarded</>
                      ) : (
                        <>
                          Bid {ds.bid} <SuitIcon suit={ds.suit || "S"} /> • Bidder {ds.bidder === "A" ? ta : tb} • {ds.coincheLevel}
                          {ds.capot ? " • Capot Made" : ""} • Bidder tricks {ds.bidderTrickPoints} • Non-bidder tricks{" "}
                          {ds.nonBidderTrickPoints !== "" && ds.nonBidderTrickPoints !== undefined
                            ? ds.nonBidderTrickPoints
                            : clamp(162 - (Number(ds.bidderTrickPoints) || 0), 0, 162)}
                        </>
                      )}
                    </div>

                    {ds.beloteTeam && ds.beloteTeam !== "NONE" ? (
                      <div style={{ marginTop: 6, ...styles.small }}>
                        Belote Made: <span style={{ color: "#e5e7eb" }}>{ds.beloteTeam === "A" ? ta : tb}</span>
                      </div>
                    ) : null}

                    {announceParts.length ? (
                      <div style={{ marginTop: 6, ...styles.small }}>
                        Announces entered: <span style={{ color: "#e5e7eb" }}>{announceParts.join(" • ")}</span>
                      </div>
                    ) : null}

                    {ds.shufflerName ? (
                      <div style={{ marginTop: 6, ...styles.small }}>
                        Dealer: <span style={{ color: "#e5e7eb" }}>{ds.shufflerName}</span>
                      </div>
                    ) : null}
                  </div>

                  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={styles.tag}>
                      +{h.scoreA} / +{h.scoreB}
                    </span>
                    {!ds.skippedHand && (
                      <button style={styles.btnSecondary} onClick={() => onStartEditHand(h.idx)}>
                        Edit
                      </button>
                    )}
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
              ? { bidderTrickPoints: String(p), nonBidderTrickPoints: String(162 - p), trickSource: "BIDDER", skippedHand: false }
              : { nonBidderTrickPoints: String(p), bidderTrickPoints: String(162 - p), trickSource: "NON", skippedHand: false }
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