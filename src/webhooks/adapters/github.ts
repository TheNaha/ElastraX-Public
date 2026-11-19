import type { WebhookBody } from '../types';
import { asNonEmptyString, asRecord, toObjectArray } from '../utils';
import { t } from '../../utils/i18n';

/** GitHub event notifications. `lang` is the target room's language. */
export function adaptGitHub(event: string, body: WebhookBody, lang: string = 'en'): string {
  const unknown = t(lang, 'webhook.unknown');
  switch (event) {
    case 'push': {
      const branch = asNonEmptyString(body.ref)?.replace('refs/heads/', '') || '';
      const repo = asNonEmptyString(asRecord(body.repository)?.full_name) || unknown;
      const commits = toObjectArray(body.commits).slice(0, 3);
      const commitLines = commits
        .map((commit) => {
          const message = asNonEmptyString(commit.message) || t(lang, 'webhook.github.no_message');
          const id = asNonEmptyString(commit.id)?.slice(0, 7) || unknown;
          return `  • ${message.split('\n')[0]} (${id})`;
        })
        .join('\n');
      return [
        t(lang, 'webhook.github.push'),
        t(lang, 'webhook.github.repo', { repo }),
        t(lang, 'webhook.github.branch', { branch }),
        t(lang, 'webhook.github.commits'),
        commitLines || `  ${t(lang, 'webhook.github.no_commits')}`,
      ].join('\n');
    }
    case 'pull_request': {
      const pr = asRecord(body.pull_request);
      const action = asNonEmptyString(body.action)?.toUpperCase() || 'UNKNOWN';
      const repo = asNonEmptyString(asRecord(body.repository)?.full_name) || unknown;
      return [
        t(lang, 'webhook.github.pull_request', { action }),
        t(lang, 'webhook.github.pull_request_title', {
          repo,
          number: String(pr?.number ?? '?'),
          title: asNonEmptyString(pr?.title) || t(lang, 'webhook.github.untitled'),
        }),
        `🔗 ${asNonEmptyString(pr?.html_url) || ''}`,
      ].join('\n');
    }
    case 'issues': {
      const issue = asRecord(body.issue);
      const action = asNonEmptyString(body.action)?.toUpperCase() || 'UNKNOWN';
      const repo = asNonEmptyString(asRecord(body.repository)?.full_name) || unknown;
      return [
        t(lang, 'webhook.github.issue', { action }),
        t(lang, 'webhook.github.issue_title', {
          repo,
          number: String(issue?.number ?? '?'),
          title: asNonEmptyString(issue?.title) || t(lang, 'webhook.github.untitled'),
        }),
        `🔗 ${asNonEmptyString(issue?.html_url) || ''}`,
      ].join('\n');
    }
    case 'release': {
      const rel = asRecord(body.release);
      const repo = asNonEmptyString(asRecord(body.repository)?.full_name) || unknown;
      return [
        t(lang, 'webhook.github.release', { tag: asNonEmptyString(rel?.tag_name) || unknown }),
        t(lang, 'webhook.github.repo', { repo }),
        asNonEmptyString(rel?.name) || '',
        `🔗 ${asNonEmptyString(rel?.html_url) || ''}`,
      ].join('\n');
    }
    case 'workflow_run': {
      const wf = asRecord(body.workflow_run);
      const conclusion = asNonEmptyString(wf?.conclusion);
      const icon = conclusion === 'success' ? '✅' : conclusion === 'failure' ? '❌' : '⚙️';
      const repo = asNonEmptyString(asRecord(body.repository)?.full_name) || unknown;
      return [
        `${icon} ${t(lang, 'webhook.github.workflow', { name: asNonEmptyString(wf?.name) || unknown })}`,
        t(lang, 'webhook.github.repo', { repo }),
        t(lang, 'webhook.github.workflow_status', {
          status: asNonEmptyString(wf?.status) || unknown,
          conclusion: conclusion || t(lang, 'webhook.github.running'),
        }),
        `🔗 ${asNonEmptyString(wf?.html_url) || ''}`,
      ].join('\n');
    }
    default:
      return `${t(lang, 'webhook.github.event', { event })}\n${JSON.stringify(body).slice(0, 200)}`;
  }
}
