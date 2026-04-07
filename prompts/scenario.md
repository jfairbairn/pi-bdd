Add the following scenario to the current feature:

**Scenario:** {{scenario_name}}

Given {{initial_context}}
When {{action}}
Then {{expected_outcome}}

---
Before writing the spec:
1. Load `bdd-testing-strategy` to confirm the right layer and isolation for this scenario

Write the spec first, then call run_tests to confirm it fails before writing any implementation. Do not write production code yet.
