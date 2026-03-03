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

// Parse multipart/form-data with Busboy and WAIT for file buffers to finish
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers });

    const fields = {};
    const files = {}; // { fieldName: { buffer, info } }
    const filePromises = [];

    bb.on("field", (name, value) => {
      fields[name] = value;
    });

    bb.on("file", (name, file, info) => {
      // Always drain streams; but if it's the image we store it.
      const p = streamToBuffer(file)
        .then((buffer) => {
          files[name] = { buffer, info };
        })
        .catch((err) => {
          // Ensure the stream is drained on error too
          try {
            file.resume();
          } catch {}
          throw err;
        });

      filePromises.push(p);
    });

    bb.on("error", (err) => reject(err));

    bb.on("finish", () => {
      Promise.all(filePromises)
        .then(() => resolve({ fields, files }))
        .catch(reject);
    });

    req.pipe(bb);
  });
}

// MVP mock "points" calculator (placeholder)
function mockComputePoints({ trumpSuit, pileSide, lastTrick }) {
  let base = pileSide === "BIDDER" ? 90 : 72;

  const suitBump = { H: 2, D: 4, C: 6, S: 8 }[trumpSuit] ?? 0;
  base += suitBump;

  if (lastTrick) base += 10;

  base = Math.max(0, Math.min(162, base));
  return base;
}

// MVP mock "detected cards"
function mockCards() {
  const suits = ["H", "D", "C", "S"];
  const ranks = ["7", "8", "9", "J", "Q", "K", "10", "A"];
  const out = [];
  for (let s of suits) for (let r of ranks) out.push({ rank: r, suit: s });
  return out.slice(0, 32);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Use POST" });
    return;
  }

  // Helpful guard: ensure multipart/form-data
  const ct = (req.headers["content-type"] || "").toLowerCase();
  if (!ct.includes("multipart/form-data")) {
    res.status(400).json({
      ok: false,
      error:
        "Expected multipart/form-data. Make sure you are sending FormData with an 'image' field.",
    });
    return;
  }

  try {
    const { fields, files } = await parseMultipart(req);

    const img = files.image; // MUST match frontend: form.append("image", ...)
    const imageBuffer = img?.buffer || null;
    const imageInfo = img?.info || { filename: "", mimeType: "" };

    if (!imageBuffer || imageBuffer.length < 10) {
      res.status(400).json({
        ok: false,
        error:
          "Missing image. Ensure the FormData field is named 'image' and you captured a photo before submitting.",
        debug: {
          receivedFileFields: Object.keys(files),
          receivedTextFields: Object.keys(fields),
        },
      });
      return;
    }

    const trumpSuit = String(fields.trumpSuit || "S").toUpperCase();
    const pileSide = String(fields.pileSide || "BIDDER").toUpperCase(); // BIDDER | NON
    const lastTrick = fields.lastTrick === "1" || fields.lastTrick === "true";

    const points = mockComputePoints({ trumpSuit, pileSide, lastTrick });

    const warnings = [];
    if (imageBuffer.length < 50_000)
      warnings.push("Image looks low-res—try closer / better lighting.");
    if (!["H", "D", "C", "S"].includes(trumpSuit))
      warnings.push("Unknown trump suit received.");

    res.status(200).json({
      ok: true,
      points,
      cards: mockCards(),
      warnings,
      meta: {
        receivedBytes: imageBuffer.length,
        mimeType: imageInfo.mimeType || "",
        filename: imageInfo.filename || "",
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
}