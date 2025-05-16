const Apify = require('apify');
const moment = require('moment');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const ProxyChain = require('proxy-chain');

puppeteer.use(StealthPlugin());

Apify.main(async () => {
    const input = await Apify.getInput();
    const { 
        username,
        password,
        profileUrls,
        maxPosts = 0,
        useProxy = false
    } = input;

    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1920,1080']
    });

    try {
        const page = await browser.newPage();
        
        // Set viewport to prevent screenshot issues
        await page.setViewport({
            width: 1920,
            height: 1080,
            deviceScaleFactor: 1,
        });

        // Setup request interception for optimization
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            if (['image', 'stylesheet', 'font'].includes(request.resourceType())) {
                request.abort();
            } else {
                request.continue();
            }
        });

        // Login to LinkedIn
        console.log('Logging in to LinkedIn...');
        await page.goto('https://www.linkedin.com/login', {
            waitUntil: 'networkidle0',
            timeout: 60000
        });

        await page.type('#username', username);
        await page.type('#password', password);
        await page.click('button[type="submit"]');

        // Wait for login to complete
        await page.waitForNavigation({ waitUntil: 'networkidle0' });

        const posts = [];
        for (const profileUrl of profileUrls) {
            console.log(`Scraping posts from ${profileUrl}`);
            
            // Navigate to profile
            await page.goto(profileUrl, {
                waitUntil: 'networkidle0',
                timeout: 60000
            });

            // Wait for profile content to load
            await page.waitForSelector('.pv-top-card', { timeout: 10000 });

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

            await activityButton.click();
            await page.waitForNavigation({ waitUntil: 'networkidle0' });

            // Wait for posts to load
            await new Promise(resolve => setTimeout(resolve, 2000));

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
        }

        // Save the results
        await Apify.pushData(posts);
        console.log(`Successfully scraped ${posts.length} total posts`);
        
    } catch (error) {
        console.error('Scraping failed:', error);
        
        // Take error screenshot only if page is still valid
        if (page && page.viewport()) {
            await page.screenshot({
                path: 'error.png',
                fullPage: true
            });
        }
        
        throw error;
    } finally {
        await browser.close();
    }
});