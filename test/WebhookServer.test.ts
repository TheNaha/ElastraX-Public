import { describe, test, expect, mock } from 'bun:test';

const _mockLogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => _mockLogger,
};

mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

import { buildWebhookMessage, readRequestBodyWithLimit, resolveRoomIds, resolveWebhookMaxBodyBytes, resolveWebhookPort } from '../src/webhookServer';

describe('WebhookServer helpers', () => {
  test('buildWebhookMessage should parse Apprise-like payload', () => {
    const msg = buildWebhookMessage({}, {
      title: 'Build Notification',
      body: 'CI finished successfully',
      notify_type: 'success',
      tags: ['ci', 'deploy'],
      source: 'GitHub Actions',
    });

    expect(msg).toContain('*Build Notification*');
    expect(msg).toContain('CI finished successfully');
    expect(msg).toContain('Tags: ci, deploy');
    expect(msg).toContain('Source: GitHub Actions');
  });

  test('buildWebhookMessage should keep GitHub adapter behavior', () => {
    const msg = buildWebhookMessage(
      { 'x-github-event': 'push' },
      {
        ref: 'refs/heads/main',
        repository: { full_name: 'owner/repo' },
        commits: [{ message: 'feat: add webhook', id: 'abcdef123456' }],
      },
    );

    expect(msg).toContain('GitHub Push');
    expect(msg).toContain('owner/repo');
    expect(msg).toContain('feat: add webhook');
  });

  test('buildWebhookMessage should create rich generic message', () => {
    const msg = buildWebhookMessage({}, {
      title: 'Database Alarm',
      message: 'Replication lag over threshold',
      priority: 'critical',
      tags: ['db', 'prod'],
      event: 'db.replication.lag',
      source: 'Prometheus',
      url: 'https://status.example.com',
    });

    expect(msg).toContain('*Database Alarm*');
    expect(msg).toContain('Replication lag over threshold');
    expect(msg).toContain('Priority: critical');
    expect(msg).toContain('Tags: db, prod');
    expect(msg).toContain('Event: db.replication.lag');
  });

  test('buildWebhookMessage should parse Grafana alert batches', () => {
    const msg = buildWebhookMessage({ 'x-grafana-origin': 'alertmanager' }, {
      alerts: [
        {
          status: 'firing',
          labels: { alertname: 'HighCPU' },
          annotations: { summary: 'CPU above 95%' },
        },
        {
          status: 'resolved',
          labels: { alertname: 'DiskFull' },
          annotations: { description: 'Disk usage recovered' },
        },
      ],
    });

    expect(msg).toContain('HighCPU');
    expect(msg).toContain('CPU above 95%');
    expect(msg).toContain('DiskFull');
    expect(msg).toContain('RESOLVED');
  });

  test('buildWebhookMessage should fall back for Grafana payloads without alerts', () => {
    const msg = buildWebhookMessage({ 'x-grafana-origin': 'alertmanager' }, { note: 'raw payload' });
    expect(msg).toContain('Grafana Alert');
    expect(msg).toContain('raw payload');
  });

  test('buildWebhookMessage should support GitHub workflow, issues, and fallback events', () => {
    const workflowMsg = buildWebhookMessage(
      { 'x-github-event': 'workflow_run' },
      {
        repository: { full_name: 'owner/repo' },
        workflow_run: { name: 'CI', status: 'completed', conclusion: 'success', html_url: 'https://ci.example' },
      },
    );
    expect(workflowMsg).toContain('GitHub Workflow');
    expect(workflowMsg).toContain('success');

    const issuesMsg = buildWebhookMessage(
      { 'x-github-event': 'issues' },
      {
        action: 'opened',
        repository: { full_name: 'owner/repo' },
        issue: { number: 42, title: 'Bug report', html_url: 'https://issues.example/42' },
      },
    );
    expect(issuesMsg).toContain('GitHub Issue OPENED');
    expect(issuesMsg).toContain('Bug report');

    const fallbackMsg = buildWebhookMessage({ 'x-github-event': 'deployment' }, { ok: true });
    expect(fallbackMsg).toContain('GitHub Event: deployment');
  });

  test('buildWebhookMessage should stringify payloads with no generic fields', () => {
    const msg = buildWebhookMessage({}, { nested: { value: 1 } });
    expect(msg).toContain('Webhook payload');
    expect(msg).toContain('nested');
  });

  test('resolveRoomIds should merge room_id and room_ids', () => {
    const url = new URL('http://localhost:3500/webhook?room_id=123456789&room_ids=alpha,beta');
    const roomIds = resolveRoomIds(
      {
        room_id: '120363000111222@g.us',
        room_ids: ['123456789', '120363000111222@g.us', 'room-x'],
      },
      url,
    );

    expect(roomIds).toEqual([
      '120363000111222@g.us',
      '123456789',
      'room-x',
      'alpha',
      'beta',
    ]);
  });

  test('resolveWebhookPort should return configured valid ports', () => {
    expect(resolveWebhookPort('0')).toBe(0);
    expect(resolveWebhookPort('3501')).toBe(3501);
  });

  test('resolveWebhookPort should fall back to default on invalid values', () => {
    expect(resolveWebhookPort(undefined)).toBe(3500);
    expect(resolveWebhookPort('')).toBe(3500);
    expect(resolveWebhookPort('not-a-number')).toBe(3500);
    expect(resolveWebhookPort('-1')).toBe(3500);
    expect(resolveWebhookPort('70000')).toBe(3500);
  });

  test('resolveWebhookMaxBodyBytes should parse configured limit and fall back safely', () => {
    expect(resolveWebhookMaxBodyBytes('1024')).toBe(1024);
    expect(resolveWebhookMaxBodyBytes(undefined)).toBe(256 * 1024);
    expect(resolveWebhookMaxBodyBytes('0')).toBe(256 * 1024);
    expect(resolveWebhookMaxBodyBytes('invalid')).toBe(256 * 1024);
  });

  test('readRequestBodyWithLimit should read small request bodies', async () => {
    const req = new Request('http://localhost/webhook', {
      method: 'POST',
      body: JSON.stringify({ ok: true }),
      headers: { 'Content-Type': 'application/json' },
    });

    const body = await readRequestBodyWithLimit(req, 1024);
    expect(body).toContain('"ok":true');
  });

  test('readRequestBodyWithLimit should reject oversized bodies from content-length', async () => {
    const req = new Request('http://localhost/webhook', {
      method: 'POST',
      body: 'hello',
      headers: { 'Content-Length': '9999' },
    });

    await expect(readRequestBodyWithLimit(req, 100)).rejects.toThrow('Request body too large');
  });

  test('readRequestBodyWithLimit should reject oversized streamed bodies', async () => {
    const req = new Request('http://localhost/webhook', {
      method: 'POST',
      body: 'x'.repeat(128),
      headers: { 'Content-Type': 'text/plain' },
    });

    await expect(readRequestBodyWithLimit(req, 64)).rejects.toThrow('Request body too large');
  });
});
