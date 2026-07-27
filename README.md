# Back-to-youtube-home-6-columns

This userscript designed to optimize the YouTube homepage experience. It forces the video list into a fixed 6-column layout, automatically hides the Shorts shelf, and removes various distracting category shelves (such as "Breaking news"), restoring the classic YouTube experience.

Fixed 6-Column Layout: Overrides YouTube's default responsive scaling to maintain exactly 6 videos per row regardless of screen size (this can be customized via the COLS variable at the top of the script).

Uniform Card Size: Eliminates YouTube's occasional oversized "emphasized cards" for a tidier layout.

Hide Shorts Module: Automatically removes the Shorts recommendation shelves from the homepage.

Remove Distracting Shelves: Automatically hides inserted category shelves such as "Recommended by topic" and "Breaking news". By default this hides every inserted `ytd-rich-section-renderer` block, which also removes sections like "Continue watching"; set `HIDE_ALL_SECTIONS` to `false` at the top of the script to fall back to hiding only the known shelf types.

Dynamic SPA Adaptation: Fully compatible with YouTube's Single Page Application (SPA) mechanics; newly loaded content upon scrolling will automatically inherit these rules.

Exact Publish Dates: Replaces relative timestamps such as "2 years ago" with the
video's exact publish date in `YYYY-MM-DD` format. Hovering the date still shows
the original relative time.

Dates are looked up through YouTube's own `/youtubei/v1/player` endpoint, which
returns a small JSON payload rather than a multi-megabyte watch page; the watch
page is only fetched as a fallback when that endpoint is unavailable. Lookups are
limited to cards near the viewport, capped at 3 concurrent requests, and cached in
`localStorage` — publish dates never change, so a video is fetched at most once
across tabs and sessions. Videos that genuinely have no publish date are recorded
too, so they are not retried on every scroll. Transient network failures are left
uncached, so those videos are requested again on a reload or in another tab.

Cards that are not ordinary videos — live streams, premieres, and Mix/playlist
cards — are detected by their metadata text and left untouched.
