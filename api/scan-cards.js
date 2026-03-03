// api/scan-cards.js
import Busboy from "busboy";

export const config = {
  api: {
    bodyParser: false, // IMPORTANT: we parse multipart ourselves
  },
};

/**
 * Parse multipart/form-data with Busboy in a way that guarantees
 * file buffers are ready before resolving.
 */
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers });

    const fields = {};
    let imageBuffer = null;
    let imageInfo = { filename: "", mimeType: "" };

    const filePromises = [];

    bb.on("field", (name, value) => {
      fields[name] = value;
    });

    bb.on("file", (name, file, info) => {
      if (name !== "image") {
        file.resume();
        return;
      }

      imageInfo = info; // { filename, mimeType }
      const p = streamToBuffer(file).then((buf) => {
        imageBuffer = buf;
      });

      filePromises.push(p);
    });

    bb.on("error", reject);

    bb.on("finish", async () => {
      try {
        await Promise.all(filePromises);
        resolve({ fields, imageBuffer, imageInfo });
      } catch (e) {
        reject(e);
      }
    });

    req.pipe(bb);
  });
}

// Helper: read a stream into a Buffer
function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (d) => chunks.push(d));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/**
 * ✅ Belote/Coinche TRICK POINTS (as per your chart)
 * Trump:    J 20, 9 14, A 11, 10 10, K 4, Q 3, 8 0, 7 0
 * NonTrump: A 11, 10 10, K 4, Q 3, J 2,  9 0, 8 0, 7 0
 */
const TRUMP_POINTS = { J: 20, 9: 14, A: 11, "10": 10, K: 4, Q: 3, 8: 0, 7: 0 };
const NON_TRUMP_POINTS = { A: 11, "10": 10, K: 4, Q: 3, J: 2, 9: 0, 8: 0, 7: 0 };

function normalizeRank(r) {
  const s = String(r ?? "").toUpperCase().trim();
  if (s === "1" || s === "T") return "10";
  return s;
}
function normalizeSuit(s) {
  return String(s ?? "").toUpperCase().trim(); // H D C S
}

function scoreCard(card, trumpSuit) {
  const suit = normalizeSuit(card?.suit);
  const rank = normalizeRank(card?.rank);

  const isTrump = suit === normalizeSuit(trumpSuit);
  const table = isTrump ? TRUMP_POINTS : NON_TRUMP_POINTS;

  // if unknown rank, treat as 0 but warn upstream
  return Number(table[rank] ?? 0);
}

function computeTrickPoints({ cards, trumpSuit, lastTrick }) {
  const warnings = [];
  const seen = new Set();

  let total = 0;
  const breakdown = [];

  for (const c of Array.isArray(cards) ? cards : []) {
    const suit = normalizeSuit(c?.suit);
    const rank = normalizeRank(c?.rank);
    const key = `${rank}${suit}`;

    // Basic validation
    if (!["H", "D", "C", "S"].includes(suit)) warnings.push(`Unknown suit: "${c?.suit}"`);
    if (!["7", "8", "9", "J", "Q", "K", "10", "A"].includes(rank))
      warnings.push(`Unknown rank: "${c?.rank}"`);

    // Duplicate detection (helps debug recognizer)
    if (seen.has(key)) warnings.push(`Duplicate card detected: ${key}`);
    seen.add(key);

    const pts = scoreCard({ rank, suit }, trumpSuit);
    total += pts;

    breakdown.push({
      rank,
      suit,
      trump: suit === normalizeSuit(trumpSuit),
      points: pts,
    });
  }

  if (lastTrick) total += 10;

  // Clamp per pile (0..162)
  total = Math.max(0, Math.min(162, total));

  return { points: total, breakdown, warnings };
}

/**
 * TEMP (until real CV): produce a deterministic mock set of cards based on the image
 * so points vary from photo to photo, but remain stable for the same image.
 */
function hashBuffer(buf) {
  // small fast hash (not crypto)
  let h = 2166136261;
  for (let i = 0; i < buf.length; i++) {
    h ^= buf[i];
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function fullDeck32() {
  const suits = ["H", "D", "C", "S"];
  const ranks = ["7", "8", "9", "J", "Q", "K", "10", "A"];
  const out = [];
  for (const s of suits) for (const r of ranks) out.push({ rank: r, suit: s });
  return out; // 32
}
function pickMockCardsFromImage(imageBuffer) {
  const seed = hashBuffer(imageBuffer);
  const rand = mulberry32(seed);

  const deck = fullDeck32();
  // Fisher-Yates shuffle using seeded RNG
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  // pile size should be multiple of 4, between 4 and 32
  const pileTricks = (seed % 8) + 1; // 1..8
  const pileSize = pileTricks * 4;

  return deck.slice(0, pileSize);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Use POST" });
    return;
  }

  try {
    const { fields, imageBuffer, imageInfo } = await parseMultipart(req);

    if (!imageBuffer || imageBuffer.length < 10) {
      res.status(400).json({ ok: false, error: "Missing image" });
      return;
    }

    const trumpSuit = normalizeSuit(fields.trumpSuit || "S");
    const pileSide = String(fields.pileSide || "BIDDER").toUpperCase(); // BIDDER | NON
    const lastTrick = fields.lastTrick === "1" || fields.lastTrick === "true";

    // ✅ TEMP: mock detected cards (replace this with real recognition later)
    const cards = pickMockCardsFromImage(imageBuffer);

    const { points, breakdown, warnings } = computeTrickPoints({
      cards,
      trumpSuit,
      lastTrick,
    });

    // Extra warnings
    if (imageBuffer.length < 50_000) {
      warnings.push("Image looks low-res—try closer / better lighting.");
    }
    if (!["H", "D", "C", "S"].includes(trumpSuit)) {
      warnings.push("Unknown trump suit received.");
    }
    if (!["BIDDER", "NON"].includes(pileSide)) {
      warnings.push("Unknown pileSide received.");
    }

    res.status(200).json({
      ok: true,
      points,
      cards, // detected cards (mock for now)
      breakdown, // points per card (super useful to debug)
      warnings,
      meta: {
        receivedBytes: imageBuffer.length,
        mimeType: imageInfo?.mimeType || "",
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
}