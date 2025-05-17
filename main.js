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
        proxyConfiguration,
        debugMode = false
    } = input;

    if (!username || !password || !profileUrls || profileUrls.length === 0) {
        throw new Error('Missing required input: username, password, and at least one profile URL are required');
    }

    console.log(`LinkedIn Profile Posts Scraper configuration:
- Number of profiles to scrape: ${profileUrls.length}
- Max posts per profile: ${maxPosts || 'unlimited'}
- Using proxy: ${useProxy ? 'yes' : 'no'}`);

    let proxyUrl = null;
    let proxyConfig = null;

    if (useProxy) {
        try {
            proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration || {});
            console.log('Proxy configuration created successfully');
            
            if (proxyConfig?.groups?.length) {
                console.log(`Using proxy groups: ${proxyConfig.groups.join(', ')}`);
            }
            
            proxyUrl = proxyConfig.newUrl();
            console.log(`Proxy URL generated: ${proxyUrl.replace(/:[^:@]*@/, ':****@')}`);
        } catch (error) {
            console.warn(`Error setting up proxy: ${error.message}`);
            console.log('Continuing without proxy');
        }
    }

    // Browser launch options
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

    if (proxyUrl) {
        launchOptions.args.push(`--proxy-server=${proxyUrl}`);
    }

    console.log('Launching browser');
    const browser = await puppeteer.launch(launchOptions);
    console.log('Browser launched successfully');
    
    const page = await browser.newPage();
    console.log('New page created');
    
    // Set user agent
    await page.setUserAgent(DEFAULT_USER_AGENT);
    
    // Set viewport
    await page.setViewport({
        width: 1920,
        height: 1080,
        deviceScaleFactor: 1,
    });

    // Enable request interception to optimize performance
    await page.setRequestInterception(true);
    page.on('request', (request) => {
        const resourceType = request.resourceType();
        if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
            request.abort();
        } else {
            request.continue();
        }
    });

    // Error logging
    page.on('error', error => {
        console.error('Page error:', error.message);
    });
    
    page.on('requestfailed', request => {
        const failure = request.failure();
        console.warn(`Request failed: ${request.url()} - ${failure ? failure.errorText : 'unknown error'}`);
    });
    
    if (debugMode) {
        page.on('request', request => {
            console.log(`Request: ${request.method()} ${request.url()}`);
        });
        
        page.on('response', response => {
            console.log(`Response: ${response.status()} ${response.url()}`);
        });
    }

    const posts = [];
    let loginSuccessful = false;
    
    try {
        // Attempt login
        console.log('Attempting to login to LinkedIn');
        loginSuccessful = await login(page, username, password);
        
        if (!loginSuccessful) {
            throw new Error('Failed to login to LinkedIn after multiple attempts');
        }
        
        // Process each profile
        for (const profileUrl of profileUrls) {
            console.log(`Processing profile: ${profileUrl}`);
            const profilePosts = await scrapeProfilePosts(page, profileUrl, maxPosts);
            
            posts.push(...profilePosts);
            console.log(`Scraped ${profilePosts.length} posts from ${profileUrl}`);
            
            // Wait between profiles to avoid being rate limited
            await humanDelay(3000, 5000);
        }
        
        console.log(`Successfully scraped ${posts.length} posts total`);
        await Actor.pushData(posts);
    } catch (error) {
        console.error('Scraping failed:', error.message);
        
        // Save debug data
        if (page) {
            try {
                const screenshotBuffer = await page.screenshot({ fullPage: true });
                await Actor.setValue('ERROR_SCREENSHOT.png', screenshotBuffer, { contentType: 'image/png' });
                
                const htmlContent = await page.content();
                await Actor.setValue('ERROR_HTML.html', htmlContent, { contentType: 'text/html' });
                
                console.log('Error debug data saved');
            } catch (debugError) {
                console.error('Failed to save debug data:', debugError.message);
            }
        }
        
        throw error;
    } finally {
        console.log('Closing browser');
        await browser.close();
    }
    
    console.log('Scraping completed successfully');
});

/**
 * Login to LinkedIn
 */
async function login(page, username, password) {
    const MAX_ATTEMPTS = 3;
    let attempts = 0;
    
    while (attempts < MAX_ATTEMPTS) {
        try {
            console.log(`Login attempt ${attempts + 1}/${MAX_ATTEMPTS}`);
            
            await page.goto('https://www.linkedin.com/login', {
                waitUntil: 'networkidle2',
                timeout: 60000
            });
            
            console.log(`Current URL: ${page.url()}`);
            
            const isLoginPage = await page.evaluate(() => {
                return !!document.querySelector('#username') && !!document.querySelector('#password');
            });
            
            if (!isLoginPage) {
                console.warn('Not on the expected login page');
                
                const isLoggedIn = await page.evaluate(() => {
                    // Check if already logged in
                    return !!document.querySelector('.global-nav');
                });
                
                if (isLoggedIn) {
                    console.log('Already logged in');
                    return true;
                }
                
                throw new Error('Not on the expected login page');
            }
            
            // Enter username and password
            await humanType(page, '#username', username);
            await humanDelay(800, 1500);
            await humanType(page, '#password', password);
            await humanDelay(1000, 2000);
            
            // Click login button
            await Promise.all([
                page.click('button[type="submit"]'),
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 })
            ]);
            
            // Check if login was successful
            const isAuthWall = await checkForAuthWall(page);
            if (isAuthWall) {
                console.warn('Login unsuccessful, hit auth wall');
                attempts++;
                await humanDelay(5000, 10000);
                continue;
            }
            
            console.log('Login successful');
            return true;
        } catch (error) {
            console.error(`Login attempt ${attempts + 1} failed:`, error.message);
            attempts++;
            
            if (attempts >= MAX_ATTEMPTS) {
                console.error('All login attempts failed');
                return false;
            }
            
            await humanDelay(5000, 10000);
        }
    }
    
    return false;
}

/**
 * Scrape posts from a LinkedIn profile
 */
async function scrapeProfilePosts(page, profileUrl, maxPosts) {
    const posts = [];
    
    // Navigate to profile
    try {
        console.log(`Navigating to ${profileUrl}`);
        await page.goto(profileUrl, {
            waitUntil: 'networkidle2',
            timeout: 60000
        });
        
        // Check for auth wall
        const isAuthWall = await checkForAuthWall(page);
        if (isAuthWall) {
            console.warn('Hit auth wall on profile page, skipping profile');
            return [];
        }
        
        // Wait for profile content
        await page.waitForSelector('.pv-top-card', { timeout: 15000 });
        console.log('Profile page loaded');
        
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
            console.log('No activity tab found, skipping profile');
            return [];
        }
        
        console.log('Clicking activity tab');
        await Promise.all([
            activityButton.click(),
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 })
        ]);
        
        // Scroll and collect posts
        console.log('Scrolling to load posts');
        let loadedPosts = [];
        let previousHeight = 0;
        let scrollAttempts = 0;
        const MAX_SCROLL_ATTEMPTS = 15;
        
        while (scrollAttempts < MAX_SCROLL_ATTEMPTS) {
            loadedPosts = await page.$$('.occludable-update');
            console.log(`Found ${loadedPosts.length} posts`);
            
            if (maxPosts > 0 && loadedPosts.length >= maxPosts) {
                console.log(`Reached desired maximum of ${maxPosts} posts`);
                break;
            }
            
            const currentHeight = await page.evaluate(() => document.documentElement.scrollHeight);
            if (currentHeight === previousHeight) {
                scrollAttempts++;
                
                if (scrollAttempts >= 3) {
                    console.log('No new content loaded after multiple scroll attempts');
                    break;
                }
                
                await humanDelay(3000, 5000);
            } else {
                scrollAttempts = 0;
                previousHeight = currentHeight;
            }
            
            await page.evaluate(() => window.scrollBy(0, 800));
            await humanDelay(1000, 2000);
        }
        
        // Extract post data
        console.log('Extracting post data');
        for (const post of loadedPosts) {
            try {
                const postData = await page.evaluate(element => {
                    const text = element.querySelector('.feed-shared-update-v2__description')?.innerText || 
                                 element.querySelector('.update-components-text')?.innerText || '';
                    
                    const timestamp = element.querySelector('time')?.getAttribute('datetime') || '';
                    
                    const likesElement = element.querySelector('.social-details-social-counts__reactions-count') || 
                                       element.querySelector('.social-counts__reactions-count');
                    const likes = likesElement ? likesElement.innerText : '0';
                    
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
                console.error('Error extracting post data:', error.message);
            }
        }
        
        return posts;
    } catch (error) {
        console.error(`Error processing profile ${profileUrl}:`, error.message);
        return [];
    }
}

/**
 * Check if the page shows an auth wall
 */
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