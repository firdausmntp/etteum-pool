export function isInvalidModelError(error?: string): boolean {
  if (!error) return false;
  const normalized = error.toLowerCase();
  return (
    normalized.includes("invalid_model_id") ||
    normalized.includes("invalid model") ||
    normalized.includes("model_not_found") ||
    normalized.includes("no such model") ||
    normalized.includes("model is not supported") ||
    normalized.includes("model not supported")
  );
}

export function isBadUpstreamRequest(error?: string): boolean {
  if (!error) return false;
  const normalized = error.toLowerCase();
  return (
    normalized.includes("improperly formed request") ||
    normalized.includes("unsupported parameter")
  );
}

export function isContentModerationError(error?: string): boolean {
  if (!error) return false;
  return (
    error.includes("敏感内容") ||
    error.includes("sensitive content") ||
    error.includes("系统检测到") ||
    error.includes("content moderation") ||
    error.includes("Content moderation") ||
    error.includes("content_filter") ||
    error.includes("flagged as potentially sensitive")
  );
}

/**
 * Errors that are caused by the request content itself, not the account.
 * These should NOT be retried with different accounts since the same content
 * will trigger the same error regardless of which account is used.
 */
export function isNonAccountRequestError(error?: string): boolean {
  if (!error) return false;
  return (
    isInvalidModelError(error) ||
    isContentModerationError(error) ||
    isBadUpstreamRequest(error)
  );
}
