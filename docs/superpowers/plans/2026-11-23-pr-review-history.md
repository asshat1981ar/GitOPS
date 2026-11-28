# Exact-head GitHub PR review history

GitOPS already captures PR revisions, checks, and required-check policy. A maintainer reviewing a packet also needs to see which GitHub review decisions were submitted against its recorded commit. GitHub's [List reviews](https://docs.github.com/en/rest/pulls/reviews?apiVersion=2022-11-28#list-reviews-for-a-pull-request) endpoint provides each review's state and commit ID. Read access to the PR is sufficient. Release approval authority and current merge eligibility require independent evidence.

Remote CI requires publication authority. Deployed ForgeCore requires a configured verifier and matching live receipt. Pilot artifacts require accessible signed attestations. Review history is immediately useful and can be verified with public GitHub reads and controlled cases.

| Owner | Scope and tool | Dependency and acceptance |
| --- | --- | --- |
| `review_source` | `server/pull-review-decisions.ts`, `test/pull-review-decisions.test.ts`. GitHub REST and native Node tests. | Verified pagination, exact SHA, empty and unavailable responses. Read-only GitHub access. |
| Lead | `server/release-packet.ts`, `server/api.ts`, `server/release-cli.ts`, `test/release-packet.test.ts`, `test/production.test.ts`. Context Prompt Engineer and Superpowers test-first workflow. | Integrated the source before the capture recheck, included the observation in the digest, validated imported rows, and preserved legacy packets and live recheck semantics. |
| Lead | `src/release.ts`, `test/browser_release_review.py`, `README.md`, `design-qa.md`. Product Design and Chromium. | Use the existing repository disclosures. Exercise decision, empty, unavailable, and legacy states across download and import. |
| `review_acceptance` | Read-only review of the adapter, packet, and browser changes. | Confirmed compatibility and authority wording, independently checked live sources and tests, and caught a skipped heading level that was corrected. |
| Lead | Build, `npm test`, clean-extraction smoke check, packaged CLI and Chromium on public pilots. | Confirm exact source SHAs and distinguish live results from fixtures. Publication and deployed-service changes require explicit authorization. |
