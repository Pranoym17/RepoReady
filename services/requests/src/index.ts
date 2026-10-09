import { Hono } from "hono";
import type { PublicErrorValue } from "@repoready/contracts";
const app = new Hono();
app.get("/api/v1/health", (c) => c.json({ status: "ok", stage: "foundation" }));
app.notFound((c) =>
  c.json(
    { code: "NOT_AVAILABLE", retryable: false } satisfies PublicErrorValue,
    404,
  ),
);
app.onError((_error, c) =>
  c.json(
    { code: "INTERNAL_ERROR", retryable: true } satisfies PublicErrorValue,
    500,
  ),
);
export default app;
