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
  if (up === "BIDDER") return "BIDDER";
  return "NON";
}

// French rank mapping: R=Roi(K), D=Dame(Q), V=Valet(J), 1=As(A)
function normalizeRank(rankRaw) {
  const r = String(rankRaw || "").trim().toUpperCase();
  const map = { R: "K", D: "Q", V: "J", "1": "A" };
  const normalized = map[r] ?? r;

  // allowed in belote 32-card deck
  const ok = ["7", "8", "9", "10", "J", "Q", "K", "A"];
  return ok.includes(normalized) ? normalized : null;
}

function parseCardLabel(label) {
  // expects like: "10S", "9H", "QD", "JS", "AS", "7C"
  // supports French ranks: "RS"(K), "DS"(Q), "VS"(J), "1S"(A)
  const raw = String(label || "").trim().toUpperCase();
  if (!raw || raw.length < 2) return null;

  const suit = raw.slice(-1);
  const rankPart = raw.slice(0, -1);

  if (!["H", "D", "C", "S"].includes(suit)) return null;

  const rank = normalizeRank(rankPart);
  if (!rank) return null;

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

/**
 * Robustly extract predictions from a Roboflow workflow response.
 * We search for objects with a "class" (or similar) and "confidence".
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

// ---------- bbox / duplicate filtering ----------
function toXYXY(p) {
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
  const interX1 = Math.max(a.x1, b.x1);
  const interY1 = Math.max(a.y1, b.y1);
  const interX2 = Math.min(a.x2, b.x2);
  const interY2 = Math.min(a.y2, b.y2);

  const interW = Math.max(0, interX2 - interX1);
  const interH = Math.max(0, interY2 - interY1);
  const interArea = interW * interH;

  const areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
  const areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
  const union = areaA + areaB - interArea;

  return union > 0 ? interArea / union : 0;
}

/**
 * NMS-like filter: keep only one box per physical card region.
 * We don't require same class; we just drop high-overlap boxes.
 */
function filterOverlappingBoxes(preds, iouThreshold = 0.65) {
  const sorted = [...preds].sort((a, b) => b.confidence - a.confidence);
  const kept = [];

  for (const p of sorted) {
    const bb = toXYXY(p);
    // If no bbox info, keep it (can't dedupe)
    if (!bb) {
      kept.push(p);
      continue;
    }

    let overlaps = false;
    for (const k of kept) {
      const kb = toXYXY(k);
      if (!kb) continue;
      if (iou(bb, kb) >= iouThreshold) {
        overlaps = true;
        break;
      }
    }
    if (!overlaps) kept.push(p);
  }

  return kept;
}

/**
 * Pick best 16 UNIQUE cards.
 * 1) bbox-dedupe (removes duplicate detections)
 * 2) unique-by-card-code (since a belote deck has no duplicates)
 * 3) stop at 16
 */
function pickBestUniqueCards(predsParsed, target = 16) {
  const seen = new Set();
  const out = [];

  for (const p of predsParsed.sort((a, b) => b.confidence - a.confidence)) {
    if (!p.parsed) continue;
    const code = p.parsed.code;
    if (seen.has(code)) continue;

    seen.add(code);
    out.push({
      rank: p.parsed.rank,
      suit: p.parsed.suit,
      code,
      confidence: p.confidence,
      x: p.x,
      y: p.y,
      width: p.width,
      height: p.height,
      rawClass: p.class,
    });

    if (out.length >= target) break;
  }

  return out;
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

  // ✅ Robust endpoint for Workflows inference
  const base = apiUrl.replace(/\/$/, "");
  const url =
    `${base}/infer/workflows/${encodeURIComponent(workspace)}/${encodeURIComponent(workflowId)}` +
    `?api_key=${encodeURIComponent(apiKey)}`;

  const base64 = imageBuffer.toString("base64");
  const dataUrl = `data:${mimeType || "image/jpeg"};base64,${base64}`;

  const body = {
    inputs: {
      image: { type: "base64", value: dataUrl },
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // ✅ Add Bearer auth too (some setups require it)
      Authorization: `Bearer ${apiKey}`,
      "x-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });

  const text = await resp.text();

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Roboflow returned non-JSON (status ${resp.status}): ${text.slice(0, 200)}`);
  }

  if (!resp.ok) {
    const msg = json?.error || json?.message || JSON.stringify(json).slice(0, 300);
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
    const pileSide = normalizePileSide(fields.pileSide || "BIDDER");
    const lastTrick = fields.lastTrick === "1" || fields.lastTrick === "true";

    // 1) call workflow
    const rf = await callRoboflowWorkflow({
      imageBuffer,
      mimeType: imageInfo?.mimeType || "image/jpeg",
    });

    // 2) extract predictions (deep)
    const preds = extractPredictionsDeep(rf);

    // 3) bbox dedupe first (removes “same card” duplicates)
    const predsDedup = filterOverlappingBoxes(preds, 0.65);

    // 4) parse labels to cards (supports French ranks)
    const parsed = predsDedup.map((p) => ({ ...p, parsed: parseCardLabel(p.class) }));

    // 5) pick best 16 UNIQUE by card code
    const cards16 = pickBestUniqueCards(parsed, 16);

    // 6) compute points
    const points = computeBelotePoints(cards16, trumpSuit, lastTrick);

    const warnings = [];
    if (cards16.length !== 16) {
      warnings.push(
        `Detected ${cards16.length} unique cards (expected 16). Try: brighter light, less glare, fan slightly wider, keep corners visible.`
      );
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
        afterBoxDedup: predsDedup.length,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
}