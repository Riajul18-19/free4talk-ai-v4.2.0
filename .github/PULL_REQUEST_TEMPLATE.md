## 📝 Description

Please provide a summary of the changes and the related issue/motivation. Include relevant context and design decisions.

Fixes / Closes #(issue)

---

## 🔍 Type of Change

- [ ] 🐛 Bug fix (non-breaking change which fixes an issue)
- [ ] ✨ New feature (non-breaking change which adds functionality)
- [ ] ⚡ Performance optimization (latency reduction, memory improvement)
- [ ] 📝 Documentation update (README, Guides, Rules, Roadmap)
- [ ] 🔒 Security fix or hardening

---

## 🧪 Testing Checklist

- [ ] Tested locally in Google Chrome (`chrome://extensions/` - Load Unpacked).
- [ ] Tested live on [free4talk.com](https://www.free4talk.com) in active rooms.
- [ ] Verified zero console errors during message trigger and reply dispatch.
- [ ] Verified failover between Groq, NVIDIA NIM, and OpenRouter.

---

## 🛡️ Security & Privacy Checklist

- [ ] **Zero Telemetry**: No third-party analytics, tracking scripts, or external relays introduced.
- [ ] **Direct API Calls**: All inference calls are sent directly from browser to official provider endpoints.
- [ ] **No Secret Leaks**: No API keys, credentials, or personal tokens are committed.
- [ ] **Scoped Permissions**: Manifest permissions remain minimal and compliant with Manifest V3.
- [ ] Adheres to [RULES.md](RULES.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
