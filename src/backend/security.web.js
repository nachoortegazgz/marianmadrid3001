/**
 * =============================================================================
 * FILE: backend/security.web.js
 * VERSION: v18.8.16-strict
 * RESPONSIBILITY: Web-module facade for RBAC checks (thin wrapper).
 *
 * CHANGES (v18.8.16):
 * - Propagate typed error codes from backend/security.js (err.code) when available.
 * - Keep stable {status,data,error} contract for widgets/pages.
 * - Keep Permissions.SiteMember (forced login pattern).
 * HISTORIAL:
 * - v18.8.16-strict: Header standardized during V2 compliance review.
 * =============================================================================
 */
import { webMethod, Permissions } from "wix-web-module";
import {
    isAdmin,
    isCajero,
    isMarianManager,
    isStaffCollaborator,
    requireAdmin as requireAdminInternal
} from 'backend/security';

function _toPublicError(err, fallbackCode = 'ACCESS_DENIED', fallbackMessage = 'Acceso denegado.') {
    const code = String(err?.code || fallbackCode);
    const message = String(err?.message || fallbackMessage);

    // Never leak internal meta; keep it minimal.
    return { code, message };
}

export const checkStaffCollaboratorAccess = webMethod(
    Permissions.SiteMember,
    async (traceId = 'staff-access') => {
        try {
            const ok = await isStaffCollaborator(traceId);
            if (!ok) {
                return {
                    status: 'ERROR',
                    data: null,
                    error: {
                        code: 'COLLAB_REQUIRED',
                        message: 'Acceso denegado. Se requieren permisos de empleado.'
                    }
                };
            }

            const [admin, cajero, marianManager] = await Promise.all([
                isAdmin(traceId),
                isCajero(traceId),
                isMarianManager(traceId),
            ]);
            return {
                status: 'SUCCESS',
                data: { isAdmin: !!admin, isCajero: !!cajero, isMarianManager: !!marianManager },
                error: null,
            };
        } catch (err) {
            return { status: 'ERROR', data: null, error: _toPublicError(err, 'ACCESS_DENIED') };
        }
    }
);

export const requireAdmin = webMethod(
    Permissions.SiteMember,
    async (traceId = 'require-admin') => {
        try {
            await requireAdminInternal(traceId);
            return { status: 'SUCCESS', data: true, error: null };
        } catch (err) {
            return { status: 'ERROR', data: null, error: _toPublicError(err, 'ADMIN_REQUIRED') };
        }
    }
);
