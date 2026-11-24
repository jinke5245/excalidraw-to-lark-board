/**
 * Resolves Feishu and Lark import destinations from their web links.
 *
 * A document URL resolves to a Docx ID for creating a board. A whiteboard URL
 * or a document link anchored to a board block resolves to an existing board
 * token. Wiki links first resolve to their underlying Docx document. The
 * module checks the original URL spelling and uses read-only CLI calls as the
 * authenticated user to verify board tokens and block anchors.
 *
 * @packageDocumentation
 */

export {};
