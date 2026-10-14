/**
 * What this server runs: Leafdesk's version and where the project lives, from package.json, so a
 * release changes the version in one place for the About tab and the MCP server alike.
 */
import pkg from "../../package.json";

const REPOSITORY = "https://github.com/esmworks/leafdesk";

export const APP_INFO = {
  name: "Leafdesk",
  version: pkg.version,
  author: pkg.author,
  authorUrl: "https://github.com/esmworks",
  license: pkg.license,
  homepage: pkg.homepage,
  repository: REPOSITORY,
  issues: pkg.bugs,
  releaseNotes: `${REPOSITORY}/releases/tag/v${pkg.version}`,
  licenseText: `${REPOSITORY}/blob/v${pkg.version}/LICENSE`,
  notice: `${REPOSITORY}/blob/v${pkg.version}/NOTICE`,
} as const;
