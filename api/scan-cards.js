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

/**
 * Parse card label coming from the model.
 * Supports:
 * - Standard: "10S", "9H", "QD", "JS", "AS", "7C"
 * - French ranks: "RS" (Roi=K), "DS" (Dame=Q), "VS" (Valet=J)
 * Also tolerates separators/spaces like "V-H", "D_C", "10 S"
 */
function parseCardLabel(label) {
  let raw = String(label || "").trim().toUpperCase();
  if (!raw) return null;

  // Remove common separators (keep only A-Z / 0-9)
  raw = raw.replace(/[^A-Z0-9]/g, "");
  if (raw.length < 2) return null;

  const suit = raw.slice(-1);
  let rank = raw.slice(0, -1);

  if (!["H", "D", "C", "S"].includes(suit)) return null;

  // Map French face letters -> standard ranks
  // R = Roi = King (K)
  // D = Dame = Queen (Q)
  // V = Valet = Jack (J)
  const FR_MAP = { R: "K", D: "Q", V: "J" };
  if (FR_MAP[rank]) rank = FR_MAP[rank];

  // optional tolerance if something outputs "1" for Ace
  if (rank === "1") rank = "A";

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
 * Extract predictions from a Roboflow workflow response.
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

/**
 * Pick best 16 UNIQUE cards by confidence.
 * If duplicates appear, keep the highest confidence for that card code.
 */
function pickBestUniqueCards(cards, n = 16) {
  const byCode = new Map(); // code -> best card
  for (const c of cards) {
    if (!c?.code) continue;
    const prev = byCode.get(c.code);
    if (!prev || (c.confidence ?? 0) > (prev.confidence ?? 0)) {
      byCode.set(c.code, c);
    }
  }

  return Array.from(byCode.values())
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .slice(0, n);
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

  const url = `${apiUrl.replace(/\/$/, "")}/${workspace}/workflows/${workflowId}?api_key=${encodeURIComponent(
    apiKey
  )}`;

  // NOTE: In Vercel Node runtime, FormData/Blob are available in modern runtimes.
  const form = new FormData();
  const blob = new Blob([imageBuffer], { type: mimeType || "image/jpeg" });
  form.append("image", blob, "upload.jpg");

  const resp = await fetch(url, {
    method: "POST",
    body: form,
    headers: {
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
          imageInfo = info; // { filename, mimeType }
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

    // 2) extract predictions
    const preds = extractPredictionsDeep(rf);

    // 3) convert labels to cards
    const cardsAll = preds
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
        rawClass: x.class, // helpful debug
      }))
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));

    // 4) pick best 16 unique
    const cards16 = pickBestUniqueCards(cardsAll, 16);

    // 5) compute points
    const points = computeBelotePoints(cards16, trumpSuit, lastTrick);

    const warnings = [];
    if (cards16.length !== 16) {
      warnings.push(
        `Detected ${cards16.length} unique cards (expected 16). Try less overlap, more light, less glare, zoom in.`
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
        parsedCardsFound: cardsAll.length,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
}