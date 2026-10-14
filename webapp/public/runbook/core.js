/* DocViewer runbook core — runnable steps, variables, run history. Works in browser and Node. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.RunbookCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const str = (v, max) => String(v == null ? '' : v).slice(0, max || 500);
  const uid = (p) => (p || 'x') + Math.random().toString(36).slice(2, 9);
  const STATUSES = ['pending', 'running', 'done', 'failed', 'skipped', 'sent', 'timeout'];

  function normCmd(c) {
    const s = c && typeof c === 'object' ? c : { cmd: c };
    return { id: str(s.id, 40) || uid('c_'), cmd: str(s.cmd, 20000), confirm: !!s.confirm };
  }
  function normStep(st) {
    const s = st && typeof st === 'object' ? st : {};
    return {
      id: str(s.id, 40) || uid('st_'),
      title: str(s.title, 300) || 'Step',
      notes: str(s.notes, 50000),
      cmds: (Array.isArray(s.cmds) ? s.cmds : []).map(normCmd).slice(0, 50),
      target: str(s.target, 500), // terminal file override ('' = runbook default)
      manual: !!s.manual, // a manual check: just tick it off
    };
  }
  function normResult(r) {
    const s = r && typeof r === 'object' ? r : {};
    return {
      stepId: str(s.stepId, 40),
      cmdId: str(s.cmdId, 40),
      status: STATUSES.includes(s.status) ? s.status : 'pending',
      output: str(s.output, 100000),
      exit: Number.isInteger(s.exit) ? s.exit : null,
      startedAt: Number(s.startedAt) || null,
      endedAt: Number(s.endedAt) || null,
      target: str(s.target, 500),
      cmd: str(s.cmd, 20000),
    };
  }
  function normRun(r) {
    const s = r && typeof r === 'object' ? r : {};
    return {
      id: str(s.id, 40) || uid('r_'),
      at: Number(s.at) || Date.now(),
      kind: s.kind === 'rollback' ? 'rollback' : 'main',
      vars: s.vars && typeof s.vars === 'object' ? Object.fromEntries(Object.entries(s.vars).slice(0, 100).map(([k, v]) => [str(k, 60), str(v, 2000)])) : {},
      results: (Array.isArray(s.results) ? s.results : []).map(normResult).slice(0, 500),
      note: str(s.note, 2000),
      finishedAt: Number(s.finishedAt) || null,
    };
  }
  function normalize(data) {
    const s = data && typeof data === 'object' ? data : {};
    return {
      version: 1,
      title: str(s.title, 200) || 'Runbook',
      summary: str(s.summary, 20000),
      target: str(s.target, 500),
      timeoutSec: Number.isInteger(s.timeoutSec) && s.timeoutSec >= 5 && s.timeoutSec <= 14400 ? s.timeoutSec : 1800,
      vars: (Array.isArray(s.vars) ? s.vars : []).slice(0, 100).map((v) => ({ name: str(v && v.name, 60).replace(/[^\w.-]/g, ''), value: str(v && v.value, 2000), desc: str(v && v.desc, 300) })).filter((v) => v.name),
      steps: (Array.isArray(s.steps) ? s.steps : []).map(normStep).slice(0, 300),
      rollback: (Array.isArray(s.rollback) ? s.rollback : []).map(normStep).slice(0, 300),
      runs: (Array.isArray(s.runs) ? s.runs : []).map(normRun).slice(-20),
      updatedAt: str(s.updatedAt, 40),
    };
  }

  // {{name}} → value; unknown names stay as-is (and are reported).
  function fill(text, vars) {
    const missing = [];
    const out = String(text).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, k) => {
      const v = vars.find((x) => x.name === k);
      if (!v || v.value === '') { missing.push(k); return m; }
      return v.value;
    });
    return { text: out, missing: [...new Set(missing)] };
  }
  function varsUsed(rb) {
    const names = new Set();
    rb.steps.concat(rb.rollback).forEach((st) => st.cmds.forEach((c) => String(c.cmd).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, k) => names.add(k))));
    return [...names];
  }

  const S = (title, notes, cmds, extra) => Object.assign({ title, notes, cmds: (cmds || []).map((c) => (typeof c === 'string' ? { cmd: c } : c)) }, extra || {});
  const TEMPLATES = {
    blank: () => ({
      title: 'Runbook',
      summary: 'What this runbook does and when to use it.',
      vars: [{ name: 'host', value: '', desc: 'Target host' }],
      steps: [S('Check connectivity', 'Make sure the host answers.', ['ping -c 3 {{host}}']), S('Do the thing', '', ['echo "replace me"'])],
      rollback: [S('Undo', '', ['echo "undo"'])],
    }),
    change: () => ({
      title: 'Network change',
      summary: 'Change window: {{ticket}}. Run pre-checks, apply, verify; roll back on failure.',
      vars: [
        { name: 'ticket', value: '', desc: 'Change ticket' },
        { name: 'device', value: '', desc: 'Switch / router (SSH alias)' },
        { name: 'iface', value: 'swp1', desc: 'Interface' },
      ],
      steps: [
        S('Pre-check: reachability', '', ['ping -c 3 {{device}}']),
        S('Pre-check: backup config', 'Keep a copy before changing anything.', ['ssh {{device}} "nv config show" > backup-{{device}}-$(date +%Y%m%d-%H%M).yaml && ls -la backup-{{device}}-*']),
        S('Pre-check: interface / BGP state', '', ['ssh {{device}} "nv show interface {{iface}}"', 'ssh {{device}} "nv show vrf default router bgp neighbor"']),
        S('Apply change', 'Review the plan before applying.', [{ cmd: 'ssh {{device}} "nv config diff"' }, { cmd: 'ssh {{device}} "nv config apply -y"', confirm: true }]),
        S('Verify', '', ['ssh {{device}} "nv show interface {{iface}}"', 'ssh {{device}} "nv show vrf default router bgp neighbor"']),
        S('Sign-off', 'Confirm with the requester; close {{ticket}}.', [], { manual: true }),
      ],
      rollback: [
        S('Restore previous config', '', [{ cmd: 'ssh {{device}} "nv config apply startup -y"', confirm: true }]),
        S('Verify after rollback', '', ['ssh {{device}} "nv show interface {{iface}}"']),
      ],
    }),
    incident: () => ({
      title: 'Incident triage',
      summary: 'First 15 minutes: gather facts, mitigate, verify, communicate.',
      vars: [{ name: 'host', value: '', desc: 'Affected host' }, { name: 'service', value: '', desc: 'Service / unit' }],
      steps: [
        S('Acknowledge & open channel', 'Post in the incident channel; assign a lead.', [], { manual: true }),
        S('Is it up?', '', ['ping -c 3 {{host}}', 'curl -s -o /dev/null -w "%{http_code} %{time_total}s\\n" https://{{host}}/ || true']),
        S('Recent errors', '', ['ssh {{host}} "journalctl -u {{service}} --since \\"-15 min\\" -p err --no-pager | tail -50"']),
        S('Resources', '', ['ssh {{host}} "uptime; df -h /; free -m"']),
        S('Mitigate: restart service', 'Only if the logs point to a stuck process.', [{ cmd: 'ssh {{host}} "sudo systemctl restart {{service}}"', confirm: true }]),
        S('Verify recovery', '', ['ssh {{host}} "systemctl is-active {{service}}"']),
        S('Write the timeline', 'Copy the run log into the incident report.', [], { manual: true }),
      ],
      rollback: [],
    }),
    deploy: () => ({
      title: 'Deploy',
      summary: 'Build, release {{version}}, smoke test; roll back if smoke tests fail.',
      vars: [{ name: 'version', value: '', desc: 'Version / tag' }, { name: 'dir', value: '~/app', desc: 'Project folder' }],
      steps: [
        S('Clean tree', '', ['cd {{dir}} && git status --short && git fetch --tags']),
        S('Build', '', ['cd {{dir}} && git checkout {{version}} && npm ci && npm run build']),
        S('Release', '', [{ cmd: 'cd {{dir}} && ./deploy.sh {{version}}', confirm: true }]),
        S('Smoke test', '', ['curl -fsS https://example.com/health']),
      ],
      rollback: [S('Roll back to previous', '', [{ cmd: 'cd {{dir}} && ./deploy.sh previous', confirm: true }])],
    }),
  };
  function createStarter(kind) { return normalize((TEMPLATES[kind] || TEMPLATES.blank)()); }

  function serializeToHtml(data, title) {
    const norm = normalize(data);
    if (title) norm.title = str(title, 200);
    norm.updatedAt = new Date().toISOString();
    const json = JSON.stringify(norm, null, 2).replace(/</g, '\\u003c');
    const t = String(title || norm.title || 'Runbook').replace(/[<>]/g, '');
    return `<!DOCTYPE html>\n<html lang="en" data-docviewer="runbook">\n<head><meta charset="UTF-8"><title>${t}</title></head>\n<body>\n<script type="application/json" id="runbook-data">\n${json}\n</script>\n</body>\n</html>\n`;
  }
  function isRunbookHtml(html) { return typeof html === 'string' && /data-docviewer\s*=\s*["']runbook["']/.test(html); }
  function parseHtml(html) {
    if (!isRunbookHtml(html)) return null;
    const m = String(html).match(/<script[^>]*id=["']runbook-data["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!m) return normalize({});
    try { return normalize(JSON.parse(m[1])); } catch (e) { return normalize({}); }
  }

  // Markdown report of one run.
  function runToMarkdown(rb, run) {
    const all = rb.steps.concat(rb.rollback);
    const out = [`# ${rb.title} — ${run.kind === 'rollback' ? 'rollback ' : ''}run`, '', `_${new Date(run.at).toLocaleString()}${run.finishedAt ? ' → ' + new Date(run.finishedAt).toLocaleString() : ''}_`, ''];
    const vars = Object.entries(run.vars);
    if (vars.length) { out.push('| Variable | Value |', '| --- | --- |'); vars.forEach(([k, v]) => out.push(`| ${k} | ${String(v).replace(/\|/g, '\\|')} |`)); out.push(''); }
    if (run.note) out.push(run.note, '');
    const icon = { done: '✅', failed: '❌', skipped: '⏭', sent: '📤', timeout: '⏱', running: '⏳', pending: '·' };
    all.forEach((st) => {
      const rs = run.results.filter((r) => r.stepId === st.id);
      if (!rs.length) return;
      out.push(`## ${st.title}`, '');
      rs.forEach((r) => {
        out.push(`${icon[r.status] || ''} **${r.status}**${r.exit != null ? ` (exit ${r.exit})` : ''}${r.startedAt && r.endedAt ? ` · ${Math.round((r.endedAt - r.startedAt) / 1000)}s` : ''}${r.target ? ` · on \`${r.target}\`` : ''}`, '');
        if (r.cmd) out.push('```bash', r.cmd, '```', '');
        if (r.output) out.push('```text', r.output, '```', '');
      });
    });
    return out.join('\n');
  }

  return { STATUSES, uid, normalize, normalizeStep: normStep, normalizeCmd: normCmd, normalizeRun: normRun, fill, varsUsed, TEMPLATES, createStarter, serializeToHtml, isRunbookHtml, parseHtml, runToMarkdown };
});
