/**
 * dsh-toolcall-id — make tool call ids unique within a session.
 *
 * Bug fixed: the Web GUI conversation registry keys tool-call contexts by the
 * raw provider callId (see dsh-client-ui-conversation toolDefinition.match).
 * openai-completions providers (e.g. NVIDIA NIM) repeat ids like "read:0" on
 * every step, so history replay throws
 * "conversation Context 9:tool-callread:0 received more than one start Match"
 * and the transcript fails to load for any multi-step session.
 *
 * Fix: wrap the `llm/stream` waterfall and rewrite a tool call id when it was
 * already used by an earlier request in the same session. One rewrite touches
 * every downstream copy at once — `tool-call-delta` chunks, the assembled
 * tool-call block in `block-end`, the persisted assistant message, and the
 * `tool/call` / `tool/result` session events — because all of them are built
 * from this stream. Ids that are already unique pass through untouched.
 */

const name = "dsh-toolcall-id";

/**
 * Per-session state: ids already consumed by earlier requests.
 * `seeded` marks that persisted history (turns from before a dsh restart)
 * has been folded in — without it a resumed session re-issues suffixes that
 * collide with ids already written to the durable log.
 * @typedef {{used: Set<string>, counter: number, seeded: boolean}} SessionState
 */

/** @type {Map<string, SessionState>} */
const sessions = new Map();

/**
 * Resolve one provider-side id to its session-canonical id.
 * Collisions (and empty ids from providers that omit them) get a "~n" suffix.
 * @param {SessionState} state
 * @param {Map<string, string>} streamMap - original -> canonical, per request
 * @param {string} id
 * @returns {string}
 */
function resolveId(state, streamMap, id) {
	const cached = streamMap.get(id);
	if (cached !== undefined) return cached;
	let canonical = id;
	if (id === "" || state.used.has(id)) {
		do {
			canonical = `${id || "call"}~${++state.counter}`;
		} while (state.used.has(canonical));
	}
	state.used.add(canonical);
	streamMap.set(id, canonical);
	return canonical;
}

/**
 * Copy a chunk with rewritten tool call ids, or pass it through unchanged.
 * @param {SessionState} state
 * @param {Map<string, string>} streamMap
 * @param {object} chunk
 * @returns {object}
 */
function rewriteChunk(state, streamMap, chunk) {
	if (chunk == null || typeof chunk !== "object") return chunk;
	if (chunk.type === "tool-call-delta" && typeof chunk.id === "string") {
		const canonical = resolveId(state, streamMap, chunk.id);
		return canonical === chunk.id ? chunk : { ...chunk, id: canonical };
	}
	if (chunk.type === "block-end" && chunk.block?.type === "tool-call") {
		const id = chunk.block.id;
		if (typeof id !== "string") return chunk;
		const canonical = resolveId(state, streamMap, id);
		return canonical === id ? chunk : { ...chunk, block: { ...chunk.block, id: canonical } };
	}
	return chunk;
}

/**
 * Wrap one downstream model stream, rewriting duplicate tool call ids.
 * Mirrors the `yield* next()` idiom of dsh-session-checkpoint-policy.
 * @param {SessionState} state
 * @param {AsyncIterable<object>} inner
 */
async function* wrapStream(state, inner) {
	const streamMap = new Map();
	for await (const chunk of inner) {
		yield rewriteChunk(state, streamMap, chunk);
	}
}

/**
 * Fold already-persisted tool-call ids of this session into `used`.
 * Without this, resuming a session after a dsh restart would regenerate the
 * same "~n" suffixes that earlier turns already wrote to the durable log,
 * re-breaking history replay. Done once per session, lazily; never throws.
 * @param {object} ctx - cordis ctx (needs the sessions service via inject)
 * @param {string} sessionId
 * @param {SessionState} state
 */
function seedFromHistory(ctx, sessionId, state) {
	if (state.seeded) return;
	state.seeded = true;
	try {
		const session = ctx.sessions?.get?.(sessionId);
		if (!session) return;
		for (const event of session.snapshotEvents?.() ?? session.events ?? []) {
			if (event.type === "tool/call" && typeof event.data?.callId === "string") {
				state.used.add(event.data.callId);
			} else if (event.type === "assistant/message") {
				for (const block of event.data?.message?.content ?? []) {
					if (block?.type === "tool-call" && typeof block.id === "string") {
						state.used.add(block.id);
					}
				}
			}
		}
		// Never regenerate a suffix that history might already own.
		state.counter = state.used.size;
	} catch {
		// seeding is best-effort; in-memory dedupe still applies
	}
}

/**
 * Cordis plugin entry: join every model request's stream.
 * @param {object} ctx
 */
function apply(ctx) {
	ctx.on("llm/stream", (options, next) => {
		const key = typeof options?.sessionId === "string" ? options.sessionId : "default";
		let state = sessions.get(key);
		if (state === undefined) {
			state = { used: new Set(), counter: 0, seeded: false };
			sessions.set(key, state);
		}
		seedFromHistory(ctx, key, state);
		return wrapStream(state, next());
	}, { global: true });
}

/** sessions service supplies the durable event log for history seeding. */
const inject = ["sessions"];

export { apply, inject, name };
