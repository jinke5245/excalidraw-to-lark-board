import { spawn } from "node:child_process";
import { constants } from "node:os";

/** Captured output and exit status from a single Lark CLI invocation. */
export interface LarkResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs the Lark CLI with an argument vector and optional UTF-8 stdin. */
export type RunLark = (args: string[], input?: string) => Promise<LarkResult>;

/** Invokes the installed Lark CLI without passing arguments through a shell. */
export const runLark: RunLark = (args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn("lark-cli", args);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status, signal) => {
      resolve({
        status: status ?? (signal ? 128 + constants.signals[signal] : 1),
        stdout,
        stderr,
      });
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.stdin.end(input);
  });

/** Narrows a JSON value to a non-array object for response validation. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Returns a successful Lark JSON envelope, or surfaces the CLI error details. */
export async function requestLark(run: RunLark, args: string[]) {
  const result = await run(args);
  if (result.status !== 0) {
    throw new Error(
      [
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n") || `lark-cli failed with exit code ${result.status}`,
    );
  }
  const response: unknown = JSON.parse(result.stdout);
  if (!isRecord(response) || response.ok !== true || !isRecord(response.data)) {
    throw new Error(`lark-cli request failed: ${result.stdout.trim()}`);
  }
  return { ok: true as const, data: response.data };
}
