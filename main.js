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
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        const page = await browser.newPage();
        
        // Set viewport to prevent screenshot issues
        await page.setViewport({
            width: 1280,
            height: 800,
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
            const activityButton = await page.$('a[href*="detail/recent-activity/shares"]');
            if (!activityButton) {
                console.log(`No activity tab found for ${profileUrl}`);
                continue;
            }

            await activityButton.click();
            await page.waitForNavigation({ waitUntil: 'networkidle0' });

            // Scroll and collect posts
            let loadedPosts = [];
            let previousHeight = 0;

            while (true) {
                loadedPosts = await page.$$('.occludable-update');
                
                if (maxPosts > 0 && loadedPosts.length >= maxPosts) {
                    break;
                }

                const currentHeight = await page.evaluate(() => document.documentElement.scrollHeight);
                if (currentHeight === previousHeight) {
                    break;
                }

                previousHeight = currentHeight;
                await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
                await page.waitForTimeout(1000);
            }

            // Extract post data
            for (const post of loadedPosts) {
                try {
                    const postData = await page.evaluate(element => {
                        const text = element.querySelector('.feed-shared-update-v2__description')?.innerText || '';
                        const timestamp = element.querySelector('time')?.getAttribute('datetime') || '';
                        const likes = element.querySelector('.social-details-social-counts__reactions-count')?.innerText || '0';
                        
                        return {
                            text,
                            timestamp,
                            likes: parseInt(likes.replace(/,/g, '')) || 0
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
        }

        // Save the results
        await Apify.pushData(posts);
        
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