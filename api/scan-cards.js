// api/scan-cards.js
import Busboy from "busboy";

export const config = {
  api: { bodyParser: false },
};

// ---------- helpers ----------
function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (d) => chunks.push(d));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

function normalizeSuit(s) {
  const up = String(s || "").toUpperCase();
  if (["H", "D", "C", "S"].includes(up)) return up;
  return "S";
}

function normalizePileSide(s) {
  const up = String(s || "").toUpperCase();
  // Accept BIDDER | NON | NON_BIDDER
  if (up === "BIDDER") return "BIDDER";
  return "NON";
}

function parseCardLabel(label) {
  // expects like: "10S", "9H", "QD", "JS", "AS", "7C"
  const raw = String(label || "").trim().toUpperCase();
  if (!raw) return null;

  const suit = raw.slice(-1);
  const rank = raw.slice(0, -1);

  if (!["H", "D", "C", "S"].includes(suit)) return null;

  // rank allowed: 7,8,9,10,J,Q,K,A
  const ok = ["7", "8", "9", "10", "J", "Q", "K", "A"];
  if (!ok.includes(rank)) return null;

  return { rank, suit, code: `${rank}${suit}` };
}

const TRUMP_POINTS = {
  J: 20,
  9: 14,
  A: 11,
  "10": 10,
  K: 4,
  Q: 3,
  8: 0,
  7: 0,
};

const NON_TRUMP_POINTS = {
  A: 11,
  "10": 10,
  K: 4,
  Q: 3,
  J: 2,
  9: 0,
  8: 0,
  7: 0,
};

function computeBelotePoints(cards16, trumpSuit, lastTrick) {
  const trump = normalizeSuit(trumpSuit);
  let total = 0;

  for (const c of cards16) {
    const table = c.suit === trump ? TRUMP_POINTS : NON_TRUMP_POINTS;
    total += table[c.rank] ?? 0;
  }

  if (lastTrick) total += 10;
  return total;
}

/**
 * Robustly extract predictions from a Roboflow workflow response.
 * We search for objects with a "class" (or "label") and "confidence".
 */
function extractPredictionsDeep(obj) {
  const out = [];

  const visit = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const x of node) visit(x);
      return;
    }
    if (typeof node !== "object") return;

    // Common inference shapes
    const cls = node.class ?? node.label ?? node.predicted_class ?? node.name;
    const conf = node.confidence ?? node.conf ?? node.score;

    if (typeof cls === "string" && typeof conf === "number") {
      out.push({
        class: cls,
        confidence: conf,
        // keep bbox if present
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
      });
    }

    for (const k of Object.keys(node)) visit(node[k]);
  };

  visit(obj);
  return out;
}

// Build the canonical 32-card Belote deck
function buildBeloteDeck32() {
  const suits = ["H", "D", "C", "S"];
  const ranks = ["7", "8", "9", "10", "J", "Q", "K", "A"];
  const deck = [];
  for (const s of suits) {
    for (const r of ranks) {
      deck.push({ rank: r, suit: s, code: `${r}${s}` });
    }
  }
  return deck;
}

const DECK32 = buildBeloteDeck32();

function pickBestUniqueCards(cards, target = 16) {
  // cards is expected sorted by confidence desc already
  const seen = new Set();
  const out = [];

  for (const c of cards) {
    if (!c?.code) continue;
    if (seen.has(c.code)) continue;
    seen.add(c.code);
    out.push(c);
    if (out.length === target) break;
  }

  return out;
}

function fillMissingFromDeck(cardsUnique, target = 16) {
  // If we detected < target, we can optionally fill with "unknown" cards
  // (so scoring isn't wildly wrong). We'll mark them as filled.
  // NOTE: This is a fallback; best is to improve capture quality.
  if (cardsUnique.length >= target) return { cards: cardsUnique, filled: [] };

  const have = new Set(cardsUnique.map((c) => c.code));
  const missing = DECK32.filter((c) => !have.has(c.code));

  const filled = [];
  const out = [...cardsUnique];

  while (out.length < target && missing.length > 0) {
    const m = missing.shift();
    out.push({
      ...m,
      confidence: 0,
      filled: true,
    });
    filled.push(m.code);
  }

  return { cards: out, filled };
}

// ---------- roboflow call ----------
async function callRoboflowWorkflow({ imageBuffer, mimeType }) {
  const apiUrl = process.env.ROBOFLOW_API_URL || "https://serverless.roboflow.com";
  const apiKey = process.env.ROBOFLOW_API_KEY;
  const workspace = process.env.ROBOFLOW_WORKSPACE;
  const workflowId = process.env.ROBOFLOW_WORKFLOW_ID;

  if (!apiKey || !workspace || !workflowId) {
    throw new Error(
      "Missing Roboflow env vars. Set ROBOFLOW_API_KEY, ROBOFLOW_WORKSPACE, ROBOFLOW_WORKFLOW_ID."
    );
  }

  // Endpoint format: https://serverless.roboflow.com/<workspace>/workflows/<workflow_id>
  const url = `${apiUrl.replace(/\/$/, "")}/${workspace}/workflows/${workflowId}?api_key=${encodeURIComponent(
    apiKey
  )}`;

  const form = new FormData();
  const blob = new Blob([imageBuffer], { type: mimeType || "image/jpeg" });
  form.append("image", blob, "upload.jpg");

  const resp = await fetch(url, {
    method: "POST",
    body: form,
    headers: {
      // Some setups accept header auth too:
      "x-api-key": apiKey,
    },
  });

  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Roboflow returned non-JSON (status ${resp.status}): ${text.slice(0, 200)}`);
  }

  if (!resp.ok) {
    const msg = json?.error || json?.message || text;
    throw new Error(`Roboflow error ${resp.status}: ${msg}`);
  }

  return json;
}

// ---------- handler ----------
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Use POST" });
    return;
  }

  try {
    const bb = Busboy({ headers: req.headers });

    const fields = {};
    let imageBuffer = null;
    let imageInfo = { filename: "", mimeType: "" };

    const done = new Promise((resolve, reject) => {
      bb.on("field", (name, value) => {
        fields[name] = value;
      });

      bb.on("file", async (name, file, info) => {
        try {
          if (name !== "image") {
            file.resume();
            return;
          }
          imageInfo = info;
          imageBuffer = await streamToBuffer(file);
        } catch (e) {
          reject(e);
        }
      });

      bb.on("error", reject);
      bb.on("finish", resolve);
    });

    req.pipe(bb);
    await done;

    if (!imageBuffer || imageBuffer.length < 10) {
      res.status(400).json({ ok: false, error: "Missing image" });
      return;
    }

    const trumpSuit = normalizeSuit(fields.trumpSuit || "S");
    const pileSide = normalizePileSide(fields.pileSide || "BIDDER"); // kept for future use
    const lastTrick = fields.lastTrick === "1" || fields.lastTrick === "true";

    // optional: allow UI to choose whether we auto-fill missing cards
    const allowFill =
      fields.allowFill === "1" || fields.allowFill === "true" || fields.allowFill === "yes";

    // 1) call workflow
    const rf = await callRoboflowWorkflow({
      imageBuffer,
      mimeType: imageInfo?.mimeType || "image/jpeg",
    });

    // 2) extract predictions
    const preds = extractPredictionsDeep(rf);

    // 3) convert labels to cards + sort by confidence
    const cards = preds
      .map((p) => ({
        ...p,
        parsed: parseCardLabel(p.class),
      }))
      .filter((x) => x.parsed)
      .map((x) => ({
        rank: x.parsed.rank,
        suit: x.parsed.suit,
        code: x.parsed.code,
        confidence: x.confidence,
      }))
      .sort((a, b) => b.confidence - a.confidence);

    // 4) choose best 16 UNIQUE cards (not just top 16 predictions)
    const unique = pickBestUniqueCards(cards, 16);

    let cards16 = unique;
    let filledCodes = [];

    if (allowFill && unique.length < 16) {
      const filled = fillMissingFromDeck(unique, 16);
      cards16 = filled.cards;
      filledCodes = filled.filled;
    }

    // 5) compute points (we only score detected cards, not filled placeholders)
    // If you enabled allowFill, you PROBABLY do NOT want placeholders affecting score,
    // so we'll score only non-filled.
    const scoredCards = cards16.filter((c) => !c.filled);
    const points = computeBelotePoints(scoredCards, trumpSuit, lastTrick);

    const warnings = [];
    const uniqueCount = unique.length;

    if (uniqueCount !== 16) {
      warnings.push(
        `Detected ${uniqueCount} unique cards (expected 16). Try better lighting / less overlap / keep corners visible.`
      );
    }

    if (allowFill && filledCodes.length > 0) {
      warnings.push(`Filled ${filledCodes.length} missing cards with placeholders (not counted in points).`);
    }

    res.status(200).json({
      ok: true,
      trumpSuit,
      pileSide,
      lastTrick,
      points,
      cards: cards16,
      warnings,
      meta: {
        receivedBytes: imageBuffer.length,
        mimeType: imageInfo?.mimeType || "",
      },
      debug: {
        totalPredictionsFound: preds.length,
        totalParsedPredictions: cards.length,
        uniqueCardsFound: uniqueCount,
        filledCodes,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
}