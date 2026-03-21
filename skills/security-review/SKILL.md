---
name: security-review
description: Guidance for manual security review of sensitive changes. Load when security_scan flags a change for manual review, or when making changes to authentication, payments, cryptography, PII handling, or agent tool definitions.
---

# Security Review

## When Manual Review Is Required

The `security_scan` tool flags changes that need a human security review alongside automated scanning. These are changes where automated tools can't fully assess the risk:

- **Authentication / authorisation** — login flows, session management, permission checks, JWT handling
- **Payments / billing** — payment processing, financial data, Stripe/payment provider integrations
- **Cryptography** — key management, encryption/decryption, hashing, certificate handling
- **PII handling** — new data fields storing personal data, new data sharing, new retention policies
- **Agent tool definitions** — new tools grant the agent new capabilities; scope must be minimum necessary
- **MCP server integrations** — new external system connections from the agent
- **Admin / privilege** — anything that elevates permissions or grants admin access

## The Review Checklist

For each flagged area, work through the relevant section:

### Authentication / Session
- [ ] Are session tokens generated with sufficient entropy? (≥128 bits)
- [ ] Are tokens invalidated on logout and expiry?
- [ ] Is there protection against session fixation?
- [ ] Are failed authentication attempts rate-limited?
- [ ] Is the same error returned for "user not found" and "wrong password"? (no user enumeration)
- [ ] Is sensitive data excluded from logs?

### Authorisation
- [ ] Does every route/action check permissions explicitly?
- [ ] Is authorisation checked server-side, not client-side?
- [ ] Are there any direct object references that bypass ownership checks? (IDOR)
- [ ] Does elevated privilege require re-authentication?

### Payments
- [ ] Is all payment processing handled server-side?
- [ ] Are card details never stored or logged — only tokens from the payment provider?
- [ ] Are webhook signatures verified?
- [ ] Are amounts validated server-side before charging?

### Cryptography
- [ ] Are modern algorithms used? (AES-256, RSA-2048+, Ed25519, bcrypt/Argon2 for passwords)
- [ ] Are keys managed via a secrets manager, not hardcoded or in config files?
- [ ] Are IVs/nonces generated randomly per operation?
- [ ] Is there a key rotation plan?

### PII / Data Handling
- [ ] Is new PII strictly necessary? Could a non-identifying alternative work?
- [ ] Is PII encrypted at rest and in transit?
- [ ] Is the retention period documented?
- [ ] Is there a data deletion path?
- [ ] Does this change require a DPIA / privacy review?

### Agent Tool Definitions (AI-specific)
- [ ] Does the tool scope follow minimum privilege? (can it do less than currently defined?)
- [ ] Could malicious input in tool parameters cause unintended actions?
- [ ] If the tool reads external content (web, files, databases), is that content sanitised before entering the agent context? (indirect prompt injection risk)
- [ ] Does the tool emit any secrets or PII into the agent context or logs?
- [ ] Are irreversible tool actions gated on human confirmation?

### MCP Integrations (AI-specific)
- [ ] Does the MCP server connection require authentication?
- [ ] Is the data returned by the MCP server sanitised before the agent uses it?
- [ ] Does the integration expose more data or capability than the agent task requires?

## Interpreting Automated Findings

### Secrets (CRITICAL — always act)
A detected secret means a credential was committed. Even if immediately removed:
1. **Rotate the credential now** — assume it is compromised regardless of git history rewriting
2. Check provider logs for unauthorised use
3. Add the pattern to `.gitleaks.toml` to prevent recurrence
4. Use environment variables or a secrets manager for the actual value

### SAST Findings (semgrep)
Semgrep reports vulnerability patterns. Not all are exploitable — assess in context:
- **Injection (SQL, command, XPath):** Nearly always exploitable if user input reaches it
- **Insecure deserialization:** High priority if data comes from untrusted sources
- **Hardcoded credentials:** Treat as a secret finding (rotate immediately)
- **Missing input validation:** Medium priority — assess the attack surface
- **Use of deprecated/weak crypto:** Low urgency unless keys are short or algorithm is broken

### Dependency Vulnerabilities
- **Critical/High CVE:** Check if the vulnerable code path is reachable in your usage
- **No direct usage of vulnerable function:** Still fix — transitive attack surface exists
- **Fix version available:** Update immediately and verify tests pass
- **No fix available:** Assess workarounds; consider removing the dependency

## What "Done" Looks Like

A manual security review is done when:
1. Each flagged area has been reviewed against the relevant checklist above
2. Any findings are either remediated or documented with an accepted risk decision
3. The reviewer can confirm: "I have read this diff with security intent, not just functional correctness"

Document the review conclusion in the PR description or a code comment — not because it's bureaucracy, but because it's evidence that it happened.

## After the Review: Unblocking Staging

Once the review is complete, call `mark_gate_passed` to pass Gate 2 and automatically trigger the staging deployment:

```
mark_gate_passed(
  gate: 2,
  notes: "Reviewed auth changes — constant-time comparison in place, no user enumeration, session tokens invalidated on logout"
)
```

Be specific in the notes — they are the evidence that the review happened. After this call, the system automatically proceeds to Gates 3, 4, and 5 (load tests, staging deployment, measurement readiness) in parallel.
