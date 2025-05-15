const Apify = require('apify');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

// La ligne "const { utils: { log } } = Apify;" a été supprimée car incorrecte pour Apify SDK v3

async function extractPostContent(page) {
    return await page.evaluate(() => {
        const posts = Array.from(document.querySelectorAll('div.feed-shared-update-v2'));
        return posts.map(post => {
            let text = '';
            const textElem = post.querySelector('.break-words, .feed-shared-update-v2__description-wrapper .feed-shared-text');
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

Apify.main(async () => {
    const input = await Apify.getInput();
    let { profileUrls, li_at, maxPosts = 20 } = input;
    if (!Array.isArray(profileUrls)) profileUrls = [profileUrls];

    for (const profileUrl of profileUrls) {
        Apify.log.info(`Scraping profile: ${profileUrl}`); // Utilise Apify.log
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
            await page.goto(profileUrl + '/recent-activity/all/', { waitUntil: 'networkidle2', timeout: 60000 });

            let collectedPosts = [];
            let previousHeight;
            let scrollAttempts = 0;
            const maxScrollAttempts = 15; // Limite pour éviter boucle infinie

            while (collectedPosts.length < maxPosts && scrollAttempts < maxScrollAttempts) {
                const newPostsOnPage = await extractPostContent(page);
                
                // Logique pour ajouter uniquement les nouveaux posts non déjà collectés (basé sur l'URL)
                const newUniquePosts = newPostsOnPage.filter(p => p.url && !collectedPosts.some(cp => cp.url === p.url));
                collectedPosts.push(...newUniquePosts);
                
                collectedPosts = collectedPosts.slice(0, maxPosts); // Respecter maxPosts

                if (collectedPosts.length >= maxPosts) {
                    break;
                }

                previousHeight = await page.evaluate('document.body.scrollHeight');
                await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
                
                try {
                    // Attendre que la hauteur de la page change ou qu'un certain temps s'écoule
                    await page.waitForFunction(
                        (prevHeight) => document.body.scrollHeight > prevHeight,
                        { timeout: 5000 }, // Attendre 5 secondes max pour un changement
                        previousHeight
                    );
                } catch (e) {
                    Apify.log.warning(`No new content loaded after scroll for ${profileUrl} or timeout. Posts found: ${collectedPosts.length}.`);
                    break; // Sortir de la boucle si pas de nouveau contenu
                }
                scrollAttempts++;
            }
            
            // Assurer que l'on ne dépasse pas maxPosts même après la boucle
            collectedPosts = collectedPosts.slice(0, maxPosts);

            for (const post of collectedPosts) {
                await Apify.pushData({ profileUrl, ...post });
            }
            Apify.log.info(`Finished scraping profile: ${profileUrl}. Found ${collectedPosts.length} posts.`);

        } catch (e) {
            Apify.log.error(`Error scraping profile ${profileUrl}: ${e.message}`, { stack: e.stack });
        } finally {
            if (browser) {
                await browser.close();
            }
        }
    }
    Apify.log.info('Scraping terminé.');
});
