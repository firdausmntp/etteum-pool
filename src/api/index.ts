import { Hono } from "hono";
import { accountsRouter } from "./accounts";
import { proxySettingsRouter } from "./proxy-settings";
import { statsRouter } from "./stats";
import { keysRouter } from "./keys";
import { vccRouter } from "./vcc";
import { proxyPoolRouter } from "./proxy-pool";
import { imageStudioRouter } from "./image-studio";
import { filtersRouter } from "./filters";
import { binApi } from "./bin";
import { integrationRouter } from "./integration";
import { oauthRouter } from "./oauth";
import { customModelsRouter } from "./custom-models";

export const apiRouter = new Hono();

apiRouter.route("/accounts", accountsRouter);
apiRouter.route("/settings", proxySettingsRouter);
apiRouter.route("/stats", statsRouter);
apiRouter.route("/keys", keysRouter);
apiRouter.route("/vcc", vccRouter);
apiRouter.route("/proxy-pool", proxyPoolRouter);
apiRouter.route("/image-studio", imageStudioRouter);
apiRouter.route("/filters", filtersRouter);
apiRouter.route("/bin", binApi);
apiRouter.route("/integration", integrationRouter);
apiRouter.route("/oauth", oauthRouter);
apiRouter.route("/custom-models", customModelsRouter);

apiRouter.get("/providers", (c) => {
  return c.json({ data: ["kiro", "kiro-pro", "codebuddy", "canva", "codex", "qoder"] });
});

// Health check
apiRouter.get("/health", (c) => {
  return c.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

apiRouter.get("/temp-debug-db", async (c) => {
  const { db } = await import("../db/index");
  const { accounts, customModels } = await import("../db/schema");
  const accountsData = await db.select().from(accounts);
  const customModelsData = await db.select().from(customModels);
  return c.json({ accounts: accountsData, customModels: customModelsData });
});
