import { Actor, log as apifyLog } from 'apify';
import { launchPuppeteer, puppeteerUtils } from 'crawlee';

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36';
const PROXY_TEST_URL = 'https://api.apify.com/v2/browser-info';
const LINKEDIN_LOGIN_URL = 'https://www.linkedin.com/login';

let debugLogEnabled = false;

function customLog(level, message, extra) {
    if (level === 'debug' && !debugLogEnabled) {
        return;
    }
    apifyLog[level](message, extra);
}

async function testProxy(proxyConfiguration, logContext) {
    customLog('info', `[${logContext}] Testing proxy configuration...`, proxyConfiguration);
    let browser = null;
    try {
        const proxyUrl = await Actor.createProxyUrl(proxyConfiguration);
        customLog('debug', `[${logContext}] Generated proxy URL for testing: ${proxyUrl.substring(0, proxyUrl.indexOf('@') + 1)}...`);

        browser = await launchPuppeteer({
            proxyUrl,
            launchOptions: {
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox'],
                timeout: 60000,
            },
            useChrome: false,
        });

        const page = await browser.newPage();
        await page.setUserAgent(DEFAULT_USER_AGENT);
        customLog('debug', `[${logContext}] Navigating to ${PROXY_TEST_URL} for proxy test.`);
        const response = await page.goto(PROXY_TEST_URL, { timeout: 60000 });

        if (!response || !response.ok()) {
            throw new Error(`[${logContext}] Proxy test navigation failed with status: ${response ? response.status() : 'unknown'}`);
        }

        const browserInfo = JSON.parse(await response.text());
        if (!browserInfo || !browserInfo.clientIp) {
            throw new Error(`[${logContext}] Proxy test failed. Could not retrieve client IP from ${PROXY_TEST_URL}`);
        }
        customLog('info', `[${logContext}] Proxy test successful. IP via proxy: ${browserInfo.clientIp}`);
        await browser.close();
        return proxyUrl;
    } catch (e) {
        customLog('warning', `[${logContext}] Proxy test failed: ${e.message}`, { stack: e.stack });
        if (browser) {
            await browser.close();
        }
        return null;
    }
}

async function checkForAuthwall(page, contextMessage) {
    if (page.url().includes('/authwall')) {
        customLog('error', `[${contextMessage}] LinkedIn Authwall detected at URL: ${page.url()}. Actor will terminate.`);
        await Actor.setValue('AUTH পরিচয়WALL_DETECTED_URL', page.url());
        throw new Error(`Authwall detected: ${contextMessage}`);
    }
    customLog('debug', `[${contextMessage}] No authwall detected at ${page.url()}.`);
    return false;
}

async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 100;
            const timer = setInterval(() => {
                const scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;

                if (totalHeight >= scrollHeight - window.innerHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, 200);
        });
    });
}


Actor.main(async () => {
    const input = await Actor.getInput();
    const {
        linkedinProfileUrl,
        email,
        password,
        proxyConfiguration: userProxyConfig,
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

    let effectiveProxyUrl = null;
    let proxyUsedLabel = "No Proxy";

    if (userProxyConfig && userProxyConfig.useApifyProxy) {
        customLog('info', 'Attempting to use user-provided proxy configuration.');
        effectiveProxyUrl = await testProxy(userProxyConfig, 'UserProxy');
        if (effectiveProxyUrl) {
            proxyUsedLabel = "User-defined Apify Proxy";
        }
    } else if (userProxyConfig && userProxyConfig.proxyUrls && userProxyConfig.proxyUrls.length > 0) {
         customLog('info', 'User provided custom proxy URLs. This actor primarily supports Apify Proxy. Testing the first custom URL as a direct proxy.');
         if(userProxyConfig.proxyUrls[0]) {
            effectiveProxyUrl = userProxyConfig.proxyUrls[0];
            proxyUsedLabel = `Custom Proxy: ${effectiveProxyUrl.substring(0,30)}...`;
         }
    }

    if (!effectiveProxyUrl) {
        customLog('info', 'User proxy failed or not configured for Apify Proxy. Attempting Apify RESIDENTIAL proxies.');
        const residentialProxyConfig = { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] };
        effectiveProxyUrl = await testProxy(residentialProxyConfig, 'ResidentialFallback');
        if (effectiveProxyUrl) {
            proxyUsedLabel = "Apify RESIDENTIAL (Fallback)";
        }
    }

    if (!effectiveProxyUrl) {
        customLog('info', 'Apify RESIDENTIAL proxy failed. Attempting Apify DATACENTER proxies.');
        const datacenterProxyConfig = { useApifyProxy: true, apifyProxyGroups: ['DATACENTER'] };
        effectiveProxyUrl = await testProxy(datacenterProxyConfig, 'DatacenterFallback');
        if (effectiveProxyUrl) {
            proxyUsedLabel = "Apify DATACENTER (Fallback)";
        }
    }

    if (!effectiveProxyUrl) {
        customLog('warning', 'All proxy attempts failed. Proceeding without proxy. This is likely to fail on LinkedIn.');
        proxyUsedLabel = "No Proxy (All fallbacks failed)";
    } else {
        customLog('info', `Successfully configured proxy. Using: ${proxyUsedLabel}`);
    }

    const launchContext = {
        launchOptions: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1920,1080'],
            userAgent: DEFAULT_USER_AGENT,
        },
        useChrome: Actor.isAtHome() ? true : false,
    };

    if (effectiveProxyUrl) {
        launchContext.proxyUrl = effectiveProxyUrl;
    }

    customLog('info', `Launching browser with proxy: ${proxyUsedLabel}`);
    const browser = await launchPuppeteer(launchContext);
    const page = await browser.newPage();
    await page.setUserAgent(DEFAULT_USER_AGENT);
    await page.setViewport({ width: 1920, height: 1080 });
    
    // await puppeteerUtils.blockRequests(page, {
    // urlPatterns: ['.css', '.jpg', '.jpeg', '.png', '.svg', '.gif', '.woff', '.woff2'],
    // });

    customLog('info', 'Attempting to log in to LinkedIn...');
    try {
        await page.goto(LINKEDIN_LOGIN_URL, { waitUntil: 'networkidle2', timeout: 90000 });

        await page.waitForSelector('#username', { timeout: 30000 });
        await page.type('#username', email, { delay: 100 + Math.random() * 100 });
        await page.waitForSelector('#password', { timeout: 30000 });
        await page.type('#password', password, { delay: 100 + Math.random() * 100 });

        customLog('debug', 'Credentials entered. Clicking login button.');
        await page.click('button[type="submit"]', { delay: 100 + Math.random() * 100 });

        customLog('debug', 'Waiting for navigation after login attempt...');
         try {
            await page.waitForFunction(
                () => document.querySelector('.feed-identity-module') || document.querySelector('[data-test-id="global-nav-search-icon"]') || window.location.href.includes('/feed/') || window.location.href.includes('/authwall'),
                { timeout: 60000 }
            );
        } catch (e) {
            customLog('warning', `Timeout or error waiting for post-login element/URL: ${e.message}`);
            await Actor.setValue('LOGIN_NAVIGATION_FAILURE_SCREENSHOT', await page.screenshot({ fullPage: true, type: 'jpeg', quality: 80 }), { contentType: 'image/jpeg' });
        }

        await checkForAuthwall(page, 'After Login Attempt');

        if (page.url().includes('/feed/')) {
            customLog('info', 'Successfully logged in to LinkedIn. Current URL: ' + page.url());
        } else if (page.url().includes('/login') || page.url().includes('session_redirect')) {
             customLog('error', 'Login failed. Still on login page or redirected. URL: ' + page.url());
             await Actor.setValue('LOGIN_FAILURE_SCREENSHOT', await page.screenshot({ fullPage: true, type: 'jpeg', quality: 80 }), { contentType: 'image/jpeg' });
             throw new Error('Login failed, page did not navigate to feed.');
        } else {
            customLog('warning', 'Login outcome uncertain. Current URL: ' + page.url() + '. Proceeding with caution.');
        }

    } catch (e) {
        customLog('error', `Error during login: ${e.message}`, { stack: e.stack });
        await Actor.setValue('LOGIN_PROCESS_ERROR_SCREENSHOT', await page.screenshot({ fullPage: true, type: 'jpeg', quality: 80 }), { contentType: 'image/jpeg' });
        await browser.close();
        await Actor.fail(`Login process failed: ${e.message}`);
        return;
    }

    customLog('info', `Navigating to profile: ${linkedinProfileUrl}`);
    try {
        await page.goto(linkedinProfileUrl, { waitUntil: 'networkidle2', timeout: 90000 });
        await checkForAuthwall(page, 'Profile Page Load');
        await page.waitForSelector('h1.text-heading-xlarge', { timeout: 30000 });
        customLog('info', 'Successfully navigated to profile page.');

    } catch (e) {
        customLog('error', `Error navigating to profile page ${linkedinProfileUrl}: ${e.message}`, { stack: e.stack });
        await Actor.setValue('PROFILE_NAVIGATION_ERROR_SCREENSHOT', await page.screenshot({ fullPage: true, type: 'jpeg', quality: 80 }), { contentType: 'image/jpeg' });
        await browser.close();
        await Actor.fail(`Failed to navigate to profile: ${e.message}`);
        return;
    }

    customLog('info', 'Attempting to scrape posts...');
    let postsScrapedCount = 0;
    try {
        const postsSectionSelector = 'main.scaffold-layout__main';
        await page.waitForSelector(postsSectionSelector, { timeout: 30000 });

        let lastHeight = await page.evaluate(() => document.body.scrollHeight);
        let noNewPostsStreak = 0;

        while (maxPosts === 0 || postsScrapedCount < maxPosts) {
            customLog('debug', `Scrolling to load more posts. Scraped so far: ${postsScrapedCount}/${maxPosts || 'all'}`);
            await autoScroll(page);
            await page.waitForTimeout(5000);

            const postElements = await page.$$('div.feed-shared-update-v2.feed-shared-update-v2--minimal-padding.full-height.relative');

            if (postElements.length === 0 && postsScrapedCount === 0) {
                 customLog('warning', 'No post elements found on the page with the current selector. Ensure selectors are up to date.');
                 break;
            }

            let newPostsInThisScroll = 0;
            for (const postElement of postElements) {
                if (maxPosts > 0 && postsScrapedCount >= maxPosts) break;

                const isProcessed = await postElement.evaluate(el => el.getAttribute('data-scraped'));
                if (isProcessed) continue;

                let postText = '';
                try {
                     const textElement = await postElement.$('div.feed-shared-update-v2__description span.break-words, div.update-components-text span.text-view-model');
                    if (textElement) {
                        postText = await textElement.evaluate(el => el.innerText.trim());
                    } else {
                        customLog('debug', 'Post text element not found for a post.');
                    }
                } catch (e) {
                    customLog('debug', `Could not extract text for a post: ${e.message}`);
                }

                let postTimestamp = '';
                try {
                    const timeElement = await postElement.$('span.feed-shared-actor__sub-description a span.visually-hidden');
                    if (timeElement) {
                        postTimestamp = await timeElement.evaluate(el => el.innerText.trim());
                    } else {
                        customLog('debug', 'Timestamp element not found for a post.');
                    }
                } catch (e) {
                    customLog('debug', `Could not extract timestamp for a post: ${e.message}`);
                }

                let likes = 'N/A';
                let comments = 'N/A';

                if (postText) {
                    await Actor.pushData({
                        profileUrl: linkedinProfileUrl,
                        postText,
                        postTimestamp,
                        likes,
                        comments,
                        scrapedAt: new Date().toISOString(),
                        proxyUsed: proxyUsedLabel,
                    });
                    postsScrapedCount++;
                    newPostsInThisScroll++;
                    await postElement.evaluate(el => el.setAttribute('data-scraped', 'true'));
                    customLog('debug', `Scraped post #${postsScrapedCount}: ${postText.substring(0, 50)}...`);
                }

                if (maxPosts > 0 && postsScrapedCount >= maxPosts) {
                    customLog('info', `Reached maxPosts limit of ${maxPosts}.`);
                    break;
                }
            }

            if (maxPosts > 0 && postsScrapedCount >= maxPosts) break;

            const currentHeight = await page.evaluate(() => document.body.scrollHeight);
            if (currentHeight === lastHeight && newPostsInThisScroll === 0) {
                noNewPostsStreak++;
                customLog('debug', `No new posts loaded or height did not change. Streak: ${noNewPostsStreak}`);
                if (noNewPostsStreak >= 3) {
                    customLog('info', 'No new posts found after multiple scrolls. Assuming end of feed or issue.');
                    break;
                }
            } else {
                noNewPostsStreak = 0;
            }
            lastHeight = currentHeight;

            if (postElements.length === 0 && postsScrapedCount > 0) {
                customLog('info', 'No more post elements found with current selectors. Assuming end of feed.');
                break;
            }
        }
        customLog('info', `Finished scraping. Total posts scraped: ${postsScrapedCount}`);

    } catch (e) {
        customLog('error', `Error during post scraping: ${e.message}`, { stack: e.stack });
        await Actor.setValue('POST_SCRAPING_ERROR_SCREENSHOT', await page.screenshot({ fullPage: true, type: 'jpeg', quality: 80 }), { contentType: 'image/jpeg' });
    } finally {
        customLog('info', 'Closing browser.');
        await browser.close();
        customLog('info', 'Actor finished.');
    }
});