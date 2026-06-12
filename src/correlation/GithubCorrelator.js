const { execFileSync } = require('child_process');

function correlateGithub(incident, config = {}) {
  if (config.githubCorrelation === false) return null;
  try {
    const since = Math.floor(((incident.first_seen || Date.now()) - 30 * 60 * 1000) / 1000);
    const output = execFileSync('git', [
      'log',
      `--since=@${since}`,
      '--name-only',
      '--pretty=format:%H%x09%an%x09%ct%x09%s',
      '--',
    ], { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

    const commits = parseGitLog(output);
    if (!commits.length) return null;
    const endpointHint = String(incident.path || incident.service || '').split('/').filter(Boolean)[1] || '';
    const scored = commits.map(commit => ({
      ...commit,
      confidence: scoreCommit(commit, endpointHint, incident),
    })).sort((a, b) => b.confidence - a.confidence);

    const best = scored[0];
    return {
      commitHash: best.hash,
      author: best.author,
      subject: best.subject,
      changedFiles: best.files,
      confidence: best.confidence,
    };
  } catch (e) {
    return null;
  }
}

function parseGitLog(output) {
  const commits = [];
  let current = null;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const header = line.split('\t');
    if (header.length >= 4 && /^[0-9a-f]{7,40}$/i.test(header[0])) {
      if (current) commits.push(current);
      current = { hash: header[0], author: header[1], timestamp: Number(header[2]) * 1000, subject: header.slice(3).join('\t'), files: [] };
    } else if (current) {
      current.files.push(line.trim());
    }
  }
  if (current) commits.push(current);
  return commits;
}

function scoreCommit(commit, endpointHint, incident) {
  let score = 50;
  const haystack = `${commit.subject} ${commit.files.join(' ')}`.toLowerCase();
  if (endpointHint && haystack.includes(endpointHint.toLowerCase())) score += 25;
  if (incident.root_cause && haystack.includes(String(incident.root_cause).toLowerCase())) score += 10;
  if (commit.files.some(f => /src|routes|api|server|controller/i.test(f))) score += 10;
  return Math.min(95, score);
}

module.exports = { correlateGithub };
