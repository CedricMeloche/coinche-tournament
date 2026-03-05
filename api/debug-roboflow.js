export default function handler(req, res) {
  res.status(200).json({
    hasKey: !!process.env.ROBOFLOW_API_KEY,
    keyPrefix: process.env.ROBOFLOW_API_KEY
      ? process.env.ROBOFLOW_API_KEY.slice(0, 6)
      : null,
    url: process.env.ROBOFLOW_API_URL || null,
    workspace: process.env.ROBOFLOW_WORKSPACE || null,
    workflow: process.env.ROBOFLOW_WORKFLOW_ID || null,
  });
}