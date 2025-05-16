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
            useProxy = false
        } = input;

        // Launch browser with new headless mode
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
            if (['image', 'stylesheet', 'font'].includes(request.resourceType())) {
                request.abort();
            } else {
                request.continue();
            }
        });

        // Set default timeout
        page.setDefaultNavigationTimeout(120000); // 2 minutes
        page.setDefaultTimeout(60000); // 1 minute

        // Login to LinkedIn
        console.log('Logging in to LinkedIn...');
        
        // Navigate to login page with retry mechanism
        let retries = 3;
        while (retries > 0) {
            try {
                await page.goto('https://www.linkedin.com/login', {
                    waitUntil: ['networkidle0', 'domcontentloaded'],
                    timeout: 120000
                });
                break;
            } catch (error) {
                console.log(`Navigation retry attempt ${4 - retries}/3`);
                retries--;
                if (retries === 0) throw error;
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }

        // Check if login page loaded correctly
        const usernameSelector = '#username';
        const passwordSelector = '#password';
        
        await page.waitForSelector(usernameSelector, { timeout: 60000 });
        await page.waitForSelector(passwordSelector, { timeout: 60000 });

        await page.type(usernameSelector, username);
        await page.type(passwordSelector, password);
        
        // Click login button and wait for navigation
        await Promise.all([
            page.click('button[type="submit"]'),
            page.waitForNavigation({ 
                waitUntil: ['networkidle0', 'domcontentloaded'],
                timeout: 120000 
            })
        ]);

        const posts = [];
        for (const profileUrl of profileUrls) {
            console.log(`Scraping posts from ${profileUrl}`);
            
            try {
                // Navigate to profile with retry mechanism
                retries = 3;
                while (retries > 0) {
                    try {
                        await page.goto(profileUrl, {
                            waitUntil: ['networkidle0', 'domcontentloaded'],
                            timeout: 120000
                        });
                        break;
                    } catch (error) {
                        console.log(`Profile navigation retry attempt ${4 - retries}/3`);
                        retries--;
                        if (retries === 0) throw error;
                        await new Promise(resolve => setTimeout(resolve, 5000));
                    }
                }

                // Wait for profile content to load
                await page.waitForSelector('.pv-top-card', { timeout: 60000 });

                // Find and click the Activity/Posts tab
                const activitySelectors = [
                    'a[href*="detail/recent-activity/shares"]',
                    'a[href*="detail/recent-activity/posts"]',
                    'a[href*="recent-activity/all"]',
                    'a[data-test-id="activity-section"]'
                ];

                let activityButton = null;
                for (const selector of activitySelectors) {
                    activityButton = await page.$(selector);
                    if (activityButton) break;
                }

                if (!activityButton) {
                    console.log(`No activity tab found for ${profileUrl}`);
                    continue;
                }

                await Promise.all([
                    activityButton.click(),
                    page.waitForNavigation({ 
                        waitUntil: ['networkidle0', 'domcontentloaded'],
                        timeout: 120000 
                    })
                ]);

                // Wait for posts to load
                await new Promise(resolve => setTimeout(resolve, 5000));

                // Scroll and collect posts
                let loadedPosts = [];
                let previousHeight = 0;
                let noNewPostsCount = 0;
                const maxScrollAttempts = 10;

                while (noNewPostsCount < maxScrollAttempts) {
                    loadedPosts = await page.$$('.occludable-update, .feed-shared-update-v2');
                    console.log(`Found ${loadedPosts.length} posts`);
                    
                    if (maxPosts > 0 && loadedPosts.length >= maxPosts) {
                        break;
                    }

                    const currentHeight = await page.evaluate(() => document.documentElement.scrollHeight);
                    if (currentHeight === previousHeight) {
                        noNewPostsCount++;
                    } else {
                        noNewPostsCount = 0;
                    }

                    previousHeight = currentHeight;
                    await page.evaluate(() => {
                        window.scrollTo(0, document.documentElement.scrollHeight);
                    });
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }

                // Extract post data
                for (const post of loadedPosts) {
                    try {
                        const postData = await page.evaluate(element => {
                            const text = element.querySelector('.feed-shared-update-v2__description, .feed-shared-text')?.innerText || '';
                            const timestamp = element.querySelector('time')?.getAttribute('datetime') || '';
                            const likes = element.querySelector('.social-details-social-counts__reactions-count, .social-details-social-counts__count-value')?.innerText || '0';
                            
                            return {
                                text,
                                timestamp,
                                likes: parseInt(likes.replace(/[^0-9]/g, '')) || 0
                            };
                        }, post);

                        if (postData.text) {
                            posts.push({
                                ...postData,
                                profileUrl,
                                scrapedAt: new Date().toISOString()
                            });
                        }

                        if (maxPosts > 0 && posts.length >= maxPosts) {
                            break;
                        }
                    } catch (error) {
                        console.error('Error extracting post data:', error);
                    }
                }

                console.log(`Scraped ${posts.length} posts from ${profileUrl}`);
            } catch (error) {
                console.error(`Error scraping profile ${profileUrl}:`, error);
            }
        }

        // Save the results
        await Actor.pushData(posts);
        console.log(`Successfully scraped ${posts.length} total posts`);
        
    } catch (error) {
        console.error('Scraping failed:', error);
        
        // Take error screenshot only if page is still valid
        if (page && typeof page.screenshot === 'function') {
            try {
                await page.screenshot({
                    path: 'error.png',
                    fullPage: true
                });
                console.log('Error screenshot saved');
            } catch (screenshotError) {
                console.error('Failed to take error screenshot:', screenshotError);
            }
        }
        
        throw error;
    } finally {
        if (browser) {
            try {
                await browser.close();
            } catch (error) {
                console.error('Error closing browser:', error);
            }
        }
    }
}

// Run the actor
Actor.main(scrapeLinkedIn);