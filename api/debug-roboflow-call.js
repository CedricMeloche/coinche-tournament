export const config = { api: { bodyParser: true } };

// Tiny 1x1 transparent PNG
const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";

export default async function handler(req, res) {
  try {
    const apiUrl = process.env.ROBOFLOW_API_URL || "https://serverless.roboflow.com";
    const apiKey = process.env.ROBOFLOW_API_KEY;
    const workspace = process.env.ROBOFLOW_WORKSPACE;
    const workflowId = process.env.ROBOFLOW_WORKFLOW_ID;

    if (!apiKey || !workspace || !workflowId) {
      return res.status(500).json({
        ok: false,
        error: "Missing env vars",
        hasKey: !!apiKey,
        workspace,
        workflowId,
        apiUrl,
      });
    }

    const base = apiUrl.replace(/\/$/, "");
    const url =
      `${base}/infer/workflows/${encodeURIComponent(workspace)}/${encodeURIComponent(workflowId)}` +
      `?api_key=${encodeURIComponent(apiKey)}`;

    const body = {
      inputs: {
        image: { type: "base64", value: `data:image/png;base64,${ONE_PIXEL_PNG_BASE64}` },
      },
    };

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "x-api-key": apiKey,
      },
      body: JSON.stringify(body),
    });

    const text = await resp.text();

    // Return status + raw text (first part) so we see EXACTLY what Roboflow says
    return res.status(200).json({
      ok: resp.ok,
      status: resp.status,
      statusText: resp.statusText,
      urlUsed: url.replace(apiKey, "****"),
      responsePreview: text.slice(0, 800),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
}