const { Actor } = require('apify');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Random delay between actions to mimic human behavior
const humanDelay = async (min = 500, max = 2000) => {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise(resolve => setTimeout(resolve, delay));
};

// Human-like typing
const humanType = async (page, selector, text) => {
    await page.focus(selector);
    await humanDelay(300, 800);
    
    for (let i = 0; i < text.length; i++) {
        await page.keyboard.type(text[i]);
        await humanDelay(30, 150);
    }
};

Actor.main(async () => {
    console.log('Starting LinkedIn Profile Posts Scraper');
    
    const input = await Actor.getInput();
    console.log('Input loaded');
    
    const { 
        username,
        password,
        profileUrls,
        maxPosts = 0,
        useProxy = true,
        proxyConfiguration, // This is the user-provided proxy configuration from input
        debugMode = false
    } = input;

    if (!username || !password || !profileUrls || profileUrls.length === 0) {
        throw new Error('Missing required input: username, password, and at least one profile URL are required');
    }

    console.log(`LinkedIn Profile Posts Scraper configuration:
- Number of profiles to scrape: ${profileUrls.length}
- Max posts per profile: ${maxPosts || 'unlimited'}
- Using proxy: ${useProxy ? 'yes' : 'no'}`);

    let activeProxyUrl = null; 
    
    const launchOptions = {
        headless: true,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--window-size=1920,1080',
            '--disable-notifications',
            '--disable-extensions',
            '--disable-component-extensions-with-background-pages'
        ]
    };

    if (useProxy) {
        console.log('Attempting to configure proxy...');
        try {
            // Ensure proxyConfiguration is at least an empty object if undefined
            const effectiveProxyInput = proxyConfiguration || {}; 
            
            console.log('Using effective proxy input:', JSON.stringify({
                ...effectiveProxyInput,
                password: effectiveProxyInput.password ? '****' : undefined, // Mask password
                proxyUrls: effectiveProxyInput.proxyUrls ? ['****'] : undefined // Mask proxyUrls
            }, null, 2));

            const proxyConfigObject = await Actor.createProxyConfiguration(effectiveProxyInput);

            if (!proxyConfigObject) {
                console.warn('Actor.createProxyConfiguration did not return a proxy configuration object.');
            } else {
                if (proxyConfigObject.groups && proxyConfigObject.groups.length > 0) {
                    console.log(`Proxy groups in config object: ${proxyConfigObject.groups.join(', ')}`);
                } else {
                    console.log('No specific proxy groups found in config object.');
                }

                try {
                    const generatedUrl = proxyConfigObject.newUrl();
                    console.log(`Value returned by proxyConfigObject.newUrl(): ${JSON.stringify(generatedUrl)}`);

                    if (typeof generatedUrl === 'string' && generatedUrl.length > 0) {
                        activeProxyUrl = generatedUrl;
                        const maskedUrl = activeProxyUrl.replace(/:[^:@]*@/, ':****@'); // Mask credentials
                        console.log(`Successfully generated proxy URL: ${maskedUrl}`);
                        launchOptions.args.push(`--proxy-server=${activeProxyUrl}`);
                    } else {
                        console.warn(`proxyConfigObject.newUrl() did not return a valid URL string. Received: ${typeof generatedUrl}`);
                    }
                } catch (newUrlError) {
                    console.error(`Error calling proxyConfigObject.newUrl(): ${newUrlError.message}`, newUrlError);
                }
            }
        } catch (error) {
            console.error(`Error during proxy setup: ${error.message}`, error);
        }

        if (!activeProxyUrl) {
            console.error('Failed to obtain a valid proxy URL, but useProxy is true. This is a critical error. Please check your proxy configuration and Apify account.');
            throw new Error('Proxy is enabled, but a valid proxy URL could not be obtained. Halting actor.');
        }
    } else {
        console.log('Proxy usage is disabled by input configuration. Proceeding without proxy.');
    }

    console.log('Final browser launch options (proxy URL masked if present):', JSON.stringify({
        ...launchOptions,
        args: launchOptions.args.map(arg => 
            arg.startsWith('--proxy-server=') ? `--proxy-server=http://****:****@proxy.apify.com:8000` : arg // Generic masking
        )
    }, null, 2));
    
    const browser = await puppeteer.launch(launchOptions);
    console.log('Browser launched successfully');
    
    const page = await browser.newPage();
    console.log('New page created');
    
    await page.setUserAgent(DEFAULT_USER_AGENT);
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });

    await page.setRequestInterception(true);
    page.on('request', (request) => {
        const resourceType = request.resourceType();
        if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
            request.abort();
        } else {
            request.continue();
        }
    });

    page.on('error', error => console.error('Page error:', error.message));
    page.on('requestfailed', request => {
        const failure = request.failure();
        console.warn(`Request failed: ${request.method()} ${request.url()} - ${failure ? failure.errorText : 'Unknown error'}`);
    });
    
    if (debugMode) {
        page.on('request', request => console.log(`DEBUG Request: ${request.method()} ${request.url()}`));
        page.on('response', response => console.log(`DEBUG Response: ${response.status()} ${response.url()}`));
    }

    const posts = [];
    let loginSuccessful = false;
    
    try {
        console.log('Attempting to login to LinkedIn');
        loginSuccessful = await login(page, username, password);
        
        if (!loginSuccessful) {
            throw new Error('Failed to login to LinkedIn after multiple attempts');
        }
        
        for (const profileUrl of profileUrls) {
            console.log(`Processing profile: ${profileUrl}`);
            const profilePosts = await scrapeProfilePosts(page, profileUrl, maxPosts);
            posts.push(...profilePosts);
            console.log(`Scraped ${profilePosts.length} posts from ${profileUrl}`);
            if (profileUrls.indexOf(profileUrl) < profileUrls.length - 1) {
                 console.log('Waiting before processing next profile...');
                 await humanDelay(3000, 5000);
            }
        }
        
        console.log(`Successfully scraped ${posts.length} posts total`);
        await Actor.pushData(posts);

    } catch (error) {
        console.error('Scraping run failed:', error.message, error.stack);
        if (page && !page.isClosed()) {
            try {
                const screenshotBuffer = await page.screenshot({ fullPage: true });
                await Actor.setValue('ERROR_SCREENSHOT.png', screenshotBuffer, { contentType: 'image/png' });
                const htmlContent = await page.content();
                await Actor.setValue('ERROR_HTML.html', htmlContent, { contentType: 'text/html' });
                console.log('Error debug data (screenshot, HTML) saved to Key-Value Store.');
            } catch (debugError) {
                console.error('Failed to save debug data (screenshot, HTML):', debugError.message);
            }
        } else {
            console.log('Page was closed or undefined; cannot save screenshot/HTML.');
        }
        throw error; // Re-throw the error to mark the actor run as failed
    } finally {
        console.log('Closing browser...');
        if (browser) {
            await browser.close();
            console.log('Browser closed.');
        }
    }
    
    console.log('LinkedIn Profile Posts Scraper finished successfully.');
});

async function login(page, username, password) {
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        console.log(`Login attempt ${attempt}/${MAX_ATTEMPTS}`);
        try {
            await page.goto('https://www.linkedin.com/login', { waitUntil: 'networkidle2', timeout: 60000 });
            console.log(`Navigated to login page. Current URL: ${page.url()}`);

            if (await page.evaluate(() => !!document.querySelector('.global-nav'))) {
                console.log('Already logged in (detected global nav).');
                return true;
            }
            
            const isLoginPage = await page.evaluate(() => !!document.querySelector('#username') && !!document.querySelector('#password'));
            if (!isLoginPage) {
                console.warn('Not on the expected login page structure.');
                const authWallText = await page.evaluate(() => document.body.innerText.toLowerCase());
                if (authWallText.includes('authwall') || authWallText.includes('sign in to continue')) {
                     console.warn('Authwall detected on navigation to login page.');
                }
                await humanDelay(2000, 4000); // Wait a bit before retrying or failing
                continue; // Try next attempt
            }

            await humanType(page, '#username', username);
            await humanType(page, '#password', password);
            
            await Promise.all([
                page.click('button[type="submit"]'),
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 })
            ]);
            console.log(`Navigation after login attempt. Current URL: ${page.url()}`);

            if (await checkForAuthWall(page)) {
                console.warn('Login attempt resulted in an auth wall.');
                await humanDelay(5000, 10000); // Longer delay if auth wall hit
                continue; 
            }
            
            // More robust check for successful login, e.g., presence of feed or profile elements
             if (await page.evaluate(() => !!document.querySelector('.feed-identity-module') || !!document.querySelector('.global-nav__me'))) {
                console.log('Login successful (detected feed or profile elements).');
                return true;
            } else {
                console.warn('Login may not have been successful, feed/profile elements not detected.');
                // Potentially save debug data here
            }

        } catch (error) {
            console.error(`Error during login attempt ${attempt}: ${error.message}`, error.stack);
            if (page && !page.isClosed()) {
                try {
                    await Actor.setValue(`DEBUG_LOGIN_ATTEMPT_${attempt}_ERROR.png`, await page.screenshot(), { contentType: 'image/png' });
                } catch (e) { console.error('Failed to save login error screenshot', e); }
            }
            if (attempt === MAX_ATTEMPTS) {
                 console.error('All login attempts failed.');
                 return false;
            }
            await humanDelay(5000, 10000); // Wait before retrying
        }
    }
    return false;
}

async function scrapeProfilePosts(page, profileUrl, maxPosts) {
    const posts = [];
    console.log(`Navigating to profile: ${profileUrl}`);
    try {
        await page.goto(profileUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        console.log(`On profile page. Current URL: ${page.url()}`);

        if (await checkForAuthWall(page)) {
            console.warn(`Auth wall detected on profile page ${profileUrl}. Skipping profile.`);
            return [];
        }
        
        try {
            await page.waitForSelector('.pv-top-card', { timeout: 20000 }); // Increased timeout
            console.log('Profile top card loaded.');
        } catch (e) {
            console.warn(`Could not find .pv-top-card on ${profileUrl}. Page might not have loaded correctly or structure changed.`);
            // Save debug info
             if (page && !page.isClosed()) {
                await Actor.setValue(`DEBUG_PROFILE_LOAD_FAIL_${profileUrl.replace(/[^a-zA-Z0-9]/g, '_')}.png`, await page.screenshot(), { contentType: 'image/png' });
            }
            return []; // Skip this profile
        }
        
        const activitySelectors = [
            'a[href*="detail/recent-activity/shares"]', // Posts
            'a[data-control-name="recent_activity_details_all"]', // All activity, then filter for posts
            'a[href*="/detail/recent-activity/"]', // Generic recent activity
             '.pv-recent-activity-section__see-all-button',
             '#content_collections > section > div > div > div > a', // Another possible selector for "see all activity"
        ];
        
        let activityButton = null;
        for (const selector of activitySelectors) {
            activityButton = await page.$(selector);
            if (activityButton) {
                console.log(`Found activity button with selector: ${selector}`);
                break;
            }
        }
        
        if (!activityButton) {
            console.warn(`No activity/posts tab button found for profile ${profileUrl}. It's possible the profile has no public posts or the selectors need updating.`);
             if (page && !page.isClosed()) {
                await Actor.setValue(`DEBUG_NO_ACTIVITY_BUTTON_${profileUrl.replace(/[^a-zA-Z0-9]/g, '_')}.png`, await page.screenshot(), { contentType: 'image/png' });
            }
            return [];
        }

        console.log('Clicking activity/posts button...');
        await Promise.all([
            activityButton.click(),
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }) // Increased timeout
        ]);
        console.log(`Navigated to activity page. Current URL: ${page.url()}`);

        // Optional: Filter for "Posts" if on a general activity page
        // This depends on LinkedIn's structure which can change
        // Example: await page.click('button[aria-pressed="false"]:has-text("Posts")');
        // await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });

        console.log('Scrolling to load posts...');
        let loadedPostElements = [];
        let previousHeight = 0;
        let noChangeScrolls = 0;
        const MAX_NO_CHANGE_SCROLLS = 5; // Increased tolerance

        for (let scrollAttempt = 0; scrollAttempt < 30; scrollAttempt++) { // Max 30 scroll attempts
            loadedPostElements = await page.$$('.occludable-update, .profile-creator-shared-feed-update__container, .feed-shared-update-v2'); // Added more selectors
            console.log(`Found ${loadedPostElements.length} post elements (scroll attempt ${scrollAttempt + 1})`);
            
            if (maxPosts > 0 && posts.length >= maxPosts) { // Check against 'posts' which stores extracted data
                console.log(`Reached desired maximum of ${maxPosts} extracted posts.`);
                break;
            }

            const currentHeight = await page.evaluate(() => document.body.scrollHeight);
            await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
            await humanDelay(1500, 2500); // Slightly longer delay for content to load

            if (currentHeight === previousHeight) {
                noChangeScrolls++;
                console.log(`Scroll height (${currentHeight}) did not change. No change count: ${noChangeScrolls}`);
                if (noChangeScrolls >= MAX_NO_CHANGE_SCROLLS) {
                    console.log('Page height has not changed after multiple scroll attempts. Assuming all posts loaded.');
                    break;
                }
            } else {
                noChangeScrolls = 0; // Reset if height changed
                previousHeight = currentHeight;
            }
             if (scrollAttempt === 29) {
                console.log('Reached maximum scroll attempts.');
            }
        }
        
        console.log(`Finished scrolling. Found ${loadedPostElements.length} potential post elements to process.`);
        
        for (const postElement of loadedPostElements) {
            if (maxPosts > 0 && posts.length >= maxPosts) break;
            try {
                const postData = await postElement.evaluate(element => {
                    const getText = (selector) => element.querySelector(selector)?.innerText.trim() || '';
                    const getAttribute = (selector, attr) => element.querySelector(selector)?.getAttribute(attr) || '';

                    // More robust selectors
                    let text = getText('.feed-shared-update-v2__description .update-components-text, .update-components-text__text--rich'); // Common text containers
                    if (!text) text = getText('.feed-shared-text, .break-words'); // Fallback text selectors
                    if (!text) text = getText('span[dir="ltr"]'); // another common one

                    const timestamp = getAttribute('time.feed-shared-actor__sub-description-timestamp', 'datetime') || 
                                      getAttribute('.feed-shared-actor__meta time', 'datetime') ||
                                      getAttribute('time', 'datetime'); // Fallback

                    let likes = getText('.social-details-social-counts__reactions-count') ||
                                getText('.social-details-social-counts__social-proof-text'); // Can include "K" or "M"
                    if (!likes) likes = getText('button[aria-label*="reaction"] span[aria-hidden="true"]');


                    // Try to extract post URL more reliably
                    let postUrl = '';
                    const links = Array.from(element.querySelectorAll('a[href*="/feed/update/urn:li:activity:"]'));
                    if (links.length > 0) {
                        postUrl = links[0].href;
                    } else {
                         // Look for URN in data attributes as a fallback
                        const urnElement = element.closest('[data-urn]') || element.querySelector('[data-urn]');
                        if (urnElement) {
                            const urn = urnElement.getAttribute('data-urn');
                            if (urn && urn.startsWith('urn:li:activity:')) {
                                postUrl = `https://www.linkedin.com/feed/update/${urn}/`;
                            } else if (urn && urn.startsWith('urn:li:share:')) {
                                 postUrl = `https://www.linkedin.com/feed/update/${urn.replace('share','activity')}/`; // Attempt conversion
                            }
                        }
                    }


                    return {
                        text,
                        timestamp,
                        likesStr: likes || '0', // Keep as string for now
                        postUrl
                    };
                });

                if (postData.text || postData.postUrl) { // Ensure there's some content
                    posts.push({
                        text: postData.text,
                        timestamp: postData.timestamp,
                        likes: parseInt(postData.likesStr.replace(/[^0-9]/g, '')) || 0, // Clean and parse likes
                        postUrl: postData.postUrl,
                        profileUrl,
                        scrapedAt: new Date().toISOString()
                    });
                }
            } catch (error) {
                console.error('Error extracting individual post data:', error.message);
            }
        }
        console.log(`Extracted ${posts.length} posts from ${profileUrl} after processing elements.`);
        return posts;

    } catch (error) {
        console.error(`Critical error processing profile ${profileUrl}: ${error.message}`, error.stack);
         if (page && !page.isClosed()) {
            try {
                await Actor.setValue(`DEBUG_PROFILE_PROCESSING_ERROR_${profileUrl.replace(/[^a-zA-Z0-9]/g, '_')}.png`, await page.screenshot(), { contentType: 'image/png' });
            } catch(e) { console.error('Failed to save profile processing error screenshot', e); }
        }
        return []; // Return empty array for this profile on error
    }
}

async function checkForAuthWall(page) {
    try {
        const onAuthWall = await page.evaluate(() => {
            const title = document.title.toLowerCase();
            const bodyText = document.body.innerText.toLowerCase();
            if (title.includes('linkedin login') || title.includes('sign in') || title.includes('authwall')) return true;
            if (bodyText.includes('authwall') || bodyText.includes('sign in to continue') || bodyText.includes('to protect your account')) return true;
            return !!(
                document.querySelector('form#join-form') ||
                document.querySelector('form.login-form') ||
                document.querySelector('main#main-content.authwall-main') ||
                document.querySelector('a[href*="linkedin.com/login"]') ||
                document.querySelector('a[data-tracking-control-name="auth_wall_desktop_profile_guest_nav_login-button"]') ||
                document.querySelector('h1[data-test-id="authwall-join-form__title"]') ||
                document.querySelector('.authwall-join-form, .authwall-login-form, [data-test-id="authwall"]')
            );
        });
        if (onAuthWall) console.warn('Authwall detected by checkForAuthWall function.');
        return onAuthWall;
    } catch (e) {
        console.error('Error in checkForAuthWall:', e.message);
        return false; // Assume not on auth wall if an error occurs during check
    }
}
