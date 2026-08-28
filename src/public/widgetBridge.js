/**
 * =============================================================================
 * MODULE: public/widgetBridge.js
 * VERSION: v19.6.14-retryable-ready-context
 * RESPONSIBILITY: Centralized postMessage transport between Velo pages and HTML
 *                 widgets with a READY handshake and safe context fallback.
 * STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
 * HISTORIAL:
 * - v19.6.15-proactive-context-fallback: Re-sends context through a bounded fallback when a legacy widget emits READY before Velo attaches its listener.
 * - v19.6.14-retryable-ready-context: Allows a later nonce-free READY retry to reload context after a transient preparation failure.
 * - v19.6.7-ready-only-context: Sends context only after the HTML component confirms READY.
 * - v19.4.4: Requires serviceId in all public widget context.
 * - v19.4.0: Removes nonce coupling, deduplicates context loading, uses SSOT
 *             timeouts, and delivers context after a bounded READY fallback.
 * - v19.3.2: Prior bridge implementation.
 * =============================================================================
 */

import {
    MESSAGE_TYPES,
    UI,
    makeTraceId,
    _safeTrim,
    _safeSlugOrId,
    _looksLikeGuid,
} from "public/mmUtils";

function _normalizeType(rawType) {
    return String(rawType || "").trim().toUpperCase();
}

function _pickServiceId(contextData) {
    if (!contextData || typeof contextData !== "object") return null;

    const candidate = contextData.serviceId || null;
    const clean = _safeTrim(candidate);
    return clean && _looksLikeGuid(clean) ? clean : null;
}

export function createWidgetBridge(widgetElement, options = {}) {
    const traceId = options.traceId || makeTraceId("bridge");
    const slug = _safeSlugOrId(options.slug || "") || "unknown";

    if (!widgetElement || typeof widgetElement.postMessage !== "function") {
        const error = new Error("[widgetBridge] HTML widget component not found or incompatible.");
        if (typeof options.onError === "function") options.onError(error);
        return null;
    }

    const handshakeTimeoutMs = Number(options.handshakeTimeoutMs) || UI.HANDSHAKE_TIMEOUT_MS;
    const contextTimeoutMs = Number(options.contextTimeoutMs) || UI.CONTEXT_TIMEOUT_MS;
    const requiresServiceId = options.requiresServiceId !== false;

    let handshakeAcked = false;
    let contextSent = false;
    let contextPromise = null;
    let unsubscribe = null;
    let handshakeTimer = null;
    let contextFallbackTimer = null;
    let contextFallbackSent = false;

    function clearTimer(name) {
        if (name === "handshake" && handshakeTimer) {
            clearTimeout(handshakeTimer);
            handshakeTimer = null;
        }
        if (name === "contextFallback" && contextFallbackTimer) {
            clearTimeout(contextFallbackTimer);
            contextFallbackTimer = null;
        }
    }

    function clearTimers() {
        clearTimer("handshake");
        clearTimer("contextFallback");
    }

    function post(type, payload = {}, messageId = null) {
        const normalizedType = _normalizeType(type);
        if (!normalizedType) return;

        try {
            const message = {
                type: normalizedType,
                payload: {
                    ...(payload || {}),
                    traceId,
                },
            };
            if (messageId) message.messageId = messageId;
            widgetElement.postMessage(message);
        } catch (error) {
            console.warn("[widgetBridge] postMessage to widget failed:", error?.message || String(error));
        }
    }

    function _loadContext() {
        if (contextPromise) return contextPromise;

        contextPromise = Promise.resolve()
            .then(() => {
                if (typeof options.onContextReady !== "function") return {};
                return options.onContextReady();
            })
            .then((contextData) => {
                const data = contextData && typeof contextData === "object" ? contextData : {};
                const serviceId = _pickServiceId(data);

                if (requiresServiceId && !serviceId) {
                    throw new Error("[widgetBridge] serviceId is missing or invalid.");
                }

                return {
                    ...data,
                    serviceId,
                    slug,
                };
            });

        return contextPromise.catch((error) => {
            contextPromise = null;
            throw error;
        });
    }

    async function postContext() {
        if (!handshakeAcked || contextSent) return;

        try {
            const context = await Promise.race([
                _loadContext(),
                new Promise((_, reject) => {
                    setTimeout(() => reject(new Error("[widgetBridge] Context timeout.")), contextTimeoutMs);
                }),
            ]);

            if (contextSent) return;
            post(MESSAGE_TYPES.CONTEXT, context);
            contextSent = true;
        } catch (error) {
            console.error("[widgetBridge] Failed to prepare widget context:", error?.message || String(error));
            if (typeof options.onError === "function") options.onError(error);
        }
    }

    function armHandshakeWatchdog() {
        clearTimer("handshake");
        handshakeTimer = setTimeout(() => {
            if (handshakeAcked || contextSent || contextFallbackSent) return;
            const error = new Error("[widgetBridge] Handshake timeout: widget did not send READY.");
            if (typeof options.onError === "function") options.onError(error);
        }, handshakeTimeoutMs);
    }

    function armContextFallback() {
        clearTimer("contextFallback");
        let attempt = 0;

        const tick = async () => {
            if (handshakeAcked || contextSent || attempt >= UI.HANDSHAKE_MAX_ATTEMPTS) return;
            attempt += 1;

            try {
                const context = await Promise.race([
                    _loadContext(),
                    new Promise((_, reject) => {
                        setTimeout(() => reject(new Error("[widgetBridge] Context fallback timeout.")), contextTimeoutMs);
                    }),
                ]);
                post(MESSAGE_TYPES.CONTEXT, context);
                contextFallbackSent = true;
            } catch (error) {
                console.warn("[widgetBridge] Context fallback failed:", error?.message || String(error));
            }

            if (!handshakeAcked && !contextSent && attempt < UI.HANDSHAKE_MAX_ATTEMPTS) {
                contextFallbackTimer = setTimeout(
                    tick,
                    UI.HANDSHAKE_BASE_BACKOFF_MS * Math.pow(2, attempt - 1)
                );
            }
        };

        contextFallbackTimer = setTimeout(tick, UI.HANDSHAKE_BASE_BACKOFF_MS);
    }

    const handler = async (event) => {
        const message = event?.data || event || {};
        const type = _normalizeType(message.type || message.action);
        const messageId = message.messageId || null;
        if (!type) return;

        if (type === _normalizeType(MESSAGE_TYPES.READY)) {
            handshakeAcked = true;
            clearTimer("handshake");
            clearTimer("contextFallback");
            post(MESSAGE_TYPES.READY, { status: "ACK" }, messageId);
            await postContext();
            return;
        }

        if (typeof options.onWidgetMessage !== "function") return;

        try {
            const reply = (responseType, responsePayload, replyMessageId) => {
                post(responseType, responsePayload, replyMessageId || messageId);
            };
            await options.onWidgetMessage(message, reply);
        } catch (error) {
            console.error("[widgetBridge] onWidgetMessage error:", error?.message || String(error));
            if (typeof options.onError === "function") options.onError(error);
        }
    };

    try {
        unsubscribe = widgetElement.onMessage(handler);
    } catch (error) {
        console.error("[widgetBridge] widgetElement.onMessage failed:", error?.message || String(error));
        if (typeof options.onError === "function") options.onError(error);
    }

    armHandshakeWatchdog();
    armContextFallback();

    return {
        post,
        postContext,
        getTraceId: () => traceId,
        isReady: () => contextSent,
        destroy: () => {
            clearTimers();
            try {
                if (typeof unsubscribe === "function") unsubscribe();
            } catch (_) {
                // Safe disposal when Wix returns no unsubscribe handler.
            }
            unsubscribe = null;
        },
    };
}
