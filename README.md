# whoami

Small Node.js service inspired by `traefik/whoami`, built to validate deployments quickly.

## Usage

```bash
npm start
```

Useful environment variables:

- `PORT`: listening port, defaults to `3000`
- `HOST`: listening interface, defaults to `0.0.0.0`
- `SERVICE_NAME`: name shown in the response
- `INSTANCE_ID`: explicit instance identifier
- `APP_VERSION`: version shown in the response
- `COMMIT_SHA`: commit SHA or tag shown in the response

## Endpoints

- `/`: plain text response similar to `whoami`
- `/json`: same payload as JSON
- `/healthz`: minimal health endpoint

## Examples

```bash
curl http://localhost:3000/
curl http://localhost:3000/json
curl -H "X-Forwarded-For: 203.0.113.10" http://localhost:3000/
```
