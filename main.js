const Apify = require('apify');
// const moment = require('moment'); // Removed
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
// const ProxyChain = require('proxy-chain'); // Removed
// const fs = require('fs'); // Removed
// const { Actor } = require('apify'); // Removed, Apify.main is used
// const { PuppeteerCrawler, ProxyConfiguration } = require('crawlee'); // Removed

puppeteer.use(StealthPlugin());

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Random delay between actions to mimic human behavior
const humanDelay = async (page, min = 500, max = 2000) => {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    await page.waitForTimeout(delay);
};

// Human-like typing
const humanType = async (page, selector, text) => {
    await page.focus(selector);
    await humanDelay(page, 300, 800);
    
    for (let i = 0; i < text.length; i++) {
        await page.keyboard.type(text[i]);
        await humanDelay(page, 30, 150);
    }
};

Apify.main(async () => {
    const input = await Apify.getInput();
    const { 
        username,
        password,
        profileUrls,
        maxPosts = 0,
        useProxy = true,  // Default to true for better success rate
        proxyConfiguration
    } = input;

    const proxyUrl = await getProxyUrl(useProxy, proxyConfiguration);
    console.log('Using proxy:', useProxy);

    const launchOptions = {
        headless: true,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--window-size=1920,1080',
        ]
    };

    // Configure proxy
    if (proxyUrl) {
        console.log('Setting up proxy...');
        launchOptions.args.push(`--proxy-server=${proxyUrl}`);
    }

    // Set up retry counter for login attempts
    let loginAttempts = 0;
    const MAX_LOGIN_ATTEMPTS = 3;
    
    const browser = await puppeteer.launch(launchOptions);
    let page;
    
    try {
        page = await browser.newPage();
        
        // Set a realistic user agent
        await page.setUserAgent(DEFAULT_USER_AGENT);
        
        // Set viewport to a common desktop resolution
        await page.setViewport({
            width: 1920,
            height: 1080,
            deviceScaleFactor: 1,
        });

        // Add extra headers to appear more like a real browser
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
        });

        // Optimize performance by blocking unnecessary resources
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const resourceType = request.resourceType();
            if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
                request.abort();
            } else {
                request.continue();
            }
        });

        // Function to handle login
        async function performLogin() {
            console.log('Logging in to LinkedIn...');
            await page.goto('https://www.linkedin.com/login', {
                waitUntil: 'networkidle2',
                timeout: 60000
            });

            // Check if we're on the login page
            const isLoginPage = await page.evaluate(() => {
                return !!document.querySelector('#username') && !!document.querySelector('#password');
            });

            if (!isLoginPage) {
                console.warn('Not on the expected login page. Current URL:', page.url());
                await saveDebugData(page, 'unexpected_login_page');
                throw new Error('Not on the expected LinkedIn login page');
            }

            // Human-like typing for username and password
            await humanType(page, '#username', username);
            await humanDelay(page, 800, 1500);
            await humanType(page, '#password', password);
            await humanDelay(page, 1000, 2000);
            
            // Click login button
            await Promise.all([
                page.click('button[type="submit"]'),
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 })
            ]);

            // Check for successful login
            const isAuthWall = await checkForAuthWall(page);
            
            if (isAuthWall) {
                console.warn('Detected auth wall after login attempt');
                await saveDebugData(page, 'auth_wall_post_login');
                return false;
            }
            
            console.log('Login successful');
            return true;
        }

        // Try to login with retries
        let loginSuccess = false;
        while (!loginSuccess && loginAttempts < MAX_LOGIN_ATTEMPTS) {
            try {
                loginSuccess = await performLogin();
                if (!loginSuccess) {
                    loginAttempts++;
                    console.log(`Login attempt ${loginAttempts} failed. Retrying...`);
                    await humanDelay(page, 5000, 10000);
                }
            } catch (error) {
                loginAttempts++;
                console.error(`Login error on attempt ${loginAttempts}:`, error.message);
                await saveDebugData(page, `login_error_attempt_${loginAttempts}`);
                
                if (loginAttempts >= MAX_LOGIN_ATTEMPTS) {
                    throw new Error(`Failed to login after ${MAX_LOGIN_ATTEMPTS} attempts: ${error.message}`);
                }
                
                await humanDelay(page, 5000, 10000);
            }
        }

        if (!loginSuccess) {
            throw new Error(`Failed to login after ${MAX_LOGIN_ATTEMPTS} attempts`);
        }

        const posts = [];
        for (const profileUrl of profileUrls) {
            console.log(`Scraping posts from ${profileUrl}`);
            
            // Navigate to profile with retries
            let retries = 3;
            while (retries > 0) {
                try {
                    await page.goto(profileUrl, {
                        waitUntil: 'networkidle2',
                        timeout: 60000
                    });
                    console.log(`Navigation to profile ${profileUrl} successful. Current URL: ${page.url()}`);
                    break;
                } catch (error) {
                    console.warn(`Profile navigation attempt ${4 - retries}/3 for ${profileUrl} failed: ${error.message}`);
                    retries--;
                    if (retries === 0) {
                        console.error(`All navigation attempts for ${profileUrl} failed.`);
                        throw error;
                    }
                    await humanDelay(page, 5000, 10000);
                }
            }

            // Check for auth wall or login page after navigation
            const isAuthWall = await checkForAuthWall(page);
            if (isAuthWall) {
                console.warn(`Detected auth wall at profile URL: ${page.url()} for ${profileUrl}`);
                await saveDebugData(page, `auth_wall_${profileUrl.replace(/[^a-zA-Z0-9]/g, '_')}`);
                
                // Try to re-login
                console.log('Attempting to re-login...');
                const reloginSuccess = await performLogin();
                if (!reloginSuccess) {
                    console.error('Re-login failed, skipping this profile');
                    continue;
                }
                
                // Retry navigation after re-login
                await page.goto(profileUrl, {
                    waitUntil: 'networkidle2',
                    timeout: 60000
                });
                
                // Check again after re-login and navigation
                const isStillAuthWall = await checkForAuthWall(page);
                if (isStillAuthWall) {
                    console.error('Still hitting auth wall after re-login, skipping profile:', profileUrl);
                    continue;
                }
            }
            
            console.log(`Waiting for profile main content on ${profileUrl}...`);

            try {
                // Wait for profile content to load
                await page.waitForSelector('.pv-top-card', { timeout: 15000 });
                
                // Find and click the Activity/Posts tab
                const activitySelectors = [
                    'a[href*="detail/recent-activity/shares"]',
                    'a[data-control-name="all_activity"]',
                    'a[href*="recent-activity"]'
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
                    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 })
                ]);

                // Scroll and collect posts
                let loadedPosts = [];
                let previousHeight = 0;
                let scrollAttempts = 0;
                const MAX_SCROLL_ATTEMPTS = 15;

                while (scrollAttempts < MAX_SCROLL_ATTEMPTS) {
                    loadedPosts = await page.$$('.occludable-update');
                    console.log(`Found ${loadedPosts.length} posts so far...`);
                    
                    if (maxPosts > 0 && loadedPosts.length >= maxPosts) {
                        console.log(`Reached desired maximum of ${maxPosts} posts.`);
                        break;
                    }

                    const currentHeight = await page.evaluate(() => document.documentElement.scrollHeight);
                    if (currentHeight === previousHeight) {
                        scrollAttempts++;
                        
                        if (scrollAttempts >= 3) {
                            console.log('No new content loaded after multiple scroll attempts, ending collection.');
                            break;
                        }
                        
                        console.log('No new content loaded, waiting a bit longer...');
                        await humanDelay(page, 3000, 5000);
                    } else {
                        scrollAttempts = 0; // Reset counter when page height changes
                        previousHeight = currentHeight;
                    }

                    await page.evaluate(() => window.scrollBy(0, 800)); // More natural scrolling
                    await humanDelay(page, 1000, 2000);
                }

                // Extract post data
                for (const post of loadedPosts) {
                    try {
                        const postData = await page.evaluate(element => {
                            const text = element.querySelector('.feed-shared-update-v2__description')?.innerText || 
                                         element.querySelector('.update-components-text')?.innerText || '';
                            
                            const timestamp = element.querySelector('time')?.getAttribute('datetime') || '';
                            
                            const likesElement = element.querySelector('.social-details-social-counts__reactions-count') || 
                                               element.querySelector('.social-counts__reactions-count');
                            const likes = likesElement ? likesElement.innerText : '0';
                            
                            // Get URL of the post if available
                            const postUrl = element.querySelector('a.app-aware-link[href*="/posts/"]')?.href || '';
                            
                            return {
                                text,
                                timestamp,
                                likes: parseInt(likes.replace(/[^\d]/g, '')) || 0,
                                postUrl
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
            } catch (error) {
                console.error(`Error processing profile ${profileUrl}:`, error.message);
                await saveDebugData(page, `profile_error_${profileUrl.replace(/[^a-zA-Z0-9]/g, '_')}`);
            }
        }

        // Save the results
        console.log(`Successfully scraped ${posts.length} posts`);
        await Apify.pushData(posts);
        
    } catch (error) {
        console.error('Scraping failed:', error);
        if (page) {
            await saveDebugData(page, 'final_error');
        }
        throw error;
    } finally {
        await browser.close();
    }
});

// Utility functions
async function getProxyUrl(useProxy, proxyConfiguration) {
    if (!useProxy) return null;
    
    // Use Apify Proxy if available
    if (proxyConfiguration) {
        const proxyConfig = await Apify.createProxyConfiguration(proxyConfiguration);
        const proxyUrl = proxyConfig.newUrl();
        console.log('Using Apify Proxy');
        return proxyUrl;
    }
    
    // Use global proxy from env if available
    const apifyProxyUrl = process.env.APIFY_PROXY_URL;
    if (apifyProxyUrl) {
        console.log('Using Apify Proxy from environment');
        return apifyProxyUrl;
    }
    
    console.log('No proxy configuration found');
    return null;
}

async function saveDebugData(page, identifier) {
    try {
        const now = new Date().toISOString().replace(/:/g, '-');
        const htmlContent = await page.content();
        const safeIdentifier = identifier.replace(/[^a-zA-Z0-9_-]/g, '_');
        
        // Save HTML
        await Apify.setValue(`DEBUG_${safeIdentifier}_${now}.html`, htmlContent, { contentType: 'text/html' });
        
        // Save screenshot
        const screenshotBuffer = await page.screenshot({ fullPage: true });
        await Apify.setValue(`DEBUG_${safeIdentifier}_${now}.png`, screenshotBuffer, { contentType: 'image/png' });
        
        console.log(`Debug data saved for ${identifier}`);
    } catch (error) {
        console.error(`Failed to save debug data for ${identifier}:`, error);
    }
}

async function checkForAuthWall(page) {
    return await page.evaluate(() => {
        return !!(
            document.querySelector('form#join-form') ||
            document.querySelector('form.login-form') ||
            document.querySelector('a[href*="linkedin.com/login"]') ||
            document.querySelector('a[data-tracking-control-name="auth_wall_desktop_profile_guest_nav_login-button"]') ||
            document.querySelector('h1[data-test-id="authwall-join-form__title"]') ||
            document.querySelector('.authwall-join-form') ||
            document.querySelector('.authwall-login-form') ||
            document.querySelector('[data-test-id="authwall"]') ||
            document.body.innerText.includes('Sign in to LinkedIn') ||
            document.body.innerText.includes('Join LinkedIn') ||
            document.body.innerText.includes('Join now') ||
            document.body.innerText.includes('Sign in') ||
            document.body.innerText.includes('Please log in to continue')
        );
    });
} 
