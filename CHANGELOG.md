# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0 — 2026-09-12

First release.

### Added

- **K2 Horizon Chat Model** node, a chat model for the AI Agent and other
  chains. Native tool calling, selectable reasoning effort, streaming, and a
  model picker fed by `GET /models` with the published catalogue as a fallback.
- **K2 Horizon** node for direct calls: system/user/assistant messages in, reply
  out, with Text, JSON, or schema-constrained JSON output. Simplified output
  returns `{ content, reasoning, finishReason }`; the raw API response is
  available too.
- **K2 Horizon (IFM) API** credential. Bearer key plus an editable base URL, so
  the same credential works against the hosted gateway or a self-hosted SGLang
  or vLLM endpoint. Its Test button calls `GET /models`, which costs no tokens.
- Retries for rate limits and transient server errors, honouring the
  `Retry-After` header and backing off exponentially without it, bounded by a
  **Max Retries** option.
- `X-Session-ID` on every request so a run keeps hitting the compute node that
  holds its prompt prefix.

### Notes

- Assistant turns always carry their reasoning trace when replayed. The gateway
  rejects turns without one, which is what breaks generic OpenAI-compatible
  chat model nodes on the first tool round trip.
- Tool schemas are converted before they are sent. Tools that expose a plain
  string input — n8n's Calculator, Wikipedia and Think — are mapped to the
  single-string-input object shape the gateway requires.
