/**
 * BDD Git Checkpoint Extension
 *
 * Auto-commits at every BDD phase boundary with meaningful commit messages.
 * Listens to the bdd:phase_change event emitted by bdd-enforcer.
 *
 * Commit conventions (feature cycles):
 *   AWAITING_RED → RED  : test(red): failing spec for <layer>
 *   GREEN → RED         : test(red): new failing spec for <layer>   ← inner loop shortcut
 *   RED → GREEN         : feat(green): implement <layer>
 *   GREEN → REFACTOR    : refactor: begin cleanup of <layer>
 *   * → IDLE            : refactor: complete <feature>
 *
 * Commit conventions (bug cycles):
 *   AWAITING_RED → RED  : test(regression): failing test for <subject>
 *   GREEN → RED         : test(regression): new failing test for <subject>
 *   RED → GREEN         : fix: <subject>
 *   GREEN → REFACTOR    : refactor: cleanup after fix of <subject>
 *   * → IDLE            : refactor: complete bugfix <subject>
 *
 * Also hooks session_before_fork to offer restoring code to a prior BDD phase.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface PhaseChangeEvent {
  from: string;
  to: string;
  cycleType?: "feature" | "bug";
  featureName?: string;
  layer?: string;
  issueRef?: string;
  testResult?: { passed: number; failed: number };
}

interface Checkpoint {
  phase: string;
  stashRef: string;
  featureName?: string;
  layer?: string;
}

export default function (pi: ExtensionAPI) {
  // Map from session entry ID → checkpoint (stash ref + phase info)
  const checkpoints = new Map<string, Checkpoint>();
  let currentEntryId: string | undefined;

  // Track current entry ID for checkpoint mapping
  pi.on("tool_result", async (_event, ctx) => {
    const leaf = ctx.sessionManager.getLeafEntry();
    if (leaf) currentEntryId = leaf.id;
  });

  // Stash before each turn so we can restore to any phase boundary
  pi.on("turn_start", async (_event, ctx) => {
    try {
      const { stdout } = await pi.exec("git", ["stash", "create"]);
      const ref = stdout.trim();
      if (ref && currentEntryId) {
        // We'll fill in phase info when the phase_change event fires
        checkpoints.set(currentEntryId, { phase: "unknown", stashRef: ref });
      }
    } catch {
      // not a git repo or git not available — silently skip
    }
  });

  // Listen to phase changes from bdd-enforcer and auto-commit
  pi.events.on("bdd:phase_change", async (data: unknown) => {
    const event = data as PhaseChangeEvent;
    const isBug = event.cycleType === "bug";
    const subject = event.layer ?? event.featureName ?? (isBug ? "bugfix" : "feature");
    const ref = event.issueRef ? ` (${event.issueRef})` : "";
    let commitMsg: string | null = null;

    if (isBug) {
      if (event.from === "AWAITING_RED" && event.to === "RED") {
        commitMsg = `test(regression): failing test for ${subject}${ref}`;
      } else if (event.from === "GREEN" && event.to === "RED") {
        commitMsg = `test(regression): new failing test for ${subject}${ref}`;
      } else if (event.from === "RED" && event.to === "GREEN") {
        commitMsg = `fix: ${subject}${ref}`;
      } else if (event.from === "GREEN" && event.to === "REFACTOR") {
        commitMsg = `refactor: cleanup after fix of ${subject}${ref}`;
      } else if (event.to === "IDLE" && event.from !== "IDLE") {
        commitMsg = `refactor: complete bugfix ${subject}${ref}`;
      }
    } else {
      if (event.from === "AWAITING_RED" && event.to === "RED") {
        commitMsg = `test(red): failing spec for ${subject}`;
      } else if (event.from === "GREEN" && event.to === "RED") {
        commitMsg = `test(red): new failing spec for ${subject}`;
      } else if (event.from === "RED" && event.to === "GREEN") {
        commitMsg = `feat(green): implement ${subject}`;
      } else if (event.from === "GREEN" && event.to === "REFACTOR") {
        commitMsg = `refactor: begin cleanup of ${subject}`;
      } else if (event.to === "IDLE" && event.from !== "IDLE") {
        commitMsg = `refactor: complete ${event.featureName ?? subject}`;
      }
    }

    if (!commitMsg) return;

    try {
      // Stage all tracked changes
      await pi.exec("git", ["add", "-A"]);
      const { code } = await pi.exec("git", ["commit", "-m", commitMsg]);
      if (code === 0) {
        // Update the checkpoint with phase info
        if (currentEntryId) {
          checkpoints.set(currentEntryId, {
            phase: event.to,
            stashRef: checkpoints.get(currentEntryId)?.stashRef ?? "",
            featureName: event.featureName,
            layer: event.layer,
          });
        }
      }
    } catch {
      // commit failed (nothing to commit, etc.) — silently skip
    }
  });

  // On fork: offer to restore code to the BDD phase at that point in history
  pi.on("session_before_fork", async (event, ctx) => {
    const checkpoint = checkpoints.get(event.entryId);
    if (!checkpoint?.stashRef || !ctx.hasUI) return;

    const label = checkpoint.layer ?? checkpoint.featureName ?? "that point";
    const choice = await ctx.ui.select(
      `Restore code to BDD phase "${checkpoint.phase}" (${label})?`,
      [
        `Yes — restore code to this BDD checkpoint`,
        `No — keep current code`,
      ],
    );

    if (choice?.startsWith("Yes")) {
      try {
        await pi.exec("git", ["stash", "apply", checkpoint.stashRef]);
        ctx.ui.notify(`Code restored to ${checkpoint.phase} checkpoint for ${label}`, "info");
      } catch (err) {
        ctx.ui.notify(`Could not restore checkpoint: ${err}`, "error");
      }
    }
  });

  pi.on("agent_end", async () => {
    // Prune old checkpoints after each agent turn to avoid unbounded growth
    if (checkpoints.size > 50) {
      const keys = Array.from(checkpoints.keys());
      for (const key of keys.slice(0, checkpoints.size - 50)) {
        checkpoints.delete(key);
      }
    }
  });
}
