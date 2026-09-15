# Compose Lint

**ESLint for Docker Compose.** Inline diagnostics for the mistakes that break `docker compose up` — entirely local, nothing leaves your machine.

![Linter type](https://img.shields.io/badge/type-Linter-blue) ![License](https://img.shields.io/badge/license-MIT-green)

## Watch it work

<video src="demo/compose-lint-demo.mp4" width="100%" controls muted loop autoplay>
  Your browser does not support HTML5 video — download <a href="demo/compose-lint-demo.mp4">compose-lint-demo.mp4</a>.
</video>

## Features

- **Port conflict detection** — two services publishing the same host port, including overlapping ranges (`8080-8090` vs `8085`). One-click fix rewrites to the next free port.
- **Circular `depends_on` detection** — flags services stuck in a dependency cycle before your containers hang at startup.
- **Environment variable validation** — warns about `${VAR}` references that aren't defined in `.env`, the service `environment:`, or the host. Quick action creates the missing `.env` file.
- **Deprecated option warnings** — `version`, `links`, `external_links`, `log_driver`, `volume_driver`, `volumes_from`.
- **YAML syntax errors** surfaced as red diagnostics in the file.

All analysis runs locally. No telemetry, no network, no Docker daemon required.

## Usage

Open any `docker-compose*.yml` / `compose*.yaml` file — diagnostics appear automatically as you type.

Commands (Ctrl+Shift+P):

| Command | Description |
| --- | --- |
| `Compose Lint: Lint Current File` | Re-lint the active file |
| `Compose Lint: Lint All Compose Files` | Lint every Compose file in the workspace |

Hover a squiggle and use the lightbulb (quick fix) to apply fixes.

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `composeLint.envFileName` | `.env` | Default env file cross-validated against `${VAR}` references |
| `composeLint.checkEnvVars` | `true` | Warn on undefined env vars |
| `composeLint.checkDeprecated` | `true` | Warn on deprecated Compose options |
| `composeLint.filePatterns` | `**/*compose*.yaml`, `**/*compose*.yml` | Files treated as Compose files |

## Example

```yaml
services:
  api:
    image: node:20
    ports:
      - "8080:3000"          # error: conflicts with web below
    depends_on:
      - web
  web:
    image: nginx
    ports:
      - "8080:80            # yaml-syntax: unclosed quote
    environment:
      - PORT=${API_PORT}     # warning: API_PORT not defined
```

## Development

```sh
npm install
npm run compile   # build
npm test          # run rule unit tests (node --test)
npm run package   # produce compose-lint-0.1.0.vsix
```

Install the built `.vsix` from the Extensions view → `...` → *Install from VSIX*.

## License

MIT. Open source, free forever — no paid tiers, per the author's choice.