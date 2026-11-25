import { repositoryPath, type GitHub } from './github.ts';

interface Decision {
  id: number;
  login: string | null;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'DISMISSED';
  submittedAt: string;
}

export type PullReviewDecisions =
  | { state: 'observed'; observedAt: string; decisions: Decision[] }
  | { state: 'unavailable' };

const shaPattern = /^[0-9a-f]{40}$/;
const dateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function loadPullReviewDecisions(
  client: GitHub, repository: string, number: number, sha: string,
): Promise<PullReviewDecisions> {
  const unavailable = { state: 'unavailable' } as const;
  if (!Number.isSafeInteger(number) || number < 1 || !shaPattern.test(sha)) return unavailable;
  try {
    const reviews = await client.pages<unknown>(`${repositoryPath(repository)}/pulls/${number}/reviews`);
    const decisions: Decision[] = [];
    const ids = new Set<number>();
    for (const review of reviews) {
      if (!record(review)) return unavailable;
      const { commit_id: commit, id, state, submitted_at: submittedAt, user } = review;
      if (state === 'COMMENTED' || state === 'PENDING' || commit === null) continue;
      if (typeof commit !== 'string' || !shaPattern.test(commit)) return unavailable;
      if (commit !== sha) continue;
      if (state !== 'APPROVED' && state !== 'CHANGES_REQUESTED' && state !== 'DISMISSED') return unavailable;
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || ids.has(id)) return unavailable;
      if (typeof submittedAt !== 'string' || !dateTimePattern.test(submittedAt)) return unavailable;
      const date = submittedAt.slice(0, 10);
      if (new Date(date).toISOString().slice(0, 10) !== date || submittedAt.slice(11, 13) === '24') return unavailable;
      const timestamp = new Date(submittedAt);
      if (!Number.isFinite(timestamp.getTime())) return unavailable;
      if (user !== null && !record(user)) return unavailable;
      const login = user === null ? null : user.login;
      if (login !== null && (typeof login !== 'string' || !login.trim())) return unavailable;
      decisions.push({ id, state, login, submittedAt: timestamp.toISOString() });
      ids.add(id);
    }
    return { state: 'observed', observedAt: new Date().toISOString(), decisions };
  } catch {
    return unavailable;
  }
}
