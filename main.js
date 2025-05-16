const { Actor } = require('apify');
const moment = require('moment');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const ProxyChain = require('proxy-chain');
const fs = require('fs'); // Added fs import

puppeteer.use(StealthPlugin());

Actor.init();

async function scrapeLinkedIn() {
    await new Promise(resolve => setTimeout(resolve, 100)); 
    console.log('Inside scrapeLinkedIn. Using console.log for debugging.');

    console.log('scrapeLinkedIn function started.'); 
    let browser = null;
    let page = null;

    try {
        const input = await Actor.getInput();
        const { password, ...inputToLog } = input;
        console.log('Input received (password omitted for security):', inputToLog);

        const { 
            username,
            profileUrls,
            maxPosts = 0,
            useProxy = false
        } = input;

        if (!profileUrls || !Array.isArray(profileUrls) || profileUrls.length === 0) {
            console.warn('No profile URLs provided or profileUrls is not a valid array. Exiting peacefully.');
            return; 
        }

        console.log('Launching browser...');
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
        console.log('Browser launched.');

        page = await browser.newPage();
        console.log('New page created.');
        
        await page.setViewport({
            width: 1920,
            height: 1080,
            deviceScaleFactor: 1,
        });
        console.log('Viewport set.');

        await page.setRequestInterception(true);
        page.on('request', (request) => {
            if (['image', 'stylesheet', 'font'].includes(request.resourceType())) {
                request.abort();
            } else {
                request.continue();
            }
        });
        console.log('Request interception set up.');

        page.setDefaultNavigationTimeout(100000);
        page.setDefaultTimeout(60000);
        console.log('Default timeouts set.');

        console.log('Logging in to LinkedIn...');
        
        let retries = 3;
        while (retries > 0) {
            try {
                console.log(`Navigating to login page (attempt ${4 - retries}/3)...`);
                await page.goto('https://www.linkedin.com/login', {
                    waitUntil: ['networkidle2', 'domcontentloaded'],
                    timeout: 90000
                });
                console.log('Login page navigation successful.');
                break;
            } catch (error) {
                console.warn(`Login page navigation attempt ${4 - retries}/3 failed: ${error.message}`);
                retries--;
                if (retries === 0) {
                    console.error('All login page navigation attempts failed.');
                    throw error;
                }
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }

        const usernameSelector = '#username';
        const passwordSelector = '#password';
        
        console.log('Waiting for username and password fields...');
        await page.waitForSelector(usernameSelector, { timeout: 60000 });
        await page.waitForSelector(passwordSelector, { timeout: 60000 });
        console.log('Username and password fields found.');

        await page.type(usernameSelector, input.username);
        await page.type(passwordSelector, input.password);
        console.log('Credentials typed in.');
        
        console.log('Clicking login button and waiting for navigation...');
        await Promise.all([
            page.click('button[type="submit"]'),
            page.waitForNavigation({ 
                waitUntil: ['networkidle2', 'domcontentloaded'],
                timeout: 90000 
            })
        ]);
        console.log('Login successful, navigation complete.');

        const posts = [];
        for (const profileUrl of profileUrls) {
            console.log(`Scraping posts from ${profileUrl}`);
            
            try {
                retries = 3;
                while (retries > 0) {
                    try {
                        console.log(`Navigating to profile ${profileUrl} (attempt ${4 - retries}/3)...`);
                        await page.goto(profileUrl, {
                            waitUntil: ['networkidle2', 'domcontentloaded'],
                            timeout: 90000
                        });
                        console.log(`Navigation to profile ${profileUrl} successful.`);
                        break;
                    } catch (error) {
                        console.warn(`Profile navigation attempt ${4 - retries}/3 for ${profileUrl} failed: ${error.message}`);
                        retries--;
                        if (retries === 0) {
                             console.error(`All navigation attempts for ${profileUrl} failed.`);
                            throw error;
                        }
                        await new Promise(resolve => setTimeout(resolve, 5000));
                    }
                }

                // New block to check for login/join page
                console.log(`Page URL before attempting to find selectors on ${profileUrl}: ${page.url()}`);
                const isLikelyLoginPage = await page.evaluate(() => {
                    return !!(
                        document.querySelector('form#join-form') ||
                        document.querySelector('form.login-form') ||
                        document.querySelector('a[href*="linkedin.com/login"]') ||
                        document.querySelector('a[data-tracking-control-name="auth_wall_desktop_profile_guest_nav_login-button"]') ||
                        document.querySelector('h1[data-test-id="authwall-join-form__title"]') ||
                        document.body.innerText.includes('Sign in to LinkedIn') ||
                        document.body.innerText.includes('Join LinkedIn')
                    );
                });

                if (isLikelyLoginPage) {
                    console.warn(`WARNING: Detected a login/join page at URL: ${page.url()} instead of profile content for ${profileUrl}. Login might have failed or session lost.`);
                    const loginPageHtml = await page.content();
                    const safeProfileUrlLoginDetect = profileUrl.replace(/[^a-zA-Z0-9]/g, '_');
                    await Actor.setValue(`DEBUG_LOGIN_PAGE_DETECTED_${safeProfileUrlLoginDetect}.html`, loginPageHtml, { contentType: 'text/html' });
                    
                    const loginScreenshotPath = `login_page_detected_${safeProfileUrlLoginDetect}.png`;
                    await page.screenshot({ path: loginScreenshotPath, fullPage: true });
                    await Actor.setValue(`DEBUG_LOGIN_PAGE_DETECTED_SCREENSHOT_${safeProfileUrlLoginDetect}.png`, fs.readFileSync(loginScreenshotPath), { contentType: 'image/png' });
                    fs.unlinkSync(loginScreenshotPath); 

                    throw new Error(`Redirected to a login/join page at ${profileUrl} when profile content was expected. Aborting scrape for this profile.`);
                }
                // End of new block
                
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
                        // Save HTML content for debugging if selectors fail
                        if (page && typeof page.content === 'function') {
                            try {
                                const htmlContent = await page.content();
                                const safeProfileUrl = profileUrl.replace(/[^a-zA-Z0-9]/g, '_');
                                await Actor.setValue(`DEBUG_HTML_${safeProfileUrl}`, htmlContent, { contentType: 'text/html' });
                                console.log(`Saved HTML content for ${profileUrl} (DEBUG_HTML_${safeProfileUrl}) for debugging.`);
                            } catch (htmlError) {
                                console.warn(`Could not get HTML content for ${profileUrl}: ${htmlError.message}`);
                            }
                        }
                        // Try to take a screenshot as a fallback
                        if (page && typeof page.screenshot === 'function') {
                            try {
                                const safeProfileUrl = profileUrl.replace(/[^a-zA-Z0-9]/g, '_');
                                await page.screenshot({ path: `error_screenshot_${safeProfileUrl}.png` });
                                console.log(`Error screenshot saved for profile ${profileUrl} as error_screenshot_${safeProfileUrl}.png`);
                                await Actor.setValue(`error_screenshot_${safeProfileUrl}.png_kvs`, `Screenshot for ${profileUrl} when selectors failed.`);

                            } catch (screenshotError) {
                                console.warn(`Failed to take error screenshot for ${profileUrl} when selectors failed: ${screenshotError.message}`);
                            }
                        }
                        throw e2; // Re-throw the error to skip this profile
                    }
                }

                const activitySelectors = [
                    'a[href*="detail/recent-activity/shares"]',
                    'a[href*="detail/recent-activity/posts"]',
                    'a[href*="recent-activity/all"]',
                    'a[data-test-id="activity-section"]' 
                ];

                let activityButton = null;
                console.log(`Searching for activity tab on ${profileUrl}...`);
                for (const selector of activitySelectors) {
                    activityButton = await page.$(selector);
                    if (activityButton) {
                        console.log(`Activity tab found with selector: ${selector}`);
                        break;
                    }
                }

                if (!activityButton) {
                    console.warn(`No activity tab found for ${profileUrl}. Skipping this profile.`);
                    continue;
                }

                console.log(`Clicking activity tab and waiting for navigation on ${profileUrl}...`);
                await Promise.all([
                    activityButton.click(),
                    page.waitForNavigation({ 
                        waitUntil: ['networkidle2', 'domcontentloaded'],
                        timeout: 90000 
                    })
                ]);
                console.log(`Activity page navigation complete for ${profileUrl}.`);

                console.log(`Waiting for posts to load on activity page of ${profileUrl}...`);
                await new Promise(resolve => setTimeout(resolve, 7000));

                let loadedPosts = [];
                let previousHeight = 0;
                let noNewPostsCount = 0;
                const maxScrollAttempts = 10;

                console.log(`Starting scroll loop for ${profileUrl}...`);
                while (noNewPostsCount < maxScrollAttempts) {
                    loadedPosts = await page.$$('.occludable-update, .feed-shared-update-v2');
                    console.log(`Found ${loadedPosts.length} potential post elements in current view on ${profileUrl}.`);
                    
                    if (maxPosts > 0 && posts.length + loadedPosts.length >= maxPosts) {
                         console.log(`Max posts limit (${maxPosts}) potentially reached. Will process current view and then stop for this profile.`);
                         break; 
                    }

                    const currentHeight = await page.evaluate(() => document.documentElement.scrollHeight);
                    if (currentHeight === previousHeight) {
                        noNewPostsCount++;
                        console.log(`Scroll height unchanged. Attempt ${noNewPostsCount}/${maxScrollAttempts} on ${profileUrl}.`);
                    } else {
                        noNewPostsCount = 0;
                    }

                    if (noNewPostsCount >= maxScrollAttempts){
                        console.log(`Max scroll attempts reached for ${profileUrl}. Assuming all posts loaded.`);
                        break;
                    }

                    previousHeight = currentHeight;
                    console.log(`Scrolling down on ${profileUrl}... Current height: ${currentHeight}`);
                    await page.evaluate(() => {
                        window.scrollTo(0, document.documentElement.scrollHeight);
                    });
                    await new Promise(resolve => setTimeout(resolve, 3000));
                }
                console.log(`Finished scroll loop for ${profileUrl}. Found ${loadedPosts.length} elements to process.`);

                let profilePostCount = 0;
                for (const postElement of loadedPosts) {
                    if (maxPosts > 0 && posts.length >= maxPosts) {
                        console.log(`Global max posts limit (${maxPosts}) reached. Stopping post extraction.`);
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
                            console.warn('Extracted post with no text content.');
                        }

                    } catch (extractError) {
                        console.error(`Error extracting individual post data on ${profileUrl}: ${extractError.message}`);
                    }
                }
                console.log(`Scraped ${profilePostCount} posts from ${profileUrl}. Total posts: ${posts.length}`);

            } catch (profileError) {
                console.error(`Failed to scrape profile ${profileUrl}: ${profileError.message}`);
                // Fallback screenshot if other attempts inside the nested try-catch failed or were not reached
                if (page && typeof page.screenshot === 'function') {
                     try {
                        const safeProfileUrl = profileUrl.replace(/[^a-zA-Z0-9]/g, '_');
                        await page.screenshot({ path: `fallback_error_screenshot_${safeProfileUrl}.png` });
                        console.log(`Fallback error screenshot saved for profile ${profileUrl} as fallback_error_screenshot_${safeProfileUrl}.png`);
                        // Attempt to also save this to KVS if not already done by inner catch
                         await Actor.setValue(`fallback_error_screenshot_${safeProfileUrl}.png_kvs`, `Fallback screenshot for ${profileUrl}.`);
                    } catch (screenshotError) {
                        console.warn(`Failed to take fallback error screenshot for ${profileUrl}: ${screenshotError.message}`);
                    }
                }
            }
        }

        await Actor.pushData(posts);
        console.log(`Successfully scraped ${posts.length} total posts.`);
        
    } catch (error) {
        console.error(`Scraping failed: ${error.message}`, { stack: error.stack });
        
        if (page && typeof page.screenshot === 'function') {
            try {
                await page.screenshot({
                    path: 'global_error.png',
                    fullPage: true
                });
                console.log('Global error screenshot saved.');
                 await Actor.setValue('global_error.png_kvs', 'Global error screenshot.');
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