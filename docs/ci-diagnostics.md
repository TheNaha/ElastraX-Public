# CI Diagnostics

`scripts/ciDiagnostics.ts` is a read-only triage tool for GitHub Actions. It classifies recent runs, jobs, and steps so that an account-side problem is never mistaken for a repository-side problem, and so that nobody "fixes" a workflow to chase a failure the workflow did not cause.

```bash
bun run scripts/ciDiagnostics.ts
bun run scripts/ciDiagnostics.ts --workflow CI --limit 10
bun run scripts/ciDiagnostics.ts --repo TheNaha/ElastraX --json
bun run scripts/ciDiagnostics.ts --help
```

## Read-only guarantees

- Only four command forms can ever be executed: `gh --version`, `gh run list --json ...`, `gh run view <id> --json ...`, and `gh api` restricted to `GET /repos/<owner>/<repo>/actions/...`.
- Every argv is validated by `assertReadOnlyGhArgs` **before** the process is spawned. `gh run rerun`, `gh run cancel`, `gh run delete`, `gh run watch`, `gh pr merge`, `gh api -X POST`, and any non-`gh` command raise `ReadOnlyViolationError` and the runner is never called.
- The script writes nothing: no file, no workflow, no run state.
- `gh` is optional. If the CLI is missing or unauthenticated the report is emitted with `source: "unavailable"` and the reason, instead of failing hard. The tests never spawn a real process; the command runner is injected.

## Failure classes

| Class | Meaning | Owner | Action |
|-------|---------|-------|--------|
| `configuration_failure` | The workflow was rejected or produced no usable job graph, so nothing in this repository ran. | Repository | Inspect the workflow file, action pins, `permissions`, and the run-page message. |
| `no_step_scheduling_failure` | A job was created and concluded, but no step ever ran: no runner was allocated. | GitHub account / organization | Verify Actions enablement, billing, spending limit, minutes quota, and org policy. **Do not edit workflows to chase it.** |
| `job_failure` | A real step started and failed. | Repository | Read `gh run view <id> --log-failed` and fix what that step exercised. |
| `success` | Every recorded step completed. | — | None. |
| `skipped` | A workflow condition prevented the job from running (for example the publish gate). | — | Confirm the skip is intended. |
| `cancelled` | Cancelled before completing, usually by the `concurrency` group. | — | Confirm the cancellation is expected. |
| `in_progress` | No final conclusion yet. | — | Re-run the diagnostics later. |
| `unknown` | Job details were unavailable, so nothing can be concluded. | — | Fetch more detail or inspect the run manually. |

### Decision rules, in order

1. Run not `completed` → `in_progress`.
2. Run conclusion `skipped` → `skipped` (this is how the `Docker Publish` gate behaves on `main`, and it is **not** a failure).
3. Run conclusion `cancelled` → `cancelled`.
4. Job details were never fetched → `configuration_failure` only when a configuration signature is present, otherwise `unknown`. The script never invents a classification.
5. Run finished with **zero jobs** and a failure conclusion → `configuration_failure`: the workflow was rejected before a job graph existed. Zero jobs with a `success` conclusion stays `success`.
6. Otherwise the run takes the most severe job class, with precedence `configuration_failure` > `no_step_scheduling_failure` > `job_failure`. Every job's own class is preserved in `runs[].jobs[]`, so a mixed run never hides a code-side failure behind an external one.
7. Per job, among failing jobs:
   - zero recorded steps → `no_step_scheduling_failure`;
   - a failed work step (anything that is not `Set up job`, `Complete job`, or a `Post …` teardown) → `job_failure`;
   - a failed `Set up job` / teardown step, or every recorded step skipped with no work step started → respectively `no_step_scheduling_failure` and `configuration_failure`.

A run whose failing jobs all completed within 15 seconds is additionally flagged `fastFailure`, which is corroborating evidence for a scheduling or billing problem: real CI work cannot start and stop that fast.

### Signatures

`CONFIGURATION_SIGNATURES` (repository-side) covers: `invalid workflow file`, `workflow is not valid`, `invalid workflow syntax`, `unable to resolve action`, `startup_failure`, `could not start workflow`, `no actions are allowed`. They are matched against the job conclusion, the run conclusion, and any annotations supplied by the caller.

`EXTERNAL_SCHEDULING_SIGNATURES` (account-side) covers: `spending limit`, `billing`, `payment required/failed`, `exceeded your minutes`, `actions disabled`, `no runner`, `self-hosted runner`, and similar. These never change a class; they are attached as `externalEvidence` so a human can confirm the account-side cause.

Annotations are not fetched by the script. If you have check-run annotations, pass them on the `CiRun.annotations` field and they are classified with the same signatures.

## Current repository state

At the time of writing, the `gh` CLI is available and authenticated, and the diagnosis is unambiguous:

```text
Summary: 2 skipped, 2 no_step_scheduling_failure
No in-repository failure detected; 2 run(s) still need account-side scheduling/billing verification.
```

- Every recent `CI` run (`push` and `pull_request`) concludes `failure` with a job that records **zero steps** and completes in roughly 3-4 seconds. No step log exists because nothing executed.
- The paired `Docker Publish` runs conclude `skipped` because their `if:` gate requires a successful `CI` run. That skip is correct behaviour, not a second fault.
- The last green `CI` run is 2026-08-25T09:29:40Z. The last successful `Docker Publish` run is 2026-07-31T11:41:53Z, so no image has been published from any revision since then.

Conclusion: the repository's gates cannot be evaluated from Actions output, because Actions is not running any step. The remaining verification is local (`bun run check`) plus account-side repair of Actions enablement/billing. No workflow edit can prove the fix; see the note in [deployment](./deployment.md) about release gating.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | No `configuration_failure` and no `job_failure` in the inspected window. External scheduling/billing failures are informational. |
| `1` | At least one `configuration_failure` or `job_failure`: there is work to do in the repository. |
| `2` | Usage error, or `gh` is unavailable. |

The distinction is the point: a repository full of red runs because no runner was allocated must not fail a local gate as if the code were broken.

## Tests

`test/CiDiagnostics.test.ts` covers the step/job/run decision rules with the exact shapes observed in this repository, the read-only allowlist (including that a rejected command never reaches the process runner), `gh` unavailability, job-detail fetch failures, malformed `gh` output, argument parsing, and report formatting. No test spawns a process or touches the network.
