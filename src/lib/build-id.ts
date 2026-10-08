/**
 * Which build of Leafdesk a browser tab runs, against the build the server runs.
 *
 * Why it matters: y-prosemirror deletes a Yjs element its editor schema can't build (the `catch` in
 * `createNodeFromYElement`), and the deletion syncs to everyone. A tab running a bundle from before
 * a release that added a block type (columns, Mermaid, a table of contents…) would erase those
 * blocks from the page the moment it renders them. A text style it doesn't know is worse: the
 * `catch` in `createTextNodesFromYText` deletes the whole text of the block holding it (a
 * superscript takes its paragraph with it). So a tab whose bundle isn't the server's never loads a
 * page document: not from the server, not from this browser's offline copy.
 *
 * Pure helpers only; the browser side is components/collab/freshness, the server's build is
 * server/build-id.
 */

/** The build this bundle came from, stamped by next.config at `next build`; empty in development. */
export const CLIENT_BUILD: string = process.env.LEAFDESK_BUILD_ID ?? "";

/** Query parameter of the collab websocket that carries the tab's build. */
export const BUILD_PARAM = "build";

/** localStorage: the last build the server confirmed to a tab of this browser. */
export const SEEN_BUILD_KEY = "leafdesk:build";

/**
 * Is a tab running `client` foreign to a server (or another tab) running `other`? Either way round:
 * a newer bundle than the server's is as wrong as an older one (a rolled-back release). An unknown
 * build on either side (development, an older server, nothing stored) is never foreign, so missing
 * information never locks anyone out.
 */
export function isForeignBuild(client: string | null | undefined, other: string | null | undefined): boolean {
  const a = client?.trim();
  const b = other?.trim();
  return Boolean(a && b && a !== b);
}
