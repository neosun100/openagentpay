"""
OpenAgentPay Semantic Kernel Plugin
====================================

Microsoft Semantic Kernel (SK) integration. SK plugins are classes whose
methods are decorated with @kernel_function. We expose `OpenAgentPayPlugin`
which provides:

  - pay(amount_usd, recipient, reason, wallet_provider?)
  - check_session_budget()  → snapshot remaining budget

The @kernel_function decorator is OPTIONAL — when SK is installed it gets
applied automatically; otherwise the methods remain plain async callables.

License: Apache-2.0
"""
from __future__ import annotations

from .client import OpenAgentPayClient
from .errors import OpenAgentPayError
from .plugin import OpenAgentPayPlugin
from .types import PaymentResult

__version__ = "0.1.0a0"

__all__ = [
    "__version__",
    "OpenAgentPayClient",
    "OpenAgentPayError",
    "OpenAgentPayPlugin",
    "PaymentResult",
]
