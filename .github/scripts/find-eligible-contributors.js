#!/usr/bin/env node

/**
 * find-eligible-contributors.js
 *
 * Finds users who have opened pull requests on a GitHub repo,
 * are NOT collaborators on that repo, and match:
 *   - fewer than 5 currently open PRs
 *   - more than 2 merged PRs
 *   - merge rate (merged / closed) > 50%
 *
 * Usage:
 *   GITHUB_TOKEN=xxxx node find-eligible-contributors.js <owner> <repo>
 */

const GITHUB_API = 'https://api.github.com';

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'find-eligible-contributors-script',
  };
}

/**
 * Generic paginated GET helper for GitHub REST API.
 * Follows `page` param at 100/page until an empty/short page is returned.
 *
 * Optional `stopWhen(item)` callback: if it returns true for an item,
 * pagination stops immediately (that item and all subsequent items,
 * including on later pages, are discarded).
 */
async function fetchAllPages(url, token, { stopWhen } = {}) {
  const results = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const pageUrl = new URL(url);
    pageUrl.searchParams.set('per_page', String(perPage));
    pageUrl.searchParams.set('page', String(page));

    const res = await fetch(pageUrl, { headers: authHeaders(token) });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitHub API error ${res.status} for ${pageUrl}: ${body}`);
    }

    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;

    let stoppedEarly = false;
    for (const item of data) {
      if (stopWhen && stopWhen(item)) {
        stoppedEarly = true;
        break;
      }
      results.push(item);
    }

    if (stoppedEarly) break;
    if (data.length < perPage) break;
    page++;
  }

  return results;
}

/**
 * Fetch all pull requests (state=all) for a repo, skipping any PRs
 * opened more than one year ago. Relies on sort=created&direction=desc
 * so we can safely stop paginating once we cross the cutoff.
 */
async function fetchAllPullRequests(owner, repo, token) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls?state=all&sort=created&direction=desc`;

  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

  return fetchAllPages(url, token, {
    stopWhen: (pr) => new Date(pr.created_at) < oneYearAgo,
  });
}

/**
 * Fetch all collaborator logins for a repo.
 * Requires push access to the repo; falls back gracefully with a
 * warning if the token lacks permission.
 */
async function fetchCollaboratorLogins(owner, repo, token) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/collaborators`;
  try {
    const collaborators = await fetchAllPages(url, token);
    return new Set(collaborators.map((c) => c.login));
  } catch (err) {
    console.warn(
      `Warning: could not fetch collaborators (${err.message}). ` +
      `Proceeding as if there are no collaborators to exclude.`
    );
    return new Set();
  }
}

/**
 * Aggregate per-user PR stats from the list of PRs.
 * Returns Map<login, {
 *   open: number,
 *   closedTotal: number,
 *   merged: number,
 *   mostRecentCreatedAt: Date
 * }>
 */
function aggregateUserStats(pullRequests) {
  const stats = new Map();

  for (const pr of pullRequests) {
    const login = pr.user?.login;
    if (!login) continue;

    if (!stats.has(login)) {
      stats.set(login, {
        open: 0,
        closedTotal: 0,
        merged: 0,
        mostRecentCreatedAt: null,
      });
    }
    const s = stats.get(login);

    if (pr.state === 'open') {
      s.open += 1;
    } else if (pr.state === 'closed') {
      s.closedTotal += 1;
      if (pr.merged_at) {
        s.merged += 1;
      }
    }

    const createdAt = new Date(pr.created_at);
    if (!s.mostRecentCreatedAt || createdAt > s.mostRecentCreatedAt) {
      s.mostRecentCreatedAt = createdAt;
    }
  }

  return stats;
}

/**
 * Apply eligibility filters:
 *   - fewer than 5 currently open PRs
 *   - more than 2 merged PRs
 *   - merge rate (merged / closed) > 50%
 *   - not a collaborator
 *   - has opened at least one PR within the past 6 weeks
 */
function filterEligibleUsers(stats, collaboratorLogins, now = new Date()) {
  const SIX_WEEKS_MS = 6 * 7 * 24 * 60 * 60 * 1000;
  const cutoff = new Date(now.getTime() - SIX_WEEKS_MS);
  const eligible = [];

  for (const [login, s] of stats.entries()) {
    if (s.open >= 5) continue;
    if (s.merged <= 2) continue;
    if (collaboratorLogins.has(login)) continue;
    if (!s.mostRecentCreatedAt || s.mostRecentCreatedAt < cutoff) continue;

    const mergeRate = s.merged / s.closedTotal;
    if (mergeRate > 0.5) {
      eligible.push({
        login,
        openPRs: s.open,
        closedPRs: s.closedTotal,
        mergedPRs: s.merged,
        mergeRatePct: Number((mergeRate * 100).toFixed(2)),
        mostRecentPRCreatedAt: s.mostRecentCreatedAt.toISOString(),
      });
    }
  }

  eligible.sort((a, b) => b.mergeRatePct - a.mergeRatePct);
  return eligible;
}

/**
 * Core reusable entry point: given a repo (owner/repo) and a GitHub token,
 * returns the list of eligible external contributors matching all filters.
 *
 * @param {Object} params
 * @param {string} params.owner - Repo owner (user or org).
 * @param {string} params.repo - Repo name.
 * @param {string} params.token - GitHub token with repo read (and ideally push) access.
 * @param {Date} [params.now] - Override "now" for testing purposes.
 * @returns {Promise<Array<{
 *   login: string,
 *   openPRs: number,
 *   closedPRs: number,
 *   mergedPRs: number,
 *   mergeRatePct: number,
 *   mostRecentPRCreatedAt: string
 * }>>}
 */
async function findEligibleContributors({ owner, repo, token, now } = {}) {
  if (!owner || !repo) {
    throw new Error('findEligibleContributors requires both "owner" and "repo".');
  }
  if (!token) {
    throw new Error('findEligibleContributors requires a "token".');
  }

  const [pullRequests, collaboratorLogins] = await Promise.all([
    fetchAllPullRequests(owner, repo, token),
    fetchCollaboratorLogins(owner, repo, token),
  ]);

  const stats = aggregateUserStats(pullRequests);
  return filterEligibleUsers(stats, collaboratorLogins, now);
}

// ---- CLI entry point ----

function isRunAsCLI() {
  return import.meta.url === `file://${process.argv[1]}`;
}

async function runCLI() {
  const [, , owner, repo] = process.argv;
  if (!owner || !repo) {
    console.error('Usage: node find-eligible-contributors.js <owner> <repo>');
    process.exit(1);
  }
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('Error: set GITHUB_TOKEN environment variable with a valid GitHub token.');
    process.exit(1);
  }

  console.error(`Fetching pull requests and collaborators for ${owner}/${repo} in parallel...`);
  const eligibleUsers = await findEligibleContributors({ owner, repo, token });

  console.log(JSON.stringify(eligibleUsers, null, 2));
  console.error(`\n${eligibleUsers.length} user(s) match the criteria.`);
}

if (isRunAsCLI()) {
  runCLI().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

export { findEligibleContributors };
