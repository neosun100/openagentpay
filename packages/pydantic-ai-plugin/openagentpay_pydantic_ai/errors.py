"""Errors raised by the OpenAgentPay PydanticAI client."""


class OpenAgentPayError(Exception):
    """Raised when the OpenAgentPay HTTP API returns a non-success response."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "unknown",
        http_status: int | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.http_status = http_status
