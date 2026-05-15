# OpenAgentPay Strands Plugin

Drop-in replacement for AWS AgentCore `AgentCorePaymentsPlugin`. Same constructor
shape, but lets you swap the underlying wallet provider (Binance Pay, OKX,
MetaMask, ...) and protocol (x402, OAP-CEX, MPP, ...).

## Install

```bash
uv add openagentpay-strands
```

## Use

```python
from strands import Agent
from openagentpay import OpenAgentPayPlugin, OpenAgentPayConfig

cfg = OpenAgentPayConfig(
    wallet_provider="binance",
    protocol="cex-pay",
    payment_session_id=session.id,
    payment_instrument_id="payment-instrument-...",
    user_id="alice",
    payment_manager_endpoint="https://...lambda-url.us-west-2.on.aws/",
)

agent = Agent(
    model_id="global.anthropic.claude-sonnet-4-6-v1:0",
    plugins=[OpenAgentPayPlugin(config=cfg)],
)
```

License: Apache-2.0.
