const { Actor } = require('apify');
const moment = require('moment');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const ProxyChain = require('proxy-chain');

puppeteer.use(StealthPlugin());

// Initialize the actor
Actor.init();

async function scrapeLinkedIn() {
    let browser = null;
    let page = null;

    try {
        const input = await Actor.getInput();
        const { 
            username,
            password,
            profileUrls,
            maxPosts = 0,
            useProxy = false,
            proxyUrl // Expecting a proxyUrl field in input if useProxy is true
        } = input;

        const launchOptions = {
            headless: "new",
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--window-size=1920,1080',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--single-process', // Might help in resource-constrained environments
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process'
            ]
        };

        if (useProxy && proxyUrl) {
            console.log(`Using proxy: ${proxyUrl}`);
            const newProxyUrl = await ProxyChain.anonymizeProxy(proxyUrl);
            launchOptions.args.push(`--proxy-server=${newProxyUrl}`);
        } else if (useProxy && !proxyUrl) {
            console.warn('useProxy is true, but no proxyUrl was provided. Proceeding without proxy.');
        }

        // Launch browser
        browser = await puppeteer.launch(launchOptions);

        page = await browser.newPage();
        
        // Set viewport
        await page.setViewport({
            width: 1920,
            height: 1080,
            deviceScaleFactor: 1,
        });

        // Setup request interception
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            if (['image', 'stylesheet', 'font', 'media'].includes(request.resourceType())) {
                request.abort();
            } else {
                request.continue();
            }
        });

        // Set default timeout
        page.setDefaultNavigationTimeout(180000); // 3 minutes
        page.setDefaultTimeout(90000); // 1.5 minutes

        // Login to LinkedIn
        console.log('Logging in to LinkedIn...');
        
        // Navigate to login page with retry mechanism
        let retries = 3;
        while (retries > 0) {
            try {
                await page.goto('https://www.linkedin.com/login', {
                    waitUntil: 'networkidle2', // Changed from networkidle0
                    timeout: 180000
                });
                break;
            } catch (error) {
                console.log(`Login page navigation retry attempt ${4 - retries}/3. Error: ${error.message}`);
                retries--;
                if (retries === 0) throw error;
                await new Promise(resolve => setTimeout(resolve, 10000)); // Increased wait time
            }
        }

        // Check for CAPTCHA or other blocks
        const captchaSelectors = ['iframe[title*="CAPTCHA"]' , '[id*="captcha"]' , '[name*="captcha"]' ];
        for (const selector of captchaSelectors) {
            if (await page.$(selector)) {
                console.warn(`CAPTCHA or similar block detected with selector: ${selector}. This might prevent login.`);
                await Actor.setValue('CAPTCHA_DETECTED', true);
                // Optionally, save a screenshot
                await page.screenshot({ path: 'captcha_detected.png' });
                await Actor.pushData({ error: 'CAPTCHA detected', details: `Selector: ${selector}` });
                // It might be necessary to stop here or implement CAPTCHA solving if it's a persistent issue.
            }
        }

        // Check if login page loaded correctly
        const usernameSelector = '#username';
        const passwordSelector = '#password';
        
        try {
            await page.waitForSelector(usernameSelector, { timeout: 60000 });
            await page.waitForSelector(passwordSelector, { timeout: 60000 });
        } catch (e) {
            console.error('Login form not found. Page content might be unexpected.');
            await page.screenshot({ path: 'login_form_not_found.png' });
            throw new Error('Login form not found. LinkedIn might have changed its layout or a block is active.');
        }


        await page.type(usernameSelector, username);
        await page.type(passwordSelector, password);
        
        // Click login button and wait for navigation
        await Promise.all([
            page.click('button[type="submit"]'),
            page.waitForNavigation({ 
                waitUntil: 'networkidle2', // Changed from networkidle0
                timeout: 180000 
            })
        ]);

        // Check for login success (e.g., by looking for a feed element or profile icon)
        const feedSelector = '[role="feed"], #feed-tab-icon, [data-control-name="identity_profile_photo"]'; // Example selectors for feed/profile
        try {
            await page.waitForSelector(feedSelector, { timeout: 60000 });
            console.log('Login appears successful.');
        } catch (error) {
            console.error('Login failed or took too long to redirect to the main page.');
            await page.screenshot({ path: 'login_failed.png' });
            throw new Error('Login failed. Check credentials or for potential blocks like CAPTCHA/2FA.');
        }

        const posts = [];
        for (const profileUrl of profileUrls) {
            console.log(`Scraping posts from ${profileUrl}`);
            
            try {
                // Navigate to profile with retry mechanism
                retries = 3;
                while (retries > 0) {
                    try {
                        await page.goto(profileUrl, {
                            waitUntil: 'networkidle2',
                            timeout: 180000
                        });
                        break;
                    } catch (error) {
                        console.log(`Profile navigation retry attempt ${4 - retries}/3. Error: ${error.message}`);
                        retries--;
                        if (retries === 0) throw error;
                        await new Promise(resolve => setTimeout(resolve, 10000));
                    }
                }

                // Wait for profile content to load
                await page.waitForSelector('.pv-top-card', { timeout: 90000 });

                // Find and click the Activity/Posts tab
                const activitySelectors = [
                    'a[href*="detail/recent-activity/shares"]',
                    'a[href*="detail/recent-activity/posts"]',
                    'a[href*="recent-activity/all"]',
                    'a[data-test-id="activity-section"]' // Common selector
                ];

                let activityButton = null;
                for (const selector of activitySelectors) {
                    try {
                        activityButton = await page.waitForSelector(selector, { timeout: 10000 }); // Wait for selector to be present
                        if (activityButton) break;
                    } catch (e) {
                        // Selector not found, try next
                    }
                }

                if (!activityButton) {
                    console.warn(`No activity tab found for ${profileUrl}. Taking screenshot: no_activity_tab.png`);
                    await page.screenshot({ path: 'no_activity_tab.png'});
                    continue;
                }

                await Promise.all([
                    activityButton.click(),
                    page.waitForNavigation({ 
                        waitUntil: 'networkidle2', 
                        timeout: 180000 
                    })
                ]);

                // Wait for posts to potentially load after navigation
                await new Promise(resolve => setTimeout(resolve, 7000)); // Increased wait

                // Scroll and collect posts
                let loadedPosts = [];
                let previousHeight = 0;
                let noNewPostsCount = 0;
                const maxScrollAttempts = 15; // Increased scroll attempts
                let scrollCount = 0;

                console.log('Starting scroll to load posts...');
                while (scrollCount < maxScrollAttempts) {
                    loadedPosts = await page.$$('.occludable-update, .feed-shared-update-v2, .social-details-social-activity, .scaffold-finite-scroll__content > div'); // Added more general selectors
                    console.log(`Scroll attempt ${scrollCount + 1}/${maxScrollAttempts}: Found ${loadedPosts.length} potential post elements in current view.`);
                    
                    if (maxPosts > 0 && posts.length >= maxPosts) {
                        console.log(`Reached maxPosts limit (${maxPosts}).`);
                        break;
                    }

                    const currentHeight = await page.evaluate(() => document.body.scrollHeight);
                    await page.evaluate(() => {
                        window.scrollTo(0, document.body.scrollHeight);
                    });
                    await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for scroll and content load
                    
                    const newHeight = await page.evaluate(() => document.body.scrollHeight);

                    if (newHeight === currentHeight) {
                        noNewPostsCount++;
                        console.log(`Height did not change after scroll. No new posts count: ${noNewPostsCount}`);
                        if (noNewPostsCount >= 3) { // Consider no new posts after 3 static scrolls
                           console.log('No new posts loaded after multiple scrolls, stopping scroll for this profile.');
                           break;
                        }
                    } else {
                        noNewPostsCount = 0;
                    }
                    scrollCount++;
                }
                console.log(`Finished scrolling. Total potential posts found: ${loadedPosts.length}`);

                // Extract post data
                for (const postElement of loadedPosts) {
                    if (maxPosts > 0 && posts.length >= maxPosts) break;
                    try {
                        const postData = await page.evaluate(element => {
                            const textElement = element.querySelector('.feed-shared-update-v2__description .text-view-model, .feed-shared-text, .update-components-text');
                            const text = textElement ? textElement.innerText.trim() : '';
                            
                            const timeElement = element.querySelector('time, .feed-shared-actor__sub-description');
                            const timestamp = timeElement ? (timeElement.getAttribute('datetime') || timeElement.innerText.trim()) : '';
                            
                            const likesElement = element.querySelector('.social-details-social-counts__reactions-count, .social-details-social-counts__count-value');
                            const likesText = likesElement ? likesElement.innerText.trim() : '0';
                            const likes = parseInt(likesText.replace(/[^0-9]/g, '')) || 0;
                            
                            return {
                                text,
                                timestamp,
                                likes
                            };
                        }, postElement);

                        if (postData.text) {
                            posts.push({
                                ...postData,
                                profileUrl,
                                scrapedAt: new Date().toISOString()
                            });
                        }
                    } catch (error) {
                        console.warn('Error extracting single post data:', error.message);
                    }
                }
                console.log(`Scraped ${posts.filter(p=>p.profileUrl === profileUrl).length} posts from ${profileUrl} (total ${posts.length})`);
            } catch (error) {
                console.error(`Error scraping profile ${profileUrl}:`, error);
                await page.screenshot({ path: `error_profile_${profileUrl.split('/').pop()}.png` });
            }
        }

        // Save the results
        await Actor.pushData(posts);
        console.log(`Successfully scraped ${posts.length} total posts`);
        if (posts.length === 0) {
            console.warn('No posts were scraped. Check logs for errors, CAPTCHA, or incorrect selectors.');
        }
        
    } catch (error) {
        console.error('Scraping failed due to an unrecoverable error:', error);
        
        if (page && typeof page.screenshot === 'function') {
            try {
                await page.screenshot({
                    path: 'fatal_error.png',
                    fullPage: true
                });
                console.log('Fatal error screenshot saved to fatal_error.png');
            } catch (screenshotError) {
                console.error('Failed to take fatal error screenshot:', screenshotError);
            }
        }
        
        await Actor.setValue('FATAL_ERROR_DETAILS', { message: error.message, stack: error.stack });
        throw error;
    } finally {
        if (browser) {
            try {
                await browser.close();
            } catch (error) {
                console.error('Error closing browser:', error);
            }
        }
        // Ensure the actor exits after completion or failure
        await Actor.exit();
    }
}

// Run the actor
Actor.main(scrapeLinkedIn);