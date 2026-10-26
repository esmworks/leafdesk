import assert from "node:assert/strict";
import { test } from "node:test";
import { certificateChanged, isCertificateError } from "./certificates.ts";

const FINGERPRINT = "AA:BB:CC";

test("an untrusted certificate where a good one was is called out", () => {
  // Never seen with a good certificate, nothing trusted: a self-signed server met for the first time.
  assert.equal(certificateChanged("leafdesk.lan", FINGERPRINT, {}, []), false);
  // The same certificate the person trusted before (asked again after a restart, say).
  assert.equal(certificateChanged("leafdesk.lan", FINGERPRINT, { "leafdesk.lan": FINGERPRINT }, []), false);
  // Another certificate than the one trusted.
  assert.equal(certificateChanged("leafdesk.lan", FINGERPRINT, { "leafdesk.lan": "DD:EE:FF" }, []), true);
  // The host had a certificate this computer trusts.
  assert.equal(certificateChanged("leafdesk.example.com", FINGERPRINT, {}, ["leafdesk.example.com"]), true);
  assert.equal(certificateChanged("leafdesk.example.com", FINGERPRINT, {}, ["other.example.com"]), false);
  assert.equal(certificateChanged("constructor", FINGERPRINT, {}, []), false);
});

test("certificate errors", () => {
  assert.equal(isCertificateError("net::ERR_CERT_AUTHORITY_INVALID"), true);
  assert.equal(isCertificateError("net::ERR_CONNECTION_REFUSED"), false);
});
