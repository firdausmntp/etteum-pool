# Qoder Daily Credit System (200 req/day)

## Context
- Qoder free plan API returns `limit: 0, remaining: 0` — proxy can't detect quota from API
- User wants: 200 credits/account/day, decrement per request, mark exhausted at 0, daily reset, round-robin rotation
- Scope: Qoder only (other providers use existing system)

## Current System
- `accounts.quotaLimit` + `accounts.quotaRemaining` fields exist but unused for Qoder
- `decrementQuota()` only called when `quotaBefore > 0` (line 320, 438 in index.ts)
- Warmup overwrites quota from provider API (would reset to 0/0 for Qoder free tier)
- `fetchActiveAccounts()` filters `status = "active"` — exhausted accounts auto-skipped
- Round-robin is default load balancing method

## Implementation Plan

### 1. Add Daily Reset Logic (`src/proxy/pool.ts`)
Add method to check and reset quota if reset time has passed:

```typescript
async checkAndResetDailyQuota(accountId: number, dailyLimit: number): Promise<number> {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  if (!account) return 0;
  
  const now = new Date();
  const resetAt = account.quotaResetAt ? new Date(account.quotaResetAt) : null;
  
  // Reset if no reset time or reset time has passed
  if (!resetAt || now >= resetAt) {
    // Set next reset to tomorrow midnight
    const nextReset = new Date(now);
    nextReset.setDate(nextReset.getDate() + 1);
    nextReset.setHours(0, 0, 0, 0);
    
    const [updated] = await db.update(accounts)
      .set({
        quotaLimit: dailyLimit,
        quotaRemaining: dailyLimit,
        quotaResetAt: nextReset,
        status: "active", // Reactivate if was exhausted
        updatedAt: now,
      })
      .where(eq(accounts.id, accountId))
      .returning({ quotaRemaining: accounts.quotaRemaining });
    
    this.invalidate(account.provider as ProviderName);
    broadcast({
      type: "account_status",
      data: { id: accountId, status: "active", provider: account.provider, quotaReset: true },
    });
    
    return Number(updated?.quotaRemaining || dailyLimit);
  }
  
  return Number(account.quotaRemaining || 0);
}
```

### 2. Modify Request Handlers (`src/proxy/index.ts`)
Update `handleChatCompletion()` and `wrapStreamWithUsageFinalizer()` to:
- Call `checkAndResetDailyQuota(accountId, 200)` before checking quota
- Decrement by **1 credit per request** (not token-based) for Qoder
- Mark exhausted when `quotaRemaining === 0`

**Before (line ~392)**:
```typescript
const quotaBefore = Number(account.quotaRemaining || 0);
```

**After**:
```typescript
// For Qoder: check daily reset and use 1 credit per request
const isQoder = provider === "qoder";
const quotaBefore = isQoder
  ? await pool.checkAndResetDailyQuota(account.id, 200)
  : Number(account.quotaRemaining || 0);

// Later in decrement logic:
const creditsToDecrement = isQoder ? 1 : creditsUsed;
const quotaAfter = quotaBefore > 0
  ? await pool.decrementQuota(account.id, creditsToDecrement)
  : 0;

// Mark exhausted if Qoder and quota hit 0
if (isQoder && quotaAfter === 0 && quotaBefore > 0) {
  await pool.markExhausted(account.id);
}
```

Apply same logic to stream finalizer (line ~320).

### 3. Prevent Warmup from Overwriting Qoder Quota (`src/auth/warmup-runner.ts`)
In `mapHealthToAccountUpdate()`, skip quota updates for Qoder provider:

```typescript
if (health.quota && account.provider !== "qoder") {
  update.quotaLimit = Number(health.quota.limit || 0);
  update.quotaRemaining = Math.max(0, Number(health.quota.remaining || 0));
  // ... rest of quota logic
}
```

### 4. Initialize Qoder Accounts on First Request
When a Qoder account has `quotaLimit === 0`, initialize it:
- Set `quotaLimit = 200`
- Set `quotaRemaining = 200`
- Set `quotaResetAt = tomorrow midnight`
- Set `status = "active"`

This happens in `checkAndResetDailyQuota()` when `quotaLimit === 0`.

### 5. Round-Robin Rotation
Current system already supports this:
- Default load balancing = round-robin
- `fetchActiveAccounts()` filters `status = "active"`
- Exhausted accounts auto-skipped

**Optional**: Add Qoder-specific default in `getLoadBalancingMethod()`:
```typescript
if (provider === "qoder" && !perProvider.has(provider)) {
  return "sequential"; // Strict rotation A→B→C→D
}
```

## Files to Modify
1. `src/proxy/pool.ts` — Add `checkAndResetDailyQuota()` method
2. `src/proxy/index.ts` — Update quota logic in `handleChatCompletion()` and stream finalizer
3. `src/auth/warmup-runner.ts` — Skip quota overwrite for Qoder

## Verification
1. **Test daily reset**:
   - Set `quotaResetAt` to past date in DB
   - Send request → should reset to 200 and decrement to 199
2. **Test exhaustion**:
   - Manually set `quotaRemaining = 1`
   - Send request → should decrement to 0 and mark exhausted
   - Send another request → should skip exhausted account
3. **Test round-robin**:
   - Send 10 requests with 3 active accounts
   - Verify distribution: 4/3/3 or similar
4. **Test daily reset reactivation**:
   - Mark account exhausted with `quotaRemaining = 0`
   - Set `quotaResetAt` to past
   - Send request → should reactivate and serve

## Edge Cases
- **Multiple concurrent requests**: `decrementQuota()` uses atomic SQL with `MAX(0, ...)` — safe
- **Timezone**: Reset at midnight local time (user's timezone)
- **Account added mid-day**: Initialize with 200 credits, reset tomorrow
- **Warmup runs**: Won't overwrite Qoder quota (provider check)
- **Dashboard**: Shows `200/200`, `199/200`, etc. in ProviderCards

## Notes
- Credits = requests (1 request = 1 credit)
- Token usage still tracked separately for stats
- Other providers (kiro, codebuddy, etc.) unchanged
- User can still override load balancing via settings if needed
