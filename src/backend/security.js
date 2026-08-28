/**
 * =============================================================================
 * MODULE: backend/security.js
 * VERSION: v19.5.1-rbac-ssot-cleanup
 * RESPONSIBILITY: RBAC (roles + allowlists) and surface-scoped sliding window rate limiter.
 * HISTORIAL DE VERSIONES:
 *   - v19.5.1-rbac-ssot-cleanup: Centralizes cache limits and removes unused Members-role authorization helpers.
 *   - v18.0.0: Version inicial.
  * - v19.4.4: Removed module-global currentMember memoization to prevent cross-request identity reuse.
 * - v18.9.1: Refactorizacion, optimizacion y cumplimiento G10 ASCII Strict.
 * =============================================================================
 */

import { getSecret } from 'wix-secrets-backend';
import { currentMember } from 'wix-members-backend';
import {
    COLLAB_ROLES,
    SDK_CONFIG,
    STAFF_ACCESS,
} from "backend/internalConfig";
import { findStaff } from "backend/staff";
import { withTimeout } from "public/mmUtils";
import { SECRETS } from 'backend/mmSecrets';
import { logger } from 'backend/booking/bookingCore';
import { hmacSha256Hex as generateHMAC, verifyHMAC, timingSafeEqual } from 'backend/securityEngine';

const log = logger;

let _adminsCache = null;
let _cajerosCache = null;
let _cacheLoadedAt = 0;
const CACHE_TTL_MS = Number(SDK_CONFIG?.SECURITY?.SECRET_CACHE_TTL_MS) || 300000;
const MEMBER_FETCH_TIMEOUT_MS = Number(SDK_CONFIG?.TIMEOUTS?.API_MS) || 15000;

const _rateLimitCache = new Map();
const RATE_LIMIT_CLEANUP_TTL_MS = Number(SDK_CONFIG?.SECURITY?.RATE_LIMIT_CACHE_CLEANUP_TTL_MS) || 60000;
const MAX_RATE_LIMIT_CACHE_SIZE = Number(SDK_CONFIG?.SECURITY?.RATE_LIMIT_CACHE_MAX_ENTRIES) || 5000;
let _rateLimitLastCleanup = 0;

export { generateHMAC, verifyHMAC, timingSafeEqual };

function _makeAccessDeniedError(code, message, meta) {
    const err = new Error(message);
    err.code = code || 'ACCESS_DENIED';
    if (meta && typeof meta === 'object') err.meta = meta;
    return err;
}

function _throwAccessDenied(code, message, meta) {
    throw _makeAccessDeniedError(code, message, meta);
}

function _roleMatches(role, allowedNamesUpper, allowedIds) {
    if (!role || typeof role !== 'object') return false;

    const roleId = String(role._id || role.id || '').trim();
    if (roleId && Array.isArray(allowedIds) && allowedIds.includes(roleId)) return true;

    const roleName = String(role.name || role.title || '').trim().toUpperCase();
    if (roleName && Array.isArray(allowedNamesUpper) && allowedNamesUpper.includes(roleName)) return true;

    return false;
}

async function _getMemberFull(traceId) {
    // Do not cache currentMember at module scope: a warm serverless instance can serve different users.
    return withTimeout(
        currentMember.getMember({ fieldsets: ['FULL'] }),
        MEMBER_FETCH_TIMEOUT_MS,
        'getMemberFull'
    ).catch((error) => {
        log.warn('RBAC member fetch failed', { traceId, error: error?.message });
        return null;
    });
}

function _pruneExpiredRateLimitEntries(now) {
    for (const [cacheKey, cacheEntry] of _rateLimitCache) {
        const lastSeen = cacheEntry.lastSeen || cacheEntry.windowStart;
        if (now - lastSeen > cacheEntry.windowMs) _rateLimitCache.delete(cacheKey);
    }
    _rateLimitLastCleanup = now;
}

function _ensureRateLimitCapacity(now) {
    if (_rateLimitCache.size < MAX_RATE_LIMIT_CACHE_SIZE) return;

    _pruneExpiredRateLimitEntries(now);
    if (_rateLimitCache.size < MAX_RATE_LIMIT_CACHE_SIZE) return;

    let oldestKey = null;
    let oldestLastSeen = Number.POSITIVE_INFINITY;
    for (const [cacheKey, cacheEntry] of _rateLimitCache) {
        const lastSeen = Number(cacheEntry.lastSeen || cacheEntry.windowStart) || 0;
        if (lastSeen < oldestLastSeen) {
            oldestLastSeen = lastSeen;
            oldestKey = cacheKey;
        }
    }

    if (oldestKey) _rateLimitCache.delete(oldestKey);
}

export function rateLimiter(key, maxRequests, windowMs) {
    const now = Date.now();

    const maxReq = Number.isFinite(maxRequests) ?
        Number(maxRequests) :
        Number(SDK_CONFIG?.RATE_LIMIT?.MAX_REQUESTS || 20);

    const winMs = Number.isFinite(windowMs) ?
        Number(windowMs) :
        Number(SDK_CONFIG?.RATE_LIMIT?.WINDOW_MS || 5000);

    if (now - _rateLimitLastCleanup > RATE_LIMIT_CLEANUP_TTL_MS) {
        _pruneExpiredRateLimitEntries(now);
    }

    let surface = 'default';
    let rawKey = key;

    if (key && typeof key === 'object') {
        surface = String(key.surface || 'default').trim() || 'default';
        rawKey = key.key;
    }

    const cleanRaw = String(rawKey ?? '').trim() || 'anon:empty';
    const k = `${surface}:${cleanRaw}`;

    const entry = _rateLimitCache.get(k);
    if (!entry || now - entry.windowStart > entry.windowMs) {
        if (!entry) _ensureRateLimitCapacity(now);
        _rateLimitCache.set(k, { count: 1, windowStart: now, windowMs: winMs, lastSeen: now });
        return { allowed: true, retryAfter: 0 };
    }

    entry.lastSeen = now;
    entry.count++;

    if (entry.count > maxReq) {
        const retryAfter = entry.windowMs - (now - entry.windowStart);
        return { allowed: false, retryAfter: Math.max(0, retryAfter) };
    }

    return { allowed: true, retryAfter: 0 };
}

export function clearRateLimitCache() {
    _rateLimitCache.clear();
    _rateLimitLastCleanup = 0;
}

function _parseEmails(csv) {
    return String(csv || '')
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean);
}

async function _loadCachesIfNeeded(traceId) {
    const now = Date.now();
    if (_cacheLoadedAt && now - _cacheLoadedAt < CACHE_TTL_MS && Array.isArray(_adminsCache) && Array.isArray(_cajerosCache)) {
        return { ok: true };
    }

    try {
        const [adminsRaw, cajerosRaw] = await Promise.all([
            getSecret(SECRETS.ADMIN_EMAILS).catch(() => ''),
            getSecret(SECRETS.CAJERO_EMAILS).catch(() => '')
        ]);

        _adminsCache = _parseEmails(adminsRaw);
        _cajerosCache = _parseEmails(cajerosRaw);
        _cacheLoadedAt = now;
        return { ok: true };
    } catch (error) {
        log.error('RBAC error loading secrets', { traceId, error: error?.message });
        _adminsCache = [];
        _cajerosCache = [];
        _cacheLoadedAt = now;
        return { ok: false };
    }
}

export async function isAdmin(traceId = 'unknown') {
    const member = await _getMemberFull(traceId);
    if (!member) return false;

    const roles = member.roles || [];
    if (!Array.isArray(roles) || roles.length === 0) {
        log.warn('isAdmin: member.roles is empty or invalid', { traceId, memberId: member._id });
    }

    const adminNames = [String(COLLAB_ROLES.ADMIN || '').toUpperCase()];
    const adminIds = [];
    if (roles.some((r) => _roleMatches(r, adminNames, adminIds))) return true;

    const email = String(member.loginEmail || '').trim().toLowerCase();
    const cache = await _loadCachesIfNeeded(traceId);
    return cache.ok && _adminsCache.includes(email);
}

export async function isCajero(traceId = 'unknown') {
    const member = await _getMemberFull(traceId);
    if (!member) return false;

    const roles = member.roles || [];
    if (!Array.isArray(roles) || roles.length === 0) {
        log.warn('isCajero: member.roles is empty or invalid', { traceId, memberId: member._id });
    }

    const cajeroNames = [String(COLLAB_ROLES.ADMIN || '').toUpperCase(), String(COLLAB_ROLES.GESTION || '').toUpperCase()];
    const cajeroIds = [];
    if (roles.some((r) => _roleMatches(r, cajeroNames, cajeroIds))) return true;

    const email = String(member.loginEmail || '').trim().toLowerCase();
    const cache = await _loadCachesIfNeeded(traceId);
    return cache.ok && (_adminsCache.includes(email) || _cajerosCache.includes(email));
}

export async function isMarianManager(traceId = 'unknown') {
    if (!await isAdmin(traceId)) return false;

    const member = await _getMemberFull(traceId);
    if (!member) return false;

    const email = String(member.loginEmail || member.email || '').trim().toLowerCase();
    const staff = await findStaff(email) || await findStaff(member._id);
    return String(staff?.resourceId || '') === String(STAFF_ACCESS.MARIAN_RESOURCE_ID || '');
}

export async function requireMarianManager(traceId = 'unknown') {
    if (!await isMarianManager(traceId)) {
        _throwAccessDenied('MARIAN_MANAGER_REQUIRED', 'Acceso exclusivo de Marian requerido.', { traceId });
    }
    return true;
}

export async function isStaffCollaborator(traceId = 'unknown') {
    const member = await _getMemberFull(traceId);
    if (!member) return false;

    const roles = member.roles || [];
    if (!Array.isArray(roles) || roles.length === 0) {
        log.warn('isStaffCollaborator: member.roles is empty or invalid', { traceId, memberId: member._id });
    }

    const allowedNames = [COLLAB_ROLES.ADMIN, COLLAB_ROLES.GESTION, COLLAB_ROLES.ESTILISTA].map((r) => String(r || '').toUpperCase());
    const allowedIds = [];
    if (roles.some((r) => _roleMatches(r, allowedNames, allowedIds))) return true;

    // Emergency or dashboard access can be granted through the same controlled
    // allowlists used by requireAdmin() and requireCajero(). This prevents the
    // frontend panel from rejecting a legitimate manager only because Wix role
    // propagation has not completed yet.
    const email = String(member.loginEmail || member.email || '').trim().toLowerCase();
    const cache = await _loadCachesIfNeeded(traceId);
    return cache.ok && (_adminsCache.includes(email) || _cajerosCache.includes(email));
}

export async function requireAdmin(traceId = 'unknown') {
    const activeTraceId = traceId || 'rbac';

    const member = await _getMemberFull(activeTraceId);
    if (!member) {
        _throwAccessDenied('AUTH_REQUIRED', 'ACCESS_DENIED: Login required for this operation.', {
            traceId: activeTraceId
        });
    }

    const roles = member.roles || [];
    const adminNames = [String(COLLAB_ROLES.ADMIN || '').toUpperCase()];
    const adminIds = [];
    if (roles.some((r) => _roleMatches(r, adminNames, adminIds))) return true;

    const memberEmail = String(member.loginEmail || '').trim().toLowerCase();

    const cache = await _loadCachesIfNeeded(activeTraceId);
    if (cache.ok && _adminsCache.includes(memberEmail)) return true;

    _throwAccessDenied('ADMIN_REQUIRED', 'ACCESS_DENIED: Admin privileges required.', {
        traceId: activeTraceId
    });
}

export async function requireCajero(traceId = 'unknown') {
    const activeTraceId = traceId || 'rbac';

    const member = await _getMemberFull(activeTraceId);
    if (!member) {
        _throwAccessDenied('AUTH_REQUIRED', 'ACCESS_DENIED: Login required for cashier operations.', {
            traceId: activeTraceId
        });
    }

    const roles = member.roles || [];
    const cajeroNames = [String(COLLAB_ROLES.ADMIN || '').toUpperCase(), String(COLLAB_ROLES.GESTION || '').toUpperCase()];
    const cajeroIds = [];
    if (roles.some((r) => _roleMatches(r, cajeroNames, cajeroIds))) return true;

    const memberEmail = String(member.loginEmail || '').trim().toLowerCase();

    const cache = await _loadCachesIfNeeded(activeTraceId);
    if (cache.ok && (_cajerosCache.includes(memberEmail) || _adminsCache.includes(memberEmail))) return true;

    _throwAccessDenied('CAJERO_REQUIRED', 'ACCESS_DENIED: Cashier privileges required.', {
        traceId: activeTraceId
    });
}

export async function requireStaffCollaborator(traceId = 'unknown') {
    const ok = await isStaffCollaborator(traceId);
    if (!ok) {
        _throwAccessDenied('COLLAB_REQUIRED', 'ACCESS_DENIED: Collaborator role required (ADMIN/GESTION/ESTILISTA)', {
            traceId
        });
    }
}
