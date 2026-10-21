# 📜 Free4Talk AI — Official Rules, Ethics & Community Guidelines

> **Effective Date:** October 2026  
> **Applicable To:** All users, contributors, and operators of Free4Talk AI (v4.2.0+)  
> **Repository:** [Riajul18-19/free4talk-ai-v4.2.0](https://github.com/Riajul18-19/free4talk-ai-v4.2.0)

Welcome to the **Free4Talk AI** community. Our mission is to empower language learners, conversationalists, and global communicators on [free4talk.com](https://www.free4talk.com) through cutting-edge, privacy-preserving AI assistance.

To protect the integrity of the Free4Talk platform, foster positive language exchange, and ensure an enjoyable experience for all participants, all users and contributors must adhere to the following rules.

---

## 🧭 Core Principles

1. **Human-First Language Learning**: Free4Talk AI is engineered as an **assistant**, not a replacement for human conversation. The goal is to enrich discussion, break language barriers, and support active learning.
2. **Absolute User Privacy**: 100% of network requests stay between your browser and the official AI model provider. No intermediaries, no telemetry, no tracking.
3. **Responsible Automation**: Intelligent, respectful participation without overwhelming, spamming, or disrupting public voice and text rooms.

---

## ⚖️ 1. Bot Usage & In-Room Conduct Rules

### Rule 1.1: Transparency & Honesty
* **Disclosure**: When using auto-reply in rooms with other learners, be transparent. Letting other room members know that you are running an AI study assistant maintains trust and allows others to engage meaningfully.
* **No Impersonation**: Do not configure your bot persona to falsely impersonate specific real-life individuals, Free4Talk administrators, or community moderators.

### Rule 1.2: Zero Tolerance for Spam & Flooding
* **No Rapid Flooding**: Do not set artificial reply loops or configure prompts that flood the chat with excessive, repetitive, or irrelevant multi-paragraph text.
* **Natural Pacing**: Use respectful response lengths suitable for conversational back-and-forth. Avoid dumping full essays unless the room context specifically calls for it (e.g., translation requests or story prompts).
* **Respect Room Turn-Taking**: Allow room participants time to speak and type. Do not let the bot dominate every exchange.

### Rule 1.3: Room Rules & Topic Respect
* **Host Authority**: Room creators set the rules (e.g., "English Only - Intermediate", "Spanish Beginners", "Casual Chat"). Your AI persona and responses must respect the host's specified language and topic.
* **Immediate Deactivation on Request**: If a room host or members ask you to disable the bot in their room, you must immediately toggle off auto-reply or leave the room.

### Rule 1.4: Prohibition of Harmful, Illegal & NSFW Content
* You may **NOT** use Free4Talk AI to generate, transmit, or promote:
  * Hate speech, harassment, bullying, or discrimination based on race, ethnicity, religion, gender, disability, or nationality.
  * Explicit adult content, pornography, or sexually suggestive material in public rooms.
  * Phishing links, scam campaigns, malware, or unauthorized commercial advertisements.
  * Dangerous instructions, illegal acts, or copyright-violating text dumps.

---

## 🔒 2. Privacy & Technical Safety Rules

### Rule 2.1: Client-Side Direct Execution Only
* Free4Talk AI is strictly architected for direct client-to-API communication (`api.groq.com`, `integrate.api.nvidia.com`, `openrouter.ai`).
* **Rule for Forks & Derivatives**: Any fork or modification of this project **must never** introduce centralized telemetry, proxy relays, remote API key scrapers, or third-party loggers that intercept user conversations.

### Rule 2.2: Protection of Sensitive Data
* Never feed passwords, financial details, government IDs, or confidential personal information into chat prompts or AI memory banks.
* All API keys (Groq, NVIDIA NIM, OpenRouter) are saved exclusively in your browser’s local storage (`chrome.storage.local`). Keep your keys private and never share your browser profile with untrusted parties.

---

## 🛠️ 3. Contributor & Code Governance Rules

Contributors submitting code, bug fixes, or enhancements to this repository must follow these standards:

### Rule 3.1: Manifest V3 Compliance & Scoping
* All pull requests must conform to Chrome Manifest V3 standards.
* Permissions must remain minimal. Never expand host permissions beyond `*://*.free4talk.com/*` and legitimate, vetted AI provider API endpoints without explicit approval and architectural justification.

### Rule 3.2: Zero Render-Blocking & Ultra-Low Latency
* Free4Talk AI v4.2.0 established an ultra-fast zero-delay pipeline (5x–8x performance boost).
* No PR may reintroduce arbitrary `sleep()`, synchronous I/O blocking, or heavy render-blocking assets that degrade browser performance.

### Rule 3.3: Clean PR & Commit Standards
* Use clear [Conventional Commits](https://www.conventionalcommits.org/) format:
  * `feat:` New features or capabilities
  * `fix:` Bug fixes or corrections
  * `perf:` Performance optimizations
  * `docs:` Documentation updates
  * `refactor:` Code restructuring without behavioral change
* Every PR must include an explanation of the change, test verification in Chrome Developer Mode, and a confirmation of zero security impact.

---

## 🚨 4. Enforcement & Compliance

* **Repository Bans**: Users or contributors who submit malicious pull requests, attempt backdoors, or violate our [Code of Conduct](CODE_OF_CONDUCT.md) will be permanently blocked from this repository and reported to GitHub Trust & Safety.
* **Platform Terms**: Remember that your use of the extension is also subject to the Terms of Service of [free4talk.com](https://www.free4talk.com) and the respective terms of the AI providers (NVIDIA, Groq, OpenRouter).

---

## 🤝 5. Community Inquiries & Reporting

If you observe violations of these rules, security concerns, or unethical behavior involving this software:

- **Security Vulnerabilities**: See [SECURITY.md](SECURITY.md) for direct disclosure.
- **Rule Violations / Issues**: Open an issue on GitHub: [Issues Tracker](https://github.com/Riajul18-19/free4talk-ai-v4.2.0/issues).
- **Maintainer**: [@Riajul18-19](https://github.com/Riajul18-19)
