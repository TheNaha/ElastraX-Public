import type { WebhookBody } from '../types';
import { asNonEmptyString, asRecord, toObjectArray } from '../utils';

export function adaptGitHub(event: string, body: WebhookBody): string {
  switch (event) {
    case 'push': {
      const branch = asNonEmptyString(body.ref)?.replace('refs/heads/', '') || '';
      const repo = asNonEmptyString(asRecord(body.repository)?.full_name) || 'unknown';
      const commits = toObjectArray(body.commits).slice(0, 3);
      const commitLines = commits
        .map((commit) => {
          const message = asNonEmptyString(commit.message) || '(no message)';
          const id = asNonEmptyString(commit.id)?.slice(0, 7) || 'unknown';
          return `  • ${message.split('\n')[0]} (${id})`;
        })
        .join('\n');
      return `🔔 *GitHub Push*\n📦 Repo: ${repo}\n🌿 Branch: ${branch}\n📝 Commits:\n${commitLines || '  (no commits)'}`;
    }
    case 'pull_request': {
      const pr = asRecord(body.pull_request);
      const action = asNonEmptyString(body.action)?.toUpperCase() || 'UNKNOWN';
      const repo = asNonEmptyString(asRecord(body.repository)?.full_name) || 'unknown';
      return `🔔 *GitHub PR ${action}*\n📦 ${repo}\n#${String(pr?.number ?? '?')} ${asNonEmptyString(pr?.title) || 'Untitled'}\n🔗 ${asNonEmptyString(pr?.html_url) || ''}`;
    }
    case 'issues': {
      const issue = asRecord(body.issue);
      const action = asNonEmptyString(body.action)?.toUpperCase() || 'UNKNOWN';
      const repo = asNonEmptyString(asRecord(body.repository)?.full_name) || 'unknown';
      return `🔔 *GitHub Issue ${action}*\n📦 ${repo}\n#${String(issue?.number ?? '?')} ${asNonEmptyString(issue?.title) || 'Untitled'}\n🔗 ${asNonEmptyString(issue?.html_url) || ''}`;
    }
    case 'release': {
      const rel = asRecord(body.release);
      const repo = asNonEmptyString(asRecord(body.repository)?.full_name) || 'unknown';
      return `🎉 *GitHub Release: ${asNonEmptyString(rel?.tag_name) || 'unknown'}*\n📦 ${repo}\n${asNonEmptyString(rel?.name) || ''}\n🔗 ${asNonEmptyString(rel?.html_url) || ''}`;
    }
    case 'workflow_run': {
      const wf = asRecord(body.workflow_run);
      const conclusion = asNonEmptyString(wf?.conclusion);
      const icon = conclusion === 'success' ? '✅' : conclusion === 'failure' ? '❌' : '⚙️';
      const repo = asNonEmptyString(asRecord(body.repository)?.full_name) || 'unknown';
      return `${icon} *GitHub Workflow: ${asNonEmptyString(wf?.name) || 'unknown'}*\n📦 ${repo}\nStatus: ${asNonEmptyString(wf?.status) || 'unknown'} / ${conclusion || 'running'}\n🔗 ${asNonEmptyString(wf?.html_url) || ''}`;
    }
    default:
      return `🔔 *GitHub Event: ${event}*\n${JSON.stringify(body).slice(0, 200)}`;
  }
}
