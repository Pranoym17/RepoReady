import { Hono } from "hono";
const app = new Hono();
app.get("/api/v1/health", (c) => c.json({ status: "ok", stage: "foundation" }));
app.notFound((c) =>
  c.json(
    { code: "NOT_AVAILABLE", message: "This feature is not available yet." },
    404,
  ),
);
app.onError((_error, c) =>
  c.json({ code: "INTERNAL_ERROR", message: "Please try again later." }, 500),
);
export default app;
