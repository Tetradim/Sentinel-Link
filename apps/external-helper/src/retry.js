export function nextRetryDelayMs(attempt, baseDelayMs) {
  const retryIndex = Math.max(0, attempt - 1);
  return baseDelayMs * 2 ** retryIndex;
}
