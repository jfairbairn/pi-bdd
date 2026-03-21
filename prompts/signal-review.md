Run a production signal review to close the loop from deployed software back to the BDD development cycle.

**Time window:** {{time_window_or_last_24h}}
**Focus area (optional):** {{feature_or_component_or_leave_blank}}

---
1. Check telemetry is configured (`/telemetry`)
2. Load `production-telemetry`
3. Call `query_signals(timeWindowMinutes: {{minutes}}, focusPattern: "{{pattern}}")`
4. Load `signal-to-spec`
5. For each signal returned: map to BDD action and estimate impact
6. Present prioritised list to the user — approve, defer, or dismiss each
7. For approved signals: start the appropriate BDD cycle

Do not create bug reports or feature specs without explicit user approval for each signal.
