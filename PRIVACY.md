# Privacy Policy — Study Assist

**Effective Date:** February 7, 2026
**Last Updated:** February 7, 2026

---

## 1. Overview

Study Assist is a browser extension that provides AI-powered study explanations. This policy describes what data the extension accesses, how it is used, and your rights.

## 2. Data the Extension Accesses

### 2.1 Page Content (Transient, User-Activated Only)

When you explicitly activate the extension on an allowed domain, it reads visible text content (questions, answer options) from the current page. This content is:

- Sent to AI API endpoints for analysis (see Section 3)
- Never stored locally or remotely
- Never transmitted to any party other than the AI APIs you configure

The extension does **not** read page content automatically. It only activates when you press a keyboard shortcut or click the extension button.

### 2.2 API Keys (Local Storage Only)

- Claude (Anthropic) API key — optional, provided by you
- DeepSeek API key — optional, provided by you

Keys are stored locally in your browser using the Chrome Storage API. They are never transmitted to any server other than the respective API endpoint during authenticated requests.

### 2.3 Usage Statistics (Local Storage Only)

- Request count, token usage, estimated cost, latency
- Stored locally in your browser
- Never transmitted externally
- Viewable and deletable from the extension dashboard

### 2.4 User Settings (Local Storage Only)

- Response mode preference
- UI configuration (button position, display options)
- Domain allowlist (sites where the extension is permitted to operate)

## 3. Third-Party Services

The extension communicates with the following third-party APIs only when you activate analysis:

| Service                | Endpoint                    | Data Sent                                                | When                                                               |
| ---------------------- | --------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------ |
| **Anthropic (Claude)** | `https://api.anthropic.com` | Question text, answer options, your API key (via header) | Only when you activate analysis and have a Claude key configured   |
| **DeepSeek**           | `https://api.deepseek.com`  | Question text, answer options, your API key (via header) | Only when you activate analysis and have a DeepSeek key configured |

These services have their own privacy policies:

- Anthropic: https://www.anthropic.com/privacy
- DeepSeek: https://www.deepseek.com/privacy

## 4. What the Extension Does NOT Do

- Does **not** collect personal information (name, email, identity)
- Does **not** track browsing history or behavior
- Does **not** use cookies, fingerprinting, or any tracking technology
- Does **not** run background processes or make network requests when inactive
- Does **not** harvest credentials, passwords, or form data
- Does **not** inject advertisements
- Does **not** sync data to any cloud service or remote server
- Does **not** share data with third parties beyond the AI APIs described above

## 5. Data Storage

All data is stored locally on your device using the Chrome Storage API:

- No remote servers
- No external databases
- No cloud synchronization
- No analytics or telemetry services

## 6. Data Retention and Deletion

Usage statistics and settings persist until you delete them. To remove all extension data:

1. Open the extension popup
2. Navigate to the Dashboard
3. Use "Clear All Usage Data" to remove statistics
4. Uninstall the extension to remove all stored settings and API keys

Alternatively, clearing your browser's extension data will remove all Study Assist data.

## 7. Domain Allowlist

The extension includes a user-defined domain allowlist. It will only operate on domains you explicitly add to this list. No domains are pre-configured. The content script performs a domain check on every page load and exits immediately if the domain is not in your allowlist.

## 8. Permissions Explained

| Permission         | Purpose                                                          |
| ------------------ | ---------------------------------------------------------------- |
| `storage`          | Store settings and API keys locally                              |
| `activeTab`        | Access visible content on the current tab when activated         |
| `tabs`             | Detect navigation events to reinitialize on allowed pages        |
| `scripting`        | Inject content scripts for question detection on allowed domains |
| `host_permissions` | Send requests to Anthropic and DeepSeek API endpoints only       |

## 9. Children's Privacy

This extension is not directed at users under 13 years of age. It does not knowingly collect data from children.

## 10. Changes to This Policy

Changes will be reflected in the "Last Updated" date above. Continued use of the extension after changes constitutes acceptance.

## 11. Contact

For privacy inquiries, please open an issue on the project's GitHub repository.

---

**Summary:** Study Assist does not collect, store, or transmit personal data. Everything stays on your device. AI API endpoints receive only the question content you choose to analyze, authenticated with your own API keys.
