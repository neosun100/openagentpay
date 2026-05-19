"""
OpenAgentPay Strands Plugin
============================

Drop-in tool for AWS Strands Agents (https://strandsagents.com) that lets your
agent autonomously make payments via OpenAgentPay's pluggable wallet/protocol
infrastructure.

Two ways to use this package:

1. **Tool function** (recommended for most users)::

       from openagentpay_strands import create_payment_tool

       pay_tool = create_payment_tool(
           api_url="https://d1p7yxa99nxaye.cloudfront.net",
           default_wallet_provider="coinbase-cdp",
           default_session_budget_usd=5.0,
       )

       from strands import Agent
       agent = Agent(model="...", tools=[pay_tool])

2. **Direct client API** (for non-Strands code paths)::

       from openagentpay_strands import OpenAgentPayClient

       client = OpenAgentPayClient(api_url="https://...")
       result = await client.pay(
           amount_usd=0.001,
           recipient="0x...",
           reason="Buy market data",
       )

The tool talks to a running OpenAgentPay demo-api deployment (HTTP). It does
NOT hold private keys locally — those stay server-side, secured by
@openagentpay/governance + AWS Secrets Manager (or your facilitator service).

License: Apache-2.0
"""
from __future__ import annotations

from .client import OpenAgentPayClient
from .errors import OpenAgentPayError
from .tool import create_payment_tool
from .types import PaymentResult

__version__ = "0.1.0a0"

__all__ = [
    "__version__",
    "OpenAgentPayClient",
    "OpenAgentPayError",
    "PaymentResult",
    "create_payment_tool",
]
