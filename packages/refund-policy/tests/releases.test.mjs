import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  getRefundPolicyBinding,
  getRefundPolicyRelease,
  loadRefundPolicyCatalog,
} from "../index.mjs";

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));

test("loads unchanged v1 and v2 releases from the shared catalog", () => {
  const v1 = getRefundPolicyRelease("refund-policy-v1");
  const v2 = getRefundPolicyRelease("refund-policy-v2");

  assert.deepEqual(v1, {
    policyVersion: "refund-policy-v1",
    supportedCurrency: "USD",
    automaticMaximumMinor: 10_000,
    approvalMaximumMinor: 50_000,
    elevatedRiskPriorRefundCount: 1,
    highRiskPriorRefundCount: 2,
    decisionValiditySeconds: 900,
    permittedReasonCodes: [
      "DAMAGED",
      "DEFECTIVE",
      "WRONG_ITEM",
      "NOT_AS_DESCRIBED",
      "MISSING_ITEM",
      "LATE_DELIVERY",
      "NO_LONGER_NEEDED",
      "OTHER",
    ],
  });
  assert.deepEqual(v2, {
    ...v1,
    policyVersion: "refund-policy-v2",
    requireDamagePhoto: true,
  });
});

test("returns deeply immutable releases", () => {
  const release = getRefundPolicyRelease("refund-policy-v1");

  assert.equal(Object.isFrozen(release), true);
  assert.equal(Object.isFrozen(release.permittedReasonCodes), true);
  assert.throws(() => {
    release.permittedReasonCodes.push("INJECTED_REASON");
  }, TypeError);
  assert.throws(() => {
    release.automaticMaximumMinor = 1;
  }, TypeError);
  assert.equal(getRefundPolicyRelease("refund-policy-v1").automaticMaximumMinor, 10_000);
});

test("binds every known version to the SHA-256 of the exact catalog bytes", async () => {
  const rawCatalog = await readFile(join(packageDirectory, "releases.json"));
  const expectedSha256 = createHash("sha256").update(rawCatalog).digest("hex");

  assert.deepEqual(getRefundPolicyBinding("refund-policy-v1"), {
    policyVersion: "refund-policy-v1",
    catalogSha256: expectedSha256,
  });
  assert.equal(Object.isFrozen(getRefundPolicyBinding("refund-policy-v1")), true);
});

test("rejects unknown releases", () => {
  assert.throws(
    () => getRefundPolicyRelease("refund-policy-unknown"),
    /UNKNOWN_REFUND_POLICY_VERSION/,
  );
  assert.throws(
    () => getRefundPolicyBinding("refund-policy-unknown"),
    /UNKNOWN_REFUND_POLICY_VERSION/,
  );
  assert.throws(
    () => getRefundPolicyRelease("constructor"),
    /UNKNOWN_REFUND_POLICY_VERSION/,
  );
});

test("rejects invalid catalog bounds before exposing a release", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "refund-policy-"));
  const invalidCatalogPath = join(temporaryDirectory, "releases.json");
  await writeFile(
    invalidCatalogPath,
    JSON.stringify({
      schemaVersion: "1",
      releases: [
        {
          policyVersion: "refund-policy-invalid",
          supportedCurrency: "USD",
          automaticMaximumMinor: 50_001,
          approvalMaximumMinor: 50_000,
          elevatedRiskPriorRefundCount: 1,
          highRiskPriorRefundCount: 2,
          decisionValiditySeconds: 900,
          permittedReasonCodes: ["DAMAGED"],
        },
      ],
    }),
  );

  assert.throws(
    () => loadRefundPolicyCatalog(invalidCatalogPath),
    /INVALID_REFUND_POLICY_CATALOG/,
  );
});
