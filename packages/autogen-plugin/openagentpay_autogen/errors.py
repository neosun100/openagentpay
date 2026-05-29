"""Error class for OpenAgentPay AutoGen plugin."""
from __future__ import annotations


class OpenAgentPayError(Exception):
    def __init__(
        self,
        message: str,
        *,
        code: str = "unknown",
        http_status: int | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status
