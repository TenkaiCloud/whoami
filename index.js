const http = require("http");
const os = require("os");

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const serviceName = process.env.SERVICE_NAME || "whoami";
const instanceId =
  process.env.INSTANCE_ID ||
  process.env.HOSTNAME ||
  `${os.hostname()}:${process.pid}`;
const startedAt = new Date().toISOString();

function getNetworkAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if (entry.internal) {
        continue;
      }

      addresses.push(`${name}:${entry.family}:${entry.address}`);
    }
  }

  return addresses;
}

function getRequestIp(req) {
  const forwardedFor = req.headers["x-forwarded-for"];

  if (typeof forwardedFor === "string" && forwardedFor.length > 0) {
    return forwardedFor.split(",")[0].trim();
  }

  return req.socket.remoteAddress || "unknown";
}

function buildPayload(req) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  return {
    service: serviceName,
    instance: instanceId,
    hostname: os.hostname(),
    pid: process.pid,
    version: process.env.APP_VERSION || process.env.npm_package_version || "unknown",
    commit: process.env.COMMIT_SHA || "unknown",
    startedAt,
    now: new Date().toISOString(),
    request: {
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      host: req.headers.host || "unknown",
      protocol: req.headers["x-forwarded-proto"] || "http",
      remoteAddress: req.socket.remoteAddress || "unknown",
      clientIp: getRequestIp(req),
      forwardedFor: req.headers["x-forwarded-for"] || null,
      forwardedHost: req.headers["x-forwarded-host"] || null,
      userAgent: req.headers["user-agent"] || null,
      headers: req.headers,
    },
    network: {
      addresses: getNetworkAddresses(),
    },
  };
}

function toPlainText(payload) {
  const lines = [
    `Name: ${payload.service}`,
    `Instance: ${payload.instance}`,
    `Hostname: ${payload.hostname}`,
    `PID: ${payload.pid}`,
    `Version: ${payload.version}`,
    `Commit: ${payload.commit}`,
    `Started-At: ${payload.startedAt}`,
    `Now: ${payload.now}`,
    `IP: ${payload.request.remoteAddress}`,
    `Client-IP: ${payload.request.clientIp}`,
    `Host: ${payload.request.host}`,
    `Method: ${payload.request.method}`,
    `Path: ${payload.request.path}`,
    `Protocol: ${payload.request.protocol}`,
  ];

  if (payload.request.forwardedFor) {
    lines.push(`X-Forwarded-For: ${payload.request.forwardedFor}`);
  }

  if (payload.request.forwardedHost) {
    lines.push(`X-Forwarded-Host: ${payload.request.forwardedHost}`);
  }

  lines.push("Headers:");

  for (const [key, value] of Object.entries(payload.request.headers)) {
    lines.push(`  ${key}: ${value}`);
  }

  if (payload.network.addresses.length > 0) {
    lines.push("Network:");

    for (const address of payload.network.addresses) {
      lines.push(`  ${address}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

const server = http.createServer((req, res) => {
  const payload = buildPayload(req);
  const accept = req.headers.accept || "";

  if (payload.request.path === "/healthz") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, service: serviceName, instance: instanceId }));
    return;
  }

  if (payload.request.path === "/json" || accept.includes("application/json")) {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload, null, 2));
    return;
  }

  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end(toPlainText(payload));
});

server.listen(port, host, () => {
  console.log(
    JSON.stringify({
      message: "whoami listening",
      service: serviceName,
      instance: instanceId,
      host,
      port,
    }),
  );
});
