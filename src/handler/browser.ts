import playwright from "playwright";
import type {
	Browser,
	LaunchOptions,
	BrowserContext,
	Response,
} from "playwright";
import type { SpotifyToken } from "../types/spotify";
import { logs } from "../utils/logger";

export class SpotifyBrowser {
	private browser: Browser | undefined;
	private context: BrowserContext | undefined;

	private async ensureBrowser(): Promise<{
		browser: Browser;
		context: BrowserContext;
	}> {
		// kalo browser/context sudah ditutup, re-launch
		if (!this.browser || !this.context) {
			try {
				const executablePath =
					process.env.BROWSER_PATH && process.env.BROWSER_PATH.trim() !== ""
						? process.env.BROWSER_PATH
						: undefined;
				const launchOptions: LaunchOptions = {
					headless: true,
					args: [
						"--disable-gpu",
						"--disable-dev-shm-usage",
						"--disable-setuid-sandbox",
						"--no-sandbox",
						"--no-zygote",
						"--single-process",
						"--disable-background-timer-throttling",
						"--disable-backgrounding-occluded-windows",
						"--disable-renderer-backgrounding",
					],
				};
				if (executablePath) launchOptions.executablePath = executablePath;

				this.browser = await playwright.chromium.launch(launchOptions);
				this.context = await this.browser.newContext({
					userAgent:
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
				});

				const initPage = await this.context.newPage();
				await initPage.goto("https://open.spotify.com/");
				await initPage.close();
			} catch (err) {
				this.browser = undefined;
				this.context = undefined;
				logs("error", "Failed to launch browser or context", err);
				throw err;
			}
		} else {
			// kalo browser/context di closed, re-launch
			if (this.browser.isConnected() === false) {
				logs("warn", "Browser is not connected, relaunching...");
				this.browser = undefined;
				this.context = undefined;
				return this.ensureBrowser();
			}
			try {
				this.context.pages(); // trigger error if context closed
			} catch {
				logs("warn", "Context is closed, relaunching...");
				this.browser = undefined;
				this.context = undefined;
				return this.ensureBrowser();
			}
		}
		return { browser: this.browser, context: this.context };
	}

	public async fetchToken(
		cookies?: Array<{ name: string; value: string }>,
	): Promise<SpotifyToken> {
		const { context } = await this.ensureBrowser();

		return new Promise<SpotifyToken>((resolve, reject) => {
			(async () => {
				const page = await context.newPage();
				let responseReceived = false;

				try {
					await context.clearCookies();

					if (cookies && cookies.length > 0) {
						const cookieObjects = cookies.map((cookie) => ({
							name: cookie.name,
							value: cookie.value,
							domain: ".spotify.com",
							path: "/",
							httpOnly: false,
							secure: true,
							sameSite: "Lax" as const,
						}));
						await context.addCookies(cookieObjects);
						logs(
							"info",
							"Cookies set for request",
							cookieObjects.map((c) => ({
								name: c.name,
								value: `${c.value.slice(0, 20)}...`,
							})),
						);
					}

					const timeout = setTimeout(() => {
						if (!responseReceived) {
							logs("error", "Token fetch timeout");
							page.close();
							reject(new Error("Token fetch exceeded deadline"));
						}
					}, 15000);

					page.on("response", async (response: Response) => {
						if (!response.url().includes("/api/token")) return;

						responseReceived = true;
						clearTimeout(timeout);

						try {
							if (!response.ok()) {
								await page.close();
								return reject(new Error("Invalid response from Spotify"));
							}

							const responseBody = await response.text();
							let json: unknown;
							try {
								json = JSON.parse(responseBody);
							} catch {
								await page.close();
								logs("error", "Failed to parse response JSON");
								return reject(new Error("Failed to parse response JSON"));
							}

							if (
								json &&
								typeof json === "object" &&
								json !== null &&
								"_notes" in json
							) {
								delete (json as Record<string, unknown>)._notes;
							}

							await page.close();
							resolve(json as SpotifyToken);
						} catch (error) {
							await page.close();
							logs("error", `Failed to process token response: ${error}`);
							reject(new Error(`Failed to process token response: ${error}`));
						}
					});

					await page.route("**/*", (route) => {
						const url = route.request().url();
						const type = route.request().resourceType();
						if (
							type === "image" ||
							type === "stylesheet" ||
							type === "font" ||
							type === "media" ||
							type === "websocket" ||
							type === "other"
						) {
							route.abort();
							return;
						}
						if (
							url.includes("google-analytics") ||
							url.includes("doubleclick.net") ||
							url.includes("googletagmanager.com") ||
							url.startsWith("https://open.spotifycdn.com/cdn/images/") ||
							url.startsWith("https://encore.scdn.co/fonts/")
						) {
							route.abort();
							return;
						}
						route.continue();
					});

					await page.goto("https://open.spotify.com/");
				} catch (error) {
					if (!responseReceived) {
						await page.close();
						logs("error", `Navigation failed: ${error}`);
						reject(new Error(`Navigation failed: ${error}`));
					}
				}
			})();
		});
	}

	public async close(): Promise<void> {
		if (this.browser) {
			await this.browser.close();
			this.browser = undefined;
			this.context = undefined;
		}
	}
}
