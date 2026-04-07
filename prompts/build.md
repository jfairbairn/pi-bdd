Work through the next item in the roadmap.

---
1. Read the `roadmap/` directory and find the first item with `status: queued` in its frontmatter
2. If no queued items exist, report that the roadmap is clear
3. Read the design artifact thoroughly — it contains problem, behaviour, acceptance criteria, constraints, and any design details
4. Update the item's frontmatter to `status: building`
5. Load `bdd-testing-strategy` to determine the right spec approach
6. Work through the acceptance criteria using outside-in BDD:
   - Write acceptance specs from the criteria in the design artifact
   - Follow the full red-green-refactor cycle for each
   - Respect all constraints listed in the artifact
   - Use any design facet sections (UI, API, technical, etc.) to guide implementation decisions
7. When all acceptance criteria are satisfied and tests pass, update the item's frontmatter to `status: done`
8. Report what was built and move on to the next item if instructed

The design artifact is the contract. Build what it says, how it says, within the constraints it sets. If the artifact is missing information you need to proceed, say so rather than guessing.
