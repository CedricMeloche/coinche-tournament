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
  return ["H", "D", "C", "S"].includes(up) ? up : "S";
}

function normalizePileSide(s) {
  const up = String(s || "").toUpperCase();
  return up === "BIDDER" ? "BIDDER" : "NON";
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
 * Extract predictions from Roboflow responses.
 * We search deep for arrays/objects containing { class/label, confidence }.
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

// ---------- roboflow call (WORKFLOW) ----------
async function callRoboflowWorkflow({ imageBuffer, mimeType }) {
  const apiUrl = (process.env.ROBOFLOW_API_URL || "https://detect.roboflow.com").replace(/\/$/, "");
  const apiKey = process.env.ROBOFLOW_API_KEY;
  const workspace = process.env.ROBOFLOW_WORKSPACE;
  const workflowId = process.env.ROBOFLOW_WORKFLOW_ID;

  if (!apiKey || !workspace || !workflowId) {
    throw new Error(
      "Missing Roboflow env vars. Set ROBOFLOW_API_KEY, ROBOFLOW_WORKSPACE, ROBOFLOW_WORKFLOW_ID."
    );
  }

  // Correct workflow endpoint:
  // https://detect.roboflow.com/infer/workflows/{workspace}/{workflowId}?api_key=...
  const url = `${apiUrl}/infer/workflows/${encodeURIComponent(
    workspace
  )}/${encodeURIComponent(workflowId)}?api_key=${encodeURIComponent(apiKey)}`;

  // Base64 payload is very reliable in serverless
  const base64 = imageBuffer.toString("base64");
  const dataUri = `data:${mimeType || "image/jpeg"};base64,${base64}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      // Roboflow accepts "image" as a base64 data URI for hosted inference
      image: dataUri,
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

    // 1) call workflow
    const rf = await callRoboflowWorkflow({
      imageBuffer,
      mimeType: imageInfo?.mimeType || "image/jpeg",
    });

    // 2) extract predictions
    const preds = extractPredictionsDeep(rf);

    // 3) convert labels to cards
    const cards = preds
      .map((p) => ({ ...p, parsed: parseCardLabel(p.class) }))
      .filter((x) => x.parsed)
      .map((x) => ({
        rank: x.parsed.rank,
        suit: x.parsed.suit,
        code: x.parsed.code,
        confidence: x.confidence,
      }))
      .sort((a, b) => b.confidence - a.confidence);

    // 4) choose 16 cards
    const cards16 = cards.slice(0, 16);

    // 5) compute points
    const points = computeBelotePoints(cards16, trumpSuit, lastTrick);

    const warnings = [];
    if (cards16.length !== 16) {
      warnings.push(`Detected ${cards16.length} cards (expected 16). Try better lighting / less overlap.`);
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
        roboflowApiUrl: process.env.ROBOFLOW_API_URL || "https://detect.roboflow.com",
        roboflowWorkflowId: process.env.ROBOFLOW_WORKFLOW_ID || "",
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
}