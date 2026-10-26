# Tenkai whoami fixtures

Four copies of the same Node.js diagnostic application, inspired by
[Traefik whoami](https://github.com/traefik/whoami). They test Tenkai deployment
paths, source access, reverse-proxy forwarding, readiness, releases, and
PostgreSQL connectivity. Only packaging and repository metadata differ.

This README, `index.js`, and `index.test.js` are identical in all four repositories.
Keep them in sync when changing the application or its contract.

## Which repository covers which case?

| Repository | Git source | Source build | Prebuilt image |
| --- | --- | --- | --- |
| [whoami](https://github.com/TenkaiCloud/whoami) | Public | Railpack/buildpack detection, no Dockerfile | None |
| [whoami-private](https://github.com/TenkaiCloud/whoami-private) | Private, authenticated clone | Railpack/buildpack detection, no Dockerfile | None |
| [whoami-dockerfile](https://github.com/TenkaiCloud/whoami-dockerfile) | Public | Included Dockerfile | `ghcr.io/tenkaicloud/whoami-dockerfile` |
| [whoami-dockerfile-private](https://github.com/TenkaiCloud/whoami-dockerfile-private) | Private, authenticated clone | Included Dockerfile | `ghcr.io/tenkaicloud/whoami-dockerfile-private` |

The first two deliberately have no Dockerfile or image-publishing workflow.
Tenkai must detect Node.js from `package.json`, install the lockfile, and run
`npm start`. Building an image elsewhere would not test this source-build path.

The Dockerfile repositories cover two separate deployment modes:

- Clone the source and build its Dockerfile. Private source requires Git access.
- Pull an already-built GHCR image. No source clone or build is needed. Registry
  access depends on package visibility, not Git repository visibility.

The included Dockerfiles use Node.js 24 Alpine, install production dependencies,
run as the `node` user, and set `FIXTURE_ID` to their repository name. Source
builds using buildpacks default to `whoami`; set `FIXTURE_ID` explicitly to
distinguish deployments. Do not infer identity from source visibility.

## Run and test

Use Node.js 24, also declared in `mise.toml` and `package.json`.

```bash
npm ci
npm test
npm start
```

The service listens on `0.0.0.0:8080` by default. For a local probe:

```bash
curl http://localhost:8080/
curl 'http://localhost:8080/json?probe=one&probe=two'
curl -H 'Accept: application/json' -H 'X-Probe: forwarded' http://localhost:8080/inspect
```

In either Dockerfile repository, build and run locally with:

```bash
docker build -t tenkai-whoami .
docker run --rm -p 8080:8080 -e RELEASE_ID=local tenkai-whoami
```

To test the prebuilt-image path instead, skip the build:

```bash
docker run --rm -p 8080:8080 ghcr.io/tenkaicloud/whoami-dockerfile:latest
```

Use `ghcr.io/tenkaicloud/whoami-dockerfile-private:latest` for the image built
from private source. For reproducible deployment tests, pin the image digest
instead of using the moving `latest` tag.

## Diagnostic response

`/` and any non-probe path return plain text. `/json` always returns JSON;
`Accept: application/json` selects JSON on other diagnostic paths.
Existing `service`, `fixture`, `release`, `environment`, `request.method`, and
`request.path` fields remain available. The response also includes:

| JSON field | Information |
| --- | --- |
| `instance.hostname` | Hostname of the running instance |
| `instance.addresses` | Interface IP addresses with `family` and `internal` loopback flags |
| `runtime` | Node.js version, platform, architecture, PID, and process uptime in seconds |
| `request.url` | Original request target, including encoded path and query string |
| `request.httpVersion` | HTTP version received by Node.js |
| `request.headers` | Lowercase header names and values as parsed by Node.js, with sensitive values redacted |
| `request.remoteAddress`, `request.remotePort` | Direct TCP peer, usually the reverse proxy |
| `request.localAddress`, `request.localPort` | Local socket receiving the request |

`X-Forwarded-*` and `Forwarded` headers are shown as received. They do not
override socket addresses or establish trusted client identity. HTTP version
and connection details describe the proxy-to-application connection, not
necessarily the browser-to-proxy connection. Request bodies are not echoed.

Header values whose names match the sensitive-name filter, including
`Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`,
and token/secret headers, are replaced with `[REDACTED]`. Environment exposure
requires `ALLOW_ENV` and excludes names matching the same filter. Hyphens in
names are treated as underscores for filtering.

This is a diagnostic fixture, not a general-purpose secret scrubber. URLs,
query strings, and unrecognized header names can still contain sensitive data.
Do not send real secrets in diagnostic requests or expose this service with
sensitive traffic. Do not allowlist environment values containing credentials,
even if their names look harmless.

## Configuration and probes

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Listening interface |
| `PORT` | `8080` | TCP port, from 1 through 65535 |
| `FIXTURE_ID` | `whoami` | Deployment identifier; overridden by each Dockerfile |
| `RELEASE_ID` | `unknown` | Release identifier in diagnostics and `/release` |
| `ALLOW_ENV` | empty | Comma-separated environment names to expose, subject to filtering |
| `READY_DELAY_MS` | `0` | Non-negative readiness delay after startup, measured with a monotonic clock |
| `HEALTH_STATUS` | `200` | Body-bearing HTTP response status, from 200 through 599 except 204, 205, and 304 |
| `DATABASE_URL` | absent | PostgreSQL connection string used only by `/database` |

| Endpoint | Response |
| --- | --- |
| `/healthz` | Always `200` with `{"ok":true}` while the server is running |
| `/ready` | `503` with `not ready` until the delay expires, then `200` with `ready` |
| `/health` | Configured status with `{"status":<status>}` |
| `/release` | `200` with `{"release":"<value>"}` |
| `/database` | Runs `SELECT 1`; `200` with `1`, or stable `503` with `database unavailable` |

Probe endpoints keep these minimal responses regardless of `Accept`; they do
not include diagnostic information. Invalid port, readiness, or health
configuration aborts startup. Database failures do not expose driver diagnostics
or credentials. Database connect/query checks use a three-second timeout budget.

## Image publication and registry access

Only the Dockerfile repositories publish images. Their existing GitHub Actions
workflows run on pushes to `main` or manual dispatch and publish `latest` and
`sha-<short commit>` tags for `linux/amd64` and `linux/arm64`. Each image keeps
its own source label and default fixture identity.

Git repository visibility and GHCR package visibility are separate. The intended
anonymous-pull case can use a public package even when its source repository is
private. A private package instead exercises authenticated registry pulls and
requires credentials with package-read access. `"private": true` in
`package.json` prevents npm publication; it does not set Git or GHCR visibility.

GHCR packages start private on first publication. If a package must support
anonymous pulls, an owner must open its **Package settings**, then **Danger
Zone**, **Change visibility**, and select **Public**, confirming the package
name. GitHub warns that this change cannot be reversed. No workflow changes
visibility automatically.

Verify anonymous pulls without stored registry credentials, for each package
that is intended to be public:

```bash
config=$(mktemp -d)
docker --config "$config" pull ghcr.io/tenkaicloud/whoami-dockerfile:latest
docker --config "$config" pull ghcr.io/tenkaicloud/whoami-dockerfile-private:latest
rm -r "$config"
```

`npm test` checks the HTTP contract locally. The tests do not prove Git clone
credentials, a Railpack build, GHCR access, or a Tenkai rollout. Those paths must
also be exercised by Tenkai's real-runtime deployment harness.
