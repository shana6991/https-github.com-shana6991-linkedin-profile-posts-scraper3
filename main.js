const { Actor } = require('apify');
const moment = require('moment');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const ProxyChain = require('proxy-chain');

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
        // Log input safely, omitting password
        const { password, ...inputToLog } = input;
        console.log('Input received (password omitted for security):', inputToLog);
        // Or, for even less verbosity if inputToLog is still too much:
        // console.log(`Input received. Username: ${input.username}, Profile URLs count: ${input.profileUrls ? input.profileUrls.length : 0}`);


        const { 
            username, // Get original password from input for use, not from inputToLog
            profileUrls,
            maxPosts = 0,
            useProxy = false
        } = input; // Use original input here for all fields

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
        page.setDefaultTimeout(60000); // Default for non-navigation actions
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

        await page.type(usernameSelector, input.username); // Use input.username
        await page.type(passwordSelector, input.password); // Use input.password
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
                
                console.log(`Waiting for profile main content on ${profileUrl}...`);
                // Try a more general selector for the main profile area, increase timeout
                const profileMainSelector = 'main[role="main"]'; // A common main content wrapper
                try {
                    await page.waitForSelector(profileMainSelector, { timeout: 75000 }); 
                } catch (e) {
                    console.warn(`Primary selector '${profileMainSelector}' not found. Trying alternative '#profile-content'...`);
                    await page.waitForSelector('#profile-content', { timeout: 75000 }); // Alternative, might be specific to some layouts
                }
                console.log(`Profile main content loaded for ${profileUrl}.`);


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
                if (page && typeof page.screenshot === 'function') {
                    try {
                        await page.screenshot({ path: `error_${profileUrl.replace(/[^a-zA-Z0-9]/g, '_')}.png` });
                        console.log(`Error screenshot saved for profile ${profileUrl}`);
                    } catch (screenshotError) {
                        console.warn(`Failed to take error screenshot for ${profileUrl}: ${screenshotError.message}`);
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
