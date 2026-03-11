import Busboy from "busboy";

export const config = {
  api: { bodyParser: false },
};

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (d) => chunks.push(d));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

function normalizeSuit(s) {
  const up = String(s || "").trim().toUpperCase();
  return ["H", "D", "C", "S"].includes(up) ? up : "S";
}

function normalizePileSide(s) {
  const up = String(s || "").trim().toUpperCase();
  return up === "BIDDER" ? "BIDDER" : "NON";
}

// Accept both English and French ranks from Roboflow
// French: V=Jack, D=Queen, R=King, 1=Ace
function normalizeRank(rankRaw) {
  const r = String(rankRaw || "").trim().toUpperCase();
  if (r === "V") return "J";
  if (r === "D") return "Q";
  if (r === "R") return "K";
  if (r === "1") return "A";
  return r;
}

// For display back to your users in French card notation
function toFrenchRank(rank) {
  if (rank === "J") return "V";
  if (rank === "Q") return "D";
  if (rank === "K") return "R";
  if (rank === "A") return "1";
  return rank;
}

function toFrenchCode(code) {
  const raw = String(code || "").trim().toUpperCase();
  if (!raw) return raw;
  const suit = raw.slice(-1);
  const rank = raw.slice(0, -1);
  return `${toFrenchRank(rank)}${suit}`;
}

function parseCardLabel(label) {
  // Accept labels like:
  // 7H, 8D, 9S, 10C, JH, QD, KS, AC
  // and French:
  // 7H, 8D, 9S, 10C, VH, DD, RS, 1C
  const raw = String(label || "").trim().toUpperCase();
  if (!raw || raw.length < 2) return null;

  const suit = raw.slice(-1);
  let rank = raw.slice(0, -1);

  if (!["H", "D", "C", "S"].includes(suit)) return null;

  rank = normalizeRank(rank);

  const validRanks = ["7", "8", "9", "10", "J", "Q", "K", "A"];
  if (!validRanks.includes(rank)) return null;

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

function computeBelotePoints(cards, trumpSuit, lastTrick) {
  const trump = normalizeSuit(trumpSuit);
  let total = 0;

  for (const c of cards) {
    const table = c.suit === trump ? TRUMP_POINTS : NON_TRUMP_POINTS;
    total += table[c.rank] ?? 0;
  }

  if (lastTrick) total += 10;
  return total;
}

function extractPredictionsDeep(obj) {
  const out = [];

  const visit = (node) => {
    if (!node) return;

    if (Array.isArray(node)) {
      for (const x of node) visit(x);
      return;
    }

    if (typeof node !== "object") return;

    const cls = node.class ?? node.label ?? node.predicted_class ?? node.name;
    const conf = node.confidence ?? node.conf ?? node.score;

    if (typeof cls === "string" && typeof conf === "number") {
      out.push({
        class: cls,
        confidence: conf,
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

function boxFromPred(p) {
  const x = Number(p.x);
  const y = Number(p.y);
  const w = Number(p.width);
  const h = Number(p.height);

  if (![x, y, w, h].every((n) => Number.isFinite(n))) return null;

  return {
    x1: x - w / 2,
    y1: y - h / 2,
    x2: x + w / 2,
    y2: y + h / 2,
  };
}

function iou(a, b) {
  const xA = Math.max(a.x1, b.x1);
  const yA = Math.max(a.y1, b.y1);
  const xB = Math.min(a.x2, b.x2);
  const yB = Math.min(a.y2, b.y2);

  const interW = Math.max(0, xB - xA);
  const interH = Math.max(0, yB - yA);
  const interArea = interW * interH;

  const areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
  const areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);

  const denom = areaA + areaB - interArea;
  return denom > 0 ? interArea / denom : 0;
}

function nms(preds, iouThreshold = 0.45) {
  const sorted = [...preds].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  const kept = [];

  for (const p of sorted) {
    const bp = boxFromPred(p);
    if (!bp) {
      kept.push(p);
      continue;
    }

    let overlaps = false;
    for (const k of kept) {
      const bk = boxFromPred(k);
      if (!bk) continue;
      if (iou(bp, bk) >= iouThreshold) {
        overlaps = true;
        break;
      }
    }

    if (!overlaps) kept.push(p);
  }

  return kept;
}

function pickBestUniqueCards(preds, maxCards = 32) {
  const reduced = nms(preds, 0.45);

  const parsed = reduced
    .map((p) => {
      const parsedCard = parseCardLabel(p.class);
      if (!parsedCard) return null;
      return {
        rank: parsedCard.rank,
        suit: parsedCard.suit,
        code: parsedCard.code,
        confidence: p.confidence ?? 0,
        x: p.x,
        y: p.y,
        width: p.width,
        height: p.height,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.confidence - a.confidence);

  const seen = new Set();
  const unique = [];

  for (const c of parsed) {
    if (seen.has(c.code)) continue;
    seen.add(c.code);
    unique.push(c);
    if (unique.length >= maxCards) break;
  }

  return {
    unique,
    reducedCount: reduced.length,
    parsedCount: parsed.length,
  };
}

async function callRoboflowWorkflow({ imageBuffer, mimeType }) {
  const apiUrl = process.env.ROBOFLOW_API_URL || "https://serverless.roboflow.com";
  const apiKey = process.env.ROBOFLOW_API_KEY;
  const workspace = process.env.ROBOFLOW_WORKSPACE;
  const workflowId = process.env.ROBOFLOW_WORKFLOW_ID;

  if (!apiKey || !workspace || !workflowId) {
    throw new Error("Missing Roboflow env vars.");
  }

  const base = apiUrl.replace(/\/$/, "");
  const url = `${base}/${encodeURIComponent(workspace)}/workflows/${encodeURIComponent(workflowId)}`;

  const base64 = imageBuffer.toString("base64");
  const dataUrl = `data:${mimeType || "image/jpeg"};base64,${base64}`;

  const body = {
    api_key: apiKey,
    inputs: {
      image: {
        type: "base64",
        value: dataUrl,
      },
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await resp.text();

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Roboflow returned non-JSON (status ${resp.status}): ${text.slice(0, 500)}`);
  }

  if (!resp.ok) {
    const msg = json?.error || json?.message || JSON.stringify(json).slice(0, 500);
    throw new Error(`Roboflow error ${resp.status}: ${msg}`);
  }

  return json;
}

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
    const pileSide = normalizePileSide(fields.pileSide || "BIDDER");
    const lastTrick = fields.lastTrick === "1" || fields.lastTrick === "true";

    const rf = await callRoboflowWorkflow({
      imageBuffer,
      mimeType: imageInfo?.mimeType || "image/jpeg",
    });

    const preds = extractPredictionsDeep(rf);
    const { unique: cards, reducedCount, parsedCount } = pickBestUniqueCards(preds, 32);
    const points = computeBelotePoints(cards, trumpSuit, lastTrick);

    const warnings = [];
    if (cards.length < 4) {
      warnings.push(`Detected only ${cards.length} unique cards. Minimum expected is 4.`);
    }
    if (cards.length > 32) {
      warnings.push(`Detected ${cards.length} unique cards. Maximum valid deck size is 32.`);
    }
    if (cards.length >= 4 && cards.length <= 32) {
      warnings.push(`Detected ${cards.length} unique cards.`);
    }

    res.status(200).json({
      ok: true,
      trumpSuit,
      pileSide,
      lastTrick,
      points,
      cardCount: cards.length,
      minCardsSupported: 4,
      maxCardsSupported: 32,
      cards: cards.map((c) => ({
        ...c,
        displayRank: toFrenchRank(c.rank),
        displayCode: toFrenchCode(c.code),
      })),
      warnings,
      meta: {
        receivedBytes: imageBuffer.length,
        mimeType: imageInfo?.mimeType || "",
      },
      debug: {
        totalPredictionsFound: preds.length,
        afterNMS: reducedCount,
        parsedCardsAfterNMS: parsedCount,
      },
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e?.message || "Server error",
    });
  }
}