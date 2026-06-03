# Role Customization

DevCrew ships with five roles.

## conductor

Owns workflow progression, gate discipline, and artifact routing.

## pm

Clarifies product goals, users, boundaries, success criteria, and requester approvals.

## architect

Designs technical architecture, interfaces, deployment considerations, and review criteria.

## implementer

Builds according to approved requirements and architecture while following discovered project standards.

## tester

Verifies behavior, runs or specifies validation commands, and prepares acceptance evidence.

## Project Standards

Put explicit standards in:

```text
.devcrew/standards.md
```

DevCrew also discovers:

- `AGENTS.md`
- `CLAUDE.md`
- README files
- `package.json`
- `pyproject.toml`
- `go.mod`
- `Cargo.toml`

Explicit DevCrew standards are included first.
