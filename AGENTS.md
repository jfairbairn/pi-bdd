# pi-bdd Project Notes

This is the pi-bdd package itself — the BDD enforcement extension, skills, and prompts.

## House Rules

- Extensions are TypeScript in `extensions/`
- Skills follow the Agent Skills spec in `skills/`
- Prompt templates are markdown in `prompts/`
- Tests use Vitest: `npm test`
- This package is consumed via `pi install` — keep the `pi` manifest in `package.json` current
