/**
 * `oap conformance test` — run @openagentpay/conformance against a connector
 * package by spawning vitest in that package's directory.
 *
 * @license Apache-2.0
 */

import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { flag, type CommandContext } from "../io.js";

export async function cmdConformance(
  argv: ReadonlyArray<string>,
  ctx: CommandContext
): Promise<number> {
  const pkgPath = flag(argv, "--pkg") ?? flag(argv, "--package") ?? ctx.cwd;
  const abs = resolve(ctx.cwd, pkgPath);
  if (!existsSync(abs)) {
    ctx.err(`✘ package directory not found: ${abs}`);
    return 2;
  }
  const pkgJson = join(abs, "package.json");
  if (!existsSync(pkgJson)) {
    ctx.err(`✘ ${abs} is not an npm package (no package.json)`);
    return 2;
  }
  ctx.log(`▸ running conformance suite in ${abs}`);
  ctx.log("");

  return new Promise<number>((res) => {
    const child = spawn("pnpm", ["test"], {
      cwd: abs,
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, OPENAGENTPAY_LIVE_TESTS: process.env["OPENAGENTPAY_LIVE_TESTS"] ?? "false" },
    });
    child.on("close", (code) => {
      ctx.log("");
      if (code === 0) ctx.log("✔ conformance: all tests passed");
      else ctx.err(`✘ conformance: failed (exit ${code})`);
      res(code ?? 1);
    });
    child.on("error", (err) => {
      ctx.err(`✘ failed to spawn pnpm: ${err.message}`);
      res(1);
    });
  });
}
