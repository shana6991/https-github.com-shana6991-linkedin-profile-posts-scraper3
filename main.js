const { Actor } = require('apify');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
pupeteer.use(StealthPlugin());

async function extractPostContent(page) {
    // ... (same as before)
    return await page.evaluate(() => {
        const posts = Array.from(document.querySelectorAll('div.feed-shared-update-v2'));
        return posts.map(post => {
            let text = '';
            const textElem = post.querySelector('.feed-shared-update-v2__description-wrapper .feed-shared-text, .break-words, .feed-shared-commentary');
            if (textElem) text = textElem.innerText.trim();
            const images = Array.from(post.querySelectorAll('img.update-components-image__image, img.ivm-view-attr__img--centered')).map(img => img.src);
            const videos = Array.from(post.querySelectorAll('video.vjs-tech')).map(video => video.src);
            let url = '';
            const postRoot = post.closest('div[data-urn]');
            if (postRoot && postRoot.dataset.urn) {
                url = `https://www.linkedin.com/feed/update/${postRoot.dataset.urn}`;
            } else {
                const anchor = post.querySelector('a.feed-shared-control-menu__item[href*="/feed/update/urn:li:activity:"]');
                if (anchor) url = anchor.href;
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
    const log = Actor.log; 

    // Diagnostic log 1: Check 'log' right after assignment
    if (log && typeof log.info === 'function') {
        log.info('DIAGNOSTIC: Local `log` variable obtained and `log.info` is a function.');
    } else {
        console.log('DIAGNOSTIC: Local `log` variable is invalid or `log.info` is not a function immediately after assignment.');
        if (Actor.log && typeof Actor.log.info === 'function') {
            Actor.log.error('DIAGNOSTIC: Actor.log is valid but local `log` assignment failed.');
        } else {
            console.log('DIAGNOSTIC: Actor.log itself is also invalid after init.');
        }
        await Actor.exit(); 
        return;
    }

    const input = await Actor.getInput();
    let { profileUrls, li_at, maxPosts = 20, proxyConfiguration, extractMedia = true, extractComments = false, filterDateAfter } = input || {};
    if (!Array.isArray(profileUrls)) profileUrls = [profileUrls].filter(Boolean);

    if (!li_at || profileUrls.length === 0) {
        log.warn('Missing li_at cookie or profileUrls in input. Exiting.');
        await Actor.exit();
        return;
    }

    // Diagnostic log 2: Check 'log' right before the loop
    log.info('DIAGNOSTIC: About to enter the profileUrls loop. Checking `log` state again.');
    if (!log || typeof log.info !== 'function') {
        console.log('DIAGNOSTIC: Local `log` variable BECAME invalid before the loop.');
        if (Actor.log && typeof Actor.log.info === 'function') {
             Actor.log.error('DIAGNOSTIC: Local `log` invalid, but Actor.log is STILL OK before loop.');
        } else {
            console.log('DIAGNOSTIC: Actor.log is ALSO invalid before loop at this stage.');
        }
        // If log is broken here, we might not proceed or the next log.info will fail.
    }

    for (const profileUrl of profileUrls) {
        log.info(`Scraping profile: ${profileUrl}`); // This is the line that was failing
        let browser;
        let page;
        try {
            const launchOptions = {
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            };

            if (proxyConfiguration) {
                const proxy = await Actor.createProxyConfiguration(proxyConfiguration);
                if (proxy) {
                    const proxyUrl = proxy.newUrl();
                    if (proxyUrl) {
                         launchOptions.args.push(`--proxy-server=${proxyUrl}`);
                         log.info(`Using proxy: ${proxyUrl.substring(0, proxyUrl.indexOf('@') > 0 ? proxyUrl.indexOf('@') : proxyUrl.length )}`);
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

            log.info(`Navigating to ${activityUrl}`);
            await page.goto(activityUrl, { waitUntil: 'networkidle2', timeout: 90000 });

            let collectedPosts = [];
            let previousHeight;
            let scrollAttempts = 0;
            const maxScrollAttempts = 20;
            const scrollDelay = 3000;

            log.info(`Starting scroll for ${profileUrl}. Target: ${maxPosts} posts.`);

            while (collectedPosts.length < maxPosts && scrollAttempts < maxScrollAttempts) {
                const newPostsOnPage = await extractPostContent(page);
                const newUniquePosts = newPostsOnPage.filter(p => p.url && !collectedPosts.some(cp => cp.url === p.url));
                
                if (newUniquePosts.length > 0) {
                    collectedPosts.push(...newUniquePosts);
                    log.info(`Collected ${collectedPosts.length}/${maxPosts} posts so far from ${profileUrl}.`);
                } else {
                    log.info(`No new unique posts found on this scroll for ${profileUrl}.`);
                }
                                
                collectedPosts = collectedPosts.slice(0, maxPosts);

                if (collectedPosts.length >= maxPosts) {
                    log.info(`Reached maxPosts (${maxPosts}) for ${profileUrl}.`);
                    break;
                }

                previousHeight = await page.evaluate('document.body.scrollHeight');
                await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
                
                try {
                    await page.waitForFunction(
                        (prevHeight, minScrollIncrement) => document.body.scrollHeight > prevHeight + minScrollIncrement,
                        { timeout: scrollDelay + 2000 },
                        previousHeight,
                        10 
                    );
                } catch (e) {
                    log.warn(`No significant new content loaded after scroll for ${profileUrl} or timeout. Current posts: ${collectedPosts.length}. Attempt ${scrollAttempts + 1}/${maxScrollAttempts}.`);
                    const seeMoreButton = await page.$('button[data-finite-scroll-load-more-button="true"], button.scaffold-finite-scroll__load-button');
                    if (seeMoreButton) {
                        log.info('Attempting to click "see more" button...');
                        try {
                            await seeMoreButton.click();
                            await page.waitForTimeout(scrollDelay);
                        } catch (clickError) {
                            log.warn(`Could not click "see more" button: ${clickError.message}`);
                        }
                    } else {
                         log.info('No "see more" button found. Assuming end of content.');
                        break; 
                    }
                }
                scrollAttempts++;
                await page.waitForTimeout(500); 
            }
            
            collectedPosts = collectedPosts.slice(0, maxPosts);

            for (const post of collectedPosts) {
                await Actor.pushData({ profileUrl, ...post });
            }
            log.info(`Finished scraping profile: ${profileUrl}. Total posts found and saved: ${collectedPosts.length}.`);

        } catch (e) {
            const currentUrl = page ? page.url() : 'N/A';
            log.error(`Error scraping profile ${profileUrl} (at URL: ${currentUrl}): ${e.message}`, { stack: e.stack });
        } finally {
            if (browser) {
                await browser.close();
            }
        }
    }
    log.info('Scraping terminé pour tous les profils.');
    await Actor.exit();
})();
