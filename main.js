const { Actor } = require('apify'); // Import Actor
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

async function extractPostContent(page) {
    return await page.evaluate(() => {
        const posts = Array.from(document.querySelectorAll('div.feed-shared-update-v2'));
        return posts.map(post => {
            let text = '';
            // Sélecteur plus général pour le texte, incluant les repartages
            const textElem = post.querySelector('.feed-shared-update-v2__description-wrapper .feed-shared-text, .break-words, .feed-shared-commentary');
            if (textElem) text = textElem.innerText.trim();

            const images = Array.from(post.querySelectorAll('img.update-components-image__image, img.ivm-view-attr__img--centered'))
                .map(img => img.src);

            const videos = Array.from(post.querySelectorAll('video.vjs-tech')) // Sélecteur plus précis pour les vidéos
                .map(video => video.src);

            let url = '';
            // Tenter d'obtenir l'URN du post pour une URL plus fiable
            const postRoot = post.closest('div[data-urn]');
            if (postRoot && postRoot.dataset.urn) {
                url = `https://www.linkedin.com/feed/update/${postRoot.dataset.urn}`;
            } else {
                 // Fallback si l'URN n'est pas trouvé directement sur le parent
                const anchor = post.querySelector('a.feed-shared-control-menu__item[href*="/feed/update/urn:li:activity:"]');
                 if(anchor) url = anchor.href;
            }


            let date = '';
            // Sélecteur plus robuste pour la date
            const dateElem = post.querySelector('span.feed-shared-actor__sub-description > span.visually-hidden, .update-components-actor__sub-description span[aria-hidden="true"]');
            if (dateElem) date = dateElem.innerText.trim(); // .trim() pour enlever les espaces

            return { text, images, videos, url, date };
        });
    });
}

Actor.main(async () => { // Utiliser Actor.main
    const input = await Actor.getInput(); // Utiliser Actor.getInput
    let { profileUrls, li_at, maxPosts = 20 } = input;
    if (!Array.isArray(profileUrls)) profileUrls = [profileUrls]; // Gérer le cas d'une URL unique

    for (const profileUrl of profileUrls) {
        Actor.log.info(`Scraping profile: ${profileUrl}`); // Utiliser Actor.log
        let browser;
        try {
            browser = await puppeteer.launch({
                headless: true, // Mettre à false pour voir le navigateur pendant le debug
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

            // Naviguer vers la page des activités récentes "posts"
            // L'URL /all/ peut inclure commentaires, réactions. /shares/ ou /posts/ est plus ciblé.
            // Testons avec /posts/ d'abord, sinon /all/
            let activityUrl = profileUrl.endsWith('/') ? profileUrl : profileUrl + '/';
            activityUrl += 'detail/recent-activity/shares/'; // Ou 'posts/' si 'shares/' ne marche pas bien

            Actor.log.info(`Navigating to ${activityUrl}`);
            await page.goto(activityUrl, { waitUntil: 'networkidle2', timeout: 90000 });

            let collectedPosts = [];
            let previousHeight;
            let scrollAttempts = 0;
            const maxScrollAttempts = 20; // Augmenté pour les longs profils
            const scrollDelay = 3000; // Délai entre les scrolls

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
                                
                collectedPosts = collectedPosts.slice(0, maxPosts); // S'assurer de ne pas dépasser

                if (collectedPosts.length >= maxPosts) {
                    Actor.log.info(`Reached maxPosts (${maxPosts}) for ${profileUrl}.`);
                    break;
                }

                previousHeight = await page.evaluate('document.body.scrollHeight');
                await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
                
                try {
                    // Attendre que la hauteur de la page change ou qu'un certain temps s'écoule
                    await page.waitForFunction(
                        (prevHeight, minScrollIncrement) => document.body.scrollHeight > prevHeight + minScrollIncrement,
                        { timeout: scrollDelay + 2000 }, // Timeout un peu plus long que le scrollDelay
                        previousHeight,
                        10 // minScrollIncrement: s'assurer que le scroll a ajouté au moins 10px
                    );
                } catch (e) {
                    Actor.log.warning(`No significant new content loaded after scroll for ${profileUrl} or timeout. Current posts: ${collectedPosts.length}. Attempt ${scrollAttempts + 1}/${maxScrollAttempts}.`);
                    // Essayer de cliquer sur un éventuel bouton "voir plus" si rien ne charge
                    const seeMoreButton = await page.$('button[data-finite-scroll-load-more-button="true"], button.scaffold-finite-scroll__load-button');
                    if (seeMoreButton) {
                        Actor.log.info('Attempting to click "see more" button...');
                        await seeMoreButton.click();
                        await page.waitForTimeout(scrollDelay); // Attendre que le contenu charge après le clic
                    } else {
                         Actor.log.info('No "see more" button found. Assuming end of content.');
                        break; // Sortir de la boucle si pas de nouveau contenu et pas de bouton
                    }
                }
                scrollAttempts++;
                await page.waitForTimeout(500); // Petit délai additionnel
            }
            
            collectedPosts = collectedPosts.slice(0, maxPosts); // S'assurer une dernière fois de ne pas dépasser

            for (const post of collectedPosts) {
                await Actor.pushData({ profileUrl, ...post }); // Utiliser Actor.pushData
            }
            Actor.log.info(`Finished scraping profile: ${profileUrl}. Total posts found and saved: ${collectedPosts.length}.`);

        } catch (e) {
            Actor.log.error(`Error scraping profile ${profileUrl}: ${e.message}`, { stack: e.stack }); // Utiliser Actor.log
        } finally {
            if (browser) {
                await browser.close();
            }
        }
    }
    Actor.log.info('Scraping terminé pour tous les profils.'); // Utiliser Actor.log
});
