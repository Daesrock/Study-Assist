# Privacy Policy — Study Assist

**Effective Date:** February 7, 2026
**Last Updated:** September 19, 2026

---

## 1. Overview

Study Assist is a browser extension that provides AI-powered study explanations. This policy describes what data the extension accesses, how it is used, and your rights.

## 2. Data the Extension Accesses

### 2.1 Page Content (Transient, User-Activated Only)

When you explicitly activate the extension on an allowed domain, it reads visible text content (questions, answer options) from the current page. This content is:

- Sent to AI API endpoints for analysis (see Section 3)
- Retained locally in the usage history by default, limited to 200 characters of each question and 4,000 characters each of answers and reasoning, within the 500-record limit. For reasoning longer than 4,000 characters, only the final 4,000-character excerpt is stored and marked as truncated. You can disable this with "Guardar contenido del historial"; disabling it redacts retained content and prevents future content from being stored.
- Never transmitted to any party other than the AI APIs you configure

On allowlisted sites, automatic detection may read question text locally to highlight questions. Sending a question to an AI provider requires an analysis action. If image sending is enabled, relevant images are also sent; potentially signed/private image URLs are converted to image data when the browser permits it.

### 2.2 API Keys (Local Storage Only, Encrypted)

- Anthropic (Claude) API key — optional, provided by you
- DeepSeek API key — optional, provided by you
- OpenAI API key — optional, provided by you

Keys remain saved until you replace or delete them. They are encrypted with AES-GCM using a random 256-bit wrapping key, not the public extension ID. Existing valid encrypted keys are migrated automatically. Custom header values are encrypted too. Chrome local storage is restricted to trusted extension contexts; content scripts receive only selected preferences through messages.

The wrapping key is stored in the same browser profile so you do not need a password at startup. **This is not protection against theft of the complete browser profile, malware running as your user, or compromise of a trusted extension page.** It is not an OS-backed secret vault. API keys are sent to the configured provider for authentication. Remote providers require HTTPS; HTTP is allowed only for explicitly configured loopback services. Redirects and browser cookies are disabled for provider requests.

### 2.3 Usage Statistics (Local Storage Only)

- Request count, token usage, estimated cost, latency
- Stored locally in your browser
- Never transmitted externally
- Viewable and deletable from the extension dashboard. Content retention is opt-in; disabling it removes retained question/answer/reasoning text without removing accounting metrics.

### 2.4 User Settings (Local Storage Only)

- Response mode preference
- UI configuration (button position, display options)
- Domain allowlist (sites where the extension is permitted to operate)

## 3. Third-Party Services

Analysis communicates with the configured providers. Model detection, connection tests and price refreshes can also make network requests. Custom providers and gateways receive the same request content and authentication configured by the user; choose endpoints you trust. Providers may retain data under their own policies, which this extension cannot guarantee or override.

| Service                | Endpoint                    | Data Sent                                                | When                                                               |
| ---------------------- | --------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------ |
| **Anthropic (Claude)** | `https://api.anthropic.com` | Question text, answer options, your API key (via header) | Only when you activate analysis and have a Anthropic key configured |
| **DeepSeek**           | `https://api.deepseek.com`  | Question text, answer options, your API key (via header) | Only when you activate analysis and have a DeepSeek key configured |
| **OpenAI**             | `https://api.openai.com`    | Question text, answer options, your API key (via header) | Only when you activate analysis and have an OpenAI key configured  |
| **LiteLLM price catalog** | `https://raw.githubusercontent.com` | Nothing (plain GET request, no user data or keys) | Only when you manually refresh model prices, or automatically on a periodic cache miss |

These services have their own privacy policies:

- Anthropic: https://www.anthropic.com/privacy
- DeepSeek: https://www.deepseek.com/privacy
- OpenAI: https://openai.com/privacy

The LiteLLM catalog is fetched from a public GitHub repository to display model prices and vision capabilities. No question content, API key, or usage data is ever sent to it.

## 4. What the Extension Does NOT Do

- Does **not** collect personal information (name, email, identity)
- Does **not** track browsing history or behavior
- Does **not** use cookies, fingerprinting, or any tracking technology
- Does **not** send quiz content to providers without an analysis request. Metadata/catalog refreshes are separate from analysis.
- Does **not** harvest credentials, passwords, or form data
- Does **not** inject advertisements
- Does **not** sync data to any cloud service or remote server
- Does **not** share data with third parties beyond the AI APIs described above

## 5. Data Storage

All data is stored locally on your device using the Chrome Storage API:

- No Study Assist backend; requests go directly to configured providers
- No external databases
- No cloud synchronization
- No analytics or telemetry services

## 6. Data Retention and Deletion

Usage history is bounded to 500 records. Settings and keys persist until deleted. Diagnostics are off by default; persisted diagnostics contain only bounded status metadata, not raw request/response bodies, URLs or credentials. The development log server is disabled in release builds. Browser-console debugging, if explicitly enabled, may display provider responses: do not share console output without reviewing it.

The security upgrade removes previously retained page content and raw diagnostics, preserving accounting metrics and settings. This removal cannot be undone by the extension. Existing files written by a separately run development log server are outside browser storage and must be deleted manually if no longer needed.

To remove extension data:

1. Open the extension popup
2. Navigate to the Dashboard
3. Use "Clear All Usage Data" to remove statistics, retained content and diagnostics. Delete each provider key in Providers if you also want to remove credentials.
4. Uninstall the extension to remove all stored settings and API keys

Alternatively, clearing your browser's extension data will remove all Study Assist data.

## 7. Domain Allowlist

The extension includes a user-defined domain allowlist, empty by default. It checks the sending frame's actual URL in the background before analysis and reacts to allowlist changes in already-open tabs. Revocation cancels running requests but cannot retract data already sent. The dashboard's explicitly launched QA sandbox is a limited exception on example.com; a page cannot enable it merely by supplying a QA flag.

## 8. Permissions Explained

| Permission         | Purpose                                                          |
| ------------------ | ---------------------------------------------------------------- |
| `storage`          | Store settings and API keys locally                              |
| `activeTab`        | Access visible content on the current tab when activated         |
| `tabs`             | Detect navigation events to reinitialize on allowed pages        |
| `scripting`        | Inject content scripts for question detection on allowed domains |
| `host_permissions` | Send requests to the configured AI API endpoints and to the public LiteLLM price catalog (no user data)|

## 9. Children's Privacy

This extension is not directed at users under 13 years of age. It does not knowingly collect data from children.

## 10. Changes to This Policy

Changes will be reflected in the "Last Updated" date above. Continued use of the extension after changes constitutes acceptance.

## 11. Contact

For privacy inquiries, please open an issue on the project's GitHub repository.

---

**Summary:** Study Assist does not collect, store, or transmit personal data. Everything stays on your device. AI API endpoints receive only the question content you choose to analyze, authenticated with your own API keys.
