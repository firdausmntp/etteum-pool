import { Hono } from "hono";
import { db } from "../db";
import { modelCombos } from "../db/schema";
import { eq } from "drizzle-orm";
import { invalidateComboCache } from "../proxy/router";

const combosRouter = new Hono();

/**
 * GET /api/model-combos - List all combos
 */
combosRouter.get("/", async (c) => {
  const rows = await db.select().from(modelCombos).orderBy(modelCombos.name);
  return c.json({ combos: rows });
});

/**
 * GET /api/model-combos/:name - Get a single combo by name
 */
combosRouter.get("/:name", async (c) => {
  const name = c.req.param("name");
  const row = await db.select().from(modelCombos).where(eq(modelCombos.name, name)).then((r) => r[0]);
  if (!row) return c.json({ error: "Combo not found" }, 404);
  return c.json({ combo: row });
});

/**
 * POST /api/model-combos - Create a new combo
 * Body: { name: string, label?: string, models: string[] }
 */
combosRouter.post("/", async (c) => {
  const body = await c.req.json() as { name?: string; label?: string; models?: string[] };
  const { name, label, models } = body;
  if (!name || !models || models.length === 0) {
    return c.json({ error: "name and models (non-empty array) are required" }, 400);
  }
  // Validate model names are non-empty strings
  for (const m of models) {
    if (typeof m !== "string" || m.trim() === "") {
      return c.json({ error: `Invalid model name: "${m}"` }, 400);
    }
  }

  try {
    const result = await db.insert(modelCombos).values({
      name: name.trim(),
      label: label || null,
      modelsJson: models.map((m) => m.trim()),
      enabled: true,
    }).returning();
    invalidateComboCache();
    return c.json({ success: true, combo: result[0] }, 201);
  } catch (error: any) {
    if (error?.code === "SQLITE_CONSTRAINT_UNIQUE" || error?.message?.includes("unique")) {
      return c.json({ error: `Combo "${name}" already exists` }, 409);
    }
    return c.json({ error: `Failed to create combo: ${error.message}` }, 500);
  }
});

/**
 * PUT /api/model-combos/:name - Update a combo
 * Body: { name?: string, label?: string, models?: string[], enabled?: boolean }
 */
combosRouter.put("/:name", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json() as { name?: string; label?: string; models?: string[]; enabled?: boolean };

  const existing = await db.select().from(modelCombos).where(eq(modelCombos.name, name)).then((r) => r[0]);
  if (!existing) return c.json({ error: "Combo not found" }, 404);

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name.trim();
  if (body.label !== undefined) updates.label = body.label;
  if (body.models !== undefined) {
    if (!Array.isArray(body.models) || body.models.length === 0) {
      return c.json({ error: "models must be a non-empty array" }, 400);
    }
    updates.modelsJson = body.models.map((m: string) => m.trim());
  }
  if (body.enabled !== undefined) updates.enabled = body.enabled;

  try {
    const result = await db.update(modelCombos)
      .set(updates)
      .where(eq(modelCombos.name, name))
      .returning();
    invalidateComboCache();
    return c.json({ success: true, combo: result[0] });
  } catch (error: any) {
    return c.json({ error: `Failed to update combo: ${error.message}` }, 500);
  }
});

/**
 * DELETE /api/model-combos/:name - Delete a combo
 */
combosRouter.delete("/:name", async (c) => {
  const name = c.req.param("name");
  const existing = await db.select().from(modelCombos).where(eq(modelCombos.name, name)).then((r) => r[0]);
  if (!existing) return c.json({ error: "Combo not found" }, 404);

  await db.delete(modelCombos).where(eq(modelCombos.name, name));
  invalidateComboCache();
  return c.json({ success: true });
});

export { combosRouter };
