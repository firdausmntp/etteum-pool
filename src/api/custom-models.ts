import { Hono } from "hono";
import { db } from "../db/index";
import { customModels } from "../db/schema";
import { eq, asc } from "drizzle-orm";
import { loadCustomModelsCache } from "../proxy/providers/registry";
import { broadcast } from "../ws/index";

export const customModelsRouter = new Hono();

// GET all custom models
customModelsRouter.get("/", async (c) => {
  try {
    const models = await db.select().from(customModels).orderBy(asc(customModels.modelId));
    return c.json({ count: models.length, data: models });
  } catch (error: any) {
    return c.json({ error: error.message || "Failed to fetch custom models" }, 500);
  }
});

// POST create custom model
customModelsRouter.post("/", async (c) => {
  try {
    const body = await c.req.json<{
      modelId: string;
      ownedBy: string;
      contextWindow?: number;
      maxOutput?: number;
      thinking?: boolean;
      vision?: boolean;
    }>();

    const modelId = (body.modelId || "").trim();
    const ownedBy = (body.ownedBy || "").trim();

    if (!modelId) {
      return c.json({ error: "modelId is required" }, 400);
    }
    if (!ownedBy) {
      return c.json({ error: "ownedBy is required" }, 400);
    }

    // Check if modelId already exists in custom_models
    const existing = await db.select().from(customModels).where(eq(customModels.modelId, modelId)).limit(1);
    if (existing.length > 0) {
      return c.json({ error: `Model ID "${modelId}" already exists` }, 400);
    }

    const [created] = await db
      .insert(customModels)
      .values({
        modelId,
        ownedBy,
        contextWindow: typeof body.contextWindow === "number" ? body.contextWindow : 200000,
        maxOutput: typeof body.maxOutput === "number" ? body.maxOutput : 65536,
        thinking: Boolean(body.thinking),
        vision: Boolean(body.vision),
      })
      .returning();

    // Refresh memory cache
    await loadCustomModelsCache();

    // Notify clients
    broadcast({ type: "models_updated", data: {} });

    return c.json(created, 201);
  } catch (error: any) {
    return c.json({ error: error.message || "Failed to create custom model" }, 500);
  }
});

// PUT update custom model
customModelsRouter.put("/:id", async (c) => {
  try {
    const id = Number(c.req.param("id"));
    const body = await c.req.json<{
      modelId?: string;
      ownedBy?: string;
      contextWindow?: number;
      maxOutput?: number;
      thinking?: boolean;
      vision?: boolean;
    }>();

    const updates: Record<string, any> = { updatedAt: new Date() };

    if (body.modelId !== undefined) {
      const modelId = (body.modelId || "").trim();
      if (!modelId) {
        return c.json({ error: "modelId cannot be empty" }, 400);
      }
      // Check for duplicate modelId if it's changing
      const duplicate = await db.select().from(customModels).where(eq(customModels.modelId, modelId)).limit(1);
      if (duplicate.length > 0 && duplicate[0].id !== id) {
        return c.json({ error: `Model ID "${modelId}" is already taken` }, 400);
      }
      updates.modelId = modelId;
    }

    if (body.ownedBy !== undefined) {
      const ownedBy = (body.ownedBy || "").trim();
      if (!ownedBy) {
        return c.json({ error: "ownedBy cannot be empty" }, 400);
      }
      updates.ownedBy = ownedBy;
    }

    if (body.contextWindow !== undefined) {
      updates.contextWindow = typeof body.contextWindow === "number" ? body.contextWindow : 200000;
    }

    if (body.maxOutput !== undefined) {
      updates.maxOutput = typeof body.maxOutput === "number" ? body.maxOutput : 65536;
    }

    if (body.thinking !== undefined) {
      updates.thinking = Boolean(body.thinking);
    }

    if (body.vision !== undefined) {
      updates.vision = Boolean(body.vision);
    }

    const [updated] = await db
      .update(customModels)
      .set(updates)
      .where(eq(customModels.id, id))
      .returning();

    if (!updated) {
      return c.json({ error: "Custom model not found" }, 404);
    }

    // Refresh memory cache
    await loadCustomModelsCache();

    // Notify clients
    broadcast({ type: "models_updated", data: {} });

    return c.json(updated);
  } catch (error: any) {
    return c.json({ error: error.message || "Failed to update custom model" }, 500);
  }
});

// DELETE custom model
customModelsRouter.delete("/:id", async (c) => {
  try {
    const id = Number(c.req.param("id"));
    const deleted = await db.delete(customModels).where(eq(customModels.id, id)).returning();

    if (deleted.length === 0) {
      return c.json({ error: "Custom model not found" }, 404);
    }

    // Refresh memory cache
    await loadCustomModelsCache();

    // Notify clients
    broadcast({ type: "models_updated", data: {} });

    return c.json({ success: true });
  } catch (error: any) {
    return c.json({ error: error.message || "Failed to delete custom model" }, 500);
  }
});
