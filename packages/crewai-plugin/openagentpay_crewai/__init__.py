"""
OpenAgentPay CrewAI Plugin
===========================

Provides a CrewAI-shaped Tool that wraps OpenAgentPay's PaymentManager.

CrewAI tools follow a `BaseTool` interface (name + description + _run/_arun).
We expose `create_payment_tool()` returning a class instance compatible with
both the modern CrewAI tool decorator and the BaseTool subclass approach.

License: Apache-2.0
"""
from __future__ import annotations

from .client import OpenAgentPayClient
from .errors import OpenAgentPayError
from .tool import OpenAgentPayCrewTool, create_payment_tool
from .types import PaymentResult

__version__ = "0.1.0a0"

__all__ = [
    "__version__",
    "OpenAgentPayClient",
    "OpenAgentPayError",
    "OpenAgentPayCrewTool",
    "PaymentResult",
    "create_payment_tool",
]
