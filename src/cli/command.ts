import { Command, CommanderError } from "commander";
import { runLark } from "../lark/client.js";
import {
  runImport,
  type ImportDependencies,
  type ImportOptions,
} from "./import.js";

const defaultDependencies: ImportDependencies = {
  runLark,
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

/** Runs the non-interactive CLI with user arguments, returning a process exit code. */
export async function runCli(
  argv: readonly string[],
  dependencies: ImportDependencies = defaultDependencies,
): Promise<number> {
  let status = 0;
  const program = new Command()
    .name("excalidraw-to-lark-board")
    .description("Convert an Excalidraw scene to Feishu whiteboard nodes.")
    .argument("<input>", "Excalidraw scene file")
    .argument(
      "[target]",
      "Feishu document URL to append a board to, or an existing whiteboard URL",
    )
    .option(
      "-o, --output <file>",
      "write node JSON to a new file instead of stdout",
    )
    .option(
      "--whiteboard-token <token>",
      "append nodes to a known whiteboard using the signed-in Lark CLI",
    )
    .configureOutput({
      writeOut: dependencies.stdout,
      writeErr: dependencies.stderr,
    })
    .exitOverride()
    .action(
      async (
        input: string,
        target: string | undefined,
        options: ImportOptions,
      ) => {
        if (target !== undefined && options.whiteboardToken !== undefined) {
          program.error("use either a target URL or --whiteboard-token", {
            exitCode: 2,
          });
        }
        if (
          options.whiteboardToken !== undefined &&
          !/^[A-Za-z0-9_-]+$/.test(options.whiteboardToken)
        ) {
          program.error("invalid whiteboard token", { exitCode: 2 });
        }
        status = await runImport(input, target, options, dependencies);
      },
    );

  try {
    await program.parseAsync(argv, { from: "user" });
    return status;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 2;
    dependencies.stderr(
      `Error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}
