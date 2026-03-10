# Study Assist

Study Assist is a Chromium browser extension that uses AI (Claude + DeepSeek) to detect and analyze quiz questions on learning platforms.

## Supported Platforms

- **NetAcad (Cisco Networking Academy)** — Deep Shadow DOM detection, including MCQ and matching (drag-and-drop style and dropdown-style matching views)
- **Moodle** — Multichoice, true/false, matching, short answer, numerical, and select missing words detection, with automatic course context extraction

## TODO — Moodle question types not yet implemented

The following Moodle question types are recognised by the platform but not yet detected by Study Assist:

- **Essay** — Free-text essay with no selectable options; requires open-ended evaluation
- **Calculated** — Numeric questions with randomised variable substitution
- **Calculated Multichoice** — Multichoice variant with calculated/randomised values
- **Calculated Simple** — Simplified version of Calculated
- **Drag and Drop into Text** — Words/phrases dragged into gaps in a paragraph
- **Embedded Answers (Cloze)** — Mixed-format question with inline sub-questions (MCQ, short-answer, numeric) embedded in the question body
- **Random Short-Answer Matching** — Matching table built from randomly selected short-answer question pool
- **Ordering** — Drag items into the correct sequential order

## Current Features

- **Hybrid AI pipeline** — DeepSeek Reasoner first, Claude fallback/validation when needed
- **Question bank lookup** — Local NetAcad-style question bank for instant matches
- **Quick mode** — Trigger analysis with `SHIFT` and show compact answer directly on the SA button
- **Detailed mode** — Overlay-based full explanation flow
- **Response modes** — `guided`, `direct`, `hints`, and `explanation`
- **Image-aware analysis** — Sends image context when enabled (public URL preferred over base64)
- **Dashboard** — Usage metrics, latency/cost trends, history, and last-response inspector
- **Manual QA scenarios** — Inject test scenarios from dashboard without opening a real quiz
- **Disguise mode** — Optional uBlock-like visual disguise
- **i18n support** — Locales available in English and Spanish
- **Domain allowlist** — Extension logic only runs on user-allowed domains

## Installation

### 1) Clone and build

```bash
git clone <repo-url>
cd study-assist-extension
npm install
npm run build
```

### 2) Load unpacked extension

1. Open `chrome://extensions/` (or `edge://extensions/` / `brave://extensions/`)
2. Enable **Developer mode**
3. Click **Load unpacked** and select the project root folder

### 3) Configure

1. Open the extension popup
2. Add your **Claude API key** (Anthropic)
3. (Optional) Add your **DeepSeek API key**
4. Add allowed domains (for example: `netacad.com`, your Moodle domain)
5. Enable extension toggle

## Keyboard Shortcuts

| Shortcut     | Action                                      |
| ------------ | ------------------------------------------- |
| `SHIFT`      | Analyze visible question (quick mode)       |
| `CTRL+SHIFT` | Skip DeepSeek and force Claude              |
| `ALT+W`      | Re-detect current question                  |
| `ALT+Q`      | Toggle SA button visibility                 |
| `ALT+X`      | Cancel in-flight request                    |
| Hold `CTRL`  | Temporarily hide/show Webex floating button |

## Manual QA (Dashboard)

The dashboard includes a **QA Manual** section to inject test scenarios into `https://example.com`:

**Moodle**

- Moodle MCQ — standard multiple-choice question
- Moodle True/False — boolean question
- Moodle Matching — dropdown-style matching pairs
- Moodle Short Answer — free-text response question
- Moodle Numerical — numeric answer question
- Moodle Gap Select — select missing words (gap-fill)
- Moodle Quiz — combined multi-question page

**NetAcad**

- NetAcad MCQ — standard multiple-choice question
- NetAcad Matching — drag-and-drop / dropdown matching
- NetAcad Quiz — combined multi-question page

This is useful to validate detection, quick mode, and UI behavior without requiring a live assessment page.

## Project Structure

```text
study-assist-extension/
├── manifest.json
├── src/
│   ├── background/
│   │   ├── background.ts
│   │   └── modules/
│   ├── content/
│   │   ├── content.ts
│   │   └── modules/
│   └── types/
├── popup/
├── background/      # built JS
├── content/         # built JS
├── data/
├── tests/
└── scripts/
```

## Development

```bash
npm install
npm run build
npm run watch
npm test
npm run test:smoke
npm run test:watch
npm run package
npm run package:zip
```

### Test Commands

- `npm test` — full Vitest suite
- `npm run test:smoke` — fast critical subset (`netacad`, `moodle`, `parsing`)

## Notes on Consistency

This README is aligned with the current codebase state:

- Matching detection includes fallback behavior when question numbers are missing
- Navigation tests cover `MCQ -> matching -> MCQ` flows (including dropdown matching)
- Smoke test script is available in `package.json`

## Privacy

Data is stored locally in browser storage. The extension only sends question context to Anthropic/DeepSeek APIs using user-provided keys, when analysis is explicitly triggered. No external telemetry server is used.
