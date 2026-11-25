# GitOPS Review Inbox design QA

Mockup 3 and the running AutoDev PR #53 view were compared side by side at
1487 × 1058. The 390 × 844 layout was checked for horizontal page overflow.

The first desktop comparison showed the selected PR outside the visible queue
and the primary export action below the fold. The revised queue pins the
selected PR, and secondary unchecked items and checks use compact disclosures.
The revised capture shows both the active row and export action in the initial
viewport. Live repository data accounts for the longer check labels and larger
queue. The receipt verifier appears below the main workflow.

Chromium exercised repository selection, PR URL entry, refresh, workflow and
rerun disclosures, Markdown export, and valid and tampered receipt uploads.
No browser console errors occurred in that run.

Cloud preview access was blocked by the browser relay's upstream address
restriction. The rendered comparison and interaction checks used local Chromium.

final result: passed

## Release Review

Release Review extends the selected Inbox layout with its graphite panels,
aqua controls, and repository disclosures. I compared the desktop and mobile
captures after collection and recheck. The mobile view stacks the forms and
results without horizontal page overflow. Repository disclosures identify
unchecked PR items as author checklist entries and show observation and
recheck times.

The packaged build passed a browser handoff between two independent contexts.
The lead downloaded a live packet and the reviewer imported it with the
expected digest, rechecked both pilots, and rejected an incorrect digest.
A separate display check imported the demo provenance packet using local
PR fixtures. Its browser label identifies packet-supplied evidence and
directs the reviewer to the CLI for fresh artifact verification.

Release Review result: passed

## GitHub PR review history

On November 23, 2026, I ran the release packet handoff in Chromium
156.0.8078.79 against the npm archive extracted locally and
served by Node 24.22.1. I inspected the 1487 px desktop and 390 px mobile
captures. The new heading sits inside the existing repository disclosure,
after its open items. It shows an observation time separate from the live
recheck time. The full recorded SHA wraps on mobile without page overflow.

The public pilot PRs returned successful empty history. AutoDev #53 had five
comment reviews, including one against the recorded head. The collector
excluded all five. Controlled browser imports exercised approval and dismissal
links, an unavailable response, and a legacy packet with no history field.
The real import endpoint rechecked the recorded PR revisions and checks for
those packets. Review history retained its capture-time label after recheck.

The packaged CLI independently captured a live approval on
[Vite PR #24178](https://github.com/vitejs/vite/pull/24178#pullrequestreview-6010605722)
for `abc55c635c6cb680b99c6d0014027ae8c488d2ca`. Its companion entry, GitHubOpsGem
#11 at `6773f856e8a596f420b236a238855f2093f1bb4b`, returned empty history. The
packaged CLI also verified the prior live v1 packet against its original digest.
