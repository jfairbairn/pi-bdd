I want to build the following feature using outside-in BDD:

**Feature:** {{feature_name}}

**As a** {{role}}
**I want** {{capability}}
**So that** {{business_value}}

**Outermost boundary:** {{boundary}}
(e.g. "user-facing web UI", "REST API endpoint", "CLI command", "background job output")

**Happy path scenario:**
Given {{initial_context}}
When {{action}}
Then {{expected_outcome}}

**Key edge cases to consider:**
- {{edge_case_1}}
- {{edge_case_2}}

---
If there is a design artifact for this feature in `roadmap/`, read it first — it contains the problem statement, behavioural specification, acceptance criteria, constraints, and any design facet details (UI, API, technical, etc.) produced during the steering conversation.

Before writing any specs or code:
1. Load `bdd-testing-strategy` to determine the right spec approach for the outermost boundary
2. Write the first failing spec from the acceptance criteria

Do not write any production code yet.
