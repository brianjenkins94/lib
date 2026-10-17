/**
 * A browser's OAuth client for a DPoP-bound authorization server (util/auth/dpop on the server side): sign in by a
 * full-page round trip with PKCE, hold the tokens, and make requests with them. Built on oauth4webapi.
 *
 * - A non-extractable ES256 key, made once and kept in IndexedDB: every request carries a proof signed with it, so a
 *   copied token is useless anywhere else.
 * - `signIn` goes to the server's authorization endpoint with a PKCE challenge, the key's thumbprint and a state;
 *   `completeSignIn`, on the way back, checks that state and the server's `iss` (RFC 9207), and redeems the code.
 * - `fetch` sends the access token and a proof, retries a nonce the server asks for, and refreshes the token (one refresh
 *   at a time, however many requests found it stale). A session that can't be refreshed is forgotten, and
 *   `signedOutEvent` dispatched on `window`.
 *
 * Browser only (IndexedDB, localStorage, location), and nothing runs until it's called, so a module that imports it can
 * still be imported in Node. Each app makes its own with `createClient`.
 */
import * as oauth from "oauth4webapi";

export interface ClientOptions {
	/** The authorization server's origin: its issuer, and where its endpoints are. */
	"api": string;
	"clientId": string;
	/** The page the server sends the sign-in back to (one of the client's registered redirect URIs). */
	"redirectUri": () => string;
	/** The authorization endpoint's path. */
	"authorizePath"?: string;
	/** localStorage key for the tokens, sessionStorage key for a sign-in in progress, IndexedDB database for the key. */
	"tokensKey": string;
	"pendingKey": string;
	"database": string;
	/** Dispatched on `window` when the session ends under the app (revoked, or refused a refresh). */
	"signedOutEvent"?: string;
}

interface Tokens { "accessToken": string; "refreshToken": string }

export function createClient({ api, clientId, redirectUri, authorizePath = "/auth/github/start", tokensKey, pendingKey, database: databaseName, signedOutEvent }: ClientOptions) {
	const as: oauth.AuthorizationServer = {
		"issuer": api,
		"authorization_endpoint": `${api}${authorizePath}`,
		"token_endpoint": `${api}/token`,
		"revocation_endpoint": `${api}/revoke`,
		"authorization_response_iss_parameter_supported": true
	};
	const client: oauth.Client = { "client_id": clientId };
	const none = oauth.None();
	const STORE = "keys";

	// ── The key ──────────────────────────────────────────────────────────────────────────────────────────────────

	function database(): Promise<IDBDatabase> {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(databaseName, 1);

			request.onupgradeneeded = () => {
				request.result.createObjectStore(STORE);
			};
			request.onsuccess = () => {
				resolve(request.result);
			};
			request.onerror = () => {
				reject(request.error ?? new Error("IndexedDB wouldn't open"));
			};
		});
	}

	async function keys<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest | undefined): Promise<T> {
		const db = await database();

		return new Promise((resolve, reject) => {
			const transaction = db.transaction(STORE, mode);
			const request = run(transaction.objectStore(STORE));

			transaction.oncomplete = () => {
				resolve(request?.result as T);
			};
			transaction.onerror = () => {
				reject(transaction.error ?? new Error("IndexedDB transaction failed"));
			};
		});
	}

	let keyPair: Promise<CryptoKeyPair> | undefined;

	/** The DPoP key: the stored one, or a new non-extractable one stored. */
	function key(): Promise<CryptoKeyPair> {
		keyPair ??= (async () => {
			const stored = await keys<CryptoKeyPair | undefined>("readonly", (store) => store.get("dpop"));

			if (stored !== undefined) {
				return stored;
			}

			const made = await oauth.generateKeyPair("ES256", { "extractable": false });

			await keys("readwrite", (store) => store.put(made, "dpop"));

			return made;
		})();

		return keyPair;
	}

	/** RFC 7638's thumbprint of the key's public half: what the server binds the sign-in to (`dpop_jkt`). */
	async function thumbprint(publicKey: CryptoKey): Promise<string> {
		const { crv, kty, x, y } = await crypto.subtle.exportKey("jwk", publicKey);
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ crv, kty, x, y })));

		return btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
	}

	/** One DPoP handle for the session: it remembers the server's nonce, so it's asked for once, not on every request. */
	let handle: Promise<oauth.DPoPHandle> | undefined;

	function dpop(): Promise<oauth.DPoPHandle> {
		handle ??= key().then((pair) => oauth.DPoP(client, pair));

		return handle;
	}

	// ── Tokens ───────────────────────────────────────────────────────────────────────────────────────────────────

	function stored(): Tokens | undefined {
		try {
			const raw = localStorage.getItem(tokensKey);

			return raw === null ? undefined : JSON.parse(raw) as Tokens;
		} catch {
			return undefined;
		}
	}

	function store(tokens: oauth.TokenEndpointResponse | undefined): void {
		try {
			if (tokens === undefined || tokens.refresh_token === undefined) {
				localStorage.removeItem(tokensKey);
			} else {
				localStorage.setItem(tokensKey, JSON.stringify({ "accessToken": tokens.access_token, "refreshToken": tokens.refresh_token }));
			}
		} catch {
			/* storage off (private mode): signed in for this page only */
		}
	}

	function isSignedIn(): boolean {
		return stored() !== undefined;
	}

	/** A token-endpoint call, retried once when the server asks for its nonce (the handle has it from the first answer). */
	async function withNonce<T>(request: () => Promise<Response>, process: (response: Response) => Promise<T>): Promise<T> {
		try {
			return await process(await request());
		} catch (error) {
			if (oauth.isDPoPNonceError(error)) {
				return process(await request());
			}

			throw error;
		}
	}

	// ── Signing in and out ───────────────────────────────────────────────────────────────────────────────────────

	/** Off to the server's sign-in. Where we were (its query and fragment too) is restored when we're back. */
	async function signIn(): Promise<void> {
		const verifier = oauth.generateRandomCodeVerifier();
		const state = oauth.generateRandomState();
		const url = new URL(as.authorization_endpoint as string);

		url.search = new URLSearchParams({
			"client_id": client.client_id,
			"response_type": "code",
			"redirect_uri": redirectUri(),
			"state": state,
			"code_challenge": await oauth.calculatePKCECodeChallenge(verifier),
			"code_challenge_method": "S256",
			"dpop_jkt": await thumbprint((await key()).publicKey)
		}).toString();

		sessionStorage.setItem(pendingKey, JSON.stringify({ "verifier": verifier, "state": state, "returnTo": location.href }));
		location.assign(url.href);
	}

	/**
	 * On load: if this page is the end of a sign-in (its state in the URL, ours pending), check it and redeem the code.
	 * The URL goes back to where the sign-in started either way. Throws when the sign-in came back refused or invalid.
	 */
	async function completeSignIn(): Promise<boolean> {
		const raw = sessionStorage.getItem(pendingKey);
		const here = new URL(location.href);

		if (raw === null || !here.searchParams.has("state")) {
			return false;
		}

		sessionStorage.removeItem(pendingKey);

		const pending = JSON.parse(raw) as { "verifier": string; "state": string; "returnTo": string };

		history.replaceState(history.state, "", pending.returnTo);

		const parameters = oauth.validateAuthResponse(as, client, here, pending.state);
		const tokens = await withNonce(
			async () => oauth.authorizationCodeGrantRequest(as, client, none, parameters, redirectUri(), pending.verifier, { "DPoP": await dpop() }),
			async (response) => oauth.processAuthorizationCodeResponse(as, client, response)
		);

		store(tokens);

		return true;
	}

	/** Forget the session in this browser: the tokens, and the key (the next sign-in makes one). Nothing asked of the server. */
	async function forget(): Promise<void> {
		store(undefined);
		keyPair = undefined;
		handle = undefined;
		await keys("readwrite", (store) => store.delete("dpop")).catch(() => undefined);
	}

	/** Forget the session here, and end it at the server (RFC 7009, with a proof from the session's key). */
	async function signOut(): Promise<void> {
		const tokens = stored();

		store(undefined);

		if (tokens !== undefined) {
			// RFC 7009 has no DPoP, but a DPoP server's /revoke wants a proof from the sign-in's key: sent as a resource request.
			const revoke = async (): Promise<Response> => oauth.protectedResourceRequest(tokens.accessToken, "POST", new URL(as.revocation_endpoint as string), new Headers({ "content-type": "application/x-www-form-urlencoded" }), new URLSearchParams({ "token": tokens.refreshToken }).toString(), { "DPoP": await dpop() }).catch((error: unknown) => (error instanceof oauth.WWWAuthenticateChallengeError ? error.response : Response.error()));

			if ((await revoke()).status === 400) {
				await revoke();
			}
		}

		await forget();
	}

	// ── Requests ─────────────────────────────────────────────────────────────────────────────────────────────────

	let refreshing: Promise<boolean> | undefined;

	/** One refresh, however many requests found the access token stale. */
	function refresh(): Promise<boolean> {
		refreshing ??= (async () => {
			const tokens = stored();

			if (tokens === undefined) {
				return false;
			}

			store(await withNonce(
				async () => oauth.refreshTokenGrantRequest(as, client, none, tokens.refreshToken, { "DPoP": await dpop() }),
				async (response) => oauth.processRefreshTokenResponse(as, client, response)
			));

			return true;
		})().catch(() => false).finally(() => {
			refreshing = undefined;
		});

		return refreshing;
	}

	/** One request with the access token and a proof (a nonce the server asks for, retried): its answer, whatever it is. */
	async function send(url: URL, method: string, headers: Headers, body: oauth.ProtectedResourceRequestBody | undefined): Promise<Response> {
		const tokens = stored();

		if (tokens === undefined) {
			return new Response(JSON.stringify({ "error": "not signed in" }), { "status": 401 });
		}

		const request = async (): Promise<Response> => oauth.protectedResourceRequest(tokens.accessToken, method, url, headers, body, { "DPoP": await dpop() });

		for (let attempt = 0; ; attempt += 1) {
			try {
				return await request();
			} catch (error) {
				if (attempt === 0 && oauth.isDPoPNonceError(error)) {
					continue;
				}

				if (error instanceof oauth.WWWAuthenticateChallengeError) {
					return error.response;
				}

				throw error;
			}
		}
	}

	/** A `fetch` for the server: the token and a proof on every request; a stale token refreshed once and retried. */
	const dpopFetch: typeof fetch = async (input, init = {}) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const method = init.method ?? (input instanceof Request ? input.method : "GET");
		const headers = new Headers(init.headers);
		const body = (init.body ?? undefined) as oauth.ProtectedResourceRequestBody | undefined;
		let response = await send(url, method, headers, body);

		if (response.status === 401 && isSignedIn()) {
			response = await refresh() ? await send(url, method, headers, body) : response;

			if (response.status === 401) {
				store(undefined);

				if (signedOutEvent !== undefined) {
					window.dispatchEvent(new CustomEvent(signedOutEvent));
				}
			}
		}

		return response;
	};

	/** A JSON call on the server, signed in (GET, or POST of a form): its answer, or an error naming the path and status. */
	async function json<T>(path: string, form?: Record<string, string>): Promise<T> {
		const response = await dpopFetch(`${api}${path}`, form === undefined ? {} : { "method": "POST", "headers": { "content-type": "application/x-www-form-urlencoded" }, "body": new URLSearchParams(form).toString() });

		if (!response.ok) {
			throw new Error(`${path}: ${response.status}`);
		}

		return response.json() as Promise<T>;
	}

	return { "api": api, isSignedIn, signIn, completeSignIn, signOut, forget, "fetch": dpopFetch, json };
}
