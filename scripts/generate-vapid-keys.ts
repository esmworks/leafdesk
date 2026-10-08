/**
 * Makes a VAPID key pair for push notifications and prints the lines to put in .env:
 *
 *   pnpm push:keys [mailto:you@example.com]
 *
 * In Docker: docker compose run --rm app tsx scripts/generate-vapid-keys.ts mailto:you@example.com
 *
 * Keep the private key secret. Changing the keys later stops push on every device until it is
 * turned on again there (Settings > Preferences).
 */
import webpush from "web-push";

const subject = process.argv[2] ?? "mailto:you@example.com";
if (!/^mailto:\S+@\S+$/i.test(subject) && !/^https:\/\/\S+$/i.test(subject)) {
  console.error("The subject must be a mailto: or https: address, e.g. mailto:ops@example.com");
  process.exit(1);
}
const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log(`VAPID_SUBJECT=${subject}`);
