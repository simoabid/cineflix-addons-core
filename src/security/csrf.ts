import { randomBytes } from 'node:crypto';

export const CSRF_COOKIE = 'csrf_token';
export const CSRF_HEADER = 'x-csrf-token';

export function generateCsrfToken(): string {
    return randomBytes(32).toString('base64url');
}

export function buildCsrfCookie(token: string, secure: boolean): string {
    const parts = [
        `${CSRF_COOKIE}=${encodeURIComponent(token)}`,
        'Path=/',
        'SameSite=Lax'
    ];
    if (secure) parts.push('Secure');
    // Not HttpOnly so JS can read for header injection
    return parts.join('; ');
}

export function clearCsrfCookie(secure: boolean): string {
    const parts = [
        `${CSRF_COOKIE}=`,
        'Path=/',
        'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
        'SameSite=Lax'
    ];
    if (secure) parts.push('Secure');
    return parts.join('; ');
}
