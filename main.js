const { Actor } = require('apify');
const moment = require('moment');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const ProxyChain = require('proxy-chain');
const fs = require('fs');

puppeteer.use(StealthPlugin());

Actor.init();

// Helper function to create launch options with a specific proxy group
async function getLaunchOptionsWithProxyGroup(groupName, existingLaunchOptions) {
    const launchOptions = JSON.parse(JSON.stringify(existingLaunchOptions)); // Deep clone
    try {
        console.log(`Attempting to configure proxy with ${groupName} group...`);
        const proxyConfiguration = await Actor.createProxyConfiguration({
            groups: [groupName],
            countryCode: 'US'
        });
        if (proxyConfiguration) {
            const proxyUrl = await proxyConfiguration.newUrl();
            const sanitizedProxyUrl = proxyUrl.includes('@') 
                ? proxyUrl.replace(/\/\/([^:]+):[^@]+@/, '//***:***@') 
                : proxyUrl;
            console.log(`Successfully configured proxy with ${groupName} group. URL: ${sanitizedProxyUrl}`);
            launchOptions.args = launchOptions.args.filter(arg => !arg.startsWith('--proxy-server=')); // Remove old proxy arg if any
            launchOptions.args.push(`--proxy-server=${proxyUrl}`);
            return { launchOptions, proxyConfiguration }; // Return both for later use if needed
        }
    } catch (error) {
        console.warn(`Failed to configure ${groupName} proxy: ${error.message}.`);
        if (groupName === 'RESIDENTIAL' && error.message.includes('cannot be used in combination')) {
            console.warn('This account may not allow mixing RESIDENTIAL with other groups or has specific restrictions.');
        }
    }
    return null; // Return null if configuration failed
}

// Helper function for proxy pre-flight check
async function testProxyConnectivity(browser, testUrl = 'https://api.apify.com/v2/browser-info', timeout = 20000) {
    let page = null;
    try {
        page = await browser.newPage();
        console.log(`Performing pre-flight proxy check, navigating to ${testUrl}...`);
        await page.goto(testUrl, { waitUntil: ['networkidle2', 'domcontentloaded'], timeout });
        console.log('Proxy pre-flight check successful.');
        await page.close();
        return true;
    } catch (error) {
        console.warn(`Proxy pre-flight check failed: ${error.message}`);
        if (page) await page.close();
        return false;
    }
}

async function scrapeLinkedIn() {
    await new Promise(resolve => setTimeout(resolve, 100)); 
    console.log('Inside scrapeLinkedIn. Using console.log for debugging.');
    console.log('scrapeLinkedIn function started.'); 
    
    let browser = null;
    let page = null;
    let activeProxyConfiguration = null; // To store the currently active proxy configuration object
    let finalLaunchOptions = null;

    try {
        const input = await Actor.getInput();
        const { password, ...inputToLog } = input;
        console.log('Input received (password omitted for security):', inputToLog);

        const { 
            username,
            profileUrls,
            maxPosts = 0,
            useProxy = true
        } = input;

        if (!profileUrls || !Array.isArray(profileUrls) || profileUrls.length === 0) {
            console.warn('No profile URLs provided or profileUrls is not a valid array. Exiting peacefully.');
            return; 
        }

        const baseLaunchOptions = {
            headless: "new",
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--window-size=1920,1080',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-site-isolation-trials'
            ]
        };

        if (useProxy) {
            console.log('Proxy usage enabled. Initiating proxy selection and pre-flight check...');
            
            // Attempt 1: RESIDENTIAL Proxies
            const residentialResult = await getLaunchOptionsWithProxyGroup('RESIDENTIAL', baseLaunchOptions);
            if (residentialResult) {
                console.log('Attempting to launch browser with RESIDENTIAL proxy...');
                try {
                    browser = await puppeteer.launch(residentialResult.launchOptions);
                    if (await testProxyConnectivity(browser)) {
                        finalLaunchOptions = residentialResult.launchOptions;
                        activeProxyConfiguration = residentialResult.proxyConfiguration;
                        console.log('Browser launched successfully with working RESIDENTIAL proxy.');
                    } else {
                        await browser.close(); browser = null;
                        console.log('RESIDENTIAL proxy connected but pre-flight check failed.');
                    }
                } catch (launchError) {
                    console.warn(`Failed to launch browser with RESIDENTIAL proxy: ${launchError.message}`);
                    if(browser) await browser.close(); browser = null;
                }
            }

            // Attempt 2: DATACENTER Proxies (if RESIDENTIAL failed)
            if (!browser) {
                const datacenterResult = await getLaunchOptionsWithProxyGroup('DATACENTER', baseLaunchOptions);
                if (datacenterResult) {
                    console.log('Attempting to launch browser with DATACENTER proxy...');
                    try {
                        browser = await puppeteer.launch(datacenterResult.launchOptions);
                        if (await testProxyConnectivity(browser)) {
                            finalLaunchOptions = datacenterResult.launchOptions;
                            activeProxyConfiguration = datacenterResult.proxyConfiguration;
                            console.log('Browser launched successfully with working DATACENTER proxy.');
                        } else {
                            await browser.close(); browser = null;
                            console.log('DATACENTER proxy connected but pre-flight check failed.');
                        }
                    } catch (launchError) {
                        console.warn(`Failed to launch browser with DATACENTER proxy: ${launchError.message}`);
                        if(browser) await browser.close(); browser = null;
                    }
                }
            }

            // Attempt 3: Fallback to environment or input proxy URL
            if (!browser) {
                console.log('Apify group proxies failed or pre-flight checks unsuccessful. Trying environment/input proxy...');
                let fallbackProxyUrl = process.env.APIFY_PROXY_URL || input.proxyUrl;
                if (fallbackProxyUrl) {
                    const fallbackLaunchOptions = JSON.parse(JSON.stringify(baseLaunchOptions));
                    fallbackLaunchOptions.args = fallbackLaunchOptions.args.filter(arg => !arg.startsWith('--proxy-server='));
                    fallbackLaunchOptions.args.push(`--proxy-server=${fallbackProxyUrl}`);
                    const sanitizedProxyUrl = fallbackProxyUrl.includes('@') 
                        ? fallbackProxyUrl.replace(/\/\/([^:]+):[^@]+@/, '//***:***@') 
                        : fallbackProxyUrl;
                    console.log(`Attempting to launch with fallback proxy: ${sanitizedProxyUrl}`);
                    try {
                        browser = await puppeteer.launch(fallbackLaunchOptions);
                         // Not doing pre-flight for custom/env proxy, assume user knows if it works.
                        finalLaunchOptions = fallbackLaunchOptions;
                        console.log('Browser launched with fallback (environment/input) proxy.');
                    } catch (launchError) {
                        console.warn(`Failed to launch browser with fallback proxy: ${launchError.message}`);
                        if(browser) await browser.close(); browser = null;
                    }
                }
            }
        }

        // Final Attempt: Launch without proxy if all proxy attempts failed or useProxy is false
        if (!browser) {
            if (useProxy) console.warn('All proxy attempts failed. Proceeding without proxy.');
            else console.log('useProxy is false. Proceeding without proxy.');
            finalLaunchOptions = JSON.parse(JSON.stringify(baseLaunchOptions));
            finalLaunchOptions.args = finalLaunchOptions.args.filter(arg => !arg.startsWith('--proxy-server=')); // Ensure no proxy args
            try {
                browser = await puppeteer.launch(finalLaunchOptions);
                console.log('Browser launched successfully without proxy.');
            } catch (launchError) {
                console.error(`FATAL: Failed to launch browser even without proxy: ${launchError.message}`);
                throw launchError;
            }
        }
        
        console.log('Final browser launch options being used:', finalLaunchOptions);
        page = await browser.newPage();
        console.log('New page created.');
        
        await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
        console.log('Viewport set.');
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
        console.log('User agent set.');
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'sec-ch-ua': '"Not=A?Brand";v="99", "Chromium";v="124"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'sec-fetch-dest': 'document',
            'sec-fetch-mode': 'navigate',
            'sec-fetch-site': 'same-origin',
            'sec-fetch-user': '?1',
            'upgrade-insecure-requests': '1'
        });
        console.log('Extra HTTP headers set.');
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            if (['image', 'stylesheet', 'font'].includes(request.resourceType())) request.abort();
            else request.continue();
        });
        console.log('Request interception set up.');
        page.setDefaultNavigationTimeout(120000);
        page.setDefaultTimeout(90000);
        console.log('Default timeouts set.');

        console.log('Logging in to LinkedIn...');
        let retries = 3;
        let loginSuccessful = false;
        while (retries > 0 && !loginSuccessful) {
            try {
                console.log(`Navigating to login page (attempt ${4 - retries}/3)...`);
                await page.goto('https://www.linkedin.com/login', { waitUntil: ['networkidle2', 'domcontentloaded'], timeout: 90000 });
                const currentUrl = page.url();
                if (!currentUrl.includes('linkedin.com/login')) {
                    console.log(`Redirected to ${currentUrl} instead of login page. Assuming already logged in or different flow.`);
                    loginSuccessful = true; // Assume success if not on login page
                    break;
                }
                console.log('Login page navigation successful.');
                loginSuccessful = true; // Mark as successful to exit loop if goto works
            } catch (error) {
                console.warn(`Login page navigation attempt ${4 - retries}/3 failed: ${error.message}`);
                retries--;
                if (retries === 0) {
                    console.error('All login page navigation attempts failed.');
                    throw error; 
                }
                await new Promise(resolve => setTimeout(resolve, 5000 + Math.random() * 2000));
            }
        }
        
        if (!loginSuccessful && page.url().includes('linkedin.com/login')) {
             throw new Error('Failed to navigate to login page or was stuck on it.');
        }

        const loginFormExists = await page.evaluate(() => !!document.querySelector('#username') && !!document.querySelector('#password'));
        if (loginFormExists) {
            console.log('Login form detected. Proceeding with login.');
            await page.waitForSelector('#username', { timeout: 60000 });
            await page.waitForSelector('#password', { timeout: 60000 });
            console.log('Username and password fields found.');
            await page.type('#username', username, { delay: Math.floor(Math.random() * 150) + 50 });
            await new Promise(r => setTimeout(r, Math.floor(Math.random() * 1000) + 500));
            await page.type('#password', password, { delay: Math.floor(Math.random() * 100) + 30 });
            console.log('Credentials typed in.');
            await new Promise(r => setTimeout(r, Math.floor(Math.random() * 1000) + 500));
            await Promise.all([
                page.click('button[type="submit"]'),
                page.waitForNavigation({ waitUntil: ['networkidle2', 'domcontentloaded'], timeout: 90000 })
            ]);
            console.log('Submitted login form.');
        } else {
            console.log('Login form not detected. Assuming already logged in or on a different page (e.g., feed, authwall).');
        }
        console.log('Login flow completed. Current URL:', page.url());
        const cookies = await page.cookies();
        console.log(`Stored ${cookies.length} cookies.`);
        await new Promise(resolve => setTimeout(resolve, 5000));

        const posts = [];
        for (const profileUrl of profileUrls) {
            console.log(`Scraping posts from ${profileUrl}`);
            try {
                let profileNavRetries = 3;
                let profileNavSuccessful = false;
                while(profileNavRetries > 0 && !profileNavSuccessful) {
                    try {
                        console.log(`Navigating to profile ${profileUrl} (attempt ${4-profileNavRetries}/3)...`);
                        await page.goto(profileUrl, { waitUntil: ['networkidle2', 'domcontentloaded'], timeout: 120000 });
                        console.log(`Navigation to profile ${profileUrl} successful. Current URL: ${page.url()}`);
                        profileNavSuccessful = true;
                    } catch (error) {
                        console.warn(`Profile navigation attempt ${4-profileNavRetries}/3 for ${profileUrl} failed: ${error.message}`);
                        profileNavRetries--;
                        if(profileNavRetries === 0) {
                            console.error(`All navigation attempts for ${profileUrl} failed.`);
                            throw error;
                        }
                        await new Promise(resolve => setTimeout(resolve, 7000 + Math.random() * 3000));
                    }
                }
                if(!profileNavSuccessful) continue; // Skip to next profile if navigation failed

                await new Promise(resolve => setTimeout(resolve, 7000)); // Wait for dynamic content

                console.log(`Page URL before authwall check on ${profileUrl}: ${page.url()}`);
                const isAuthwall = await page.evaluate(() => {
                    return !!( document.querySelector('form#join-form') || document.querySelector('form.login-form') || 
                               document.querySelector('a[href*="linkedin.com/login"]') || 
                               document.querySelector('a[data-tracking-control-name="auth_wall_desktop_profile_guest_nav_login-button"]') ||
                               document.querySelector('h1[data-test-id="authwall-join-form__title"]') ||
                               document.body.innerText.toLowerCase().includes('sign in to linkedin') || 
                               document.body.innerText.toLowerCase().includes('join linkedin') ||
                               document.querySelector('.authwall-join-form') || document.querySelector('.authwall-login-form') ||
                               window.location.href.includes('authwall') || document.querySelector('[data-test-id="signup-modal"]'));
                });

                if (isAuthwall) {
                    console.warn(`WARNING: Detected authwall/login page at URL: ${page.url()} for ${profileUrl}.`);
                    const authwallHtml = await page.content();
                    const safeProfileUrlAuth = profileUrl.replace(/[^a-zA-Z0-9]/g, '_');
                    await Actor.setValue(`DEBUG_AUTHWALL_${safeProfileUrlAuth}.html`, authwallHtml, { contentType: 'text/html' });
                    await page.screenshot({ path: `DEBUG_AUTHWALL_${safeProfileUrlAuth}.png`, fullPage: true });
                    await Actor.setValue(`DEBUG_AUTHWALL_SCREENSHOT_${safeProfileUrlAuth}.png`, fs.readFileSync(`DEBUG_AUTHWALL_${safeProfileUrlAuth}.png`), { contentType: 'image/png' });
                    fs.unlinkSync(`DEBUG_AUTHWALL_${safeProfileUrlAuth}.png`);
                    console.error(`Authwall detected for ${profileUrl}. Skipping this profile. Check KVS for debug files.`);
                    continue; // Skip this profile
                }
                
                // ... (rest of the scraping logic: activity tab, scrolling, post extraction) ...
                // Ensure this part is also robust
                 console.log(`Waiting for profile main content on ${profileUrl}...`);
                const profileMainSelector = 'main[role="main"]';
                try {
                    await page.waitForSelector(profileMainSelector, { timeout: 75000 }); 
                    console.log(`Profile main content loaded for ${profileUrl} using selector: ${profileMainSelector}`);
                } catch (e) {
                    console.warn(`Primary selector '${profileMainSelector}' not found. Trying alternative '#profile-content'...`);
                    try {
                        await page.waitForSelector('#profile-content', { timeout: 75000 });
                        console.log(`Profile main content loaded for ${profileUrl} using selector: #profile-content`);
                    } catch (e2) {
                        console.error(`Both primary and alternative selectors for profile main content failed for ${profileUrl}: ${e2.message}`);
                        if (page && typeof page.content === 'function') {
                            const htmlContent = await page.content();
                            const safeProfileUrlDebug = profileUrl.replace(/[^a-zA-Z0-9]/g, '_');
                            await Actor.setValue(`DEBUG_MAIN_CONTENT_FAIL_${safeProfileUrlDebug}.html`, htmlContent, { contentType: 'text/html' });
                        }
                        throw e2; 
                    }
                }

                const activitySelectors = [
                    'a[href*="detail/recent-activity/shares"]',
                    'a[href*="detail/recent-activity/posts"]',
                    'a[href*="recent-activity/all"]',
                    'a[data-test-id="activity-section"]',
                    'a[data-control-name="recent_activity_details_all"]' 
                ];
                let activityButton = null;
                for (const selector of activitySelectors) {
                    activityButton = await page.$(selector);
                    if (activityButton) { console.log(`Activity tab found with selector: ${selector}`); break; }
                }
                if (!activityButton) {
                    console.warn(`No activity tab found for ${profileUrl}. Skipping post extraction for this profile.`);
                    continue;
                }
                await Promise.all([
                    activityButton.click(),
                    page.waitForNavigation({ waitUntil: ['networkidle2', 'domcontentloaded'], timeout: 90000 })
                ]);
                console.log(`Activity page navigation complete for ${profileUrl}.`);
                await new Promise(resolve => setTimeout(resolve, 7000));

                let loadedPostElements = [];
                let previousHeight = 0;
                let noNewPostsScrollCount = 0;
                const maxScrollAttempts = 10;
                console.log(`Starting scroll loop for ${profileUrl}...`);
                while (noNewPostsScrollCount < maxScrollAttempts) {
                    loadedPostElements = await page.$$('.occludable-update, .feed-shared-update-v2');
                    console.log(`Found ${loadedPostElements.length} potential post elements in current view on ${profileUrl}.`);
                    if (maxPosts > 0 && posts.length + loadedPostElements.length >= maxPosts) {
                         console.log(`Max posts limit (${maxPosts}) potentially reached.`);
                         break; 
                    }
                    const currentHeight = await page.evaluate(() => document.documentElement.scrollHeight);
                    if (currentHeight === previousHeight) {
                        noNewPostsScrollCount++;
                        console.log(`Scroll height unchanged. Attempt ${noNewPostsScrollCount}/${maxScrollAttempts}.`);
                    } else {
                        noNewPostsScrollCount = 0;
                    }
                    if (noNewPostsScrollCount >= 3) { // Be more aggressive if height hasn't changed for 3 scrolls
                        console.log('Scroll height unchanged for 3 attempts, trying a more forceful scroll or breaking.');
                        await page.evaluate(() => window.scrollBy(0, window.innerHeight + 200)); // Try a larger scroll
                        await new Promise(resolve => setTimeout(resolve, 4000 + Math.random()*1000));
                        const newHeightAfterForceScroll = await page.evaluate(() => document.documentElement.scrollHeight);
                        if (newHeightAfterForceScroll === currentHeight && noNewPostsScrollCount >= 5) {
                           console.log('Force scroll did not change height. Assuming all posts loaded.'); break;
                        } else if (newHeightAfterForceScroll !== currentHeight) {
                            noNewPostsScrollCount = 0; // Reset if force scroll helped
                        }
                    }
                     if (noNewPostsScrollCount >= maxScrollAttempts ) break;

                    previousHeight = currentHeight;
                    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
                    await new Promise(resolve => setTimeout(resolve, 3000 + Math.random()*1000));
                }
                console.log(`Finished scroll loop for ${profileUrl}. Processing ${loadedPostElements.length} elements.`);

                let profilePostCount = 0;
                for (const postElement of loadedPostElements) {
                    if (maxPosts > 0 && posts.length >= maxPosts) break;
                    try {
                        const postData = await page.evaluate(element => {
                            const textElement = element.querySelector('.feed-shared-update-v2__description .feed-shared-inline-show-more-text, .feed-shared-text, .update-components-text');
                            const text = textElement ? textElement.innerText.trim() : '';
                            const timeElement = element.querySelector('time, .update-components-text-view__timestamp');
                            const timestamp = timeElement ? (timeElement.getAttribute('datetime') || timeElement.innerText.trim()) : '';
                            const likesElement = element.querySelector('.social-details-social-counts__reactions-count, .social-details-social-counts__count-value');
                            const likesText = likesElement ? likesElement.innerText.trim() : '0';
                            const likes = parseInt(likesText.replace(/[^0-9]/g, '')) || 0;
                            return { text, timestamp, likes };
                        }, postElement);
                        if (postData.text) {
                            posts.push({ ...postData, profileUrl, scrapedAt: new Date().toISOString() });
                            profilePostCount++;
                        }
                    } catch (extractError) {
                        console.error(`Error extracting post data on ${profileUrl}: ${extractError.message}`);
                    }
                }
                console.log(`Scraped ${profilePostCount} posts from ${profileUrl}. Total posts: ${posts.length}`);

            } catch (profileError) {
                console.error(`Failed to process profile ${profileUrl}: ${profileError.message}`);
                if (page && typeof page.screenshot === 'function') {
                     try {
                        const safeProfileUrlErr = profileUrl.replace(/[^a-zA-Z0-9]/g, '_');
                        await page.screenshot({ path: `PROFILE_ERROR_${safeProfileUrlErr}.png`, fullPage: true });
                        await Actor.setValue(`PROFILE_ERROR_SCREENSHOT_${safeProfileUrlErr}.png`, fs.readFileSync(`PROFILE_ERROR_${safeProfileUrlErr}.png`), { contentType: 'image/png' });
                        fs.unlinkSync(`PROFILE_ERROR_${safeProfileUrlErr}.png`);
                        console.log(`Saved error screenshot for profile ${profileUrl}.`);
                    } catch (screenshotError) {
                        console.warn(`Failed to take profile error screenshot for ${profileUrl}: ${screenshotError.message}`);
                    }
                }
            }
        }

        await Actor.pushData(posts);
        console.log(`Successfully scraped ${posts.length} total posts.`);
        
    } catch (error) {
        console.error(`Scraping failed globally: ${error.message}`, { stack: error.stack });
        if (page && typeof page.screenshot === 'function') {
            try {
                await page.screenshot({ path: 'GLOBAL_ERROR.png', fullPage: true });
                await Actor.setValue('GLOBAL_ERROR_SCREENSHOT.png', fs.readFileSync('GLOBAL_ERROR.png'), { contentType: 'image/png' });
                fs.unlinkSync('GLOBAL_ERROR.png');
                console.log('Global error screenshot saved.');
            } catch (screenshotError) {
                console.warn(`Failed to take global error screenshot: ${screenshotError.message}`);
            }
        }
        throw error;
    } finally {
        if (browser) {
            try {
                console.log('Closing browser...');
                await browser.close();
                console.log('Browser closed.');
            } catch (closeError) {
                console.error(`Error closing browser: ${closeError.message}`);
            }
        }
        console.log('scrapeLinkedIn function finished.');
    }
}

console.log('Logging setup: About to call Actor.main(scrapeLinkedIn)');
Actor.main(scrapeLinkedIn);