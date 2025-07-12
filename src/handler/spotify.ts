import { SpotifyBrowser } from "./browser";
import { Semaphore } from "../utils/semaphore";
import { logs } from "../utils/logger";
import type { SpotifyToken } from "../types/spotify";
import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { handleRequest } from "./request";

export class SpotifyTokenHandler {
	private semaphore = new Semaphore();
	private accessToken: SpotifyToken | undefined;
	private refreshTimeout: NodeJS.Timeout | undefined;
	private browser = new SpotifyBrowser();

	constructor() {
		const initFetch = Date.now();
		const tryInit = async (attempt = 1) => {
			try {
				const token = await this.getAccessToken();
				this.accessToken = token;
				const elapsed = Date.now() - initFetch;
				logs("info", `Initial Spotify token fetched in ${elapsed}ms`);
			} catch (err) {
				logs(
					"warn",
					`Failed to fetch initial Spotify token (attempt ${attempt})`,
					err,
				);
				if (attempt < 3) {
					setTimeout(() => tryInit(attempt + 1), 2000 * attempt); // retry with backoff
				}
			}
		};
		tryInit();
	}

	// Cleanup method
	public async cleanup(): Promise<void> {
		if (this.refreshTimeout) {
			clearTimeout(this.refreshTimeout);
			this.refreshTimeout = undefined;
		}
		await this.browser.close();
	}

	private setRefresh() {
		if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
		const token = this.accessToken;
		if (!token) return;
		const now = Date.now();
		const expiresIn = token.accessTokenExpirationTimestampMs - now;
		const refreshIn = Math.max(expiresIn + 100, 0); // refresh this trash thing 100ms after expired
		this.refreshTimeout = setTimeout(async () => {
			try {
				const release = await this.semaphore.acquire();
				try {
					const newToken = await this.getAccessToken();
					this.accessToken = newToken;
					logs("info", "Spotify token auto-refreshed (timeout)");
				} finally {
					release();
				}
			} catch (err) {
				logs("warn", "Failed to auto-refresh Spotify token", err);
			}
			this.setRefresh();
		}, refreshIn);
	}

	private getAccessToken = async (
		cookies?: Array<{ name: string; value: string }>,
	): Promise<SpotifyToken> => {
		return new Promise<SpotifyToken>((resolve, reject) => {
			const run = async () => {
				try {
					const token = await this.browser.fetchToken(cookies);
					this.accessToken = token;
					this.setRefresh();
					resolve(token);
				} catch (err) {
					logs("error", "Error in getAccessToken", err);
					reject(err);
				}
			};
			run();
		});
	};

	public honoHandler = async (c: Context): Promise<Response> => {
		const isForce = ["1", "yes", "true"].includes(
			(c.req.query("force") || "").toLowerCase(),
		);
		const connInfo = getConnInfo(c);
		const ip = connInfo?.remote?.address || "unknown";
		const userAgent = c.req.header("user-agent") ?? "no ua";
		const start = Date.now();

		const cookies: Array<{ name: string; value: string }> = [];
		const cookieHeader = c.req.header("cookie");
		if (cookieHeader) {
			const cookiePairs = cookieHeader.split(";");
			for (const pair of cookiePairs) {
				const [name, ...rest] = pair.trim().split("=");
				if (name && rest.length > 0) {
					cookies.push({ name, value: rest.join("=") });
				}
			}
			logs(
				"info",
				`Request with cookies: ${cookies.map((c) => `${c.name}=${c.value}`).join(", ")}`,
			);
		} else {
			logs("info", "Request without cookies");
		}

		const result = await handleRequest(
			c,
			isForce,
			(cookies) => this.getAccessToken(cookies),
			() => this.accessToken,
			(token) => {
				this.accessToken = token;
			},
			this.semaphore,
			cookies,
		);
		const elapsed = Date.now() - start;
		logs(
			"info",
			`Handled Spotify Token request from IP: ${ip}, UA: ${userAgent} (force: ${isForce}) in ${elapsed}ms`,
		);
		return result;
	};
}
