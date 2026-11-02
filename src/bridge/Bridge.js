/**
 * Passthough Mashup V1 — Fase 0.2.1
 * Bridge: main-thread intermediary for bidirectional communication
 * between Worker A and Worker B.
 *
 * - Does NOT talk to the mGBA core.
 * - Does NOT use SharedArrayBuffer / Atomics / Pthreads.
 * - Origin is determined by the real Worker instance that posted the message,
 *   not solely by the envelope.origin field.
 */

import {
  WORKER_IDS,
  createEnvelope,
  validateEnvelope
} from "./MessageProtocol.js";

/**
 * @typedef {"A"|"B"} WorkerId
 */

/**
 * Minimal interface expected from a worker wrapper:
 * - raw: the underlying Worker
 * - request(type, payload?, transfer?): Promise
 */
export class Bridge {
  /**
   * @param {object} workerA - wrapper with .raw (Worker)
   * @param {object} workerB - wrapper with .raw (Worker)
   * @param {object} [options]
   * @param {(event: object) => void} [options.onLog]
   * @param {(event: object) => void} [options.onMessage]
   * @param {(event: object) => void} [options.onReject]
   */
  constructor(workerA, workerB, options = {}) {
    this._workers = {
      A: workerA,
      B: workerB
    };
    this._onLog = options.onLog || (() => {});
    this._onMessage = options.onMessage || (() => {});
    this._onReject = options.onReject || (() => {});

    /** @type {Map<string, number>} recent messageIds for basic duplicate detection */
    this._recentIds = new Map();
    this._maxRecent = 2000;

    /** @type {Map<string, {resolve: Function, reject: Function, timeout: any}>} */
    this._pending = new Map();

    this._boundHandlers = {
      A: (event) => this._handleWorkerMessage("A", event),
      B: (event) => this._handleWorkerMessage("B", event)
    };

    this._attach();
  }

  _attach() {
    for (const id of WORKER_IDS) {
      const w = this._workers[id];
      if (!w || !w.raw) {
        throw new Error(`Bridge: worker ${id} is missing or has no .raw Worker`);
      }
      w.raw.addEventListener("message", this._boundHandlers[id]);
    }
  }

  /**
   * Detach listeners. Call when the Bridge is no longer needed.
   */
  destroy() {
    for (const id of WORKER_IDS) {
      const w = this._workers[id];
      if (w && w.raw) {
        w.raw.removeEventListener("message", this._boundHandlers[id]);
      }
    }
    for (const [, entry] of this._pending) {
      clearTimeout(entry.timeout);
      entry.reject(new Error("Bridge destroyed"));
    }
    this._pending.clear();
    this._recentIds.clear();
  }

  /**
   * Register a waiter for the response that the destination Worker will send
   * after receiving a bridge message (inReplyTo === messageId).
   * Call this BEFORE the source Worker emits via bridgeEmit.
   *
   * @param {string} messageId
   * @param {number} [timeoutMs=5000]
   * @returns {Promise<object>} response envelope from the destination Worker
   */
  /**
   * Register a waiter for the response to messageId.
   * expectedResponder / expectedReplyTo are normally filled by _deliver when
   * the original envelope is known. They may also be supplied here for tests
   * that inject forged responses without a real deliver.
   *
   * @param {string} messageId
   * @param {number} [timeoutMs=5000]
   * @param {{ expectedResponder?: string, expectedReplyTo?: string }} [routing]
   * @returns {Promise<object>}
   */
  expectResponse(messageId, timeoutMs = 5000, routing = {}) {
    if (typeof messageId !== "string" || !messageId) {
      return Promise.reject(new Error("expectResponse: messageId is required"));
    }
    if (this._pending.has(messageId)) {
      return Promise.reject(new Error(`expectResponse: already waiting for ${messageId}`));
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pending.delete(messageId);
        reject(new Error(`Bridge timeout waiting for response to ${messageId}`));
      }, timeoutMs);
      this._pending.set(messageId, {
        resolve,
        reject,
        timeout,
        expectedResponder: routing.expectedResponder || null,
        expectedReplyTo: routing.expectedReplyTo || null,
        originalMessageId: messageId
      });
    });
  }

  /**
   * Convenience: main-thread initiated send (kept for utility / secondary checks).
   * Primary proof of Worker↔Worker must use bridgeEmit from the Workers.
   *
   * @param {WorkerId} origin
   * @param {WorkerId} destination
   * @param {string} type
   * @param {unknown} [payload]
   * @param {object} [opts]
   * @param {string} [opts.correlationId]
   * @param {number} [opts.timeoutMs=5000]
   * @returns {Promise<object>}
   */
  send(origin, destination, type, payload = null, opts = {}) {
    if (!WORKER_IDS.includes(origin) || !WORKER_IDS.includes(destination)) {
      return Promise.reject(new Error("Bridge.send: invalid origin or destination"));
    }
    if (origin === destination) {
      return Promise.reject(new Error("Bridge.send: origin and destination must differ"));
    }

    const envelope = createEnvelope({
      origin,
      destination,
      type,
      payload,
      correlationId: opts.correlationId
    });

    const validation = validateEnvelope(envelope);
    if (!validation.valid) {
      this._onReject({ reason: validation.reason, envelope, source: "Bridge.send" });
      return Promise.reject(new Error(validation.reason));
    }

    return this._deliver(envelope, opts.timeoutMs ?? 5000);
  }

  /**
   * Post envelope to destination Worker and wait for its bridgeResponse.
   * If a pending entry for envelope.messageId already exists (from expectResponse),
   * it is reused instead of being overwritten.
   *
   * @param {object} envelope
   * @param {number} timeoutMs
   * @returns {Promise<object>}
   */
  _deliver(envelope, timeoutMs) {
    const dest = envelope.destination;
    const worker = this._workers[dest];
    if (!worker || !worker.raw) {
      return Promise.reject(new Error(`Bridge: destination Worker ${dest} not available`));
    }

    const responseId = envelope.messageId;
    // Who must answer, and who the reply must be addressed to.
    const expectedResponder = envelope.destination;
    const expectedReplyTo = envelope.origin;

    const promise = new Promise((resolve, reject) => {
      if (this._pending.has(responseId)) {
        // Already registered via expectResponse — piggy-back and record routing.
        const existing = this._pending.get(responseId);
        existing.expectedResponder = expectedResponder;
        existing.expectedReplyTo = expectedReplyTo;
        existing.originalMessageId = responseId;
        const origResolve = existing.resolve;
        const origReject = existing.reject;
        existing.resolve = (value) => {
          origResolve(value);
          resolve(value);
        };
        existing.reject = (err) => {
          origReject(err);
          reject(err);
        };
      } else {
        const timeout = setTimeout(() => {
          this._pending.delete(responseId);
          reject(new Error(`Bridge timeout waiting for response to ${responseId}`));
        }, timeoutMs);
        this._pending.set(responseId, {
          resolve,
          reject,
          timeout,
          expectedResponder,
          expectedReplyTo,
          originalMessageId: responseId
        });
      }
    });

    this._onLog({
      direction: "out",
      from: envelope.origin,
      to: dest,
      type: envelope.type,
      messageId: envelope.messageId
    });

    worker.raw.postMessage({
      type: "bridge",
      envelope
    });

    return promise;
  }

  /**
   * Handle any message coming from a real Worker.
   * @param {WorkerId} realOrigin
   * @param {MessageEvent} event
   */
  _handleWorkerMessage(realOrigin, event) {
    const data = event.data;
    if (!data || typeof data !== "object") return;

    if (data.type === "bridgeOut") {
      this._handleBridgeOut(realOrigin, data.envelope);
      return;
    }

    if (data.type === "bridgeResponse") {
      this._handleBridgeResponse(realOrigin, data);
      return;
    }

    // Emulator request/response protocol — ignored by the Bridge.
  }

  /**
   * A Worker emitted a bridge message via bridgeOut.
   * Only the origin field is forced from the real Worker instance.
   * protocolVersion, messageId and timestamp are mandatory on the original
   * envelope and are NOT filled in automatically.
   * @param {WorkerId} realOrigin
   * @param {object} envelope
   */
  _handleBridgeOut(realOrigin, envelope) {
    if (!envelope || typeof envelope !== "object") {
      this._onReject({
        reason: "bridgeOut without a valid envelope object",
        source: realOrigin
      });
      return;
    }

    // Force only the real origin. Do not invent missing required fields.
    const corrected = {
      ...envelope,
      origin: realOrigin
    };

    const validation = validateEnvelope(corrected);
    if (!validation.valid) {
      this._onReject({
        reason: validation.reason,
        envelope: corrected,
        source: realOrigin
      });
      return;
    }

    if (this._recentIds.has(corrected.messageId)) {
      this._onReject({
        reason: `Duplicate messageId: ${corrected.messageId}`,
        envelope: corrected,
        source: realOrigin
      });
      return;
    }
    this._rememberId(corrected.messageId);

    this._onLog({
      direction: "in",
      from: realOrigin,
      to: corrected.destination,
      type: corrected.type,
      messageId: corrected.messageId
    });

    this._onMessage({
      envelope: corrected,
      realOrigin
    });

    // Forward to the destination Worker. If the test already called
    // expectResponse(messageId), that promise will be resolved by the
    // destination's bridgeResponse.
    this._deliver(corrected, 8000).catch((err) => {
      this._onReject({
        reason: err.message,
        envelope: corrected,
        source: "forward"
      });
    });
  }

  /**
   * Handle a response that a Worker produced after receiving a "bridge" message.
   *
   * Before resolving expectResponse:
   * - realOrigin must be the original destination (expectedResponder)
   * - response destination must be the original origin (expectedReplyTo)
   * - data.inReplyTo and envelope.correlationId (when present) must both match
   *   the original messageId; correlationId is not overwritten before this check
   *
   * @param {WorkerId} realOrigin
   * @param {object} data
   */
  _handleBridgeResponse(realOrigin, data) {
    const envelope = data.envelope;
    const topInReplyTo = data.inReplyTo;
    const envCorrelation =
      envelope && typeof envelope === "object" ? envelope.correlationId : undefined;

    // Resolve the correlation key without mutating the envelope yet.
    const inReplyTo =
      (typeof topInReplyTo === "string" && topInReplyTo) ||
      (typeof envCorrelation === "string" && envCorrelation) ||
      null;

    if (!inReplyTo) {
      this._onReject({
        reason: "bridgeResponse missing inReplyTo / correlation",
        source: realOrigin,
        data
      });
      return;
    }

    // If both are present, they must agree with each other and with the pending key.
    if (
      typeof topInReplyTo === "string" &&
      typeof envCorrelation === "string" &&
      topInReplyTo !== envCorrelation
    ) {
      this._onReject({
        reason: "bridgeResponse inReplyTo and correlationId diverge",
        source: realOrigin,
        inReplyTo: topInReplyTo,
        correlationId: envCorrelation
      });
      // Do not resolve or reject the pending solely from a divergent pair that
      // may not even address the pending key; only touch pending if it matches.
      const maybePending = this._pending.get(topInReplyTo) || this._pending.get(envCorrelation);
      if (maybePending) {
        // Leave pending intact so the legitimate responder can still complete.
        this._onLog({
          direction: "rejected-divergent-correlation",
          from: realOrigin,
          topInReplyTo,
          envCorrelation
        });
      }
      return;
    }

    const pending = this._pending.get(inReplyTo);
    if (!pending) {
      this._onLog({
        direction: "late-or-unknown-response",
        from: realOrigin,
        inReplyTo
      });
      return;
    }

    const originalMessageId = pending.originalMessageId || inReplyTo;

    // Both identifiers, when present, must match the original messageId.
    if (typeof topInReplyTo === "string" && topInReplyTo !== originalMessageId) {
      this._onReject({
        reason: `bridgeResponse inReplyTo does not match original messageId (${topInReplyTo} !== ${originalMessageId})`,
        source: realOrigin,
        inReplyTo: topInReplyTo
      });
      return;
    }
    if (typeof envCorrelation === "string" && envCorrelation !== originalMessageId) {
      this._onReject({
        reason: `bridgeResponse correlationId does not match original messageId (${envCorrelation} !== ${originalMessageId})`,
        source: realOrigin,
        correlationId: envCorrelation
      });
      return;
    }

    // Require the answering Worker to be the original destination.
    if (
      pending.expectedResponder &&
      realOrigin !== pending.expectedResponder
    ) {
      this._onReject({
        reason: `bridgeResponse from wrong Worker: got ${realOrigin}, expected ${pending.expectedResponder}`,
        source: realOrigin,
        inReplyTo,
        expectedResponder: pending.expectedResponder
      });
      // Do NOT resolve or reject the promise — the correct Worker may still answer.
      return;
    }

    if (!envelope || typeof envelope !== "object") {
      clearTimeout(pending.timeout);
      this._pending.delete(inReplyTo);
      pending.reject(new Error("bridgeResponse without a valid envelope object"));
      this._onReject({
        reason: "bridgeResponse without a valid envelope object",
        source: realOrigin,
        inReplyTo
      });
      return;
    }

    // Force real origin only after correlation / responder checks.
    const responseEnvelope = {
      ...envelope,
      origin: realOrigin,
      correlationId: originalMessageId
    };

    // Reply must be addressed to the original sender.
    if (
      pending.expectedReplyTo &&
      responseEnvelope.destination !== pending.expectedReplyTo
    ) {
      this._onReject({
        reason: `bridgeResponse destination mismatch: got ${responseEnvelope.destination}, expected ${pending.expectedReplyTo}`,
        source: realOrigin,
        inReplyTo,
        envelope: responseEnvelope
      });
      // Do not resolve; leave pending for a correct reply or timeout.
      return;
    }

    if (responseEnvelope.destination === realOrigin) {
      this._onReject({
        reason: "bridgeResponse destination equals responder",
        source: realOrigin,
        inReplyTo,
        envelope: responseEnvelope
      });
      return;
    }

    const validation = validateEnvelope(responseEnvelope);
    if (!validation.valid) {
      const coreFail =
        String(validation.reason).includes("protocolVersion") ||
        String(validation.reason).includes("messageId") ||
        String(validation.reason).includes("timestamp") ||
        String(validation.reason).includes("type") ||
        String(validation.reason).includes("must be a non-null");
      if (coreFail) {
        clearTimeout(pending.timeout);
        this._pending.delete(inReplyTo);
        pending.reject(new Error(`Invalid bridgeResponse: ${validation.reason}`));
        this._onReject({
          reason: validation.reason,
          envelope: responseEnvelope,
          source: realOrigin,
          inReplyTo
        });
        return;
      }
    }

    clearTimeout(pending.timeout);
    this._pending.delete(inReplyTo);

    this._onLog({
      direction: "response",
      from: realOrigin,
      inReplyTo,
      type: responseEnvelope.type
    });

    this._onMessage({
      envelope: responseEnvelope,
      realOrigin,
      isResponse: true
    });

    pending.resolve(responseEnvelope);
  }

  _rememberId(id) {
    this._recentIds.set(id, Date.now());
    if (this._recentIds.size > this._maxRecent) {
      const first = this._recentIds.keys().next().value;
      this._recentIds.delete(first);
    }
  }
  }
