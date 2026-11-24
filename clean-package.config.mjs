/**
 * @satisfies {Exclude<
 *   Parameters<typeof import('clean-package').load>[1],
 *   string | undefined
 * >}
 */
const defaultConfig = {
  remove: [
    "devDependencies",
    "scripts",
    "publishConfig",
  ],
};

export { defaultConfig as "module.exports" };
