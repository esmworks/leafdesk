/**
 * What this server runs: Leafdesk's version and where the project lives, from package.json, so a
 * release changes the version in one place for the About tab and the MCP server alike.
 */
import pkg from "../../package.json";

const REPOSITORY = "https://github.com/esmworks/leafdesk";

/**
 * SOURCE_URL: where the source code of what this server runs can be had. Someone running a
 * changed Leafdesk points it at their own code; unset, it is this release's tag. Only http(s)
 * links count; anything else falls back to the tag.
 */
export function sourceUrlFrom(value: string | undefined, version: string): string {
  const url = value?.trim();
  if (url && /^https?:\/\/[^\s/]+/i.test(url)) return url.replace(/\/$/, "");
  return `${REPOSITORY}/tree/v${version}`;
}

export const APP_INFO = {
  name: "Leafdesk",
  version: pkg.version,
  author: pkg.author,
  authorUrl: "https://github.com/esmworks",
  license: pkg.license,
  homepage: pkg.homepage,
  repository: REPOSITORY,
  /** Read when asked, so the server's environment counts rather than the build's. */
  get source() {
    return sourceUrlFrom(process.env.SOURCE_URL, pkg.version);
  },
  issues: pkg.bugs,
  releaseNotes: `${REPOSITORY}/releases/tag/v${pkg.version}`,
  licenseText: `${REPOSITORY}/blob/v${pkg.version}/LICENSE`,
  notice: `${REPOSITORY}/blob/v${pkg.version}/NOTICE`,
} as const;
