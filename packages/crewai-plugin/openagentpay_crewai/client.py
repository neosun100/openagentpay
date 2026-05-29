"""HTTP client (mirror of strands/autogen plugin clients).

Single source of truth for the demo-api wire shape; all language plugins
share this implementation modulo small naming tweaks.
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
    session_id: str
    expires_at_unix: float


class OpenAgentPayClient:
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
        self.api_url = api_url.rstrip("/")
        self.default_wallet_provider = default_wallet_provider
        self.default_session_budget_usd = default_session_budget_usd
        self.default_session_expiry_minutes = default_session_expiry_minutes
        self._timeout = timeout
        self._http = http_client
        self._session_state: _SessionState | None = None
        self._session_creations = 0

    @property
    def _client(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(timeout=self._timeout)
        return self._http

    async def aclose(self) -> None:
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    async def __aenter__(self) -> "OpenAgentPayClient":
        return self

    async def __aexit__(self, *_args: Any) -> None:
        await self.aclose()

    async def pay(
        self,
        *,
        amount_usd: float,
        recipient: str,
        reason: str,
        wallet_provider: str | None = None,
        mandates: list[dict] | None = None,
    ) -> PaymentResult:
        if amount_usd <= 0:
            raise ValueError("amount_usd must be positive")
        if not recipient:
            raise ValueError("recipient is required")
        if not reason:
            raise ValueError("reason is required")
        provider = wallet_provider or self.default_wallet_provider
        if not provider:
            raise ValueError("wallet_provider not provided and no default configured")

        session_id = await self._ensure_session()
        body: dict[str, Any] = {
            "sessionId": session_id,
            "amountUsdc": amount_usd,
            "recipient": recipient,
            "walletProvider": provider,
        }
        if mandates:
            body["mandates"] = mandates

        try:
            r = await self._client.post(f"{self.api_url}/api/pay", json=body)
        except httpx.HTTPError as e:
            raise OpenAgentPayError(
                f"POST /api/pay failed: {e}", code="transport_error"
            ) from e
        if r.status_code == 404:
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
        return PaymentResult(
            success=bool(body_resp.get("success", False)),
            wallet_provider=str(body_resp.get("walletProvider", provider)),
            amount_usd=amount_usd,
            recipient=str(body_resp.get("recipient", recipient)),
            tx_hash=body_resp.get("txHash"),
            explorer_url=body_resp.get("explorerUrl"),
            network=body_resp.get("network"),
            error_code=body_resp.get("errorCode"),
            error_message=body_resp.get("errorMessage"),
            had_mandates=bool(mandates),
        )

    async def _ensure_session(self) -> str:
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
                f"POST /api/session failed: {e}", code="session_creation_failed"
            ) from e
        if r.status_code >= 400:
            raise OpenAgentPayError(
                f"POST /api/session failed: {r.text[:200]}",
                code="session_creation_failed",
                http_status=r.status_code,
            )
        data = r.json()
        ttl = (self.default_session_expiry_minutes * 60) - 5
        self._session_state = _SessionState(
            session_id=data["sessionId"],
            expires_at_unix=now + max(0.0, ttl),
        )
        self._session_creations += 1
        return data["sessionId"]
