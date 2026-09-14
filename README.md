<img src="https://raw.githubusercontent.com/iayazedan/n8n-nodes-k2-horizon/main/icons/k2horizon.svg" alt="K2 Horizon" width="120" />

# n8n-nodes-k2-horizon

This is an n8n community node. It lets you use [K2 Horizon](https://ifm.ai/blog/k2/) in your n8n workflows.

K2 Horizon is the Institute of Foundation Models' open-weight frontier reasoning series, built for agentic tool use and long-horizon tasks. The 375B sparse MoE is served on IFM's hosted API; every size is released as open weights, so the same node also works against your own SGLang or vLLM deployment.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/sustainable-use-license/) workflow automation platform.

[Installation](#installation)
[Operations](#operations)
[Credentials](#credentials)
[Compatibility](#compatibility)
[Usage](#usage)
[Resources](#resources)
[Version history](#version-history)

The package ships two nodes and one credential:

|                           |                                                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **K2 Horizon Chat Model** | A sub-node that plugs into the AI Agent, Basic LLM Chain, and anything else taking a Chat Model. This is the one to use for agentic work. |
| **K2 Horizon**            | A regular node for direct calls: messages in, reply out, optionally constrained to JSON or a JSON Schema.                                 |
| **K2 Horizon (IFM) API**  | The credential both nodes use.                                                                                                            |

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation, using the package name `n8n-nodes-k2-horizon`.

## Operations

### K2 Horizon Chat Model

Supplies a model to an AI Agent or chain. Tool calling is native, so the agent can drive n8n's built-in tools and your own.

- **Model** — loaded from the gateway's `/models`, falling back to the published catalogue if that call is unavailable.
- **Reasoning Effort** — `low`, `medium` or `high`. IFM tunes and evaluates K2 Horizon at `high` and recommends it for production.
- **Options** — Max Retries, Max Tokens, Frequency Penalty, Presence Penalty, Sampling Temperature, Session ID, Timeout, Top P.

### K2 Horizon

One request per input item.

- **Messages** — any number of system, user and assistant turns.
- **Output Format**
  - **Text** — a plain reply.
  - **JSON** — valid JSON of any shape (`response_format: json_object`). Describe the fields you want in a message as well; this constrains syntax, not structure.
  - **JSON Schema** — the reply is constrained to a schema you supply, so it validates by construction and arrives already parsed.
- **Simplify Output** — on by default, returning `{ content, reasoning, finishReason }`. Turn it off for the raw API response, including token usage.
- **Options** — Max Retries, Max Tokens, Sampling Temperature, Seed, Session ID, Timeout, Top P.

## Credentials

You need an API key from the [IFM Platform](https://ifm.ai/). Keys look like `IFM-xf…`.

1. Create a key in the IFM Platform and copy it.
2. In n8n, create a new **K2 Horizon (IFM) API** credential and paste the key.
3. Leave **Base URL** at `https://api.ifm.ai/v1` for the hosted gateway, or point it at your own SGLang or vLLM endpoint.
4. Press **Test**. It calls `GET /models`, which costs no tokens and fails loudly on a bad key or a wrong base URL.

## Compatibility

Requires an n8n version that ships the AI node SDK (`@n8n/ai-node-sdk`), which n8n supplies at runtime — this package has no runtime dependencies of its own.

Verified against:

| n8n    | AI node SDK | Verified                                        |
| ------ | ----------- | ----------------------------------------------- |
| 2.23.4 | 0.14.1      | AI Agent with a tool, streamed and non-streamed |
| 2.34.0 | 0.24.0      | AI Agent with a tool                            |

Newer releases are expected to work but have not been tested. Note that n8n 2.36 and later require Node.js 24 for n8n itself; that is an n8n requirement, unrelated to this package.

## Usage

### As an agent's model

Add an **AI Agent**, attach **K2 Horizon Chat Model** to its Chat Model input, and connect whatever tools you need. The model asks for a tool, n8n runs it, and the result goes back for the next turn.

K2 Horizon returns a reasoning trace alongside its answer, and the gateway rejects any assistant turn that is replayed without one. This node keeps the trace attached to each turn, which is what makes multi-step tool use work. A generic OpenAI-compatible chat model node will fail on the first tool round trip for exactly this reason.

### Structured output

Use the **K2 Horizon** node with **Output Format → JSON Schema** when you need a predictable shape. Decoding is constrained to the schema, so `content` comes back already parsed. Keep schemas shallow and name fields the way you would in a prompt — deep or cryptic schemas cost tokens and degrade the answer even though it stays valid.

If a reply cannot be parsed it almost always means the token limit cut it off mid-object; raise **Max Tokens**, remembering that reasoning tokens count towards it.

### Rate limits

Every API key has a daily token allowance, and the platform also applies a per-minute guard that a modest batch can reach. Both nodes retry rate limits and transient server errors, waiting as long as the `Retry-After` header asks and backing off exponentially otherwise. Tune this with the **Max Retries** option, or split large batches.

### Session routing

Both nodes send an `X-Session-ID` header so a conversation keeps hitting the compute node that already holds its prompt prefix. The chat model mints one per agent run; the direct node mints one per execution, shared by its items. Set **Session ID** yourself to override. It is a latency optimisation only — results are identical without it.

### Known quirks

- **Frequency Penalty** is accepted by the gateway but has no effect, per IFM's documentation.
- Tools whose input is a plain string (n8n's Calculator, Wikipedia, Think) are supported: their schema is converted to the single-string-input object shape the gateway requires.

## Resources

- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
- [IFM documentation](https://docs.ifm.ai)
- [K2 Horizon on Hugging Face](https://huggingface.co/IFM)

## Version history

### 0.1.0

First release. K2 Horizon Chat Model for agentic use, the K2 Horizon node for direct calls with JSON and JSON Schema output, and the K2 Horizon (IFM) API credential.
