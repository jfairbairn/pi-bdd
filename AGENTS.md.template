# BDD Project Configuration
# Copy this to your project root as AGENTS.md and fill in the blanks.

## BDD Method

This project uses outside-in BDD with strict red-green-refactor enforcement.

Rules (enforced by the bdd-enforcer extension):
1. Never write to production paths before a failing test is confirmed
2. Never write production code before running tests and seeing them fail
3. Write the minimum code to make the test pass — no speculative implementation
4. Refactor only when tests are green
5. Every phase boundary (RED, GREEN, REFACTOR complete) is a git commit

## Stack

Language: [TypeScript / Ruby / Python / Go / Rust / ...]
Test framework: [Vitest / RSpec / pytest / go test / cargo test / ...]
Test command: npm test

## Roadmap

Design artifacts live in `roadmap/` as numbered markdown files.
Use `/build` to work through them in order via BDD.
Load the `roadmap` skill for format details.

## File Layout

Production code:  src/          (lib/ for shared libraries)
Test/spec code:   tests/        (or spec/ for RSpec projects)
Design artifacts: roadmap/      (numbered, ordered)
Fixtures:         tests/fixtures/
Mocks:            tests/mocks/  (or __mocks__/ for Jest/Vitest auto-mocking)
Test helpers:     tests/support/ (or spec/support/)

## BDD Config (.pi/bdd.config.json)

Create this file to override defaults:

```json
{
  "productionPaths": ["src/", "lib/"],
  "testPaths": ["tests/", "spec/", "features/", "__tests__/"],
  "testFilePatterns": ["\\.test\\.", "\\.spec\\.", "\\.feature$"],
  "testCommand": "npm test"
}
```

## Naming Conventions

Spec files mirror source files:
  src/auth/AuthService.ts       → tests/auth/AuthService.test.ts
  src/components/LoginForm.tsx  → tests/components/LoginForm.test.tsx
  app/models/user.rb            → spec/models/user_spec.rb

## Test Data

Use builder functions (not literals) for test data:
  tests/builders/userBuilder.ts    (or spec/factories/ with FactoryBot)

Fixtures (for persistence tests) live in:
  tests/fixtures/

## Common Commands

Run all tests:    [npm test]
Run focused:      [npx vitest run src/auth]
Run single file:  [npx vitest run tests/auth/AuthService.test.ts]
Watch mode:       [npx vitest]
Coverage:         [npx vitest --coverage]
