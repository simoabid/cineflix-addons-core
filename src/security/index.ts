/**
 * Phase 1 security surface — re-exports the public API used by the server
 * and routes so call sites have a single import path.
 */

export {
    redactString,
    redactUrl,
    redactHeaders,
    redactValue,
    maskSecret
} from './redaction.js';

export {
    UrlPolicyError,
    validateOutboundUrl,
    assertUrlSyntax,
    classifyBlockedIp,
    normalizeIpv6,
    policyFromFlags,
    type UrlPolicyOptions,
    type ValidatedUrl
} from './urlPolicy.js';

export {
    secureFetch,
    secureFetchJson,
    sanitizeOutboundHeaders,
    SecureFetchError,
    isPolicyOrSecureError,
    type SecureFetchLimits,
    type SecureFetchResult
} from './secureFetch.js';

export {
    createSecretBox,
    generateMasterKey,
    SecretsError,
    type SecretBox
} from './secrets.js';

export {
    createAuditLogger,
    actorFromAuth,
    type AuditEvent,
    type AuditLogger,
    type AuditOutcome
} from './audit.js';

export {
    makeAuthGuard,
    makeAdminGuard,
    resolveActor,
    roleAtLeast,
    parseRole,
    signServiceJwt,
    verifyServiceJwt,
    signSession,
    verifySession,
    safeEqual,
    generateAdminToken,
    SESSION_COOKIE,
    type Role,
    type AuthMethod,
    type AuthActor,
    type AuthContext,
    type GuardOptions
} from './auth.js';

export {
    createRateLimiter,
    RATE_LIMITS,
    rateLimitKey,
    type RateLimiter,
    type RateLimitResult,
    type RateLimitBucket
} from './rateLimit.js';

export {
    createPlaybackGrantStore,
    grantPublicView,
    GrantCapacityError,
    type PlaybackGrantClaims,
    type PlaybackGrantStore,
    type IssueGrantInput
} from './playbackGrant.js';

export {
    createSecureProxyContext,
    createProxyCapacityGuards,
    registerSecureProxyRoutes,
    type SecureProxyContext
} from './proxyRoute.js';

export {
    registerHttpSecurity,
    applySecurityHeaders,
    assertCorsSafe,
    toSafeError,
    adminCsp,
    buildSessionCookie,
    clearSessionCookie,
    parseCookieHeader
} from './httpSecurity.js';

export {
    generateCsrfToken,
    buildCsrfCookie,
    clearCsrfCookie,
    CSRF_COOKIE,
    CSRF_HEADER
} from './csrf.js';
export { isTrustedPeer } from './auth.js';
