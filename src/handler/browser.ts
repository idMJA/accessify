import playwright from "playwright";
import type {
	Browser,
	LaunchOptions,
	BrowserContext,
	Response,
	Page,
} from "playwright";
import type { SpotifyToken } from "../types/spotify";
import { logs } from "../utils/logger";

export class SpotifyBrowser {
	private browser: Browser | undefined;
	private context: BrowserContext | undefined;
	private persistentPage: Page | undefined;

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
						"--disable-extensions",
						"--disable-background-timer-throttling",
						"--disable-blink-features=AutomationControlled",
						"--disable-backgrounding-occluded-windows",
						"--disable-renderer-backgrounding",
						"--window-size=1920,1080",
					],
				};
				if (executablePath) launchOptions.executablePath = executablePath;

				this.browser = await playwright.chromium.launch(launchOptions);
				this.context = await this.browser.newContext({
					userAgent:
						"Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
				});

				this.persistentPage = await this.context.newPage();
				this.persistentPage.goto("https://open.spotify.com/");
				logs("info", "Persistent page created and navigated to Spotify");
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
				let page = this.persistentPage;
				let shouldClosePage = false;

				if (!page || page.isClosed()) {
					page = await context.newPage();
					shouldClosePage = true;
				}

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
							if (shouldClosePage) page.close();
							reject(new Error("Token fetch exceeded deadline"));
						}
					}, 15000);

					page.on("response", async (response: Response) => {
						if (!response.url().includes("/api/token")) return;

						responseReceived = true;
						clearTimeout(timeout);

						try {
							if (!response.ok()) {
								if (shouldClosePage) await page.close();
								return reject(new Error("Invalid response from Spotify"));
							}

							const responseBody = await response.text();
							let json: unknown;
							try {
								json = JSON.parse(responseBody);
							} catch {
								if (shouldClosePage) await page.close();
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

							if (shouldClosePage) await page.close();
							resolve(json as SpotifyToken);
						} catch (error) {
							if (shouldClosePage) await page.close();
							logs("error", `Failed to process token response: ${error}`);
							reject(new Error(`Failed to process token response: ${error}`));
						}
					});

					await page.route("**/*", (route) => {
						const url = route.request().url();
						const type = route.request().resourceType();

						const blockedTypes = new Set([
							"image",
							"stylesheet",
							"font",
							"media",
							"websocket",
							"other",
						]);

						const blockedPatterns = [
							"google-analytics",
							"doubleclick.net",
							"googletagmanager.com",
							"https://open.spotifycdn.com/cdn/images/",
							"https://encore.scdn.co/fonts/",
						];

						const isBlockedUrl = (u: string) =>
							blockedPatterns.some((pat) => u.includes(pat));

						if (blockedTypes.has(type) || isBlockedUrl(url)) {
							route.abort();
							return;
						}

						route.continue();
					});

					await page.goto("https://open.spotify.com/");
				} catch (error) {
					if (!responseReceived) {
						if (shouldClosePage) await page.close();
						logs("error", `Navigation failed: ${error}`);
						reject(new Error(`Navigation failed: ${error}`));
					}
				}
			})();
		});
	}

	public async close(): Promise<void> {
		if (this.persistentPage && !this.persistentPage.isClosed()) {
			await this.persistentPage.close();
			this.persistentPage = undefined;
		}
		if (this.browser) {
			await this.browser.close();
			this.browser = undefined;
			this.context = undefined;
		}
	}
}
