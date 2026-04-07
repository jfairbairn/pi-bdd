---
name: bdd-testing-strategy
description: Identifies the layer being built and determines the appropriate BDD testing strategy, isolation technique, and spec style. Load this before writing any new spec.
---

# BDD Testing Strategy — Identifying the Right Spec for Each Layer

Before writing a spec, identify what kind of component or layer you're about to build. The testing strategy must match the layer — wrong isolation technique means either tests that don't actually verify behaviour, or tests so coupled to implementation that they break on every refactor.

## Layer Identification

Ask these questions:

1. **What is the outermost visible boundary of this piece?**
   - User sees it in a browser? → UI Component or Acceptance spec
   - Caller hits it over HTTP? → API/Route spec
   - Another service calls it in-process? → Service/Domain spec
   - It persists or retrieves data? → Repository/Persistence spec
   - It's a pure transformation? → Unit spec

2. **What does this layer depend on?**
   - External services / APIs → mock them
   - Database / file system → use fixtures or test DB
   - Other domain objects → use real ones (don't mock your own domain)
   - Browser/DOM → use a harness or testing-library

3. **What behaviour needs to be verified?**
   - Always verify behaviour, not implementation
   - Ask: "if I change how this works internally but the result is the same, should this test break?" If yes — the test is testing implementation, not behaviour. Rewrite it.

---

## Layer Strategies

### Acceptance / Feature Layer
**When:** Outermost user-facing behaviour. Often the first spec in the double loop.  
**Spec style:** Gherkin (Cucumber/RSpec Cucumber) when stakeholders need to read it; plain feature spec when not.  
**Isolation:** None — full integration, real system end to end (or near-end).  
**What to verify:** That the user-visible outcome occurs given the described starting state and action.

```gherkin
# When Gherkin is warranted
Feature: User login
  Scenario: Valid credentials
    Given a registered user with email "alice@example.com"
    When they submit the login form with correct credentials
    Then they are redirected to the dashboard
```

```typescript
// When plain spec is fine (Vitest)
describe("user login flow", () => {
  it("redirects to dashboard on valid credentials", async () => {
    // drive the outer boundary (HTTP, CLI, UI render)
  });
});
```

---

### API / HTTP Handler Layer
**When:** Verifying the HTTP contract — status codes, response shape, headers, error handling.  
**Spec style:** Request/response spec using test client.  
**Isolation:** Mock the domain/service layer. Test the handler's responsibility only.  
**Tools:** `supertest` (Node/Express), `httpx` + `pytest` (FastAPI), `rack-test` (Rack/Rails), `RestAssured` (JVM).

```typescript
// Vitest + supertest
describe("POST /api/sessions", () => {
  it("returns 201 with session token on valid credentials", async () => {
    authService.login.mockResolvedValue({ token: "tok_123" });
    const res = await request(app).post("/api/sessions").send({ email, password });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ token: expect.any(String) });
  });

  it("returns 401 on invalid credentials", async () => {
    authService.login.mockRejectedValue(new InvalidCredentialsError());
    const res = await request(app).post("/api/sessions").send({ email, badPassword });
    expect(res.status).toBe(401);
  });
});
```

**Mock strategy:** Mock at the service boundary injected into the handler. Do not mock HTTP internals.

---

### Service / Domain Layer
**When:** Business logic, domain rules, orchestration between repositories and external services.  
**Spec style:** Plain describe/it. No framework ceremony needed.  
**Isolation:** Mock external dependencies (repos, external APIs, queues). Use real domain objects.  
**Key rule:** Never mock your own domain objects. If AuthService calls UserRepository, mock the repo, not the User model.

```typescript
// Vitest
describe("AuthService", () => {
  let authService: AuthService;
  let userRepo: MockedObject<UserRepository>;

  beforeEach(() => {
    userRepo = { findByEmail: vi.fn(), save: vi.fn() };
    authService = new AuthService(userRepo, tokenSigner);
  });

  describe("login", () => {
    it("returns a signed token when credentials match", async () => {
      userRepo.findByEmail.mockResolvedValue(aUser({ passwordHash: hash("correct") }));
      const token = await authService.login("alice@example.com", "correct");
      expect(token).toMatch(/^tok_/);
    });

    it("throws InvalidCredentialsError when password does not match", async () => {
      userRepo.findByEmail.mockResolvedValue(aUser({ passwordHash: hash("correct") }));
      await expect(authService.login("alice@example.com", "wrong")).rejects.toThrow(InvalidCredentialsError);
    });

    it("throws InvalidCredentialsError when user does not exist", async () => {
      userRepo.findByEmail.mockResolvedValue(null);
      await expect(authService.login("unknown@example.com", "any")).rejects.toThrow(InvalidCredentialsError);
    });
  });
});
```

**Test data:** Use builder functions (`aUser({...})`) not literal objects — they make intent clear and insulate tests from model shape changes.

---

### Repository / Persistence Layer
**When:** Code that talks to a database, file system, or external store.  
**Spec style:** Integration test against a real (test) database or in-memory equivalent.  
**Isolation:** Use a real test database (reset between tests) or an in-memory store. Do NOT mock the database driver — you'll miss SQL errors, constraint violations, and query bugs.  
**Fixtures:** Seed known state before each test; verify known outcome after.

```typescript
// Vitest + test database
describe("UserRepository", () => {
  beforeEach(async () => {
    await db.migrate.latest();
    await db("users").truncate();
  });

  afterAll(() => db.destroy());

  describe("findByEmail", () => {
    it("returns the user when found", async () => {
      await db("users").insert(fixtures.alice);
      const user = await repo.findByEmail("alice@example.com");
      expect(user).toMatchObject({ email: "alice@example.com", id: expect.any(String) });
    });

    it("returns null when not found", async () => {
      const user = await repo.findByEmail("nobody@example.com");
      expect(user).toBeNull();
    });
  });
});
```

**Fixture strategy:** Define fixtures as plain objects in a `fixtures/` directory. Use factory functions for variants. Never reuse fixture state across tests — reset is always cheaper than debugging ordering bugs.

---

### UI Component Layer
**When:** Front-end components (React, Vue, Svelte, web components).  
**Spec style:** Component test using a test harness / Testing Library.  
**Isolation:** Render the component with controlled props and/or a mock store. Do not test DOM implementation details (class names, element structure) — test behaviour (what the user sees and can do).  
**Tools:** `@testing-library/react` (React), `@testing-library/vue`, `@testing-library/svelte`.

```typescript
// Vitest + @testing-library/react
describe("LoginForm", () => {
  it("calls onSubmit with email and password when form is submitted", async () => {
    const onSubmit = vi.fn();
    render(<LoginForm onSubmit={onSubmit} />);

    await userEvent.type(screen.getByLabelText("Email"), "alice@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "correct");
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));

    expect(onSubmit).toHaveBeenCalledWith({ email: "alice@example.com", password: "correct" });
  });

  it("shows a validation error when email is empty", async () => {
    render(<LoginForm onSubmit={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Email is required");
  });
});
```

**Data harness:** For components that depend on API data, use a controlled mock provider or MSW (Mock Service Worker) — test the component's behaviour given specific data states (loading, loaded, error).

---

### Pure Function / Utility Layer
**When:** Stateless transformations with no side effects.  
**Spec style:** Simple input/output assertions. No mocks needed.  
**Isolation:** None required — pure functions are already isolated.

```typescript
describe("formatCurrency", () => {
  it("formats whole dollars", () => {
    expect(formatCurrency(1000, "USD")).toBe("$1,000.00");
  });
  it("handles zero", () => {
    expect(formatCurrency(0, "USD")).toBe("$0.00");
  });
  it("handles negative amounts", () => {
    expect(formatCurrency(-500, "USD")).toBe("-$500.00");
  });
});
```

---

## Mock Object Guidance

**Mock only what you own's external boundary.** If your service calls a repo, mock the repo. If your handler calls a service, mock the service. Never mock:
- Your own domain objects (mock the repo that returns them, not the objects themselves)
- Language/framework internals
- Things you could test with a real in-memory equivalent

**Use `vi.fn()` / `vi.spyOn()` (Vitest) or RSpec doubles for mocking.**  
Always assert on calls when the call itself is the behaviour (`expect(repo.save).toHaveBeenCalledWith(...)`) — don't just set up the mock and check side effects.

## Test Data Builders

Prefer builder functions over literal objects:

```typescript
// fixtures/users.ts
export function aUser(overrides: Partial<User> = {}): User {
  return {
    id: "usr_default",
    email: "default@example.com",
    passwordHash: "hashed",
    createdAt: new Date("2025-01-01"),
    ...overrides,
  };
}
```

This way, each test declares only what's relevant to it, and model shape changes don't require updating every test.
