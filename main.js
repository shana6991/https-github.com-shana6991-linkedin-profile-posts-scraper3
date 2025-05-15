const Apify = require('apify');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const { utils: { log } } = Apify;

async function extractPostContent(page) {
    return await page.evaluate(() => {
        const posts = Array.from(document.querySelectorAll('div.feed-shared-update-v2'));
        return posts.map(post => {
            // Texte complet
            let text = '';
            const textElem = post.querySelector('.break-words');
            if (textElem) text = textElem.innerText.trim();

            // Images
            const images = Array.from(post.querySelectorAll('img.update-components-image__image'))
                .map(img => img.src);

            // Vidéos
            const videos = Array.from(post.querySelectorAll('video'))
                .map(video => video.src);

            // URL du post
            let url = '';
            const anchor = post.querySelector('a.feed-shared-control-link');
            if (anchor) url = anchor.href;

            // Date
            let date = '';
            const dateElem = post.querySelector('span.feed-shared-actor__sub-description > span.visually-hidden');
            if (dateElem) date = dateElem.innerText;

            return { text, images, videos, url, date };
        });
    });
}

Apify.main(async () => {
    const input = await Apify.getInput();
    let { profileUrls, li_at, maxPosts = 20 } = input;
    if (!Array.isArray(profileUrls)) profileUrls = [profileUrls];

    for (const profileUrl of profileUrls) {
        log.info(`Scraping profile: ${profileUrl}`);
        const browser = await puppeteer.launch({
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

        // Scroll pour charger les posts
        let previousHeight;
        let posts = [];
        while (posts.length < maxPosts) {
            posts = await extractPostContent(page);
            previousHeight = await page.evaluate('document.body.scrollHeight');
            await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
            await page.waitForTimeout(2000);
            const newHeight = await page.evaluate('document.body.scrollHeight');
            if (newHeight === previousHeight) break;
        }
        posts = posts.slice(0, maxPosts);
        for (const post of posts) {
            await Apify.pushData({ profileUrl, ...post });
        }
        await browser.close();
    }
    log.info('Scraping terminé.');
});
