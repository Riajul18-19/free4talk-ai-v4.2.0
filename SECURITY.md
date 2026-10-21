# 🔒 Security Policy

The security and privacy of our users are the highest priorities of **Free4Talk AI**. Because this browser extension interacts directly with AI models using user-supplied API keys, we enforce strict security architectural principles.

---

## 🛡️ Supported Versions

We provide security updates and patches for the current and recent major releases:

| Version | Supported | Security Maintenance |
| :--- | :---: | :--- |
| **4.2.x (Pro)** |  Yes | Active support and rapid patches |
| **4.1.x** |  No | Please upgrade to v4.2.0 |
| **< 4.0.0** |  No | End-of-life |

---

## 🔐 Core Security Commitments

1. **Direct-to-Provider HTTPS**: All inference calls are sent directly from the client’s browser to official endpoints (`api.groq.com`, `integrate.api.nvidia.com`, `openrouter.ai`). No intermediate server, proxy, or logger ever touches your conversation or API keys.
2. **Local Credential Storage**: Keys are stored exclusively within Chrome’s isolated `chrome.storage.local`.
3. **No External Analytics / Telemetry**: We do not include Google Analytics, Sentry, Mixpanel, or any tracking telemetry.
4. **Minimal Domain Scoping**: Content scripts are restricted strictly to `*://*.free4talk.com/*`.

---

## 🚨 Reporting a Vulnerability

If you discover a security vulnerability or privacy flaw within Free4Talk AI, please report it responsibly:

1. **Do NOT open a public issue** disclosing the exploit before it is patched.
2. Submit a private security report via [GitHub Security Advisories](https://github.com/Riajul18-19/free4talk-ai-v4.2.0/security/advisories) or contact the project maintainer [@Riajul18-19](https://github.com/Riajul18-19).
3. Please include:
   - Description of the vulnerability.
   - Proof of Concept (PoC) or reproduction steps.
   - Assessment of potential impact.

### Response Timeline
- **Initial Acknowledgement**: Within 48 hours.
- **Triage & Assessment**: Within 72 hours.
- **Fix & Advisory Release**: Coordinated disclosure within 14 days of patch confirmation.

Thank you for helping keep the Free4Talk AI community safe! 🛡️
