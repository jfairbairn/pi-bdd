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

**Product success conditions:**
We will know this feature is working when:
- {{success_condition_1}} (e.g. "70% of users complete X within their first session")
- {{success_condition_2}} (e.g. "error rate on Y stays below 0.1%")

**Telemetry spec:**
To measure the above, the feature must emit:
- `{{event_name}}` when {{trigger}} with properties: {{properties}}
- `{{metric_name}}` measuring {{what}} (threshold: {{target}})

---
Before writing any specs or code:
1. Load `measurement-design` — verify success conditions are specific and measurable, derive the telemetry spec if missing, and update PRODUCT.md
2. Load `bdd-testing-strategy` to determine the right spec approach for the outermost boundary
3. Write the first failing spec — include telemetry event emission as a testable assertion alongside functional behaviour

The telemetry spec is a first-class requirement. Event emission must be specced and tested alongside functional behaviour. Do not write any production code yet.
