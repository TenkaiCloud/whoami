const http = require("http");
const os = require("os");
const { Client } = require("pg");

function parseNonNegativeInteger(name, fallback) {
  const value = process.env[name] ?? fallback;

  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }

  return parsed;
}

function parseHealthStatus() {
  const status = parseNonNegativeInteger("HEALTH_STATUS", "200");

  if (status < 200 || status > 599 || [204, 205, 304].includes(status)) {
    throw new Error("HEALTH_STATUS must be a response status from 200 to 599 with a body");
  }

  return status;
}

const port = parseNonNegativeInteger("PORT", "8080");

if (port < 1 || port > 65535) {
  throw new Error("PORT must be between 1 and 65535");
}

const host = process.env.HOST || "0.0.0.0";
const fixtureId = process.env.FIXTURE_ID || "whoami";
const releaseId = process.env.RELEASE_ID || "unknown";
const healthStatus = parseHealthStatus();
const readyDelayMs = parseNonNegativeInteger("READY_DELAY_MS", "0");
const readyAt = process.hrtime.bigint() + BigInt(readyDelayMs) * 1_000_000n;
const databaseUrl = process.env.DATABASE_URL;
const allowedEnvironmentNames = [...new Set(
  (process.env.ALLOW_ENV || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean),
)].sort();

function isSensitiveName(name) {
  return /DATABASE_URL|PASSWORD|PASSWD|SECRET|TOKEN|CREDENTIAL|PRIVATE_KEY|API_KEY|ACCESS_KEY|AUTHORIZATION|COOKIE/i.test(
    name.replaceAll("-", "_"),
  );
}

function getAllowedEnvironment() {
  const environment = {};

  for (const name of allowedEnvironmentNames) {
    if (!isSensitiveName(name) && process.env[name] !== undefined) {
      environment[name] = process.env[name];
    }
  }

  return environment;
}

function getPath(req) {
  return new URL(req.url || "/", "http://localhost").pathname;
}

function buildPayload(req, path) {
  return {
    service: "whoami",
    fixture: fixtureId,
    release: releaseId,
    environment: getAllowedEnvironment(),
    instance: {
      hostname: os.hostname(),
      addresses: Object.values(os.networkInterfaces())
        .flat()
        .map(({ address, family, internal }) => ({ address, family, internal })),
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      uptimeSeconds: process.uptime(),
    },
    request: {
      method: req.method || "UNKNOWN",
      path,
      url: req.url,
      httpVersion: req.httpVersion,
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([name, value]) => [
          name,
          isSensitiveName(name) ? "[REDACTED]" : value,
        ]),
      ),
      remoteAddress: req.socket.remoteAddress,
      remotePort: req.socket.remotePort,
      localAddress: req.socket.localAddress,
      localPort: req.socket.localPort,
    },
  };
}

function toPlainText(payload) {
  const lines = [
    `Name: ${payload.service}`,
    `Fixture: ${JSON.stringify(payload.fixture)}`,
    `Release: ${JSON.stringify(payload.release)}`,
    `Method: ${payload.request.method}`,
    `Path: ${payload.request.path}`,
    `Hostname: ${payload.instance.hostname}`,
    ...payload.instance.addresses.map(
      ({ address, family, internal }) =>
        `IP: ${address} (${family}${internal ? ", loopback" : ""})`,
    ),
    `Node: ${payload.runtime.node}`,
    `Platform: ${payload.runtime.platform}/${payload.runtime.arch}`,
    `PID: ${payload.runtime.pid}`,
    `Uptime: ${payload.runtime.uptimeSeconds.toFixed(3)}s`,
    `URL: ${JSON.stringify(payload.request.url)}`,
    `HTTP: ${payload.request.httpVersion}`,
    `Remote address: ${payload.request.remoteAddress}`,
    `Remote port: ${payload.request.remotePort}`,
    `Local address: ${payload.request.localAddress}`,
    `Local port: ${payload.request.localPort}`,
    "Headers:",
  ];

  for (const [name, value] of Object.entries(payload.request.headers)) {
    lines.push(`  ${name}: ${JSON.stringify(value)}`);
  }

  if (Object.keys(payload.environment).length > 0) {
    lines.push("Environment:");

    for (const [name, value] of Object.entries(payload.environment)) {
      lines.push(`  ${name}: ${JSON.stringify(value)}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function sendText(res, status, body) {
  res.writeHead(status, { "content-type": "text/plain" });
  res.end(body);
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function checkDatabase(res) {
  if (!databaseUrl) {
    sendText(res, 503, "database unavailable\n");
    return;
  }

  const timeoutMs = 3000;
  const deadline = process.hrtime.bigint() + BigInt(timeoutMs) * 1_000_000n;
  let client;

  try {
    client = new Client({
      connectionString: databaseUrl,
      connectionTimeoutMillis: timeoutMs,
      statement_timeout: timeoutMs,
    });
    client.on("error", () => {});

    await client.connect();
    const remainingMs = Number(
      (deadline - process.hrtime.bigint()) / 1_000_000n,
    );

    if (remainingMs <= 0) {
      throw new Error("database timeout");
    }

    const result = await client.query({
      text: "SELECT 1",
      query_timeout: remainingMs,
    });
    const values = result.rows.length === 1 ? Object.values(result.rows[0]) : [];

    if (values.length !== 1 || values[0] !== 1) {
      throw new Error("unexpected database result");
    }

    sendText(res, 200, "1\n");
  } catch {
    sendText(res, 503, "database unavailable\n");
  } finally {
    if (client) {
      try {
        await client.end();
      } catch {
        // The response remains intentionally independent of driver diagnostics.
      }
    }
  }
}

const server = http.createServer(async (req, res) => {
  let path;

  try {
    path = getPath(req);
  } catch {
    sendText(res, 400, "bad request\n");
    return;
  }

  if (path === "/healthz") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (path === "/ready") {
    const ready = readyDelayMs === 0 || process.hrtime.bigint() >= readyAt;
    sendText(res, ready ? 200 : 503, ready ? "ready\n" : "not ready\n");
    return;
  }

  if (path === "/health") {
    sendJson(res, healthStatus, { status: healthStatus });
    return;
  }

  if (path === "/release") {
    sendJson(res, 200, { release: releaseId });
    return;
  }

  if (path === "/database") {
    await checkDatabase(res);
    return;
  }

  const payload = buildPayload(req, path);
  const accept = req.headers.accept || "";

  if (path === "/json" || accept.includes("application/json")) {
    sendJson(res, 200, payload);
    return;
  }

  sendText(res, 200, toPlainText(payload));
});

server.listen(port, host, () => {
  console.log(
    JSON.stringify({
      message: "whoami listening",
      fixture: fixtureId,
      host,
      port,
    }),
  );
});
