# Contributing to Linq Examples

Thanks for your interest in contributing! We welcome PRs, issues, and discussions.

## Getting Started

1. Fork the repository
2. Clone your fork
3. Create a branch for your changes

## Adding a New Example

Each example should be self-contained in its own directory with:

- `README.md` - Clear documentation with setup instructions
- `package.json` - With `"license": "MIT"`
- Working code that demonstrates a specific integration pattern

### Example Structure

```
your-example/
├── README.md
├── package.json
├── package-lock.json
├── tsconfig.json (if using TypeScript)
└── src/
    └── ...
```

## Pull Request Guidelines

1. **One example per PR** - Keep changes focused
2. **Test your code** - Ensure it works with a real or mocked API
3. **Document clearly** - Include setup steps and expected behavior
4. **No secrets** - Never commit API tokens or credentials
5. **Keep dependencies minimal** - Only include what's necessary

## Code Style

- Use TypeScript where possible
- Include types for API responses and webhook payloads
- Add comments for non-obvious logic

## Reporting Issues

- Check existing issues first
- Include reproduction steps
- Specify Node.js version and OS

## Security

See [SECURITY.md](./SECURITY.md) for reporting vulnerabilities.

## Questions?

Open a discussion or reach out at https://linqapp.com
