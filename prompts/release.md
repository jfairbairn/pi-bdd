Run the release gate sequence for the current feature to verify it is ready for production deployment.

**Feature:** {{feature_name_or_current_cycle}}

---
1. Load `release-gate` skill
2. Run `/release` to see current gate status
3. Run `check_release_readiness` to execute all pending automatable gates
4. For Gate 5: run `check_success_conditions` then `mark_gate_passed(5, notes: "...")`
5. For Gate 6: complete the rollback readiness checklist interactively
6. When all gates pass: run the production deploy command from release.config.json
7. After deployment: update ROADMAP.md → deployed, update PRODUCT.md validation status

Do not deploy to production until `check_release_readiness` confirms all gates passed.
