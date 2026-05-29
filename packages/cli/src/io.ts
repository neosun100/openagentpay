/**
 * Helpers shared across CLI subcommands.
 */

export interface CommandContext {
  readonly log: (s: string) => void;
  readonly err: (s: string) => void;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

/** Wraps process.exit so tests can mock if needed. */
export function exitWithCode(code: number): never {
  process.exit(code);
  // unreachable
  throw new Error(`process.exit(${code}) returned`);
}

/** Pretty-print an object as human-readable JSON. */
export function pretty(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

/** Find a flag in argv. Returns the value (next arg) or undefined. */
export function flag(
  argv: ReadonlyArray<string>,
  long: string,
  short?: string
): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === long || (short && a === short)) {
      return argv[i + 1];
    }
    if (a && a.startsWith(`${long}=`)) {
      return a.slice(long.length + 1);
    }
  }
  return undefined;
}

/** Returns true if a boolean flag is present. */
export function boolFlag(
  argv: ReadonlyArray<string>,
  long: string,
  short?: string
): boolean {
  return argv.includes(long) || (short !== undefined && argv.includes(short));
}

/** First positional arg (skipping flags + their values). */
export function firstPositional(
  argv: ReadonlyArray<string>,
  knownValueFlags: ReadonlyArray<string> = []
): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--") || a.startsWith("-")) {
      // skip flag — and its value if it's a known value flag
      if (knownValueFlags.includes(a)) i++;
      continue;
    }
    return a;
  }
  return undefined;
}
