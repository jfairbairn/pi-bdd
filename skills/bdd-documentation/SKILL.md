---
name: bdd-documentation
description: Minimum-viable documentation for BDD projects. Explains what to document, when to document it, how the requirements→implementation→deployment loop maps to documentation status, and how to use check_docs, update_doc_status, and update_roadmap tools.
---

# BDD Documentation — Minimum Viable, Always Current

## The Principle

Documentation is harmony between what the user intends, what the code does, and what's written down. When these agree, documentation is done enough. When they don't, surface the tension and resolve it — fill what you can confidently infer, ask about what you can't.

**Tests are documentation of behaviour.** Don't rewrite in prose what tests already express. Documentation fills what tests don't cover: *why* this design, *what* this component is for, *where* it sits, *what* its current status is.

## The Six Categories (per component)

Every non-trivial component needs exactly this — no more, no less:

```markdown
# ComponentName

> One sentence: what this is for.

**Status**: specified | implementing | implemented | deployed | deprecated

## What it does
<!-- Cross-reference tests for behaviour. Prose only for what tests don't express. -->

## How it does it
<!-- Key design approach, patterns used, significant structure. NOT implementation detail. -->

## Decisions
<!-- Only if non-obvious choices were made. Omit this section if nothing needs justification. -->
- Chose X over Y because Z

## Roadmap
<!-- Only if there are known planned extensions. Omit if nothing is planned. -->
- [ ] Planned thing
```

Omit **Decisions** and **Roadmap** sections when there's genuinely nothing to say. Don't add them as empty placeholders.

## The Requirements → Implementation → Deployment Loop

Documentation status mirrors where a feature is in the loop:

| Status | Meaning | BDD phase |
|--------|---------|-----------|
| `specified` | Requirement documented, no code yet | Before AWAITING_RED |
| `implementing` | BDD cycle in progress | AWAITING_RED through GREEN |
| `implemented` | Tests pass, not yet deployed | IDLE (post-GREEN) |
| `deployed` | Live in production | After deployment |
| `deprecated` | No longer maintained | After removal decision |

## When to Write What

### Before writing the first spec (AWAITING_RED start)
The requirement must be documented before the spec is written. Even one sentence.
- Add to **ROADMAP.md** at status `implementing`
- Add success conditions and telemetry spec to **PRODUCT.md** (load `measurement-design` for guidance)
- Optionally: create the component README with status `implementing` and the purpose line

### During implementation (RED → GREEN)
Don't stop to write documentation. Focus on making the test pass.
Jot down any non-obvious decisions or discovered constraints as comments in code — formalise them in REFACTOR.

### During REFACTOR
This is the primary documentation moment:
- Write or update the component README (all six categories checked)
- Update the **Decisions** section with anything non-obvious that was decided during implementation
- Call `check_docs` to verify completeness

### At IDLE transition
- Call `check_docs` to find gaps
- Fill from context where confident; ask the user where not
- Call `update_doc_status` to set component status to `implemented`
- Call `update_roadmap` to move the feature to `implemented`

### At deployment
- Call `update_doc_status` to set component status to `deployed`
- Call `update_roadmap` to move the feature to `deployed`
- Ensure the semantic commit message accurately describes the deployment (the CI/build system generates release notes from git history)

## ROADMAP.md Structure

The project-level view of the entire requirements→implementation→deployment loop:

```markdown
# Roadmap

## Deployed
- [x] Feature name — brief description

## Implemented (pending deployment)
- [x] Feature name

## Implementing
- [ ] Feature name

## Specified (not yet started)
- [ ] Feature name — brief description

## Considering
- [ ] Idea (not yet specified)
```

Keep this current. Every IDLE transition should touch it.

## What "Done Enough" Looks Like

Documentation is done enough when:
1. A new engineer (or a fresh agent session) can read it and understand what the component is for, what it does, and roughly how it works — without reading the code
2. The status accurately reflects where it is in the loop
3. Any non-obvious design decisions are explained
4. The roadmap is current
5. PRODUCT.md has measurable success conditions and a telemetry spec for this feature (required for Gate 5 / measurement readiness before deployment)

Documentation is NOT done enough when:
- Status says `implementing` but the BDD cycle is complete
- The README is empty or contains only a heading
- A significant design decision (e.g. "deliberately no user enumeration on login") is only in someone's head
- PRODUCT.md has no success conditions for this feature (the feature cannot be validated in production)

## Tools

| Tool | When to call |
|------|-------------|
| `check_docs(atIdle: true)` | At IDLE transition — checks docs, ROADMAP, and PRODUCT.md |
| `update_doc_status` | When a component moves to `implemented` or `deployed` |
| `update_roadmap` | When a feature moves to a new loop status |

PRODUCT.md is maintained manually (or via the `measurement-design` skill guidance) — it is not updated by a tool, it is written by the agent as part of the feature design step.

## Changelog

Changelogs are generated from git history by the CI/build system — not maintained by hand. The semantic commit conventions (`feat:`, `fix:`, `refactor:`, `test(regression):`) are what make that generation meaningful. No manual changelog maintenance is required.

## The Harmony Check

If documentation, code, and conversation are in tension — for example, the conversation established a design decision that isn't in the docs, or the docs describe an approach the implementation didn't follow — surface it:

1. If the discrepancy is clear and you can resolve it from context → resolve it
2. If it requires a design decision → ask the user which way to go
3. If the user has said something that contradicts the docs → ask before overwriting

Never silently overwrite documentation that expresses an intent you're uncertain about.
