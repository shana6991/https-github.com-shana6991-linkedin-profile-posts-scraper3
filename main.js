const { Actor } = require('apify');
const moment = require('moment');
const ProxyChain = require('proxy-chain');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

// Configuration de l'acteur
// const { log } = Apify.utils; // ANCIENNE SYNTAXE
// Remplacé par Actor.log utilisé directement

// Fonction utilitaire pour parser les dates LinkedIn
const parseLinkedInDate = (dateStr) => {
    if (!dateStr) return null;
    const now = moment();
    const units = {
        h: 'hours', j: 'days', sem: 'weeks', mois: 'months', an: 'years',
        s: 'weeks', // semaine
        m: 'months', // mois
        a: 'years', // année
        d: 'days', // jour
        hr: 'hours' // heure
    };

    const simpleUnits = { 'now': 0, 'maintenant': 0, 'hier': 1, 'yesterday': 1};
    if (dateStr.toLowerCase() in simpleUnits) {
        if (simpleUnits[dateStr.toLowerCase()] === 0) return now;
        return now.subtract(simpleUnits[dateStr.toLowerCase()], 'days');
    }

    for (const [key, unit] of Object.entries(units)) {
        const regex = new RegExp(`^(\\d+)\\s*${key}`, 'i');
        const match = dateStr.match(regex);
        if (match) {
            const number = parseInt(match[1]);
            if (!isNaN(number)) {
                return now.subtract(number, unit);
            }
        }
    }
    // Default parsing for full dates like "2 mars 2024" or "March 2, 2024"
    // moment needs locale to be set for month names in other languages
    const parsedDate = moment(dateStr, ['D MMMM YYYY', 'MMMM D, YYYY', 'YYYY-MM-DD'], 'fr', true); // 'fr' for French
    if (parsedDate.isValid()) {
        return parsedDate;
    }
    console.warn(`[WARN] Could not parse date: ${dateStr}`);
    return null;
};

// Fonction pour extraire les médias d'un post
const extractMedia = async (postElement) => {
    const media = { images: [], videos: [] };
    try {
        media.images = await postElement.$$eval('img.update-components-image__image', imgs => imgs.map(img => img.src));
        const videoElements = await postElement.$$('video.vjs-tech');
        for (const videoEl of videoElements) {
            const videoSrc = await videoEl.evaluate(el => el.src);
            if (videoSrc) media.videos.push(videoSrc);
        }
    } catch (error) {
        console.debug(`[DEBUG] Failed to extract media: ${error.message}`);
    }
    return media;
};

// Fonction pour extraire les commentaires d'un post
const extractComments = async (postElement, page, maxComments) => {
    const comments = [];
    try {
        // Logic to click "load more comments" or similar might be needed here
        // For now, directly extracting visible comments
        const commentElements = await postElement.$$('div.comments-comment-item');
        for (const commentEl of commentElements.slice(0, maxComments)) {
            const author = await commentEl.$eval('span.comments-post-meta__name-text', el => el.innerText.trim()).catch(() => '');
            const text = await commentEl.$eval('div.feed-shared-comment-item__text', el => el.innerText.trim()).catch(() => '');
            // Timestamp extraction needs refinement based on actual HTML structure
            const timestampText = await commentEl.$eval('time.feed-shared-comment-item__timestamp', el => el.innerText.trim()).catch(() => '');
            comments.push({ author, text, timestamp: parseLinkedInDate(timestampText) });
        }
    } catch (error) {
        console.debug(`[DEBUG] Failed to extract comments: ${error.message}`);
    }
    return comments;
};

Actor.main(async () => {
    console.log('[INFO] Actor.main started. Attempting to get input.');
    const input = await Actor.getInput();

    if (!input) {
        console.error('[ERROR] Failed to get input. Actor.getInput() returned null or undefined.');
        throw new Error('Input is missing. Actor.getInput() returned null or undefined.');
    }

    const {
        profileUrl,
        linkedinLogin,
        linkedinPassword,
        proxyConfiguration,
        maxPosts = null,
        includeComments = false,
        maxCommentsPerPost = 10,
        dateFrom: dateFromString,
        dateTo: dateToString,
        includeMedia = false
    } = input;

    if (!profileUrl || !linkedinLogin || !linkedinPassword) {
        console.error('[ERROR] profileUrl, linkedinLogin, and linkedinPassword are required input fields.');
        throw new Error('profileUrl, linkedinLogin, and linkedinPassword are required.');
    }
    console.log('[INFO] Input received:', { profileUrl, linkedinLogin: '***', linkedinPassword: '***', maxPosts, includeComments, maxCommentsPerPost, dateFromString, dateToString, includeMedia });

    const dateFrom = dateFromString ? moment(dateFromString) : null;
    const dateTo = dateToString ? moment(dateToString) : null;

    console.log('[INFO] Launching Puppeteer...');
    let browser;
    try {
        const launchOptions = {
            headless: true, // Apify platform runs headful based on actor config
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        };
        if (proxyConfiguration && proxyConfiguration.useApifyProxy) {
            const proxyUrl = await ProxyChain.requestUrl(proxyConfiguration.apifyProxyGroups ? proxyConfiguration.apifyProxyGroups.join(',') : null);
            if (proxyUrl) {
                launchOptions.args.push(`--proxy-server=${proxyUrl}`);
                console.log(`[INFO] Using Apify Proxy: ${proxyUrl}`);
            }
        }
        browser = await puppeteer.launch(launchOptions);
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });

        console.log('[INFO] Navigating to LinkedIn login page...');
        await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 });

        console.log('[INFO] Entering credentials...');
        await page.type('#username', linkedinLogin);
        await page.type('#password', linkedinPassword);
        await page.click('button[type="submit"]');

        console.log('[INFO] Waiting for login to complete...');
        try {
            await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 });
        } catch (e) {
            console.warn(`[WARN] waitForNavigation after login failed: ${e.message}. Checking current URL...`);
            if (page.url().includes('/feed')) {
                console.log('[INFO] Login likely successful, landed on feed page.');
            } else if (page.url().includes('checkpoint/challenge') || page.url().includes('checkpoint/verify')) {
                 console.error('[ERROR] LinkedIn is asking for a security check (CAPTCHA or verification).');
                 await Actor.setValue('LOGIN_CHALLENGE_SCREENSHOT', await page.screenshot({ fullPage: true }), { contentType: 'image/png' });
                 await Actor.setValue('LOGIN_CHALLENGE_HTML', await page.content(), { contentType: 'text/html' });
                 throw new Error('LinkedIn security check triggered during login. Cannot proceed.');
            } else {
                console.error(`[ERROR] Login failed. Current URL: ${page.url()}`);
                await Actor.setValue('LOGIN_FAILED_SCREENSHOT', await page.screenshot({ fullPage: true }), { contentType: 'image/png' });
                await Actor.setValue('LOGIN_FAILED_HTML', await page.content(), { contentType: 'text/html' });
                throw new Error(`Login failed. Unexpected page: ${page.url()}`);
            }
        }

        console.log('[INFO] Login successful or challenge detected and handled.');
        console.log(`[INFO] Navigating to profile: ${profileUrl}`);
        try {
            // This is the line (approx 115) that needs the timeout increase
            await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 120000 }); // Increased timeout
        } catch (navError) {
             console.error(`[ERROR] Navigation to profile ${profileUrl} failed: ${navError.message}`);
             await Actor.setValue(`PROFILE_NAV_ERROR_SCREENSHOT_${profileUrl.split('/').pop()}`, await page.screenshot({ fullPage: true }), { contentType: 'image/png' });
             await Actor.setValue(`PROFILE_NAV_ERROR_HTML_${profileUrl.split('/').pop()}`, await page.content(), { contentType: 'text/html' });
             throw navError; // Re-throw to stop execution
        }
        console.log(`[INFO] Successfully navigated to profile: ${profileUrl}`);

        // Click on "Show all posts" or "Activity" tab
        const activitySelectors = [
            'a[href$="/recent-activity/all/"]', // Provided by user
            'a[href$="/detail/recent-activity/shares/"]', // Common for shares
            'a[href$="/detail/recent-activity/posts/"]', // Common for posts
            '#navigation-index-see-all-posts', // Another possible selector
            '//a[.//span[contains(text(),"Posts") or contains(text(),"Activité") or contains(text(),"Activity")]]' // XPath for flexibility
        ];

        let activityLinkClicked = false;
        for (const selector of activitySelectors) {
            try {
                console.log(`[INFO] Trying to click activity link with selector: ${selector}`);
                if (selector.startsWith('//')) { // XPath
                    const [activityLink] = await page.$x(selector);
                    if (activityLink) {
                        await activityLink.click();
                        activityLinkClicked = true;
                        console.log(`[INFO] Clicked activity link using XPath: ${selector}`);
                        break;
                    }
                } else { // CSS Selector
                    const activityLink = await page.$(selector);
                    if (activityLink) {
                        await activityLink.click();
                        activityLinkClicked = true;
                        console.log(`[INFO] Clicked activity link using CSS: ${selector}`);
                        break;
                    }
                }
            } catch (e) {
                console.warn(`[WARN] Could not click activity link with selector ${selector}: ${e.message}`);
            }
        }

        if (!activityLinkClicked) {
            console.warn('[WARN] Could not find or click the "Show all posts/activity" link. Scraping from main profile page if posts are directly visible, or may fail.');
            await Actor.setValue('NO_ACTIVITY_LINK_CLICKED_SCREENSHOT', await page.screenshot({ fullPage: true }), { contentType: 'image/png' });
        } else {
            try {
                await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 });
                console.log('[INFO] Navigation after clicking activity link successful.');
            } catch (e) {
                console.warn(`[WARN] waitForNavigation after clicking activity link failed: ${e.message}. Proceeding anyway.`);
                await Actor.setValue('ACTIVITY_LINK_NAV_FAILED_SCREENSHOT', await page.screenshot({ fullPage: true }), { contentType: 'image/png' });
            }
        }
        
        console.log('[INFO] Starting to scroll and extract posts...');
        let postsCollected = [];
        let lastHeight = await page.evaluate('document.body.scrollHeight');
        let noNewPostsStreak = 0;

        while ((maxPosts === null || postsCollected.length < maxPosts) && noNewPostsStreak < 5) {
            const initialPostCount = postsCollected.length;
            // This selector needs to be very robust. LinkedIn changes its structure often.
            // The selector should target individual post containers.
            // Common patterns: .feed-shared-update-v2, .occludable-update, article, [data-urn^="urn:li:activity:"], [data-urn^="urn:li:share:"]
            // It's better to find a common wrapper for each post/update
            const postElements = await page.$$('.scaffold-finite-scroll__content > div > div');
            console.log(`[INFO] Found ${postElements.length} potential post elements in current view.`);

            for (const postEl of postElements) {
                if (maxPosts !== null && postsCollected.length >= maxPosts) break;

                let postData = null;
                try {
                    postData = await postEl.evaluate(el => {
                        const getText = (selector) => el.querySelector(selector)?.innerText.trim();
                        const getAttribute = (selector, attr) => el.querySelector(selector)?.getAttribute(attr);

                        // These selectors are highly dependent on LinkedIn's current HTML structure
                        // It is CRITICAL to inspect the page and update these if they break.
                        const authorName = getText('span.feed-shared-actor__name > span[aria-hidden="true"]') || getText('span.actor-name');
                        const authorProfileUrl = getAttribute('a.feed-shared-actor__meta-link', 'href') || getAttribute('a.actor-link', 'href');
                        const postContentElement = el.querySelector('div.feed-shared-update-v2__description-wrapper span.break-words, div.update-components-text span.text-view-model, .feed-shared-text');
                        const postContent = postContentElement ? postContentElement.innerText.trim() : '';
                        
                        let timestampStr = getText('span.feed-shared-actor__supplementary-metadata > span[aria-hidden="true"]') || getText('time.feed-shared-comment-item__timestamp');
                        if (timestampStr && timestampStr.includes('•')) { 
                             timestampStr = Array.from(el.querySelectorAll('span[aria-hidden="true"]')).find(s => s.innerText.match(/\d+(h|d|w|mo|yr|s|m|j|sem|an|mois|heure)|ago|maintenant|hier/i))?.innerText.trim();
                        }
                        if (!timestampStr) { // Fallback for different timestamp structure
                            timestampStr = getText('.update-components-actor__sub-description > div > span[aria-hidden="true"]')
                        }

                        const likesCountText = getText('button[aria-label*="reaction"] span.social-details-social-counts__reactions-count') || getText('span.likes-count');
                        const commentsCountText = getText('button[aria-label*="comment"] span.social-details-social-counts__comments') || getText('span.comments-count');

                        return {
                            authorName,
                            authorProfileUrl: authorProfileUrl ? (authorProfileUrl.startsWith('http') ? authorProfileUrl : `https://www.linkedin.com${authorProfileUrl}`) : null,
                            postContent,
                            timestamp: timestampStr, // Will be parsed later
                            likesCount: likesCountText ? parseInt(likesCountText.match(/\d+/)?.[0] || '0') : 0,
                            commentsCount: commentsCountText ? parseInt(commentsCountText.match(/\d+/)?.[0] || '0') : 0,
                            postUrl: window.location.href // This might not be specific enough for individual posts if not on a permalink
                        };
                    });
                } catch(evalError) {
                    console.debug(`[DEBUG] Error evaluating post element: ${evalError.message}`);
                    continue; // Skip this element if basic evaluation fails
                }


                if (!postData.postContent && !postData.authorName && !(postData.media && (postData.media.images.length > 0 || postData.media.videos.length > 0)) ) { // Skip empty/invalid entries unless there's media
                    console.debug('[DEBUG] Skipping post element, no content, author, or media found.');
                    continue;
                }

                postData.parsedDate = parseLinkedInDate(postData.timestamp);

                // Filter by date
                if (dateFrom && postData.parsedDate && postData.parsedDate.isBefore(dateFrom)) {
                    console.log(`[INFO] Skipping post by ${postData.authorName} from ${postData.parsedDate ? postData.parsedDate.format('YYYY-MM-DD') : 'unknown date'} (before dateFrom ${dateFrom.format('YYYY-MM-DD')}).`);
                    continue;
                }
                if (dateTo && postData.parsedDate && postData.parsedDate.isAfter(dateTo)) {
                    console.log(`[INFO] Skipping post by ${postData.authorName} from ${postData.parsedDate ? postData.parsedDate.format('YYYY-MM-DD') : 'unknown date'} (after dateTo ${dateTo.format('YYYY-MM-DD')}).`);
                    continue;
                }
                
                // Deduplication check - ensure a unique ID or better content hash if possible
                const uniquePostId = postData.authorName + ':' + (postData.postContent ? postData.postContent.slice(0,100) : 'NOCONTENT') + ':' + postData.timestamp;
                if (postsCollected.some(p => p.uniquePostId === uniquePostId)) {
                     console.debug(`[DEBUG] Skipping duplicate post by ${postData.authorName} with timestamp ${postData.timestamp}`);
                     continue;
                }
                postData.uniquePostId = uniquePostId;

                if (includeMedia) {
                    postData.media = await extractMedia(postEl);
                }
                if (includeComments) {
                    postData.comments = await extractComments(postEl, page, maxCommentsPerPost);
                }
                
                console.log(`[INFO] Collected post by: ${postData.authorName} | Date: ${postData.parsedDate ? postData.parsedDate.format('YYYY-MM-DD HH:mm') : postData.timestamp} | Content snippet: ${postData.postContent ? postData.postContent.substring(0, 50) + '...' : 'N/A'}`);
                postsCollected.push(postData);
                await Actor.pushData(postData); // Push data as it's collected
            }

            if (postsCollected.length === initialPostCount && postElements.length > 0) { // Only increment streak if we had elements to process but none were new
                noNewPostsStreak++;
                console.log(`[INFO] No new valid posts found in this scroll. Streak: ${noNewPostsStreak}`);
            } else if (postsCollected.length > initialPostCount) {
                noNewPostsStreak = 0; // Reset streak if new posts were found and added
            }
            // If postElements.length is 0, it means we might have reached the end or an empty section, 
            // but it doesn't necessarily mean no *new* posts if previous scrolls also yielded 0. Handled by streak.

            if ((maxPosts !== null && postsCollected.length >= maxPosts) || noNewPostsStreak >= 5) {
                 if (noNewPostsStreak >= 5) console.log('[INFO] Reached maximum noNewPostsStreak, stopping scroll.');
                 if (maxPosts !== null && postsCollected.length >= maxPosts) console.log('[INFO] Reached maxPosts limit.');
                break;
            }

            console.log('[INFO] Scrolling down...');
            await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
            try {
                // Wait for a bit more dynamic time for content to potentially load after scroll
                await page.waitForTimeout(3500 + Math.random() * 2500);
                // Check if scroll height actually changed, or if new content appeared (more robust)
                // This waitForFunction can be tricky. A simpler approach might be to check for new elements if scroll height doesn't change.
                 await page.waitForFunction(
                    (currentHeight, previousPostsCount, postSelector) => {
                        const newHeight = document.body.scrollHeight;
                        const newPosts = document.querySelectorAll(postSelector).length;
                        return newHeight > currentHeight || newPosts > previousPostsCount;
                    },
                    { timeout: 15000 }, // Increased timeout for waiting for new content or scroll height change
                    lastHeight, postElements.length, '.scaffold-finite-scroll__content > div > div'
                ).catch(() => {
                    console.warn('[WARN] Scroll height/content did not change significantly after scroll, or timeout waiting for it. May be end of page.');
                });
            } catch (e) {
                console.warn(`[WARN] Error during scroll/wait: ${e.message}`);
            }
            lastHeight = await page.evaluate('document.body.scrollHeight');
        }

        console.log(`[INFO] Finished scraping. Total posts collected: ${postsCollected.length}`);
        // Data is pushed incrementally, but a final summary log is good.
        // await Actor.pushData(postsCollected); // Already pushing data incrementally

    } catch (error) {
        console.error(`[ERROR] Scraping failed: ${error.message}. Stack: ${error.stack}`);
        await Actor.setValue('RUN_ERROR_MESSAGE', error.message);
        await Actor.setValue('RUN_ERROR_STACK', error.stack);
        
        // Try to save context if browser is still available
        if (browser) {
            try {
                const page = (await browser.pages())[0]; // Get current page if exists
                if (page) { // Check if page exists
                    await Actor.setValue('GENERAL_ERROR_SCREENSHOT', await page.screenshot({ fullPage: true }), { contentType: 'image/png' });
                    await Actor.setValue('GENERAL_ERROR_HTML', await page.content(), { contentType: 'text/html' });
                    console.log('[INFO] General error page HTML and screenshot saved to Key-Value Store.');
                }
            } catch (saveError) {
                console.error(`[ERROR] Could not save error context: ${saveError.message}`);
            }
        }
        throw error; // Re-throw to ensure Apify platform marks run as failed.
    } finally {
        if (browser) {
            console.log('[INFO] Closing browser...');
            await browser.close();
            console.log('[INFO] Browser closed. Actor run finishing.');
        }
        console.log('[INFO] Actor finished.');
    }
});