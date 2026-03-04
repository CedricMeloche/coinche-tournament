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

function parseCardLabel(label) {
  // expects like: "10S", "9H", "QD", "JS", "AS", "7C"
  const raw = String(label || "").trim().toUpperCase();
  if (!raw) return null;

  const suit = raw.slice(-1);
  const rank = raw.slice(0, -1);

  if (!["H", "D", "C", "S"].includes(suit)) return null;

  const ok = ["7", "8", "9", "10", "J", "Q", "K", "A"];
  if (!ok.includes(rank)) return null;

  return { rank, suit, code: `${rank}${suit}` };
}

// Belote/Coinche points
const TRUMP_POINTS = { J: 20, 9: 14, A: 11, "10": 10, K: 4, Q: 3, 8: 0, 7: 0 };
const NON_TRUMP_POINTS = { A: 11, "10": 10, K: 4, Q: 3, J: 2, 9: 0, 8: 0, 7: 0 };

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

// ---------- roboflow call (WORKFLOW = JSON inputs + base64) ----------
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

  // Workflow endpoint:
  // https://serverless.roboflow.com/<workspace>/workflows/<workflow_id>?api_key=...
  const url = `${apiUrl.replace(/\/$/, "")}/${workspace}/workflows/${workflowId}?api_key=${encodeURIComponent(
    apiKey
  )}`;

  const mt = mimeType || "image/jpeg";
  const b64 = imageBuffer.toString("base64");
  const dataUrl = `data:${mt};base64,${b64}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
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
    // This is what you saw before: "Internal Server Error" text instead of JSON
    throw new Error(`Roboflow returned non-JSON (status ${resp.status}): ${text.slice(0, 300)}`);
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

    // 2) extract predictions
    const preds = extractPredictionsDeep(rf);

    // 3) parse to cards
    const parsedCards = preds
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

    // 4) de-dupe by exact card code (keep best confidence)
    const bestByCode = new Map();
    for (const c of parsedCards) {
      const prev = bestByCode.get(c.code);
      if (!prev || c.confidence > prev.confidence) bestByCode.set(c.code, c);
    }
    const deduped = Array.from(bestByCode.values()).sort((a, b) => b.confidence - a.confidence);

    // 5) choose 16 cards
    const cards16 = deduped.slice(0, 16);

    // 6) compute points
    const points = computeBelotePoints(cards16, trumpSuit, lastTrick);

    const warnings = [];
    if (cards16.length !== 16) {
      warnings.push(
        `Detected ${cards16.length} unique cards (expected 16). Try better lighting / less overlap.`
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
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
}