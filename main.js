const { Actor } = require('apify');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

async function extractPostContent(page) {
    return await page.evaluate(() => {
        const posts = Array.from(document.querySelectorAll('div.feed-shared-update-v2'));
        return posts.map(post => {
            let text = '';
            const textElem = post.querySelector('.feed-shared-update-v2__description-wrapper .feed-shared-text, .break-words, .feed-shared-commentary');
            if (textElem) text = textElem.innerText.trim();

            const images = Array.from(post.querySelectorAll('img.update-components-image__image, img.ivm-view-attr__img--centered'))
                .map(img => img.src);

            const videos = Array.from(post.querySelectorAll('video.vjs-tech'))
                .map(video => video.src);

            let url = '';
            const postRoot = post.closest('div[data-urn]');
            if (postRoot && postRoot.dataset.urn) {
                url = `https://www.linkedin.com/feed/update/${postRoot.dataset.urn}`;
            } else {
                const anchor = post.querySelector('a.feed-shared-control-menu__item[href*="/feed/update/urn:li:activity:"]');
                 if(anchor) url = anchor.href;
            }

            let date = '';
            const dateElem = post.querySelector('span.feed-shared-actor__sub-description > span.visually-hidden, .update-components-actor__sub-description span[aria-hidden="true"]');
            if (dateElem) date = dateElem.innerText.trim();

            return { text, images, videos, url, date };
        });
    });
}

(async () => {
    await Actor.init();

    const input = await Actor.getInput();
    let { profileUrls, li_at, maxPosts = 20, proxyConfiguration, extractMedia = true, extractComments = false, filterDateAfter } = input || {}; // Added default for input
    if (!Array.isArray(profileUrls)) profileUrls = [profileUrls].filter(Boolean); // Filter out null/undefined if single URL is not provided

    if (!li_at || profileUrls.length === 0) {
        Actor.log.warn('Missing li_at cookie or profileUrls in input. Exiting.');
        await Actor.exit();
        return;
    }

    for (const profileUrl of profileUrls) {
        Actor.log.info(`Scraping profile: ${profileUrl}`);
        let browser;
        let page; // Declare page here to access in finally block for error reporting
        try {
            const launchOptions = {
                headless: true, // Actor.isAtHome ? 'new' : false, // Or simply true
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            };

            if (proxyConfiguration) {
                // Ensure proxyConfiguration is correctly structured for Actor.createProxyConfiguration
                // E.g., { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] }
                // or { proxyUrls: ['http://user:password@proxy1.com:8000'] }
                const proxy = await Actor.createProxyConfiguration(proxyConfiguration);
                if (proxy) {
                    // newUrl() is a method on the object returned by createProxyConfiguration
                    const proxyUrl = proxy.newUrl(); 
                    if (proxyUrl) {
                         launchOptions.args.push(`--proxy-server=${proxyUrl}`);
                         Actor.log.info(`Using proxy: ${proxyUrl.substring(0, proxyUrl.indexOf('@') > 0 ? proxyUrl.indexOf('@') : proxyUrl.length )}`); // Log without credentials
                    }
                }
            }
            
            browser = await puppeteer.launch(launchOptions);
            page = await browser.newPage(); 
            
            await page.setCookie({
                name: 'li_at',
                value: li_at,
                domain: '.linkedin.com',
                path: '/',
                httpOnly: true,
                secure: true
            });

            let activityUrl = profileUrl.endsWith('/') ? profileUrl : profileUrl + '/';
            activityUrl += 'detail/recent-activity/shares/';

            Actor.log.info(`Navigating to ${activityUrl}`);
            await page.goto(activityUrl, { waitUntil: 'networkidle2', timeout: 90000 });

            let collectedPosts = [];
            let previousHeight;
            let scrollAttempts = 0;
            const maxScrollAttempts = 20; // Increased max attempts
            const scrollDelay = 3000; // ms to wait after scroll

            Actor.log.info(`Starting scroll for ${profileUrl}. Target: ${maxPosts} posts.`);

            while (collectedPosts.length < maxPosts && scrollAttempts < maxScrollAttempts) {
                const newPostsOnPage = await extractPostContent(page);
                const newUniquePosts = newPostsOnPage.filter(p => p.url && !collectedPosts.some(cp => cp.url === p.url));
                
                if (newUniquePosts.length > 0) {
                    collectedPosts.push(...newUniquePosts);
                    Actor.log.info(`Collected ${collectedPosts.length}/${maxPosts} posts so far from ${profileUrl}.`);
                } else {
                    Actor.log.info(`No new unique posts found on this scroll for ${profileUrl}.`);
                }
                                
                // Ensure we don't exceed maxPosts if newUniquePosts overshoots
                collectedPosts = collectedPosts.slice(0, maxPosts);

                if (collectedPosts.length >= maxPosts) {
                    Actor.log.info(`Reached maxPosts (${maxPosts}) for ${profileUrl}.`);
                    break;
                }

                previousHeight = await page.evaluate('document.body.scrollHeight');
                await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
                
                try {
                    // Wait for new content to load or a "see more" button to appear
                    // More robust wait: wait for scroll height to change or a specific loader to disappear
                    await page.waitForFunction(
                        (prevHeight, minScrollIncrement) => document.body.scrollHeight > prevHeight + minScrollIncrement,
                        { timeout: scrollDelay + 2000 }, // More generous timeout
                        previousHeight,
                        10 // Min pixels to consider as new content
                    );
                } catch (e) {
                    Actor.log.warn(`No significant new content loaded after scroll for ${profileUrl} or timeout. Current posts: ${collectedPosts.length}. Attempt ${scrollAttempts + 1}/${maxScrollAttempts}.`);
                    // Attempt to click a "see more" button if it exists
                    const seeMoreButton = await page.$('button[data-finite-scroll-load-more-button="true"], button.scaffold-finite-scroll__load-button');
                    if (seeMoreButton) {
                        Actor.log.info('Attempting to click "see more" button...');
                        try {
                            await seeMoreButton.click();
                            await page.waitForTimeout(scrollDelay); // Wait for content to load
                        } catch (clickError) {
                            Actor.log.warn(`Could not click "see more" button: ${clickError.message}`);
                            // If click fails, might be end of content or overlay
                           // break; // Decide if this is a definitive end
                        }
                    } else {
                         Actor.log.info('No "see more" button found. Assuming end of content.');
                        break; 
                    }
                }
                scrollAttempts++;
                await page.waitForTimeout(500); // Brief pause before next scroll
            }
            
            // Final trim to maxPosts
            collectedPosts = collectedPosts.slice(0, maxPosts);

            for (const post of collectedPosts) {
                await Actor.pushData({ profileUrl, ...post });
            }
            Actor.log.info(`Finished scraping profile: ${profileUrl}. Total posts found and saved: ${collectedPosts.length}.`);

        } catch (e) {
            const currentUrl = page ? page.url() : 'N/A';
            Actor.log.error(`Error scraping profile ${profileUrl} (at URL: ${currentUrl}): ${e.message}`, { stack: e.stack });
        } finally {
            if (browser) {
                await browser.close();
            }
        }
    }
    Actor.log.info('Scraping terminé pour tous les profils.');
    await Actor.exit();
})();
