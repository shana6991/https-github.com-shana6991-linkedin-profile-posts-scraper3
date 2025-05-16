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
        Actor.log.info('Input received:', input);
        const { 
            username,
            password,
            profileUrls,
            maxPosts = 0,
            useProxy = false
        } = input;

        Actor.log.info('Launching browser...');
        browser = await puppeteer.launch({
            headless: "new",
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--window-size=1920,1080',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu'
            ]
        });
        Actor.log.info('Browser launched.');

        page = await browser.newPage();
        Actor.log.info('New page created.');
        
        await page.setViewport({
            width: 1920,
            height: 1080,
            deviceScaleFactor: 1,
        });
        Actor.log.info('Viewport set.');

        await page.setRequestInterception(true);
        page.on('request', (request) => {
            if (['image', 'stylesheet', 'font'].includes(request.resourceType())) {
                request.abort();
            } else {
                request.continue();
            }
        });
        Actor.log.info('Request interception set up.');

        page.setDefaultNavigationTimeout(100000); // ~1.5 minutes for default navigation
        page.setDefaultTimeout(60000); // 1 minute for other actions
        Actor.log.info('Default timeouts set.');

        Actor.log.info('Logging in to LinkedIn...');
        
        let retries = 3;
        while (retries > 0) {
            try {
                Actor.log.info(`Navigating to login page (attempt ${4 - retries}/3)...`);
                await page.goto('https://www.linkedin.com/login', {
                    waitUntil: ['networkidle2', 'domcontentloaded'], // Changed to networkidle2
                    timeout: 90000 // Reduced to 90 seconds
                });
                Actor.log.info('Login page navigation successful.');
                break;
            } catch (error) {
                Actor.log.warn(`Login page navigation attempt ${4 - retries}/3 failed: ${error.message}`);
                retries--;
                if (retries === 0) {
                    Actor.log.error('All login page navigation attempts failed.');
                    throw error;
                }
                await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5s before retry
            }
        }

        const usernameSelector = '#username';
        const passwordSelector = '#password';
        
        Actor.log.info('Waiting for username and password fields...');
        await page.waitForSelector(usernameSelector, { timeout: 60000 });
        await page.waitForSelector(passwordSelector, { timeout: 60000 });
        Actor.log.info('Username and password fields found.');

        await page.type(usernameSelector, username);
        await page.type(passwordSelector, password);
        Actor.log.info('Credentials typed in.');
        
        Actor.log.info('Clicking login button and waiting for navigation...');
        await Promise.all([
            page.click('button[type="submit"]'),
            page.waitForNavigation({ 
                waitUntil: ['networkidle2', 'domcontentloaded'], // Changed to networkidle2
                timeout: 90000 // Reduced to 90 seconds 
            })
        ]);
        Actor.log.info('Login successful, navigation complete.');

        const posts = [];
        for (const profileUrl of profileUrls) {
            Actor.log.info(`Scraping posts from ${profileUrl}`);
            
            try {
                retries = 3;
                while (retries > 0) {
                    try {
                        Actor.log.info(`Navigating to profile ${profileUrl} (attempt ${4 - retries}/3)...`);
                        await page.goto(profileUrl, {
                            waitUntil: ['networkidle2', 'domcontentloaded'], // Changed to networkidle2
                            timeout: 90000 // Reduced to 90 seconds
                        });
                        Actor.log.info(`Navigation to profile ${profileUrl} successful.`);
                        break;
                    } catch (error) {
                        Actor.log.warn(`Profile navigation attempt ${4 - retries}/3 for ${profileUrl} failed: ${error.message}`);
                        retries--;
                        if (retries === 0) {
                             Actor.log.error(`All navigation attempts for ${profileUrl} failed.`);
                            throw error; // Rethrow to be caught by outer try-catch for this profile
                        }
                        await new Promise(resolve => setTimeout(resolve, 5000));
                    }
                }

                Actor.log.info(`Waiting for profile content on ${profileUrl}...`);
                await page.waitForSelector('.pv-top-card', { timeout: 60000 });
                Actor.log.info(`Profile content loaded for ${profileUrl}.`);

                const activitySelectors = [
                    'a[href*="detail/recent-activity/shares"]',
                    'a[href*="detail/recent-activity/posts"]',
                    'a[href*="recent-activity/all"]',
                    'a[data-test-id="activity-section"]' // Might be for newer UI
                ];

                let activityButton = null;
                Actor.log.info(`Searching for activity tab on ${profileUrl}...`);
                for (const selector of activitySelectors) {
                    activityButton = await page.$(selector);
                    if (activityButton) {
                        Actor.log.info(`Activity tab found with selector: ${selector}`);
                        break;
                    }
                }

                if (!activityButton) {
                    Actor.log.warn(`No activity tab found for ${profileUrl}. Skipping this profile.`);
                    continue;
                }

                Actor.log.info(`Clicking activity tab and waiting for navigation on ${profileUrl}...`);
                await Promise.all([
                    activityButton.click(),
                    page.waitForNavigation({ 
                        waitUntil: ['networkidle2', 'domcontentloaded'],
                        timeout: 90000 
                    })
                ]);
                Actor.log.info(`Activity page navigation complete for ${profileUrl}.`);

                Actor.log.info(`Waiting for posts to load on activity page of ${profileUrl}...`);
                await new Promise(resolve => setTimeout(resolve, 7000)); // Increased wait for posts to appear

                let loadedPosts = [];
                let previousHeight = 0;
                let noNewPostsCount = 0;
                const maxScrollAttempts = 10; // Max attempts if no new posts are loaded

                Actor.log.info(`Starting scroll loop for ${profileUrl}...`);
                while (noNewPostsCount < maxScrollAttempts) {
                    loadedPosts = await page.$$('.occludable-update, .feed-shared-update-v2'); // Common selectors for posts
                    Actor.log.info(`Found ${loadedPosts.length} potential post elements in current view on ${profileUrl}.`);
                    
                    if (maxPosts > 0 && posts.length + loadedPosts.length >= maxPosts) { // Check combined posts
                         Actor.log.info(`Max posts limit (${maxPosts}) potentially reached. Will process current view and then stop for this profile.`);
                         break; 
                    }

                    const currentHeight = await page.evaluate(() => document.documentElement.scrollHeight);
                    if (currentHeight === previousHeight) {
                        noNewPostsCount++;
                        Actor.log.info(`Scroll height unchanged. Attempt ${noNewPostsCount}/${maxScrollAttempts} on ${profileUrl}.`);
                    } else {
                        noNewPostsCount = 0; // Reset counter if new content loaded
                    }

                    if (noNewPostsCount >= maxScrollAttempts){
                        Actor.log.info(`Max scroll attempts reached for ${profileUrl}. Assuming all posts loaded.`);
                        break;
                    }

                    previousHeight = currentHeight;
                    Actor.log.info(`Scrolling down on ${profileUrl}... Current height: ${currentHeight}`);
                    await page.evaluate(() => {
                        window.scrollTo(0, document.documentElement.scrollHeight);
                    });
                    await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for content to load after scroll
                }
                Actor.log.info(`Finished scroll loop for ${profileUrl}. Found ${loadedPosts.length} elements to process.`);

                let profilePostCount = 0;
                for (const postElement of loadedPosts) {
                    if (maxPosts > 0 && posts.length >= maxPosts) {
                        Actor.log.info(`Global max posts limit (${maxPosts}) reached. Stopping post extraction.`);
                        break;
                    }
                    try {
                        const postData = await page.evaluate(element => {
                            const textElement = element.querySelector('.feed-shared-update-v2__description .feed-shared-inline-show-more-text, .feed-shared-text, .update-components-text');
                            const text = textElement ? textElement.innerText.trim() : '';
                            
                            const timeElement = element.querySelector('time, .update-components-text-view__timestamp');
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
                            profilePostCount++;
                        } else {
                            Actor.log.warn('Extracted post with no text content.');
                        }

                    } catch (extractError) {
                        Actor.log.error(`Error extracting individual post data on ${profileUrl}: ${extractError.message}`);
                    }
                }
                Actor.log.info(`Scraped ${profilePostCount} posts from ${profileUrl}. Total posts: ${posts.length}`);

            } catch (profileError) {
                // Log error for this specific profile and continue to the next one
                Actor.log.error(`Failed to scrape profile ${profileUrl}: ${profileError.message}`);
                // Optionally save partial data or take a screenshot for this specific profile error
                if (page && typeof page.screenshot === 'function') {
                    try {
                        await page.screenshot({ path: `error_${profileUrl.replace(/[^a-zA-Z0-9]/g, '_')}.png` });
                        Actor.log.info(`Error screenshot saved for profile ${profileUrl}`);
                    } catch (screenshotError) {
                        Actor.log.warn(`Failed to take error screenshot for ${profileUrl}: ${screenshotError.message}`);
                    }
                }
            }
        }

        await Actor.pushData(posts);
        Actor.log.info(`Successfully scraped ${posts.length} total posts.`);
        
    } catch (error) {
        Actor.log.error(`Scraping failed: ${error.message}`, { stack: error.stack });
        
        if (page && typeof page.screenshot === 'function') {
            try {
                await page.screenshot({
                    path: 'global_error.png',
                    fullPage: true
                });
                Actor.log.info('Global error screenshot saved.');
            } catch (screenshotError) {
                Actor.log.warn(`Failed to take global error screenshot: ${screenshotError.message}`);
            }
        }
        throw error;
    } finally {
        if (browser) {
            try {
                Actor.log.info('Closing browser...');
                await browser.close();
                Actor.log.info('Browser closed.');
            } catch (closeError) {
                Actor.log.error(`Error closing browser: ${closeError.message}`);
            }
        }
        // Finalize the actor run
        await Actor.exit();
    }
}

Actor.main(scrapeLinkedIn);