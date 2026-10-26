const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { test } = require("node:test");

async function startService(t, environment = {}) {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));

  const child = spawn(process.execPath, [path.join(__dirname, "index.js")], {
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      FIXTURE_ID: "test-fixture",
      RELEASE_ID: "release-42",
      ALLOW_ENV: "",
      READY_DELAY_MS: "0",
      HEALTH_STATUS: "200",
      DATABASE_URL: "",
      ...environment,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  });

  await new Promise((resolve, reject) => {
    let output = "";
    let diagnostics = "";
    child.stderr.on("data", (chunk) => { diagnostics += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`Service exited: ${code}\n${diagnostics}`)));
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("whoami listening")) resolve();
    });
  });

  return {
    port,
    pid: child.pid,
    request(url, { method = "GET", headers = {}, body } = {}) {
      return new Promise((resolve, reject) => {
        const req = http.request({
          hostname: "127.0.0.1", port, path: url, method, headers,
        }, (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => { text += chunk; });
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
        });
        req.on("error", reject);
        req.end(body);
      });
    },
  };
}

test("diagnostics expose the instance and real HTTP request in JSON and text", { timeout: 10000 }, async (t) => {
  const service = await startService(t, {
    ALLOW_ENV: "PUBLIC_LABEL, DATABASE_URL, SECRET_TOKEN, PUBLIC_LABEL",
    PUBLIC_LABEL: "blue\ninstance",
    SECRET_TOKEN: "environment-secret",
  });
  const headers = {
    accept: "application/json",
    "x-probe": ["first", "second"],
    "x-forwarded-for": "203.0.113.17",
    "x-forwarded-proto": "https",
    authorization: "Bearer auth-secret",
    "proxy-authorization": "Basic proxy-secret",
    cookie: "session=cookie-secret",
    "x-api-key": "key-secret",
  };
  const response = await service.request("/inspect/a%20b?tag=one&tag=two", {
    method: "POST", headers, body: "body-is-not-echoed",
  });
  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"], /application\/json/);
  const payload = JSON.parse(response.text);
  assert.equal(payload.service, "whoami");
  assert.equal(payload.fixture, "test-fixture");
  assert.equal(payload.release, "release-42");
  assert.deepEqual(payload.environment, { PUBLIC_LABEL: "blue\ninstance" });
  assert.equal(payload.instance.hostname, os.hostname());
  assert.ok(payload.instance.addresses.some(({ address, internal }) => address === "127.0.0.1" && internal));
  assert.ok(payload.instance.addresses.every(({ family }) => ["IPv4", "IPv6"].includes(family)));
  assert.equal(payload.runtime.node, process.version);
  assert.equal(payload.runtime.platform, process.platform);
  assert.equal(payload.runtime.arch, process.arch);
  assert.equal(payload.runtime.pid, service.pid);
  assert.ok(payload.runtime.uptimeSeconds > 0);
  assert.equal(payload.request.method, "POST");
  assert.equal(payload.request.path, "/inspect/a%20b");
  assert.equal(payload.request.url, "/inspect/a%20b?tag=one&tag=two");
  assert.equal(payload.request.httpVersion, "1.1");
  assert.equal(payload.request.headers["x-probe"], "first, second");
  assert.equal(payload.request.headers["x-forwarded-for"], "203.0.113.17");
  assert.equal(payload.request.headers["x-forwarded-proto"], "https");
  assert.equal(payload.request.remoteAddress, "127.0.0.1");
  assert.equal(payload.request.localAddress, "127.0.0.1");
  assert.equal(payload.request.localPort, service.port);
  assert.ok(payload.request.remotePort > 0);
  assert.notEqual(payload.request.remotePort, service.port);
  for (const name of ["authorization", "proxy-authorization", "cookie", "x-api-key"]) {
    assert.equal(payload.request.headers[name], "[REDACTED]");
  }
  assert.doesNotMatch(response.text, /auth-secret|proxy-secret|cookie-secret|key-secret|environment-secret|body-is-not-echoed/);

  const text = await service.request("/inspect?mode=text", {
    headers: { ...headers, accept: "text/plain" },
  });
  assert.match(text.headers["content-type"], /text\/plain/);
  for (const line of [
    "Name: whoami", 'Fixture: "test-fixture"', 'Release: "release-42"',
    "Method: GET", "Path: /inspect", `Hostname: ${os.hostname()}`,
    "IP: 127.0.0.1 (IPv4, loopback)", `Node: ${process.version}`,
    `Platform: ${process.platform}/${process.arch}`, `PID: ${service.pid}`,
    'URL: "/inspect?mode=text"', "HTTP: 1.1", "Remote address: 127.0.0.1",
    "Local address: 127.0.0.1", `Local port: ${service.port}`,
    '  x-probe: "first, second"', '  authorization: "[REDACTED]"',
    '  PUBLIC_LABEL: "blue\\ninstance"',
  ]) {
    assert.ok(text.text.split("\n").includes(line), `Missing line: ${line}`);
  }
  assert.match(text.text, /^Uptime: \d+\.\d{3}s$/m);
  assert.match(text.text, /^Remote port: \d+$/m);
  assert.doesNotMatch(text.text, /auth-secret|proxy-secret|cookie-secret|key-secret|environment-secret/);

  const json = await service.request("/json?format=forced", { headers: { accept: "text/plain" } });
  assert.equal(JSON.parse(json.text).request.url, "/json?format=forced");
});

test("deployment probes keep their existing contract and bypass diagnostics", { timeout: 10000 }, async (t) => {
  const service = await startService(t, { HEALTH_STATUS: "503", READY_DELAY_MS: "500" });
  const ready = await service.request("/ready");
  assert.equal(ready.status, 503);
  assert.equal(ready.text, "not ready\n");
  await delay(550);
  const nowReady = await service.request("/ready");
  assert.equal(nowReady.status, 200);
  assert.equal(nowReady.text, "ready\n");

  for (const [url, status, text] of [
    ["/healthz", 200, '{"ok":true}'],
    ["/health", 503, '{"status":503}'],
    ["/release", 200, '{"release":"release-42"}'],
    ["/database", 503, "database unavailable\n"],
  ]) {
    const response = await service.request(url, { headers: { accept: "application/json" } });
    assert.equal(response.status, status);
    assert.equal(response.text, text);
  }
  const head = await service.request("/", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.text, "");
});
