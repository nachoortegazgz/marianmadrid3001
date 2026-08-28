/**
 * =============================================================================
 * FILE: backend/crons.js
 * VERSION: v20.0.0-canonical-dst-safe-crons
 * RESPONSIBILITY: Scheduled background jobs: mutex lock purging, DualSlotCache cleanup,
 * DaysCache cleanup, automated Z-Closing, audit log retention,
 * and system health monitoring.
 * REFACTORED (ITERATION 8 - HARDENED):
 * - Bug Fix (Incidencia 1): Fixed jwtKeyError assignment in catch block.
 * - Safety Limit (Incidencia 2): SSOT page and batch limits in _removeByQuery
 * prevent Wix Jobs timeouts.
 * - Health Check (Incidencia 3): Expanded systemHealthCheck with active locks,
 * pending compensations, and daily ledger integrity.
 * - C-06: cleanExpiredLocks requires the configured Wix Jobs cadence; five-minute cadence requires an eligible Wix plan.
 * - Vector A: Wrapped all NoSQL wixData calls in withTimeout.
 * - G10 Strict: Pure ASCII compliance (0 non-ASCII characters).
 * STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
 * HISTORIAL:
 * - v20.0.0-canonical-dst-safe-crons: Uses canonical _addDaysYMD for deterministic Madrid
 *   yesterday key calculation during automated Z-Closing regardless of UTC skew.
 * - v19.6.15-pending-compensations-recovery: Restores the booking
 *   compensation processor with per-record mutexes and current native revision.
 * - v19.5.1-jobs-observability-ssot: Uses SSOT maintenance limits and reports bounded health-check saturation.
 * - v19.4.8-jobs-ssot-aligned: Uses SSOT job limits and documents Wix Jobs plan-dependent cadence.
 * - v19.2.0-lock-cleanup-hardened: Uses SSOT grace period before removing expired lock leases.
 * - v18.9.0-ultimate: Header standardized during V2 compliance review.
 * =============================================================================
 */

import wixData from 'wix-data';
import { getSecret } from 'wix-secrets-backend';
import { elevate } from 'wix-auth';
import { extendedBookings } from '@wix/bookings';
import {
    makeTraceId,
    withTimeout,
    _addDaysYMD,
} from "public/mmUtils";
import {
    COLLECTIONS,
    CONCURRENCY,
    SDK_CONFIG,
} from "backend/internalConfig";
import {
    _lockSlotKeyOrFail,
    _unlockSlotKey,
    cancelBookingElevated,
    logger,
} from 'backend/booking/bookingCore';
import { _cleanExpiredDualSlotsInternal } from 'backend/reservas.web';
import { _verifyIntegrityInternal, _registerZClosingInternal, processPendingFiscalRecoveries } from 'backend/cajas.web';
import { SECRETS } from 'backend/mmSecrets';
import { processBookingsServiceSyncQueue } from 'backend/bookingsServiceSync';
import { prepareScheduledManagerPackages } from 'backend/fiscalDocuments.web';

const log = logger;
const JOB_TIMEOUT_MS = SDK_CONFIG.JOBS.TIMEOUT_MS;
const AUDIT_RETENTION_DAYS = SDK_CONFIG.JOBS.AUDIT_RETENTION_DAYS;
const DELETE_BATCH_SIZE = SDK_CONFIG.JOBS.DELETE_BATCH_SIZE;
const DELETE_MAX_PAGES = SDK_CONFIG.JOBS.DELETE_MAX_PAGES;
const DUAL_CACHE_CLEANUP_LIMIT = SDK_CONFIG.JOBS.DUAL_CACHE_CLEANUP_LIMIT;
const FISCAL_RECOVERY_BATCH_SIZE = SDK_CONFIG.JOBS.FISCAL_RECOVERY_BATCH_SIZE;
const HEALTH_CHECK_QUERY_LIMIT = SDK_CONFIG.JOBS.HEALTH_CHECK_QUERY_LIMIT;
const COMPENSATION_BATCH_SIZE = Math.max(1, Math.min(FISCAL_RECOVERY_BATCH_SIZE, 100));
const MAX_COMPENSATION_RETRIES = Number(CONCURRENCY.MAX_COMPENSATION_RETRIES) || 3;
const COMPENSATION_LOCK_TTL_MS = Number(CONCURRENCY.MUTEX_TTL_MS) || 120000;
const queryExtendedBookingsElevated = elevate(extendedBookings.queryExtendedBookings);

/**
 * Executes paged removal of documents matching a query builder (I-16).
 * Uses SSOT batch/page limits to bound each execution and prevent serverless timeouts.
 */
async function _removeByQuery(collectionName, queryBuilder, traceId, label) {
    let totalRemoved = 0;
    let hasMore = true;
    let pageCount = 0;
    const maxPages = DELETE_MAX_PAGES;

    try {
        const orderedQuery = queryBuilder.ascending('_id');

        while (hasMore && pageCount < maxPages) {
            pageCount++;

            // VECTOR A: Watchdog en NoSQL query
            const res = await withTimeout(
                orderedQuery.limit(DELETE_BATCH_SIZE).find({ suppressAuth: true }),
                JOB_TIMEOUT_MS,
                `${label}-find`
            );

            const items = res?.items || [];
            if (!items.length) break;

            for (const item of items) {
                // VECTOR A: Watchdog en NoSQL remove
                await withTimeout(
                    wixData.remove(collectionName, item._id, { suppressAuth: true }),
                    JOB_TIMEOUT_MS,
                    `${label}-remove`
                );
                totalRemoved++;
            }

            hasMore = items.length === DELETE_BATCH_SIZE;
        }

        if (pageCount >= maxPages && hasMore) {
            log.warn(`[CRON] ${label} reached max pages limit, remaining items will be processed in next execution`, {
                totalRemoved,
                pageCount,
                traceId
            });
        }

        return { status: 'SUCCESS', data: { count: totalRemoved, pages: pageCount }, error: null };
    } catch (error) {
        log.error(`[CRON] ${label} failed`, { error: error?.message || String(error), traceId });
        return { status: 'ERROR', data: null, error: { code: 'CRON_FAIL', message: error?.message || String(error) } };
    }
}

function _safeCompensationItem(item, patch) {
    const { _createdDate, _updatedDate, _owner, ...safeItem } = item || {};
    return { ...safeItem, ...patch };
}

async function _getBookingForCompensation(bookingId) {
    const result = await withTimeout(
        queryExtendedBookingsElevated({
            filter: { id: String(bookingId) },
            cursorPaging: { limit: 1 },
        }),
        JOB_TIMEOUT_MS,
        'cron-queryExtendedBooking'
    );
    const items = Array.isArray(result?.extendedBookings) ? result.extendedBookings : result?.items;
    return Array.isArray(items) ? items[0]?.booking || null : null;
}

async function _updateBookingCompensation(item, patch) {
    return withTimeout(
        wixData.update(
            COLLECTIONS.COMPENSATIONS,
            _safeCompensationItem(item, patch), { suppressAuth: true }
        ),
        JOB_TIMEOUT_MS,
        'cron-updateBookingCompensation'
    );
}

async function _processBookingCompensation(item, traceId) {
    const bookingId = String(item?.bookingId || '').trim();
    const attempts = Number(item?.attempts || 0) + 1;
    const now = new Date();
    const lockKey = `compensation:${String(item?._id || bookingId)}`;
    const lockOwnerId = `${traceId}:${String(item?._id || bookingId)}`;

    if (!bookingId) {
        await _updateBookingCompensation(item, {
            status: 'FAILED',
            attempts,
            error: 'COMPENSATION_BOOKING_ID_MISSING',
            fechaFallo: now,
            fechaProcesado: now,
        });
        return { completed: 0, failed: 1, skipped: 0 };
    }

    const lock = await _lockSlotKeyOrFail(lockKey, lockOwnerId, COMPENSATION_LOCK_TTL_MS);
    if (!lock?.ok) return { completed: 0, failed: 0, skipped: 1 };

    try {
        const booking = await _getBookingForCompensation(bookingId);
        if (!booking) throw new Error('COMPENSATION_BOOKING_NOT_FOUND');

        if (String(booking.status || '').toUpperCase() !== 'CANCELED') {
            const revision = String(booking.revision || '').trim();
            if (!revision) throw new Error('COMPENSATION_BOOKING_REVISION_MISSING');
            await withTimeout(
                cancelBookingElevated(bookingId, {
                    revision,
                    flowControlSettings: { ignoreCancellationPolicy: true },
                }),
                JOB_TIMEOUT_MS,
                'cron-cancelCompensationBooking'
            );
        }

        await _updateBookingCompensation(item, {
            status: 'COMPLETED',
            attempts,
            error: '',
            fechaProcesado: now,
        });
        return { completed: 1, failed: 0, skipped: 0 };
    } catch (error) {
        const terminal = attempts >= MAX_COMPENSATION_RETRIES;
        const message = String(error?.message || 'COMPENSATION_CANCEL_FAILED');
        await _updateBookingCompensation(item, {
            status: terminal ? 'FAILED' : 'PENDING',
            attempts,
            error: message,
            ...(terminal ? { fechaFallo: now } : {}),
        });
        log.error('[CRON] Booking compensation attempt failed', {
            bookingId,
            traceId,
            attempts,
            terminal,
            message,
        });
        return { completed: 0, failed: terminal ? 1 : 0, skipped: terminal ? 0 : 1 };
    } finally {
        await _unlockSlotKey(lockKey, lockOwnerId).catch((error) => {
            log.error('[CRON] Booking compensation unlock failed', {
                bookingId,
                traceId,
                message: error?.message,
            });
        });
    }
}

export async function runPendingCompensationsJob() {
    const traceId = makeTraceId('cron-compensations');
    try {
        const pending = await withTimeout(
            wixData.query(COLLECTIONS.COMPENSATIONS)
            .eq('status', 'PENDING')
            .ascending('createdAt')
            .limit(COMPENSATION_BATCH_SIZE)
            .find({ suppressAuth: true, consistentRead: true }),
            JOB_TIMEOUT_MS,
            'cron-pendingCompensations'
        );

        const bookingResult = { completed: 0, failed: 0, skipped: 0 };
        const bookingItems = (pending?.items || []).filter((item) => !item?.kind && item?.bookingId);
        for (const item of bookingItems) {
            const result = await _processBookingCompensation(item, traceId);
            bookingResult.completed += result.completed;
            bookingResult.failed += result.failed;
            bookingResult.skipped += result.skipped;
        }

        const fiscalResult = await processPendingFiscalRecoveries({
            traceId,
            limit: FISCAL_RECOVERY_BATCH_SIZE,
        });

        return {
            status: fiscalResult?.status === 'SUCCESS' ? 'SUCCESS' : 'PARTIAL',
            data: {
                scanned: pending?.items?.length || 0,
                bookingCompensations: bookingResult,
                fiscalRecoveries: fiscalResult?.data || null,
            },
            error: fiscalResult?.status === 'SUCCESS' ? null : fiscalResult?.error || null,
        };
    } catch (error) {
        log.error('[CRON] Pending compensations job failed', {
            traceId,
            message: error?.message || String(error),
        });
        return {
            status: 'ERROR',
            data: null,
            error: { code: 'PENDING_COMPENSATIONS_CRON_FAIL', message: error?.message || String(error) },
        };
    }
}

export async function cleanExpiredLocks() {
    const traceId = makeTraceId('cron-locks');
    try {
        const cleanupThreshold = new Date(Date.now() - Number(CONCURRENCY.LOCK_CLEANUP_GRACE_MS));
        const result = await _removeByQuery(
            COLLECTIONS.LOCKS,
            wixData.query(COLLECTIONS.LOCKS).lt('expiresAt', cleanupThreshold),
            traceId,
            'cron-cleanLocks'
        );
        return result;
    } catch (error) {
        log.error('[CRON] Failed to clean expired locks', { error: error?.message || String(error), traceId });
        return { status: 'ERROR', data: null, error: { code: 'CRON_FAIL', message: error?.message || String(error) } };
    }
}

export async function cleanupExpiredDualCache() {
    const traceId = makeTraceId('cron-dual');
    try {
        const res = await _cleanExpiredDualSlotsInternal({ limit: DUAL_CACHE_CLEANUP_LIMIT, traceId });
        return res;
    } catch (error) {
        log.error('[CRON] Failed to clean expired dual slots', { error: error?.message || String(error), traceId });
        return { status: 'ERROR', data: null, error: { code: 'CRON_FAIL', message: error?.message || String(error) } };
    }
}

export async function cleanExpiredDaysCache() {
    const traceId = makeTraceId('cron-dayscache');
    try {
        const nowObj = new Date();
        const result = await _removeByQuery(
            COLLECTIONS.DAYS_CACHE,
            wixData.query(COLLECTIONS.DAYS_CACHE).lt('expiresAt', nowObj),
            traceId,
            'cron-cleanDaysCache'
        );
        return result;
    } catch (error) {
        log.error('[CRON] Failed to clean expired days cache', { error: error?.message || String(error), traceId });
        return { status: 'ERROR', data: null, error: { code: 'CRON_FAIL', message: error?.message || String(error) } };
    }
}

export async function cleanExpiredSlotsCache() {
    const traceId = makeTraceId('cron-slotscache');
    try {
        const nowObj = new Date();
        const result = await _removeByQuery(
            COLLECTIONS.SLOTS_CACHE,
            wixData.query(COLLECTIONS.SLOTS_CACHE).lt('expiresAt', nowObj),
            traceId,
            'cron-cleanSlotsCache'
        );
        return result;
    } catch (error) {
        log.error('[CRON] Failed to clean expired slots cache', { error: error?.message || String(error), traceId });
        return { status: 'ERROR', data: null, error: { code: 'CRON_FAIL', message: error?.message || String(error) } };
    }
}
export async function processFiscalRecoveryQueue() {
    const traceId = makeTraceId('cron-fiscal-recovery');
    try {
        return await processPendingFiscalRecoveries({ traceId, limit: FISCAL_RECOVERY_BATCH_SIZE });
    } catch (error) {
        log.error('[CRON] Fiscal recovery queue failed', { error: error?.message || String(error), traceId });
        return { status: 'ERROR', data: null, error: { code: 'FISCAL_RECOVERY_CRON_FAIL', message: error?.message || String(error) } };
    }
}

export async function processBookingsServiceSyncJob() {
    const traceId = makeTraceId('cron-bookings-service-sync');
    try {
        return await processBookingsServiceSyncQueue({ traceId });
    } catch (_) {
        log.error('[CRON] Bookings service sync job failed', { traceId, errorCode: 'BOOKINGS_SERVICE_SYNC_JOB_FAILED' });
        return { status: 'ERROR', data: null, error: { code: 'BOOKINGS_SERVICE_SYNC_JOB_FAILED', message: 'Bookings service synchronization failed.' } };
    }
}

export async function prepareManagerPackagesJob() {
    const traceId = makeTraceId('cron-manager-packages');
    try {
        return await withTimeout(
            prepareScheduledManagerPackages({ traceId }),
            JOB_TIMEOUT_MS,
            'cron-prepareManagerPackages'
        );
    } catch (error) {
        log.error('[CRON] Scheduled manager-package preparation failed', {
            traceId,
            message: error?.message || String(error),
        });
        return {
            status: 'ERROR',
            data: null,
            error: { code: 'MANAGER_PACKAGE_CRON_FAIL', message: 'Document preparation failed.' },
        };
    }
}

export async function verifyNightlyZClosing() {
    const traceId = makeTraceId('cron-zclosing');
    try {
        const tz = SDK_CONFIG?.TZ || 'Europe/Madrid';
        const nowMadridYmd = new Date().toLocaleDateString('sv-SE', { timeZone: tz });
        const diaKey = _addDaysYMD(nowMadridYmd, -1);

        if (!diaKey) {
            throw new Error("No se pudo calcular la fecha previa para el cierre Z nocturno.");
        }

        // VECTOR A: Watchdog en NoSQL query
        const existing = await withTimeout(
            wixData.query(COLLECTIONS.HISTORICO_CIERRES_Z).eq('_id', `Z_${diaKey}`).limit(1).find({ suppressAuth: true }),
            JOB_TIMEOUT_MS,
            'cron-checkZClosing'
        );

        if (existing.items?.length > 0) {
            return { status: 'SUCCESS', data: { idempotent: true, diaKey }, error: null };
        }

        const integrity = await _verifyIntegrityInternal(diaKey, { traceId });
        if (!integrity || !integrity.integrityOk) {
            log.error('[CRON] Integrity violation, Z-Closing aborted', { diaKey, inconsistencies: integrity?.inconsistencies, traceId });
            return { status: 'ERROR', data: null, error: { code: 'INTEGRITY_VIOLATION', message: 'Integrity violation' } };
        }

        const zResult = await _registerZClosingInternal(diaKey, { traceId, autoCron: true });
        return zResult;
    } catch (error) {
        log.error('[CRON] Auto Z-Closing error', { error: error?.message || String(error), traceId });
        return { status: 'ERROR', data: null, error: { code: 'CRON_FAIL', message: error?.message || String(error) } };
    }
}

export async function cleanAuditLogs() {
    const traceId = makeTraceId('cron-audit');
    try {
        const cutoff = new Date(Date.now() - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
        const result = await _removeByQuery(
            COLLECTIONS.AUDIT_LOG,
            wixData.query(COLLECTIONS.AUDIT_LOG).lt('fechaLog', cutoff),
            traceId,
            'cron-cleanAudit'
        );
        return result;
    } catch (error) {
        log.error('[CRON] Failed to clean audit logs', { error: error?.message || String(error), traceId });
        return { status: 'ERROR', data: null, error: { code: 'CRON_FAIL', message: error?.message || String(error) } };
    }
}

export async function systemHealthCheck() {
    const traceId = makeTraceId('cron-health');
    let overallStatus = 'OK';
    const details = {};

    try {
        // 1. Validar acceso a CITAS
        const citaRes = await withTimeout(
            wixData.query(COLLECTIONS.CITAS).limit(1).find({ suppressAuth: true }),
            JOB_TIMEOUT_MS,
            'cron-healthCheck-citas'
        ).catch(() => null);
        details.citasAccessible = !!citaRes;
        if (!citaRes) {
            overallStatus = 'WARNING';
            details.citasError = 'Empty response from CITAS collection';
        }

        // 2. Validar secretos
        try {
            const fiscalKey = await getSecret(SECRETS.FISCAL_KEY);
            details.fiscalKeyExists = !!fiscalKey;
            if (!fiscalKey) {
                overallStatus = 'WARNING';
                details.fiscalKeyError = 'FISCAL_KEY secret is empty or not set';
            }
        } catch (secretError) {
            overallStatus = 'WARNING';
            details.fiscalKeyError = secretError?.message || String(secretError);
        }

        try {
            const jwtKey = await getSecret(SECRETS.AUTH_JWT_KEY);
            details.jwtKeyExists = !!jwtKey;
            if (!jwtKey) {
                overallStatus = 'WARNING';
                details.jwtKeyError = 'AUTH_JWT_KEY secret is empty or not set';
            }
        } catch (secretError) {
            overallStatus = 'WARNING';
            // INCIDENCIA 1: CORREGIDA ASIGNACION A jwtKeyError
            details.jwtKeyError = secretError?.message || String(secretError);
        }

        // 3. INCIDENCIA 3: Deteccion de cerrojos activos
        const nowObj = new Date();
        const activeLocksRes = await withTimeout(
            wixData.query(COLLECTIONS.LOCKS).ge('expiresAt', nowObj).limit(HEALTH_CHECK_QUERY_LIMIT).find({ suppressAuth: true }),
            JOB_TIMEOUT_MS,
            'cron-healthCheck-activeLocks'
        ).catch(() => null);
        details.activeLocksCount = activeLocksRes?.items?.length || 0;
        details.activeLocksHasMore = !!activeLocksRes?.hasNext?.();
        if (details.activeLocksCount >= HEALTH_CHECK_QUERY_LIMIT || details.activeLocksHasMore) {
            overallStatus = 'WARNING';
            details.locksWarning = `Active locks reached the bounded health-check limit: ${details.activeLocksCount}`;
        } else if (details.activeLocksCount > 50) {
            overallStatus = 'WARNING';
            details.locksWarning = `High number of active locks: ${details.activeLocksCount}`;
        }

        // 4. INCIDENCIA 3: Deteccion de compensaciones pendientes
        const compensationsRes = await withTimeout(
            wixData.query(COLLECTIONS.COMPENSATIONS).eq('status', 'PENDING').limit(HEALTH_CHECK_QUERY_LIMIT).find({ suppressAuth: true }),
            JOB_TIMEOUT_MS,
            'cron-healthCheck-compensations'
        ).catch(() => null);
        details.pendingCompensationsCount = compensationsRes?.items?.length || 0;
        details.pendingCompensationsHasMore = !!compensationsRes?.hasNext?.();
        if (details.pendingCompensationsCount >= HEALTH_CHECK_QUERY_LIMIT || details.pendingCompensationsHasMore) {
            overallStatus = 'WARNING';
            details.compensationsWarning = `Pending compensations reached the bounded health-check limit: ${details.pendingCompensationsCount}`;
        } else if (details.pendingCompensationsCount > 10) {
            overallStatus = 'WARNING';
            details.compensationsWarning = `High number of pending compensations: ${details.pendingCompensationsCount}`;
        }

        // 5. M365 permanece pausado expresamente hasta una autorizacion de Fase 2.
        details.m365GraphSyncEnabled = SDK_CONFIG?.M365?.ENABLED === true;
        if (!details.m365GraphSyncEnabled) {
            details.m365GraphSyncState = 'PAUSED_PHASE_1';
            details.pendingM365GraphSyncCount = 0;
            details.blockedM365GraphSyncCount = 0;
        } else {
            const m365SyncRes = await withTimeout(
                wixData.query(COLLECTIONS.M365_GRAPH_SYNC_QUEUE).in('status', ['PENDING', 'RETRY', 'BLOCKED']).limit(HEALTH_CHECK_QUERY_LIMIT).find({ suppressAuth: true }),
                JOB_TIMEOUT_MS,
                'cron-healthCheck-m365GraphSync'
            ).catch(() => null);
            details.pendingM365GraphSyncCount = m365SyncRes?.items?.length || 0;
            details.pendingM365GraphSyncHasMore = !!m365SyncRes?.hasNext?.();
            details.blockedM365GraphSyncCount = (m365SyncRes?.items || []).filter((item) => item?.status === 'BLOCKED').length;
            if (details.pendingM365GraphSyncCount >= HEALTH_CHECK_QUERY_LIMIT || details.pendingM365GraphSyncHasMore || details.blockedM365GraphSyncCount > 0) {
                overallStatus = 'WARNING';
                details.m365GraphSyncWarning = 'External registry queue requires configuration or review.';
            }
        }

        // 6. INCIDENCIA 3: Integridad del libro diario del dia actual
        const tz = SDK_CONFIG?.TZ || 'Europe/Madrid';
        const todayYmd = nowObj.toLocaleDateString('sv-SE', { timeZone: tz });
        const integrity = await _verifyIntegrityInternal(todayYmd, { traceId });
        details.ledgerIntegrityOk = integrity?.integrityOk || false;
        if (!integrity?.integrityOk) {
            overallStatus = 'ERROR';
            details.ledgerError = 'Integrity violation detected in todays ledger';
        }

        // 7. Validar acceso a BookingTransactions
        const txRes = await withTimeout(
            wixData.query(COLLECTIONS.TRANSACTIONS).limit(1).find({ suppressAuth: true }),
            JOB_TIMEOUT_MS,
            'cron-healthCheck-tx'
        ).catch(() => null);
        details.bookingTransactionsAccessible = !!txRes;

        // 8. Validar acceso a DaysCache
        const daysCacheRes = await withTimeout(
            wixData.query(COLLECTIONS.DAYS_CACHE).limit(1).find({ suppressAuth: true }),
            JOB_TIMEOUT_MS,
            'cron-healthCheck-daysCache'
        ).catch(() => null);
        details.daysCacheAccessible = !!daysCacheRes;

        return { status: overallStatus, data: details, error: null };
    } catch (error) {
        log.error('[CRON] System health check failed', { error: error?.message || String(error), traceId });
        return { status: 'ERROR', data: null, error: { code: 'CRON_FAIL', message: error?.message || String(error) } };
    }
}