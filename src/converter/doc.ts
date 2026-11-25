/**
 * Pure conversion from Excalidraw v2 scene JSON to native Feishu board nodes.
 * The converter keeps element order for stable IDs, preserves connector bindings,
 * and collects embedded images for later upload by the caller.
 * Unsupported elements are skipped. A Magic Frame's supported children remain
 * on the canvas at their original coordinates.
 *
 * @module converter
 */
export {};
