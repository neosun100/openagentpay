"""
OpenAgentPay AutoGen Plugin
============================

Drop-in payment tool for Microsoft AutoGen agents. Compatible with both:
  - autogen_agentchat.agents.AssistantAgent (modern, v0.4+)
  - autogen.agentchat (legacy)

Strategy: AutoGen tools are plain async callables — same shape Strands uses.
We expose `create_payment_tool()` returning an async function with rich
metadata; AutoGen's tool registry picks it up automatically.

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
