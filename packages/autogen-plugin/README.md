# OpenAgentPay × Microsoft AutoGen Plugin

Drop-in async tool for Microsoft [AutoGen](https://github.com/microsoft/autogen)
agents. Lets multi-agent conversations execute real micropayments with the
7-Layer Guardrail in force.

```python
from autogen_agentchat.agents import AssistantAgent
from openagentpay_autogen import create_payment_tool

pay = create_payment_tool(
    api_url="https://d1p7yxa99nxaye.cloudfront.net",
    default_wallet_provider="coinbase-cdp",
)

agent = AssistantAgent("buyer", model_client, tools=[pay])
```

License: Apache 2.0.
