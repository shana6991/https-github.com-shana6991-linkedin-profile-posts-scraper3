import { Actor, log as apifyLog } from 'apify';
import { PuppeteerCrawler, ProxyConfiguration, launchPuppeteer } from 'crawlee';

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PROXY_TEST_URL = 'https://api.apify.com/v2/browser-info';
const LINKEDIN_LOGIN_URL = 'https://www.linkedin.com/login';

let debugLogEnabled = false;

// --- Logging Utility ---
function customLog(level, message, extra) {
    if (level === 'debug' && !debugLogEnabled) {
        return;
    }
    if (extra !== undefined) {
        if (level === 'debug' && typeof extra === 'object' && extra !== null) {
            apifyLog[level](`${message} ${JSON.stringify(extra)}`);
        } else {
            apifyLog[level](message, extra);
        }
    } else {
        apifyLog[level](message);
    }
}

// --- Proxy Testing Utility ---
async function testAndGetWorkingProxyConfiguration(userInputProxyConfig) {
    const proxyTestAttempts = [];

    if (userInputProxyConfig && userInputProxyConfig.useApifyProxy && userInputProxyConfig.apifyProxyGroups) {
        const userDefinedOptions = {
            groups: userInputProxyConfig.apifyProxyGroups,
        };
        if (userInputProxyConfig.apifyProxyCountry && userInputProxyConfig.apifyProxyCountry.trim() !== '') {
            userDefinedOptions.countryCode = userInputProxyConfig.apifyProxyCountry.trim();
        }
        userDefinedOptions.useApifyProxy = true; 
        proxyTestAttempts.push({
            options: userDefinedOptions,
            label: 'User-defined Apify Proxy',
        });
    }

    proxyTestAttempts.push({
        options: { useApifyProxy: true, groups: ['RESIDENTIAL'] },
        label: 'Apify RESIDENTIAL (Fallback)',
    });
    proxyTestAttempts.push({
        options: { useApifyProxy: true, groups: ['DATACENTER'] },
        label: 'Apify DATACENTER (Fallback)',
    });

    for (const attempt of proxyTestAttempts) {
        customLog('info', `[ProxySetup] Attempting to test proxy: ${attempt.label} with options: ${JSON.stringify(attempt.options)}`);
        let browser = null;
        let maskedProxyUrlForLogging = 'N/A';
        try {
            const tempProxyConfig = await Actor.createProxyConfiguration(attempt.options);

            if (!tempProxyConfig) {
                customLog('warning', `[ProxySetup] Actor.createProxyConfiguration returned null/undefined for ${attempt.label} with options: ${JSON.stringify(attempt.options)}`);
                continue;
            }

            const proxyUrl = await tempProxyConfig.newUrl();

            if (!proxyUrl) {
                customLog('warning', `[ProxySetup] Could not get a proxy URL for ${attempt.label} (config created, but newUrl() failed).`);
                continue;
            }
            
            maskedProxyUrlForLogging = proxyUrl.replace(/:[^@]+@/, ':********@');
            customLog('debug', `[ProxySetup] Testing with actual proxy URL from ${attempt.label}: ${maskedProxyUrlForLogging}`);
            
browser = await launchPuppeteer({
                proxyUrl,
                launchOptions: {
                    headless: true,
                    args: ['--no-sandbox', '--disable-setuid-sandbox'],
                    timeout: 45000,
                },
                useChrome: Actor.isAtHome(),
            });
            const page = await browser.newPage();
            await page.setUserAgent(DEFAULT_USER_AGENT);
            customLog('debug', `[ProxySetup] Navigating to ${PROXY_TEST_URL} for proxy test (${attempt.label} using ${maskedProxyUrlForLogging}).`);
            const response = await page.goto(PROXY_TEST_URL, { timeout: 30000 });
            if (!response || !response.ok()) {
                throw new Error(`Proxy test navigation failed with status: ${response ? response.status() : 'unknown'}`);
            }
            const browserInfo = JSON.parse(await response.text());
            if (!browserInfo || !browserInfo.clientIp) {
                throw new Error(`Proxy test failed. Could not retrieve client IP from ${PROXY_TEST_URL}`);
            }
            customLog('info', `[ProxySetup] Proxy test successful for ${attempt.label} (via ${maskedProxyUrlForLogging}). IP: ${browserInfo.clientIp}`);
            await browser.close();
            return { proxyConfiguration: tempProxyConfig, label: attempt.label };
        } catch (e) {
            customLog('warning', `[ProxySetup] Proxy test failed for ${attempt.label} (using ${maskedProxyUrlForLogging}): ${e.message}`);
            if (debugLogEnabled) {
                customLog('debug', `[ProxySetup] Error details for ${attempt.label}`, { stack: e.stack });
            }
            if (browser) await browser.close();
        }
    }
    customLog('warning', '[ProxySetup] All proxy configurations failed the test.');
    return null;
}

// --- Authwall Detection Utility ---
async function checkForAuthwall(page, contextMessage) {
    const currentUrl = page.url();
    if (currentUrl.includes('/authwall')) {
        customLog('error', `[${contextMessage}] LinkedIn Authwall detected at URL: ${currentUrl}.`);
        await Actor.setValue('AUTHWALL_DETECTED_URL', currentUrl);
        const timestamp = new Date().toISOString().replace(/:/g, '-');
        await Actor.setValue(`AUTHWALL_SCREENSHOT_${contextMessage.replace(/\s+/g, '_')}_${timestamp}`, await page.screenshot({fullPage: true, type: 'jpeg'}), { contentType: 'image/jpeg' });
        throw new Error(`Authwall detected: ${contextMessage} at ${currentUrl}`);
    }
    customLog('debug', `[${contextMessage}] No authwall detected at ${currentUrl}.`);
    return false;
}

// --- AutoScroll Utility ---
async function autoScroll(page) {
    await page.evaluate(async () => {
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
    const finalProxyConfiguration = proxyInfo ? proxyInfo.proxyConfiguration : undefined;
    let proxyUsedLabel = proxyInfo ? proxyInfo.label : "No Proxy (All tests failed or no proxy used)";

    if (proxyInfo) {
        customLog('info', `Using proxy configuration: ${proxyUsedLabel}`);
    } else {
        customLog('warning', 'Proceeding without a successfully tested Apify Proxy. LinkedIn scraping is likely to fail or be unreliable.');
    }

    const crawler = new PuppeteerCrawler({
        proxyConfiguration: finalProxyConfiguration,
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
        browserPoolOptions: { maxOpenPagesPerBrowser: 1 },
        minConcurrency: 1,
        maxConcurrency: 1,
        navigationTimeoutSecs: 120,
        requestHandlerTimeoutSecs: 180,

        requestHandler: async ({ page, request, log }) => {
            log.info(`Processing base profile URL: ${request.url} to derive activity feed.`);

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
                               window.location.href.includes('/checkpoint/') || // Early checkpoint check
                               document.querySelector('form#login-form') === null,
                        { timeout: 75000 }
                    );
                } catch (e) {
                    log.warning(`Timeout or error waiting for post-login element/URL: ${e.message}`);
                    const timestamp = new Date().toISOString().replace(/:/g, '-');
                    await Actor.setValue(`LOGIN_NAV_FAILURE_SCREENSHOT_${timestamp}.jpg`, await page.screenshot({ fullPage: true, type: 'jpeg', quality: 75 }), { contentType: 'image/jpeg' });
                }
                await checkForAuthwall(page, 'After Login Attempt'); // This will throw if it's an authwall URL

                const currentUrl = page.url();
                if (currentUrl.includes('/feed/')) {
                    log.info('Successfully logged in to LinkedIn. Current URL: ' + currentUrl);
                } else if (currentUrl.includes('/login') || 
                           currentUrl.includes('session_redirect') || 
                           await page.$('form#login-form') || 
                           currentUrl.includes('/checkpoint/')) { // Explicitly check for checkpoint URL
                    log.error(`Login failed. Page URL: ${currentUrl} indicates login issue or checkpoint.`);
                    const timestamp = new Date().toISOString().replace(/:/g, '-');
                    const failureType = currentUrl.includes('/checkpoint/') ? 'CHECKPOINT' : 'LOGIN_PAGE_OR_REDIRECT';
                    await Actor.setValue(`LOGIN_FAILURE_${failureType}_SCREENSHOT_${timestamp}.jpg`, await page.screenshot({ fullPage: true, type: 'jpeg', quality: 75 }), { contentType: 'image/jpeg' });
                    await Actor.setValue(`LOGIN_FAILURE_${failureType}_HTML_${timestamp}.html`, await page.content(), { contentType: 'text/html' });
                    throw new Error(`Login failed, page did not navigate to feed. Current URL: ${currentUrl}`);
                } else {
                    log.warning('Login outcome uncertain. Current URL: ' + currentUrl + '. Proceeding with caution.');
                    // Potentially save screenshot here too if this path is reached unexpectedly
                    const timestamp = new Date().toISOString().replace(/:/g, '-');
                    await Actor.setValue(`LOGIN_UNCERTAIN_SCREENSHOT_${timestamp}.jpg`, await page.screenshot({ fullPage: true, type: 'jpeg', quality: 75 }), { contentType: 'image/jpeg' });
                }
            } catch (e) {
                log.error(`Error during login: ${e.message}`, { stack: e.stack });
                // Ensure screenshot is saved if error happens before explicit failure checks
                try {
                    const timestamp = new Date().toISOString().replace(/:/g, '-');
                    await Actor.setValue(`LOGIN_EXCEPTION_SCREENSHOT_${timestamp}.jpg`, await page.screenshot({ fullPage: true, type: 'jpeg', quality: 75 }), { contentType: 'image/jpeg' });
                } catch (screenshotError) {
                    log.error(`Could not save screenshot during login exception: ${screenshotError.message}`);
                }
                throw e;
            }

            let baseProfileUrl = request.url; 
            if (baseProfileUrl.endsWith('/')) {
                baseProfileUrl = baseProfileUrl.slice(0, -1);
            }
            const activityFeedUrl = `${baseProfileUrl}/recent-activity/all/`;
            log.info(`Navigating to activity feed: ${activityFeedUrl}`);

            try {
                await page.goto(activityFeedUrl, { waitUntil: 'networkidle2', timeout: 90000 });
                await checkForAuthwall(page, 'Activity Feed Page Load');
                await page.waitForSelector('main.scaffold-layout__main', { timeout: 60000 });
                log.info('Successfully navigated to activity feed page.');
            } catch (e) {
                log.error(`Error navigating to activity feed page ${activityFeedUrl}: ${e.message}`, { stack: e.stack });
                throw e;
            }

            log.info('Attempting to scrape posts from activity feed...');
            let postsScrapedCount = 0;
            try {
                const postsFeedContainerSelector = 'main.scaffold-layout__main';
                await page.waitForSelector(postsFeedContainerSelector, { timeout: 45000 });
                let lastHeight = await page.evaluate(() => document.body.scrollHeight);
                let noNewPostsStreak = 0;
                const MAX_NO_NEW_POSTS_STREAK = 3;

                while (maxPosts === 0 || postsScrapedCount < maxPosts) {
                    log.debug(`Scrolling activity feed. Scraped so far: ${postsScrapedCount}/${maxPosts === 0 ? 'all' : maxPosts}`);
                    await autoScroll(page);
                    await page.waitForTimeout(5000 + Math.random() * 2000);
                    const postElements = await page.$$('div[data-urn^="urn:li:activity:"]');
                    if (postElements.length === 0 && postsScrapedCount === 0) {
                        log.warning('No post elements found on activity feed. Ensure selectors (div[data-urn^="urn:li:activity:"]) are up to date or profile has posts.');
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
                                profileUrl: baseProfileUrl, 
                                activityFeedUrlScraped: activityFeedUrl,
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
                log.info(`Finished scraping from ${activityFeedUrl}. Total posts scraped: ${postsScrapedCount}`);
            } catch (e) {
                log.error(`Error during post scraping on ${activityFeedUrl}: ${e.message}`, { stack: e.stack });
                throw e;
            }
        },
        failedRequestHandler: async ({ request, error, page, log }) => {
            log.error(`Request ${request.url} failed for ${request.loadedUrl} (derived activity page): ${error.message}`, { stack: error.stack });
            const safeUrl = request.loadedUrl ? request.loadedUrl.replace(/[^a-zA-Z0-9]/g, '_') : 'UNKNOWN_URL';
            const timestamp = new Date().toISOString().replace(/:/g, '-');
            try {
                if (page) {
                     await Actor.setValue(`FAILED_REQUEST_SCREENSHOT_${safeUrl}_${timestamp}.jpg`, await page.screenshot({ fullPage: true, type: 'jpeg', quality: 70 }), { contentType: 'image/jpeg' });
                     await Actor.setValue(`FAILED_REQUEST_HTML_${safeUrl}_${timestamp}.html`, await page.content(), { contentType: 'text/html' });
                }
            } catch (screenShotError) {
                 log.error(`Failed to save screenshot or HTML for ${request.loadedUrl || 'unknown URL'}: ${screenShotError.message}`);
            }
        },
    });

    customLog('info', `Starting crawler for base profile URL: ${linkedinProfileUrl}`);
    await crawler.run([linkedinProfileUrl]);

    customLog('info', 'Actor finished.');
});
