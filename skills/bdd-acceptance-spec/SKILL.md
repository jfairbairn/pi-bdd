---
name: bdd-acceptance-spec
description: Writing acceptance-level specs — the outermost ring of outside-in BDD. Covers Gherkin/Cucumber (when appropriate) and plain feature specs. Includes Gherkin syntax, scenario tables, data tables, and when NOT to use Gherkin.
---

# BDD Acceptance Specs — The Outermost Ring

Acceptance specs describe behaviour at the outermost boundary of a feature — the contract between the system and the outside world (a user, a calling service, a CLI consumer). They drive the outer loop of outside-in BDD.

## When to Use Gherkin

Use Gherkin when **at least two** of these are true:
- A non-engineer stakeholder needs to read and verify the spec
- The behaviour naturally decomposes into Given/When/Then with distinct roles
- Multiple concrete examples (scenario outlines / example tables) add genuine clarity
- The feature is user-facing in a way that business language matters

Use plain describe/it otherwise. Gherkin for internal service behaviour is ceremony without benefit.

## Gherkin Syntax

### Basic Scenario

```gherkin
Feature: User login
  As a registered user
  I want to log in with my credentials
  So that I can access my account

  Background:
    Given the application is running
    And a registered user exists with email "alice@example.com" and password "correct"

  Scenario: Successful login
    When Alice submits the login form with email "alice@example.com" and password "correct"
    Then she is redirected to the dashboard
    And she sees a welcome message containing "Alice"

  Scenario: Invalid password
    When Alice submits the login form with email "alice@example.com" and password "wrong"
    Then she sees an error message "Invalid email or password"
    And she is not redirected
```

### Given / When / Then — roles

| Step | Role | Contains |
|------|------|----------|
| **Given** | Setup — establish context | State before action. Never actions, never assertions. |
| **When** | Action — the thing being tested | The single action the scenario exercises. |
| **Then** | Assertion — the expected outcome | Observable outcomes only. No implementation detail. |
| **And / But** | Continuation | Inherits the role of the preceding step. |

**One When per scenario.** Multiple Whens indicate multiple scenarios collapsed into one — split them.

### Scenario Outline + Example Tables

Use when the same behaviour applies across multiple concrete inputs:

```gherkin
  Scenario Outline: Login with invalid credentials
    When a user submits the login form with email "<email>" and password "<password>"
    Then they see the error "<error>"

    Examples:
      | email                  | password | error                          |
      | alice@example.com      | wrong    | Invalid email or password      |
      | nonexistent@example.com| any      | Invalid email or password      |
      | not-an-email           | any      | Please enter a valid email     |
```

### Data Tables

Use for structured input within a single step:

```gherkin
  Scenario: Bulk import users
    When I import the following users:
      | name    | email                | role  |
      | Alice   | alice@example.com    | admin |
      | Bob     | bob@example.com      | user  |
    Then 2 users are created
    And Alice has the admin role
```

## Anti-Patterns

```gherkin
# ❌ Implementation detail in Gherkin
When the UserService.authenticate() method is called with valid JWT

# ❌ Multiple actions in When
When I click the submit button
And the form is validated
And the API call returns 200

# ❌ Assertion in Given
Given the login succeeds

# ❌ Imperative UI steps (reveals implementation)
When I click the "Email" input field
And I type "alice@example.com"
And I click the "Password" field
And I type "correct"
And I click the button with text "Log in"

# ✓ Declarative (hides implementation, survives UI refactors)
When Alice logs in with email "alice@example.com" and password "correct"
```

## Step Definition Guidance

Step definitions are implementation — they belong in the inner loop, not the outer spec. When writing step definitions:
- Keep them thin: they should call into your domain/service layer, not contain business logic
- Reuse steps via well-named helper methods
- Data table steps should use the table's `hashes()` / `rows()` to iterate

## Plain Acceptance Spec (when Gherkin isn't warranted)

```typescript
// Vitest — acceptance-level, full integration, no mocks
describe("user login", () => {
  describe("with valid credentials", () => {
    it("issues a session token", async () => {
      await createUser({ email: "alice@example.com", password: "correct" });
      const res = await apiClient.post("/api/sessions", { email: "alice@example.com", password: "correct" });
      expect(res.status).toBe(201);
      expect(res.data.token).toBeDefined();
    });
  });

  describe("with invalid credentials", () => {
    it("returns 401", async () => {
      await createUser({ email: "alice@example.com", password: "correct" });
      const res = await apiClient.post("/api/sessions", { email: "alice@example.com", password: "wrong" });
      expect(res.status).toBe(401);
    });
  });
});
```
