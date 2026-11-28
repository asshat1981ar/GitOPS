# GitOPS Review Inbox implementation

Build mockup 3 as a local, read-only pull request workspace. GitHub supplies PRs,
commit checks, statuses, and metadata for linked Actions runs. A fixed GitHub API
origin and server-side optional token keep credentials out of the browser.

1. Add failing tests for URL validation, commit-scoped observations, rerun history,
   manual follow-ups, and Markdown export.
2. Implement the GitHub adapter and derive the evidence snapshot. Keep source
   failures distinct from empty successful responses. Recheck the PR head before
   returning the snapshot.
3. Implement the dark inbox, repository and PR selection, source disclosure,
   refresh, and export. Label gate receipts as unverified when verification is
   unavailable.
4. Run type checking, the production build, automated tests and a browser smoke
   test against the live pilot repositories. Compare the running app with mockup 3
   and document how to start and use it.
