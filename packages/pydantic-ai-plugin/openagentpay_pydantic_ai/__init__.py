"""
openagentpay-pydantic-ai
========================

PydanticAI-compatible tool. Mirrors the strands/autogen/crewai plugins'
shape but uses Pydantic v2 BaseModel for input validation.

Usage::

    from pydantic_ai import Agent
    from openagentpay_pydantic_ai import create_payment_tool

    pay = create_payment_tool(api_url="http://localhost:8788", user_id="alice")
    agent = Agent("openai:gpt-4o-mini", tools=[pay])

The actual HTTP client lives in :mod:`openagentpay_pydantic_ai.client`. The
Pydantic models in :mod:`openagentpay_pydantic_ai.types` are re-used by
plain-Python callers who want typed responses without a framework.
"""

from .client import OpenAgentPayClient
from .errors import OpenAgentPayError
from .tool import create_payment_tool, has_pydantic_ai_sdk
from .types import PaymentInput, PaymentResult

__all__ = [
    "OpenAgentPayClient",
    "OpenAgentPayError",
    "PaymentInput",
    "PaymentResult",
    "create_payment_tool",
    "has_pydantic_ai_sdk",
]
