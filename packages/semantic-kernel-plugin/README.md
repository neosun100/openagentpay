# OpenAgentPay × Microsoft Semantic Kernel Plugin

Drop-in Semantic Kernel plugin (`@kernel_function`-decorated). Lets SK agents
execute autonomous payments with the 7-Layer Guardrail in force.

```python
import semantic_kernel as sk
from openagentpay_semantic_kernel import OpenAgentPayPlugin

kernel = sk.Kernel()
kernel.add_plugin(
    OpenAgentPayPlugin(api_url="https://d1p7yxa99nxaye.cloudfront.net",
                      default_wallet_provider="coinbase-cdp"),
    plugin_name="payments",
)
```

License: Apache 2.0.
