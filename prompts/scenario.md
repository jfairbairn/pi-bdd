Add the following scenario to the current feature:

**Scenario:** {{scenario_name}}

Given {{initial_context}}
When {{action}}
Then {{expected_outcome}}

---
Before writing the spec:
1. Load `bdd-testing-strategy` to confirm the right layer and isolation for this scenario
2. If this scenario covers new user-visible behaviour, check whether it needs a telemetry assertion added to the spec (does PRODUCT.md have a HogQL query that should fire when this scenario executes?)

Write the spec first (including any telemetry assertions), then call run_tests to confirm it fails before writing any implementation. Do not write production code yet.
