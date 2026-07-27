# Back-to-youtube-home-6-columns

This userscript designed to optimize the YouTube homepage experience. It forces the video list into a fixed 6-column layout, automatically hides the Shorts shelf, and removes various distracting category shelves (such as "Breaking news"), restoring the classic YouTube experience.

Fixed 6-Column Layout: Overrides YouTube's default responsive scaling to maintain exactly 6 videos per row regardless of screen size (this can be customized via the COLS variable at the top of the script).

Uniform Card Size: Eliminates YouTube's occasional oversized "emphasized cards" for a tidier layout.

Hide Shorts Module: Automatically removes the Shorts recommendation shelves from the homepage.

Remove Distracting Shelves: Automatically hides inserted category shelves such as "Recommended by topic" and "Breaking news". This works by hiding every inserted shelf block, so sections like "Continue watching" are hidden as well.

Dynamic SPA Adaptation: Fully compatible with YouTube's Single Page Application (SPA) mechanics; newly loaded content upon scrolling will automatically inherit these rules.

Exact Publish Dates: Replaces relative timestamps such as "2 years ago" with the video's exact publish date in `YYYY-MM-DD` format; hovering still shows the original relative time. Dates come from YouTube's own `/youtubei/v1/player` endpoint (a small JSON response, not a multi-megabyte watch page), are only requested for cards near the viewport, and are cached in `localStorage` — publish dates never change, so each video is fetched at most once. Live streams, premieres, and Mix/playlist cards are left untouched. If the lookup fails the card simply keeps its relative time.
