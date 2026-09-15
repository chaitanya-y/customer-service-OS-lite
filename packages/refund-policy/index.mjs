import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const defaultCatalogPath = fileURLToPath(new URL("./releases.json", import.meta.url));
const releaseKeys = new Set([
  "policyVersion",
  "supportedCurrency",
  "automaticMaximumMinor",
  "approvalMaximumMinor",
  "elevatedRiskPriorRefundCount",
  "highRiskPriorRefundCount",
  "decisionValiditySeconds",
  "permittedReasonCodes",
  "requireDamagePhoto",
]);

function invalidCatalog() {
  return new Error("INVALID_REFUND_POLICY_CATALOG");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateRelease(value) {
  if (
    !isRecord(value)
    || Object.keys(value).some((key) => !releaseKeys.has(key))
    || typeof value.policyVersion !== "string"
    || value.policyVersion.length === 0
    || value.supportedCurrency !== "USD"
    || !isNonNegativeInteger(value.automaticMaximumMinor)
    || !isNonNegativeInteger(value.approvalMaximumMinor)
    || value.automaticMaximumMinor > value.approvalMaximumMinor
    || !isNonNegativeInteger(value.elevatedRiskPriorRefundCount)
    || !isNonNegativeInteger(value.highRiskPriorRefundCount)
    || value.elevatedRiskPriorRefundCount >= value.highRiskPriorRefundCount
    || !Number.isSafeInteger(value.decisionValiditySeconds)
    || value.decisionValiditySeconds <= 0
    || !Array.isArray(value.permittedReasonCodes)
    || value.permittedReasonCodes.length === 0
    || value.permittedReasonCodes.some(
      (reason) => typeof reason !== "string" || reason.length === 0,
    )
    || new Set(value.permittedReasonCodes).size !== value.permittedReasonCodes.length
    || (
      value.requireDamagePhoto !== undefined
      && typeof value.requireDamagePhoto !== "boolean"
    )
  ) {
    throw invalidCatalog();
  }

  return Object.freeze({
    ...value,
    permittedReasonCodes: Object.freeze([...value.permittedReasonCodes]),
  });
}

export function loadRefundPolicyCatalog(catalogPath = defaultCatalogPath) {
  let rawCatalog;
  let parsed;
  try {
    rawCatalog = readFileSync(catalogPath);
    parsed = JSON.parse(rawCatalog.toString("utf8"));
  } catch (error) {
    throw invalidCatalog();
  }

  if (
    !isRecord(parsed)
    || Object.keys(parsed).length !== 2
    || parsed.schemaVersion !== "1"
    || !Array.isArray(parsed.releases)
    || parsed.releases.length === 0
  ) {
    throw invalidCatalog();
  }

  const releases = Object.create(null);
  for (const rawRelease of parsed.releases) {
    const release = validateRelease(rawRelease);
    if (Object.hasOwn(releases, release.policyVersion)) {
      throw invalidCatalog();
    }
    releases[release.policyVersion] = release;
  }

  return Object.freeze({
    catalogSha256: createHash("sha256").update(rawCatalog).digest("hex"),
    releases: Object.freeze(releases),
  });
}

const catalog = loadRefundPolicyCatalog();

export function getRefundPolicyRelease(version) {
  if (!Object.hasOwn(catalog.releases, version)) {
    throw new Error("UNKNOWN_REFUND_POLICY_VERSION");
  }
  return catalog.releases[version];
}

export function getRefundPolicyBinding(version) {
  getRefundPolicyRelease(version);
  return Object.freeze({
    policyVersion: version,
    catalogSha256: catalog.catalogSha256,
  });
}
