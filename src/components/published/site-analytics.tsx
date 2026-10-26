/** `value` as a string literal of an inline script: JSON, with "<" escaped. */
export const scriptString = (value: string) => JSON.stringify(value).replace(/</g, "\\u003c");

/**
 * Google Analytics 4 on a site's pages, when its owner set a measurement ID: Google's tag and its
 * setup, both carrying the response's nonce. The proxy lets exactly Google's hosts into this
 * response's policy (lib/content-security-policy.ts); `id` is checked to be `G-` and letters or
 * digits before it gets here.
 */
export function SiteAnalytics({ id, nonce }: { id: string; nonce: string | undefined }) {
  // Escaped for an inline script all the same: a "<" in it could never close the script element.
  const setup = `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag("js",new Date());gtag("config",${scriptString(id)});`;
  return (
    <>
      <script async src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`} nonce={nonce} />
      <script nonce={nonce} dangerouslySetInnerHTML={{ __html: setup }} />
    </>
  );
}
