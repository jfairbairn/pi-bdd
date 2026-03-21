Bug report:

**Reported behaviour**: {{what_is_currently_happening}}
**Expected behaviour**: {{what_should_happen_instead}}
**How to reproduce**: {{reproduction_steps}}
**Affected area**: {{component_or_feature}}
**Issue reference**: {{issue_ref_or_none}}

---
Load `bdd-bug-workflow`. Before writing any code or tests:
1. Find the relevant component and its existing tests
2. Verify the reported behaviour actually occurs
3. Run the diagnostic flow to identify the bug type
4. Call report_bug() with the identified type
5. Proceed with the appropriate BDD first move for that type

Do not write production code until a failing test confirms the bug.
