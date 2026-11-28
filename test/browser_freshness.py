"""Exercise the review and export flows with live PR data and controlled freshness responses."""

import argparse
from pathlib import Path
from urllib.parse import urlencode, urljoin

from playwright.sync_api import sync_playwright


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:4173/")
    parser.add_argument("--chromium", help="Optional path to a system Chromium executable.")
    args = parser.parse_args()

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=args.chromium)
        page = browser.new_page(accept_downloads=True)
        downloads = []
        page.on("download", lambda download: downloads.append(download.suggested_filename))
        page.goto(args.url, wait_until="domcontentloaded")
        page.get_by_role("heading", name="Current GitHub checks").wait_for(timeout=35_000)
        full_sha = page.locator("#meta code").get_attribute("title")
        export = page.get_by_role("button", name="Export handoff")

        revision = "**/api/revision?*"
        page.route(revision, lambda route: route.fulfill(
            status=503, json={"error": "GitHub unavailable for this test."}))
        export.click()
        page.get_by_text("Export paused.", exact=False).wait_for()
        assert page.locator("#revision-message").inner_text().startswith(
            "The current PR revision and check evidence could not be confirmed.")
        assert not downloads
        assert export.is_enabled()
        page.unroute(revision)

        other_sha = "b" * 40 if full_sha == "a" * 40 else "a" * 40
        page.route(revision, lambda route: route.fulfill(json={"sha": other_sha, "baseRef": "main"}))
        page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
        page.get_by_role("heading", name="GitHub checks from the saved snapshot").wait_for()
        assert "snapshot is stale" in page.locator("#revision-message").inner_text()
        assert export.is_disabled()
        assert not downloads
        page.unroute(revision)

        page.get_by_role("button", name="Refresh review").click()
        page.get_by_role("heading", name="Current GitHub checks").wait_for(timeout=35_000)
        refreshed_sha = page.locator("#meta code").get_attribute("title")
        assert export.is_enabled()

        page.route(revision, lambda route: route.fulfill(json={
            "sha": refreshed_sha, "baseRef": "main", "contextDigest": "f" * 64,
        }))
        export.click()
        page.get_by_text("The pull request details changed.", exact=False).wait_for()
        assert export.is_disabled()
        assert not downloads
        page.unroute(revision)
        page.get_by_role("button", name="Refresh review").click()
        page.get_by_role("heading", name="Current GitHub checks").wait_for(timeout=35_000)
        refreshed_sha = page.locator("#meta code").get_attribute("title")

        params = urlencode({"repository": "asshat1981ar/AutoDev", "number": 53, "evidence": "checks"})
        live = page.request.get(urljoin(args.url, "/api/revision?" + params)).json()
        assert live["sha"] == refreshed_sha and live["checksDigest"]
        partial = {**live, "checksDigest": None, "checkIssues": ["GitHub commit statuses unavailable."]}
        page.route(revision, lambda route: route.fulfill(json=partial))
        export.click()
        page.get_by_text("GitHub commit statuses unavailable.", exact=False).wait_for()
        assert export.is_enabled()
        assert not downloads
        page.unroute(revision)

        changed_digest = "b" * 64 if live["checksDigest"] == "a" * 64 else "a" * 64
        page.route(revision, lambda route: route.fulfill(json={**live, "checksDigest": changed_digest}))
        export.click()
        page.get_by_text("GitHub checks changed for this commit.", exact=False).wait_for()
        assert export.is_disabled()
        assert not downloads
        page.unroute(revision)
        page.get_by_role("button", name="Refresh review").click()
        page.get_by_role("heading", name="Current GitHub checks").wait_for(timeout=35_000)
        refreshed_sha = page.locator("#meta code").get_attribute("title")

        with page.expect_download() as pending:
            export.click()
        body = Path(pending.value.path()).read_text(encoding="utf-8")
        assert f"Observed head: `{refreshed_sha}`" in body
        assert "PR revision rechecked at:" in body
        assert "PR context digest:" in body
        assert "Current GitHub checks rechecked at:" in body
        assert "Current GitHub checks digest:" in body
        print("PASS revision changes, same-head check changes, source outages, refresh, and verified export")


if __name__ == "__main__":
    main()
