// src/scoring/coinche.js
export const TARGET_SCORE = 2000;

export function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

// Rounds like your current code:
// 125 -> 120 (ending in 5 rounds down), 126 -> 130
export function roundTrickPoints(x) {
  if (x == null) return 0;
  const n = Math.max(0, Math.min(162, Number(x) || 0));
  return Math.floor((n + 4) / 10) * 10;
}

/**
 * Matches your current "Fast Mode" scoring logic in App.jsx.
 */
export function computeFastCoincheHandScore({
  bidder,          // "A"|"B"
  bid,             // number
  suit,            // "S"|"H"|"D"|"C" (not used for math)
  coincheLevel,    // "NONE"|"COINCHE"|"SURCOINCHE"
  capot,           // boolean
  bidderTrickPoints, // 0..162 raw
  announceA,       // non-belote announces total A
  announceB,       // non-belote announces total B
  beloteTeam,      // "NONE"|"A"|"B"
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

  // Rules from your doc:
  // - Minimum 81
  // - If bidder has belote, minimum becomes 71
  // - If bid is 80, they must still make 81
  const bidderHasBelote =
    (BIDDER_IS_A && beloteTeam === "A") || (!BIDDER_IS_A && beloteTeam === "B");
  const baseMin = bidderHasBelote ? 71 : 81;
  const special80 = bidVal === 80 ? 81 : 0;

  // announces help reduce requirement, but not below baseMin
  const announceHelp = bidderAnn + (bidderHasBelote ? 20 : 0);
  const required = Math.max(baseMin, special80, bidVal - announceHelp);

  const bidderSucceeded = capot ? true : rawBidder >= required;

  const mult =
    coincheLevel === "SURCOINCHE" ? 4 : coincheLevel === "COINCHE" ? 2 : 1;
  const isCoinche = coincheLevel !== "NONE";

  let scoreA = 0;
  let scoreB = 0;

  if (capot) {
    // Capot: winner gets 250 + all announces (incl belote) + bid, loser 0
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
    // Coinche/Surcoinche: winner gets 160 + (mult*bid) + all announces
    // loser 0; belote stays with declaring team (unless capot)
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

  // Normal scoring
  if (bidderSucceeded) {
    // bidder: rounded tricks + their announces + bid (+ belote)
    // opp: rounded tricks + their announces (+ belote)
    if (BIDDER_IS_A) {
      scoreA = tricksBidder + aAnn + beloteA + bidVal;
      scoreB = tricksOpp + bAnn + beloteB;
    } else {
      scoreB = tricksBidder + bAnn + beloteB + bidVal;
      scoreA = tricksOpp + aAnn + beloteA;
    }
  } else {
    // fail: bidder gets 0 but keeps belote; opponents get 160 + bid + announces (non-belote)
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

export function computeGameTotalsFromHands(hands) {
  let totalA = 0;
  let totalB = 0;
  let ended = false;
  let winnerSide = null;

  for (const h of hands) {
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
  }

  return { totalA, totalB, ended, winnerSide };
}
