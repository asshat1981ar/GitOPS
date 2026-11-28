"""Collect, hand off, and independently recheck a live release packet in Chromium."""

import argparse
from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path

from playwright.sync_api import sync_playwright


def upload(packet, page):
    content = json.dumps(packet["packet"], ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    packet["digest"] = sha256(content.encode()).hexdigest()
    page.get_by_label("Release packet JSON").set_input_files({
        "name": "review-history-fixture.json",
        "mimeType": "application/json",
        "buffer": json.dumps(packet).encode(),
    })
    page.get_by_label("Expected SHA-256", exact=False).fill(packet["digest"])
    page.get_by_role("button", name="Recheck against GitHub").click()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:4173/")
    parser.add_argument("--chromium")
    parser.add_argument("--screenshots", type=Path)
    parser.add_argument("--artifact-packet", type=Path)
    args = parser.parse_args()

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=args.chromium)
        lead = browser.new_page(viewport={"width": 1487, "height": 1058}, accept_downloads=True)
        errors = []
        lead.on("pageerror", lambda error: errors.append(str(error)))
        lead.goto(args.url)
        lead.get_by_role("button", name="Release review", exact=True).click()
        lead.get_by_role("heading", name="Release review", exact=True).wait_for()
        lead.get_by_role("button", name="Add PR").click()
        assert lead.get_by_label("GitHub PR URL 3").is_visible()
        lead.get_by_role("button", name="Remove PR URL 3").click()
        assert lead.get_by_label("GitHub PR URL 3").count() == 0
        lead.get_by_role("button", name="Use pilot PRs").click()
        lead.get_by_role("button", name="Collect evidence").click()
        lead.get_by_role("heading", name="AutoDev and GitHubOpsGem pilot").wait_for(timeout=35_000)
        assert lead.get_by_text("Unchanged during capture", exact=True).count() == 2
        assert lead.get_by_text("Artifact provenance uncollected.", exact=True).is_visible()
        lead_repo = lead.locator(".release-repository").first
        lead_repo.locator("summary").click()
        assert lead_repo.get_by_text("No Gem-Gate trailer found.", exact=True).is_visible()
        lead_repo.get_by_role("heading", name="GitHub PR review history", exact=True).wait_for(timeout=5_000)
        assert lead.get_by_text("Release approval authority uncollected.", exact=True).is_visible()
        with lead.expect_download() as pending:
            lead.get_by_role("button", name="Download packet").click()
        download = pending.value.path()
        packet = json.loads(download.read_text(encoding="utf-8"))
        assert len(packet["packet"]["entries"]) == 2
        assert all(entry["snapshot"]["reviewDecisions"]["state"] == "observed" for entry in packet["packet"]["entries"])
        first_history = packet["packet"]["entries"][0]["snapshot"]["reviewDecisions"]
        if not first_history["decisions"]:
            assert lead_repo.get_by_text("No submitted decisions for the recorded commit.", exact=True).is_visible()

        reviewer = browser.new_page(viewport={"width": 390, "height": 844})
        reviewer.on("pageerror", lambda error: errors.append(str(error)))
        reviewer.goto(args.url)
        reviewer.get_by_role("button", name="Release review", exact=True).click()
        reviewer.get_by_label("Release packet JSON").set_input_files(download)
        reviewer.get_by_label("Expected SHA-256", exact=False).fill(packet["digest"])
        reviewer.get_by_role("button", name="Recheck against GitHub").click()
        reviewer.get_by_text("PR revisions and checks matched for 2 of 2 repositories.").wait_for(timeout=35_000)
        assert reviewer.get_by_text("Checks match packet", exact=True).count() == 2
        reviewer_repo = reviewer.locator(".release-repository").first
        reviewer_repo.locator("summary").click()
        if not first_history["decisions"]:
            assert reviewer_repo.get_by_text("No submitted decisions for the recorded commit.", exact=True).is_visible()
        else:
            assert reviewer_repo.locator("section li").count() == len(first_history["decisions"])
        assert reviewer.evaluate("document.documentElement.scrollWidth === innerWidth")
        if args.screenshots:
            lead.screenshot(path=args.screenshots / "release-review-desktop.png", full_page=True)
            reviewer.screenshot(path=args.screenshots / "release-review-mobile.png", full_page=True)
        reports = [
            {"recheck": {"state": "unchanged", "detail": None},
             "branchPolicy": {"state": "changed", "detail": "Required-check policy differs from the saved snapshot.",
                              "added": [{"name": "Integration", "appId": 10}], "removed": [],
                              "upToDate": {"recorded": False, "current": True}}},
            {"recheck": {"state": "unchanged", "detail": None},
             "branchPolicy": {"state": "unavailable", "detail": "Current required-check policy is unavailable."}},
        ]
        reviewer.route("**/api/release/recheck", lambda route: route.fulfill(json={"entries": reports}))
        reviewer.get_by_role("button", name="Recheck against GitHub").click()
        reviewer.get_by_text("Policy changed", exact=True).wait_for()
        reviewer.get_by_text("Policy unavailable", exact=True).wait_for()
        reviewer.locator(".release-repository").first.locator("summary").click()
        assert reviewer.get_by_text("Added required check · Integration · GitHub App 10", exact=True).is_visible()
        assert reviewer.get_by_text("Base branch must now be up to date.", exact=True).is_visible()
        reviewer.unroute("**/api/release/recheck")

        # Exercise decision, unavailable, empty, and legacy packet states with
        # controlled observations and the real import API.
        fixture = deepcopy(packet)
        entries = fixture["packet"]["entries"]
        entries[0]["snapshot"]["reviewDecisions"]["decisions"] = [
            {"id": 42, "login": "reviewer[bot]", "state": "APPROVED", "submittedAt": "2026-11-22T22:00:00Z"},
            {"id": 43, "login": None, "state": "DISMISSED", "submittedAt": "2026-11-22T22:00:00Z"},
        ]
        entries[1]["snapshot"]["reviewDecisions"] = {"state": "unavailable"}
        upload(fixture, reviewer)
        reviewer.get_by_text("PR revisions and checks matched for 2 of 2 repositories.").wait_for(timeout=35_000)
        for row in reviewer.locator(".release-repository > summary").all():
            row.click()
        assert reviewer.get_by_role("link", name="Approved · reviewer[bot]").get_attribute("href").endswith("/pull/53#pullrequestreview-42")
        assert reviewer.get_by_role("link", name="Dismissed · Unknown reviewer").is_visible()
        assert reviewer_repo.get_by_text("Live review decisions differ from the packet.", exact=True).is_visible()
        assert reviewer.get_by_text("Review decision comparison unavailable.", exact=True).is_visible()
        assert reviewer.get_by_text("GitHub PR review history was unavailable during collection.", exact=True).is_visible()
        assert reviewer.evaluate("document.documentElement.scrollWidth === innerWidth")
        entries[0]["snapshot"]["reviewDecisions"]["decisions"] = []
        del entries[1]["snapshot"]["reviewDecisions"]
        upload(fixture, reviewer)
        reviewer.get_by_text("PR revisions and checks matched for 2 of 2 repositories.").wait_for(timeout=35_000)
        for row in reviewer.locator(".release-repository > summary").all():
            row.click()
        assert reviewer.get_by_text("No submitted decisions for the recorded commit.", exact=True).is_visible()
        assert reviewer.get_by_text("This packet did not collect GitHub PR review history.", exact=True).is_visible()
        assert reviewer.get_by_text("Review decisions were skipped for this older packet.", exact=True).is_visible()

        reviewer.get_by_label("Expected SHA-256", exact=False).fill("0" * 64)
        reviewer.get_by_role("button", name="Recheck against GitHub").click()
        reviewer.get_by_text("Packet digest or version check failed.").wait_for()
        assert not reviewer.get_by_role("button", name="Download packet").is_visible()
        if args.artifact_packet:
            # The optional demo packet has genuine artifact proof and local PR fixtures.
            # Keep the display check separate from the live recheck of the two pilots.
            demo = json.loads(args.artifact_packet.read_text(encoding="utf-8"))
            artifacts = demo["packet"]["artifacts"]
            entries = [{"recheck": {"state": "unavailable", "detail": "Local PR fixture."}}
                       for _ in demo["packet"]["entries"]]
            reviewer.route("**/api/release/recheck", lambda route: route.fulfill(json={"entries": entries}))
            reviewer.get_by_label("Release packet JSON").set_input_files(args.artifact_packet)
            reviewer.get_by_label("Expected SHA-256", exact=False).fill(demo["digest"])
            reviewer.get_by_role("button", name="Recheck against GitHub").click()
            reviewer.get_by_role("heading", name="Artifact provenance in packet").wait_for()
            assert reviewer.get_by_text(artifacts[0]["sha256"], exact=True).is_visible()
            assert reviewer.get_by_text("Verify the artifact bytes and issuer with the CLI.", exact=True).is_visible()
            reviewer.unroute("**/api/release/recheck")
        reviewer.get_by_role("button", name="PR inbox", exact=True).click()
        reviewer.get_by_role("heading", name="Current GitHub checks").wait_for(timeout=35_000)
        assert not errors, errors
        print("PASS release packet capture, download, import, live recheck, review-history states, digest rejection, and mobile layout")


if __name__ == "__main__":
    main()
