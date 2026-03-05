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

// ---- Card label parsing (supports French ranks + French Ace shown as "1") ----
function normalizeRank(rankRaw) {
  const r = String(rankRaw || "").trim().toUpperCase();

  // French face letters + Ace shown as 1:
  // R = Roi = King (K)
  // D = Dame = Queen (Q)
  // V = Valet = Jack (J)
  // 1 = Ace (A)
  const map = { R: "K", D: "Q", V: "J", "1": "A" };
  const mapped = map[r] || r;

  const ok = ["7", "8", "9", "10", "J", "Q", "K", "A"];
  if (!ok.includes(mapped)) return null;
  return mapped;
}

function parseCardLabel(label) {
  // parses: "10S", "9H", "QD", "JS", "AS", "7C", also "1H" etc.
  // also tolerates separators like "10_S", "10-S", "10 S"
  const raw = String(label || "").trim().toUpperCase();
  if (!raw) return null;

  const suitMatch = raw.match(/([HDCS])\s*$/);
  if (!suitMatch) return null;
  const suit = suitMatch[1];

  const rankPart = raw
    .slice(0, suitMatch.index)
    .replace(/[^0-9AJQKRDV]/g, ""); // allow French letters + digits

  const rank = normalizeRank(rankPart);
  if (!rank) return null;

  return { rank, suit, code: `${rank}${suit}` };
}

// ---- Point tables (Belote/Coinche trick points) ----
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
 * Extract predictions from Roboflow workflow response.
 * We look for {class/label, confidence, x, y, width, height}
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

    const x = node.x ?? node.center_x ?? node.cx;
    const y = node.y ?? node.center_y ?? node.cy;
    const width = node.width ?? node.w;
    const height = node.height ?? node.h;

    if (typeof cls === "string" && typeof conf === "number") {
      out.push({
        class: cls,
        confidence: conf,
        x: typeof x === "number" ? x : null,
        y: typeof y === "number" ? y : null,
        width: typeof width === "number" ? width : null,
        height: typeof height === "number" ? height : null,
      });
    }

    for (const k of Object.keys(node)) visit(node[k]);
  };

  visit(obj);
  return out;
}

// ---- Bounding box utilities (IoU + NMS) ----
function toXYXY(p) {
  if (
    typeof p.x !== "number" ||
    typeof p.y !== "number" ||
    typeof p.width !== "number" ||
    typeof p.height !== "number"
  ) {
    return null;
  }
  const x1 = p.x - p.width / 2;
  const y1 = p.y - p.height / 2;
  const x2 = p.x + p.width / 2;
  const y2 = p.y + p.height / 2;
  return { x1, y1, x2, y2 };
}

function iou(a, b) {
  const A = toXYXY(a);
  const B = toXYXY(b);
  if (!A || !B) return 0;

  const ix1 = Math.max(A.x1, B.x1);
  const iy1 = Math.max(A.y1, B.y1);
  const ix2 = Math.min(A.x2, B.x2);
  const iy2 = Math.min(A.y2, B.y2);

  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;

  const areaA = Math.max(0, A.x2 - A.x1) * Math.max(0, A.y2 - A.y1);
  const areaB = Math.max(0, B.x2 - B.x1) * Math.max(0, B.y2 - B.y1);
  const union = areaA + areaB - inter;

  if (union <= 0) return 0;
  return inter / union;
}

function nms(preds, iouThreshold = 0.5) {
  const sorted = [...preds].sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  const kept = [];

  for (const p of sorted) {
    let overlapped = false;
    for (const k of kept) {
      if (iou(p, k) >= iouThreshold) {
        overlapped = true;
        break;
      }
    }
    if (!overlapped) kept.push(p);
  }
  return kept;
}

function pickBest16Unique(predsRaw, { iouThreshold = 0.5, minConf = 0.2 } = {}) {
  const preds = predsRaw.filter((p) => (p.confidence ?? 0) >= minConf);

  const afterNms = nms(preds, iouThreshold);

  const parsed = afterNms
    .map((p) => {
      const parsedCard = parseCardLabel(p.class);
      if (!parsedCard) return null;
      return {
        rank: parsedCard.rank,
        suit: parsedCard.suit,
        code: parsedCard.code,
        confidence: p.confidence,
        bbox: { x: p.x, y: p.y, width: p.width, height: p.height },
        rawClass: p.class,
      };
    })
    .filter(Boolean);

  const byCode = new Map();
  for (const c of parsed) {
    const prev = byCode.get(c.code);
    if (!prev || c.confidence > prev.confidence) byCode.set(c.code, c);
  }

  const uniqueSorted = [...byCode.values()].sort((a, b) => b.confidence - a.confidence);
  const cards16 = uniqueSorted.slice(0, 16);

  return {
    cards16,
    debug: {
      predsIn: predsRaw.length,
      predsAfterMinConf: preds.length,
      predsAfterNms: afterNms.length,
      parsedCards: parsed.length,
      uniqueCards: uniqueSorted.length,
      picked: cards16.length,
    },
  };
}

// ---------- roboflow call (JSON base64 - more reliable for workflows) ----------
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

  const url = `${apiUrl.replace(/\/$/, "")}/${workspace}/workflows/${workflowId}?api_key=${encodeURIComponent(
    apiKey
  )}`;

  const b64 = Buffer.from(imageBuffer).toString("base64");
  const type = mimeType || "image/jpeg";
  const dataUrl = `data:${type};base64,${b64}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      inputs: {
        image: dataUrl,
      },
    }),
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
    const pileSide = normalizePileSide(fields.pileSide || "BIDDER");
    const lastTrick = fields.lastTrick === "1" || fields.lastTrick === "true";

    const IOU_THRESHOLD = Number(process.env.IOU_THRESHOLD ?? 0.5);
    const MIN_CONF = Number(process.env.MIN_CONF ?? 0.2);

    const rf = await callRoboflowWorkflow({
      imageBuffer,
      mimeType: imageInfo?.mimeType || "image/jpeg",
    });

    const preds = extractPredictionsDeep(rf);

    const { cards16, debug } = pickBest16Unique(preds, {
      iouThreshold: IOU_THRESHOLD,
      minConf: MIN_CONF,
    });

    const points = computeBelotePoints(cards16, trumpSuit, lastTrick);

    const warnings = [];
    if (cards16.length !== 16) {
      warnings.push(
        `Detected ${cards16.length} unique cards (expected 16). Try: brighter light, less overlap, less glare, tighter framing.`
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
        ...debug,
        iouThreshold: IOU_THRESHOLD,
        minConf: MIN_CONF,
        totalPredictionsFound: preds.length,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
}