/**
 * Poll until something holds: `until("the server is up", () => probe())` resolves to the probe's first truthy value.
 * A probe that throws counts as "not yet" (its last error becomes the timeout's `cause`). Browser-safe.
 *
 * `sleep` is how it waits between tries — pass Playwright's `page.waitForTimeout` to wait the way the page does.
 */
export async function until<T>(what: string, probe: () => T | Promise<T>, { timeoutMs = 15_000, intervalMs = 100, sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }) }: { "timeoutMs"?: number; "intervalMs"?: number; "sleep"?: (ms: number) => Promise<unknown> } = {}): Promise<NonNullable<T>> {
	const deadline = Date.now() + timeoutMs;
	let last: unknown;

	for (;;) {
		try {
			const value = await probe();

			if (value) {
				return value;
			}
		} catch (error) {
			last = error;
		}

		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for ${what}`, { "cause": last });
		}

		await sleep(intervalMs);
	}
}
