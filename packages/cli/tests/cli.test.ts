/**
 * @openagentpay/cli tests — exercise each subcommand without spawning a real
 * subprocess. We call `runCli(argv)` directly and inspect stdout/stderr/exit.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../src/cli.js";

const TMP = join(process.cwd(), ".tmp-cli-test");

beforeEach(() => {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
});

describe("oap CLI — top-level", () => {
  it("prints help on no args", async () => {
    const r = await runCli([]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage:");
    expect(r.stdout).toContain("config validate");
  });

  it("prints version on `version`", async () => {
    const r = await runCli(["version"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/oap \d/);
  });

  it("returns 2 on unknown command", async () => {
    const r = await runCli(["nonsense"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("unknown command");
  });
});

describe("oap config init", () => {
  it("writes a skeleton yaml", async () => {
    const out = join(TMP, "openagentpay.yaml");
    process.chdir(TMP);
    const r = await runCli(["config", "init", "--out", "openagentpay.yaml"]);
    expect(r.exitCode).toBe(0);
    expect(existsSync(out)).toBe(true);
  });

  it("refuses to overwrite without --force", async () => {
    const out = join(TMP, "openagentpay.yaml");
    writeFileSync(out, "existing", "utf8");
    process.chdir(TMP);
    const r = await runCli(["config", "init", "--out", "openagentpay.yaml"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("already exists");
  });

  it("overwrites with --force", async () => {
    const out = join(TMP, "openagentpay.yaml");
    writeFileSync(out, "existing", "utf8");
    process.chdir(TMP);
    const r = await runCli(["config", "init", "--out", "openagentpay.yaml", "--force"]);
    expect(r.exitCode).toBe(0);
  });
});

describe("oap config validate", () => {
  it("validates a known-good config", async () => {
    const out = join(TMP, "openagentpay.yaml");
    writeFileSync(
      out,
      `version: "1"
wallets: []
protocols: []
tenants: []
`,
      "utf8"
    );
    process.chdir(TMP);
    const r = await runCli(["config", "validate", "openagentpay.yaml"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("config valid");
  });

  it("rejects an invalid config with exit 3", async () => {
    const out = join(TMP, "openagentpay.yaml");
    writeFileSync(
      out,
      `version: "999"
wallets: []
`,
      "utf8"
    );
    process.chdir(TMP);
    const r = await runCli(["config", "validate", "openagentpay.yaml"]);
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain("validation failed");
  });

  it("returns exit 3 if file missing", async () => {
    process.chdir(TMP);
    const r = await runCli(["config", "validate", "nope.yaml"]);
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain("config not found");
  });
});

describe("oap doctor", () => {
  it("passes on a clean config with no secrets", async () => {
    const out = join(TMP, "openagentpay.yaml");
    writeFileSync(
      out,
      `version: "1"
wallets: []
protocols: []
tenants: []
`,
      "utf8"
    );
    process.chdir(TMP);
    const r = await runCli(["doctor", "openagentpay.yaml"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("doctor");
  });

  it("flags missing env vars in tenant.apiKey", async () => {
    const out = join(TMP, "openagentpay.yaml");
    writeFileSync(
      out,
      `version: "1"
wallets: []
protocols: []
tenants:
  - id: t1
    apiKey: "env://DEFINITELY_NOT_SET_${Math.random().toString(36).slice(2)}"
    dailyBudgetUsd: 10
`,
      "utf8"
    );
    process.chdir(TMP);
    const r = await runCli(["doctor", "openagentpay.yaml"]);
    expect(r.exitCode).toBe(4);
    expect(r.stdout).toContain("✘");
  });
});

describe("oap config show", () => {
  it("prints effective config as json with defaults", async () => {
    const out = join(TMP, "openagentpay.yaml");
    writeFileSync(
      out,
      `version: "1"
wallets: []
protocols: []
tenants: []
`,
      "utf8"
    );
    process.chdir(TMP);
    const r = await runCli(["config", "show", "openagentpay.yaml", "--json"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('"version"');
    expect(r.stdout).toContain('"routing"');
  });
});
