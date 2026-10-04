### New Features

- Dedicated manual QA page — Moodle and NetAcad scenarios now run inside the extension, with their own responsive layout and styles. Open or reuse the page from the dashboard.

### Added

- Added accessible answer selection to simulated Moodle and NetAcad multiple-choice questions. Each question has an independent selection, supports keyboard navigation, and retains its selection while navigating a quiz. Reloading or reopening a scenario resets selections; answers are not graded.

### Changed

- Replaced the dashed blue QA border with a white card, subtle outline, rounded corners, and light shadow.
- Simplified QA headings and scenario labels, and hid Quick-mode shortcut hints in detailed/streaming mode.
- Disabled development logging in release builds and reset previously enabled debug settings on worker startup.

### Fixed

- Fixed slow provider responses interrupting Quick and streaming analyses and showing `!`, as observed with NVIDIA NIM. The worker stays active only while analysis is pending; completion, failure, or cancellation releases that activity.
- Fixed QA requests failing with `Unsupported page URL` after a worker restart. QA registration is refreshed before analysis, while access remains restricted to the exact QA page and its registered tab.
- Fixed new Moodle QA history records appearing as platform `moodle`. Both Moodle and NetAcad QA requests now display the **QA** badge in the dashboard; existing history labels remain unchanged.

### Removed

- Removed example.com as the host for manual QA.
- Removed the local log-server host permission from the release manifest.
