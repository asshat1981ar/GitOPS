import { readFile } from 'node:fs/promises';
import { GitHub, loadReleaseRevision, loadReview } from './github.ts';
import { verifyGitHubArtifact } from './artifact-provenance.ts';
import { loadPullReviewDecisions } from './pull-review-decisions.ts';
import { attachReleaseArtifact, collectReleasePacket, recheckReleasePacket, verifyRecordedReleaseArtifact, verifyReleasePacket } from './release-packet.ts';

const [command, first, ...remaining] = process.argv.slice(2);

try {
  if (command === 'collect' && first) {
    const client = new GitHub();
    const result = await collectReleasePacket(first, remaining, {
      review: (repository, number) => loadReview(client, repository, number),
      recheck: (repository, number) => loadReleaseRevision(client, repository, number),
      reviewDecisions: (repository, number, sha) => loadPullReviewDecisions(client, repository, number, sha),
    });
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'recheck' && first && remaining.length <= 1) {
    const client = new GitHub();
    const value: unknown = JSON.parse(await readFile(first, 'utf8'));
    const report = await recheckReleasePacket(value, remaining[0],
      (repository, number) => loadReleaseRevision(client, repository, number));
    console.log(JSON.stringify(report, null, 2));
    if (report.entries.some(entry => entry.recheck.state !== 'unchanged' || entry.branchPolicy.state !== 'unchanged')) process.exitCode = 2;
  } else if ((command === 'attach-artifact' || command === 'verify-artifact') && first && remaining.length >= 2) {
    const [artifact, repository, ...flags] = remaining;
    const options = new Map<string, string>();
    for (let index = 0; index < flags.length; index += 2) {
      const [flag, argument] = flags.slice(index, index + 2);
      if ((flag !== '--bundle' && flag !== '--expected-digest') || !argument ||
          argument.startsWith('--') || options.has(flag)) {
        throw new Error('Artifact options are --bundle PATH and --expected-digest SHA256.');
      }
      options.set(flag, argument);
    }
    const expected = options.get('--expected-digest');
    if (expected && !/^[0-9a-f]{64}$/.test(expected)) throw new Error('Expected digest must be a 64-character SHA-256 value.');
    const value: unknown = JSON.parse(await readFile(first, 'utf8'));
    const run = command === 'attach-artifact' ? attachReleaseArtifact : verifyRecordedReleaseArtifact;
    const result = await run(value, repository, expected,
      scope => verifyGitHubArtifact(artifact, scope, options.get('--bundle')));
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'verify' && first && remaining.length <= 1) {
    const value: unknown = JSON.parse(await readFile(first, 'utf8'));
    if (!verifyReleasePacket(value, remaining[0])) throw new Error('Packet digest or version check failed.');
    console.log(remaining.length ? 'Packet contents match the expected digest.' : 'Packet contents match the embedded digest.');
  } else {
    throw new Error('Usage: node server/release-cli.ts collect NAME GITHUB_PR_URL GITHUB_PR_URL [...] | verify FILE [EXPECTED_SHA256] | recheck FILE [EXPECTED_SHA256] | attach-artifact FILE ARTIFACT OWNER/REPO [--bundle PATH] [--expected-digest SHA256] | verify-artifact FILE ARTIFACT OWNER/REPO [--bundle PATH] [--expected-digest SHA256]');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Release packet operation failed.');
  process.exitCode = 1;
}
