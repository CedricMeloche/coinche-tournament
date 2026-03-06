export const config = { api: { bodyParser: true } };

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
      });
    }

    const base = apiUrl.replace(/\/$/, "");
    const url = `${base}/${workspace}/workflows/${workflowId}`;

    const body = {
      api_key: apiKey,
      inputs: {
        image: {
          type: "base64",
          value: `data:image/png;base64,${ONE_PIXEL_PNG_BASE64}`,
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

    res.status(200).json({
      ok: true,
      url: `${base}/${workspace}/workflows/${workflowId}`,
      status: resp.status,
      statusText: resp.statusText,
      bodyPreview: text.slice(0, 700),
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e?.message || "error",
    });
  }
}