/**
 * =============================================================================
 * MODULE: backend/securityEngine.js
 * VERSION: v18.9.1-ultimate
 * RESPONSIBILITY: Cryptographic engine (HMAC-SHA256, hash chains, timing-safe equal, and JWT).
 * HISTORIAL DE VERSIONES:
 *   - v18.0.0: Version inicial.
 *   - v18.9.1: Refactorizacion, optimizacion y cumplimiento G10 ASCII Strict.
 * =============================================================================
 */

import { createHmac, createHash, timingSafeEqual as nativeTimingSafeEqual } from 'crypto';
import { getSecret } from 'wix-secrets-backend';
import {
    makeTraceId,
} from "public/mmUtils";
import {
    JWT,
} from "backend/internalConfig";
import { SECRETS } from 'backend/mmSecrets';
import { logger } from 'backend/booking/bookingCore';

const log = logger;

function _stringifySafe(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;

    const seen = new WeakSet();

    try {
        return JSON.stringify(value, function (key, val) {
            if (typeof val === 'bigint') return String(val);
            if (typeof val === 'object' && val !== null) {
                if (seen.has(val)) return '[Circular]';
                seen.add(val);
            }
            return val;
        });
    } catch (_) {
        try {
            return String(value);
        } catch (e2) {
            return '';
        }
    }
}

export function hmacSha256Hex(secretKey, payload) {
    if (!secretKey || typeof secretKey !== 'string') {
        throw new Error('SECURITY_ALERT: Valid secretKey required for HMAC generation');
    }
    if (payload === null || payload === undefined) {
        throw new Error('SECURITY_ALERT: Valid payload required for HMAC generation');
    }
    const s = typeof payload === 'string' ? payload : _stringifySafe(payload);
    return createHmac('sha256', secretKey).update(s).digest('hex');
}

export function timingSafeEqual(a, b) {
    if (a === null || a === undefined || b === null || b === undefined) return false;
    const strA = String(a);
    const strB = String(b);
    const bufA = Buffer.from(strA, 'utf8');
    const bufB = Buffer.from(strB, 'utf8');

    try {
        if (bufA.length !== bufB.length) {
            nativeTimingSafeEqual(bufA, bufA);
            return false;
        }
        return nativeTimingSafeEqual(bufA, bufB);
    } catch (_) {
        const maxLen = Math.max(bufA.length, bufB.length);
        let result = bufA.length ^ bufB.length;
        for (let i = 0; i < maxLen; i++) {
            const valA = i < bufA.length ? bufA[i] : 0;
            const valB = i < bufB.length ? bufB[i] : 0;
            result |= valA ^ valB;
        }
        return result === 0;
    }
}

export function verifyHMAC(secretKey, payload, signature) {
    try {
        if (typeof signature !== 'string') return false;
        const expected = hmacSha256Hex(secretKey, payload);
        return timingSafeEqual(signature, expected);
    } catch (_) {
        return false;
    }
}

export function hashSHA256(data) {
    const rawStr = _stringifySafe(data);
    return createHash('sha256').update(rawStr).digest('hex');
}

export function hashChain(previousHash, currentData) {
    if (!previousHash || typeof previousHash !== 'string') {
        throw new Error('SECURITY_ALERT: Valid previousHash required for chain hashing');
    }
    const safeData = _stringifySafe(currentData);
    return hashSHA256(`${previousHash}|${safeData}`);
}

function _base64UrlEncode(str) {
    return Buffer.from(String(str), 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

function _base64UrlDecode(str) {
    if (typeof str !== 'string') return '';
    const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    const pad = base64.length % 4;
    const padded = pad ? base64 + '='.repeat(4 - pad) : base64;
    try {
        return Buffer.from(padded, 'base64').toString('utf8');
    } catch (_) {
        return '';
    }
}

function _signJWT(secretKey, data) {
    return createHmac('sha256', secretKey)
        .update(String(data), 'utf8')
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

async function _getJwtSecretOrThrow(traceId) {
    const secretKey = await getSecret(SECRETS.AUTH_JWT_KEY).catch(() => '');
    if (!secretKey) {
        log.error('AUTH_JWT_KEY missing in Secrets Manager', { traceId });
        throw new Error('SECURITY_ALERT: Missing AUTH_JWT_KEY secret');
    }
    return String(secretKey);
}

export async function generarToken(payload, traceId) {
    const activeTraceId = traceId || makeTraceId('jwt-gen');
    if (!payload || typeof payload !== 'object') {
        throw new Error('INVALID_PAYLOAD: Payload object required for token generation');
    }

    const secretKey = await _getJwtSecretOrThrow(activeTraceId);
    const header = { alg: (JWT && JWT.ALGORITHM) ? JWT.ALGORITHM : 'HS256', typ: 'JWT' };

    const now = Math.floor(Date.now() / 1000);
    const expirationMs = (JWT && JWT.EXPIRATION_MS) ? JWT.EXPIRATION_MS : 30 * 60 * 1000;
    const exp = now + Math.floor(expirationMs / 1000);

    const safePayload = { ...payload };
    delete safePayload.exp;
    delete safePayload.iat;
    delete safePayload.jti;

    const jwtPayload = { ...safePayload, iat: now, exp, jti: makeTraceId('jti') };

    const encodedHeader = _base64UrlEncode(_stringifySafe(header));
    const encodedPayload = _base64UrlEncode(_stringifySafe(jwtPayload));
    const signature = _signJWT(secretKey, `${encodedHeader}.${encodedPayload}`);

    return `${encodedHeader}.${encodedPayload}.${signature}`;
}

export async function verificarToken(token, traceId) {
    const activeTraceId = traceId || makeTraceId('jwt-verify');

    try {
        if (!token || typeof token !== 'string') return null;

        const parts = token.split('.');
        if (parts.length !== 3) return null;

        const encodedHeader = parts[0];
        const encodedPayload = parts[1];
        const signature = parts[2];

        let header;
        try {
            header = JSON.parse(_base64UrlDecode(encodedHeader));
        } catch (_) {
            return null;
        }

        const targetAlg = (JWT && JWT.ALGORITHM) ? JWT.ALGORITHM : 'HS256';
        if (!header || String(header.alg || '').toUpperCase() !== String(targetAlg).toUpperCase()) return null;

        const secretKey = await _getJwtSecretOrThrow(activeTraceId);
        const expectedSignature = _signJWT(secretKey, `${encodedHeader}.${encodedPayload}`);
        if (!timingSafeEqual(signature, expectedSignature)) return null;

        let payload;
        try {
            payload = JSON.parse(_base64UrlDecode(encodedPayload));
        } catch (_) {
            return null;
        }

        const exp = Number(payload && payload.exp);
        const iat = Number(payload && payload.iat);
        if (!Number.isFinite(exp) || !Number.isFinite(iat)) return null;

        const now = Math.floor(Date.now() / 1000);
        if (iat > now + 60) return null;
        if (exp <= now) return null;

        return payload;
    } catch (error) {
        log.error('Failed to verify JWT token', { error: error && error.message ? error.message : String(error), traceId: activeTraceId });
        return null;
    }
}

export async function requireValidToken(token, traceId) {
    const activeTraceId = traceId || makeTraceId('jwt-require');
    const payload = await verificarToken(token, activeTraceId);
    if (!payload) throw new Error('INVALID_OR_EXPIRED_TOKEN: JWT token validation failed');
    return payload;
}