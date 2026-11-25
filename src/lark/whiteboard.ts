import { createHash } from "node:crypto";
import { isRecord, requestLark, type RunLark } from "./client.js";

const URL_NAMESPACE = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
const TOKEN = /^[A-Za-z0-9_-]+$/;

function requestToken(name: string): string {
  const digest = createHash("sha1")
    .update(URL_NAMESPACE)
    .update(name, "utf8")
    .digest();
  digest[6] = (digest.readUInt8(6) & 0x0f) | 0x50;
  digest[8] = (digest.readUInt8(8) & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

/** Appends a whiteboard block at the end of a Docx document and returns both IDs. */
export async function createWhiteboard(
  run: RunLark,
  documentId: string,
  requestContent: string,
) {
  const clientToken = requestToken(
    `feishu-document-board:${documentId}:${requestContent}`,
  );
  const { data } = await requestLark(run, [
    "api",
    "POST",
    `/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children`,
    "--params",
    JSON.stringify({ client_token: clientToken }),
    "--data",
    JSON.stringify({ index: -1, children: [{ block_type: 43, board: {} }] }),
    "--as",
    "user",
    "--format",
    "json",
  ]);
  const children: unknown = data.children;
  if (Array.isArray(children) && children.length === 1) {
    const [block] = children as unknown[];
    if (isRecord(block) && block.block_type === 43 && isRecord(block.board)) {
      const { block_id: blockId } = block;
      const { token } = block.board;
      if (
        typeof blockId === "string" &&
        TOKEN.test(blockId) &&
        typeof token === "string" &&
        TOKEN.test(token)
      ) {
        return { blockId, token };
      }
    }
  }
  throw new Error(
    "document response did not return the new whiteboard block ID and token",
  );
}

/** Returns the signed-in user's Open ID required for native sticky notes. */
export async function stickyNoteAuthor(run: RunLark): Promise<string> {
  const status = await run([
    "auth",
    "status",
    "--json",
  ]);
  if (status.status === 0) {
    const value: unknown = JSON.parse(status.stdout);
    if (
      isRecord(value) &&
      isRecord(value.identities) &&
      isRecord(value.identities.user)
    ) {
      const { openId } = value.identities.user;
      if (typeof openId === "string" && openId.startsWith("ou_")) return openId;
    }
  }
  throw new Error(
    "sticky notes require a signed-in lark-cli user with an Open ID",
  );
}

/** Uploads a local image path relative to the working directory and returns its media token. */
export async function uploadWhiteboardImage(
  run: RunLark,
  token: string,
  filename: string,
): Promise<string> {
  const { data } = await requestLark(run, [
    "docs",
    "+media-upload",
    "--as",
    "user",
    "--parent-type",
    "whiteboard",
    "--parent-node",
    token,
    "--file",
    filename,
    "--format",
    "json",
  ]);
  if (typeof data.file_token !== "string" || !data.file_token) {
    throw new Error("image upload did not return a file token");
  }
  return data.file_token;
}

/** Appends raw nodes using a stable request token and returns the underlying CLI status. */
export function appendWhiteboardNodes(
  run: RunLark,
  token: string,
  requestContent: string,
  nodes: string,
) {
  const idempotentToken = requestToken(
    `feishu-whiteboard:${token}:${requestContent}`,
  );
  return run(
    [
      "whiteboard",
      "+update",
      "--whiteboard-token",
      token,
      "--source",
      "-",
      "--input_format",
      "raw",
      "--idempotent-token",
      idempotentToken,
      "--as",
      "user",
    ],
    nodes,
  );
}
