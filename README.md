# Study Assist

Study Assist is a Chromium (Manifest V3) browser extension that uses AI to detect and analyze quiz questions on learning platforms. Providers are pluggable — **Anthropic, DeepSeek and OpenAI** — assigned to a `primary` and optional `validator` role, with models detected live from each provider's API.

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

- **Pluggable providers** — built-ins: Anthropic, DeepSeek and OpenAI
- **Custom providers & templates** — add any OpenAI-compatible, Anthropic-compatible or OpenAI Responses endpoint (base URL + key); ready-made templates for OpenRouter, Groq, Mistral, xAI, Command Code GOAT and OpenCode Go (multi-endpoint). The host permission is requested on demand
- **Live model lists** — models are detected from each provider's `GET /models` (no hardcoded lists), with search/filter in the Providers page
- **Role-based pipeline** — a configurable `primary` provider/model answers first; an optional `validator` validates or acts as fallback
- **Question bank lookup** — Local NetAcad-style question bank for instant matches
- **Quick mode** — Trigger analysis with `SHIFT` and show compact answer directly on the SA button
- **Detailed mode (streaming)** — Overlay-based full explanation streamed over SSE for both Anthropic and OpenAI-compatible providers
- **Response modes** — `guided`, `direct`, `hints`, and `explanation`
- **Model pricing** — LiteLLM-driven per-request cost (input/output/cache read/write); unpriced models are recorded without a cost
- **Connection test** — Send a minimal request per provider to verify the key/model works
- **Image-aware analysis** — Sends image context when enabled (public URL preferred over base64)
- **Dashboard** — Usage metrics, latency/cost trends, history, and last-response inspector
- **Manual QA scenarios** — Inject test scenarios from the dashboard (quick or full/streaming mode)
- **Disguise mode** — Optional uBlock-like visual disguise
- **i18n support** — Locales available in English and Spanish
- **Domain allowlist** — Extension logic only runs on user-allowed domains
- **Dev logging** — Local log server writes background/content logs into the project

## Installation

### 1) Clone and build

```bash
git clone https://github.com/Daesrock/Study-Assist.git
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
2. Click **Configure providers** to open the Providers page
3. Add the API key for each provider you use (Anthropic, DeepSeek, OpenAI); the available models are detected automatically
4. Back in the popup, pick a **Primary** provider/model and an optional **Validator**
5. Add allowed domains (for example: `netacad.com`, your Moodle domain)
6. Enable the extension toggle

Each provider also has a **Test connection** button (sends a minimal request) and a **Detect models** button.

### Custom providers

Besides the three built-in providers you can add your own from the Providers page:

1. Click **Add provider** and pick a **template** (OpenRouter, Groq, Mistral, xAI, Command Code GOAT, OpenCode Go) or **Custom (blank)**
2. Adjust the **name**, **base URL** and **dialect** (OpenAI-compatible, Anthropic-compatible or OpenAI Responses)
3. Grant the requested **host permission** (needed to call that endpoint)
4. Paste the API key; models are detected from `GET /models`

Gateways that require extra headers (e.g. OpenCode Go's `x-opencode-session`) get them automatically or via the **Headers** field. Pick the **OpenAI Responses** dialect when an endpoint only speaks the Responses API.

## Keyboard Shortcuts

| Shortcut     | Action                                      |
| ------------ | ------------------------------------------- |
| `SHIFT`      | Analyze visible question (quick mode)       |
| `CTRL+SHIFT` | Analyze using the validator role            |
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

The QA card also has a **Modo full (streaming)** toggle: when enabled it opens the full overlay with the detected question(s), so a click runs the streaming path. This is useful to validate detection, quick/full modes, and UI behavior without requiring a live assessment page.

## Project Structure

```text
study-assist-extension/
├── manifest.json
├── src/
│   ├── background/
│   │   ├── background.ts
│   │   └── modules/          # pipeline, providers (llm/), usage, logging
│   ├── content/
│   │   ├── content.ts
│   │   └── modules/
│   └── types/
├── popup/                    # popup, providers page, dashboard (static)
├── background/               # built JS
├── content/                  # built JS
├── data/                     # question banks + LiteLLM price snapshot
├── logs/                     # dev logs (gitignored)
├── tests/
└── scripts/                  # build, packaging, scrapers, dev log server
```

## Development

```bash
npm install
npm run build
npm run watch
npm run dev:logs     # local log server -> logs/background.log + logs/content.log
npm test
npm run test:smoke
npm run test:watch
npm run update:prices
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

Data is stored locally in browser storage. The extension only sends question context to the configured AI providers (built-in and custom) using your own keys, when analysis is explicitly triggered. It also fetches LiteLLM's public model-price catalog to display model costs/capabilities; no user data is sent with that request. Custom providers require a host permission (requested when you add them). No external telemetry server is used.

## Security update (September 2026)

Requires Chrome/Chromium 102+; development and testing use Node.js 24+.
API keys remain saved until changed or deleted. They and custom header values
use AES-GCM with a random local wrapping key. This is not an OS-backed vault
and cannot protect a stolen complete browser profile. See [PRIVACY.md](PRIVACY.md).

Question/answer history content is now opt-in in the dashboard; token/cost
metrics remain available. On upgrade, old content and raw diagnostics are
removed while metrics and provider settings are preserved. Production builds
reject enabled development logging or HTTP development host permissions.
