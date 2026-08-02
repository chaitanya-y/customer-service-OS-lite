import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../..");

const contracts = {
  contextAssertion:
    "contracts/internal-api/trusted-context-assertion/v1/context-assertion-claims.schema.json",
  executionEvidence:
    "contracts/ai-io/execution-evidence/v1/execution-evidence.schema.json",
  orderContext:
    "contracts/tools/order-context/v1/order-context.schema.json",
  refundProposal:
    "contracts/workflows/proposals/v1/refund-proposal.schema.json",
  policyDecision:
    "contracts/workflows/policy/v1/policy-decision.schema.json",
};

const fixtures = {
  contextAssertion: "context-assertion",
  executionEvidence: "execution-evidence",
  orderContext: "order-context",
  refundProposal: "refund-proposal",
  policyDecision: "policy-decision",
};

async function readJson(relativePath) {
  const content = await readFile(
    path.join(repositoryRoot, relativePath),
    "utf8",
  );
  return JSON.parse(content);
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
});
addFormats(ajv);

for (const schemaPath of Object.values(contracts)) {
  ajv.addSchema(await readJson(schemaPath));
}

for (const [contractName, schemaPath] of Object.entries(contracts)) {
  test(`${contractName} schema compiles`, () => {
    const schema = ajv.getSchema(
      pathToSchemaId(schemaPath),
    );
    assert.ok(schema);
  });

  test(`${contractName} accepts its valid fixture`, async () => {
    const validate = ajv.getSchema(pathToSchemaId(schemaPath));
    const fixture = await readJson(
      `tests/contract/fixtures/${fixtures[contractName]}/valid.json`,
    );

    assert.equal(
      validate(fixture),
      true,
      ajv.errorsText(validate.errors),
    );
  });

  test(`${contractName} rejects its unsafe fixture`, async () => {
    const validate = ajv.getSchema(pathToSchemaId(schemaPath));
    const fixture = await readJson(
      `tests/contract/fixtures/${fixtures[contractName]}/invalid.json`,
    );

    assert.equal(validate(fixture), false);
    assert.ok(validate.errors?.length);
  });
}

function pathToSchemaId(schemaPath) {
  const ids = {
    [contracts.contextAssertion]:
      "https://customer-service-os.example/contracts/internal-api/trusted-context-assertion/v1/claims",
    [contracts.executionEvidence]:
      "https://customer-service-os.example/contracts/ai-io/execution-evidence/v1",
    [contracts.orderContext]:
      "https://customer-service-os.example/contracts/tools/order-context/v1",
    [contracts.refundProposal]:
      "https://customer-service-os.example/contracts/workflows/proposals/v1/refund-proposal",
    [contracts.policyDecision]:
      "https://customer-service-os.example/contracts/workflows/policy/v1/refund-policy-decision",
  };

  return ids[schemaPath];
}
