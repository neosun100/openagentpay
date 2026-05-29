# OpenAgentPay × CrewAI Plugin

Drop-in tool for [CrewAI](https://crewai.com) crews. Lets agents autonomously
execute payments with the 7-Layer Guardrail.

```python
from crewai import Agent, Crew, Task
from openagentpay_crewai import create_payment_tool

pay_tool = create_payment_tool(
    api_url="https://d1p7yxa99nxaye.cloudfront.net",
    default_wallet_provider="coinbase-cdp",
)

buyer = Agent(role="Buyer", goal="Buy data when needed", tools=[pay_tool])
crew = Crew(agents=[buyer], tasks=[...])
```

License: Apache 2.0.
