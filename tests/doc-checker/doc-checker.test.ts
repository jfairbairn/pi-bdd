import { describe, it, expect } from "vitest";
import { checkDocConsistency, type DocCheckInput } from "../../extensions/bdd-enforcer/doc-checker.js";

function makeInput(overrides: Partial<DocCheckInput> = {}): DocCheckInput {
  return {
    deletedFiles: [],
    addedFiles: [],
    docFiles: [],
    ...overrides,
  };
}

describe("checkDocConsistency", () => {
  describe("deleted file references", () => {
    it("flags a doc that references a deleted prompt", () => {
      const result = checkDocConsistency(makeInput({
        deletedFiles: ["prompts/feature.md"],
        docFiles: [
          { path: "README.md", content: "Use `/feature` to start a new feature." },
        ],
      }));

      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues[0]).toMatch(/README\.md/);
      expect(result.issues[0]).toMatch(/feature/);
    });

    it("flags a skill that references a deleted prompt", () => {
      const result = checkDocConsistency(makeInput({
        deletedFiles: ["prompts/scenario.md"],
        docFiles: [
          { path: "skills/bdd-workflow/SKILL.md", content: "Use `/scenario` to add a scenario." },
        ],
      }));

      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues[0]).toMatch(/bdd-workflow/);
      expect(result.issues[0]).toMatch(/scenario/);
    });

    it("flags references to deleted skill directories", () => {
      const result = checkDocConsistency(makeInput({
        deletedFiles: ["skills/old-skill/SKILL.md"],
        docFiles: [
          { path: "README.md", content: "Load `old-skill` for details." },
        ],
      }));

      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues[0]).toMatch(/old-skill/);
    });

    it("flags references to deleted extension files", () => {
      const result = checkDocConsistency(makeInput({
        deletedFiles: ["extensions/old-ext.ts"],
        docFiles: [
          { path: "README.md", content: "The old-ext extension handles this." },
        ],
      }));

      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues[0]).toMatch(/old-ext/);
    });
  });

  describe("no issues", () => {
    it("returns empty issues when no docs reference deleted files", () => {
      const result = checkDocConsistency(makeInput({
        deletedFiles: ["prompts/feature.md"],
        docFiles: [
          { path: "README.md", content: "Use `/build` to work through the roadmap." },
        ],
      }));

      expect(result.issues).toEqual([]);
    });

    it("returns empty issues when nothing was deleted", () => {
      const result = checkDocConsistency(makeInput({
        deletedFiles: [],
        addedFiles: ["src/new-thing.ts"],
        docFiles: [
          { path: "README.md", content: "Some content." },
        ],
      }));

      expect(result.issues).toEqual([]);
    });

    it("returns empty issues when there are no doc files", () => {
      const result = checkDocConsistency(makeInput({
        deletedFiles: ["prompts/feature.md"],
        docFiles: [],
      }));

      expect(result.issues).toEqual([]);
    });
  });
});
