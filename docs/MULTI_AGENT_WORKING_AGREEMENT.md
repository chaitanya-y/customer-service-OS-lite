# Multi-agent working agreement

Agreed on 2026-09-05 after reviewing an expensive parallel implementation batch.
Applies to coding assistants working on this repository. It governs the working
process, not the customer-support agents implemented by the product.

## 1. Delegate only when it helps

Use one agent for small edits, documentation, a single bug, or tightly coupled
changes. Do not create an agent merely to keep every slot occupied.

When the user approves parallel work, start with one coordinator and one worker.
Use a second worker only when its bounded task can proceed independently and the
coordinator has useful integration work to do. More than two workers needs
explicit approval. Workers must not spawn additional agents without approval.

Parallel work can reduce elapsed time while increasing total model usage. Never
promise that doubling agents halves time or preserves the same allowance cost.
This agreement does not authorize delegation for every future request.

## 2. Agree on a small batch before starting

The coordinator states these items in one short plan:

1. One concrete outcome and its acceptance checks.
2. Non-goals and deferred improvements.
3. Agent tasks, exclusive edit paths and shared-contract owner.
4. Dependencies: what must be settled before another task can proceed.
5. Model/reasoning choices and the checkpoint budget.
6. Who runs focused tests, final integration, browsers and documentation checks.

Do not silently turn a contract task into a complete UI/API/storage rollout.
Report newly discovered work and get approval for material scope expansion.
Required fixes for the approved outcome remain in scope, but count against its
budget. Optional refactoring and unrelated cleanup wait for another batch.

### Task-based model selection

The owner approved this approach on 2026-09-05, including powerful models when
the task requires them. Within a user-approved parallel batch, the coordinator
may select worker models and reasoning levels using this guide without asking
again for each routine selection. This is not permission to launch a new batch,
increase agent counts or exceed the agreed scope/budget. A specific user model
request takes precedence; leave the main conversation's selected model unchanged.

| Work | Starting model and reasoning |
| --- | --- |
| Small fixes, documentation, focused tests with clear expected behavior | Luna, low or medium |
| Clearly designed backend or frontend implementation | Terra, medium |
| Difficult implementation or debugging across several services | Sol, high when justified |
| Ambiguous architecture, security boundaries, complex refund logic and critical final review | Astra, high when justified |

These are project defaults, not a quality ranking or a promise of savings. Verify
the models and reasoning levels available in the current session. Do not silently
substitute an unavailable requested model. Prefer medium reasoning for ordinary
work; use high or deeper reasoning when the task justifies it, not for every worker.

- State each worker's model, reasoning level and one-sentence rationale before
  launching it. Use only the models the batch needs, not one agent per model.
- Select a strong model from the start for uncertain authorization, tenant
  isolation, money movement, durable state transitions or difficult concurrency.
  Do not force a cheaper model to fail first. Test design can also be complex;
  not all testing belongs on Luna.
- If a worker encounters complexity beyond its brief, report the evidence and
  move that bounded task to a stronger model when warranted. Explain the change,
  preserve its useful findings and stop the previous assignment before handing
  over edit ownership. Do not run competing implementations or restart the whole
  feature. Existing loop and budget checkpoints still apply.
- Pass an explicit supported worker model/reasoning setting with a scoped brief.
  In the current Codex tools, full-history forks inherit the parent settings;
  use a fresh or limited-history fork when selecting a different worker model.
- Judge efficiency by verified outcomes, elapsed time and observed usage, not
  model price alone. Smaller models can require more rework; stronger models can
  be the efficient choice. Never promise a fixed allowance saving.

This policy configures our coding workflow only. It does not implement the
product's planned Model Gateway or change its runtime provider/model settings.

## 3. Keep worker context small and sufficient

The coordinator does project onboarding once and sends each worker a compact
brief with exact paths, contracts, decisions and tests. Prefer a fresh/scoped
context over inheriting the entire long conversation.

Every worker must read:

- Root and applicable child `AGENTS.md` instructions.
- The assigned source files and canonical contracts for its boundary.
- The focused tests and specific architecture/authentication references needed
  for its task. Authentication work must read `LOCAL_AUTH_AND_SECRETS.md`.
- Any applicable skill's required instructions, completely as required.

The worker need not reread the full README, architecture, project history and
handoff collection for an isolated task. If its brief is insufficient or its
scope crosses a new trust boundary, ask the coordinator and read the additional
relevant material before proceeding. Limited context must not mean guessed APIs.

Reuse valid context and completed test evidence. Re-read changed sections, not
whole documents repeatedly. Keep tool output bounded: show failures, counts and
relevant excerpts; retain large logs locally outside Git and read them on demand.
Never include secrets or raw customer data in briefs, summaries or logs.

## 4. Give each file and shared resource one owner

- Each editable path has one active owner, including tests and shared schemas.
- Settle shared contracts before dependent implementation. Backend and UI may
  run in parallel against an agreed contract, not competing invented shapes.
- Reassign a file explicitly before another agent edits it. Preserve local work;
  do not overwrite or revert another agent's changes.
- Assign one owner for dependencies and lockfiles. Do not run concurrent installs
  or builds against the same output directory.
- The coordinator owns integration, server restarts, migrations, local tokens,
  test data and Git operations. Separate approval requirements still apply.
- Do not create commits, push, merge, reset or switch branches just because a
  worker finished. User authorization governs those actions.

Use descriptive task names. Reuse a worker for closely related follow-up work;
do not keep adding unrelated tasks to a large, stale worker conversation.

## 5. Preflight once, then test in layers

Before a live test, check the actual repository path, selected runtime, required
service health, authentication validity and browser availability. Ensure the app
workspace points at the real checkout. Fix workspace access normally; never
disable safety controls to avoid permission handling.

Do not start all services for a unit test. The coordinator keeps one authoritative
record of live service endpoints/processes and token expiry metadata, not token
values. Only restart the affected service after configuration/source changes.

Testing responsibilities:

1. Worker runs focused tests and its boundary's typecheck/lint after changes.
2. Worker reports exact commands, outcomes, skips and the files those checks cover.
3. Coordinator reviews the diff and runs cross-boundary checks after integration.
4. Run relevant final suites/builds once on settled code. Reuse a worker's valid
   result if covered files, dependencies, configuration and fixtures are unchanged.
5. After a late fix, rerun affected checks and any impacted integration tests.
   Do not skip necessary coverage simply to meet the checkpoint budget.

Keep a small in-task check ledger: command, owner, covered files, result and
whether later edits invalidate it. No separate tracking application is needed.
Report new tests separately from total passing tests; do not count repeated runs
as additional coverage. Distinguish mocks, live HTTP, browser clicks and provider
execution. Synthetic success is not production certification.

## 6. Detect loops and control usage

Unless the user sets another budget:

- Review progress at 10 minutes or an observed 5 percentage-point increase in the
  account allowance, whichever is noticed first.
- At 20 minutes or an observed 10-point increase, stop expanding work, stop
  dispatching agents, reach the nearest safe checkpoint and ask whether to
  continue, reduce scope or change the model/approach. Do not leave a known broken
  state without explaining it, and do not discard unfinished local work.
- Check available usage at the start, a checkpoint and completion, not after
  every tool call. If unavailable, use elapsed time and say usage is unknown.
- Account usage is shared. An observed increase is a checkpoint signal, not
  exact attribution to this task. These checks cannot guarantee a hard usage cap.
- Never redeem a usage reset automatically.

After two attempts fail with the same symptom, stop identical retries. Record the
failure, identify what assumption is wrong, and choose one targeted diagnostic or
a different supported approach. After a third failure with no new evidence,
report the blocker and ask for direction instead of continuing an open-ended loop.
Evidence-driven debugging may continue within the agreed budget.

This also applies to broken browser sessions and test harnesses: distinguish a
test-infrastructure failure from an application defect before changing product
code. Do not repeatedly restart healthy services or create duplicate workflows.

Agents send updates on contract changes, blockers, findings and completion. The
coordinator uses bounded waits/status checks, not busy polling or repetitive
"still working" messages. Keep user updates concise, with what changed and what
remains, at the cadence required by the environment.

## 7. Finish at a verified stopping point

Workers stop when their acceptance checks pass. Their handoff should normally be
under 200 words: changed files/functions, checks/results, contract changes,
remaining issues and side effects. Important safety findings are never omitted
to meet a length target.

The coordinator integrates, reviews and updates documentation once the batch is
stable. A review finding triggers a scoped fix and relevant regression checks,
not a fresh implementation of the whole feature. Confirm all workers are stopped
or complete before declaring the batch finished.

Final report: completed outcomes, a simple example, file-by-file changes/main
functions, exact verification scope, deferred work and whether anything was
committed or pushed. Link to detailed documentation instead of pasting whole
files. Preserve the owner's learning goal as well as the usage budget.

## Worker brief template

```text
Outcome and acceptance criteria:
Exclusive edit paths:
Read-only dependencies and canonical contract:
Required safety/architecture context:
Non-goals and forbidden side effects:
Model/reasoning choice approved for this task:
Focused checks you own:
Dependencies/contact for contract questions:
Checkpoint time and stop conditions:
Return: changed files/functions, exact check results, blockers and side effects.
Do not spawn agents, change shared services/secrets, or perform Git mutations.
```

## Example split

For a small new endpoint and its interface, agree on the response/error contract
first. One worker owns the endpoint and its tests. The coordinator owns the UI
and integration check. Add a second worker only if there is a separate useful
task with no overlapping edits; otherwise finish with two agents total.
