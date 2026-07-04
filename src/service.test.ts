import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installService,
  renderMaintainPlist,
  serviceStatus,
  uninstallService,
  type ServiceOptions,
} from "./service.js";

test("renderMaintainPlist emits StartInterval in seconds, no KeepAlive, and the maintain --all-graphs argv", () => {
  const plist = renderMaintainPlist({
    label: "io.recall.maintain",
    intervalMinutes: 60,
    nodeBin: "/usr/local/bin/node",
    cliPath: "/opt/recall/dist/cli.js",
    launchAgentsDir: "/tmp/LaunchAgents",
    logDir: "/tmp/recall-logs",
  });

  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>3600<\/integer>/);
  assert.doesNotMatch(plist, /KeepAlive/);
  assert.match(plist, /<key>Label<\/key>\s*<string>io\.recall\.maintain<\/string>/);
  assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>/);
  assert.match(plist, /<string>\/opt\/recall\/dist\/cli\.js<\/string>/);
  assert.match(plist, /<string>maintain<\/string>/);
  assert.match(plist, /<string>--all-graphs<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<false\/>/);
  assert.match(plist, /<key>StandardOutPath<\/key>\s*<string>\/tmp\/recall-logs\/[^<]*<\/string>/);
  assert.match(plist, /<key>StandardErrorPath<\/key>\s*<string>\/tmp\/recall-logs\/[^<]*<\/string>/);
});

test("renderMaintainPlist XML-escapes interpolated values", () => {
  const plist = renderMaintainPlist({
    label: "io.recall.maintain",
    intervalMinutes: 60,
    nodeBin: '/usr/local/bin/node & "friends"',
    cliPath: "/opt/recall/dist/cli.js",
    launchAgentsDir: "/tmp/LaunchAgents",
    logDir: "/tmp/recall-logs",
  });

  assert.doesNotMatch(plist, /& "friends"/);
  assert.match(plist, /&amp;/);
  assert.match(plist, /&quot;/);
});

test("renderMaintainPlist honors a custom interval", () => {
  const plist = renderMaintainPlist({
    label: "io.recall.maintain",
    intervalMinutes: 15,
    nodeBin: "/usr/local/bin/node",
    cliPath: "/opt/recall/dist/cli.js",
    launchAgentsDir: "/tmp/LaunchAgents",
    logDir: "/tmp/recall-logs",
  });

  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>900<\/integer>/);
});

test("installService writes the plist file under a temp LaunchAgents dir without invoking launchctl", () => {
  const tmp = tempDir();
  try {
    const opts: ServiceOptions = {
      launchAgentsDir: join(tmp, "LaunchAgents"),
      logDir: join(tmp, "logs"),
      nodeBin: "/usr/local/bin/node",
      cliPath: "/opt/recall/dist/cli.js",
    };
    const result = installService(opts);

    assert.equal(result.label, "io.recall.maintain");
    assert.ok(existsSync(result.path));
    const written = readFileSync(result.path, "utf8");
    assert.equal(written, result.plist);
    assert.doesNotMatch(written, /KeepAlive/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("serviceStatus reports installed after installService and not installed after uninstallService", () => {
  const tmp = tempDir();
  try {
    const opts: ServiceOptions = {
      launchAgentsDir: join(tmp, "LaunchAgents"),
      logDir: join(tmp, "logs"),
      nodeBin: "/usr/local/bin/node",
      cliPath: "/opt/recall/dist/cli.js",
    };

    assert.equal(serviceStatus(opts).installed, false);

    installService(opts);
    assert.equal(serviceStatus(opts).installed, true);

    uninstallService(opts);
    assert.equal(serviceStatus(opts).installed, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("installService honors a custom label and interval", () => {
  const tmp = tempDir();
  try {
    const opts: ServiceOptions = {
      label: "io.recall.maintain.custom",
      intervalMinutes: 5,
      launchAgentsDir: join(tmp, "LaunchAgents"),
      logDir: join(tmp, "logs"),
      nodeBin: "/usr/local/bin/node",
      cliPath: "/opt/recall/dist/cli.js",
    };
    const result = installService(opts);

    assert.equal(result.label, "io.recall.maintain.custom");
    assert.match(result.path, /io\.recall\.maintain\.custom\.plist$/);
    assert.match(result.plist, /<key>StartInterval<\/key>\s*<integer>300<\/integer>/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "recall-v5-service-"));
}
