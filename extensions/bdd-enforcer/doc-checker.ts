/**
 * Doc Consistency Checker
 *
 * Pure function that checks documentation files for references to
 * deleted files (prompts, skills, extensions). Called during the
 * IDLE transition to flag stale references before the closing commit.
 */

import * as path from "node:path";

export interface DocCheckInput {
  deletedFiles: string[];
  addedFiles: string[];
  docFiles: Array<{ path: string; content: string }>;
}

export interface DocCheckResult {
  issues: string[];
}

/**
 * Derive searchable names from a deleted file path.
 *
 * For prompts:   "prompts/feature.md"     → ["/feature", "`feature`"]
 * For skills:    "skills/old-skill/SKILL.md" → ["`old-skill`", "old-skill"]
 * For extensions: "extensions/old-ext.ts"  → ["old-ext"]
 */
function deriveSearchTerms(filePath: string): { terms: string[]; label: string } {
  const parts = filePath.split("/");

  // Prompts: prompts/name.md → /name command reference
  if (parts[0] === "prompts" && parts.length === 2) {
    const name = path.basename(parts[1], path.extname(parts[1]));
    return {
      terms: [`/${name}`, `\`${name}\``],
      label: `prompt /${name}`,
    };
  }

  // Skills: skills/name/SKILL.md → backtick or plain name reference
  if (parts[0] === "skills" && parts.length >= 2) {
    const name = parts[1];
    return {
      terms: [`\`${name}\``, name],
      label: `skill \`${name}\``,
    };
  }

  // Extensions: extensions/name.ts or extensions/name/index.ts
  if (parts[0] === "extensions") {
    const name = parts.length >= 3
      ? parts[1]  // directory-style: extensions/name/index.ts
      : path.basename(parts[1], path.extname(parts[1]));
    return {
      terms: [name],
      label: `extension ${name}`,
    };
  }

  // Generic: just use the filename
  const name = path.basename(filePath, path.extname(filePath));
  return {
    terms: [name],
    label: filePath,
  };
}

export function checkDocConsistency(input: DocCheckInput): DocCheckResult {
  const issues: string[] = [];

  for (const deleted of input.deletedFiles) {
    const { terms, label } = deriveSearchTerms(deleted);

    for (const doc of input.docFiles) {
      for (const term of terms) {
        if (doc.content.includes(term)) {
          issues.push(
            `${doc.path} references ${label} (deleted: ${deleted})`,
          );
          break; // one issue per doc per deleted file
        }
      }
    }
  }

  return { issues };
}
