import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  convert,
  type BoardNode,
  type RasterAsset,
} from "../converter/index.js";
import { isRecord, requestLark, type RunLark } from "../lark/client.js";
import {
  appendWhiteboardNodes,
  createWhiteboard,
  stickyNoteAuthor,
  uploadWhiteboardImage,
} from "../lark/whiteboard.js";
import { resolveTarget } from "../target/index.js";

/** Command options used by the import workflow. */
export interface ImportOptions {
  output?: string;
  whiteboardToken?: string;
}

/** External services and output streams used by the import command. */
export interface ImportDependencies {
  runLark: RunLark;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

async function checkOutput(filename: string) {
  try {
    await access(filename);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`output already exists: ${filename}`);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!isRecord(item)) return item;
    return Object.fromEntries(
      Object.keys(item)
        .sort()
        .map((key) => [
          key,
          item[key],
        ]),
    );
  });
}

async function uploadAssets(
  nodes: BoardNode[],
  assets: Map<string, RasterAsset>,
  token: string,
  run: RunLark,
) {
  const workingDirectory = process.cwd();
  const directory = await mkdtemp(join(workingDirectory, ".feishu-assets-"));
  try {
    for (const node of nodes) {
      const asset = assets.get(node.id);
      if (!asset || !node.image) continue;
      const filename = join(
        directory,
        node.id.replaceAll(":", "-") + asset.suffix,
      );
      await writeFile(filename, asset.data);
      try {
        node.image.token = await uploadWhiteboardImage(
          run,
          token,
          relative(workingDirectory, filename),
        );
      } catch (error) {
        throw new Error(
          `image upload failed for ${node.id}: ${error instanceof Error ? error.message : error}`,
          {
            cause: error,
          },
        );
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Converts a scene, optionally appends it to a whiteboard, and returns its exit status. */
export async function runImport(
  filename: string,
  targetUrl: string | undefined,
  options: ImportOptions,
  dependencies: ImportDependencies,
): Promise<number> {
  const { runLark, stdout, stderr } = dependencies;
  if (options.output) await checkOutput(options.output);
  const target =
    targetUrl === undefined
      ? undefined
      : await resolveTarget(targetUrl, (args) => requestLark(runLark, args));
  const scene: unknown = JSON.parse(
    (await readFile(filename, "utf8")).replace(/^\uFEFF/, ""),
  );
  const importing =
    targetUrl !== undefined || options.whiteboardToken !== undefined;
  const assets = new Map<string, RasterAsset>();
  const { payload, warnings } = await convert(
    scene,
    importing ? { assets } : {},
  );

  const notes = payload.nodes.flatMap((node) =>
    node.sticky_note ? [node.sticky_note] : [],
  );
  if (notes.length > 0) {
    const author = await stickyNoteAuthor(runLark);
    for (const note of notes) note.user_id = author;
  }

  let data = JSON.stringify(payload, null, 2) + "\n";
  let requestContent = data;
  if (assets.size > 0) {
    const hashedAssets = Object.fromEntries(
      Array.from(
        assets,
        ([
          id,
          { data },
        ]) => [
          id,
          createHash("sha256").update(data).digest("hex"),
        ],
      ),
    );
    requestContent += canonicalJson(hashedAssets);
  }

  let token = options.whiteboardToken;
  if (target && targetUrl) {
    if ("documentId" in target && target.documentId) {
      const board = await createWhiteboard(
        runLark,
        target.documentId,
        requestContent,
      );
      token = board.token;
      stderr(`Whiteboard: ${targetUrl.split("#", 1)[0]}#${board.blockId}\n`);
    } else {
      token = target.boardToken;
    }
  }
  if (token && assets.size > 0) {
    await uploadAssets(payload.nodes, assets, token, runLark);
    data = JSON.stringify(payload, null, 2) + "\n";
  }
  for (const warning of warnings) stderr(`Warning: ${warning}\n`);
  if (options.output) {
    await writeFile(options.output, data, { encoding: "utf8", flag: "wx" });
  } else {
    stdout(data);
  }

  if (!token) return 0;
  const result = await appendWhiteboardNodes(
    runLark,
    token,
    requestContent,
    data,
  );
  if (result.stdout) stderr(result.stdout);
  if (result.stderr) stderr(result.stderr);
  return result.status;
}
