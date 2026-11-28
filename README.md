# GitOPS Review Inbox

GitOPS gives maintainers one place to review the GitHub evidence associated with
a pull request head and export a Markdown handoff. The repository queue includes
AutoDev and GitHubOpsGem. Select **Open a PR by URL** for other repositories.

## Run locally

Requires Node.js 24 or newer and npm.

```sh
npm ci
npm run build
npm start
```

Open the printed address, `http://127.0.0.1:4173/` by default. Set
`GITOPS_PORT` to choose another port, or set it to `0` for an available port. The built server binds to loopback
and serves the frontend and GitOPS API from one origin. Its runtime uses
Node's standard library.

Use `npm run dev` when editing source files. Both entry points read GitHub
through their local API. Unauthenticated requests work with public repositories and use GitHub's
unauthenticated rate limit. To use an authorized account or raise that limit,
provide `GITOPS_GITHUB_TOKEN` in the server environment. Use a read-only token
with access to the repository and its PR, check, status, contents, and Actions
metadata. The browser never receives the token. In environments that route
HTTPS through an outbound proxy, set `NODE_USE_ENV_PROXY=1` with the host's
normal proxy settings before starting Node.

## Package a local release

From the source checkout, run:

```sh
npm ci
npm pack
```

The pack step builds the frontend and writes
`gitops-review-inbox-0.1.0.tgz` for the current version. The archive contains
the built frontend, Node server, shared review module, package metadata, and
font and icon license notices in `dist/licenses/`.
The checkout's environment files and development material stay local.

Extract the archive into a fresh directory and start it with Node.js 24 or newer:

```sh
tar -xzf gitops-review-inbox-0.1.0.tgz
cd package
node server/start.ts
```

The extracted runtime needs no package installation. Pass optional GitHub and
ForgeCore settings through the server process environment as described here.

## Review evidence

- **Needs attention** shows unchecked items from the PR's verification prose,
  references to runs on another commit, failed or missing required checks, and unavailable sources. A required check
  can show as missing only with complete evidence coverage. Checklist items are assertions from the PR author.
- **Current GitHub checks** groups check runs and commit statuses for the
  selected HEAD and preserves previous results inside each group. Same-repo
  Actions links in the PR description are resolved separately.
- GitOps reports readable GitHub branch check requirements. Private or
  inaccessible policy can be unavailable, and base-branch rules can differ
  from merge-queue or merge-result evaluation. GitHub decides merge eligibility.
- **Export handoff** downloads a snapshot with the complete commit SHA,
  observation time, intent, source links, check results, and open items. Before
  downloading, GitOPS rechecks the PR head, base branch, and a digest of the
  review context, including the title, description and PR state. The handoff records
  the revision-check time and context digest separately from the check-evidence observation time.
  Export also re-reads GitHub check runs and commit statuses. A rerun or
  changed result on the same commit requires a refresh. Temporary check-source
  failures allow retry. The handoff records the check digest and recheck time.
  The open inbox also checks on return to the tab and every two minutes while
  visible. A changed revision requires a refresh. A failed lookup pauses export
  and allows retry.

### Cross-repository release packets

Open **Release review** in the inbox to collect evidence from two to eight
repositories. Expand a repository to see its recorded commit and open items.
Download the JSON packet so another reviewer can upload it, optionally enter
an independently shared SHA-256, and run a fresh GitHub recheck. The browser
sends packet data only to the local GitOPS server.

The CLI also works in the checkout and the extracted release. Pick one HTTPS
GitHub PR URL in each of at least two repositories:

```sh
node server/release-cli.ts collect "Review pilot" \
  https://github.com/asshat1981ar/AutoDev/pull/53 \
  https://github.com/asshat1981ar/GitHubOpsGem/pull/11 > release-packet.json
node server/release-cli.ts verify release-packet.json
node server/release-cli.ts recheck release-packet.json
```

The version 1 JSON includes the capture window, full PR heads and source URLs,
and per-repository recheck results. An unchanged result means the PR revision
and current GitHub checks and statuses matched during capture. A stale or
unavailable entry can be present in a valid packet. Required-check policy has
its own capture and recheck results. PR checklist items, linked runs, and any
trailer ID are captured observations with their own coverage. The capture
window spans multiple network reads across repositories.

Expand a repository and look under **GitHub PR review history** to see
submitted GitHub decisions whose review commit matches the full recorded head.
The capture records approval, changes requested, and dismissal states, along
with the account when visible, the original submission time, and a link to
GitHub. A successful empty response, unavailable history, and older packets
without review history each have their own label. Review history shows what
GitHub returned during collection. GitHub determines current merge eligibility,
and release approval authority stays uncollected. Initial collection also
leaves artifact provenance uncollected.

Digest verification runs locally without GitHub. Include a SHA-256 digest from
a trusted independent channel as an optional third argument to `verify` if
available. The digest covers the packet, including its timestamps. It checks
content integrity against the selected digest. Issuer authenticity and current
upstream evidence require their own verification. Packets can contain titles,
intent, and check links from private PRs. Handle them with the same care as
the source data.

The online `recheck` command accepts an optional expected digest after the
filename. It validates the packet, all PR targets, and the recorded check
fingerprints before using GitHub. It returns a separate JSON report comparing
the recorded PR revisions, checks, required-check policy, and recorded review
decisions to current observations. The original packet stays intact. For the same base branch, the
policy comparison shows added or removed required checks, their GitHub App
scope, and changes to the up-to-date requirement when GitHub exposed it at
both observations. Legacy packets can still compare their recorded checks.
An unrecorded up-to-date requirement remains unavailable. Review recheck
compares submitted review IDs and decisions on the recorded head, including
dismissals. Only the saved rows are shown, alongside a separate comparison
state. A different head, unavailable review evidence, and an older packet
without review evidence each have their own state. Linked runs, receipts,
release approvals, and other branch rules have separate evidence.

Exit status `0` means PR revisions, checks, required-check policies, and any
recorded review decisions matched. A legacy packet can still exit successfully
when the comparisons it supports match. Status `2` means compared evidence
changed, was stale, or was unavailable. Status `1` means the command or input
failed validation.

### Attach and verify GitHub build provenance

Install a GitHub CLI version with `gh attestation verify` and its
`--source-digest` option on your PATH. GitOPS was tested with GitHub CLI 2.105.
Choose an artifact whose signed provenance names the exact repository and
PR head already in the packet:

```sh
node server/release-cli.ts attach-artifact release-packet.json ./build.tgz owner/repo \
  --bundle ./attestations.jsonl > release-with-artifact.json
node server/release-cli.ts verify-artifact release-with-artifact.json ./build.tgz owner/repo \
  --bundle ./attestations.jsonl
```

The bundle option uses a local attestation bundle. Omit it to let GitHub CLI
retrieve attestations with your GitHub access. Both commands accept
`--expected-digest SHA256` for the input packet. Attachment verifies the
artifact bytes, GitHub issuer, signer repository and recorded source commit.
It emits a new packet and digest. The independent command checks the bytes
and issuer against the recorded attachment. Current scope covers SLSA build
provenance with a SHA-256 subject signed by a workflow in the recorded
repository. Release builds signed from a different source commit need a
packet that records that revision.

The browser discloses packet-supplied provenance when a reviewer imports
the attached packet. Browser recheck compares the GitHub PR revisions and
checks. Use `verify-artifact` for a fresh verification of artifact bytes
and provenance.

### ForgeCore receipts

Set `GITOPS_FORGECORE_URL` and `GITOPS_FORGECORE_TOKEN` in the GitOPS server
environment to use an AutoDev server that implements
`POST /api/v1/gate/verify`. Use an HTTPS endpoint or HTTP on loopback. Restart
GitOPS after changing these values.

Expand **Verify a ForgeCore receipt** and select a signed receipt JSON file.
GitOPS checks the PR's current GitHub HEAD, its repository and branch, and the
Gem-Gate ID when the commit supplies one. The configured ForgeCore instance
checks the signature. The result records the signed decision, whether the
verifier recorded the receipt, and whether the commit trailer matched.
Malformed or conflicting Gem-Gate trailers are surfaced as unavailable and
block receipt verification for that head.
A gate receipt speaks to a repository and branch. A trailer match does not
bind the receipt to the commit contents or grant approval.

GitOPS performs read-only GitHub requests and forwards a receipt only when
the user submits it. The local server keeps both credentials in its process
environment.

## Verification

```sh
npm test
npm run verify:release
```

The release check uses `tar` to unpack a fresh archive into a temporary
directory. It starts the extracted server, checks the built HTML and
JavaScript, and exercises API validation. It uses loopback HTTP and needs
no GitHub or ForgeCore credentials. The **Verify GitOPS** pull-request
workflow runs the same commands after `npm ci`.

Live pilots were AutoDev PR #53 and GitHubOpsGem PR #11. The running app was
tested in Chromium on desktop and mobile, including repository changes,
a PR URL, an Actions run on a different commit, rerun history, and Markdown
download. For the receipt path, AutoDev PR #55 at `d22adc5` was built and run
as a loopback server using a throwaway signing key. GitHubOpsGem's upstream
end-to-end script passed, and GitOPS accepted a locally signed receipt and
rejected a copy with an altered decision. The test receipt matched the pilot's
repository and branch. It had no matching commit trailer, and no deployed
ForgeCore endpoint was configured for this test.

### Review freshness regression

Run the app at port 4173, then use Python with Playwright installed and a
Chromium browser available:

```sh
npm run dev -- --port 4173 --strictPort
# In another shell
python3 test/browser_freshness.py
```

Pass `--chromium` to use an existing Chromium executable. The smoke test reads
the pilot from GitHub and substitutes only the revision response to exercise
an outage, a head change, a same-head description edit, and changes or
unavailability in same-head check evidence without pushing to a repository.

### Latest verification evidence

| Pilot | GitHub head SHA | Observed checks and statuses | Gem-Gate trailer |
| --- | --- | ---: | --- |
| [AutoDev PR #53](https://github.com/asshat1981ar/AutoDev/pull/53) | `b1cb12bed1d60a728c53aa1c86b872a48d0b7749` | 19 | Absent |
| [GitHubOpsGem PR #11](https://github.com/asshat1981ar/GitHubOpsGem/pull/11) | `6773f856e8a596f420b236a238855f2093f1bb4b` | 2 | Absent |

The live AutoDev run linked by PR #53 reports SHA
`e89b0f2d3895c558967e27c30278de1c16fdf564`. It was displayed separately
from the current checks. The smoke test uses controlled revision responses
for the outage and head-change cases.

A separate local test started the real ForgeCore server built from AutoDev
PR #55, signed a receipt, and wrote its ID to the trailer of a disposable Git
commit (`48d8af32a0cb160771f3a586c23cdfc6eeeac1a6`). The GitHub adapter used
test responses derived from that commit. ForgeCore validated the receipt and
rejected an altered decision. GitOPS independently reported the trailer
match and repository/branch scope. Neither public pilot supplied a trailer
and receipt pair, and no deployed verifier was tested.
