// api/scan-cards.js
import Busboy from "busboy";

export const config = {
  api: {
    bodyParser: false, // IMPORTANT: we parse multipart ourselves
  },
};

// Helper: read a stream into a Buffer
function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (d) => chunks.push(d));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

// MVP mock "points" calculator (placeholder)
// Later we'll replace this with actual card recognition + belote scoring rules.
function mockComputePoints({ trumpSuit, pileSide, lastTrick }) {
  // Give deterministic-ish points so you can test end-to-end.
  // Example: bidder pile tends to have more points.
  let base = pileSide === "BIDDER" ? 90 : 72;

  // Slight change by trump just to prove it flows through.
  const suitBump = { H: 2, D: 4, C: 6, S: 8 }[trumpSuit] ?? 0;
  base += suitBump;

  // Add last trick (+10) if checked
  if (lastTrick) base += 10;

  // Clamp to 0..162
  base = Math.max(0, Math.min(162, base));
  return base;
}

// MVP mock "detected cards"
function mockCards() {
  // Not real detection, just a plausible sample structure
  const suits = ["H", "D", "C", "S"];
  const ranks = ["7", "8", "9", "J", "Q", "K", "10", "A"];
  const out = [];
  for (let s of suits) {
    for (let r of ranks) out.push({ rank: r, suit: s });
  }
  return out.slice(0, 32);
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

    bb.on("field", (name, value) => {
      fields[name] = value;
    });

    bb.on("file", async (name, file, info) => {
      if (name !== "image") {
        // Drain unknown file fields
        file.resume();
        return;
      }
      imageInfo = info; // { filename, mimeType }
      imageBuffer = await streamToBuffer(file);
    });

    bb.on("error", (err) => {
      throw err;
    });

    bb.on("finish", () => {
      if (!imageBuffer || imageBuffer.length < 10) {
        res.status(400).json({ ok: false, error: "Missing image" });
        return;
      }

      const trumpSuit = (fields.trumpSuit || "S").toUpperCase();
      const pileSide = (fields.pileSide || "BIDDER").toUpperCase(); // BIDDER | NON
      const lastTrick = fields.lastTrick === "1" || fields.lastTrick === "true";

      // In MVP we don’t actually use imageBuffer yet — we just prove upload works.
      const points = mockComputePoints({ trumpSuit, pileSide, lastTrick });

      const warnings = [];
      if (imageBuffer.length < 50_000) warnings.push("Image looks low-res—try closer / better lighting.");
      if (!["H", "D", "C", "S"].includes(trumpSuit)) warnings.push("Unknown trump suit received.");

      res.status(200).json({
        ok: true,
        points,
        cards: mockCards(), // later: real detected cards
        warnings,
        meta: {
          receivedBytes: imageBuffer.length,
          mimeType: imageInfo.mimeType || "",
        },
      });
    });

    req.pipe(bb);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
}