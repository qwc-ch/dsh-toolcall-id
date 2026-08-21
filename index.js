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
 * @typedef {{used: Set<string>, counter: number}} SessionState
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
		canonical = `${id || "call"}~${++state.counter}`;
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
 * Cordis plugin entry: join every model request's stream.
 * @param {object} ctx
 */
function apply(ctx) {
	ctx.on("llm/stream", (options, next) => {
		const key = typeof options?.sessionId === "string" ? options.sessionId : "default";
		let state = sessions.get(key);
		if (state === undefined) {
			state = { used: new Set(), counter: 0 };
			sessions.set(key, state);
		}
		return wrapStream(state, next());
	}, { global: true });
}

export { apply, name };
