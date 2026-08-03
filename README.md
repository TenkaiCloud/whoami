# whoami

Public source fixture for Tenkai's **Railpack/buildpack** path. This repository
intentionally has no `Dockerfile`: `package.json`, its lockfile, and `npm start`
are the complete build contract. The real proof is Tenkai's real-runtime harness,
which clones this repository and asks Railpack to detect and build it.

The HTTP implementation is kept byte-for-byte identical across the four
`whoami*` fixtures. Build-specific files and the explicit `FIXTURE_ID` may differ.

## Run

```bash
npm ci
npm start
```

The service listens on `HOST=0.0.0.0` and `PORT=8080` by default.

## Configuration and endpoints

| Variable | Default | Endpoint |
| --- | --- | --- |
| `READY_DELAY_MS` | `0` | `GET /ready` returns `503` until the monotonic delay expires, then `200` |
| `HEALTH_STATUS` | `200` | `GET /health` returns `{"status":<status>}` with that status |
| `RELEASE_ID` | `unknown` | `GET /release` returns `{"release":"<value>"}` |
| `DATABASE_URL` | absent | `GET /database` runs `SELECT 1`, or returns a stable `503` |
| `ALLOW_ENV` | empty | Comma-separated environment names exposed by `/` and `/json` |

`HEALTH_STATUS` accepts body-bearing response statuses from 200 through 599
(excluding 204, 205, and 304). Invalid readiness or health configuration aborts
startup. Sensitive variables are never exposed, even when named in `ALLOW_ENV`.
Database failures never include PostgreSQL diagnostics or credentials.

Historical endpoints remain available: `/` (plain text), `/json` (JSON), and
`/healthz` (minimal health check).

No OCI image is published from this repository. In particular, a workflow here
would not prove Tenkai's Railpack source-build path.
