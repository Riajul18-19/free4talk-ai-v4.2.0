# 🤝 Contributing to Free4Talk AI

Thank you for your interest in contributing to **Free4Talk AI**! We welcome contributions from developers, designers, language enthusiasts, and prompt engineers of all experience levels.

Please take a moment to review this document to ensure smooth, respectful, and effective collaboration.

---

## 📜 Code of Conduct & Rules

Before contributing, please read and agree to:
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Official Rules & Ethics Guidelines](RULES.md)
- [Security Policy](SECURITY.md)

---

## 🛠️ Getting Started with Local Development

### Prerequisites
- Google Chrome (or Chromium-based browser such as Brave, Edge)
- Git installed locally
- Node.js (v18+ recommended if building React/esbuild components)

### Setup Instructions

1. **Fork & Clone the Repository**:
   ```bash
   git clone https://github.com/Riajul18-19/free4talk-ai-v4.2.0.git
   cd free4talk-ai-v4.2.0
   ```

2. **Load the Unpacked Extension in Chrome**:
   - Open Chrome and navigate to `chrome://extensions/`.
   - Enable **Developer mode** in the top-right corner.
   - Click **Load unpacked** in the top-left corner.
   - Select the `free4talk-ai-v4.2.0` folder.

3. **Test in Real Time**:
   - Navigate to [free4talk.com](https://www.free4talk.com).
   - Whenever you edit `content.js`, `background.js`, or the UI files, click the **Reload icon** on the extension card in `chrome://extensions/` and refresh the Free4Talk page.

---

## 📐 Development Guidelines & Rules

### 1. Privacy First — Zero Telemetry Rule
- **Never** add third-party tracking scripts, analytic SDKs, or intermediate logging proxies.
- All network calls must be sent directly to approved AI endpoints (`api.groq.com`, `integrate.api.nvidia.com`, `openrouter.ai`) or run locally on device.

### 2. High Performance & Zero-Delay Pipeline
- Avoid introducing blocking loops, long synchronous disk operations, or artificial `sleep()` calls.
- Use asynchronous non-blocking storage writes where appropriate.
- Maintain micro-frame DOM observation (15–20ms checks).

### 3. Manifest V3 Integrity
- Strict permission scoping in `manifest.json`.
- Do not request `tabs` or host permissions beyond `*://*.free4talk.com/*` without explicit review.

---

## 🔀 Branching & Commit Conventions

We follow [Conventional Commits](https://www.conventionalcommits.org/):

| Type | Description |
| :--- | :--- |
| `feat:` | A new feature or capability |
| `fix:` | A bug fix |
| `perf:` | A code change that improves performance |
| `docs:` | Documentation changes only |
| `style:` | Formatting changes that do not affect code logic |
| `refactor:` | Code changes that neither fix a bug nor add a feature |
| `test:` | Adding or updating tests |

### Example Commit Messages:
```bash
feat(voice): add initial WebRTC audio capture observer
fix(failover): resolve abort timeout leak in Groq provider
perf(dom): reduce quote-button detection to micro-frame checks
docs(readme): add SEO keywords and roadmap badges
```

---

## 🚀 Submitting a Pull Request (PR)

1. Create a descriptive feature branch:
   ```bash
   git checkout -b feat/smart-icebreaker
   ```
2. Commit your changes following the convention:
   ```bash
   git commit -m "feat(room): add automated icebreaker topic generator"
   ```
3. Push to your forked repository:
   ```bash
   git push origin feat/smart-icebreaker
   ```
4. Open a Pull Request against the `main` branch of [Riajul18-19/free4talk-ai-v4.2.0](https://github.com/Riajul18-19/free4talk-ai-v4.2.0).
5. Complete all items in the [Pull Request Template](.github/PULL_REQUEST_TEMPLATE.md).

---

## 🐛 Reporting Bugs & Suggesting Features

- **Bug Reports**: Please use the [Bug Report Template](.github/ISSUE_TEMPLATE/bug_report.md). Include your Chrome version, operating system, AI provider, and console logs.
- **Feature Requests**: Check [ROADMAP.md](ROADMAP.md) first to see if your proposal is already planned, then submit a [Feature Request](.github/ISSUE_TEMPLATE/feature_request.md).

---

Thank you for helping make Free4Talk AI the best language learning companion in the world! 🌍🚀
