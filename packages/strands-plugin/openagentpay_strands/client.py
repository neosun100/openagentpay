"""
HTTP client for the OpenAgentPay demo-api deployment.

This is the underlying transport used by the Strands tool. You can also use it
directly from Python code (no Strands required).

Three endpoints we hit:
    POST /api/session       create a session with budget cap + TTL
    POST /api/pay           sign + settle (returns tx hash on success)
    GET  /api/governance    optional — fetch policy list / audit log
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

import httpx

from .errors import OpenAgentPayError
from .types import PaymentResult

DEFAULT_TIMEOUT_S = 30.0
DEFAULT_BUDGET_USD = 5.0
DEFAULT_EXPIRY_MIN = 30


@dataclass(slots=True)
class _SessionState:
    """Cached session id + expiry for lazy session lifecycle."""

    session_id: str
    expires_at_unix: float


class OpenAgentPayClient:
    """Async client for the OpenAgentPay demo-api HTTP endpoints.

    The client manages a per-instance "current session": on the first call to
    :meth:`pay`, a session is created with the configured budget + TTL. The
    same session is reused for subsequent calls until it expires, at which
    point a new one is created automatically.

    Example::

        client = OpenAgentPayClient(api_url="https://d1p7yxa99nxaye.cloudfront.net")
        r = await client.pay(amount_usd=0.001, recipient="0x...", reason="market data")
        print(r.success, r.tx_hash)
    """

    def __init__(
        self,
        api_url: str,
        *,
        default_wallet_provider: str | None = None,
        default_session_budget_usd: float = DEFAULT_BUDGET_USD,
        default_session_expiry_minutes: int = DEFAULT_EXPIRY_MIN,
        http_client: httpx.AsyncClient | None = None,
        timeout: float = DEFAULT_TIMEOUT_S,
    ) -> None:
        if not api_url:
            raise ValueError("api_url is required")
        # Strip trailing slash for clean URL joins
        self.api_url = api_url.rstrip("/")
        self.default_wallet_provider = default_wallet_provider
        self.default_session_budget_usd = default_session_budget_usd
        self.default_session_expiry_minutes = default_session_expiry_minutes
        self._timeout = timeout
        # Allow caller to inject (e.g., for testing); we own a fallback otherwise.
        self._http = http_client
        self._session_state: _SessionState | None = None
        # Fresh-session affinity counter — for tests / debug
        self._session_creations = 0

    @property
    def _client(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(timeout=self._timeout)
        return self._http

    async def aclose(self) -> None:
        """Release HTTP resources. Safe to call multiple times."""
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    async def __aenter__(self) -> "OpenAgentPayClient":
        return self

    async def __aexit__(self, *_args: Any) -> None:
        await self.aclose()

    # ----------------------------------------------------------------
    #  Public API
    # ----------------------------------------------------------------

    async def list_wallets(self) -> list[dict]:
        """GET /api/wallets → list of available wallet providers + chain info."""
        r = await self._client.get(f"{self.api_url}/api/wallets")
        if r.status_code >= 400:
            raise OpenAgentPayError(
                f"GET /api/wallets failed: {r.text[:200]}",
                code="http_error",
                http_status=r.status_code,
            )
        body = r.json()
        return list(body.get("wallets", []))

    async def get_governance(self) -> dict:
        """GET /api/governance → policies + compliance + audit log."""
        r = await self._client.get(f"{self.api_url}/api/governance")
        if r.status_code >= 400:
            raise OpenAgentPayError(
                f"GET /api/governance failed: {r.text[:200]}",
                code="http_error",
                http_status=r.status_code,
            )
        return r.json()

    async def pay(
        self,
        *,
        amount_usd: float,
        recipient: str,
        reason: str,
        wallet_provider: str | None = None,
    ) -> PaymentResult:
        """POST /api/pay (with auto session lifecycle).

        Args:
            amount_usd: amount to pay in USD (settles in USDC by default)
            recipient: chain address (0x...) or merchant id
            reason: human-readable reason for the payment (audit trail)
            wallet_provider: optional override; falls back to default_wallet_provider

        Returns:
            PaymentResult with success/tx_hash on success, error_code/error_message on failure.

        Raises:
            OpenAgentPayError: only on non-recoverable transport / 5xx errors.
                Governance denials and chain failures are returned as
                ``PaymentResult(success=False, ...)``, not exceptions.
        """
        if amount_usd <= 0:
            raise ValueError("amount_usd must be positive")
        if not recipient:
            raise ValueError("recipient is required")
        if not reason:
            raise ValueError("reason is required")

        provider = wallet_provider or self.default_wallet_provider
        if not provider:
            raise ValueError(
                "wallet_provider not provided and no default_wallet_provider configured"
            )

        # 1. Ensure session
        session_id = await self._ensure_session()

        # 2. POST /api/pay
        body: dict = {
            "sessionId": session_id,
            "amountUsdc": amount_usd,
            "recipient": recipient,
            "walletProvider": provider,
        }
        try:
            r = await self._client.post(f"{self.api_url}/api/pay", json=body)
        except httpx.HTTPError as e:
            raise OpenAgentPayError(
                f"POST /api/pay failed: {e}",
                code="transport_error",
            ) from e

        if r.status_code == 404:
            # Session may have expired or routed to a different Lambda
            # warm instance. Invalidate cache so next call creates a new one.
            self._session_state = None

        if r.status_code >= 400:
            payload: Any = {}
            try:
                payload = r.json()
            except Exception:
                payload = {"message": r.text[:200]}
            raise OpenAgentPayError(
                payload.get("message", f"HTTP {r.status_code}"),
                code=str(payload.get("code", "http_error")),
                http_status=r.status_code,
            )

        body_resp = r.json()
        return _result_from_response(body_resp, recipient, amount_usd, provider, reason)

    # ----------------------------------------------------------------
    #  Internals
    # ----------------------------------------------------------------

    async def _ensure_session(self) -> str:
        """Create a session if we don't have one, or if the cached one expired."""
        now = asyncio.get_event_loop().time()
        st = self._session_state
        if st is not None and st.expires_at_unix > now:
            return st.session_id

        body = {
            "budgetUsd": self.default_session_budget_usd,
            "expiryMinutes": self.default_session_expiry_minutes,
        }
        try:
            r = await self._client.post(f"{self.api_url}/api/session", json=body)
        except httpx.HTTPError as e:
            raise OpenAgentPayError(
                f"POST /api/session failed: {e}",
                code="session_creation_failed",
            ) from e
        if r.status_code >= 400:
            raise OpenAgentPayError(
                f"POST /api/session failed: {r.text[:200]}",
                code="session_creation_failed",
                http_status=r.status_code,
            )
        data = r.json()
        # Use a slight buffer (5 seconds) before actual expiry to avoid
        # racing with server-side TTL.
        ttl_seconds = (self.default_session_expiry_minutes * 60) - 5
        self._session_state = _SessionState(
            session_id=data["sessionId"],
            expires_at_unix=now + max(0.0, ttl_seconds),
        )
        self._session_creations += 1
        return data["sessionId"]


def _result_from_response(
    body: dict,
    recipient: str,
    amount_usd: float,
    provider: str,
    _reason: str,
) -> PaymentResult:
    """Convert demo-api /api/pay response shape into PaymentResult."""
    return PaymentResult(
        success=bool(body.get("success", False)),
        wallet_provider=str(body.get("walletProvider", provider)),
        amount_usd=amount_usd,
        recipient=str(body.get("recipient", recipient)),
        tx_hash=body.get("txHash"),
        explorer_url=body.get("explorerUrl"),
        network=body.get("network"),
        error_code=body.get("errorCode"),
        error_message=body.get("errorMessage"),
    )
