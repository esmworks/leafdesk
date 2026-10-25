export const SOCIAL_PROVIDERS = ["github", "google", "apple"] as const;
export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];

export const SOCIAL_PROVIDER_NAMES: Record<SocialProvider, string> = { github: "GitHub", google: "Google", apple: "Apple" };

export type SocialCredentials = { clientId: string; clientSecret: string };

/**
 * OAuth apps configured through `<PROVIDER>_CLIENT_ID` and `<PROVIDER>_CLIENT_SECRET`. A provider
 * is on only when both are set; anything else leaves it off, so sign-in looks as before. Apple's
 * secret is a JWT that runs out; lib/apple-client-secret.ts makes it from a key instead.
 */
export function socialProvidersFrom(source: Record<string, string | undefined>) {
  const enabled: Partial<Record<SocialProvider, SocialCredentials>> = {};
  for (const provider of SOCIAL_PROVIDERS) {
    const prefix = provider.toUpperCase();
    const clientId = source[`${prefix}_CLIENT_ID`]?.trim();
    const clientSecret = source[`${prefix}_CLIENT_SECRET`]?.trim();
    if (clientId && clientSecret) enabled[provider] = { clientId, clientSecret };
  }
  return enabled;
}
