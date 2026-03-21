/**
 * Shared PRODUCT.md parsing utilities.
 * Used by telemetry-access (check_success_conditions, query_signals)
 * to extract HogQL queries and success condition targets.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface ProductQuery {
  featureName: string;
  condition: string;
  query: string;
  target: number | null;
  targetStr: string;
}

/**
 * Parse PRODUCT.md and extract all HogQL queries with their targets.
 * Returns an empty array if PRODUCT.md doesn't exist or has no queries.
 *
 * Format expected in PRODUCT.md:
 *   ### Feature Name
 *   - Condition description
 *   ```sql
 *   SELECT ... FROM events ...
 *   -- target: 0.70
 *   ```
 */
export function parseProductMdQueries(cwd: string): ProductQuery[] {
  const productPath = path.join(cwd, "PRODUCT.md");
  if (!fs.existsSync(productPath)) return [];

  const content = fs.readFileSync(productPath, "utf8");
  const results: ProductQuery[] = [];

  const featureSections = content.split(/^### /m).slice(1);

  for (const section of featureSections) {
    const featureName = section.split("\n")[0]?.trim() ?? "Unknown";
    const queryBlocks = [...section.matchAll(/```(?:sql|hogql)\n([\s\S]*?)```/gi)];

    for (const block of queryBlocks) {
      const rawQuery = block[1]?.trim() ?? "";

      // Extract target from comment: -- target: 0.70  or  -- target: >= 0.70
      const targetMatch = rawQuery.match(/--\s*target:\s*(>=?\s*)?([\d.]+)/i);
      const targetStr = targetMatch ? `${targetMatch[1] ?? ""}${targetMatch[2]}` : "";
      const target = targetMatch ? parseFloat(targetMatch[2]) : null;

      // Clean query (strip comment lines)
      const cleanQuery = rawQuery.replace(/--[^\n]*/g, "").trim();
      if (!cleanQuery) continue;

      // Find the nearest preceding bullet point as the condition description
      const beforeBlock = section.slice(0, section.indexOf(block[0]));
      const conditionLines = beforeBlock.split("\n").filter((l) => l.trim().startsWith("-")).slice(-1);
      const condition = conditionLines[0]?.replace(/^[-*]\s*/, "").trim() ?? featureName;

      results.push({ featureName, condition, query: cleanQuery, target, targetStr });
    }
  }

  return results;
}

/** True if PRODUCT.md exists and has at least one success condition. */
export function hasSuccessConditions(cwd: string): boolean {
  const productPath = path.join(cwd, "PRODUCT.md");
  if (!fs.existsSync(productPath)) return false;
  const content = fs.readFileSync(productPath, "utf8").toLowerCase();
  return content.includes("success condition") ||
    content.includes("## success") ||
    content.includes("we will know");
}

/** True if PRODUCT.md has at least one embedded HogQL query. */
export function hasHogQLQueries(cwd: string): boolean {
  const productPath = path.join(cwd, "PRODUCT.md");
  if (!fs.existsSync(productPath)) return false;
  return /```(?:sql|hogql)/i.test(fs.readFileSync(productPath, "utf8"));
}
