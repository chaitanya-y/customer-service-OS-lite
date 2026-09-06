import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import { createElement, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { actionLabel, normalizeHumanCase } from "../components/human-case.ts";

// Execute the real private component with React, without adding a test-only
// production export or loading the surrounding page's network/image modules.
const source = await readFile(new URL("../components/refund-case-detail.tsx", import.meta.url), "utf8");
const parsed = ts.createSourceFile("refund-case-detail.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = parsed.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "DecisionForm");
assert.ok(component, "The case detail must contain its decision panel.");
const compiled = ts.transpileModule(component.getText(parsed), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  fileName: "decision-form.tsx",
}).outputText;
const DecisionForm = new Function("require", "exports", "useState", "actionLabel", "styles", `${compiled}\nreturn DecisionForm;`)(
  createRequire(import.meta.url), {}, useState, actionLabel, {},
);

function refundCase(overrides = {}) {
  return normalizeHumanCase({
    case_id: "claim-copy-case", workflow_id: "claim-copy-workflow", case_type: "REFUND_EVIDENCE_REVIEW",
    case_version: 1, created_at: "2026-09-06T12:00:00Z", updated_at: "2026-09-06T12:00:00Z",
    status: "OPEN", can_claim: true, allowed_actions: [], allowed_evidence_actions: [], review_packet: {}, ...overrides,
  });
}

function renderCase(value) {
  return renderToStaticMarkup(createElement(DecisionForm, { refundCase: value, onComplete: async () => {} }));
}

for (const [phase, label] of [
  ["REFUND_EVIDENCE_REVIEW", "Claim evidence review"],
  ["REFUND_APPROVAL", "Claim refund decision"],
  ["REFUND_TAKEOVER", "Claim refund decision"],
]) {
  test(`unclaimed ${phase} identifies the phase in its claim heading and button`, () => {
    const html = renderCase(refundCase({ case_type: phase }));
    assert.ok(html.includes(`<h2 id="decision-heading">${label}</h2>`));
    assert.match(html, new RegExp(`<button[^>]*>${label}</button>`));
    assert.doesNotMatch(html, /type="radio"|Record decision|Approve refund|Approve exceptional refund plan/);
  });
}

test("a phase transition response requires a fresh monetary claim before decision controls appear", () => {
  const evidenceClaimed = refundCase({ status: "CLAIMED", can_claim: false, assigned_staff_id: "staff-copy-test", case_version: 2 });
  assert.doesNotMatch(renderCase(evidenceClaimed), /Claim evidence review|Record decision/);

  // The authoritative transition clears assignment and does not grant actions.
  const transitioned = refundCase({ case_type: "REFUND_TAKEOVER", case_version: 3 });
  const beforeReclaim = renderCase(transitioned);
  assert.equal(transitioned.assignedStaffId, undefined);
  assert.match(beforeReclaim, /Unassigned/);
  assert.match(beforeReclaim, /<button[^>]*>Claim refund decision<\/button>/);
  assert.doesNotMatch(beforeReclaim, /type="radio"|Record decision/);

  const reclaimed = refundCase({ case_type: "REFUND_TAKEOVER", case_version: 4, status: "CLAIMED", can_claim: false,
    assigned_staff_id: "staff-copy-test", allowed_actions: ["REJECT", "RESOLVE_TAKEOVER", "APPROVE_EXCEPTIONAL_REFUND"] });
  const afterReclaim = renderCase(reclaimed);
  assert.match(afterReclaim, /Record decision/);
  assert.match(afterReclaim, /Reject request/);
  assert.doesNotMatch(afterReclaim, /Claim refund decision/);
});

test("an unavailable claim remains unavailable regardless of phase-specific wording", () => {
  for (const phase of ["REFUND_EVIDENCE_REVIEW", "REFUND_APPROVAL", "REFUND_TAKEOVER"]) {
    const html = renderCase(refundCase({ case_type: phase, can_claim: false }));
    assert.match(html, /Case status/);
    assert.doesNotMatch(html, /<button|type="radio"|Record decision/);
  }
});
