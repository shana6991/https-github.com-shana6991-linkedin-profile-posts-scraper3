const Apify = require('apify'); // Use the full Apify module object
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

Apify.Actor.main(async () => { // Use Apify.Actor.main
    const input = await Apify.Actor.getInput(); // Use Apify.Actor.getInput
    let { profileUrls, li_at, maxPosts = 20 } = input;
    if (!Array.isArray(profileUrls)) profileUrls = [profileUrls];

    for (const profileUrl of profileUrls) {
        Apify.Actor.log.info(`Scraping profile: ${profileUrl}`); // Use Apify.Actor.log
        let browser;
        try {
            browser = await puppeteer.launch({
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
            const page = await browser.newPage();
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

            Apify.Actor.log.info(`Navigating to ${activityUrl}`);
            await page.goto(activityUrl, { waitUntil: 'networkidle2', timeout: 90000 });

            let collectedPosts = [];
            let previousHeight;
            let scrollAttempts = 0;
            const maxScrollAttempts = 20;
            const scrollDelay = 3000;

            Apify.Actor.log.info(`Starting scroll for ${profileUrl}. Target: ${maxPosts} posts.`);

            while (collectedPosts.length < maxPosts && scrollAttempts < maxScrollAttempts) {
                const newPostsOnPage = await extractPostContent(page);
                const newUniquePosts = newPostsOnPage.filter(p => p.url && !collectedPosts.some(cp => cp.url === p.url));
                
                if (newUniquePosts.length > 0) {
                    collectedPosts.push(...newUniquePosts);
                    Apify.Actor.log.info(`Collected ${collectedPosts.length}/${maxPosts} posts so far from ${profileUrl}.`);
                } else {
                    Apify.Actor.log.info(`No new unique posts found on this scroll for ${profileUrl}.`);
                }
                                
                collectedPosts = collectedPosts.slice(0, maxPosts);

                if (collectedPosts.length >= maxPosts) {
                    Apify.Actor.log.info(`Reached maxPosts (${maxPosts}) for ${profileUrl}.`);
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
                    Apify.Actor.log.warning(`No significant new content loaded after scroll for ${profileUrl} or timeout. Current posts: ${collectedPosts.length}. Attempt ${scrollAttempts + 1}/${maxScrollAttempts}.`);
                    const seeMoreButton = await page.$('button[data-finite-scroll-load-more-button="true"], button.scaffold-finite-scroll__load-button');
                    if (seeMoreButton) {
                        Apify.Actor.log.info('Attempting to click "see more" button...');
                        await seeMoreButton.click();
                        await page.waitForTimeout(scrollDelay);
                    } else {
                         Apify.Actor.log.info('No "see more" button found. Assuming end of content.');
                        break; 
                    }
                }
                scrollAttempts++;
                await page.waitForTimeout(500); 
            }
            
            collectedPosts = collectedPosts.slice(0, maxPosts);

            for (const post of collectedPosts) {
                await Apify.Actor.pushData({ profileUrl, ...post }); // Use Apify.Actor.pushData
            }
            Apify.Actor.log.info(`Finished scraping profile: ${profileUrl}. Total posts found and saved: ${collectedPosts.length}.`);

        } catch (e) {
            Apify.Actor.log.error(`Error scraping profile ${profileUrl}: ${e.message}`, { stack: e.stack });
        } finally {
            if (browser) {
                await browser.close();
            }
        }
    }
    Apify.Actor.log.info('Scraping terminé pour tous les profils.');
});
