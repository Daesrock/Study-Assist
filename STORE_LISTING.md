# Microsoft Edge Add-ons — Store Listing

## Extension Name

**Study Assist — AI Study Companion**

## Category

**Productivity**

---

## Short Description (132 characters max)

AI study companion that helps you understand questions by providing explanations, guided reasoning, and learning hints on any webpage.

## Full Description

Study Assist is a browser extension that uses AI to help you learn more effectively. When you encounter a question you're struggling with on a webpage, Study Assist provides clear explanations, step-by-step reasoning, and contextual hints — so you build genuine understanding, not just memorize answers.

### How It Works

1. **Add the domains** where you study to the extension's allowed list.
2. **Navigate to a page** containing study material or questions.
3. **Activate the extension** to have AI analyze visible content and break it down for you.
4. **Choose your learning style** — guided reasoning, direct explanations, or hints only.

### Features

- **AI-Powered Explanations** — Uses Claude (Anthropic) and DeepSeek APIs to deliver thoughtful, educational responses tailored to the content you're reading.
- **Three Learning Modes** — Guided Learning (step-by-step reasoning), Direct Explanation (clear and concise), and Hints Only (nudges you toward the answer without revealing it).
- **User-Controlled Activation** — The extension only works on domains you explicitly allow, and only analyzes content when you activate it. No background scanning or tracking.
- **Domain Allowlist** — You decide which websites the extension operates on. Nothing is pre-configured.
- **Quick Mode** — A streamlined interface for fast analysis with a single keypress.
- **Usage Dashboard** — Track your API usage, costs, and session statistics locally.
- **Multi-Language Support** — English and Spanish interfaces included.
- **Privacy Focused** — All data stays on your device. API keys are stored locally. No telemetry, no analytics, no remote servers.
- **Bring Your Own Keys** — You provide your own API keys from Anthropic and/or DeepSeek. The extension never stores or shares credentials externally.

### Requirements

- An API key from [Anthropic (Claude)](https://console.anthropic.com) and/or [DeepSeek](https://platform.deepseek.com).
- API usage costs are determined by your provider. Typical per-question cost is less than $0.01.

### Designed for Learners

Study Assist is built for students who want to deepen their understanding of material — not bypass it. Use it as a study companion, a concept explainer, or a self-check tool that helps you reason through challenging content.

---

## Features List (Bullet Format for Store)

- AI-powered explanations using Claude and DeepSeek
- Three learning modes: Guided, Direct, Hints
- Domain allowlist — you control where it runs
- User-activated only — no background activity
- Quick mode for fast single-keypress analysis
- Local usage dashboard with cost tracking
- English and Spanish language support
- Privacy-first: all data stored locally, no telemetry
- Bring your own API keys — no subscriptions

---

## Privacy Summary

Study Assist does not collect, store, or transmit personal data. All settings and API keys remain on your device. The extension only communicates with AI API endpoints (Anthropic, DeepSeek) when you explicitly activate analysis, using your own API keys. No telemetry, analytics, or background network activity.

Full privacy policy: [Link to hosted PRIVACY.md]

---

## Permission Justifications

| Permission                            | Justification                                                                                                                                                                                                                                                                                |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                             | Stores your API keys, settings, and usage statistics locally on your device. No data is synced or transmitted.                                                                                                                                                                               |
| `activeTab`                           | Reads visible page content on the active tab only when you activate the extension. Required to extract text for AI analysis.                                                                                                                                                                 |
| `tabs`                                | Detects page navigation to re-initialize the extension when you navigate to a new page on an allowed domain.                                                                                                                                                                                 |
| `scripting`                           | Injects the content script that detects and highlights questions on allowed domains.                                                                                                                                                                                                         |
| `host_permissions: api.anthropic.com` | Sends analysis requests to the Anthropic Claude API using your own API key.                                                                                                                                                                                                                  |
| `host_permissions: api.deepseek.com`  | Sends analysis requests to the DeepSeek API using your own API key.                                                                                                                                                                                                                          |
| `content_scripts: <all_urls>`         | The content script checks the current domain against your personal allowlist. If the domain is not allowed, the script exits immediately without reading or modifying the page. This broad match is necessary because the allowlist is user-defined and cannot be predicted at install time. |

---

## Single Purpose Description (250 characters max)

Provides AI-powered study explanations for questions on user-allowed web pages using Claude and DeepSeek APIs with user-provided keys.

---

## Store Details

| Field                  | Value                              |
| ---------------------- | ---------------------------------- |
| **Pricing**            | Free                               |
| **Category**           | Productivity                       |
| **Age Rating**         | 13+                                |
| **Website**            | [Your GitHub Pages or website URL] |
| **Support**            | [GitHub Issues URL]                |
| **Privacy Policy URL** | [Publicly hosted PRIVACY.md URL]   |
| **Visibility**         | Public                             |
| **Markets**            | All                                |

---

## Tags / Keywords

study, learning, AI, education, assistant, explanations, companion, reasoning, quiz help

---

## Required Assets

### Screenshots (1280x800 or 640x400) — 3 to 5 required

1. Extension popup showing settings and domain list
2. Question detection and analysis overlay on a webpage
3. Usage dashboard with statistics
4. Learning mode selection

### Promotional Images (Optional)

- Small tile: 440x280
- Large tile: 1400x560
