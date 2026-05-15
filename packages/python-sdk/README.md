# OpenAgentPay Python SDK

Canonical Python types and helpers for the OpenAgentPay platform.

This package mirrors `@openagentpay/core` (TypeScript) one-for-one. Use it from
Strands Agents or any Python AI runtime to build wallet connectors, protocol
adapters, and spend governors.

## Install

```bash
uv add openagentpay        # or pip install openagentpay
```

## Use

```python
from openagentpay import (
    WalletConnector, ProtocolAdapter, Session,
    Money, Asset, PaymentRequest, SettlementResult,
)
```

See full API in `openagentpay/types.py`. License: Apache-2.0.
