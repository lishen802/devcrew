# Security

DevCrew is a local workflow service. It does not grant additional permissions beyond the host agent runtime.

## Permission Model

- Codex sandbox and approval settings remain authoritative in Codex.
- Claude Code permissions and approval settings remain authoritative in Claude Code.
- DevCrew records state and writes artifacts inside the target repository.

## Reporting Issues

For a public repository, open a private security advisory when available. Otherwise contact the maintainers before publishing exploit details.

## Design Rules

- Do not store secrets in `.devcrew/runs`.
- Do not add network access to adapters without explicit configuration.
- Do not execute destructive commands from the service layer.
