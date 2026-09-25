import { describe, expect, test } from 'bun:test';
import {
  CONFIGURATION_SIGNATURES,
  DiagnosticsError,
  FAST_FAILURE_THRESHOLD_MS,
  ReadOnlyViolationError,
  assertReadOnlyGhArgs,
  buildReport,
  classifyJob,
  classifyRun,
  classifyStepPhase,
  collectDiagnostics,
  describeClass,
  durationMs,
  formatReport,
  isEnvironmentStepName,
  parseArgs,
  parseJsonPayload,
  parseRunList,
  runReadOnlyGh,
  type CiJob,
  type CiRun,
  type CommandResult,
  type CommandRunner,
} from '../scripts/ciDiagnostics';

const CI_RUN_URL = 'https://github.com/TheNaha/ElastraX/actions/runs/36158813668';

function run(overrides: Partial<CiRun> = {}): CiRun {
  return {
    databaseId: 36158813668,
    name: 'CI',
    workflowName: 'CI',
    status: 'completed',
    conclusion: 'failure',
    event: 'push',
    headBranch: 'main',
    displayTitle: 'chore(release): align application identity to v8.0.1',
    createdAt: '2026-09-25T16:08:15Z',
    updatedAt: '2026-09-25T16:08:19Z',
    url: CI_RUN_URL,
    ...overrides,
  };
}

function job(overrides: Partial<CiJob> = {}): CiJob {
  return {
    databaseId: 108149937950,
    name: 'Verify source, migrations, secrets, and image',
    status: 'completed',
    conclusion: 'failure',
    startedAt: '2026-09-25T16:08:16Z',
    completedAt: '2026-09-25T16:08:19Z',
    steps: [],
    ...overrides,
  };
}

function recorder(): { runner: CommandRunner; invocations: string[][] } {
  const invocations: string[][] = [];
  const runner: CommandRunner = async argv => {
    invocations.push([...argv]);
    return { code: 0, stdout: '[]', stderr: '' };
  };
  return { runner, invocations };
}

function jsonRunner(responses: Record<string, CommandResult>): { runner: CommandRunner; invocations: string[][] } {
  const invocations: string[][] = [];
  const runner: CommandRunner = async argv => {
    invocations.push([...argv]);
    const key = argv[1] === 'run' ? `run ${argv[2]}` : argv[1] === 'api' ? 'api' : 'other';
    const response = responses[key] ?? { code: 1, stdout: '', stderr: `no canned response for ${key}` };
    return response;
  };
  return { runner, invocations };
}

describe('ciDiagnostics step and job classification', () => {
  test('separates environment steps from work steps', () => {
    expect(isEnvironmentStepName('Set up job')).toBe(true);
    expect(isEnvironmentStepName('Complete job')).toBe(true);
    expect(isEnvironmentStepName('Post Setup Bun environment')).toBe(true);
    expect(isEnvironmentStepName('Secret gate')).toBe(false);
    expect(classifyStepPhase({ name: 'Set up job', status: 'completed', conclusion: 'success' })).toBe('environment');
    expect(classifyStepPhase({ name: 'Tests', status: 'completed', conclusion: 'failure' })).toBe('work');
    expect(classifyStepPhase({ name: 'Build pinned container image', status: 'skipped', conclusion: 'skipped' })).toBe('pending');
  });

  test('classifies a job that concluded failure with no steps as external scheduling or billing', () => {
    const diagnosis = classifyJob(job(), run());
    expect(diagnosis.class).toBe('no_step_scheduling_failure');
    expect(diagnosis.recordedSteps).toBe(0);
    expect(diagnosis.executedWorkSteps).toBe(0);
    expect(diagnosis.failedSteps).toEqual([]);
    expect(diagnosis.reasons.join(' ')).toContain('no runner was ever allocated');
    expect(diagnosis.durationMs).toBe(3_000);
  });

  test('classifies a failed work step as a normal job failure', () => {
    const diagnosis = classifyJob(
      job({
        steps: [
          { name: 'Set up job', status: 'completed', conclusion: 'success' },
          { name: 'Install locked dependencies', status: 'completed', conclusion: 'success' },
          { name: 'Typecheck', status: 'completed', conclusion: 'failure' },
        ],
      }),
      run(),
    );
    expect(diagnosis.class).toBe('job_failure');
    expect(diagnosis.failedSteps).toEqual(['Typecheck']);
    expect(diagnosis.executedWorkSteps).toBe(2);
  });

  test('classifies a job that failed during runner setup as external, not a code failure', () => {
    const diagnosis = classifyJob(
      job({
        steps: [
          { name: 'Set up job', status: 'completed', conclusion: 'failure' },
          { name: 'Checkout repository', status: 'queued', conclusion: null },
        ],
      }),
      run(),
    );
    expect(diagnosis.class).toBe('no_step_scheduling_failure');
    expect(diagnosis.executedWorkSteps).toBe(0);
  });

  test('classifies a job whose steps were all skipped as a configuration failure', () => {
    const diagnosis = classifyJob(
      job({
        steps: [
          { name: 'Set up job', status: 'completed', conclusion: 'success' },
          { name: 'Build and publish attested image', status: 'skipped', conclusion: 'skipped' },
        ],
      }),
      run(),
    );
    expect(diagnosis.class).toBe('configuration_failure');
    expect(diagnosis.reasons.join(' ')).toContain('every recorded step was skipped');
  });

  test('classifies a rejected workflow as a configuration failure', () => {
    const withJobs = run({ jobs: [job({ steps: [], conclusion: 'failure' })] });
    const withSignature = classifyRun({ ...withJobs, annotations: [{ title: 'Invalid workflow file', message: 'the syntax is invalid' }] });
    expect(withSignature.class).toBe('configuration_failure');

    const startup = run({ conclusion: 'startup_failure', jobs: [job({ conclusion: 'startup_failure' })] });
    expect(classifyRun(startup).class).toBe('configuration_failure');
  });

  test('recognises the documented configuration signatures', () => {
    const samples = [
      'Invalid workflow file. See the run page for details.',
      'The workflow is not valid for this repository',
      'Invalid workflow syntax at line 12',
      'Unable to resolve action `actions/checkout@deadbeef`',
      'startup_failure',
      'Could not start workflow',
      'No actions are allowed for this repository',
    ];
    expect(CONFIGURATION_SIGNATURES.length).toBeGreaterThanOrEqual(samples.length);
    for (const sample of samples) {
      expect(CONFIGURATION_SIGNATURES.some(signature => signature.test(sample))).toBe(true);
    }
    expect(CONFIGURATION_SIGNATURES.some(signature => signature.test('Typecheck exited with code 1'))).toBe(false);
  });

  test('keeps healthy, skipped, cancelled, and running jobs out of the failure classes', () => {
    expect(classifyJob(job({ conclusion: 'success', steps: [{ name: 'Tests', status: 'completed', conclusion: 'success' }] }), run()).class).toBe('success');
    expect(classifyJob(job({ conclusion: 'skipped' }), run()).class).toBe('skipped');
    expect(classifyJob(job({ conclusion: 'cancelled' }), run()).class).toBe('cancelled');
    expect(classifyJob(job({ status: 'in_progress', conclusion: null }), run()).class).toBe('in_progress');
  });
});

describe('ciDiagnostics run classification', () => {
  test('treats a failed run with zero jobs as a configuration failure', () => {
    const diagnosis = classifyRun(run({ jobs: [] }));
    expect(diagnosis.class).toBe('configuration_failure');
    expect(diagnosis.reasons.join(' ')).toContain('zero jobs');
  });

  test('treats a skipped run with zero jobs as a gate, not a failure', () => {
    const diagnosis = classifyRun(run({ conclusion: 'skipped', workflowName: 'Docker Publish', jobs: [] }));
    expect(diagnosis.class).toBe('skipped');
    expect(diagnosis.reasons.join(' ')).toContain('skipped by a workflow condition');
  });

  test('marks fast no-step failures for external verification', () => {
    const diagnosis = classifyRun(run({ jobs: [job()] }));
    expect(diagnosis.class).toBe('no_step_scheduling_failure');
    expect(diagnosis.fastFailure).toBe(true);

    const slow = classifyRun(
      run({
        jobs: [
          job({
            startedAt: '2026-09-25T16:08:16Z',
            completedAt: new Date(Date.parse('2026-09-25T16:08:16Z') + FAST_FAILURE_THRESHOLD_MS * 4).toISOString(),
          }),
        ],
      }),
    );
    expect(slow.fastFailure).toBe(false);
  });

  test('prefers a configuration failure over scheduling and job failures in mixed runs', () => {
    const diagnosis = classifyRun(
      run({
        jobs: [
          job({ name: 'publish', databaseId: 2 }),
          job({ name: 'verify', databaseId: 3, steps: [{ name: 'Typecheck', status: 'completed', conclusion: 'failure' }] }),
        ],
      }),
    );
    expect(diagnosis.class).toBe('no_step_scheduling_failure');
    expect(diagnosis.jobs.map(entry => entry.class)).toEqual(['no_step_scheduling_failure', 'job_failure']);
  });

  test('reports unknown when job details were never fetched', () => {
    const diagnosis = classifyRun(run({ jobs: undefined }));
    expect(diagnosis.class).toBe('unknown');
    expect(diagnosis.reasons.join(' ')).toContain('job details were not supplied');
  });

  test('computes run and job durations defensively', () => {
    expect(durationMs('2026-09-25T16:08:15Z', '2026-09-25T16:08:19Z')).toBe(4_000);
    expect(durationMs('2026-09-25T16:08:19Z', '2026-09-25T16:08:15Z')).toBeNull();
    expect(durationMs(null, '2026-09-25T16:08:15Z')).toBeNull();
    expect(durationMs('not-a-date', 'also-not-a-date')).toBeNull();
  });
});

describe('ciDiagnostics read-only guarantees', () => {
  test('accepts only read-only gh invocations', () => {
    expect(() => assertReadOnlyGhArgs(['gh', 'run', 'list', '--limit', '5', '--json', 'databaseId'])).not.toThrow();
    expect(() => assertReadOnlyGhArgs(['gh', 'run', 'view', '1', '--json', 'jobs'])).not.toThrow();
    expect(() => assertReadOnlyGhArgs(['gh', 'api', '/repos/o/r/actions/runs/1'])).not.toThrow();
  });

  test('rejects mutating and out-of-scope gh invocations', () => {
    const rejected: string[][] = [
      ['gh', 'run', 'rerun', '36158813668'],
      ['gh', 'run', 'cancel', '36158813668'],
      ['gh', 'run', 'delete', '36158813668'],
      ['gh', 'run', 'watch', '36158813668'],
      ['gh', 'pr', 'merge', '442'],
      ['gh', 'api', '-X', 'POST', '/repos/o/r/actions/runs/1/rerun'],
      ['gh', 'api', '--method', 'DELETE', '/repos/o/r/actions/runs/1'],
      ['gh', 'api', '/repos/o/r/issues/1'],
      ['git', 'push', 'origin', 'main'],
      [],
    ];
    for (const argv of rejected) {
      expect(() => assertReadOnlyGhArgs(argv)).toThrow(ReadOnlyViolationError);
    }
  });

  test('never reaches the command runner for a rejected command', async () => {
    const { runner, invocations } = recorder();
    await expect(runReadOnlyGh(['gh', 'run', 'rerun', '1'], runner)).rejects.toBeInstanceOf(ReadOnlyViolationError);
    expect(invocations).toEqual([]);
  });
});

describe('ciDiagnostics collection', () => {
  const listPayload = JSON.stringify([
    {
      databaseId: 2,
      name: 'CI',
      workflowName: 'CI',
      status: 'completed',
      conclusion: 'failure',
      event: 'push',
      headBranch: 'main',
      displayTitle: 'feat: x',
      createdAt: '2026-09-25T16:08:15Z',
      updatedAt: '2026-09-25T16:08:19Z',
      url: CI_RUN_URL,
    },
    {
      databaseId: 1,
      name: 'CI',
      workflowName: 'CI',
      status: 'completed',
      conclusion: 'success',
      event: 'push',
      headBranch: 'main',
      displayTitle: 'old green',
      createdAt: '2026-08-25T09:29:40Z',
      updatedAt: '2026-08-25T09:30:06Z',
      url: CI_RUN_URL,
    },
  ]);

  const viewPayload = JSON.stringify({
    databaseId: 2,
    name: 'CI',
    workflowName: 'CI',
    status: 'completed',
    conclusion: 'failure',
    event: 'push',
    headBranch: 'main',
    displayTitle: 'feat: x',
    createdAt: '2026-09-25T16:08:15Z',
    updatedAt: '2026-09-25T16:08:19Z',
    url: CI_RUN_URL,
    jobs: [job()],
  });

  test('collects runs with an injected runner and only reads job details when needed', async () => {
    const { runner, invocations } = jsonRunner({
      'run list': { code: 0, stdout: listPayload, stderr: '' },
      'run view': { code: 0, stdout: viewPayload, stderr: '' },
      other: { code: 0, stdout: 'gh version 2.101.0 (2026-09-15)', stderr: '' },
    });

    const report = await collectDiagnostics({ runner, limit: 2, now: new Date('2026-09-25T17:00:00Z') });
    expect(report.source).toBe('gh');
    expect(report.runs.map(entry => entry.class)).toEqual(['no_step_scheduling_failure', 'success']);
    expect(report.counts.no_step_scheduling_failure).toBe(1);
    expect(report.counts.success).toBe(1);
    expect(invocations.filter(argv => argv[1] === 'run' && argv[2] === 'view')).toHaveLength(1);
    for (const argv of invocations) expect(() => assertReadOnlyGhArgs(argv)).not.toThrow();
  });

  test('degrades to an unavailable report when gh is missing', async () => {
    const runner: CommandRunner = async () => ({ code: 127, stdout: '', stderr: 'gh: command not found' });
    const report = await collectDiagnostics({ runner, now: new Date('2026-09-25T17:00:00Z') });
    expect(report.source).toBe('unavailable');
    expect(report.runs).toEqual([]);
    expect(report.reason).toContain('command not found');
  });

  test('surfaces a gh run list failure instead of guessing', async () => {
    const { runner } = jsonRunner({
      'run list': { code: 1, stdout: '', stderr: 'HTTP 403: resource not accessible' },
      other: { code: 0, stdout: 'gh version 2.101.0', stderr: '' },
    });
    await expect(collectDiagnostics({ runner })).rejects.toBeInstanceOf(DiagnosticsError);
  });

  test('records a job-detail failure without inventing a classification', async () => {
    const { runner } = jsonRunner({
      'run list': { code: 0, stdout: listPayload, stderr: '' },
      'run view': { code: 1, stdout: '', stderr: 'HTTP 404: Not Found' },
      other: { code: 0, stdout: 'gh version 2.101.0', stderr: '' },
    });
    const report = await collectDiagnostics({ runner });
    const failed = report.runs.find(entry => entry.databaseId === 2);
    expect(failed?.class).toBe('unknown');
    expect(failed?.reasons.join(' ')).toContain('HTTP 404');
  });
});

describe('ciDiagnostics parsing and reporting', () => {
  test('rejects malformed gh payloads', () => {
    expect(() => parseJsonPayload('not json', 'gh run list')).toThrow(DiagnosticsError);
    expect(() => parseRunList('{"runs":[]}')).toThrow(DiagnosticsError);
    expect(() => parseRunList('')).toThrow(DiagnosticsError);
    expect(parseRunList('[{"databaseId":1},{"noId":true}]')).toHaveLength(1);
  });

  test('counts classes and formats an actionable next step', () => {
    const report = buildReport([run({ jobs: [job()] }), run({ databaseId: 3, conclusion: 'success', jobs: [] })], {
      generatedAt: '2026-09-25T17:00:00Z',
      source: 'gh',
      ghVersion: 'gh version 2.101.0',
      reason: null,
    });
    expect(report.counts.no_step_scheduling_failure).toBe(1);
    expect(report.counts.success).toBe(1);
    const text = formatReport(report);
    expect(text).toContain('no-step scheduling/billing failure');
    expect(text).toContain('account-side');
    expect(text).toContain('#36158813668');
    expect(() => JSON.parse(JSON.stringify(report))).not.toThrow();
  });

  test('describes every failure class', () => {
    for (const failureClass of [
      'success',
      'in_progress',
      'skipped',
      'cancelled',
      'configuration_failure',
      'no_step_scheduling_failure',
      'job_failure',
      'unknown',
    ] as const) {
      const description = describeClass(failureClass);
      expect(description.label.length).toBeGreaterThan(0);
      expect(description.meaning.length).toBeGreaterThan(0);
      expect(description.next.length).toBeGreaterThan(0);
    }
    expect(describeClass('no_step_scheduling_failure').next).toContain('billing');
    expect(describeClass('job_failure').next).toContain('--log-failed');
  });

  test('parses CLI arguments and rejects unknown flags', () => {
    const parsed = parseArgs(['--limit=5', '--workflow', 'CI', '--repo', 'TheNaha/ElastraX', '--json']);
    expect(parsed.error).toBeNull();
    expect(parsed.options.limit).toBe(5);
    expect(parsed.options.workflow).toBe('CI');
    expect(parsed.options.repo).toBe('TheNaha/ElastraX');
    expect(parsed.json).toBe(true);

    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['--limit']).error).toContain('--limit');
    expect(parseArgs(['--nope']).error).toContain('unknown argument');
  });
});
