import { Actor, log as apifyLog } from 'apify';
import { PuppeteerCrawler, ProxyConfiguration } from 'crawlee'; // Correct imports from Crawlee

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PROXY_TEST_URL = 'https://api.apify.com/v2/browser-info';
const LINKEDIN_LOGIN_URL = 'https://www.linkedin.com/login';

let debugLogEnabled = false;

// --- Logging Utility ---
function customLog(level, message, extra) {
    if (level === 'debug' && !debugLogEnabled) {
        return;
    }
    apifyLog[level](message, extra);
}

// --- Proxy Testing Utility ---
async function testAndGetWorkingProxyConfiguration(userInputProxyConfig) {
    const proxyTestAttempts = [];

    // 1. Try user-defined Apify proxy from input
    if (userInputProxyConfig && userInputProxyConfig.useApifyProxy && userInputProxyConfig.apifyProxyGroups) {
        proxyTestAttempts.push({
            options: {
                groups: userInputProxyConfig.apifyProxyGroups,
                countryCode: userInputProxyConfig.apifyProxyCountry,
            },
            label: 'User-defined Apify Proxy',
        });
    }

    // 2. Fallback to RESIDENTIAL
    proxyTestAttempts.push({
        options: { groups: ['RESIDENTIAL'] },
        label: 'Apify RESIDENTIAL (Fallback)',
    });

    // 3. Fallback to DATACENTER
    proxyTestAttempts.push({
        options: { groups: ['DATACENTER'] },
        label: 'Apify DATACENTER (Fallback)',
    });

    for (const attempt of proxyTestAttempts) {
        customLog('info', `[ProxySetup] Attempting to test proxy: ${attempt.label}`, attempt.options);
        let browser = null;
        try {
            // Directly pass Crawlee-compatible options to ProxyConfiguration constructor
            const tempProxyConfig = new ProxyConfiguration(attempt.options);
            const proxyUrl = await tempProxyConfig.newUrl(); // Get a URL for testing
            if (!proxyUrl) {
                customLog('warning', `[ProxySetup] Could not get a proxy URL for ${attempt.label}.`);
                continue;
            }
            customLog('debug', `[ProxySetup] Testing with proxy URL from ${attempt.label}`);

            browser = await Actor.launchPuppeteer({ // Use Actor.launchPuppeteer for consistency
                proxyUrl,
                launchOptions: {
                    headless: true,
                    args: ['--no-sandbox', '--disable-setuid-sandbox'],
                    timeout: 45000, // Shorter timeout for proxy test
                },
                useChrome: Actor.isAtHome(), // Use Chrome on Apify platform
            });

            const page = await browser.newPage();
            await page.setUserAgent(DEFAULT_USER_AGENT);
            customLog('debug', `[ProxySetup] Navigating to ${PROXY_TEST_URL} for proxy test (${attempt.label}).`);
            const response = await page.goto(PROXY_TEST_URL, { timeout: 30000 });

            if (!response || !response.ok()) {
                throw new Error(`Proxy test navigation failed with status: ${response ? response.status() : 'unknown'}`);
            }
            const browserInfo = JSON.parse(await response.text());
            if (!browserInfo || !browserInfo.clientIp) {
                throw new Error(`Proxy test failed. Could not retrieve client IP from ${PROXY_TEST_URL}`);
            }
            customLog('info', `[ProxySetup] Proxy test successful for ${attempt.label}. IP via proxy: ${browserInfo.clientIp}`);
            await browser.close();
            return { proxyConfiguration: tempProxyConfig, label: attempt.label }; // Return the Crawlee ProxyConfiguration object
        } catch (e) {
            customLog('warning', `[ProxySetup] Proxy test failed for ${attempt.label}: ${e.message}`);
            if (browser) await browser.close();
        }
    }
    customLog('warning', '[ProxySetup] All proxy configurations failed the test.');
    return null; // No working Apify Proxy configuration found
}


// --- Authwall Detection Utility ---
async function checkForAuthwall(page, contextMessage) {
    const currentUrl = page.url();
    if (currentUrl.includes('/authwall')) {
        customLog('error', `[${contextMessage}] LinkedIn Authwall detected at URL: ${currentUrl}.`);
        await Actor.setValue('AUTHWALL_DETECTED_URL', currentUrl);
        await Actor.setValue(`AUTHWALL_SCREENSHOT_${contextMessage.replace(/\s+/g, '_')}`, await page.screenshot({fullPage: true, type: 'jpeg'}), { contentType: 'image/jpeg' });
        throw new Error(`Authwall detected: ${contextMessage} at ${currentUrl}`);
    }
    customLog('debug', `[${contextMessage}] No authwall detected at ${currentUrl}.`);
    return false;
}

// --- AutoScroll Utility ---
async function autoScroll(page, stopConditionCallback) {
    await page.evaluate(async (stopCbStr) => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 100;
            const timer = setInterval(async () => {
                const scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;
                if (totalHeight >= scrollHeight - window.innerHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, 300);
        });
    }); 
}


Actor.main(async () => {
    const input = await Actor.getInput();
    const {
        linkedinProfileUrl,
        email,
        password,
        proxyConfiguration: userProxyInput,
        maxPosts = 20,
        debugLog = false,
    } = input;

    debugLogEnabled = debugLog;

    if (!linkedinProfileUrl || !email || !password) {
        customLog('error', 'Missing required input: linkedinProfileUrl, email, or password.');
        await Actor.exit(1);
        return;
    }

    customLog('info', 'Actor starting...', { linkedinProfileUrl, maxPosts, debugLogEnabled });

    const proxyInfo = await testAndGetWorkingProxyConfiguration(userProxyInput);
    // Critical change: Use undefined if proxyInfo is null, as PuppeteerCrawler expects ProxyConfiguration | undefined
    const finalProxyConfiguration = proxyInfo ? proxyInfo.proxyConfiguration : undefined;
    let proxyUsedLabel = proxyInfo ? proxyInfo.label : "No Proxy (All tests failed or no proxy used)";

    if (proxyInfo) {
        customLog('info', `Using proxy configuration: ${proxyUsedLabel}`);
    } else {
        customLog('warning', 'Proceeding without a successfully tested Apify Proxy. LinkedIn scraping is likely to fail or be unreliable.');
    }

    const crawler = new PuppeteerCrawler({
        proxyConfiguration: finalProxyConfiguration, // This can now be undefined
        launchContext: {
            launchOptions: {
                headless: Actor.isAtHome() ? 'new' : false,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--window-size=1920,1080',
                ],
            },
            userAgent: DEFAULT_USER_AGENT,
            useChrome: Actor.isAtHome(),
        },
        browserPoolOptions: {
            maxOpenPagesPerBrowser: 1,
        },
        minConcurrency: 1,
        maxConcurrency: 1,
        navigationTimeoutSecs: 120,
        requestHandlerTimeoutSecs: 180,

        requestHandler: async ({ page, request, log }) => {
            log.info(`Processing ${request.url}...`);

            try {
                log.info('Attempting to log in to LinkedIn...');
                await page.goto(LINKEDIN_LOGIN_URL, { waitUntil: 'networkidle2', timeout: 90000 });
                await checkForAuthwall(page, 'LinkedIn Login Page');

                await page.waitForSelector('#username', { timeout: 45000 });
                await page.type('#username', email, { delay: 120 + Math.random() * 80 });
                await page.waitForSelector('#password', { timeout: 45000 });
                await page.type('#password', password, { delay: 110 + Math.random() * 90 });

                log.debug('Credentials entered. Clicking login button.');
                await page.click('button[type="submit"]', { delay: 150 + Math.random() * 100 });

                log.debug('Waiting for navigation after login attempt...');
                try {
                    await page.waitForFunction(
                        () => document.querySelector('.feed-identity-module') ||
                               document.querySelector('[data-test-id="global-nav-search-icon"]') ||
                               window.location.href.includes('/feed/') ||
                               window.location.href.includes('/authwall') ||
                               document.querySelector('form#login-form') === null,
                        { timeout: 75000 }
                    );
                } catch (e) {
                    log.warning(`Timeout or error waiting for post-login element/URL: ${e.message}`);
                    await Actor.setValue('LOGIN_NAVIGATION_FAILURE_SCREENSHOT', await page.screenshot({ fullPage: true, type: 'jpeg', quality: 75 }), { contentType: 'image/jpeg' });
                }

                await checkForAuthwall(page, 'After Login Attempt');

                if (page.url().includes('/feed/')) {
                    log.info('Successfully logged in to LinkedIn. Current URL: ' + page.url());
                } else if (page.url().includes('/login') || page.url().includes('session_redirect') || await page.$('form#login-form')) {
                    log.error('Login failed. Still on login page or redirected. URL: ' + page.url());
                    await Actor.setValue('LOGIN_FAILURE_SCREENSHOT', await page.screenshot({ fullPage: true, type: 'jpeg', quality: 75 }), { contentType: 'image/jpeg' });
                    throw new Error('Login failed, page did not navigate to feed.');
                } else {
                    log.warning('Login outcome uncertain. Current URL: ' + page.url() + '. Proceeding with caution.');
                }
            } catch (e) {
                log.error(`Error during login: ${e.message}`, { stack: e.stack });
                throw e;
            }

            log.info(`Navigating to profile: ${request.loadedUrl}`);
            try {
                await page.goto(request.loadedUrl, { waitUntil: 'networkidle2', timeout: 90000 });
                await checkForAuthwall(page, 'Profile Page Load');
                await page.waitForSelector('h1.text-heading-xlarge', { timeout: 45000 });
                log.info('Successfully navigated to profile page.');
            } catch (e) {
                log.error(`Error navigating to profile page ${request.loadedUrl}: ${e.message}`, { stack: e.stack });
                throw e;
            }

            log.info('Attempting to scrape posts...');
            let postsScrapedCount = 0;
            try {
                const postsFeedSelector = 'main.scaffold-layout__main';
                await page.waitForSelector(postsFeedSelector, { timeout: 45000 });

                let lastHeight = await page.evaluate(() => document.body.scrollHeight);
                let noNewPostsStreak = 0;
                const MAX_NO_NEW_POSTS_STREAK = 3;

                while (maxPosts === 0 || postsScrapedCount < maxPosts) {
                    log.debug(`Scrolling to load more posts. Scraped so far: ${postsScrapedCount}/${maxPosts === 0 ? 'all' : maxPosts}`);
                    await autoScroll(page);
                    await page.waitForTimeout(5000 + Math.random() * 2000);

                    const postElements = await page.$$('div[data-urn^="urn:li:activity:"]');

                    if (postElements.length === 0 && postsScrapedCount === 0) {
                        log.warning('No post elements found on the page with selector: div[data-urn^="urn:li:activity:"]. Ensure selectors are up to date or profile has posts.');
                        break;
                    }

                    let newPostsInThisScroll = 0;
                    for (const postElement of postElements) {
                        if (maxPosts > 0 && postsScrapedCount >= maxPosts) break;

                        const isProcessed = await postElement.evaluate(el => el.getAttribute('data-scraped-by-actor'));
                        if (isProcessed) continue;

                        let postText = '';
                        try {
                            const textElement = await postElement.$('.feed-shared-update-v2__description .feed-shared-inline-show-more-text, .update-components-text.break-words');
                            if (textElement) {
                                postText = await textElement.evaluate(el => el.innerText.trim());
                            } else {
                                log.debug('Post text element not found for a post candidate.');
                            }
                        } catch (e) {
                            log.debug(`Could not extract text for a post: ${e.message}`);
                        }

                        let postTimestamp = '';
                        try {
                            const timeElement = await postElement.$('.update-components-text-view__timestamp');
                            if (timeElement) {
                                postTimestamp = await timeElement.evaluate(el => el.innerText.trim());
                            } else {
                                log.debug('Timestamp element not found for a post candidate.');
                            }
                        } catch (e) {
                            log.debug(`Could not extract timestamp for a post: ${e.message}`);
                        }
                        
                        let actualPostContent = postText;
                        if (!actualPostContent) {
                             const genericContent = await postElement.$('.feed-shared-update-v2__commentary, .update-components-text');
                             if(genericContent) actualPostContent = await genericContent.evaluate(el => el.innerText.trim());
                        }

                        if (actualPostContent) {
                            await Actor.pushData({
                                profileUrl: request.loadedUrl,
                                postText: actualPostContent,
                                postTimestamp,
                                likes: 'N/A (Selector TODO)',
                                comments: 'N/A (Selector TODO)',
                                scrapedAt: new Date().toISOString(),
                                proxyUsed: proxyUsedLabel,
                            });
                            postsScrapedCount++;
                            newPostsInThisScroll++;
                            await postElement.evaluate(el => el.setAttribute('data-scraped-by-actor', 'true'));
                            log.debug(`Scraped post #${postsScrapedCount}: ${actualPostContent.substring(0, 70)}...`);
                        }

                        if (maxPosts > 0 && postsScrapedCount >= maxPosts) {
                            log.info(`Reached maxPosts limit of ${maxPosts}.`);
                            break;
                        }
                    }

                    if (maxPosts > 0 && postsScrapedCount >= maxPosts) break;

                    const currentHeight = await page.evaluate(() => document.body.scrollHeight);
                    if (newPostsInThisScroll === 0 && currentHeight === lastHeight) {
                        noNewPostsStreak++;
                        log.debug(`No new posts loaded AND height did not change. Scroll streak: ${noNewPostsStreak}/${MAX_NO_NEW_POSTS_STREAK}`);
                        if (noNewPostsStreak >= MAX_NO_NEW_POSTS_STREAK) {
                            log.info('No new posts found after multiple scrolls with no height change. Assuming end of feed or issue.');
                            break;
                        }
                    } else {
                        noNewPostsStreak = 0;
                    }
                    lastHeight = currentHeight;

                    if (postElements.length === 0 && postsScrapedCount > 0) {
                        log.info('No more post elements found (div[data-urn^="urn:li:activity:"]). Assuming end of feed.');
                        break;
                    }
                }
                log.info(`Finished scraping for ${request.loadedUrl}. Total posts scraped: ${postsScrapedCount}`);

            } catch (e) {
                log.error(`Error during post scraping on ${request.loadedUrl}: ${e.message}`, { stack: e.stack });
                throw e;
            }
        },

        failedRequestHandler: async ({ request, error, page, log }) => {
            log.error(`Request ${request.url} failed: ${error.message}`, { stack: error.stack });
            const safeUrl = request.url.replace(/[^a-zA-Z0-9]/g, '_');
            const timestamp = new Date().toISOString().replace(/:/g, '-');
            try {
                if (page) {
                     await Actor.setValue(`FAILED_REQUEST_SCREENSHOT_${safeUrl}_${timestamp}.jpg`, await page.screenshot({ fullPage: true, type: 'jpeg', quality: 70 }), { contentType: 'image/jpeg' });
                     await Actor.setValue(`FAILED_REQUEST_HTML_${safeUrl}_${timestamp}.html`, await page.content(), { contentType: 'text/html' });
                }
            } catch (screenShotError) {
                 log.error(`Failed to save screenshot or HTML for ${request.url}: ${screenShotError.message}`);
            }
        },
    });

    customLog('info', `Starting crawler for URL: ${linkedinProfileUrl}`);
    await crawler.run([linkedinProfileUrl]);

    customLog('info', 'Actor finished.');
});
