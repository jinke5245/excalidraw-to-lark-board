import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  convert,
  PNG_SIGNATURE,
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
  snapshot: string[];
}

/** External services and output streams used by the import command. */
export interface ImportDependencies {
  runLark: RunLark;
  renderSnapshots: (
    scene: unknown,
    elementIds: string[],
  ) => Promise<Map<string, RasterAsset>>;
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

async function snapshotOverrides(values: string[]) {
  const snapshots = new Map<string, RasterAsset>();
  for (const value of values) {
    const equals = value.indexOf("=");
    const elementId = value.slice(0, equals);
    const filename = value.slice(equals + 1);
    if (equals <= 0 || !filename || snapshots.has(elementId)) {
      throw new Error(
        "expected --snapshot ELEMENT_ID=FILE.png with a unique element ID",
      );
    }
    const data = await readFile(filename);
    if (!data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw new Error(`${filename}: snapshots must be PNG files`);
    }
    snapshots.set(elementId, { suffix: ".png", data });
  }
  return snapshots;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!isRecord(item)) return item;
    return Object.fromEntries(
      Object.keys(item)
        .sort()
        .map((key) => [key, item[key]]),
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
  const { runLark, renderSnapshots, stdout, stderr } = dependencies;
  if (options.output) await checkOutput(options.output);
  const target =
    targetUrl === undefined
      ? undefined
      : await resolveTarget(targetUrl, (args) => requestLark(runLark, args));
  const snapshots = await snapshotOverrides(options.snapshot);
  const scene: unknown = JSON.parse(
    (await readFile(filename, "utf8")).replace(/^\uFEFF/, ""),
  );
  const importing =
    targetUrl !== undefined || options.whiteboardToken !== undefined;
  const assets = new Map<string, RasterAsset>();
  let usedAutomaticSnapshots = false;
  const { payload, warnings } = await convert(scene, {
    assets: importing ? assets : undefined,
    snapshots,
    autoRender: importing
      ? async (elementIds) => {
          const generated = await renderSnapshots(scene, elementIds);
          usedAutomaticSnapshots = generated.size > 0;
          return generated;
        }
      : undefined,
  });

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
    // Automatic captures can change even when retrying the same source scene.
    if (usedAutomaticSnapshots) requestContent += canonicalJson(scene);
    const hashedAssets = Object.fromEntries(
      Array.from(
        usedAutomaticSnapshots ? snapshots : assets,
        ([id, { data }]) => [
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
