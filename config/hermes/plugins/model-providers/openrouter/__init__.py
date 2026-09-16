"""Cafe OS OpenRouter policy: bound Qwen output while retaining Hermes routing behavior."""

from dataclasses import fields

from plugins.model_providers.openrouter import OpenRouterProfile, openrouter as bundled_openrouter
from providers import register_provider

QWEN_MODEL = "qwen/qwen3.8-flash"
TOTAL_OUTPUT_TOKEN_CAP = 16_384


class CafeOpenRouterProfile(OpenRouterProfile):
    """Use Hermes OpenRouter behavior with a hard Qwen completion ceiling."""

    def get_max_tokens(self, model: str | None) -> int | None:
        normalized = (model or "").strip().lower().split(":", 1)[0]
        if normalized == QWEN_MODEL:
            return TOTAL_OUTPUT_TOKEN_CAP
        return super().get_max_tokens(model)


_profile_kwargs = {
    field.name: getattr(bundled_openrouter, field.name)
    for field in fields(bundled_openrouter)
}
register_provider(CafeOpenRouterProfile(**_profile_kwargs))
