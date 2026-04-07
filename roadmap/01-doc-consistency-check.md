---
status: queued
---
# Doc Consistency Check

## Problem
Documentation drifts out of sync with code during development. Skills reference deleted prompts, README lists features that don't exist, extension doc comments describe outdated behaviour. Currently this is caught by manual audits — or not at all.

## Behaviour
When a BDD cycle completes (phase transitions to IDLE), the system checks project documentation against the current state of the code and flags inconsistencies before the closing commit. The agent fixes any issues it finds, then the commit proceeds.

The check covers:
- README.md: prompts, commands, tools, and features listed match what actually exists
- Skill files: cross-references to other skills, prompts, and commands are valid
- Extension doc comments: described behaviour matches the code
- References to deleted or renamed files

The check is scoped to files changed in the current cycle — it doesn't audit the entire project on every commit.

## Acceptance Criteria
- Given a BDD cycle that deleted a prompt, when the cycle completes (→ IDLE), then the system detects any README or skill references to the deleted prompt and flags them
- Given a BDD cycle that added a new tool, when the cycle completes, then the system detects if README's tool table is missing the new tool
- Given a BDD cycle where no docs are affected, when the cycle completes, then the check passes silently and the commit proceeds without delay
- Given the check finds inconsistencies, then the agent updates the docs and includes the fixes in the closing commit

## Constraints
- Runs only on the IDLE transition commit, not on every phase boundary — keep the inner loop fast
- Must not block or slow down cycles where docs are unaffected
- The check is advisory to the agent (it flags issues for the agent to fix), not a mechanical gate — doc updates require judgment
- Scope the check to files that could plausibly reference things changed in this cycle
