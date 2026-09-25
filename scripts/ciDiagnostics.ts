import { spawn } from 'node:child_process';

export type CiStatus =
  | 'queued'
  | 'in_progress'
  | 'completed'
  | 'waiting'
  | 'requested'
  | 'pending'
  | (string & {});

export type CiConclusion =
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | 'action_required'
  | 'neutral'
  | 'stale'
  | 'startup_failure'
  | (string & {});

export type FailureClass =
  | 'success'
  | 'in_progress'
  | 'skipped'
  | 'cancelled'
  | 'configuration_failure'
  | 'no_step_scheduling_failure'
  | 'job_failure'
  | 'unknown';

export type StepPhase = 'environment' | 'work' | 'pending';

export interface CiStep {
  name: string;
  status?: CiStatus | null;
  conclusion?: CiConclusion | null;
  number?: number | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface CiJob {
  databaseId?: number | null;
  name: string;
  status?: CiStatus | null;
  conclusion?: CiConclusion | null;
  startedAt?: string | null;
  completedAt?: string | null;
  steps?: CiStep[] | null;
  url?: string | null;
}

export interface CiAnnotation {
  annotationLevel?: string | null;
  title?: string | null;
  message?: string | null;
  path?: string | null;
}

export interface CiRun {
  databaseId: number;
  name?: string | null;
  workflowName?: string | null;
  status?: CiStatus | null;
  conclusion?: CiConclusion | null;
  event?: string | null;
  headBranch?: string | null;
  headSha?: string | null;
  displayTitle?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  url?: string | null;
  jobs?: CiJob[] | null;
  annotations?: CiAnnotation[] | null;
  jobsFetchError?: string | null;
}

export interface Diagnosis {
  class: FailureClass;
  reasons: string[];
  failedSteps: string[];
  executedWorkSteps: number;
  recordedSteps: number;
  durationMs: number | null;
  externalEvidence: string[];
}

export interface RunDiagnosis extends Diagnosis {
  databaseId: number;
  workflowName: string;
  event: string;
  headBranch: string;
  displayTitle: string;
  createdAt: string;
  url: string;
  fastFailure: boolean;
  jobs: Array<Diagnosis & { name: string; databaseId: number | null; conclusion: string; url: string }>;
}

export interface DiagnosticsReport {
  generatedAt: string;
  source: 'gh' | 'unavailable';
  ghVersion: string | null;
  reason: string | null;
  counts: Record<FailureClass, number>;
  runs: RunDiagnosis[];
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (argv: string[]) => Promise<CommandResult>;

export interface DiagnosticsOptions {
  limit?: number;
  workflow?: string;
  branch?: string;
  event?: string;
  repo?: string;
  runner?: CommandRunner;
  now?: Date;
}

export class ReadOnlyViolationError extends Error {
  readonly argv: readonly string[];

  constructor(argv: readonly string[], detail: string) {
    super(`Refusing to run a non read-only gh command: gh ${argv.join(' ')} (${detail})`);
    this.name = 'ReadOnlyViolationError';
    this.argv = argv;
  }
}

export class DiagnosticsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiagnosticsError';
  }
}

export const RUN_LIST_FIELDS = [
  'databaseId',
  'name',
  'workflowName',
  'status',
  'conclusion',
  'event',
  'headBranch',
  'headSha',
  'displayTitle',
  'createdAt',
  'updatedAt',
  'url',
].join(',');

export const RUN_VIEW_FIELDS = `${RUN_LIST_FIELDS},jobs`;

export const FAST_FAILURE_THRESHOLD_MS = 15_000;

export const CONFIGURATION_SIGNATURES: readonly RegExp[] = [
  /invalid workflow file/i,
  /workflow is not valid/i,
  /invalid workflow syntax/i,
  /unable to resolve action/i,
  /startup_failure/i,
  /could not start workflow/i,
  /no actions? (?:are )?(?:allowed|enabled)/i,
];

export const EXTERNAL_SCHEDULING_SIGNATURES: readonly RegExp[] = [
  /spending limit/i,
  /billing/i,
  /payment (?:required|failed)/i,
  /exceeded your (?:included|remaining) minutes/i,
  /actions? (?:is|are) disabled/i,
  /disabled for this repository/i,
  /no runner/i,
  /runner was not (?:allocated|registered)/i,
  /queued (?:for too long|job exceeded)/i,
  /self-hosted runner/i,
];

export const READ_ONLY_GH_FORMS: readonly string[] = [
  'gh --version',
  'gh run list --json ...',
  'gh run view <id> --json ...',
  'gh api /repos/<owner>/<repo>/actions/... (GET only)',
];

const API_REQUEST_BLOCKING_FLAGS = new Set([
  '--method',
  '-X',
  '--field',
  '-F',
  '--raw-field',
  '-f',
  '--input',
  '-H',
  '--hostname',
]);

const API_PATH_PATTERN = /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/[A-Za-z0-9_./_-]+$/;

export const defaultCommandRunner: CommandRunner = argv =>
  new Promise<CommandResult>(resolve => {
    const [command, ...args] = argv;
    if (!command) {
      resolve({ code: 2, stdout: '', stderr: 'empty command' });
      return;
    }
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', chunk => {
      stderr += String(chunk);
    });
    child.on('error', error => resolve({ code: 127, stdout, stderr: `${stderr}${String(error)}` }));
    child.on('close', code => resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr }));
  });

export function isEnvironmentStepName(name: string): boolean {
  const normalized = name.trim();
  if (/^(?:set up|complete) job$/i.test(normalized)) return true;
  if (/^post /i.test(normalized)) return true;
  return false;
}

export function classifyStepPhase(step: CiStep): StepPhase {
  if (isEnvironmentStepName(step.name)) return 'environment';
  const finished = step.status === 'completed' || step.conclusion != null;
  if (!finished) return 'pending';
  if (step.conclusion === 'skipped') return 'pending';
  return 'work';
}

export function durationMs(startedAt?: string | null, completedAt?: string | null): number | null {
  if (!startedAt || !completedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

function matchesAny(text: string, patterns: readonly RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return null;
}

function configurationSignatures(run: CiRun, job?: CiJob): string[] {
  const found: string[] = [];
  const conclusion = String(job?.conclusion ?? run.conclusion ?? '');
  const signature = matchesAny(conclusion, CONFIGURATION_SIGNATURES);
  if (signature) found.push(`conclusion contains "${signature}"`);
  for (const annotation of run.annotations ?? []) {
    const text = [annotation.title, annotation.message, annotation.annotationLevel].filter(Boolean).join(' ');
    const annotationSignature = matchesAny(text, CONFIGURATION_SIGNATURES);
    if (annotationSignature) found.push(`annotation "${annotation.title ?? 'untitled'}" contains "${annotationSignature}"`);
  }
  return found;
}

function externalSchedulingSignatures(run: CiRun, job?: CiJob): string[] {
  const found: string[] = [];
  const texts = [run.displayTitle, job?.name].filter((value): value is string => typeof value === 'string');
  for (const annotation of run.annotations ?? []) {
    if (annotation.message) texts.push(annotation.message);
  }
  for (const text of texts) {
    const signature = matchesAny(text, EXTERNAL_SCHEDULING_SIGNATURES);
    if (signature) found.push(`"${signature}"`);
  }
  return found;
}

function isFailureConclusion(conclusion: string | null | undefined): boolean {
  if (!conclusion) return false;
  return ['failure', 'timed_out', 'action_required', 'startup_failure'].includes(conclusion);
}

export function classifyJob(job: CiJob, run?: CiRun): Diagnosis {
  const steps = job.steps ?? [];
  const executedWorkSteps = steps.filter(step => classifyStepPhase(step) === 'work').length;
  const failedSteps = steps
    .filter(step => isFailureConclusion(step.conclusion))
    .map(step => step.name);
  const environmentFailures = steps
    .filter(step => classifyStepPhase(step) === 'environment' && isFailureConclusion(step.conclusion))
    .map(step => step.name);
  const observed = durationMs(job.startedAt, job.completedAt);
  const base = {
    failedSteps,
    executedWorkSteps,
    recordedSteps: steps.length,
    durationMs: observed,
    externalEvidence: run ? externalSchedulingSignatures(run, job) : [],
  };

  const status = job.status ?? 'completed';
  if (status !== 'completed') {
    return { class: 'in_progress', reasons: [`job status is "${status}"`], ...base };
  }

  const conclusion = job.conclusion ?? null;
  if (conclusion === null) {
    return { class: 'unknown', reasons: ['job finished without a conclusion'], ...base };
  }
  if (conclusion === 'success' || conclusion === 'neutral') {
    return { class: 'success', reasons: [`job concluded "${conclusion}"`], ...base };
  }
  if (conclusion === 'skipped') {
    return { class: 'skipped', reasons: ['job was skipped by a workflow condition'], ...base };
  }
  if (conclusion === 'cancelled') {
    return { class: 'cancelled', reasons: ['job was cancelled before completing'], ...base };
  }

  const configSignatures = configurationSignatures(run ?? { databaseId: 0 }, job);
  if (steps.length === 0) {
    if (configSignatures.length > 0) {
      return {
        class: 'configuration_failure',
        reasons: [
          'job concluded failure without recording any step',
          ...configSignatures,
          'the workflow definition itself is rejected, so no repository code ran',
        ],
        ...base,
      };
    }
    return {
      class: 'no_step_scheduling_failure',
      reasons: [
        'job concluded failure with zero recorded steps: no runner was ever allocated',
        'action logs are unavailable because nothing executed',
      ],
      ...base,
    };
  }

  if (failedSteps.some(name => !isEnvironmentStepName(name))) {
    return {
      class: 'job_failure',
      reasons: [
        `step(s) failed: ${failedSteps.filter(name => !isEnvironmentStepName(name)).join(', ')}`,
        'an executed step failed, so the cause is inside the repository',
      ],
      ...base,
    };
  }

  if (environmentFailures.length > 0) {
    return {
      class: 'no_step_scheduling_failure',
      reasons: [
        `runner environment step(s) failed: ${environmentFailures.join(', ')}`,
        'no work step started, so the cause is GitHub-side scheduling or account state',
      ],
      ...base,
    };
  }

  if (configSignatures.length > 0 || executedWorkSteps === 0) {
    return {
      class: 'configuration_failure',
      reasons: [
        'job failed before any work step executed',
        ...(executedWorkSteps === 0 ? ['every recorded step was skipped or environment-only'] : []),
        ...configSignatures,
      ],
      ...base,
    };
  }

  return {
    class: 'job_failure',
    reasons: [`job concluded "${conclusion}" after ${executedWorkSteps} work step(s)`],
    ...base,
  };
}

const CLASS_PRECEDENCE: readonly FailureClass[] = [
  'configuration_failure',
  'no_step_scheduling_failure',
  'job_failure',
  'cancelled',
  'unknown',
];

function dominantClass(classes: readonly FailureClass[]): FailureClass {
  for (const candidate of CLASS_PRECEDENCE) {
    if (classes.includes(candidate)) return candidate;
  }
  return 'success';
}

export function classifyRun(run: CiRun): RunDiagnosis {
  const jobs = run.jobs ?? [];
  const jobDiagnoses = jobs.map(job => ({
    ...classifyJob(job, run),
    name: job.name,
    databaseId: job.databaseId ?? null,
    conclusion: String(job.conclusion ?? 'unknown'),
    url: job.url ?? '',
  }));

  const status = run.status ?? 'completed';
  const conclusion = String(run.conclusion ?? '');
  let runClass: FailureClass;
  const reasons: string[] = [];

  if (status !== 'completed') {
    runClass = 'in_progress';
    reasons.push(`run status is "${status}"`);
  } else if (conclusion === 'skipped') {
    runClass = 'skipped';
    reasons.push(
      jobs.length === 0
        ? 'run was skipped by a workflow condition before any job was created'
        : `run was skipped by a workflow condition (${jobs.length} job(s) recorded)`,
    );
  } else if (conclusion === 'cancelled') {
    runClass = 'cancelled';
    reasons.push('run was cancelled before completing');
  } else if (run.jobs == null) {
    const configSignatures = configurationSignatures(run);
    runClass = configSignatures.length > 0 ? 'configuration_failure' : 'unknown';
    reasons.push(
      run.jobsFetchError
        ? `job details could not be fetched: ${run.jobsFetchError}`
        : 'job details were not supplied, so the run cannot be classified beyond its conclusion',
      ...configSignatures,
    );
  } else if (jobs.length === 0) {
    const configSignatures = configurationSignatures(run);
    if (!isFailureConclusion(run.conclusion)) {
      runClass = ['success', 'neutral'].includes(conclusion) ? 'success' : 'unknown';
      reasons.push(`run concluded "${conclusion || 'unknown'}" without recording any job`);
    } else {
      runClass = 'configuration_failure';
      reasons.push(
        `run concluded "${conclusion}" with zero jobs: the workflow was rejected before a job graph existed`,
        ...configSignatures,
      );
    }
  } else {
    runClass = dominantClass(jobDiagnoses.map(diagnosis => diagnosis.class));
    reasons.push(...classReasons(runClass, jobDiagnoses));
  }

  const failedJobDurations = jobDiagnoses
    .filter(diagnosis => diagnosis.class === 'no_step_scheduling_failure')
    .map(diagnosis => diagnosis.durationMs)
    .filter((value): value is number => value != null);
  const fastFailure =
    runClass === 'no_step_scheduling_failure'
    && failedJobDurations.length > 0
    && failedJobDurations.every(value => value <= FAST_FAILURE_THRESHOLD_MS);

  return {
    databaseId: run.databaseId,
    workflowName: run.workflowName ?? run.name ?? 'unknown',
    event: run.event ?? 'unknown',
    headBranch: run.headBranch ?? 'unknown',
    displayTitle: run.displayTitle ?? '',
    createdAt: run.createdAt ?? '',
    url: run.url ?? '',
    class: runClass,
    reasons,
    failedSteps: jobDiagnoses.flatMap(diagnosis => diagnosis.failedSteps),
    executedWorkSteps: jobDiagnoses.reduce((total, diagnosis) => total + diagnosis.executedWorkSteps, 0),
    recordedSteps: jobDiagnoses.reduce((total, diagnosis) => total + diagnosis.recordedSteps, 0),
    durationMs: durationMs(run.createdAt, run.updatedAt),
    externalEvidence: [...new Set(jobDiagnoses.flatMap(diagnosis => diagnosis.externalEvidence))],
    fastFailure,
    jobs: jobDiagnoses,
  };
}

function classReasons(failureClass: FailureClass, jobs: readonly (Diagnosis & { name: string })[]): string[] {
  if (failureClass === 'configuration_failure') {
    const failed = jobs.filter(job => job.class === 'configuration_failure');
    return failed.length > 0
      ? failed.flatMap(job => job.reasons.map(reason => `${job.name}: ${reason}`))
      : ['workflow configuration was rejected before any job could run'];
  }
  if (failureClass === 'no_step_scheduling_failure') {
    return jobs
      .filter(job => job.class === 'no_step_scheduling_failure')
      .flatMap(job => job.reasons.map(reason => `${job.name}: ${reason}`));
  }
  if (failureClass === 'job_failure') {
    return jobs
      .filter(job => job.class === 'job_failure')
      .flatMap(job => job.reasons.map(reason => `${job.name}: ${reason}`));
  }
  const reasons = jobs.flatMap(job => job.reasons.map(reason => `${job.name}: ${reason}`));
  return reasons.length > 0 ? reasons : [`run classified as ${failureClass}`];
}

const CLASS_DESCRIPTIONS: Record<FailureClass, { label: string; meaning: string; next: string }> = {
  success: {
    label: 'healthy',
    meaning: 'Every recorded step completed successfully.',
    next: 'No action required.',
  },
  in_progress: {
    label: 'running',
    meaning: 'The run has not reached a final conclusion yet.',
    next: 'Re-run the diagnostics after the run completes.',
  },
  skipped: {
    label: 'skipped',
    meaning: 'A workflow condition prevented the job from running.',
    next: 'Confirm the skip is intended (for example a publish gate on a failed CI run).',
  },
  cancelled: {
    label: 'cancelled',
    meaning: 'The run or job was cancelled before completing.',
    next: 'Check whether the cancellation came from a concurrency group or a human.',
  },
  configuration_failure: {
    label: 'configuration failure',
    meaning: 'The workflow was rejected or produced no usable job graph, so nothing in this repository executed.',
    next: 'Inspect the workflow file, action pins, permissions block, and any run-page message. This is actionable in the repository.',
  },
  no_step_scheduling_failure: {
    label: 'no-step scheduling/billing failure',
    meaning: 'A job concluded without any step running: no runner was allocated.',
    next: 'Verify Actions enablement, billing/spending limit, minutes quota, and organization policy outside the repository. Do not edit workflows to chase it; prove the change locally with `bun run check`.',
  },
  job_failure: {
    label: 'normal job failure',
    meaning: 'A real step started and failed, so the cause is inside the repository.',
    next: 'Read the failed step logs (`gh run view <id> --log-failed`) and fix the code or configuration that step exercised.',
  },
  unknown: {
    label: 'unknown',
    meaning: 'The available evidence is insufficient to classify the run.',
    next: 'Re-run with more job detail or inspect the run manually.',
  },
};

export function describeClass(failureClass: FailureClass): { label: string; meaning: string; next: string } {
  return CLASS_DESCRIPTIONS[failureClass];
}

export function assertReadOnlyGhArgs(argv: readonly string[]): void {
  if (argv.length === 0) throw new ReadOnlyViolationError(argv, 'empty command');
  if (argv[0] !== 'gh') throw new ReadOnlyViolationError(argv, 'only the gh CLI may be executed');
  const subcommand = argv[1];

  if (subcommand === '--version' || subcommand === '-v' || subcommand === '--help') return;

  if (subcommand === 'run') {
    const verb = argv[2];
    if (verb === 'list' || verb === 'view') return;
    throw new ReadOnlyViolationError(argv, 'only `gh run list` and `gh run view` are read-only');
  }

  if (subcommand === 'api') {
    for (const argument of argv.slice(2)) {
      if (!argument.startsWith('-')) continue;
      const flag = argument.includes('=') ? argument.split('=')[0]! : argument;
      if (API_REQUEST_BLOCKING_FLAGS.has(flag)) {
        throw new ReadOnlyViolationError(argv, 'the gh api allowlist permits GET requests only');
      }
    }
    const path = argv.slice(2).find(argument => argument.startsWith('/'));
    if (!path || !API_PATH_PATTERN.test(path)) {
      throw new ReadOnlyViolationError(argv, 'gh api is limited to GET /repos/<owner>/<repo>/actions/...');
    }
    return;
  }

  throw new ReadOnlyViolationError(argv, 'subcommand is not on the read-only allowlist');
}

export async function runReadOnlyGh(argv: readonly string[], runner: CommandRunner): Promise<CommandResult> {
  assertReadOnlyGhArgs(argv);
  return runner([...argv]);
}

export async function probeGh(runner: CommandRunner = defaultCommandRunner): Promise<{ available: boolean; version: string | null; error: string | null }> {
  try {
    const result = await runner(['gh', '--version']);
    const version = result.stdout.split('\n')[0]?.trim() ?? '';
    if (result.code === 0) return { available: true, version: version || null, error: null };
    return { available: false, version: null, error: result.stderr.trim() || `gh --version exited with ${result.code}` };
  } catch (error) {
    return { available: false, version: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function isGhAvailable(runner: CommandRunner = defaultCommandRunner): Promise<boolean> {
  return (await probeGh(runner)).available;
}

export function parseJsonPayload<T>(stdout: string, context: string): T {
  const trimmed = stdout.trim();
  if (trimmed === '') throw new DiagnosticsError(`${context} returned no output`);
  try {
    return JSON.parse(trimmed) as T;
  } catch (error) {
    throw new DiagnosticsError(`${context} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parseRunList(stdout: string): CiRun[] {
  const parsed = parseJsonPayload<unknown>(stdout, 'gh run list');
  if (!Array.isArray(parsed)) throw new DiagnosticsError('gh run list did not return an array');
  return parsed.filter((entry): entry is CiRun => typeof entry === 'object' && entry !== null && typeof (entry as CiRun).databaseId === 'number');
}

function emptyCounts(): Record<FailureClass, number> {
  return {
    success: 0,
    in_progress: 0,
    skipped: 0,
    cancelled: 0,
    configuration_failure: 0,
    no_step_scheduling_failure: 0,
    job_failure: 0,
    unknown: 0,
  };
}

export function buildReport(runs: readonly CiRun[], meta: { generatedAt: string; source: 'gh' | 'unavailable'; ghVersion: string | null; reason: string | null }): DiagnosticsReport {
  const counts = emptyCounts();
  const diagnoses = runs.map(classifyRun);
  for (const diagnosis of diagnoses) counts[diagnosis.class] += 1;
  return { generatedAt: meta.generatedAt, source: meta.source, ghVersion: meta.ghVersion, reason: meta.reason, counts, runs: diagnoses };
}

function needsJobDetails(run: CiRun): boolean {
  if ((run.status ?? 'completed') !== 'completed') return false;
  const conclusion = run.conclusion ?? '';
  return !['success', 'neutral', 'skipped'].includes(conclusion);
}

export async function collectDiagnostics(options: DiagnosticsOptions = {}): Promise<DiagnosticsReport> {
  const runner = options.runner ?? defaultCommandRunner;
  const generatedAt = (options.now ?? new Date()).toISOString();
  const availability = await probeGh(runner);
  if (!availability.available) {
    return buildReport([], {
      generatedAt,
      source: 'unavailable',
      ghVersion: availability.version,
      reason: availability.error ?? 'gh is not available on PATH',
    });
  }

  const limit = Number.isSafeInteger(options.limit) && (options.limit ?? 0) > 0 ? options.limit! : 25;
  const listArgs = ['gh', 'run', 'list', '--limit', String(limit), '--json', RUN_LIST_FIELDS];
  if (options.workflow) listArgs.push('--workflow', options.workflow);
  if (options.branch) listArgs.push('--branch', options.branch);
  if (options.event) listArgs.push('--event', options.event);
  if (options.repo) listArgs.push('--repo', options.repo);

  const listResult = await runReadOnlyGh(listArgs, runner);
  if (listResult.code !== 0) {
    throw new DiagnosticsError(`gh run list failed (${listResult.code}): ${listResult.stderr.trim() || 'no error output'}`);
  }

  const runs: CiRun[] = [];
  for (const run of parseRunList(listResult.stdout)) {
    if (!needsJobDetails(run)) {
      runs.push({ ...run, jobs: [] });
      continue;
    }
    const viewArgs = ['gh', 'run', 'view', String(run.databaseId), '--json', RUN_VIEW_FIELDS];
    if (options.repo) viewArgs.push('--repo', options.repo);
    const viewResult = await runReadOnlyGh(viewArgs, runner);
    if (viewResult.code !== 0) {
      runs.push({ ...run, jobsFetchError: viewResult.stderr.trim() || `gh run view exited with ${viewResult.code}` });
      continue;
    }
    const detailed = parseJsonPayload<CiRun>(viewResult.stdout, `gh run view ${run.databaseId}`);
    runs.push({ ...run, ...detailed, jobs: detailed.jobs ?? [] });
  }

  return buildReport(runs, { generatedAt, source: 'gh', ghVersion: availability.version, reason: null });
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

export function formatReport(report: DiagnosticsReport): string {
  const lines: string[] = [];
  const source = report.source === 'gh' ? `gh ${report.ghVersion ?? 'unknown'}` : 'gh unavailable';
  lines.push(`ElastraX CI diagnostics (read-only) at ${report.generatedAt} - source: ${source}`);
  if (report.reason) lines.push(`  note: ${report.reason}`);
  if (report.runs.length === 0) {
    lines.push('No workflow runs were returned. Nothing to classify.');
    return lines.join('\n');
  }
  for (const run of report.runs) {
    const description = describeClass(run.class);
    const timing = run.durationMs == null ? '' : ` ~${Math.round(run.durationMs / 1000)}s`;
    lines.push('');
    lines.push(
      `#${run.databaseId} ${pad(run.workflowName, 18)} ${pad(run.event, 14)} ${pad(run.headBranch, 12)} ${pad(String(run.class), 28)}${run.fastFailure ? ' fast-fail' : ''}`
    );
    lines.push(`  title: ${run.displayTitle || '(none)'}`);
    lines.push(`  url:   ${run.url || '(none)'}`);
    lines.push(`  class: ${description.label}${timing} - ${description.meaning}`);
    for (const reason of run.reasons.slice(0, 6)) lines.push(`    - ${reason}`);
    lines.push(`    next: ${description.next}`);
  }
  const summary = (Object.entries(report.counts) as [FailureClass, number][])
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${count} ${key}`);
  lines.push('');
  lines.push(`Summary: ${summary.length > 0 ? summary.join(', ') : 'nothing classified'}`);
  const actionable = report.counts.configuration_failure + report.counts.job_failure;
  if (actionable > 0) {
    lines.push(`Actionable in-repository failures: ${actionable}.`);
  } else if (report.counts.no_step_scheduling_failure > 0) {
    lines.push(
      `No in-repository failure detected; ${report.counts.no_step_scheduling_failure} run(s) still need account-side scheduling/billing verification.`,
    );
  } else {
    lines.push('No failure detected in the inspected runs.');
  }
  return lines.join('\n');
}

const HELP = [
  'Usage: bun run scripts/ciDiagnostics.ts [options]',
  '',
  'Options:',
  '  --limit <n>          number of recent runs to inspect (default 25)',
  '  --workflow <name>    filter by workflow name, for example CI',
  '  --branch <name>      filter by head branch',
  '  --event <name>       filter by event, for example push or pull_request',
  '  --repo <owner/name>  target another repository explicitly',
  '  --json               emit the machine-readable report instead of text',
  '  --help               show this message',
  '',
  'The script is read-only: it runs `gh run list`, `gh run view`, and GET-only',
  '`gh api` calls. It never edits workflows, never re-runs or cancels runs, and',
  'degrades to an "unavailable" report when `gh` is missing or unauthenticated.',
  '',
  'Exit codes: 0 no in-repository failure, 1 configuration or job failure,',
  '2 usage or collection error.',
].join('\n');

interface ParsedArgs {
  options: DiagnosticsOptions;
  json: boolean;
  help: boolean;
  error: string | null;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const options: DiagnosticsOptions = {};
  let json = false;
  let help = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    const readValue = (): string | null => {
      const inline = argument.includes('=') ? argument.split('=').slice(1).join('=') : null;
      if (inline != null) return inline;
      const next = argv[index + 1];
      if (next == null || next.startsWith('--')) return null;
      index += 1;
      return next;
    };
    const name = argument.split('=')[0]!;
    switch (name) {
      case '--limit': {
        const value = readValue();
        if (value == null) return { options, json, help, error: '--limit requires a positive integer' };
        options.limit = Number(value);
        break;
      }
      case '--workflow': {
        const value = readValue();
        if (value == null) return { options, json, help, error: '--workflow requires a workflow name' };
        options.workflow = value;
        break;
      }
      case '--branch': {
        const value = readValue();
        if (value == null) return { options, json, help, error: '--branch requires a branch name' };
        options.branch = value;
        break;
      }
      case '--event': {
        const value = readValue();
        if (value == null) return { options, json, help, error: '--event requires an event name' };
        options.event = value;
        break;
      }
      case '--repo': {
        const value = readValue();
        if (value == null) return { options, json, help, error: '--repo requires owner/name' };
        options.repo = value;
        break;
      }
      case '--json':
        json = true;
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      default:
        return { options, json, help, error: `unknown argument: ${argument}` };
    }
  }
  return { options, json, help, error: null };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    console.log(HELP);
    return;
  }
  if (parsed.error) {
    console.error(parsed.error);
    console.error(HELP);
    process.exitCode = 2;
    return;
  }

  let report: DiagnosticsReport;
  try {
    report = await collectDiagnostics(parsed.options);
  } catch (error) {
    console.error(`[ci-diagnostics] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
    return;
  }

  if (parsed.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatReport(report));

  const actionable = report.counts.configuration_failure + report.counts.job_failure;
  process.exitCode = report.source === 'unavailable' ? 2 : actionable > 0 ? 1 : 0;
}

if (import.meta.main) await main();
