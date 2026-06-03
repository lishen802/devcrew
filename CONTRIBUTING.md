# Contributing

## Development

```bash
npm install
npm test
npm run build
npm run validate
```

## Pull Requests

Keep changes scoped and include tests for behavior changes. For workflow behavior, update both tests and documentation.

## Project Standards

- Use TypeScript strict mode.
- Prefer small modules with explicit inputs and outputs.
- Keep host-specific behavior behind adapters.
- Do not bypass Codex or Claude Code permission models.
